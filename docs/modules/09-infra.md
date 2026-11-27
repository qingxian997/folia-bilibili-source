# 09 · 基础设施（`store` / `memoCache` / `asar` / `update` / `link`）

## `lib/store.cjs`（101 行，主进程）

### 职责

Cookie 落在哪。三级顺序：

```text
1. 宿主的 secret 设置字段（加密存储）
2. 模组自己的数据文件（明文，兜底）
3. 内存
```

### 导出

| 导出 | 作用 |
| --- | --- |
| `createCookieStore(api, options)` | 返回 `{ read, write, clear }` |

### 为什么不能只用数据文件

`filesystem.data` 是明文的，`SESSDATA` 等于账号密码。

### 为什么要回读校验

宿主有些版本的 `secrets.set` 是**静默 no-op**（字段被当成未知类型丢掉），
只看「没抛异常」会以为存上了，重启就掉登录。所以写完必须读回来比对。

### 已知坑

- 宿主版本差异：`secrets` 在某些版本不认 `type: 'secret'`，写在 `mod.json` 里要
  确保字段声明正确，否则会静默失败。
- 切换账号时先 `clear()` 再写，否则旧 `buvid3` 会带进新会话。

### 测试

`test/store.test.mjs`。

---

## `lib/memoCache.cjs`（34 行，主进程）

### 职责

主进程「短期记忆」的写入规则。

宿主的墙一刷新就会连着问好几次同一件事，每次都真打 bilibili 既慢又容易吃 `-412`。
但 key 里带着搜索词、收藏夹分页和字幕 id，一个开着的窗口能攒下几百上千条，
值往往是整页歌曲数组（每首带封面 URL）。

0.9.0 之前只有 `clearCache` 兜底，等于没有上限。现在写入时先入先出。

### 导出

| 导出 | 作用 |
| --- | --- |
| `MEMO_MAX` | 上限条数 |
| `remember(map, key, value, max = MEMO_MAX)` | 写入并压制上限 |

### 要点

- 超上限丢**最旧**的（Map 迭代顺序即插入顺序），不是随机。
- 只缓存「成功结果」。失败不要写进去，否则一次风控会毒化半小时。
- 值如果很大（整页歌曲），考虑只缓存 id 列表。

### 测试

`test/memoCache.test.mjs`。

---

## `lib/asar.cjs`（44 行，主进程）

### 职责

按格式直接读 Electron asar：16 字节头，offset 12 起是 uint32 的 JSON 长度，
紧跟着目录树。

不用 Electron 的 `fs` 补丁，因为模组主进程不一定跑在那样的环境里；
纯 Node 也能用，所以测试可跑。

### 导出

| 导出 | 作用 |
| --- | --- |
| `readAsarIndex(archive)` | 读目录树 |
| `listAsarDir(archive, segments)` | 列某个目录下的文件 |

### 用途

歌词源注册的兜底：入口 chunk 文本里找不到 `loginDiagnosticReport-*.js` 时，
直接用 `listAsarDir` 在 `assets` 目录里按文件名找。

### 测试

`test/asar.test.mjs`。

---

## `lib/update.cjs`（205 行，主进程）

### 职责

GitHub Release 更新检查与下载（纯逻辑 + 注入 IO）。
主进程负责访问 GitHub、下载 zip、校验 sha256；客户端负责调宿主的
`installModFromZip`。

### 导出

| 导出 | 作用 |
| --- | --- |
| `createUpdateService(options)` | 返回 `{ check, state, download, skip }` |

内部辅助：`parseVersion` / `compareVersions` / `checksumOf` / `releaseInfo` / `sha256OfFile`。

### 流程

```text
check(force)
  → GET /repos/.../releases/latest
  → 比较版本（预发布不占 latest，所以要读 /releases 列表）
  → 找 asset 里的 bilibili-<ver>.zip 与 SHA256SUMS
  → 返回 { available, version, notes, asset, digest }

download()
  → 下载到临时目录
  → 校验 sha256，不匹配直接丢弃
  → 返回本地路径

client: installModFromZip(path)
```

### 已知坑

- **升级后必然落到 disabled**：宿主替换文件后旧 approval 与新 digest 不匹配。
  要在客户端主动 `setEnabled` 触发信任确认，不要自己去写 trust 记录（见下面的 `afterInstall`）。
- 预发布版本不占 `/releases/latest`，要读 `/releases` 列表再挑。
- 校验和必须来自 Release 正文或同名 `.sha256` 资产，不能只信文件大小。
- 下载失败要保留旧版本可用，不要先删再下。

### 测试

`test/update.test.mjs`。

---

## `lib/afterInstall.mjs`（渲染侧，33 行）

### 职责

更新装完之后，替用户把开关再打开一次。

宿主认为「换了文件 = 旧信任作废」，`installModFromZip()` 只替换文件和重载，
换完一定落到 disabled，而且**不会**弹确认——弹确认的代码在宿主 `setModEnabled()` 里，
只有用户手动点开关才会走到。所以更新完，用户看到的是「模组没了」。

### 导出

| 导出 | 作用 |
| --- | --- |
| `ensureEnabledAfterInstall({ mods, id, onManual })` | 调 `mods.setEnabled(id, true)`；拿不到接口或抛错时走 `onManual`，返回 `'enabled'` / `'manual'` |

### 规则

- **只按开关，不写信任记录。** 信任是宿主的安全边界，绕过会带来更大的问题。
- `setEnabled` 在已启用时是空操作；刚更新过时它会弹宿主的原生确认。
- 不存在 `mods.setEnabled` 的老宿主：走 `onManual`，界面上说清「设置 → 模组 → bilibili 打开开关」。

### 调用点

`client.mjs` 的 `installUpdate()`：`installModFromZip` 完成 → 等 600ms 让宿主落盘 →
`enableAfterInstall()`。

### 测试

`test/afterInstall.test.mjs`：正常启用、无接口、无 `electron.mods`、`setEnabled` 抛错四条分支。

---

## `lib/link.mjs`（44 行）

### 职责

把用户粘进输入框的东西认成「某个人的收藏夹列表」或「某一个收藏夹」。

### 导出

| 导出 | 作用 |
| --- | --- |
| `parseFavInput(raw)` | → `{ kind: 'user' \| 'fav', ... }` 或 null |

### 认得的形态

```text
https://space.bilibili.com/2267573/favlist?fid=63692673&ftype=create
https://www.bilibili.com/medialist/detail/ml63692673
@fav/63692673
2267573          （纯数字按 UID 处理）
```

### 已知坑

UID 和 media_id 都是数字，无法自动分辨，所以 media_id 必须用链接或 `@fav/` 前缀。

### 测试

`test/link.test.mjs`。

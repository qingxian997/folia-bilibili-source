# 2.0.3 待办

2026-11-26 真机反馈的三个问题。下面三条都已实现，只差真机验证与发布（用户要求先不发布）。

---

## P0 升级后启用报错 —— 已完成

**现象**

```text
client activate: The requested module './lib/collections.mjs'
does not provide an export named 'expandPages'
```

手动启用报错一次，重启 Folia 后恢复。

**根因**

宿主只给 client 入口 URL 加 digest query（`folia-mod://bilibili/client.mjs?v=<digest>`），
`client.mjs` 里的相对 import 解析出来不带 query。同一进程内升级后，新 client 会命中
旧的 `lib/*.mjs` 模块缓存，静态 import 阶段直接抛错。

**实现（与最初设想不同）**

原计划「把 client 与 lib 内联成单文件」。落地时放弃了这个做法：

- 手写拼接会撞名（`pad` / `log` 这类短名字在多个模块里都有），要做得对就得写一个真正的打包器
- 仓库没有 esbuild（`node_modules/.bin` 为空），离线装不了
- 内联后测试跑源码、上线跑产物，一旦拼错只有用户能看到

改成**给相对 import 加内容版本号**，同样消除「旧模块缓存」这一类问题，且只有一个实现：

- `scripts/version-imports.mjs`：把 `client.mjs`、`lib/*.mjs`、`vendor/*.mjs` 里每个相对
  import 改写成 `./lib/collections.mjs?v=<该文件内容 sha256 前 8 位>`，输出到 `build/`，
  并写 `build/manifest.json` 记录该进包的文件
- 宿主的协议处理只读 `url.pathname`（`modProtocol.cjs`），query 被忽略，带版本仍能取到文件
- 内容不变 → URL 不变 → 仍走模块缓存；内容一变 → URL 一变 → 重新加载
- `scripts/pack.py`：runtime 包按 manifest 从 `build/` 取，source 包保持原始源码
- `tools/deploy-mod.cjs`：先跑构建，再按 manifest 同步
- `scripts/check-manifest.mjs`：每次检查都会重建 `build/`，并断言没有不带版本号的相对 import
- `build/` 已加进 `.gitignore`

**验证**

- `test/build.test.mjs`：产物存在、相对 import 全带版本、版本化后路径真实存在、
  同一目标各处版本一致、`import(build/client.mjs)` 能拿到 `activate`
- 打包自检：运行包里 `client.mjs` 的 17 个相对 import 全部带 `?v=`

---

## P1 更新后不自动启用、也不弹确认 —— 已完成

**现象**

宿主用 `installModFromZip()` 更新后，模组落到 disabled，既不自动启用，也不弹信任确认。

**根因**

宿主 `zipInstall.cjs`：替换文件后旧 approval 与新 digest 不匹配，必然 disabled。
弹确认的代码在 `setModEnabled()` 里，只有用户手动开关才会走到。

**实现**

- 新增 `lib/afterInstall.mjs`：`ensureEnabledAfterInstall({ mods, id, onManual })`
  - 有 `mods.setEnabled` → 调它，走宿主原生确认流程
  - 没有 / 抛错 → 交给 `onManual`，界面上说清去哪点
- `client.mjs` 的 `installUpdate()`：`installModFromZip` 完成 → 等 600ms 落盘 → 调它
- **不写宿主信任记录**，不改 `mod-system.json`
- `test/afterInstall.test.mjs` 覆盖四条分支

---

## P1 偶现封面空白 —— 已完成

**现象**

书库墙卡片偶尔没有封面，过一会儿或重启才出现。

**根因**

- 客户端自己算 missing，再把 `fillCovers` 回吐的**整份原始 cache** 合并回去，过期项和空数组又回来了
- `fillMissingCovers` 是 single-flight，正在跑时新缺失被丢掉
- 客户端与主进程各有一份冷却时间，互相不知道
- 登录后只补 12 个，其余靠宿主下次读账号，时机不可控

**实现**

主进程（`index.cjs`）：

- 持久化 `coverQueue`（`api.storage` 的 `coverQueue`，含 `ids` / `cooldownUntil` / `step`）
- `ensureCovers({ ids, force })`：只入队，立即返回快照，不阻塞
- `cover.state`：只读快照，客户端轮询用
- worker：串行、每条间隔 900ms、每轮最多 12 条、跨重启续跑
- 限流（`-412 / -799 / -352 / -509`）→ 退避 1 → 5 → 15 分钟，被限流那条留在队首
- 网络失败 / 单条失效 → 跳过继续；**不写负缓存**
- 只有 `code=0` 且夹子真空，才写 5 分钟负结果
- 快照只含新鲜正结果：空数组、过期项、限流一律不出现
- `fillCovers` 改为只回本次新补到的正结果
- `clearCache` 连队列、冷却、退避档位一起清

客户端（`client.mjs`）：

- `fillMissingCovers` 改为「交给队列 + 轮询快照」；登录时把**全部**夹子入队，不在前端截 12 个
- `applyCoverState` 整体替换快照，不再 `{...covers, ...answer.covers}`
- `pumpCovers` 每 3 秒问一次 `cover.state`，`pending` 归零或进入冷却就停（最多 20 轮）
- `loadCovers` 也不再合并旧值

**验证**

`test/covers.test.mjs` 新增三条：入队后后台补完、限流时保留队列并给冷却且不写负缓存、
已有新鲜封面的不重复排队。

---

## 真机结果（2026-11-26 15:15，Folia 0.8.0）

部署：`node tools/deploy-mod.cjs` → 摘要 `sha256:e9d668b7…406e69`，31 个文件（1 个新增）。

| 验证项 | 结果 |
| --- | --- |
| 启用后有无 `expandPages` 报错 | 无。`caps` / `tab` / `lyric` 三个诊断都在 |
| 带版本的相对地址能否取到文件 | `folia-mod://bilibili/lib/collections.mjs?v=deadbeef` → `expandPages` 是函数 |
| 版本号是否真的产生独立模块实例 | `plain === versioned` 为 `false`，说明换版本号必定重新加载 |
| 封面队列 | `ensureCovers(2 个真实收藏夹, force)` → `pending 2 → 0`，两条封面都在，`cooldown 0`、`lastError ''` |
| 书库墙 | 截图里 歌单1 / 默认收藏夹 / 纯音乐 / 我喜欢的音乐 都有封面，没有空白卡 |
| 崩溃日志 | `D:\folia\logs` 没有新增 |

真机还验出一个单测覆盖不到的问题：`force` 在 worker 里被「已有新鲜封面」判断吃掉，
导致「刷新缓存」不会重取。已修（`coverForce` 集合），并补了回归测试。

## 还差什么

- 更新后触发信任确认：需要真有新 Release 才能验，本轮未测
- 已发布为 2.0.3（tag `v2.0.3`），包与源码包都在该 Release 下

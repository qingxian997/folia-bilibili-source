# 架构

## 一句话

`client.mjs` 在渲染进程里把 bilibili 的原始数据翻译成宿主认识的形状，
`index.cjs` 在主进程里负责所有联网、凭据和本地缓存。中间只有一层 RPC。

```text
┌──────────────────────── 渲染进程 ────────────────────────┐
│  client.mjs                                              │
│    activate(folium)                                      │
│      ├─ folium.sources.register(...)   9 项能力           │
│      ├─ 缓存：siteCache / folderCache / meta / covers    │
│      ├─ 分页桥：pendingParts / rangeCursors              │
│      ├─ 宿主适配：hostAdaptation / tabLabel / homeTab    │
│      ├─ 设置面板：settingsPanel.mjs                      │
│      └─ 歌词源注册：loginDiagnosticReport chunk          │
└───────────────────────────┬──────────────────────────────┘
                            │ folium.rpc(name, [payload])
                            │ （渲染进程不直接联网）
┌───────────────────────────┴──────────────────────────────┐
│  index.cjs（主进程）                                      │
│    handle('status') / 'folders' / 'folderItems' / ...     │
│    ├─ HTTP：自定义 Referer / UA / Cookie                  │
│    ├─ 凭据：store.cjs（secret 优先）+ cookie.cjs          │
│    ├─ 缓存：state.views / 封面 / memoCache.cjs            │
│    ├─ 音频：直连 or 本机中转（proxyStream.cjs）           │
│    └─ 更新：update.cjs                                    │
└───────────────────────────┬──────────────────────────────┘
                            │ https
                     api.bilibili.com
```

## 为什么分两层

因为三件事只能主进程做：

1. **自定义请求头**。bilibili 要 `Referer: https://www.bilibili.com/` 和 Cookie，
   渲染进程的 fetch 既带不上 Cookie 也改不了 Referer。
2. **凭据加密存储**。`SESSDATA` 等于账号密码，只能走宿主的 `secret` 字段。
3. **音频中转**。直连拿不到时要在本机开 HTTP 服务转发，渲染进程做不到。

渲染进程只做「形状转换 + DOM 适配 + 界面」，因此 `lib/*.mjs` 全是纯函数，测试不需要网络。

## 模块版本化（升级不炸的前提）

宿主只给模组入口加版本号：

```text
folia-mod://bilibili/client.mjs?v=<digest>
```

而入口里的相对 import 解析出来不带 query。同一进程内升级后，新 client 会命中旧的
`lib/*.mjs` 模块缓存，静态 import 阶段直接抛「does not provide an export named」。

所以打包前先跑 `node scripts/version-imports.mjs`：把每个相对 import 改成
`./lib/x.mjs?v=<该文件内容 sha256 前 8 位>`，产物在 `build/`，包和本机部署都用它。
内容不变 URL 不变（仍复用缓存），内容一变 URL 就变（强制重新加载）。

宿主协议处理只读 `url.pathname`，query 被忽略，所以带版本不影响取文件。

## 九项能力

`folium.sources.register()` 声明的能力名带 `@1`，和 `foliumShared.json` 的版本表对齐。

| 能力 | 实现 | 说明 |
| --- | --- | --- |
| `search@1` | `search` / `searchAlbums` / `searchPlaylists` | 歌曲走视频搜索，合集走 `searchSeasons` |
| `songs@1` | `getSong` | 单曲详情，分 P 补 `pages` |
| `playback.audio@1` | `getAudioUrl` | 四档音质，`getAudioSource` 返回直链或中转地址 |
| `lyrics@1` | `getLyrics` | 跨平台匹配 or CC 字幕，顺序可配 |
| `auth@1` | `auth.*` | 扫码登录、登录态、登出 |
| `library@1` | `getUserPlaylists` / `getUserAlbums` / `getLikedSongIds` / `getLikedSongCount` | 书库墙数据源 |
| `catalog@1` | `getPlaylistTracks` / `getPlaylistDetail` / `getAlbumTracks` / `getAlbumDetail` | 收藏夹与合集的曲目分页 |
| `explore@1` | `getFeed` / `getSectionItems` / `songsShownAs` | 探索页瀑布流 |
| `mutations@1` | `likeSong` / `updatePlaylistTracks` / `canAddToPlaylist` | 写入收藏夹 |

`getAvailability()` 未登录时也返回 `configured: true`，只是附带 `not-signed-in`。
原因：返回 false 时宿主把这一行当未配置，点它不会打开统一登录面板。

## 状态归属

**同一条数据不要在两边各存一份。** 现状：

| 状态 | 归属 | 生命周期 |
| --- | --- | --- |
| Cookie / 登录态 | 主进程 `store.cjs` | 持久，宿主 secret 加密 |
| 视频详情 `state.views` | 主进程 | 10 分钟，上限 300 条 |
| 封面缓存 | 主进程（+ 客户端只读快照） | 7 天；客户端不再持有第二份可写状态 |
| 封面补全队列 | 主进程，落盘 | 跨重启续跑；限流退避 1/5/15 分钟 |
| 收藏夹分页 `folderCache` | 客户端 | 进程内，`clearCaches()` 清 |
| 搜索分页 `siteCache` | 客户端 | 进程内 |
| 分 P 续交 `pendingParts` | 客户端 | 10 分钟过期，最多 8 个视频 |
| 设置值 | 宿主 `paramStore` | 持久，键 `settings:bilibili:bili-source` |

设置项由宿主存，模组只读；`client.mjs` 的 `config()` 是唯一入口。

## 分页模型（最容易错的地方）

宿主按**歌曲** offset 翻页，bilibili 按**视频**位置翻页。一个 59P 视频在宿主眼里是 59 首歌，
在 bilibili 眼里是 1 条记录。

```text
宿主：offset=0 limit=20  →  要 P1…P20
bilibili：第 1 个视频的 page 1..59

readExpandedRange():
  外层  offset/limit   ← 宿主的歌曲数
  内层  rawCursor      ← bilibili 的视频位置
  pendingParts         ← 被 limit 截断在视频内部的剩余 P
```

规则：

- 对外 `nextOffset = offset + items.length`，永远是歌曲数
- 内部用 `pendingParts` 记住「这个视频还有几个 P 没交」
- 展开模式下**不返回 `total`**，避免把视频数当歌曲数
- 探索页不接这条桥，一个视频一张卡（`id = bvid`）

## 音质模型

bilibili 的音频流 id 与用户档位不是一一对应：

| 流 id | 实际 | 对外档位 |
| --- | --- | --- |
| `30216` | 64K | `standard` |
| `30232` | 132K | `high` |
| `30280` | 192K | `ultra` |
| `30380` | 320K | `ultra` 优先 |
| `30251` / `30252` | Hi-Res / FLAC | `lossless` |
| `30250` | 杜比全景声 | `lossless` 降级 |

只声明四档，不声明 `hires`。宿主请求 `hires` 时自动回落到最高已声明档，
正好符合「bilibili 没有比无损更高的档」这一事实。

## 歌词模型

两条来源，顺序可配：

1. **跨平台匹配**：拿 `title + artist` 去宿主其他音源搜，命中即用
2. **CC 字幕**：`x/player/v2` 拿字幕列表，取中文轨，转 LRC

硬约束：`lyrics.lines` 每行必须带 `words` 数组，缺了宿主渲染期直接崩。
`client.mjs` 启动时有自愈逻辑，会修复旧缓存里的坏行。

## 宿主适配层

宿主 DOM 有三套「当前音源」信号，不能混用：

| 场景 | 信号 |
| --- | --- |
| 书库墙 | `localStorage.active_online_provider_id` |
| 搜索页 | `nav.search-sources button[aria-current="true"]` 的文字 |
| 页签改名 | 逐节点判定（见 `lib/tabLabel.mjs`） |

`lib/hostAdaptation.mjs` 是唯一入口，`tabLabel` 和 `homeTab` 都从它取 `roots()` 和
`isBiliActive()`，不要各自再写一套 shadow root 遍历。

## 失败与限流

| 场景 | 策略 |
| --- | --- |
| `-412` | 认为是风控，持久化 `buvid3` 后重试一次 |
| `-799` / `-352` / `429` | 冷却 5 分钟，不重试风暴 |
| 音频中转失败 | 自动回退直连 |
| 字幕缺失 | 回落到跨平台匹配；都失败就返回空，不抛错 |
| 封面限流 | 队列退避 1 → 5 → 15 分钟，被限流那条留在队首，不写负缓存 |
| 封面真空 | 只有 `code=0` 且夹子真空才写 5 分钟负结果 |

## 扩展点

- 新增一个 RPC：`index.cjs` 里 `handle(name, fn)` + `client.mjs` 里 `rpc(name, payload)`
- 新增一项能力：`folium.sources.register({ capabilities })` 里加 `xxx@1`
- 新增一个设置项：`mod.json` 的 `settings` + `client.mjs` 的 `config()`
- 新增模块：`lib/` 放纯函数 + `test/` 放用例，再在 `pack.py` 的文件清单里确认能被打进包

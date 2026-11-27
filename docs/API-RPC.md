# RPC 契约

`index.cjs` 里每个 `handle(name, fn)` 就是一条 RPC，渲染进程用
`folium.rpc(name, [payload])` 调用。**第三个参数必须是数组**，返回值在 `answer.result`。

下面是实际字段，按调用方真正读到的部分写，不是形式化 schema。

## 账号

| RPC | 参数 | 返回 |
| --- | --- | --- |
| `status` | — | `{ loggedIn, mid, uname, face, saved, vipType, vipDueDate, vipLabel }` |
| `qr.generate` | — | `{ url, key, expiresIn }`，`url` 直接喂给二维码生成 |
| `qr.poll` | `{ key }` | `{ stage, ... }`，stage 为 `waiting / scanned / expired / error / ok`；`ok` 时带 `uname / mid / encrypted` |
| `logout` | — | `{ ok: true }` |
| `setCookie` | `{ cookie }` | `{ loggedIn, uname, mid }` |

`status` 打的是 `/x/web-interface/nav`。`settled` 只在 code `0` / `-101` 时为真，
其余错误码继续沿用上次缓存，避免一次风控就把用户显示成未登录。

`vipType` 非 0 时宿主会在账号名旁画会员标记。缓存 profile 时要把这个字段一起存，
否则要等下一次 `/nav` 成功才显示。

## 收藏夹

| RPC | 参数 | 返回 |
| --- | --- | --- |
| `folders` | `{ upMid? }` | `{ mid, loggedIn, owner, folders[] }` |
| `collected` | — | `{ items[] }`，「我收藏的」别人的公开夹与合集 |
| `folderItems` | `{ mediaId, page }` | `{ title, owner, total, hasMore, items[] }` |
| `folderAll` | `{ mediaId, maxPages }` | 同上，`truncated` 表示是否被 `maxPages` 截断 |
| `favDeal` | `{ id, liked, folder }` | `{ ok, folder }`，`id` 支持 `bvid#N` |
| `likedIds` | `{ folder?, expandParts? }` | `{ ids[], folder, baseCount }` |
| `extraItems` | `{ ref, page, owner }` | `{ title, owner, total, hasMore, items[] }` |
| `extras` | `{ refs }` | `{ items[] }`，用户手贴的收藏夹 / 合集 |

`likedIds` 两套语义：

- `expandParts: false`（默认）：返回纯 bvid 列表，`baseCount === ids.length`
- `expandParts: true`：额外补 `bvid#N`，`ids.length > baseCount`

**喜欢态必须展开。** 宿主按 `sourceRef.mediaId` 匹配心形，P2 的 mediaId 是 `bvid#2`，
只给 bvid 时 P2 的心形不会亮。但「喜欢总数」要用 `baseCount`，不能用展开后的长度。

## 封面

| RPC | 参数 | 返回 |
| --- | --- | --- |
| `covers` | — | `{ covers }`，落盘快照 |
| `folderCover` | `{ mediaId, force? }` | `{ covers }`；限流时 `{ ok: false, throttled, code }` |
| `fillCovers` | `{ ids, force? }` | `{ covers, filled, failed }` |

`covers` 的键是 `media_id`，值是封面 URL 数组。收藏夹接口不给封面，
这里取夹内第一条视频的封面，所以可能和夹子内容不完全一致。

## 搜索与探索

| RPC | 参数 | 返回 |
| --- | --- | --- |
| `search` | `{ keyword, page }` | `{ items[], total, hasMore, page }`，item 保留原始字段（带 `bvid`，无 `id`） |
| `searchSeasons` | `{ keyword, page }` | `{ items[], hasMore, page }`，全站合集 |
| `matchFolders` | `{ keyword, ids }` | `{ hits }`，`hits` 是 `{ mediaId: [bvid...] }` |
| `recommend` | `{ ps, freshIdx }` | `{ items[], freshIdx }`，`ps` 上限 30 |

`search` 返回的是**原始条目**，不是歌曲 DTO。渲染侧 `toSong()` 负责转换。
`searchSeasons` 在 `keyword` 为空时直接返回空，不浪费请求。

`matchFolders` 的 `ids` 必须传，否则不知道在哪些夹子里找内容命中。

## 单曲 / 歌词 / 音频

| RPC | 参数 | 返回 |
| --- | --- | --- |
| `song` | `{ id }` | 原始视频对象，关键字段 `bvid / title / pages / cid / duration` |
| `subtitles` | `{ id, preferCC }` | `{ cid, lan, lanDoc, body[] }` |
| `levels` | `{ id }` | `{ cid, candidates }`，`candidates` 是可选音频流 |
| `audio` | `{ id, quality, route }` | `{ url, quality, ... }`，`url` 可能是本机中转地址 |

`id` 统一支持 `bvid` 与 `bvid#N`，拆分是 `index.cjs:421` 的内部函数 `splitId()`，
不是 `lib/bvid.cjs`（那个只做 BV → av 换算）。

`song` 的分 P 兜底：`view` 接口的 `pages` 少于 2 时，再打一次
`x/player/pagelist`。真机遇到过 `view.pages` 为空但 pagelist 完整返回 59P 的视频，
只信 `view` 就会把它显示成一整段。

`audio` 的 `quality` 只接受 `standard / high / ultra / lossless`。
`route` 为 `auto` 时先直连，失败自动切本机中转。

## 维护

| RPC | 参数 | 返回 |
| --- | --- | --- |
| `assets` | `{ match }` | `{ files[] }`，在宿主 asar 里按名字找 chunk |
| `clearCache` | — | `{ ok: true }` |
| `update.check` | `{ force }` | 更新状态对象 |
| `update.state` | — | 同上，不联网 |
| `update.download` | — | 下载 + 校验 sha256 后的本地路径 |
| `update.skip` | `{ version }` | 记录跳过的版本 |

`assets` 是歌词源注册的第三层兜底：入口 chunk 文本找不到
`loginDiagnosticReport-*.js` 时，用它直接在 asar 里按文件名找。

## 错误约定

- 业务失败**不 reject**，返回 `{ ok: false, ... }` 或空列表，由调用方判断
- 抛异常只用于「真的不该发生」的情况（参数非法、内部状态损坏）
- 限流统一带 `throttled: true` 和原始 `code`，方便调用方决定冷却时长
- 未注册的 RPC 返回 `{ ok: false, error: 'rpc-not-found:<name>' }`，不抛错

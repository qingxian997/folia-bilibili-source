# 宿主契约与实现细节

这份文档写给改代码的人：宿主（Folia / Folium）提供什么、我们怎么用、哪些地方不能碰。
普通用户看 [README](../README.md) 就够了。

## 为什么以前画不出来
宿主对模组音源的能力位是写死的（`src/mods/folium/registries/omniProviders.ts` 的 `buildProvider()`）：

```js
capabilities: { auth: !1, userLibrary: !1, playlists: !1, albums: !1,
                artists: !1, recommendations: !1, mutations: !1, ... }
```

宿主用 `capabilities.auth` 判断「这个源有没有账号」（`omni.getProviderSummaries()` 里
`requiresAccount: provider.capabilities.auth`），而 `requiresAccount === false` 会被
`onlineProviderAccountView.ts` 判成 `accountless`，`BravaisHomeSources.tsx` 里
`showList = online.accountView === 'authenticated'` 一假，`items` 直接被清空——**一张卡都不画**。
「收藏」页签（宿主原文叫「歌单」）能不能点，看的是 `homeSources.ts` 的 `canUsePlaylists = userLibrary && playlists`。

于是模组音源注定是「没账号、没曲库、歌单页签灰」的残缺品，只能在墙面上硬贴一层自己的 DOM。

## 现在怎么绕过去
模组和宿主跑在**同一个 JS realm** 里。`document.baseURI` 是
`file:///<安装目录>/resources/app.asar/dist/index.html`，对同一个 URL 再 `import()` 一次拿到的
就是宿主自己用的那个模块实例——registry 里的 Map 是同一张。宿主 buildProvider 造出来的
provider 对象**没有冻结**，可以直接往上挂东西。

`lib/hostlib.mjs` 干三件事：

1. **找 chunk**：入口 chunk 里带一张 `__vite__mapDeps` 依赖表，正则捞出全部 `.js` 文件名；
   先试名字里带 `omni|provider|account|library|service` 的那几个（已经加载过，走模块缓存，不发请求）。
2. **行为探测**，不写死压缩后的变量名：
   - omni：导出对象上同时有 `readAccount` / `getUserPlaylists` / `getCollectionTracks`；
   - 注册表取值函数：一元、源码里有 `.get(`、没有 `.set(` / `.delete(` / `.push(` / `.register(`。
3. **补能力位**（`attachLibrary`）：

```js
provider.capabilities.auth = true;
provider.capabilities.userLibrary = true;
provider.capabilities.playlists = true;
provider.auth = parts.auth;         // 登录 / 登出 / 二维码
provider.library = parts.library;   // getUserPlaylists
provider.catalog = parts.catalog;   // getPlaylistTracks / getPlaylistDetail
provider.mark = { letter: 'B', color: '#FB7299' };
```

补完这一下，宿主自己就会：把 bilibili 排进账号位、把「收藏」页签点亮、调 `getUserPlaylists`
要数据、按自己的排版把收藏夹铺成墙、点开走自己的集合页。宿主的整条链路一行都没改。

## 接口契约（照宿主 `src/types/onlineMusic.ts` 抄的）
```js
library.getUserPlaylists(userId, limit, offset)     // 注意第一个参数是 userId
catalog.getPlaylistTracks(id, limit, offset, collection)
catalog.getPlaylistDetail(id, collection)
auth.getLoginStatus() / logout() / startLogin() / createQr(key) / checkLogin(key) / cancelLogin(key)
```

`getUserPlaylists` 的签名以前写成了 `(limit, offset)`，宿主实际传 `(userId, 50, 0)`，
offset 吃到 limit 的值，永远返回空列表——墙面一张卡都长不出来。这个坑已经修了。

收藏夹 → 歌单卡的映射在 `lib/collections.mjs`（纯函数，可单测）：
`ProviderCollection = { providerId, id, type: 'playlist', name, trackCount, coverUrl, creator }`。
视频 → 歌曲：`UnifiedSong = { id, name, artists: [{ id, name }], album: { id, name, coverUrl },
durationMs, sourceRef: { kind: 'online', providerId, mediaId } }`。

## 封面
bilibili 的收藏夹列表接口**不返回封面**，网页上那张图是夹里第一条视频的封面。这里照做：
`x/v3/fav/resource/list?ps=1` 取第一条，拿它的 `cover`。

这个接口有风控：并发十几条就整片 `HTTP 412`，还会连累 `api.bilibili.com` 整个域名。
所以取封面是**主进程串行 + 700ms 间隔**，一次最多补 40 个，取到的落盘缓存 7 天，
之后 `refreshWall()` 让宿主重读一次账号，它自己就把封面画上了。

## 喜欢按钮
播放器上那个心形按钮是宿主的，模组只管让它亮起来、让点下去真的存到 bilibili。

宿主 `omni.canLikeSong()` 的门槛是三个条件同时为真（`omniProviders.ts` /
`providerSupports`）：

```js
provider.capabilities.mutations === true &&
provider.capabilities.likes === true &&
typeof provider.mutations.likeSong === 'function'
```

所以 `attachLibrary` 里 `mutations` 要一次开两个位：

```js
provider.capabilities.mutations = true;
provider.capabilities.likes = true;
provider.mutations = { likeSong };
```

`likeSong(song, liked)` 拆成两步，因为 bilibili 收藏接口只认 `aid` 不认 `bvid`：

1. `/x/web-interface/view?bvid=` 拿到 `aid`；
2. `POST /x/v3/fav/resource/deal`，form 里 `rid=aid`、`type=2`、`add_media_ids`
   或 `del_media_ids`、`platform=web`、`csrf=`（Cookie 里的 `bili_jct`）。

收进哪个收藏夹由设置里的「「喜欢」用哪个收藏夹」决定，默认取 `fav_state === 1`
的那个（也就是网页上点了「默认收藏夹」的那个），没有就用第一个。

点亮的状态走宿主自己的收藏：`getLikedSongIds()` 直接调
`/x/v3/fav/resource/ids?media_id=`，这个接口**不分页**，实测 1000 条一次给完，
所以返回 `{ ids, whole: true }`——`whole` 告诉宿主「这是全量、可以原地覆盖」，
缺了它宿主只敢做增量合并。宿主日志里能看到：

```
[Like] folium.bili-fav-wall.bili: liked songs read (whole, 1000 ids) applied: 0 added, 0 removed
```

点赞成功后写状态是宿主自己干（`omni.ts` 的 `sendSongLike`），失败它自己回滚心形；
模组只负责把 `favDeal` 的结果如实抛回。

## 手贴的公开收藏夹 / 合集 / 系列
设置里「额外的公开收藏夹」是一个多行框，一行一条，也可以用空格、逗号、分号分隔。
**收藏夹进「收藏」页签，合集和系列进「合集」页签**（这两个名字只在 bilibili 是当前音源时出现；切到别的平台立刻还原成「歌单」「专辑」），
分流和去重在下一节。`lib/extras.mjs` 解析（纯函数，`test/extras.test.mjs` 覆盖）：

| 贴什么 | 认成 | 内部 id |
| --- | --- | --- |
| `ml337285064`、`medialist/detail/ml337285064`、`favlist?fid=337285064` | 收藏夹 | `x-fav-337285064` |
| 纯数字 `337285064` | 收藏夹 | 同上 |
| `space.bilibili.com/3466635/lists/1234?type=season`、`channel/collectiondetail?sid=1234` | 合集 | `x-season-3466635-1234` |
| `…/lists/1234?type=series`、`channel/seriesdetail?sid=1234` | 系列 | `x-series-3466635-1234` |

合集和系列**必须同时有 mid 和 sid**（bilibili 接口按 UP 主 + 合集 id 查），缺 mid 的链接
直接判坏，日志里 warn 一条，不会拖垮整个墙。坏链接不会让页面白屏，其余条目照常显示。

三个接口各走各的路：

- 收藏夹：`/x/v3/fav/resource/list?media_id=&pn=&ps=20`
- 合集：`/x/polymer/web-space/seasons_archives_list?mid=&season_id=&sort_reverse=false&page_num=&page_size=20`
- 系列：`/x/series/archives?mid=&series_id=&only_normal=true&sort=desc&pn=&ps=20`

**`page_size` 只能 ≤20**。列合集的 `seasons_series_list` 传 `page_size=50` 会直接
`-400 请求错误`，所以拉「这个 UP 主有哪些合集」是一页 20、最多翻 3 页，结果按 mid
缓存 10 分钟；歌单卡本身的元信息（名字、条数、封面色）另外缓存 10 分钟，并落盘到
模组存储里，重启不用重拉。

封面还是老办法：收藏夹没有封面字段，取第一条的 `cover`；合集/系列的 `meta` 里
连 `upper` 都没有，UP 主名要用 `/x/web-interface/card?mid=` 补。

## 「我收藏的」和两个页签
bilibili 账号里除了自己建的收藏夹，还有一栏「我收藏的」——别人公开的收藏夹和 UP 主的视频合集。
以前模组只读自建收藏夹，那一栏在 Folia 里完全没有；现在两边都进来，而且**分开两个页签**：

| 来源 | 落到 | 取数 |
| --- | --- | --- |
| 自建收藏夹（`created/list-all`） | 收藏 | `fav/resource/list?media_id=` |
| 手贴的收藏夹 | 收藏 | 同上 |
| 「我收藏的」里的收藏夹（`type: 11`） | 收藏 | 同上，用完整 `id` 当 media_id |
| 手贴的合集 / 系列 | 专辑 | `seasons_archives_list` / `series/archives` |
| 「我收藏的」里的视频合集（`type: 21`） | 专辑 | `seasons_archives_list?mid=&season_id=` |

三个来源按**真实资源 id** 去重（自建 → 手贴 → 账号收藏，先到先得）：同一个夹子既贴了链接又收藏了，
墙上只出现一次，优先留用户自己贴的那条。`lib/collected.mjs` 的 `buildLibrary()` 是纯函数，
`test/collected.test.mjs` 覆盖分类、去重和分流。

### 接口

`GET /x/v3/fav/folder/collected/list?up_mid=<自己的mid>&pn=1&ps=20&platform=web`，
按 `data.has_more` 翻页（实测一页 20 条、最多取 10 页）。**`platform=web` 不能省**——
少了它只返回收藏夹，不带视频合集。主进程压平字段、5 分钟缓存，未登录 / 接口挂了安静返回空，
不会把整面墙搞挂。栏目里 `state: 1`（已失效）和音频、番剧之类的 `type` 都丢掉。

读自己的 mid 要走 `/x/web-interface/nav`，所以**这一栏要扫码登录**；没登录时这一栏安静为空。
真机还踩过一次：`folders` 未登录会直接抛错，早先三个来源用 `Promise.all` 一起等，
结果连设置里手贴的公开合集都进不了「专辑」页签。现在 `readLibrarySources()` 把自建收藏夹
单独降级成空，另外两个来源照常上墙（`test/collected.test.mjs` 覆盖这一路）。

### 「专辑」页签怎么点亮的

宿主判的是 `canUseAlbums = capabilities.userLibrary && !!capabilities.userAlbums`。
模组 provider 的默认 capabilities 里只有 `albums:!1`，**压根没有 `userAlbums` 这个键**，
所以 `lib/hostlib.mjs` 的 `attachLibrary()` 在看到 `library.getUserAlbums` 时补这一位。
宿主随后调 `library.getUserAlbums(userId, limit, offset)`；点开 `type:'album'` 的卡片走
`catalog.getAlbumTracks(id, limit, offset, collection)` **而不是** `getPlaylistTracks`，
详情走 `getAlbumDetail`。四个方法都是宿主原生契约，卡片、墙、集合页依然全是它自己画。
服务端把 bilibili 合集当「专辑」渲染，所以卡片角标可能仍写「专辑 · N 首」。

### 页签只在 bilibili 音源下叫「收藏」「合集」

胶囊上的「歌单 / Playlists」「专辑 / Albums」来自宿主全局 i18n，网易云、QQ 音乐、
Apple Music 共用同一套键，直接改字典会串台。`lib/tabLabel.mjs` 只改渲染出来的文本节点：

| 宿主原文 | bilibili 是当前音源时 | 英文界面 |
| --- | --- | --- |
| 歌单 | 收藏 | `Playlists → Favorites` |
| 专辑 | 合集 | `Albums → Collections` |

判定按**节点所在的语境**分开做（`lib/searchTabs.mjs`）：书库墙和 0.7.26 新搜索页
各有各的当前音源，不能拿一个信号去改整个页面。

| 语境 | 看什么 | 读不到时 |
| --- | --- | --- |
| 书库墙页签 | `localStorage['active_online_provider_id']` 严格等于本模组 provider id | 不改 |
| 新搜索页 `.search-kinds` 分类大标题 | `nav.search-sources` 里 `aria-current="true"` 那个按钮是不是 `bilibili` | 不改 |
| 搜索页其它位置 | — | 一律不改 |

只改「文本精确等于标签且长在按钮/标签里」的节点，切走立刻还原、卸载全还原；
不会误伤「专辑 · N 首」角标或设置里的「显示专辑」。

> **0.7.26 修过一个真 bug**：旧版在 localStorage 读不到时会拿「宿主最近读过我们的库」当兜底。
> 新版的新搜索页 / 跨平台队列会同时预取好几个 provider 的库，这个信号会把网易云的「专辑」
> 也改成「合集」。现在兜底彻底删掉，而且 `restore()` 会连 React 复用的文本节点一起修回来——
> 切平台时宿主常以为文字没变、不会重绘，旧版会把「合集」粘在别的平台上。
>
> **0.7.3 又修了一个**：书库墙的音源和搜索页的音源是两套状态。以前共用书库墙的判定，
> 于是「书库墙停在 bilibili、搜索页切到网易云」时，网易云的分类也变成「合集 / 收藏」。
> 现在两套分开，切到别的平台永远是宿主原生的「专辑 / 歌单」。

> 宿主设置里的「显示专辑」开关得是开的，否则这个页签被用户自己隐藏，合集也就没地方显示。

### 排除收藏夹 / 合集

模组设置「更多设置」里有**两份独立的勾选列表**：

| 设置项 | 列出什么 | 挡住哪里 |
| --- | --- | --- |
| 不显示的收藏夹 | 自建收藏夹 + 账号「我收藏的」+ 手贴的公开收藏夹 | 「收藏」页签、新搜索页的「收藏」结果 |
| 不显示的合集（0.7.8） | 手贴的 UP 主合集 / 系列 + 账号收藏的视频合集 | 「合集」页签、新搜索页里**已接入**的合集结果 |

勾中的卡片不再出现：曲目、封面、翻页都不会被读取，取消勾选立刻恢复。
已排除的条目仍然列在设置里（库快照保持全量），所以随时能改回来。
两份设置值互不干扰，勾掉一个合集不会动到任何收藏夹。

存的不是名字也不是 `raw.key`，而是 `resourceOf(raw)` 这个「真实资源键」
（`fav:<mediaId>` / `season:<mid>:<sid>` / `series:<mid>:<sid>`）：同一个夹子既被
手贴又被账号收藏时，去重和排除用的是同一套键，勾一次就全挡住，换号或改链接也不会漏。
0.7.4 的「全站反查合集」是搜索结果、不属于书库墙，**不进任何一份排除列表** ——
按关键词搜出来的陌生合集照常出现，这是刻意保留的（那些卡片本来就不在你的库里）。
按页签取哪份设置由 `excludedForKind()` 决定，纯函数在 `lib/exclude.mjs`，
用例在 `test/exclude.test.mjs` / `test/searchCollections.test.mjs`。

## 歌词
设置里可选，默认 **跨平台匹配 → CC 字幕**：

| 值 | 行为 |
| --- | --- |
| `match-then-cc`（默认） | 先按「歌名 + UP主」去宿主已登录的平台找歌词，找不到再用视频的 CC 字幕 |
| `cc-then-match` | 反过来 |
| `cc` / `match` | 只用一种 |
| `off` | 不要歌词 |

这项只管**正常播放**。「匹配歌词」窗口里的 bilibili 页签固定只用 CC 字幕，见下一节。

### 手动换一首歌的歌词：bilibili 在页签行末尾

播放页右侧面板 →「歌词」→「在线匹配」，宿主打开的是它自己的「匹配歌词」窗口。那排页签是
网易云音乐 / AMLLDB / QQ 音乐 / 酷狗音乐 / 汽水音乐 / Spotify / Apple Music（0.7.26 新增，需登录且配置了才显示），最后是 **bilibili**。

最后那个不是画上去的，是宿主自己渲染的：点它，搜索框、结果行、选中态、布局全是它原生那一套，
结果行和右侧大预览都会显示 bilibili 视频封面。

**这个页签固定只用该视频的 CC 字幕**，不受上面那项设置影响。点一条结果，取回来的一定是字幕原文
（没有跨平台匹配带来的翻译 / 罗马音）；视频没有 CC 字幕时就明确显示没词，不会拿网易云的词冒充
bilibili 字幕。只对这一首生效；想撤销就在同一个窗口换回别的源——那本来就是宿主的流程。

#### 怎么挂进去的

宿主把歌词源写成打包后的一个常量数组，在 `useLyricSettingsStore` 里导出成 `y`：

```js
S = [{ id:`netease`, labelKey:`lyricProvider.netease`, platform:!0 }, … ,{ id:`spotify`, … },{ id:`appleMusic`, … }]
C = S.map(e => e.id)                       // 导出成 b，优先级列表用的 id 快照
w = new Map(S.map(e => [e.id, e]))          // 注意：这张是模块私有的，没有导出
```

`const` 只锁绑定、不锁内容，所以 `S.push({ id:'bili', … })` 和 `C.push('bili')` 立刻算数——
宿主渲染页签时是 `S.filter(还能用的).map(e => e.id)`，多一项就多一个页签。
（别被 chunk 导出的 `w` 骗了：那个是版权词表数组，不是上面这张元数据 Map。）

麻烦在另外两张按官方那几个 id 建好的**私有** Map（0.7.25 是 6 个，0.7.26 加了 Apple Music 变 7 个）：

- 页签文字链路 `XA(id) → O(id) → t(E(T(id) ? id : 'netease').labelKey)`，`T` 是 `w.has`。
  不认 `bili` 就会回落成「网易云音乐」。
- 取词实现表 `xse`（`Xk = e => xse.get(e)`）**没有兜底**，认不出 id 就选中即崩。

两张都拿不到实例，只能在 `Map.prototype.get` / `has` 上补一条。条件收死：
键是 `bili`、原值本来是 `undefined`、这张表至少 6 项（0.7.25 是 6，0.7.26 是 7，用下界两版都认）、而且 `get('netease')` 有值——四条同时成立才认，
其余所有 Map 原样返回。卸载时把数组项、`C` 里的 id 和两个原型方法全部还原，不留半截状态。

#### 搜索结果要补成「宿主歌曲」形状

窗口拿到的结果不是拿来显示的轻量对象，而是当歌曲用的：`Lm` 读 `e.name`，打分函数 `Es` 读
`name` / `artists[].name` / `album.name` / `durationMs`，保存时的 `rj` 读同一批字段。
而 `folium.omni.searchSongs()` 交回来的是 `{ id, title, artist(字符串), album(字符串), source, ref }`。
直接交上去就是一排空的「0% · Unknown Album」。所以 `toLyricSong()` 补出
`name` / `artists:[{name}]` / `album:{id,name}` / `durationMs` / `coverUrl` / `aliases`，
同时保留 `ref` 和 `sourceRef`。补完之后匹配度百分比才是有意义的（实测 70%、63%、56% 依次排序）。

封面要放在 **`album.coverUrl`**：宿主结果行的 `$A()` 和右侧大预览读的都是 `tl(song).coverUrl`，
通用提取器从 `album.coverUrl` 取。只给顶层 `coverUrl`，两处都会渲染成占位音符方块。
omni 的标准化把封面丢了，所以 `toLyricSong()` 从 `meta` 缓存里把 `toSong()` 存过的原始缩略图捞回来。
实测 50 条结果 + 1 个预览共 51 张 bilibili 图全部加载成功（`naturalWidth > 0`）。

#### 窗口里的取词不借道 omni

早期版本让 `lyricFetch` 调 `folium.omni.getLyrics(song)`，那会绕回本模组的 `getLyrics(song)`，
默认是 `match-then-cc`——第三方先命中，窗口里就变成网易云那套带翻译 / 罗马音的词而不是 CC 字幕。
（顺带一提，那条路还要求 `song.ref` 是宿主发的 `song-xxx` 句柄，自己重拼 `{id,sourceRef}` 会被拒：
`invalid-arguments: pass a song DTO that came from the host`；缺 `sourceRef.providerId` 又会报
`Invalid NetEase id: BV1...`。）

现在窗口直接调模组内部的 `ccTrack(song)`，用 `lib/lrc.mjs` 的 `subtitleToLines()` 把 bilibili 字幕
JSON 行转成 `{ startTime, endTime?, fullText }`（秒），交给宿主 `Zk` 时包成
`{ lyrics:{ lines, isPureMusic:false, isWordByWord:false }, isPureMusic:false }`。
`Zk` 只校验 `lines` 里有非空 `fullText`，所以这就是它认的形状。没有字幕就返回 `null`。
实测取回 15 行带时间轴的字幕、无 `translation` / `romanization`，「保存」可点。

#### 文件名带哈希，怎么找到那个 chunk

`useLyricSettingsStore-Cbyi_7vr.js` 后面的哈希发一次版就换一个。主路径在渲染进程里：
`fetch` 页面那个 `<script type="module">` 的入口 chunk（asar 下 `fetch` 可用，实测 33 KB），
正则捞出 `useLyricSettingsStore-*.js`，再 `import(new URL('./assets/<name>', document.baseURI).href)`。
拿到的是**同一个数组实例**，不是副本。

主进程那条 `assets` RPC（`lib/asar.cjs` 按 asar 头格式列 `dist/assets`）只作兜底：
纯 Node 里读同一个 asar 能命中，但 Electron 主进程里 `fs` 读不到那个目录，实测返回 `{name:''}`，
所以它不再承担主路径。找不到 chunk 就安静跳过：只是少一个页签，播放、搜索、取词照旧全走 provider。

安装是异步的（`await import()`），卸载可能比它先到；用代数计数器而不是布尔标记，
这样热重载「卸载→再装回来」也照样能注册上。安装链路每一步都记在 `window.__biliLyricSource`，
排查时不用猜断在哪一步。

### 音质：显示的是这个视频实际的码率

宿主「默认音质」那四档是写死的 id（`standard` / `high` / `ultra` / `lossless` / `hires`），
模组改不了选项本身，但能改它画出来的字。放着 bilibili 的歌时，面板按**这个视频实际有哪些音频流**
把通名换掉：

| 宿主上写着 | 面板里显示 | 实际选的流 |
| --- | --- | --- |
| 标准 | 64K | 30216 |
| 极高 | 192K（这个视频最高只有 132K 时显示 132K） | 30280 / 30232 |
| 无损 | FLAC，没有就杜比，再没有就 192K | 30251 / 30250 / 30280 |
| Hi-Res | 同上 | 30251 / 30250 / 30280 |

选哪个档位仍然是宿主存的；模组把它翻成 bilibili 的音频流 id（`AUDIO_ORDER`），并在「不高于所选档位」
里挑最高的那个——所以选了无损但视频没有 FLAC 时，拿到的是 192K，不会没声音。

## 播放
`getAudioSource` 返回一个本地反代地址（`http://127.0.0.1:<port>/a?...`，补 `Referer`），
因为 bilibili CDN 会校验来源。设置里可以切「自动 / 只用直链 / 只用本地反代」。

## 设置面板

宿主会在模组设置里自动生成一张声明式表单（`settingsSections.register({ settings, settingsPanel })`），
但**装了 `settingsPanel` 就整块换成自绘面板**（`FoliumSettingsCard` 走 `customPanel` 分支，
挂进 ShadowRoot，容器 `all: initial`，只继承 `--folium-bg / primary / secondary / accent / font`）。
所以面板自己负责所有颜色：拿 `ctx.getTheme().isDaylight` 判明暗，设
`--bf-fg / --bf-dim / --bf-field / --bf-line / --bf-bad`，再 `ctx.onChange()` 跟着主题走。

**面板本体在 `lib/settingsPanel.mjs`（0.9.0 从 `client.mjs` 搬出来）**，用
`createSettingsPanel(deps)` 造出来；`client.mjs` 只传依赖：`rpc / reason / later / auth /
extrasNow / collectedNow / buildLibrary / clearCaches / refreshWall / reloadCovers` 等薄函数。
面板不碰 client 的内部状态，所以能单独读、单独测。

面板分四组，后两组默认折起，标题右边给一句摘要（`先匹配其他平台，再 CC 字幕 · 自动`）：

| 分组 | 字段 |
| --- | --- |
| 账号 | 登录状态、扫码登录（二维码画在面板里，2.2 秒轮一次）、退出登录 |
| 内容 | `likedFolder`、「收藏夹」选择器、`excludeAlbums` 选择器、`extraCollections` 额外列表 |
| 播放与歌词 | `lyrics`、`route` |
| 高级 | `rawTitle`、`maxMinutes`、维护区（清缓存、版本与条目数） |

折叠状态、搜索词、来源分段、登录步骤这些都放在模块级 `ui` 对象里，**不能放进 `paint()` 的局部变量**——
`paint()` 会 `replaceChildren()` 重建整块 DOM，放局部的话用户正在看的列表会被重置。

### 字段 type 只有六种

宿主对 `settings` 字段的 `type` 做白名单校验：只认 `number | text | boolean | select | color | secret`。
写别的（`picker`、`extras`、`folder-select`、`hidden`……）**不会拦住注册，但会在模组卡片上报红字**，
整块面板看起来像坏了。所以界面形态放在自定义键 `ui` 上，`type` 一律写 `text`：

```js
{ key: 'excludedFolders', type: 'text', ui: 'picker', picker: 'folders', ... }
{ key: 'visibleFolders',  type: 'text', ui: 'hidden', ... }   // 只存储，不直接画
```

`secret` 是唯一会加密存储的类型。`cookie` 字段必须留在 schema 里——`modSecrets.cjs` 的
`declare` 靠 `type: 'secret'` 认加密键，删了字段，已登录的凭据就解不出来。它是「声明在、不渲染」。

自己画表单的两个坑：选项不要用全局 `Option` 构造器（ShadowRoot 里不稳），统一
`doc.createElement('option')`；保存要走模组自己的 `settings` 写口，别直接改 DOM 值当已保存。

## 快一点的地方
宿主画一面墙会连着问好几遍同样的问题（`getUserPlaylists` 一刷新就被调、集合页来回滚、
歌词面板和播放器各要一次字幕）。以前每一问都真去 bilibili，既有延迟又容易撞风控（412）。
现在有两层收敛：

**主进程的 60 秒记忆 + 同请求合并**（`index.cjs` 的 `cached(key, ttl, run)`）：

| 记什么 | 多久 |
| --- | --- |
| `nav`（自己的 mid） | 5 分钟 |
| `folders:<mid>`（收藏夹列表） | 60 秒 |
| `liked:<fid>`（「喜欢」的全部 bvid） | 60 秒 |
| `items:<fid>:<page>`（某一页曲目） | 60 秒 |
| `sub:<bvid>`（CC 字幕） | 5 分钟 |

并发问同一个东西只会发一个请求（`inflight` 那张表），收藏、登录、登出、`clearCache`
会按前缀作废对应的记忆。

**渲染进程这边**：

- 一首歌的 CC 字幕和跨平台匹配各只取一次（`lyricCache`，10 分钟，上限 240 条），
  provider 取词、窗口里搜出来的那份共用同一份；**「没找到」只记 60 秒**——匹配是联网的，
  一次抖动就把空结果记 10 分钟，用户看到的就是「没匹配到」再也不变；
- 「额外列表」同时只跑一个请求，TTL 对齐主进程的 10 分钟；
- 让宿主重读账号这件事合并成一次：`scheduleWallRefresh()` 600ms 内多声只跑一遍，
  正在跑的时候再来就排在它后面（收藏、改设置、补完封面都走这里）；
- 改设置不再全部重来：只有 `rawTitle / maxMinutes / extraCollections / route` 真的变了才清缓存，
  在「额外列表」里打字不会一次一次重画整面墙。

## Folia 0.7.26 适配
0.7.26 换了整套 chunk 名（omni / useLyricSettingsStore / remoteActions 的 hash 全变），
模组不写死文件名：从入口 chunk 文本里正则捞，再 `import(new URL('./<name>', entry))`。
真机体检过的功能：

| 功能 | 0.7.26 的要求 | 模组 |
| --- | --- | --- |
| 新搜索页（单曲） | `capabilities.search` + `provider.search.searchSongs` | 沿用宿主 registry，实测 `searchProviderSongs(bili, …)` 返回结果，`sourceRef.providerId` 正确 |
| 新搜索页（专辑 / 歌单两类） | `capabilities.albums` / `playlists` + `provider.search.searchAlbums` / `searchPlaylists`，结果项必须带 `providerId` | 0.7.3 补齐接口；0.7.4 把两类从「只按列表名过滤」扩成三层搜索，见下 |
| 跨平台队列（切平台不清空播放器） | 歌曲 DTO 的 `sourceRef` 要指回自己的 provider | `videoToSong()` / 歌词窗口 DTO 都带 `sourceRef`，切到 netease 再切回正常 |
| 速记簿「加进歌单」 | `capabilities.playlistTrackMutations` + `mutations.updatePlaylistTracks(action, collection, songs)` | 0.7.2 补齐；逐首走现成的 `favDeal`，`canAddToPlaylist()` 只放行自建收藏夹 |
| 新增 Apple Music / 飞牛音乐 | 歌词源表 S 由 6 项变 7 项 | `LYRIC_TABLE_SIZE` 用下界 6，两版都认；bilibili 是页签行末尾那一项 |
| 新平台共用页签 i18n | 改字典会串台；书库墙与搜索页还是两套音源状态 | 0.7.3 起按节点语境分别判定，见「页签只在 bilibili 音源下…」 |

### 新搜索页的三类结果

0.7.26 搜索页顶部是它自己那排音源 tab，下面是 `01 单曲 / 02 专辑 / 03 歌单`
（选中 bilibili 时显示成 `01 单曲 / 02 合集 / 03 收藏`）。宿主的
`getProviderSearchKinds(providerId)` 决定画几个分类，四个条件缺一不可：
`capabilities.search`、`provider.search.searchAlbums` / `searchPlaylists` 存在、
`capabilities.albums` / `playlists` 为真。0.7.3 把它们补齐了。

| 分类 | 宿主调用 | 0.7.4 的数据源（按优先级） |
| --- | --- | --- |
| 单曲 | `searchProviderSongs` | bilibili 全站视频搜索（原有） |
| 合集（原文专辑） | `searchProviderCollections(id, 'album', …)` | ① 已接入合集的名字命中 ② 名字没命中时，从视频搜索结果反查 `ugc_season` 得到的 **bilibili 全站合集** ③ 仍没有就列出全部已接入合集 |
| 收藏（原文歌单） | `searchProviderCollections(id, 'playlist', …)` | ① 收藏夹名字命中 ② 夹内视频标题命中（`fav/resource/list?keyword=`） ③ 都没有就列出全部已接入收藏夹 |

bilibili Web 端**没有**「按关键词搜别人的收藏夹」这种搜索类型（`media_list` / `fav` /
`collection` / `season` 全被 `-1200 被降级过滤的请求` 挡回来），所以「收藏」只能搜已接入的；
「合集」走的是另一条路：视频详情 `x/web-interface/view?bvid=` 会带
`ugc_season = { id, title, cover, mid, ep_count, sections[].episodes[] }`，
把关键词搜到的前 12 条视频反查一遍就能拿到真正的全站合集。结果按关键词缓存 5 分钟，
本地名字已经命中时直接跳过反查，不会每次搜索都发十几个请求。

三层都没命中时**兜底列出全部已接入列表**，保证两个分类不再一片空白；
卡片副标题会写「bilibili 合集」或「包含《关键词》」，说明它为什么出现。
全站合集的 id 是 `w-season-<mid>-<sid>`，自带 mid / sid，`catalog.getAlbumTracks`
不查书库墙快照也能打开，曲目走 `seasons_archives_list`。

结果项就是书库墙用的 `toCollection()`，带 `providerId`、`id`、`type`、封面和条数；
「不显示的收藏夹」设置对已接入列表照样生效。纯函数在 `lib/searchCollections.mjs`，
主进程两个新 RPC 是 `searchSeasons` / `matchFolders`，
用例在 `test/searchCollections.test.mjs`。

`capabilities.albums` 在 0.7.3 起设为 `true`，但不是假装支持歌手专辑目录：
0.7.26 的 `getProviderSearchKinds()` 拿它当「这个源能不能搜专辑」的开关，
而书库墙的「专辑」页签看的是 `userAlbums`（模组 0.7.0 就补了 `true`）。
模组确实实现了 `searchAlbums()`，所以这一位可以诚实打开。
`capabilities.recommendations` 在 0.7.8 起打开（首页推荐 feed 是真实存在的，早先那句
「bilibili 没有推荐 feed」是判断失误）；`capabilities.explore` 在 0.8.0 起打开——
宿主「探索」页签是唯一能原生画「歌曲卡」的地方，点一下直接播、滚到底自动续读。

## 代码结构与边界（0.9.0）

| 位置 | 职责 | 不该做什么 |
| --- | --- | --- |
| `index.cjs` | 所有 bilibili 请求、Cookie、WBI 签名、音频中转、RPC 出口 | 不碰 DOM，不假定窗口存在 |
| `client.mjs` | provider 注册、曲库交给宿主、探索续读、歌词、音质、DOM 改名 | 不直接联网，一律走 `rpc()` |
| `lib/settingsPanel.mjs` | 自绘设置面板（四组、选择器、扫码、维护） | 不读 client 内部变量，只用 `deps` |
| `lib/hostlib.mjs` | 按行为找宿主的 provider / explore store | 不写死 chunk 名，宿主改版就失效 |
| `lib/*.mjs` 其它 | 纯函数：标题清洗、歌词转换、排除规则、额外列表… | 不带副作用，方便单测 |
| `vendor/qrcode.mjs` | 二维码生成 | 不改成动不了的原样，附许可证 |

### 缓存与上限

客户端的表都在写入处裁剪：`siteCache` 12、`folderCache` 40、`qualityCache` 40、
`lyricCache` 240、`failedAt` 200、`forceProxy` 500、`entry.delivered` 20。

主进程的短期记忆（`memo`）走 `lib/memoCache.cjs` 的 `remember()`：300 条先入先出。
**新增缓存必须同时有上限**，否则开着一天的窗口就会一直涨——这类问题在真机上很难发现。

### 权限

只声明真的在用的：`filesystem.data`（存 Cookie 和缓存）、`playback.control`（放歌）。
`scripts/check-manifest.mjs` 会检查「声明了但没有对应调用」的权限并报错，防止顺手多要。

### 硬约束

- `mod.json` 字段是白名单，多写一个（`homepage`、`repository`）在 Folium 2 会是错误。
- `version` 必须三段数字，预览状态靠 GitHub pre-release 表达。
- `folia` 范围是 `>=0.7.22 <0.8.0`；0.8.0 是 Folium 2，到那时重新适配再放开。
- 改了已安装目录里的任何文件，摘要就变了，宿主的信任记录失效，会提示重新确认——这是设计，不是 bug。

### 跑测试的运行时

宿主 Folia 0.7.27 是 Electron 43.7.5（Chrome 150 / Node 24），所以模组代码实际跑在 Node 24 上；
CI 用 Node 22 和 24 两档，22 是下限（jsdom 30 依赖的 undici 8 要求 ≥ 22.19）。
不要为了「兼容 Node 18」往回退写法，宿主不会跑那个版本。

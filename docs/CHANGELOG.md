# 更新记录

每个版本只写用户感觉得到的变化和修掉的坑。版本号在 `mod.json` 里，必须三段数字。

## 0.9.1：探索页不卡了、设置页收起来了、登录不再隔天掉

三个用户点名的问题，加一轮完整代码审查。

### 探索页滑动卡顿

原因是「补一批数据」这一下要重排整面墙（真机测到一次 55~155ms），而老逻辑在你手指还在滑的时候
也可能触发，掉帧就落在最不该掉的那一下。

- **手指还在滑就先不补**：距离上一次滚动不到 220ms 时不动，等停下来再补。一口气滑得特别远
  （超过 2400px）例外 —— 那时宁可中途卡一下，也不能让墙空着。
- **一批少装一点**：每次补的条数从 30 降到 18，单次重排轻了一半。

实测（真机滚 50 下）：掉帧 10 次 → **2 次**，最长一帧 155ms → **70ms**。

### 设置页太占地方

- 四组（账号 / 内容 / 播放与歌词 / 高级）**默认全部收起**，标题右边写一句当前状态，
  比如账号那行直接显示昵称，没登录就写「未登录 · 点开扫码」。
- 内容组里的**收藏夹表和合集表也各自能收起**，收起时显示「共 15 个 · 只显示 4 个」，
  一眼能看出筛掉了多少。默认都是收起的，面板从原来的一整屏变成 157px。

### 登录容易失效

- **游客指纹会存下来了**：以前每次启动都重新申请一次，等于每次重启都换一台「新设备」，
  同一个登录凭据配一堆陌生指纹，很容易被判定成风险流量。现在存一份，下次接着用。
- **不再把「没问到」当成「没登录」**：以前接口被限流或风控挡一下（-412 / -799 / 超时），
  界面就整个变成未登录，看着像掉号了。现在只有 bilibili 明确回答「未登录 / 凭据过期」
  才算掉号，其余情况沿用上次读到的身份。

### 搜索页

- 搜索**之前一条都出不来**（宿主要求的字段没给全，整批被丢掉），补全之后又会白屏
  （歌手字段形状不对，宿主渲染时直接抛错）。现在交付的形状按搜索页的读法给，
  完整信息留给播放器，两处都正常。

### 代码审查顺带修的

- 「推荐」页签的隐藏记录会无界增长（原值是空串时判不出来，每 400ms 重记一条），
  长会话越用越卡。改成判「有没有打过标记」。
- 模组停用后，迟到的回调还会重新挂一批滚动监听，永远不释放。加了停用检查。
- 批量加进收藏夹时如果刚好停用模组，那 250ms 的等待永远不会结束，宿主的操作会一直转圈。
- 歌词匹配拿到的歌手是对象时，搜索词会变成 `[object Object]`，歌手加权也一起失效。
- 额外列表里一行塞了两条时，「移除」按钮点了没反应（分隔符和解析层不一致）。
- 收藏夹读取失败过一次之后，错误提示会一直挂在那，登录成功也不消。
- 搜索页 / 收藏夹的分页缓存没有上限，一直往下翻会一直占内存。
- 歌词源补丁在卸载时无条件还原，会把别的模组后装的补丁一起抹掉。

测试 251（248 pass / 0 fail / 3 skip），新增 6 个用例覆盖上面的修复。

## 0.9.0：整理成能长期维护的样子

功能没变，这次是把地基收拾干净，准备长期放出去。

- **设置面板搬到 `lib/settingsPanel.mjs`**：原来 `client.mjs` 3700 行里，有 900 行是这一块。
  现在它只认传进去的依赖，`client.mjs` 只留接线（3698 → 2851 行）。行为一字未改，19 个面板用例照旧全绿。
- **主进程的短期记忆加上了上限**：以前只有「清缓存」兜底，开着一天的窗口会一直攒（key 里带搜索词、
  收藏夹分页、字幕，值是整页歌曲数组）。现在超过 300 条就先入先出，见 `lib/memoCache.cjs`。
- **去掉没用的 `playback.queue` 权限**：声明了但代码里从来没有调用过，等于让你在信任弹窗里白看一眼。
  现在只留 `filesystem.data` 和 `playback.control` 两项，都是真在用的。
- **补上 `author`**：模组卡片上能看到作者了。
- **仓库化**：README 重写成面向用户的样子（技术细节搬进 `docs/HOST-CONTRACT.md`，逐版本记录搬进
  这份 CHANGELOG），加了 CI、issue 模板、PR 模板、MIT 许可证，以及跨平台的 `scripts/pack.py`。
- **补了截图**：设置面板「内容」「播放与歌词 / 高级」两张，放在 `docs/screenshots/`。收藏夹名字
  是本人的，截图里打了码。
- **方便别人找到它**：仓库加了 topics（`folia`、`folium`、`bilibili`、`lyrics` 等 14 个），
  README 顶部放了下载入口和 CI 徽章，issue 补了 `host-update` / `needs-info` / `upstream` / `login` 四个标签。

## 0.8.6：按截图改的五处
| 位置 | 之前 | 现在 |
| --- | --- | --- |
| 歌词来源摘要 | 先匹配，再字幕 | 先匹配其他平台，再 CC 字幕 |
| 播放线路 | 音频怎么取 | 播放线路（太口语，换成界面常用说法） |
| 来源标签 | 粘贴的 | 手动添加 |
| 收藏夹 / 合集筛选 | 一个全局「筛选方式」下拉，改一处两张表全变 | 每张表自带「勾掉的隐藏 / 只显示勾选的」，各存一份（`albumPickerMode`） |
| 心形存哪个收藏夹 | 两张筛选表后面 | 内容组最上面 |

### 顺带修的

- 「显示原始标题」那行的 `?` 跑到标题和开关正中间：`.bf-head` 原来是 `space-between` 加三段内容，
  中间那段被顶到中间。现在标题 `flex: 1`，`?` 和开关都靠右，和其他行对齐。
- 合集没单独选过筛选方式时跟着收藏夹走（`albumPickerMode` 空值），老配置升级上来不会
  突然整类消失或整类冒出；一旦在合集那张表上点过，两份就完全分开。
- 歌词来源的选项统一成「其他平台 / CC 字幕」的说法，摘要走 `shortLabel`，长名字不挤在标题右边。
- 筛选方式进了 `sigOfSettings()`，不然切完合集的筛选方式墙不会重读。

测试 240（237 pass / 0 fail / 3 skip），新增 `exclude.test.mjs` 1 个「两种模式各管各的」、
`panel.test.mjs` 1 个「点每张表自己的筛选方式」。

## 0.8.5：把设置项挪到该去的地方，全部文案改成说人话
用户拿截图点名两处：「喜欢」存到哪个收藏夹属于「内容」，不该跟播放放一起；「显示原始标题」
是列表长相的事，属于「高级」。顺手把整个模组给用户看的字重写了一遍。

### 分组挪动

| 字段 | 原来 | 现在 |
| --- | --- | --- |
| 「喜欢」存到哪个收藏夹 | 播放与歌词 | 内容（两张筛选表后面） |
| 显示原始标题 | 播放与歌词 | 高级（最上面） |

「播放与歌词」剩下歌词来源和音频怎么取，都是真的在管播放；「内容」是「墙上出现什么」，
心形写到哪个夹子也算这一层。

### 文案：从「说明书」改成「一句话」

原来的说明是写给维护者看的：带接口路径、`Referer`、主进程/渲染进程、`media_count`
这类词，用户读三行还不知道这开关干什么。现在每条只回答两个问题：**动了会怎样**、
**什么时候该动它**。细节仍然收在「?」里，但也是人话。

| 位置 | 之前 | 现在 |
| --- | --- | --- |
| 播放链路 | 自动：先试着直连 bilibili CDN，拿不到再走主进程的本地反代（补 Referer） | 一般不用改。一条走不通会自动换另一条 |
| 歌词来源 | 跨平台匹配 → CC 字幕 | 先匹配，再字幕 |
| 时长过滤 | 0 表示不过滤。合集、直播回放通常几十分钟，会污染搜索结果和探索页 | 填 0 就不过滤。合集和直播回放通常很长 |
| 来源标签 | 自建 / 手贴 | 我建的 / 粘贴的 |
| 计数行 | 已隐藏 9 个 · 墙上显示 2 / 2 | 隐藏 9 个 · 显示 2 / 2 |
| 空白名单 | 白名单还是空的，暂时全部显示（2 个） | 还没勾，先全部显示（共 2 个） |
| 额外列表坏行 | 认不出：`<链接>` | 看不懂：`<链接>` |
| 命令 | bilibili：重新接入曲库 | bilibili：重新接入 |

主进程的错误信息一起改了：`响应不是 JSON` 改「bilibili 这次没返回数据」，
`收藏夹读取失败 403` 改「收藏夹读不到（403）」，`没有可播放的音频流（可能需要登录或大会员）`
改「这首歌放不了（可能要登录或大会员）」。`mod.json` 的描述也从一段 300 字的说明书压成
四句。

改文案牵动了一批断言（`test/main.test.mjs`、`test/panel.test.mjs`、`test/extras.test.mjs`
里匹配旧中文的地方），一并改成新文案；`activate.test.mjs` 的字段顺序按新分组重排。

### 测试与验证

- 单测 238（235 pass / 0 fail / 3 skip）。
- 真机按顺序走了一遍功能完整性：书库墙 → 「收藏」页签（含「我喜欢的音乐」）→ 合集页签 →
  设置面板四组 → 收藏夹/合集筛选 → 黑白名单切换 → 额外列表增删 → 搜索 → 探索页续读 →
  播放与歌词 → 心形收藏 → 退出登录态。结果见当天的 `memory/2026-11-07.md`。
- 性能：主进程与渲染进程各采一次 CPU / 内存，和 0.8.4 对比确认文案改动没有引入任何
  新的定时器或观察器（改动只在字符串和两个 `renderX` 的调用顺序上）。

## 0.8.4：设置页重做，顺手堵掉两处风控口子
用户提了两件事：一是想知道正常用会不会被风控、会不会把宿主拖卡；二是「设置页太凌乱、
收藏夹太多不好选」。第二件先问清方案再动，选的是：**黑白名单都要（可切换）、四组结构、
说明默认收一行、额外列表条目化**。

### 设置页：两组 → 四组

| 组 | 内容 | 默认 |
| --- | --- | --- |
| 账号 | 登录状态、扫码登录（二维码直接画在面板里，2.2 秒轮一次）、退出登录 | 展开 |
| 内容 | 筛选方式（黑/白名单）、收藏夹选择器、合集选择器、额外列表 | 展开 |
| 播放与歌词 | 歌词来源、心形写入哪个收藏夹、播放链路、原始标题 | 折起（标题右显示摘要） |
| 高级 | 时长过滤、清理缓存并重读、版本与条目数 | 折起 |

每条设置只留一行 `hint`，完整说明（接口细节、注意事项那些）收进标题右边的「?」，
点开才出现。之前 8 项里有 6 项挤在「更多设置」，每条 2~4 行说明，面板一眼看不到底。

### 收藏夹 / 合集选择器

- 顶部：搜索框（名字 / UP 主，边打边过滤）、「只看已勾选」、排序（默认 / 名称 / 条数）；
- 按来源分段：自建 / 我收藏的 / 手贴（只有存在该来源时才出现这一颗）；
- 行内保留条数，勾选即时生效；
- 底部一行说清后果：黑名单是「已隐藏 N 个 · 墙上显示 X / 共 M」，白名单是
  「白名单 N 个 · 墙上显示 X / 共 M」；
- 勾选里留着早就删掉 / 换了账号的收藏夹 id 时（它们只存在于排除集合里、列表上没有对应行），
  计数里会点出来「其中 M 个已不在列表里」，并多一个「清掉失效项」按钮 ——
  否则用户看着「已隐藏 9 个」却一个勾都没有，只会以为面板坏了；
- 批量：黑名单给「全部显示」，白名单给「全选（M）」和「清空」。

**两种模式各存一份**：黑名单仍是 `excludedFolders` / `excludedAlbums`（老配置一个字不用改），
白名单新增 `visibleFolders` / `visibleAlbums`。来回切不会丢勾选；白名单空着时按
「全部显示」处理，所以刚切过去不会把墙清空。过滤统一走 `lib/exclude.mjs` 的
`visibilityForKind()` + `excludeCollections()`，后者现在既收老的 Set 也收新的规则对象，
搜索结果那条链路（`lib/searchCollections.mjs`）不用改。

### 额外列表：文本框 → 条目列表

粘贴一条链接就多一行，显示从 bilibili 现读出来的名称、条数和类型（收藏夹 / 合集 / 系列）；
读不出来的行标红（旧配置里遗留的坏行也能这么删掉）；认不出的新链接当场提示、不写进设置。
底层仍然是一行一个 URL 的纯文本，所以旧设置和降级都安全。

### 踩坑：宿主只认六种字段 type

面板是自绘的，本来想给 schema 直接写 `type: 'picker' / 'extras' / 'folder-select' / 'hidden'`
把「画成什么」一起表达出来。装进真机后模组卡片上立刻出现红字：

```
settings likedFolder: type must be one of number, text, boolean, select, color, secret
settings visibleFolders: type must be one of number, text, boolean, select, color, secret
```

宿主对声明式表单的字段类型是白名单校验的（`number / text / boolean / select / color / secret`），
不认自造值。改法是**把界面形态拆到 `ui` 键**（`picker` / `extras` / `folder-select` / `hidden`），
`type` 一律写 `text`（这几个字段存的本来就是字符串）——面板按字段 key 硬编码挑渲染器，
根本不看 `type`。`activate.test.mjs` 里加了一条守护用例：任何一个字段的 `type` 掉出那六种就红。

### 性能与风控：查出来的三处

1. **（真 bug）空收藏夹让封面补抓连发**：`index.cjs` 原来是 `if (filled) await sleep(700)`，
   只有成功才等；空夹 / 私有夹走 `continue`，40 个 id 能毫秒级连发。而且空结果不写缓存，
   每次库墙刷新都重来一遍。现在**失败也等 700ms**，并按 **5 分钟负缓存**记下空结果
   （`COVER_MISS_TTL`），刷墙只读本地。
2. **搜索合集反查**：一次搜索最多 12 个 `view`，3 并发、批间没有间隔。现在批间加 200ms，
   和「翻页 150ms」保持同一个量级。
3. **`homeTab` 的观察器开了 `attributes: true`**：宿主那面墙是 transform 虚拟墙，滚动时
   每帧都在改 style，等于让隐藏器每 120ms 全量扫一遍文档里的 button。0.8.4 去掉属性观察，
   切音源触发的是 childList（胶囊被整个替换），照旧能还原。
4. 播放页的音质补丁原本每 1.2 秒全量扫一次 `div` 找「默认音质」，现在**找到一次就记住**，
   控件还在文档里就不重扫。

实测（宿主 0.7.27，用户正在用的实例，30 秒采样）：GPU 进程 67.6%、渲染进程 55.9%，
其余进程合计 <1%。这两块都跑的是**宿主自己的**毛玻璃墙 / 可视化，模组代码不在 GPU 进程里；
模组自身的常驻开销是 3 个 body 级 MutationObserver + 2 个 400ms 间隔的轻量扫描。

### 兼容性：宿主 0.7.27

升级到 0.7.27 后扫了新的 `app.asar`：`data-bravais-tab`、`lattice-field/lattice-world`、
explore store 的 `loadMoreOf`、以及 `nu()` 里写死的 `t<96 && n<4` 全都还在，只是 chunk 改名
（`BravaisStage-BBJlsE1N.js` / `remoteActions-B8WeAXtM.js`）。0.7.27 另加了一个宿主级开关
「显示推荐」（`showHomeTabRadio`），是全局的，和本模组「只在 bilibili 下隐藏」不冲突。

测试 238（235 pass / 0 fail / 3 skip），新增 `exclude.test.mjs` 5 个黑白名单用例、
`panel.test.mjs` 7 个面板交互用例（四组结构、说明折叠、搜索与筛选、失效勾选清理（含「列表空着时不许清」）、
白名单全选、额外列表增删与坏行标红）、`activate.test.mjs` 里一条字段 type 白名单守护。

真机（宿主 0.7.27 + 0.8.4）走了一遍：四组标题与摘要、9 个「?」默认全部收起、点开再收起、
搜索即时过滤、勾选即时写盘、黑名单↔白名单来回切换（空白名单回落全部显示、勾一个后成 1/2）、
额外列表「移除 → 加回 → 重复添加被挡」、全部还原 —— 宿主的字段校验报错随之消失。

## 0.8.3：修崩溃 —— 音频反代把整个 Folia 拖掉了
用户贴来 `D:\folia\logs\crash-2026-11-07T12-25-40-300Z.log`：

```
Kind       uncaughtException
TypeError: terminated
    at Fetch.onAborted (node:internal/deps/undici/undici:13877:53)
    at Fetch.terminate ...
    at TLSSocket.onHttpSocketClose
```

同一个形状在 2026-11-06 还有两份（13:48、14:47），说明不是偶发。

**根因**：音频反代收尾写的是

```js
const stream = Readable.fromWeb(upstream.body);
request.on('close', () => stream.destroy());
stream.pipe(response);
```

`pipe()` **不转发 `'error'`**。CDN 在传输中途把连接掐断（换歌、拖进度条、网络抖动都会）时，
undici 让 `upstream.body` 以 `TypeError: terminated` 失败，`Readable.fromWeb` 把这个错误
重新发到 Node 流上；没有任何监听者 → Node 升级成**主进程 uncaughtException** →
宿主直接退出。客户端 RST（响应端 `'error'`）是同一类隐患。

**修法**：新增 `lib/proxyStream.cjs` 的 `pipeUpstream()`，用 `stream.pipeline` 接管：

| 处理 | 原因 |
| --- | --- |
| `pipeline(stream, response, cb)` | 给两端都挂 error 监听、出错互相销毁，错误只进回调，不再变未捕获异常 |
| 回调里按 `error.code` 分流 | `ERR_STREAM_PREMATURE_CLOSE` / `ERR_STREAM_DESTROYED` / `ABORT_ERR` 是主动收尾，不记故障；其余（含 `TypeError: terminated`）记一条 warn |
| `request` / `response` 的 `close` + `error` 都接 `dispose()` | 客户端先走时立刻掐上游，不留悬挂连接 |
| `body` 为空或 `fromWeb` 抛错 | 直接结束 / 销毁响应，不再让异常往上冒 |

判定不能只看「有没有 close 过」：pipeline 自己出错时也会先销毁目标流，那样真实的
上游中断会被一起吞掉 —— 这是写用例时发现的（第一版就是这么错的，`onError` 一次都没调到）。

用例 `test/proxyStream.test.mjs`（5 个）：正常灌数据、上游 `TypeError: terminated`、
上游立刻失败、客户端先断开不算故障、空 body。全部只断言「不抛 + 记一次日志 + 响应被销毁」。

顺带确认：模组完全没用到 Electron 的 `net`，所以 `crash-2026-11-07T12-05-25-060Z.log`
那条 `unhandledRejection / net::ERR_CONNECTION_TIMED_OUT`（栈里是 `SimpleURLLoaderWrapper`）
是宿主自己的网络请求，不是这个模组。

## 0.8.2：P0 —— 探索页「随便动一下就整页反复刷新」
用户实测反馈：随便动一下界面，整个窗口就不断地整体刷新。根因是 0.8.1 的
「96 首后续命」用 **600ms 定时轮询 +「最近 4.5 秒有过任意输入」**当触发信号：

1. `noteExploreInput()` 在 `document` capture 上监听 `wheel / scroll / touchmove / keydown`，
   按一下空格暂停、动一下滚轮都把 `exploreInputAt` 续上。
2. `tickExploreContinuation()` 每 600ms 跑一次，只要「最近 4.5s 有输入」且
   `pages>=5 || total>=96`（两者只增不减，到顶后永久为真），就每 1.8s 调一次宿主 `loadMore()`。
3. `loadMore()` 追加 section → 整面墙重排（React 重绘 + 标题卡重算 + 取模铺砖）
   → 浏览器派发 `scroll` → 又回到第 1 步把时间戳续上。

自激闭环：用户动一下就唤醒，之后**宿主自己产生的 scroll** 维持循环，停不下来。

0.8.2 改成**纯事件驱动**，判定抽到 `lib/exploreContinuation.mjs`（纯函数，
`test/exploreContinuation.test.mjs` 12 个用例）。唯一的「进度」是用户**向下滚动的
累计像素**，判定不碰 DOM、不设总批数上限：

**真机实测的宿主滚动机制**（`tools/diag-scroll.js`）：探索墙是
`lattice-field{overflow:clip}` + `lattice-world{transform:matrix(0.76,…,tx,ty)}`
的 transform 虚拟墙。派发 10 次 wheel 后 `wheel:10 / scroll:0`，所有元素的
`scrollTop` 恒为 0，`el.scrollTop = 300` 写进去读回还是 0。所以**不能靠原生
`scroll` /「接近底部」判定**——第一版这么改虽然止住了 P0，但瀑布流也一起停了
（验证脚本里 `grew:false` 就是这么发现的）。

| 闸门 | 作用 |
| --- | --- |
| 只累计 `wheel` / `scroll` / `touchmove` 的**向下**位移 | 宿主重排不派发 wheel / touchmove，自派 scroll 的 scrollTop 恒 0 贡献不了进度；`deltaMode` 按行 / 页折算，单事件最多计 400px |
| `MIN_ADVANCE_PX = 600` | 自上次补批累计不足 600px 不补：按空格、点界面、宿主自派 scroll 全挡掉 |
| `QUIET_MS = 1500` | 补批后静默 1.5s，狂滚也只按这个节奏补 |
| `exploreLoading` in-flight 锁 | 上一批 `loadMore()` 的 Promise 没结束就不补 |
| 补批后进度清零 | 必须再真往下滚一段才有下一批，不会一次滚动带出一串请求 |
| `exploreVisible()` 增补 | 窗口不可见 / 有 `aria-modal` 对话框时清零不判定；设置面板、输入框、弹层里的滚动不计 |
| 不监听 `keydown` / `click`，没有定时器 | 从根上断开「任意输入唤醒 → 宿主重排续命」的自激闭环 |

0.8.1 的数据侧成果全部保留：`fresh_idx` 无上界、不声明 `refreshReadsAnew`、
不设总批数上限、宿主还能自读 4 批 / 96 首时不插手、游标连续 3 次停滞放弃。
瀑布流还在，只是从「后台定时推」变成「用户真的往下滚才拉」。

> 下面 0.8.1 的「续命有几道闸」描述的是旧实现，已由本节取代。

## 0.8.1：撤掉「推荐」页签、把探索页改成真正的瀑布流
用户提了三个问题：「删掉 bilibili 音源的推荐页签」「『为你推荐 27 首歌』那个大卡有什么必要」
「一直往下翻探索好像都是重复的，应该是不断的瀑布流」。查完宿主 bundle、并用
`fresh_idx=1/201/401/601/801/1201/2001` 实测 bilibili 首页推荐能持续给新歌之后，
确认的落地方式是：只在 bilibili 下隐藏推荐胶囊、只留「我喜欢的音乐」、不新增页签、
照原样显示（不额外去重）。

### 1. 「推荐」页签只在 bilibili 下隐藏

「推荐」是宿主顶栏的**全局**胶囊（`lo()` 里 `key:'radio'`，i18n 键 `home.radioTab`），
由全局设置 `show_home_tab_radio` 和当前音源的 `capabilities.recommendations` 控制。
模组没有「按音源隐藏页签」的 API：写 localStorage 会把网易云 / QQ 音乐一起藏掉，
关能力位只会让它变灰而不是消失。所以两边一起做：

* 不再声明 `capabilities.recommendations`，也不再挂 `getRecommendedCollections()`：
  `canUseRadio` 为 false，键盘循环页签会跳过「推荐」，不会落进空白页。
* `lib/homeTab.mjs` 在 `isBiliActive()`（书库墙当前音源 =
  `localStorage.active_online_provider_id`）为真时，把那颗胶囊 `display:none`；
  切到其它音源、模组卸载都立刻还原。命中规则是 `button[data-bravais-tab="radio"]`
  （Bravais 书库缝），或「按钮正文是 推荐 / 推薦 / Radio 且同一排里还有至少两个
  别的首页页签」（Grid 首页）。设置页的「显示推荐」开关不在这排里，不会误伤。
  注意宿主会给这颗按钮挂 `disabledReason`，`aria-label` 不再是「推荐」，
  所以判定必须看**正文**。
* 如果藏掉的正好是当前页签（`last_home_view_tab === 'radio'`），顺手点一下
  「收藏」，不把用户留在没有页签的空白页。
* 真机回归（0.8.1 收尾）：切音源时宿主会重绘那排胶囊，新节点把 inline
  `display:none` 带过来却丢了我们打的 JS 标记。只还原「自己记录过的旧节点」会漏掉它，
  实测「切到网易云，推荐页签还是不见」。现在非 bilibili 时会用 `radioTabNodes()`
  把当前这颗胶囊上的残留 `none` 一并清掉；`hideOne()` 也不会把残留的 `none` 记成
  「原值」，否则还原时又写回 `none`、形成死锁。`test/homeTab.test.mjs` 两个用例覆盖。

原来 0.8.0 的 8 张入口卡只保留「我喜欢的音乐」，搬到书库墙「收藏」页签：
`getUserPlaylists()` 在最前面 unshift 一张 `isLiked:true` 的 `w-liked` 特殊卡
（宿主 `BravaisHome.Te()` 认 `raw.isLiked`），同时把红心真正写入的那个夹子从普通
列表里去掉，免得同一批歌出现两张卡。点开仍走 `tracksOf('w-liked')` 递归解析。
`lib/recommend.mjs` 因此瘦成「我喜欢的音乐」+ 旧版 `w-reco-<bvid>` 卡的开卡兜底。

### 2. 「为你推荐 27 首歌」是宿主画的，不是 bilibili 卡

`BravaisHome` 的 `ut()` 会**为每个探索 section 强制生成一张** `kind:'feed'` 标题卡：
`title = section.heading`（来自 `section.title`）、副标题是条目数、角标 `04 / 05`。
0.8.0 每个 section 都叫「为你推荐」，宿主自动续读 1 初始 + 4 批，于是出现了 5 张
同名大卡。这是宿主分区制自带的，模组没法单独关掉卡片；用户选择「只修现有探索页」
时该选项已写明「分区标题卡还在」，所以 0.8.1 保持原样。

### 3. 探索页为什么重复，以及怎么修

| 原因 | 位置 | 0.8.1 的处理 |
| --- | --- | --- |
| `MAX_FRESH_IDX = 400` 回绕：`fresh_idx` 到 400 就回到 1，整批重来 | `lib/feed.cjs` / `index.cjs` / `client.mjs` / `lib/explore.mjs` | 全删。实测 `fresh_idx=1/201/401/601/801/1201/2001` 每批 30 首、`code=0`、210 首零重复，上限纯属模组自己加的 |
| `refreshReadsAnew:true` 让「换一批」跳过 `getExploreSectionItems()` 追加、重放旧池子 | `lib/explore.mjs` 的 `feedAnswer()` | 不再声明。点「换一批」会老实拉 `moreCursor` 追加新歌 |
| `nu()` 写死 `t<96 && n<4`：一次 read 最多自动续读 4 批 / 96 首，之后书库墙按取模循环铺同一批 tile | 宿主 `remoteActions-*.js` / `wall-*.js` | `lib/hostlib.mjs` 按行为找到宿主那张 explore store，`client.mjs` 在宿主停手后自己调 `loadMore()` 追加新 section：不重置滚动、不新增页签 |

续命有几道闸，避免后台空转把 bilibili 刷成 -412：只在 bilibili 是当前音源、
当前在探索页、用户最近 4.5 秒内有滚轮 / 触摸 / 方向键时才补；每 1.8 秒最多补一批；
`loadMore()` 后游标连续 3 次不推进就安静放弃。宿主版本变了找不到 store 就退化成
「宿主自己续读 4 批」。

**不设总批数上限**：0.8.1 首版曾按 `feed.read` 限「每个 read 最多补 8 批」，真机实测
feed 涨到 12 sections / 330 首、游标 `bili:feed:673` 后就撞上限不再追加，继续往下翻
又变成重复铺砖——这跟「刷久了整批重来」是同一种病，只是推迟到第 330 首。现在改成
「用户停手就不加载、还在滚就一直有」，节流只靠空闲时间和冷却。

按用户选择「照原样显示」，模组侧不再用 `exploreSeen` 做全局去重，接口给什么就画什么；
宿主自己会在 section pool 里用 `fl()` / `xl()` 过滤重复条目。

改动文件：`lib/feed.cjs`、`index.cjs`、`lib/explore.mjs`、`lib/recommend.mjs`、
`lib/homeTab.mjs`（新）、`lib/hostlib.mjs`、`client.mjs`、`mod.json`、
`test/feed.test.mjs` / `explore.test.mjs` / `recommend.test.mjs` /
`homeTab.test.mjs`（新）/ `hostlib.test.mjs`。测试 209（206 pass / 0 fail / 3 skip）。

> 0.8.1 起推荐页签已撤掉，下面记录的是 0.8.0 当时的方案与宿主契约，
> 其中「8 张入口卡」「bvid 集合去重」「400 回绕」已不再是当前行为。

## 0.8.0：推荐页签与探索页签的分工
宿主 0.7.26 的 `remoteActions-*.js` 里，`Ol()` 把 `getHomeFeed(35)` 的结果一律映射成
集合卡（`radio` / `daily_recommendations` / `playlist`）——**「推荐」页签没有歌曲卡这一类型**。
0.7.x 那种「一首视频一张 `trackCount=1` 的歌单」就是被这个契约逼出来的。
歌曲卡在另一个页签：`capabilities.explore` + `provider.explore.getFeed()` /
`getSectionItems()`，宿主的 `useExploreWall` 负责画卡、接播放和自动续读。

因此 0.8.0 改成：

| 页签 | 内容 | 说明 |
| --- | --- | --- |
| 推荐 | 「我喜欢的音乐」+「bilibili 推荐流」+ 自己的收藏夹（不足 8 张时用推荐分组补） | 不再实现 `getDailySongs()`，宿主的「每日推荐」卡自动消失；「我喜欢的音乐」带 `isLiked:true`，宿主会画成特殊卡并给竖排快捷入口，点开就是红心写入的那个收藏夹 |
| 探索 | 每批 30 首的歌曲卡 | 滚到底自动续读（`nextCursor`），每区「更多」（`moreCursor`），顶部「换一批」重新取数；游标是 bilibili 的 `fresh_idx`，用 bvid 集合去重 |

「推荐」页签的入口卡都是**多曲合集**，不再是只有一首歌的歌单；点开走
`catalog.getPlaylistTracks()`，`w-liked` 解析到红心收藏夹，`w-reco-all` /
`w-reco-group-N` 切当前这一批推荐。宿主的书库墙是无限平铺的，卡太少会被复制满屏
（0.7.8 那次「界面一团糟」），所以固定补到 8 张互不相同的卡。

限制：宿主自动续读最多 4 批 / 96 首；0.8.1 起模组会在宿主停手后自己追加 section
（见上一节），不再需要一直点「更多」。探索页要求账号处于登录态（宿主
`accountView === 'authenticated'`，游客态显示空态）。`fresh_idx` 没有上限，一直往后推。
纯函数在 `lib/explore.mjs` 和 `lib/recommend.mjs`，用例在
`test/explore.test.mjs` / `test/recommend.test.mjs`。

## 0.7.9：推荐页满屏重复卡 + 点开白屏
**症状**：0.7.8 切到书库首页「推荐」页签，整面墙都是同一张「每日推荐」卡
（一屏 21 张、全墙 80+ 张，tile 的 key 全是
`card:daily_recommendations:daily_recommendations`），封面全是粉色占位；
点进去整个窗口白屏，点什么都没反应。

两个独立根因：

1. **墙上只有一张卡**。宿主 `homeSources` 把 `getRecommendedCollections()` 的结果
   直接铺到墙上，0.7.8 没实现这个方法，只剩「每日推荐」一张卡，平铺算法就
   拿它把槽位复制填满。现在每个推荐视频一张 `w-reco-<bvid>` 卡，各带自己的
   封面、标题和 UP 主；点开走 `getCollectionTracks()` → `tracksOf()` 按 key
   直接回这一批里的那首歌，不依赖书库墙快照。
2. **给了裸 song**。宿主 `omni.getDailySongs()` 是**直接透传** provider 返回值的，
   不像 `searchSongs` / `getCollectionTracks` 会标准化歌曲 DTO。0.7.8 用的是
   `toSong()`（只有 `title`、`album:''`、顶层 `coverUrl`），于是：
   - `songCoverUrl()` 从 `album.coverUrl` 取封面 → 空，卡面变成占位色块；
   - 集合页墙做文本排版读 `song.name` → `undefined.length` 抛 `TypeError`
     （`layout-*.js` 的 `Je()`），整棵 React 树被卸载，就是那个白屏。

   现在改用模组里本来就在用的 `videoToSong()`，一次给全
   `name / title / artists[{name}] / album.coverUrl / durationMs / sourceRef`。
   同时也修好了曲目播放所需的 `sourceRef`（队列 / 历史 / 歌词都认这个）。

两个方法的取数合并成 `recommendFeed()`：同一批 feed 既给曲目也给卡，
5 分钟缓存只对一次 RPC 生效，点开卡片不会看到「换了一批」。
卡片 id 自带 bvid，但墙上的卡可能比缓存活得久：换一批之后旧卡的 bvid 不在新批次里，
只从当前缓存找就会得到「0 首 / 暂无内容」。所以 `recoItems` 跨批累积元数据，
`recoTrackRaw()` 再用卡片自身的 `name` / `coverUrl` / `creator` 兜底 —— 播放只认
`sourceRef` 里的 bvid，任何一张出现过的卡都能点开并播。
纯函数在 `lib/recommend.mjs`（`recoKey` / `parseRecoKey` / `feedToCollections`），
用例 `test/recommend.test.mjs` 里有一条专门守着「完整 DTO」这条契约。

## 0.7.8：推荐页 + 合集排除
> 以下是 0.7.8 / 0.7.9 的历史实现。0.8.0 起 `getDailySongs()` 已移除、
> 推荐页签只留入口卡，歌曲瀑布流搬到了「探索」页签，见前面的 0.8.0 一节。

### 书库首页「推荐」页签

宿主的「推荐」页签（`homeSources.ts` 的 `canUseRadio = capabilities.recommendations`）
由 `omni.getHomeFeed(35)` 供数，它会并发问 provider 三件事：
`getPersonalFm()` / `getDailySongs()` / `getRecommendedCollections(35)`。
0.7.8 只实现 **`getDailySongs()`**，把 bilibili 首页推荐 feed 交给宿主那张
「每日推荐」卡（自带刷新按钮）；另外两个不实现。这个取舍在 0.7.9 被改正：
`getRecommendedCollections()` 也必须实现，否则墙会被同一张卡填满（见上）。

```text
书库首页「推荐」页签
  → omni.getHomeFeed(35) → provider.recommendations.getDailySongs()
  → client rpc('recommend') → 主进程 GET /x/web-interface/wbi/index/top/feed/rcmd
  → lib/feed.cjs 过滤出 goto=av 的视频、秒转毫秒、封面补 https
  → videoToSong()（0.7.9 起；0.7.8 的 toSong() 会白屏）→ 宿主的「每日推荐」卡
```

- 带 Cookie 时是账号的个性化推荐，未登录时接口给通用热门，一样能播。
- `ps` 上限实测是 30（32 起一律 `-400 请求错误`），宿主虽然按 35 个推荐位问，
  这里最多给 30 条；上限写成 `MAX_FEED_PAGE` 常量并有测试守着。
- 一批内容在 5 分钟内保持稳定：宿主画墙问一次、点开卡片又问一次，
  两次都真去请求会让 30 首突然换成另一批。过期后把 `fresh_idx` 往后推，自然换一批。
- `fresh_idx` 累加到 400 就回到 1，避免被风控；接口失败时保留上一批，不让卡片突然空白。
- 页签本身还受宿主设置里的「显示电台 / 推荐」开关控制，那一关得是开的。
- 纯函数在 `lib/feed.cjs`，用例 `test/feed.test.mjs`；能力位挂载在 `lib/hostlib.mjs`。

### 「不显示的合集」

新增独立设置项 `excludedAlbums`，和原来的 `excludedFolders` 完全分开：
`getUserAlbums()` 与新搜索页的「合集」类各读各的那份黑名单，
`excludedForKind(values, kind)` 负责按页签取值。升级上来只有旧字段时，
合集黑名单是空的 —— 不会一升级就把 44 张合集全挡掉。

全站反查出来的合集（`w-season-<mid>-<sid>`）**不受排除影响**：它们不是已接入的库，
`collectCandidates()` 只用 `excluded` 过滤本地 `source`，`remote` 那一路照常进结果。
被排除的合集也不再算「本地名字命中」，否则会错误跳过全站反查。

## 0.7.7：应用 CC 字幕之后整窗白屏
**症状**：播放器页里给一首 bilibili 歌搜到 CC 字幕、点「应用」，之后整个窗口变成白/黑，点什么都没反应，只能强退重开。

**根因**：`lyricFetch` 把 CC 字幕直接当宿主歌词行交上去，行里只有 `startTime` / `endTime` / `fullText`。宿主的歌词模型 `monetLyricsModel` 里 `G(line)` 第一句就是 `line.words.length`——键不在就抛 `TypeError: Cannot read properties of undefined (reading 'length')`；而它跑在 React 渲染期间，异常把整棵树卸载掉，于是整窗白屏。宿主自己解析出来的行一定带 `words`（逐字歌词才有内容，普通行是空数组），我们漏了这个字段。

复现时抓到的堆栈：

```text
Uncaught TypeError: Cannot read properties of undefined (reading 'length')
    at G (monetLyricsModel-BmKNncnm.js:1:2080)     // if (t.words.length === 0)
    at K (monetLyricsModel-BmKNncnm.js:1:2519)
    at N (monetLyricsModel-BmKNncnm.js:1:823)
    at ee (monetLyricsModel-BmKNncnm.js:1:5192)
    at Pe (VisualizerMonet-DnDwv1Uk.js:1:8527)
```

**修复**（`lib/lrc.mjs`）

- `subtitleToLines()` 每行都带 `words: []`。
- 顺手补齐时间区间：缺 `to`、或 `to` 不晚于 `from` 的行，用下一行起点当终点，末行 +3 秒。否则「当前行」永远推进不了，歌词会卡在某一句上不滚。

**已经写进宿主库的旧记录也要救**（`client.mjs`）

宿主把匹配结果按行原样存进 `KineticPlayerDB` 的 `metadata_cache`：key 是 `lyric_online:folium.bili-fav-wall.bili:<bvid>_state`，歌词在 `data.onlineOverrideLyrics.lines`。升级代码不会动这些记录，播到那首歌照样崩，而且崩的时候连「重新匹配」的界面都打不开。所以启动后延迟 2.5 秒扫一遍本 provider 的 key，给缺 `words` 的行补空数组，成功后写 `bili:lyric-cache-repair:v1` 标记，以后不再扫库。

实测这台机器 140 条记录里有 3 条是应用 CC 字幕留下的（38 / 25 / 56 行全缺 `words`），启动后补了 3 条，进播放器页不再抛异常。

新增测试：行必须带 `words`（守住这个契约）、缺 `to` 的补齐、`fillMissingWords()` 幂等。

## 0.7.6：第二轮审计
针对 0.7.5 复查报告的 1 条 P0 + 3 条 P1 + 5 条 P2。逐条对代码核实后动手，其中一条（跨平台歌词匹配）经查是**报告读错了字段**，没有改。

**P0 尾部永不收敛**（`lib/collections.mjs`）

0.7.5 的游标改成了原始下标，但 `hasMore` 在「接口说没有下一页」时仍然拿 `total` 比长短。收藏夹的 `media_count` 不扣失效视频、搜索的 `numResults` 常年虚高，于是尾部永远「还差几条」，`nextOffset` 不再前进 → 集合页底部一直转圈。

- 判定顺序改成：**这一页还有没交付的原始槽位 → true**；**接口说没了 / 连续空页 → false**；都没有再用 `total` 比。
- 一条都交付不出来时一律 `hasMore:false`——宿主适配层用「交付条数」算下一个 offset，0 条就是原地不动。
- `fromSite` 不再缓存空结果：留着它只会让同一个 offset 反复拿到空页，还挡掉「后面几页其实有内容」的可能。
- 实测（默认收藏夹 1330 首，含失效视频）：一屏一屏翻到到底，最后一次 `hasMore:false`，不再有 `nextOffset` 不前进的轮次。新增 2 个回归用例（末尾失效混排、整页被过滤）。

**P1 三条**

- 补 `mutations.canEditPlaylistTracks`：宿主 `canEditCollectionTracks` 的逻辑是「有这一位且没返回 false」，不实现就默认 true —— 只读的合集（`type:'album'`）在界面上有增删曲目入口，点下去只能报错。现在只有纯数字 id 的自建收藏夹算可编辑。
- `attachToHost` 重试耗尽不再只写一行日志：弹提示，并新增命令 **bilibili：重新接入曲库**，不用为了一次顺序竞争重载整个模组。
- `Map.prototype` 拦截条件收紧：不再用「size≥6 且碰巧有 netease」，改成**表里查得到的官方音源 id 达到下界**才认（官方 id 取自宿主自己的歌词源表）。补丁打的是原型、跨模组可见，宁可判严。

**P2 五条**

- `isOwned` 放开到全部自建收藏夹（以前只有默认夹带这一位，其余会被宿主当成「别人的」）。
- 声明 `playback.audioQualityLevels = ['standard','high','lossless']`：以前宿主回落四档，而 bilibili 的 `hires` 与 `lossless` 取的是同一个 FLAC 流，用户以为选了两档、听到的是同一个。
- 反代**只对 bilibili 接口域名带 Cookie**，`*.bilivideo.*` / `*.hdslb.com` / `akamai` / `szbdyd` 这类音频 CDN 只带 UA 与 Referer。SESSDATA 没必要跟着音频请求散到一堆第三方域名上。
- 批量改收藏夹加 250ms 间隔、失败即停，并把「已经改好 N 首」报回去，不再一次 50 连发吃 412、失败还不知道改了几首。
- 面向用户的错误去掉 `bili:` 日志前缀（日志里保留）。RPC 注册处统一摘，不再逐个改字符串。

**文案**

- `mod.json` 描述从约 700 字压到 173 字，变更日志留在 README；「合辑」统一成「合集」。
- 「不显示的收藏夹」说明里写合集不受影响，代码却顺手过滤了 `snap.albums` —— 删掉那行过滤，让行为和文案一致。
- 设置面板的折叠状态改成每个实例一份；强调色优先读宿主主题色，读不到才用 bilibili 粉。

**报告判错的一条：跨平台歌词匹配**

报告说 `hostProviders()` 读的 `origin` / `supports` 字段在宿主里不存在，所以默认的「跨平台匹配 → CC」第一段永远失败。实测不成立：`folium.omni.listProviders()` 返回的不是内部 `getProviderSummaries()`（那份确实只有 `providerId / status / user …`），而是经 `RBe()` 包装过的表，字段是

```
providerId, displayName, shortName, origin: 'host'|'mod', selected, configured,
supports: { search, resolve, lyrics, albums, artists }
```

宿主 `omni-DX…` 里的 `getProviderSummaries()` 只用于内部与调试。所以筛选条件本来就是对的，不需要改。为了这个误判不再重复发生，加了两处保险：筛选为空时退一步用「已登录 + 不是模组音源」，以及真要匹配却一个源都没有时打一条日志说明原因。

## 0.7.5：审计修复
第三方审计报告（针对 Folium 1.8）列了 3 条 P0 + 5 条 P1 + 9 条 P2。逐条核对代码后，确认为真的都修了，属于推断或已不成立的写在下面。

**P0-1 分页错位与无限空页**（`lib/collections.mjs`、`index.cjs`）

旧实现用「交付条数」当 offset，却用「原始 20 条」换算页码。收藏夹里只要有一条失效视频被过滤掉，两者就对不上：下一次 `offset / 20` 落回上一页中间，曲目重复；尾部整页失效时交付条数不前进，`hasMore` 恒真，集合页无限滚动对着同一页猛敲。

- offset / nextOffset 统一成**原始下标**，游标按「这一页消费到第几个原始位置」推进。
- `folderItems` / `extraItems` 不再删除失效条目，改成打 `playable:false` 占位——位置信息必须留着，否则页码无从对齐。
- 响应内按 bvid 去重；连续两页没有可交付内容即判定到底。
- `hasMore` 区分「没有下一页」和「这一页还没取完」，避免刚好填满一页时误报到底。
- 新增 4 个回归用例：失效条目混排不重复、尾部整页失效必须收敛、45 条要 50 条的情况、`keep` 过滤不占交付名额但占原始下标。

**P0-2 反代 URL 跨激活失效**

反代地址绑在本次激活的随机端口和随机 token 上，模组重载后队列里的旧地址必然 403 / 连接被拒，而模组没有任何失败回调。

- `expiresAt` 改用 URL 里的 `deadline` 参数（取不到退回 30 分钟，不再硬编码 90 分钟）。
- 播放地址新增 `volatile: true`，告诉宿主这条地址不可跨会话缓存。
- 订阅 `folium.events.on('playback.failed')`：只对 bilibili 自己的歌生效，清掉 `streams:` 缓存、标记走反代、让宿主重播一次；同一首 8 秒内只抢救一次，避免失败→重播→再失败的死循环。
- `ensureProxy()` 失败后释放 `state.pending`，不再永久卡在 rejected。

**P1**

- 搜索 `hasMore` 不再用过滤后的条数算：`keep` 只影响交付，不参与页码换算，「过滤长视频」开着也不会十几条就到底。`fromFolder` 与 `fromSite` 都走同一个 `readTrackRange`。
- 反代 `fetch` 加 20 秒首字节超时（`AbortController`），超时返回 504 而不是让播放器永久转圈。
- `playurl` 对 412 / 超时 / 连接重置做 3 次退避重试；「没有音频流」「需要大会员」这类不重试，直接给可读错误。
- `attachLibrary()` 回读确认真的挂上去了，失败时返回 false 并弹提示——不再静默留下空白书库墙。

**P2**

- `forceProxy` 现在真的会写入（播放失败时标记），直连成功时移除。
- `meta`（2000）、`folderCache`（40）、`state.views`（300）加容量上限。
- 所有延迟执行走统一的 `later()`，dispose 一把清空定时器，置 `disposed` 标志，`refreshWall` 首行判停用。
- 同一关键词同一页做 in-flight 去重；关键词截断到 80 字符。
- `AUDIO_ORDER` 补上 `ultra` 键（值同 `high`，bilibili 在 192K 与 FLAC 之间没有中间档），不再靠 `||` 兜底。

**没改的**

- `toSong` 与 `videoToSong` 的字段形状仍未合并。搜索页和曲库走的是宿主两条不同的消费路径（一条读顶层 `coverUrl`、一条读 `album.coverUrl`），合并需要宿主侧确认，贸然改会让搜索页封面变占位图。当前两条链路都显示正常。
- `quality` 的枚举值与 `expiresAt` 是否被宿主消费仍无法从模组侧确认，属于宿主行为，留待真机日志。

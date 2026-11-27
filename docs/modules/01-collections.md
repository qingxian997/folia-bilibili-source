# 01 · 曲库映射与分页（`collections.mjs` / `extras.mjs`）

## `lib/collections.mjs`（375 行）

### 职责

把 bilibili 的数据翻成宿主的两个形状：

- 收藏夹 → `ProviderCollection`
- 视频 → `UnifiedSong`

纯映射，不联网、不碰 DOM。它是全项目最需要小心的一层，因为**分页语义**和**分 P 身份**
两个概念都压在这里。

### 导出

| 导出 | 签名 | 作用 |
| --- | --- | --- |
| `FOLDER_PAGE_SIZE` | `20` | bilibili 收藏夹一页固定 20 条，与宿主 `limit` 无关 |
| `foldersToCollections` | `(folders, options)` | 收藏夹数组 → 宿主卡片 |
| `videoToSong` | `(raw, options)` | 单个视频 → 歌曲 DTO |
| `expandPages` | `(raw)` | 视频 → 分 P 变体数组；单 P 返回 `[raw]` |
| `videoToSongs` | `(raw, options)` | `expandPages` + `videoToSong` 的组合 |
| `readTrackRange` | `({ offset, limit, fetchPage, pageSize, keep, expand })` | 内层分页，**offset 是视频位置** |
| `readExpandedRange` | `({ offset, limit, key, fetchPage, pageSize, keep, expand, pendingParts, rangeCursors, now })` | 外层分页桥，**offset 是歌曲数** |
| `trimExpandedCaches` | `(pendingParts, rangeCursors, now)` | 过期清理 + 上限压制 |
| `refineCollection` | `(collection, { total, owner })` | 补曲目数与简介 |
| `toLoginState` | `(answer)` | 扫码 stage → 宿主 LoginState |

### 身份规则

```text
P1  → id = bvid             sourceRef.mediaId = bvid
P2+ → id = `${bvid}#${n}`   sourceRef.mediaId = `${bvid}#${n}`
P2+ 标题 = `${原歌名} · P${n} ${part}`
```

`bvid#N` 是全链路统一约定：`lib/bvid.cjs` 的 `splitId()` 拆它，
`subtitles` / `audio` / `favDeal` 都吃这个格式。

### 两套 offset

```text
宿主 offset  = 已交付歌曲数（P3 也算一首）
bilibili offset = 原始视频位置（一个 59P 视频算 1 条）
```

`readTrackRange` 只认后者，`readExpandedRange` 负责换算：

- 返回 `{ items, hasMore, nextOffset }`，`nextOffset` 永远是 `offset + items.length`
- 被 `limit` 截断在某个视频内部时，`readTrackRange` 额外返回
  `partial: { bvid, variants: [剩余 P], rawCursor }`
- `readExpandedRange` 把 `partial` 存进 `pendingParts[key]`，下次宿主用同一个
  `songOffset` 来取时先交付这些剩余分 P
- 分 P 交完后用 `rangeCursors[key].rawCursor` 从原始位置继续

### 不变量

1. **`nextOffset >= items.length`**。宿主对缓存快照有这个校验，回吐视频游标会被判为无效。
2. **展开模式不返回 `total`**。视频数当歌曲数会误导宿主的分页判断。
3. **`pendingParts` 上限 8 个视频、`rangeCursors` 上限 40 条、10 分钟过期**。
   超过就丢最旧的，宁可让宿主重读一次。
4. **`key` 必须唯一标识一个列表**。收藏夹用 `folder:<mediaId>`、搜索用 `site:<keyword>`、
   合集用 `season:<mid>:<sid>`。key 撞了会把 A 的剩余分 P 交给 B。

### 已知坑

- 单 P 视频不要进 `pendingParts`，否则 `hasMore` 永远为 true，宿主无限转圈。
- `keep` 只做交付层过滤（长视频、失效视频），**不能参与页码换算**。
  否则一页筛掉几条就被判到底。
- `expandedPages` 里的 `page` 字段是 bilibili 的页码，不是数组下标，不要用下标拼 id。

### 测试

`test/collections.test.mjs`：分 P 展开、`readTrackRange` 的 partial 返回、
`readExpandedRange` 跨页续交、`trimExpandedCaches` 的 TTL 与上限。

---

## `lib/extras.mjs`（118 行）

### 职责

用户手贴进来的「额外收藏夹 / 合集 / 系列」。纯字符串解析，外加一个能当歌单 id 用的键。

### 导出

| 导出 | 作用 |
| --- | --- |
| `EXTRA_PAGE_SIZE` | 20 |
| `splitExtraRefs(text)` | 按换行 / 逗号 / 空格切开 |
| `parseExtraRef(raw)` | 单条 → `{ kind, mediaId }` 或 `{ kind, mid, sid }` |
| `extraKey(ref)` | 生成稳定的歌单 id |
| `parseExtraList(text)` | 多行文本 → ref 数组，丢弃认不出的 |
| `extrasToCollections(extras, options)` | ref 数组 → 宿主卡片 |
| `cleanListName(name)` | 去掉书名号和多余空白 |

### 认得的形态

```text
https://www.bilibili.com/medialist/detail/ml337285064
https://space.bilibili.com/357648464/favlist?fid=337285064
337285064                     （纯数字 = 收藏夹 id）
mid:sid                       （合集）
```

### 已知坑

- 纯数字只能当收藏夹 id。UID 和 media_id 都是数字，无法自动分辨，所以 UID 必须贴链接。
- `extraKey` 必须稳定：换号、改链接后同一个夹子的键不能变，否则白名单 / 黑名单会失配。
- 解析失败要静默丢弃，不要把整段输入当错误弹给用户。

### 测试

`test/extras.test.mjs`。

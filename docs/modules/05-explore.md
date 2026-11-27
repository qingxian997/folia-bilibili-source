# 05 · 探索与推荐（`explore.mjs` / `recommend.mjs` / `feed.cjs`）

## 探索页契约

宿主调三件事：

```text
getExploreFeed(cursor, recentSongs)
  → { sections: [{ id, title, items, moreCursor? }], nextCursor?, refreshReadsAnew? }

getExploreSectionItems(cursor)
  → { items, moreCursor? }

songsShownAs(songs)      // 可选，把「听过的歌」映射成「展示的歌」
```

`items` 里 `{ kind: 'song', song }` 会被画成歌曲卡，点了直接播。
宿主滚到底会自己调 `loadMore(nextCursor)`，一次最多自动续读 4 批 / 96 首，
**模组不要自己再续命**。

### `lib/explore.mjs`（120 行）

| 导出 | 作用 |
| --- | --- |
| `EXPLORE_TITLE` | `'为你推荐'`，section 标题恒定 |
| `REFRESH_READS_ANEW` | 是否带 `refreshReadsAnew: true`，异常时改 false 回退 |
| `feedCursor(freshIdx)` | 首批游标 |
| `moreCursor(freshIdx)` | 续读游标 |
| `parseExploreCursor(cursor)` | 游标 → `{ freshIdx, more }` |
| `recentSongIds(recentSongs)` | 最近播放 → 排除集合 |
| `songsToItems(songs)` | 歌曲 → `{ kind: 'song', song }` |
| `exploreSection(freshIdx, nextIdx, songs)` | 组装 section |
| `feedAnswer(section, nextIdx)` | 组装 feed 返回 |
| `sectionAnswer(songs, nextIdx)` | 组装 section 返回 |

### 规则

- `recentSongs` 只在 `cursor` 为空时传，宿主给的是最近 30 首，用作避开已听
- `EXPLORE_PAGE = 18`（定义在 `client.mjs:1979`），一次交付 18 首
- 探索页**不展开分 P**，一个视频一张卡，`id = bvid`
- 首屏大标题卡是宿主 `BravaisHome.ut()` 强制生成的，不是模组画的

### 已知坑

- `songsShownAs` 在 Folium 2 原生契约里收的是**按 id 索引的对象**，宿主自己转 Map。
  旧版曾要求直接返回 `Map`，两者不要混。
- 如果宿主开始报探索页异常，第一件事是把 `REFRESH_READS_ANEW` 改 `false`，
  它能立刻排除「宿主缓存策略变化」这一类原因。

### 测试

`test/explore.test.mjs`、`test/exploreRefresh.test.mjs`。

---

## `lib/recommend.mjs`（58 行）

### 职责

「我喜欢的音乐」这张特殊卡。0.8.1 起本模组不再挂「推荐」页签
（`lib/homeTab.mjs` 把它藏掉，`capabilities.recommendations` 也不再声明），
只保留这一张卡，并且挪到书库墙的「收藏」页签最前面。

### 导出

| 导出 | 作用 |
| --- | --- |
| `LIKED_KEY` | `'w-liked'`，虚拟收藏夹键 |
| `isLikedKey(key)` | 判定是否这张特殊卡 |
| `recoTrackRaw(bvid, cached, collection)` | 兜底用的原始条目 |
| `parseRecoKey(key)` | 键 → 参数 |
| `likedCollection(raw, providerId)` | → 宿主卡片，带 `isLiked: true` |

### 关键点

宿主 `BravaisHome` 对 online 集合认 `raw.isLiked === true`，画成特殊卡。
所以「我喜欢的音乐」不是真收藏夹，是靠这个标记骗出来的一个入口；
点进去后走 `getLikedSongIds` 拿真实内容。

### 测试

`test/recommend.test.mjs`。

---

## `lib/feed.cjs`（74 行，主进程）

### 职责

`x/web-interface/index/top/feed/rcmd` → 模组内部统一视频条目。

单独一层的原因：这个接口的形状和 `search/type` 完全不同 ——
`duration` 是**秒**不是毫秒、UP 主在 `owner.name`、还混着直播 / 番剧 / 广告卡。
而客户端 `toSong()` 只认 `{ bvid, title, author, cover, durationMs }`。

### 导出

| 导出 | 作用 |
| --- | --- |
| `normalizeFeedItems(raw)` | 过滤非视频卡 + 字段归一 |
| `nextFeedCursor(items)` | 下一批游标 |
| `MAX_FEED_PAGE` | `30`，接口 `ps` 上限 |

### 已知坑

- `ps` 上限 30，传更大的值会被服务端截断，不是报错。
- `fresh_idx` 没有上界，可以一直往后翻；缓存 5 分钟。
- 直播卡的 `owner` 结构和视频不同，必须在 `normalizeFeedItems` 里剔除，
  否则渲染侧拿不到 `durationMs` 会画出 `NaN:NaN`。

### 测试

`test/feed.test.mjs`。

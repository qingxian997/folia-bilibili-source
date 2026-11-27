# 02 · 收藏来源与筛选（`collected.mjs` / `searchCollections.mjs` / `exclude.mjs`）

这三个模块共用一套「资源键」，所以放在一起看。

## 资源键

```text
收藏夹  c-fav-<mediaId>
合集    c-season-<mid>-<sid>
```

`resourceOf(raw)` 是唯一生成入口。白名单、黑名单、去重、封面缓存键全部用它，
因此「自建夹」「手贴夹」「账号收藏的夹」指向同一个夹子时，勾一次就全挡住，
换号或改链接也不会漏。

---

## `lib/collected.mjs`（184 行）

### 职责

`/x/v3/fav/folder/collected/list` 的条目 → 宿主集合。这个接口混着两类东西：

| `type` | 含义 | 取曲目走哪 |
| --- | --- | --- |
| `11` | 收藏的别人的**公开收藏夹** | `fav/resource/list` |
| `21` | 收藏的**视频合集** | `seasons_archives_list` |

其余 `type`（音频、番剧等）和 `state=1`（已失效）都不收。

### 导出

| 导出 | 作用 |
| --- | --- |
| `COLLECTED_FOLDER` / `COLLECTED_SEASON` | 前缀常量 |
| `classifyCollected(item)` | 判定 type 与有效性，返回分类结果或 null |
| `parseCollected(list)` | 批量分类 |
| `resourceOf(raw)` | 生成资源键 |
| `mergeUnique(groups)` | 多来源去重合并 |
| `normalizeOwn(folder, ownerName, ownerId, coverUrl)` | 自建夹归一化 |
| `normalizeExtra(extra)` | 手贴项归一化 |
| `toCollection(raw, providerId)` | → 宿主卡片 |
| `readLibrarySources({ folders, extras, collected, onError })` | 汇总三个来源，单源失败不影响其余 |
| `buildLibrary({ folders, extras, collected, covers, ownerName, ownerId })` | → 最终书库 |

### 不变量

- 去重按资源键，不按名字。两个同名夹子是两张卡。
- `readLibrarySources` 里单个来源抛错只 `onError`，不中断整体。书库墙不能因为
  「我收藏的」接口挂了就整面空白。

### 测试

`test/collected.test.mjs`。

---

## `lib/searchCollections.mjs`（165 行）

### 职责

搜索页的「合集 / 收藏」两类结果。0.7.3 只按列表名过滤，搜歌名两类必然全空，
所以现在是三层：

1. **名字 / UP 主 / 简介命中**（本地库，最相关）
2. **内容命中**：夹子里真的有标题含关键词的视频（主进程 `fav/resource/list?keyword=`）
3. **全站合集**：`search/type?search_type=video` 拿 bvid → `view?bvid=` 取
   `ugc_season` 反查所属合集

### 导出

| 导出 | 作用 |
| --- | --- |
| `WEB_SEASON_PREFIX` | `w-season-`，全站合集键前缀 |
| `matchesCollection(raw, query)` | 名字层匹配 |
| `hasLocalNameHit(list, query, excluded)` | 本地是否已有名字命中（有就不打远端） |
| `remoteSeasonRaw(season)` | 远端合集 → 内部 raw |
| `remoteSeasonFromKey(key)` | 键 → `{ mid, sid }` |
| `collectCandidates({...})` | 三层候选汇总 |
| `searchCollectionPage(list, query, providerId, limit, offset, excluded, options)` | 分页交付 |

### 已知坑

- **全站收藏夹搜索不存在**。`search_type=media_list` 恒返回 `-1200`，不要再试。
- 也没有「这个视频属于哪个公开收藏夹」的接口，只能反查合集。
- 远端合集的键是 `w-season-<mid>-<sid>`，`type=11` 是收藏别人的公开夹、
  `type=21` 才是合集，别混。

### 测试

`test/searchCollections.test.mjs`。

---

## `lib/exclude.mjs`（135 行）

### 职责

收藏夹和合集各有一份独立的设置值，存的是资源键集合。两种玩法：

| 模式 | 语义 |
| --- | --- |
| `hide` | 列表里的不显示（黑名单） |
| `allow` | 只显示列表里的（白名单）；列表为空则回落全部 |

### 导出

| 导出 | 作用 |
| --- | --- |
| `parseExcluded(value)` | 设置字符串 → Set |
| `serializeExcluded(set)` | Set → 设置字符串 |
| `excludedForKind(values, kind)` | 按 kind 取对应那份 |
| `PICKER_MODES` | `['hide', 'allow']` |
| `pickerModeOf(values, kind)` | 取模式；合集空值跟随收藏夹 |
| `visibilityForKind(values, kind)` | 生成判定用的视图对象 |
| `isVisible(raw, view)` | 单个是否可见 |
| `isExcluded(raw, excluded)` | 单个是否在黑名单 |
| `excludeCollections(list, filter)` | 批量过滤 |

### 不变量

- 白名单为空 = 全放行，不是全挡住。
- 列表读空**不算失效**。接口临时失败时不要把它当成「用户清空了设置」。
- `sigOfSettings()` 必须包含这几项，否则设置变了缓存不失效。

### 测试

`test/exclude.test.mjs`。

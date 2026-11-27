# 06 · 宿主适配（`hostAdaptation` / `tabLabel` / `homeTab` / `searchTabs` / `hostlib`）

宿主没有「按音源改 UI」的 API，这一层全靠 DOM 和模块单例。**一改就碎**，
所以集中成一个入口，谁都不许自己再写一套 shadow root 遍历。

> 宿主侧的深层细节（能力位为什么是 false、chunk 怎么找、行为探测怎么做）
> 见 [HOST-CONTRACT.md](../HOST-CONTRACT.md)，那份文档比这份更细，也更长。

## `lib/hostAdaptation.mjs`（87 行）

### 职责

宿主 DOM 适配的唯一入口：收集可遍历的 root、判断当前音源是不是 bilibili。

| 导出 | 作用 |
| --- | --- |
| `collectHostRoots(doc, maxDepth = 8)` | 递归收集主文档 + 所有 shadow root |
| `activeSourceHint(doc, roots, providerLabel)` | 从页面当前音源按钮读信号，读不到返回 `null` |
| `createHostAdaptation(options)` | 统一封装：`roots()` / `isBiliActive()` / `relabel()` / `hideRecommendation()` / `diagnostics()` |

### 三套「当前音源」信号，不能混

| 场景 | 信号 |
| --- | --- |
| 书库墙 | `localStorage.active_online_provider_id` |
| 搜索页 | `nav.search-sources button[aria-current="true"]` 的文字 |
| 页签改名 | 逐节点判定 |

`activeSourceHint` 返回 `null` 表示「读不到」，此时**宁可不改**，不要默认成 bilibili。

诊断入口：`window.__biliTabAdaptation()` 返回命中节点数、改名数、隐藏状态。

## `lib/tabLabel.mjs`（236 行）

### 职责

只在当前语境确实是 bilibili 时，把宿主共用胶囊换成 bilibili 的说法
（「专辑」→「合集」之类）。宿主页签文字来自全局 i18n，所有音源共用，
**直接改字典会把网易云、QQ 音乐一起改掉**，所以只改渲染出来的文本节点。

| 导出 | 作用 |
| --- | --- |
| `createTabRelabel({ document, isActive })` | 返回 `{ start, stop, diagnostics }` |

### 两条铁律

1. `isActive` 是**逐节点**判定，不是全页面一个信号。0.7.26 之后书库墙和新搜索页
   各有各的当前音源。
2. **不要读 `node.nodeValue` 判断原文**。节点被改名之后文本已经不是原文，
   第二次扫描会认不出来。判定只看 DOM 结构和语境。

### 测试

`test/tabLabel.test.mjs`、`test/searchTabs.test.mjs`。

## `lib/homeTab.mjs`（303 行）

### 职责

0.8.1 起只在 bilibili 是当前音源时，把书库首页的「推荐」胶囊藏起来；切走立刻还原。

宿主两套首页的页签结构不一样：

```text
Bravais 书库缝  <button data-bravais-tab="radio" role="tab">推荐</button>
Grid 首页       <span title="推荐"><button aria-label="推荐"><span>推荐</span></button></span>
```

### 导出

| 导出 | 作用 |
| --- | --- |
| `RADIO_TAB_KEY` | `'radio'` |
| `PLAYLIST_TAB_KEY` | `'playlist'` |
| `RADIO_LABELS` | `['推荐', '推薦', 'Radio']` |
| `HOME_TAB_LABELS` / `PLAYLIST_TAB_LABELS` | 同排兄弟判定用的标签集 |
| `HOME_TAB_STORAGE_KEY` | `'last_home_view_tab'` |
| `radioTabNodes(doc, options)` | 找出所有「推荐」胶囊 |
| `fallbackTab(doc, el, options)` | 藏掉当前页时该点哪个页签 |
| `createHomeTabHider({ document, isActive })` | 返回 `{ start, stop }` |

### 为什么不能改设置

关 `capabilities.recommendations` 只会让它变灰；写 `localStorage.show_home_tab_radio`
会把别的平台一起藏掉。所以只能动那一颗胶囊，不动宿主状态。

### 已知坑

- 藏的正好是当前页签时，要顺手点一下「收藏」，否则用户留在没有页签的空白页。
- 切到其他音源必须清掉 `display:none`，否则残留会把网易云的「推荐」也藏了。
- 只改 `display`，不要 `remove()` —— 宿主重渲染时找不到节点会重建，状态就乱了。

### 测试

`test/homeTab.test.mjs`。

## `lib/searchTabs.mjs`（75 行）

### 职责

新搜索页有自己的音源切换器，和书库墙的「当前音源」是两套状态。

```html
<nav class="search-sources">
  <button class="search-source is-active" aria-current="true">bilibili</button>
</nav>
<div class="search-kinds" role="tablist">
  <button class="search-kind" role="tab"><span class="search-kind-number">01</span>…</button>
</div>
```

| 导出 | 作用 |
| --- | --- |
| `activeSearchSourceLabel(doc)` | 当前搜索音源的文字 |
| `searchContextOf(node)` | 节点属于哪个搜索语境 |
| `createBiliTabPredicate({ document, providerLabel, providerId, isWallActive })` | 给 `tabLabel` 用的逐节点判定 |

### 已知坑

- 切搜索 tab **不改** `localStorage`，所以不能只读书库墙那个信号。
- `aria-current` 优先于 `is-active` 类名，宿主两个都写过。

## `lib/hostlib.mjs`（256 行）

### 现状（2.0.0 之后）

2.0.0 起改成 Folium 2 原生 `sources` 音源，**不再需要事后改宿主 provider 对象**。
所以 `openHostLibrary` 和 `attachLibrary` 在生产代码里已经没有调用点，
只剩测试还在测它们。

真正还在用的只有一个导出：`canMutateOwnCollection`，`client.mjs` 用它判断
某个合集能不能写入。新代码不要再用 `attachLibrary`。

### 职责（历史）

补齐宿主 provider 的能力位。宿主给模组音源的适配层把 `auth` / `userLibrary` /
`playlists` 写死成 false，于是「收藏」页签永远不可用、墙面一张卡都不画。
补齐后收藏夹变成宿主自己的数据。

| 导出 | 现状 |
| --- | --- |
| `openHostLibrary(options)` | 历史，无生产调用 |
| `attachLibrary(provider, parts)` | 历史，无生产调用 |
| `canMutateOwnCollection(collection)` | **在用** |

### 已知坑

- 靠「同一 URL 再 import 一次拿到同一个实例」这条 ESM 性质。宿主编译产物 chunk 名
  带 hash，改版就换名，所以要有 `assets` RPC 兜底查找。
- `canEditCollectionTracks = canEditPlaylistTracks?.() ?? true`，
  默认值是 `true`，只读合集必须**显式**实现成 false，否则用户会看到能拖但存不上。

### 测试

`test/hostlib.test.mjs`、`test/hostAdaptation.test.mjs`。

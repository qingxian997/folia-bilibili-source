# 04 · 标题解析（`title.mjs`）

## 职责

bilibili 没有结构化的音乐元数据，标题是唯一线索。这里只做**可解释的规则**，
不做猜测性替换：拿不准时宁可把整段当歌名，也不给一个错乱的歌手。

入口是 `parseVideoTitle(raw, upperName)`，由 `client.mjs` 的 `decorate()` 调用。

## 导出

| 导出 | 签名 | 作用 |
| --- | --- | --- |
| `parseVideoTitle` | `(raw, upperName = '')` | 标题 → `{ title, artist, tags, flags, raw }` |
| `normalizeForMatch` | `(text)` | 只用于比对，不用于显示 |
| `parseDurationText` | `(value)` | `12:34` / `1:02:03` → 秒 |

## 规则优先级

### 1. 规范化

NFKC 规范化（抹平全角半角）+ trim，同时扫标记位：

```text
翻唱 / cover / 翻自        → flags.cover
纯音乐 / 伴奏 / instrumental → flags.instrumental
现场 / live / 演唱会        → flags.live
```

### 2. 书名号最高优先

标题里有 `《...》` 时，**第一个书名号内容直接当歌名**，其余不再猜。

```text
《晴天》- 周杰伦   →  title=晴天  artist=周杰伦
```

### 3. 括号分组

处理 `【】 [] () 〔〕`。每组三类：

| 类别 | 处理 |
| --- | --- |
| 噪音（`4K` `MV` `无损` `字幕` `官方` `合集`…） | 丢进 `tags` |
| 像歌手（≤20 字、非网址、非纯数字、非噪音） | 进候选歌手 |
| 不确定 | 丢进 `tags` |

```text
【初音ミク】千本桜        → 歌手候选=初音ミク，剩余=千本桜
【4K修复】夜に駆ける / YOASOBI → 4K修复是噪音，剩下按分隔符继续
```

### 4. 分隔符切段

中文破折号先统一成 ` - `，然后按 `- – — | ｜ / ／` 切段，丢掉纯噪音段。

### 5. 选歌名和歌手

1. **UP 主名字命中某一段** → 另一段当歌名，命中的当歌手
2. **斜杠形式 `A / B`** → 左歌名、右歌手
3. **两段式** → 短的一段更像歌手
4. 还没歌手就依次回退：括号候选 → 另一段 → UP 主名

### 6. 尾巴清洗

反复去掉尾部噪音：`mv / pv / amv / 4k / 8k / 1080p / 2160p / hi-res / flac / wav /
无损 / 高音质 / 完整版 / 官方 / 修复版 / 字幕 / 歌词 / 试听 / 版`。

```text
【4K修复】周杰伦 - 晴天MV 2160P修复版
  →  title=晴天  artist=周杰伦
```

## 与「显示原始标题」的关系

设置项 `rawTitle` 只影响**歌名**：

```js
title:  showRaw ? raw.title : parsed.title
artist: parsed.artist || raw.author
```

打开后歌名直接用 UP 主原文，歌手字段仍走解析；分 P 后缀
（`· P2 分P名`）由 `videoToSong()` 另外拼，不受这个开关影响。

## `normalizeForMatch` 做什么

去括号内容、去引号和标点、去空格和连字符、统一小写。只用于比对：

```js
normalizeForMatch('【初音ミク】千本桜 (4K)')
  === normalizeForMatch('千本桜')   // true
```

## 已知坑

- 不要把 `normalizeForMatch` 的结果拿去显示，会丢掉所有包装信息。
- 书名号可能有多个（`《A》《B》`），只取第一个，其余进 `tags`。
- 纯数字括号（`(2019)`）是年份，不是歌手，靠「非纯数字」这条挡住。
- 标题里带网址时不要当歌手，`isUrl` 判断在括号分类之前。

## 测试

`test/title.test.mjs`，夹具是真实搜索结果里的标题形态，改规则前先看这些例子。

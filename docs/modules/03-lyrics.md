# 03 · 歌词（`lrc.mjs`）

## 职责

把两条来源的歌词转成宿主认识的格式：

1. **bilibili CC 字幕**（JSON 行）
2. **宿主 omni 解析好的行**（跨平台匹配结果）

宿主认 `lrc / enhanced-lrc / yrc / qrc / krc / ttml / vtt / awlrc`，但**不嗅探格式**：
标成 `lrc` 就不要带 `<mm:ss.xx>` 逐字标记，否则整段歌词显示成乱码。
所以这里只产出两种：`lrc` 和 `enhanced-lrc`。

## 导出

| 导出 | 签名 | 作用 |
| --- | --- | --- |
| `stamp` | `(seconds)` | 秒 → `[mm:ss.xxx]` |
| `wordStamp` | `(seconds)` | 秒 → `<mm:ss.xxx>`，逐字时间戳 |
| `subtitleToLines` | `(body)` | CC 字幕 JSON 行 → 宿主 `lines` |
| `fillMissingWords` | `(lines)` | 给缺 `words` 的行补兜底 |
| `subtitleToLrc` | `(body)` | CC 字幕 → LRC 纯文本 |
| `omniLyricsToTracks` | `(lyrics)` | 宿主 omni 结果 → 宿主 lyrics 对象 |
| `formatDuration` | `(ms)` | 毫秒 → `m:ss`，歌词面板用 |

## 硬约束：每一行必须带 `words`

```js
{ timeMs, text, words: [{ text, startMs, endMs }, ...] }
```

缺了 `words`，宿主渲染期直接崩（React 报错、白屏），而且**不是可降级错误**。
`fillMissingWords()` 就是为此存在：把整行当成一个词，`startMs` 用行时间、
`endMs` 用下一行时间或行时间 + 估算值。

旧版本写进缓存的坏行会在启动时被 `client.mjs` 自愈逻辑扫一遍，
标记键 `bili:lyric-cache-repair:v2`，同时扫旧 provider id `folium.bili-fav-wall.bili`
和新 id `folium.bilibili.bili`，所以升级后不用重新扫码。

## 取词流程

```text
getLyrics(song)
  ├─ route = match-then-cc（默认）
  │    1. 跨平台匹配：song.title + artist 去宿主其他音源搜
  │    2. 匹配不到 → CC 字幕
  ├─ route = cc-then-match
  ├─ route = match-only
  └─ route = off              直接返回空
```

跨平台匹配用 `lib/title.mjs` 的 `normalizeForMatch()` 做比对，
标点和括号差异不算不同歌。

## 已知坑

- CC 字幕的 `from / to` 是秒（浮点），不是毫秒。忘了乘 1000 会让整首歌挤在开头。
- 字幕可能只有一行且 `to` 为 0，要兜底成 `from + 3s`。
- 多语言字幕优先 `zh-CN` / `zh-Hans`，其次任意中文，最后才用第一条。
- 分 P 视频取字幕必须带页码：`subtitles({ id: 'BVxxx#2' })`，
  否则拿到的是 P1 的字幕。
- 第三方匹配的搜索词里带 `· P2 xxx` 后缀会降低命中率，这是已知的半适配点。

## 测试

`test/lrc.test.mjs`：时间戳格式、逐字标记、缺 `words` 兜底、omni 结果转换。

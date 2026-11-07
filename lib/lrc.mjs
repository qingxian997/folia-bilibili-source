// mods/bili-fav/lib/lrc.mjs
// 歌词搬运：bilibili CC 字幕（JSON 行）与宿主 omni 解析好的行 → 宿主认识的歌词原文。
//
// 宿主只认 lrc / enhanced-lrc / yrc / qrc / krc / ttml / vtt / awlrc，而且不嗅探格式：
// 标 lrc 就别带 <mm:ss.xx> 逐字标记。这里产出的都是 lrc + enhanced-lrc 两种。

const pad = (value, width = 2) => String(value).padStart(width, '0');

/** 秒 → [mm:ss.xxx] */
export function stamp(seconds) {
    const ms = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
    return `[${pad(Math.floor(ms / 60000))}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}]`;
}

/** 秒 → <mm:ss.xxx>（enhanced-lrc 的逐字标记） */
export function wordStamp(seconds) {
    return stamp(seconds).replace('[', '<').replace(']', '>');
}

/**
 * bilibili CC 字幕 → 宿主歌词文档的行。
 * 行结构 `{ startTime, endTime, fullText, words }`，单位是秒，和 omni 返回的 `lines` 同形。
 * 「匹配歌词」窗口要的就是这个形状，不是 LRC 文本。
 *
 * `words` 必须是数组，哪怕没有逐字信息。宿主的歌词模型（monetLyricsModel 里那个
 * `G(line)`）第一步就是 `line.words.length`，键不在就抛
 * `TypeError: Cannot read properties of undefined (reading 'length')`，
 * 而这一步跑在 React 渲染期间——异常直接把整棵树卸载掉，用户看到的就是
 * 「整个窗口变白/黑、点什么都没反应」。CC 字幕没有逐字时间轴，给空数组。
 */
export function subtitleToLines(body) {
    if (!Array.isArray(body)) return [];
    const rows = body
        .filter((item) => item && Number.isFinite(Number(item.from)) && String(item.content || '').trim())
        .map((item) => {
            const startTime = Number(item.from);
            const to = Number(item.to);
            const line = {
                startTime,
                fullText: String(item.content).replace(/\r?\n/g, ' ').trim(),
                words: [],
            };
            if (Number.isFinite(to)) line.endTime = to;
            return line;
        })
        .sort((a, b) => a.startTime - b.startTime);

    // 补齐时间区间：缺 to、或 to 不晚于 from 的行会让「当前行」永远推进不了，
    // 表现是歌词卡在某一句上不滚动。用下一行的起点当终点，末行给 3 秒。
    rows.forEach((line, index) => {
        const next = rows[index + 1];
        const fallback = next ? next.startTime : line.startTime + 3;
        if (!Number.isFinite(line.endTime)) line.endTime = fallback;
        else if (line.endTime <= line.startTime) line.endTime = Math.max(fallback, line.startTime + 0.3);
    });
    return rows;
}

/**
 * 给缺 `words` 的歌词行补空数组，返回补了几行。
 *
 * 宿主把「匹配来的歌词」按行原样存进自己的 IndexedDB，之后直接拿去渲染；
 * 旧版模组存进去的行没有 `words`，宿主的歌词模型读 `line.words.length` 就抛异常，
 * 整个界面白屏。新写入的行已经带了，这个函数用来修已经落盘的旧记录。
 */
export function fillMissingWords(lines) {
    if (!Array.isArray(lines)) return 0;
    let fixed = 0;
    for (const line of lines) {
        if (line && typeof line === 'object' && !Array.isArray(line.words)) {
            line.words = [];
            fixed += 1;
        }
    }
    return fixed;
}

/** bilibili CC 字幕 → LRC。body 形如 [{ from: 0.5, to: 3.1, content: '歌词' }] */
export function subtitleToLrc(body) {
    return subtitleToLines(body)
        .map((line) => `${stamp(line.startTime)}${line.fullText}`)
        .join('\n');
}

/**
 * 宿主 folium.omni.getLyrics 的返回 → FoliumLyricsResult 的两条轨道。
 * 行结构：{ startTime, endTime?, fullText, translation?, romanization?, words? }
 */
export function omniLyricsToTracks(lyrics) {
    const lines = (lyrics && Array.isArray(lyrics.lines) ? lyrics.lines : []).filter(
        (line) => line && Number.isFinite(Number(line.startTime)),
    );
    if (!lines.length) return null;

    const sorted = lines.slice().sort((a, b) => Number(a.startTime) - Number(b.startTime));

    const build = (field) => {
        const text = sorted
            .filter((line) => String(line[field] || '').trim())
            .map((line) => `${stamp(line.startTime)}${String(line[field]).replace(/\r?\n/g, ' ').trim()}`)
            .join('\n');
        return text || undefined;
    };

    const mainText = build('fullText');
    if (!mainText) return null;

    const main = {
        format: 'lrc',
        text: mainText,
        translationText: build('translation'),
        romanizationText: build('romanization'),
    };

    let wordByWord;
    if (lyrics.isWordByWord) {
        const text = sorted
            .filter((line) => Array.isArray(line.words) && line.words.length)
            .map((line) => {
                const words = line.words
                    .map((word) => `${wordStamp(word.startTime)}${String(word.text ?? '')}`)
                    .join('');
                const end = Number.isFinite(Number(line.endTime)) ? wordStamp(line.endTime) : '';
                return `${stamp(line.startTime)}${words}${end}`;
            })
            .join('\n');
        if (text) wordByWord = { format: 'enhanced-lrc', text };
    }

    return { isPureMusic: Boolean(lyrics.isPureMusic), main, ...(wordByWord ? { wordByWord } : {}) };
}

/** 毫秒 → 04:33，界面用。 */
export function formatDuration(ms) {
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

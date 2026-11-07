// mods/bili-fav/lib/title.mjs
// bilibili 视频标题 → 歌名 / 歌手 / 属性。
//
// bilibili 没有结构化的音乐元数据，标题就是唯一线索。这里只做「可解释的规则」，
// 不做猜测性替换：拿不准的时候宁可把整段标题当歌名，也不要给出错乱的歌手。
// 规则按真实搜索结果的形态反复调过（见 test/title.test.mjs 里的真实标题夹具）。

// 括号里出现这些词，说明这一组在描述画质、来源或包装，而不是歌名或歌手。
const NOISE_WORDS = [
    'mv', 'pv', 'op', 'ed', 'amv', 'mad', 'live', 'hires', 'hi-res', 'hi res',
    '4k', '8k', '2k', '1080p', '720p', '2160p', 'hd', 'hq', '60fps', '60帧', '120帧',
    '无损', '无损音质', '无损音乐', '高音质', '高画质', '超清', '高清', '蓝光', '母带',
    '试听', '试听版', '预告', '纯享', '完整版', '官方', '官方mv', '中文字幕', '中日字幕',
    '字幕', '动态歌词', '滚动歌词', '附歌词', '带歌词', '歌词', '搬运', '补档', '转载',
    '修复', '修复版', '重置', '升频', '剪辑', '合集', '混剪', '翻唱', 'cover', '翻自',
    '原唱', '伴奏', 'instrumental', 'inst', 'off vocal', 'remix', 'dj', '现场', '演唱会',
    '片段', '纯音乐', '动态谱', '手书',
];

// 中文没有词边界，整词表检查不够用：「中日字幕」「4K修复」这类要按字面标记命中。
const NOISE_MARK = /字幕|歌词|画质|音质|无损|完整版|官方|修复|搬运|补档|合集|剪辑|混剪|试听|纯享|升频|现场|演唱会|4k|8k|1080p|2160p|720p|60帧|60fps|hi-?res|hires/i;

const emptyAfterNoise = (value) => {
    let rest = value.replace(/\d+\s*[kp]/g, '');
    NOISE_WORDS.forEach((word) => {
        rest = rest.split(word).join('');
    });
    return rest.replace(/[\s\d,.\/+、·\-_~&]+/g, '');
};

/** 括号组：命中标记词、或抹掉包装词后不剩东西，就是噪音。 */
const isGroupNoise = (text) => {
    const value = String(text || '').trim().toLowerCase();
    if (!value) return true;
    if (NOISE_WORDS.includes(value)) return true;
    if (NOISE_MARK.test(value)) return true;
    return emptyAfterNoise(value) === '';
};

/** 分段：只有「什么都不剩」才算噪音，「晴天MV 2160P修复版」这种要留下再削尾巴。 */
const isPureNoise = (text) => {
    const value = String(text || '').trim().toLowerCase();
    if (!value) return true;
    if (NOISE_WORDS.includes(value)) return true;
    return emptyAfterNoise(value) === '';
};

const looksLikeArtist = (text) => {
    const value = String(text || '').trim();
    if (!value || value.length > 20) return false;
    if (isGroupNoise(value)) return false;
    if (/https?:|www\.|@/.test(value)) return false;
    if (/^\d+$/.test(value)) return false;
    if (/^[\d\s.:-]+$/.test(value)) return false;
    return true;
};

// 中文夹着的破折号当分隔符处理（「晴天-周杰伦」），英文里的连字符（Hi-Res）不动。
const CJK_DASH = /(?<=[\u4e00-\u9fff])\s*[-–—]\s*(?=[\u4e00-\u9fff])/g;
const SEPARATOR = /\s+[-–—]\s*|\s*[–—]\s+|\s*[|｜]\s*|\s+\/\s+|\s*／\s*/;

const stripEdges = (text) =>
    String(text || '')
        .replace(/^[\s\-–—_|｜·・,，、:：'"‘’“”]+/, '')
        .replace(/[\s\-–—_|｜·・,，、:：'"‘’“”]+$/, '')
        .replace(/\s{2,}/g, ' ')
        .trim();

/** 去掉尾部的「(4K)」「[MV]」这类括号，直到不再变化。 */
const stripTrailingBrackets = (text) => {
    let value = text;
    for (let i = 0; i < 4; i += 1) {
        const next = value.replace(/\s*[【\[(（][^】\])）]{1,40}[】\])）]\s*$/, '').trim();
        if (next === value) break;
        value = next;
    }
    return value;
};

// 尾巴上的包装词，一次削一个，削到削不动为止。
const TAIL_TOKEN = /\s*[-–—_|｜·,，、]*\s*(?:mv|pv|amv|mad|4k|8k|2160p|1080p|720p|480p|hi-?res|hires|无损音质|无损音乐|无损|高音质|高画质|高清|超清|蓝光|完整版|官方|修复版|修复|中文字幕|中日字幕|字幕|动态歌词|滚动歌词|附歌词|歌词|60帧|60fps|flac|wav|试听版|试听|版)$/i;

const stripTail = (text) => {
    let value = String(text || '').trim();
    for (let i = 0; i < 8; i += 1) {
        const next = value.replace(TAIL_TOKEN, '').trim();
        if (next === value || !next) break;
        value = next;
    }
    return value;
};

/**
 * @param {string} raw 视频原始标题
 * @param {string} upperName UP 主名字（歌手兜底）
 * @returns {{ title: string, artist: string, tags: string[], flags: { cover: boolean, instrumental: boolean, live: boolean }, raw: string }}
 */
export function parseVideoTitle(raw, upperName = '') {
    const original = String(raw || '').normalize('NFKC').trim();
    const flags = {
        cover: /翻唱|cover|翻自/i.test(original),
        instrumental: /纯音乐|伴奏|instrumental|off\s?vocal/i.test(original),
        live: /现场|live|演唱会/i.test(original),
    };

    let text = original.replace(CJK_DASH, ' - ');
    const tags = [];

    // 《书名号》里几乎总是歌名，优先级最高。
    let bookTitle = '';
    text = text.replace(/《\s*([^》]{1,80}?)\s*》/g, (_match, inner) => {
        if (!bookTitle) bookTitle = inner.trim();
        return ' ';
    });

    // 摘出其余括号，按内容分成「噪音」和「疑似歌手」。
    const groupArtists = [];
    text = text.replace(/[【\[(（〔]([^】\])）〕]{1,60})[】\])）〕]/g, (_match, inner) => {
        const value = String(inner).trim();
        if (isGroupNoise(value)) {
            if (value) tags.push(value);
        } else if (looksLikeArtist(value)) {
            groupArtists.push(value);
        } else {
            tags.push(value);
        }
        return ' ';
    });

    const core = stripEdges(text);
    // 「A / B」在 bilibili 几乎都是「歌名 / 歌手」；连字符则两个方向都常见，
    // 所以斜杠单独给方向，破折号继续靠长度和尾巴噪音判断。
    const slashSplit = /\s+\/\s+/.test(core) || /\s*／\s*/.test(core);
    const segments = core
        .split(SEPARATOR)
        .map((part) => stripEdges(part))
        .filter((part) => part && !isPureNoise(part));

    let title = bookTitle;
    let artist = '';

    // UP 主名字出现在某一段里时，另一段就是歌名（「周杰伦 - 晴天」）。
    if (!title && segments.length >= 2 && upperName) {
        const wantUpper = normalizeForMatch(upperName);
        const index = segments.findIndex((part) => normalizeForMatch(part) === wantUpper);
        if (index >= 0) {
            const other = segments.find((_part, i) => i !== index);
            if (other) {
                title = other;
                artist = segments[index];
            }
        }
    }

    // 「歌名 / 歌手」：方向固定成左歌名右歌手，尾巴噪音留到后面统一削。
    if (!title && slashSplit && segments.length >= 2) {
        const [first, ...rest] = segments;
        title = first;
        artist = rest.join(' / ');
    }

    // 两段式：短的一段更像歌手，「歌手 - 歌名」与「歌名 - 歌手」都按长度收敛。
    if (!title && segments.length >= 2) {
        const [first, ...rest] = segments;
        const tail = rest.join(' / ');
        if (first.length <= 8 && tail.length > first.length + 2) {
            artist = first;
            title = tail;
        } else {
            title = first;
            artist = tail;
        }
    }

    if (!title) title = segments[0] || '';
    if (!artist && groupArtists.length) artist = groupArtists[0];
    if (!artist && segments.length) {
        const other = segments.find((part) => normalizeForMatch(part) !== normalizeForMatch(title));
        if (other) artist = other;
    }

    title = stripEdges(stripTail(stripTrailingBrackets(stripEdges(title))));
    artist = stripEdges(stripTail(stripTrailingBrackets(stripEdges(artist))));

    if (!title) title = stripTail(stripEdges(original)) || '未知曲目';
    if (artist && normalizeForMatch(artist) === normalizeForMatch(title)) artist = '';
    if (!artist) artist = String(upperName || '').trim();

    return { title, artist, tags, flags, raw: original };
}

/** 用于跨平台比对的归一化：去括号内容、去标点、去空格、统一大小写。 */
export function normalizeForMatch(text) {
    return String(text || '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[【\[(（〔][^】\])）〕]*[】\])）〕]/g, '')
        .replace(/《|》|「|」|『|』|“|”|"|'|`/g, '')
        .replace(/[\s\-–—_|｜·・,，、:：!！?？.。~～+&/\\]/g, '')
        .trim();
}

/** 「04:33」/「1:02:03」/ 273 → 毫秒。 */
export function parseDurationText(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value * 1000);
    const parts = String(value || '')
        .split(':')
        .map((item) => Number(item))
        .filter((item) => Number.isFinite(item));
    if (!parts.length) return 0;
    return parts.reduce((total, item) => total * 60 + item, 0) * 1000;
}

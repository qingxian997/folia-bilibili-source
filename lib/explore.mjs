// lib/explore.mjs
// 宿主「探索」页签的歌曲瀑布流契约（纯函数，不联网、不碰 DOM）。
//
// 0.7.26 宿主 remoteActions-*.js 里的形状：
//   getExploreFeed(cursor)      → { sections:[{ id, title, items, moreCursor? }], nextCursor?, refreshReadsAnew? }
//   getExploreSectionItems(c)   → { items, moreCursor? }
//   items 里 { kind:'song', song } 会被画成歌曲卡，点了直接播（Ml / Jl）。
// 宿主滚动到底时 useExploreWall 会自己调 loadMore(nextCursor)，但它在
//   nu() 里写死了 t<96 && n<4 —— 一次 read 最多自动续读 4 批 / 96 首。
// 0.8.1 起 client.mjs 会拿到宿主那张 explore store，在宿主停手之后继续
// loadMore() 追加新 section，把上限续掉（不新增页签，仍然是宿主原生探索页）。
// 游标必须是新值：Zc() 会比较 nextCursor === 传入的 cursor，相等就当没进度直接停。
//
// bilibili 那侧的 fresh_idx 已经由 index.cjs 的 recommend RPC 维护，这里只负责编解码
// 宿主传回来的不透明游标，以及把歌曲包成它认得的 section/item。

export const EXPLORE_TITLE = '为你推荐';

/** 宿主每个 section 的标题要稳定：Uc() 按标题排序、去重、限制标题数量。 */
const FEED_PREFIX = 'bili:feed:';
const MORE_PREFIX = 'bili:more:';

/**
 * fresh_idx 是「已看过多少条」，bilibili 网页能一直往下刷，没有上界。
 * 0.8.1 删掉了原来的 Math.min(400, …) 回绕：正是它让刷到 ~400 时整批回到第 1 批。
 * 只挡 NaN / Infinity / 负数这类坏值。
 */
function idxOf(value) {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? Math.floor(num) : 1;
}

export function feedCursor(freshIdx) {
    return FEED_PREFIX + idxOf(freshIdx);
}

export function moreCursor(freshIdx) {
    return MORE_PREFIX + idxOf(freshIdx);
}

/** 认不出（包括宿主自己的 'read-already' 哨兵）就返回 null，交给调用方用滚动游标。 */
export function parseExploreCursor(cursor) {
    const text = String(cursor || '');
    const hit = /^bili:(?:feed|more):(\d+)$/.exec(text);
    if (!hit) return null;
    const idx = Number(hit[1]);
    return Number.isFinite(idx) && idx > 0 ? idx : null;
}

/** 一首歌一张卡。song 必须是完整 DTO（videoToSong() 的产物）。 */
export function songsToItems(songs) {
    return (Array.isArray(songs) ? songs : [])
        .filter((song) => song && String(song.id || ''))
        .map((song) => ({ kind: 'song', song }));
}

/** 一批推荐 → 一个 section；空的批次别交出去，宿主会拿它当「没有内容」。 */
export function exploreSection(freshIdx, nextIdx, songs) {
    const items = songsToItems(songs);
    if (!items.length) return null;
    return {
        id: `bili-reco-${idxOf(freshIdx)}`,
        title: EXPLORE_TITLE,
        items,
        moreCursor: moreCursor(nextIdx),
    };
}

/**
 * getExploreFeed() 的返回值。
 *
 * **不要加 refreshReadsAnew:true**：宿主 bl() 看到这一位会跳过每个 section 的
 * getExploreSectionItems() 追加，改走「按共享条目匹配新 section」的老路；
 * 全批都是新歌时匹配不上，hl() 就把旧池子 from:0 重放一遍 —— 点「换一批」
 * 反而全是刚才那几首。不声明时 refresh 会老老实实拉 moreCursor 追加新歌。
 */
export function feedAnswer(section, nextIdx) {
    return {
        sections: section ? [section] : [],
        ...(section ? { nextCursor: feedCursor(nextIdx) } : {}),
    };
}

/** getExploreSectionItems() 的返回值：没有新歌就别再给 moreCursor，免得「更多」点了没反应。 */
export function sectionAnswer(songs, nextIdx) {
    const items = songsToItems(songs);
    return {
        items,
        ...(items.length ? { moreCursor: moreCursor(nextIdx) } : {}),
    };
}

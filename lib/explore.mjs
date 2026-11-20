// lib/explore.mjs
// 宿主「探索」页签的歌曲瀑布流契约（纯函数，不联网、不碰 DOM）。
//
// 0.7.29 宿主 remoteActions / omni 的形状：
//   getExploreFeed(cursor, recentSongs) → { sections:[{ id, title, items, moreCursor? }], nextCursor?, refreshReadsAnew? }
//   getExploreSectionItems(c)           → { items, moreCursor? }
//   songsShownAs(songs)                 → songs（可选，把「听过的歌」映射成「展示的歌」）
//   items 里 { kind:'song', song } 会被画成歌曲卡，点了直接播。
// 宿主滚动到底时 useExploreWall 会自己调 loadMore(nextCursor)；一次 read 最多
// 自动续读 4 批 / 96 首，这个上限由宿主负责，模组不再自己续命。
//
// 0.7.29 新增「换一批」按钮，走 store.refresh(seed)：seed 是最近播放的歌（≤30 首），
// 宿主把它当第二参传给 getExploreFeed(undefined, seed)。要让它生效，feedAnswer
// 必须声明 refreshReadsAnew —— 宿主刷新时看到这一位才跳过逐 section 追加、直接带
// seed 来读新 feed；否则 seed 会被宿主吃掉的追加路径挡住，换一批就不避开最近听过。
// section 的 title 必须恒定非空：宿主按 title 匹配新旧 section，匹配上了才用新池替换，
// 匹配不上会把旧池从头重放（0.8.1 的老毛病）。
//
// 游标必须是新值：宿主会比较 nextCursor === 传入的 cursor，相等就当没进度直接停。
// bilibili 那侧的 fresh_idx 由 index.cjs 的 recommend RPC 维护，这里只负责编解码
// 宿主传回来的不透明游标，以及把歌曲包成它认得的 section/item。

export const EXPLORE_TITLE = '为你推荐';

/**
 * 「换一批」要不要声明 refreshReadsAnew：这是让宿主把 seed 透传进 getFeed 的唯一开关。
 * 真机若出现回放旧池，把它改成 false 即可回退到「靠 getSectionItems 的 +7 追加新歌」，
 * 那时 seed 不生效，但换一批仍能拿到新内容。修复与回退都只动这一处。
 */
export const REFRESH_READS_ANEW = true;

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

/**
 * 把宿主给的「最近播放」种子收成一串 id：宿主可能传歌曲 DTO，也可能传光字符串。
 * 只看我们的 bvid（song.id / sourceRef.mediaId），换一批时用它避开最近听过的。
 */
export function recentSongIds(recentSongs) {
    const ids = new Set();
    if (!Array.isArray(recentSongs)) return ids;
    for (const item of recentSongs) {
        if (typeof item === 'string' && item) ids.add(item);
        else if (item && typeof item === 'object') {
            const id = item.id || (item.sourceRef && item.sourceRef.mediaId);
            if (id) ids.add(String(id));
        }
    }
    return ids;
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
 * 0.7.29：声明 refreshReadsAnew:true，让「换一批」走宿主带 seed 的新路径；
 * 配合恒定的 section title，宿主用新池替换旧池而不是从头重放。
 * 回退开关见 REFRESH_READS_ANEW。
 */
export function feedAnswer(section, nextIdx) {
    return {
        sections: section ? [section] : [],
        ...(section ? { nextCursor: feedCursor(nextIdx), refreshReadsAnew: REFRESH_READS_ANEW } : {}),
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

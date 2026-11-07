// lib/collections.mjs
// 把 bilibili 的数据翻成宿主自己的形状：收藏夹 → ProviderCollection，视频 → UnifiedSong。
//
// 这里只做纯映射，不联网、不碰 DOM，好让 test/collections.test.mjs 直接跑。
// 宿主拿到这两个形状之后，墙面、集合页、队列、历史全由它自己渲染——不再有自绘的一层。

/** bilibili 收藏夹接口一页最多给 20 条，跟宿主请求的 limit 无关，所以这里自己累积。 */
export const FOLDER_PAGE_SIZE = 20;
/** 一次 getPlaylistTracks 最多往后翻几页，防止宿主把 limit 开得很大时一口气打穿风控。 */
const MAX_PAGES_PER_CALL = 8;

/**
 * 收藏夹 → 歌单卡。
 *
 * 宿主的 `ProviderCollection` 里 `providerId` 必填（它靠这个把卡片路由回音源），
 * `trackCount` 进磁贴上的「歌单 · N」，`coverUrl` 没有就画渐变占位。
 *
 * @param {Array<{id: string, title: string, count: number, isDefault?: boolean}>} folders
 * @param {{ providerId: string, covers?: Record<string, string[]>, owner?: { id: string, name: string } }} options
 */
export function foldersToCollections(folders, options) {
    const providerId = String(options && options.providerId || '');
    const covers = (options && options.covers) || {};
    const owner = (options && options.owner) || null;
    return (folders || []).map((folder) => {
        const list = covers[String(folder.id)] || [];
        /** @type {Record<string, unknown>} */
        const collection = {
            providerId,
            id: String(folder.id),
            type: 'playlist',
            name: folder.title || '未命名收藏夹',
            trackCount: Number(folder.count) || 0,
        };
        // 收藏夹接口不返回封面，第一条视频的封面就是 bilibili 网页上那格的主图。
        if (list[0]) collection.coverUrl = list[0];
        if (folder.isDefault) collection.isOwned = true;
        if (owner && owner.name) collection.creator = { id: owner.id || '', nickname: owner.name };
        return collection;
    });
}

/**
 * 视频 → 宿主的一首歌。
 *
 * `sourceRef` 是播放链路唯一的凭据：没有它，宿主的队列、历史、歌词都认不出这首歌。
 * 专辑名填收藏夹名，播放器里就会显示「来自 默认收藏夹」而不是空。
 *
 * @param {{ bvid: string, title?: string, author?: string, cover?: string, durationMs?: number }} raw
 * @param {{ providerId: string, decorate?: (raw: object) => { title: string, artist: string }, album?: string }} options
 */
export function videoToSong(raw, options) {
    const providerId = String(options && options.providerId || '');
    const id = String(raw && (raw.bvid || raw.id) || '');
    if (!id) return null;
    const decorate = typeof options.decorate === 'function'
        ? options.decorate(raw)
        : { title: raw.title || '', artist: raw.author || '' };
    const title = (decorate && decorate.title) || raw.title || '未知曲目';
    const artist = (decorate && decorate.artist) || raw.author || '';
    const album = (options && options.album) || '';
    return {
        id,
        // `name` 是收藏夹/队列那条路用的；`title` 是「匹配歌词」窗口结果行直接读的字段
        // （宿主那行是 `children: e.title`，不是 `e.name`）。少一个，那一列就是空标题。
        name: title,
        title,
        artists: [{ id: `${id}#artist`, name: artist || '未知歌手' }],
        album: {
            id: `${id}#album`,
            name: album,
            ...(raw.cover ? { coverUrl: raw.cover } : {}),
        },
        durationMs: Number(raw.durationMs) || 0,
        sourceRef: { kind: 'online', providerId, mediaId: id },
    };
}

/**
 * 一条原始条目能不能交付给宿主。失效视频、私有视频都留在 `items` 里占位，
 * 但不往下传——关键是「占位」：只有保留它们在数组里的位置，页码和 offset 才对得上。
 */
function playable(item) {
    if (!item) return false;
    if (item.playable === false) return false;
    return String(item.title || '') !== '已失效视频';
}

/**
 * 把「宿主想要的第 offset..offset+limit 首」翻成「bilibili 的第几页」，并且一页一页取。
 *
 * offset / nextOffset 一律是**原始下标**（接口那一页里的位置），不是「已交付条数」。
 * 这个区别是 0.7.5 修的分页 bug：接口一页 20 条里只要有一条失效视频被过滤掉，
 * 交付条数就比原始下标少，下一次 `offset / 20` 会落回上一页中间，导致曲目重复；
 * 尾部整页失效时交付条数不前进，`hasMore` 又会恒真，集合页无限滚动对着同一页猛敲。
 *
 * `fetchPage(page)` 由调用方提供（走 rpc），返回 `{ items, total, hasMore }`，
 * 其中 `items` 必须保留失效条目（带 `playable:false`），否则位置信息就丢了。
 *
 * @param {{
 *   offset: number, limit: number,
 *   fetchPage: (page: number) => Promise<{ items: object[], total?: number, hasMore?: boolean }>,
 *   pageSize?: number, keep?: (item: object) => boolean,
 * }} input
 */
export async function readTrackRange({ offset, limit, fetchPage, pageSize, keep }) {
    const size = Math.max(1, Number(pageSize) || FOLDER_PAGE_SIZE);
    const start = Math.max(0, Number(offset) || 0);
    const want = Math.max(1, Math.min(200, Number(limit) || size));
    const accept = typeof keep === 'function' ? keep : playable;

    let page = Math.floor(start / size) + 1;
    let skip = start % size;
    /** @type {object[]} */
    const items = [];
    const seen = new Set();
    let total = 0;
    let cursor = start;
    let emptyPages = 0;
    let pages = 0;
    /** null=还没停；'end'=接口说没有下一页；'empty'=尾部空页 */
    let stopped = null;
    let lastLen = 0;
    let lastHasMore = false;

    while (items.length < want && pages < MAX_PAGES_PER_CALL) {
        const answer = await fetchPage(page);
        pages += 1;
        const list = (answer && answer.items) || [];
        lastLen = list.length;
        lastHasMore = Boolean(answer && answer.hasMore);
        if (Number(answer && answer.total) > 0) total = Number(answer.total);

        let examined = skip - 1;
        for (let index = skip; index < list.length; index += 1) {
            if (items.length >= want) break;
            const item = list[index];
            examined = index;
            const id = String((item && (item.bvid || item.id)) || '');
            if (id && seen.has(id)) continue;
            if (!accept(item)) continue;
            if (id) seen.add(id);
            items.push(item);
        }
        // 游标 = 这一页已经消费掉的原始位置（不是交付了多少首）
        cursor = Math.max(cursor, (page - 1) * size + examined + 1);

        if (!answer || answer.hasMore === false) {
            stopped = 'end';
            break;
        }
        if (examined < skip) {
            // 这一页没有可用的原始槽位（整页失效，或 offset 正好压到页尾）
            emptyPages += 1;
            if (emptyPages >= 2) {
                stopped = 'empty';
                break;
            }
        } else {
            emptyPages = 0;
        }
        page += 1;
        skip = 0;
    }

    const capped = !stopped && pages >= MAX_PAGES_PER_CALL && items.length < want;
    // 这一页还剩多少原始槽位没消费：接口说「没有下一页」不代表这一页也取完了
    const consumedInPage = Math.max(0, cursor - (page - 1) * size);
    const leftInPage = Math.max(0, lastLen - consumedInPage);

    let hasMore;
    if (!items.length) {
        // 一条都没交付：再让宿主拿同一个 offset 问一次就是无限空转。
        // 这已经是「翻到上限/连续空页/接口说没了」三者之一的结论，到此为止。
        hasMore = false;
    } else if (leftInPage > 0) {
        // 这一页还有没交付的原始槽位——接口说「没有下一页」也不影响，先把这页取完
        hasMore = true;
    } else if (stopped) {
        // 'end' 接口说没有下一页、'empty' 连续两页没东西可交付 → 一定到底。
        // 不能再拿 total 比：total 是 media_count / numResults，不扣失效与私有，
        // 尾部只要有失效视频就永远「还差几条」，宿主就一直转圈。
        hasMore = false;
    } else if (total > 0) {
        hasMore = cursor < total;
    } else {
        hasMore = capped || items.length === want || lastHasMore;
    }
    return {
        items,
        hasMore,
        nextOffset: cursor,
        ...(total ? { total } : {}),
    };
}

/**
 * 宿主会在歌单详情里问 `getPlaylistDetail`：把曲目数、简介补上，卡片和缝里的标题才对。
 *
 * @param {object} collection 宿主手里那张卡
 * @param {{ total?: number, owner?: string }} extra
 */
export function refineCollection(collection, extra) {
    if (!collection) return null;
    const next = { ...collection };
    const total = Number(extra && extra.total) || 0;
    if (total) next.trackCount = total;
    if (!next.description && extra && extra.owner) next.description = extra.owner;
    return next;
}

/**
 * bilibili 扫码的状态 → 宿主的 LoginState（types/onlineMusic 的 LoginState）。
 *
 * 宿主只认这几种：waiting / scanned / confirmed / expired / error。
 */
export function toLoginState(answer) {
    const stage = answer && answer.stage;
    if (stage === 'ok') return { state: 'confirmed' };
    if (stage === 'scanned') return { state: 'scanned' };
    if (stage === 'expired') return { state: 'expired' };
    if (stage === 'error') return { state: 'error', message: String((answer && answer.message) || '') };
    return { state: 'waiting' };
}

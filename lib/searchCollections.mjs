// lib/searchCollections.mjs
// Folia 0.7.26 新搜索页的「合集 / 收藏」两类结果。
//
// 宿主 omni.searchProviderCollections(providerId, kind, query, {limit, offset})
// 会直接调 provider.search.searchAlbums / searchPlaylists，并把结果过滤成
// item.providerId === providerId。
//
// 0.7.3 只按列表名字过滤，搜「风衣」这种歌名两类必然全空。0.7.4 改成三层：
//   1. 名字 / UP 主 / 简介命中（本地库，最相关）
//   2. 内容命中：收藏夹里真的有标题含关键词的视频（主进程 fav/resource/list 的 keyword）
//      「合集」则是从 bilibili 视频搜索结果反查 ugc_season 得到的全站合集
//   3. 一个都没命中 → 列出全部已接入列表，保证分类不再空白
//
// bilibili Web 端没有「按关键词搜别人的收藏夹」这种接口（media_list / fav /
// collection / season 这些 search_type 全被降级过滤），所以「收藏」只能搜已接入的；
// 「合集」用 view?bvid= 的 ugc_season 做真正的全站反查。
//
// 纯函数，不联网、不碰 DOM，测试在 test/searchCollections.test.mjs。

import { excludeCollections } from './exclude.mjs';
import { resourceOf, toCollection } from './collected.mjs';

const SEARCHABLE = ['name', 'owner', 'description', 'desc', 'title'];
/** 全站合集的自包含 id：点开时不用查库快照，直接从 id 解析出 mid / sid。 */
export const WEB_SEASON_PREFIX = 'w-season-';
const REASON_WEB = 'bilibili 合集';

/** 关键词命中：名字 / UP 主 / 简介，都是大小写不敏感的子串匹配。 */
export function matchesCollection(raw, query) {
    if (!raw) return false;
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return true;
    for (const field of SEARCHABLE) {
        const value = raw[field];
        if (value == null) continue;
        if (String(value).toLowerCase().includes(needle)) return true;
    }
    return false;
}

/** 本地已有名字精确命中的合集时，不必再去反查全站（省一次全网搜索，结果也更干净）。 */
export function hasLocalNameHit(list, query, excluded) {
    return excludeCollections(Array.isArray(list) ? list : [], excluded)
        .some((raw) => matchesCollection(raw, query));
}

/**
 * 主进程反查出来的全站合集 → 库快照同形状的 raw。
 * key 自带 mid / sid，catalog 拿到就能直接取曲目。
 */
export function remoteSeasonRaw(season) {
    if (!season) return null;
    const mid = String(season.mid || '');
    const sid = String(season.sid || season.id || '');
    if (!/^\d+$/.test(mid) || !/^\d+$/.test(sid)) return null;
    return {
        key: `${WEB_SEASON_PREFIX}${mid}-${sid}`,
        kind: 'season',
        mid,
        sid,
        name: String(season.name || season.title || '').trim() || '未命名合集',
        count: Number(season.count) || 0,
        cover: String(season.cover || ''),
        owner: String(season.owner || ''),
        source: 'web',
        matchReason: REASON_WEB,
    };
}

/** 自包含 id → 可用的 raw；不是全站合集 id 就返回 null。 */
export function remoteSeasonFromKey(key) {
    const match = new RegExp(`^${WEB_SEASON_PREFIX}(\\d+)-(\\d+)$`).exec(String(key || ''));
    if (!match) return null;
    return {
        key: String(key), kind: 'season', mid: match[1], sid: match[2],
        name: '', count: 0, cover: '', owner: '', source: 'web',
    };
}

/**
 * 把三层候选合起来，按真实资源键去重（同一个合集可能既在手贴里、又被全站搜到）。
 *
 * @param {Array} list         snap.playlists / snap.albums
 * @param {string} query
 * @param {Set|string|Array|null} excluded
 * @param {Array} [remote]     全站反查的合集（raw 或主进程给的元信息）
 * @param {Set|null} [contentKeys] 夹内视频命中关键词的 raw.key
 * @param {boolean} [fallback] 无命中时是否退回全部已接入列表
 */
export function collectCandidates({
    list, query, excluded, remote = [], contentKeys = null, fallback = true,
} = {}) {
    const source = excludeCollections(Array.isArray(list) ? list : [], excluded);
    const nameHits = source.filter((raw) => matchesCollection(raw, query));
    const seen = new Set(nameHits.map(resourceOf));

    const keys = contentKeys instanceof Set ? contentKeys : new Set(contentKeys || []);
    const contentHits = [];
    if (keys.size) {
        for (const raw of source) {
            const res = resourceOf(raw);
            if (!keys.has(String(raw.key)) || seen.has(res)) continue;
            seen.add(res);
            contentHits.push({ ...raw, matchReason: `包含《${String(query || '').trim()}》` });
        }
    }

    const remoteHits = [];
    for (const item of Array.isArray(remote) ? remote : []) {
        const raw = item && item.key ? item : remoteSeasonRaw(item);
        if (!raw || !raw.key) continue;
        const res = resourceOf(raw);
        if (!res || seen.has(res)) continue;
        seen.add(res);
        remoteHits.push(raw.matchReason ? raw : { ...raw, matchReason: REASON_WEB });
    }

    let hits = [...nameHits, ...contentHits, ...remoteHits];
    let usedFallback = false;
    if (!hits.length && String(query || '').trim() && fallback) {
        hits = source;
        usedFallback = true;
    }
    return { hits, usedFallback, sourceCount: source.length };
}

/** 给宿主的结果卡片补一个「为什么出现在这里」的副标题。 */
function withReason(dto, raw) {
    if (!raw || !raw.matchReason) return dto;
    if (dto.type === 'album') return { ...dto, artists: [{ name: raw.matchReason }] };
    return { ...dto, creator: { id: String(raw.mid || ''), nickname: raw.matchReason } };
}

/**
 * 一页集合搜索结果。
 *
 * @param {Array} list        snap.playlists 或 snap.albums（已按页签分好类）
 * @param {string} query      用户输入的关键词
 * @param {string} providerId 宿主给本模组起的音源 id
 * @param {number} limit      每页条数
 * @param {number} offset     起始下标
 * @param {Set|string|Array} [excluded] 设置里勾掉的收藏夹
 * @param {object} [options]  { remote, contentKeys, fallback }
 * @returns {{items: Array, total: number, hasMore: boolean, nextOffset: number}}
 */
export function searchCollectionPage(list, query, providerId, limit, offset, excluded, options = {}) {
    const { hits } = collectCandidates({
        list, query, excluded,
        remote: options.remote,
        contentKeys: options.contentKeys,
        fallback: options.fallback !== false,
    });
    const start = Math.max(0, Number(offset) || 0);
    const want = Math.max(1, Number(limit) || hits.length || 1);
    const items = hits
        .slice(start, start + want)
        .map((raw) => withReason(toCollection(raw, providerId), raw))
        .filter(Boolean);
    return {
        items,
        total: hits.length,
        hasMore: start + items.length < hits.length,
        nextOffset: start + items.length,
    };
}

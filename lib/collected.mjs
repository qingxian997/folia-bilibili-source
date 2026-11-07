// lib/collected.mjs
// 「我收藏的」：bilibili /x/v3/fav/folder/collected/list 的条目 → 宿主集合。
//
// 这个接口在 platform=web 下混着两类东西：
//   type 11 = 收藏的别人的公开收藏夹（id 是完整 mlid，取曲目走 fav/resource/list）
//   type 21 = 收藏的视频合集（id 是 season_id，配合 mid 走 seasons_archives_list）
// 其余 type（音频、番剧等）和 state=1（已失效）都不收。
//
// 纯函数，不联网、不碰 DOM，测试在 test/collected.test.mjs。

export const COLLECTED_FOLDER = 'c-fav-';
export const COLLECTED_SEASON = 'c-season-';

/**
 * 一条接口原始项 → 统一列表项。认不出来返回 null。
 * 主进程已经把字段压平成 { id, mid, type, title, cover, owner, count, state }。
 */
export function classifyCollected(item) {
    if (!item || Number(item.state) === 1) return null;
    const type = Number(item.type) || 0;
    const id = String(item.id || '');
    const mid = String(item.mid || '');
    if (!id) return null;
    const common = {
        name: String(item.title || '').trim() || '未命名列表',
        count: Number(item.count) || 0,
        cover: String(item.cover || ''),
        owner: String(item.owner || ''),
        source: 'collected',
    };
    if (type === 11) {
        return {
            ...common,
            kind: 'folder',
            key: COLLECTED_FOLDER + id,
            mediaId: id,
            mid,
        };
    }
    if (type === 21 && mid) {
        return {
            ...common,
            kind: 'season',
            key: COLLECTED_SEASON + mid + '-' + id,
            sid: id,
            mid,
        };
    }
    return null;
}

/** 一串接口原始项 → 统一列表项（去掉失效与不认识的）。 */
export function parseCollected(list) {
    return (Array.isArray(list) ? list : []).map(classifyCollected).filter(Boolean);
}

/**
 * 去重用的「真实资源键」：和 key 前缀无关。
 * 同一个收藏夹既被手贴又被账号收藏时，两条会算出同一个键。
 */
export function resourceOf(raw) {
    if (!raw) return '';
    if (raw.kind === 'folder') return 'fav:' + String(raw.mediaId || raw.key || '');
    return String(raw.kind || '') + ':' + String(raw.mid || '') + ':' + String(raw.sid || '');
}

/** 先到先得去重。调用方按优先级传数组：自建 → 手贴 → 账号收藏。 */
export function mergeUnique(groups) {
    const seen = new Set();
    const out = [];
    for (const group of groups || []) {
        for (const raw of group || []) {
            const key = resourceOf(raw);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            out.push(raw);
        }
    }
    return out;
}

/** 自己创建的收藏夹 → 统一列表项。封面来自主进程的封面缓存。 */
export function normalizeOwn(folder, ownerName, ownerId, coverUrl) {
    if (!folder) return null;
    const id = String(folder.id || '');
    if (!id) return null;
    return {
        key: id,
        kind: 'folder',
        mediaId: id,
        mid: String(ownerId || ''),
        name: String(folder.title || '').trim() || '未命名收藏夹',
        count: Number(folder.count) || 0,
        cover: String(coverUrl || ''),
        owner: String(ownerName || ''),
        isDefault: Boolean(folder.isDefault),
        source: 'own',
    };
}

/** 设置里手贴的列表 → 统一列表项（kind 可能是 folder / season / series）。 */
export function normalizeExtra(extra) {
    if (!extra) return null;
    return { ...extra, source: 'extra' };
}

/**
 * 统一列表项 → 宿主 ProviderCollection。
 * 收藏夹落「收藏」页签（宿主原文「歌单」，playlist），合集 / 系列落「合集」页签（宿主原文「专辑」，album）。
 */
export function toCollection(raw, providerId) {
    if (!raw) return null;
    const collection = {
        providerId: String(providerId || ''),
        id: String(raw.key),
        type: raw.kind === 'folder' ? 'playlist' : 'album',
        name: raw.name || '未命名列表',
        trackCount: Number(raw.count) || 0,
    };
    if (raw.cover) collection.coverUrl = raw.cover;
    if (raw.owner) {
        collection.creator = { id: String(raw.mid || ''), nickname: raw.owner };
        collection.description = raw.owner;
    }
    // 自建收藏夹全是自己的，不只是默认夹。宿主拿 isOwned 判「我的还是别人的」
    // （canSubscribeCollection 里 isOwned===true 会藏掉订阅入口），标错就成了别人的夹子。
    if (raw.source === 'own') collection.isOwned = true;
    return collection;
}

/**
 * 读三个来源，任何一个单独失败都不连累其它两个。
 *
 * 真机踩过：没登录时 `folders` 直接抛错，Promise.all 一起炸，连设置里手贴的
 * 公开合集都进不了「专辑」页签。这里把「自建收藏夹」降级成空，其余照常。
 * 手贴列表和「我收藏的」各自还有自己的缓存/降级，这里只补 folders 这一环。
 */
export async function readLibrarySources({ folders, extras, collected, onError = () => {} } = {}) {
    const [own, manual, account] = await Promise.all([
        Promise.resolve()
            .then(() => (typeof folders === 'function' ? folders() : folders))
            .catch((error) => {
                onError(error);
                return { items: [], owner: '', mid: '' };
            }),
        Promise.resolve().then(() => (typeof extras === 'function' ? extras() : extras)),
        Promise.resolve().then(() => (typeof collected === 'function' ? collected() : collected)),
    ]);
    return { folders: own || { items: [], owner: '', mid: '' }, extras: manual, collected: account };
}

/**
 * 三个来源合流，分好两个页签的队列。
 * 优先级：自建收藏夹 → 手贴列表 → 账号「我收藏的」，同一个资源只留一条。
 *
 * @param {object} input
 * @param {Array} input.folders   folders rpc 的自建收藏夹
 * @param {Array} input.extras    extrasNow() 的手贴列表
 * @param {Array} input.collected parseCollected() 的账号收藏列表
 * @param {Record<string, string[]>} input.covers 自建收藏夹的封面缓存（id → 图片数组）
 */
export function buildLibrary({ folders = [], extras = [], collected = [], covers = {}, ownerName = '', ownerId = '' } = {}) {
    const list = Array.isArray(folders) ? folders : [];
    const own = list
        .map((folder) => normalizeOwn(folder, ownerName, ownerId, (covers[String(folder.id)] || [])[0] || ''))
        .filter(Boolean);
    const manual = (Array.isArray(extras) ? extras : []).map(normalizeExtra).filter(Boolean);
    const account = Array.isArray(collected) ? collected : [];
    const playlists = mergeUnique([
        own,
        manual.filter((raw) => raw.kind === 'folder'),
        account.filter((raw) => raw.kind === 'folder'),
    ]);
    const albums = mergeUnique([
        manual.filter((raw) => raw.kind !== 'folder'),
        account.filter((raw) => raw.kind !== 'folder'),
    ]);
    return {
        playlists,
        albums,
        byKey: new Map([...playlists, ...albums].map((raw) => [raw.key, raw])),
        folders: list,
    };
}

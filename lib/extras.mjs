// lib/extras.mjs
// 「额外收藏夹 / 合集 / 系列」：用户自己贴进来的公开列表。
//
// 这里的活是纯字符串的：把一条链接认成 { kind, mediaId | mid+sid }，再给它一个能当歌单 id 的键。
// 解析和键都只在这里做一次——主进程只负责按 ref 发请求，不再各写一份解析。
//
// 认得的形态（真机验证过，未登录都读得到）：
//   收藏夹  https://www.bilibili.com/medialist/detail/ml337285064
//           https://space.bilibili.com/357648464/favlist?fid=337285064
//           337285064（纯数字当收藏夹 id）
//   合集    https://space.bilibili.com/357648464/lists/3466635?type=season
//           https://space.bilibili.com/357648464/channel/collectiondetail?sid=3466635
//   系列    https://space.bilibili.com/357648464/lists/402153?type=series
//           https://space.bilibili.com/357648464/channel/seriesdetail?sid=402153

/** 收藏夹 / 合集 / 系列的接口一页都给 20 条，和宿主的 getPlaylistTracks 换算一致。 */
export const EXTRA_PAGE_SIZE = 20;

/** 一条输入能拆成几个引用：换行、逗号、分号、空白都算分隔。 */
export function splitExtraRefs(text) {
    return String(text || '')
        .split(/[\s,;，；]+/)
        .map((item) => item.trim())
        .filter(Boolean);
}

/**
 * 一条输入 → 一个引用。认不出来返回 null（界面上会标成「看不懂」）。
 *
 * @param {string} raw
 * @returns {null | { kind: 'folder', mediaId: string } | { kind: 'season' | 'series', mid: string, sid: string }}
 */
export function parseExtraRef(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;

    const midMatch = /space\.bilibili\.com\/(\d+)/i.exec(text);
    const mid = midMatch ? midMatch[1] : '';

    // 合集 / 系列：接口要求同时给 UP 主 UID 和列表 ID，只有一个认不出来。
    const sidMatch = /[?&]sid=(\d+)/i.exec(text) || /\/lists\/(\d+)/i.exec(text);
    if (sidMatch) {
        if (!mid) return null;
        const kind = /seriesdetail|[?&]type=series\b|\/series\//i.test(text) ? 'series' : 'season';
        return { kind, mid, sid: sidMatch[1] };
    }

    const ml = /(?:^|\/)ml(\d+)/i.exec(text);
    if (ml) return { kind: 'folder', mediaId: ml[1] };

    const fid = /[?&]fid=(\d+)/i.exec(text);
    if (fid) return { kind: 'folder', mediaId: fid[1] };

    if (/^\d{1,20}$/.test(text)) return { kind: 'folder', mediaId: text };
    return null;
}

/**
 * 引用 → 歌单 id。宿主只认这个字符串，别改格式：改了就认不出旧设置里存的收藏夹。
 * 前缀 `x-` 用来和本账号的收藏夹（纯数字 id）区分开。
 */
export function extraKey(ref) {
    if (!ref) return '';
    if (ref.kind === 'folder') return `x-fav-${ref.mediaId}`;
    return `x-${ref.kind}-${ref.mid}-${ref.sid}`;
}

/** 一串输入 → 去重后的引用（同一个夹子贴两次只留一条）。 */
export function parseExtraList(text) {
    const seen = new Set();
    const items = [];
    const bad = [];
    for (const raw of splitExtraRefs(text)) {
        const ref = parseExtraRef(raw);
        if (!ref) {
            bad.push(raw);
            continue;
        }
        const key = extraKey(ref);
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ ...ref, key, raw });
    }
    return { items, bad };
}

/**
 * 引用 + 主进程查到的元信息 → 宿主的 ProviderCollection。
 *
 * @param {Array<{ key: string, kind: string, name?: string, count?: number, cover?: string, owner?: string }>} extras
 * @param {{ providerId: string }} options
 */
export function extrasToCollections(extras, options) {
    const providerId = String((options && options.providerId) || '');
    return (extras || []).filter(Boolean).map((extra) => {
        const collection = {
            providerId,
            id: extra.key,
            type: 'playlist',
            name: extra.name || '未命名收藏夹',
            trackCount: Number(extra.count) || 0,
        };
        if (extra.cover) collection.coverUrl = extra.cover;
        if (extra.owner) {
            collection.creator = { id: String(extra.mid || ''), nickname: extra.owner };
            collection.description = extra.owner;
        }
        return collection;
    });
}

/** 合集名前面常带「合集·」，卡片上重复一遍没意义。 */
export function cleanListName(name) {
    return String(name || '')
        .replace(/^合集[·・:：]\s*/, '')
        .replace(/^系列[·・:：]\s*/, '')
        .trim();
}

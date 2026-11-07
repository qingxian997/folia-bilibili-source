// lib/recommend.mjs
// 「我喜欢的音乐」特殊卡 + 旧版本推荐视频卡的开卡兜底。纯函数，不联网、不碰 DOM，
// 用例在 test/recommend.test.mjs。
//
// 0.8.1 起本模组不再挂「推荐」页签：宿主那排胶囊在 bilibili 音源下由 lib/homeTab.mjs
// 藏掉，capabilities.recommendations 也不再声明。原来 0.8.0 的 8 张入口卡里，
// 用户只要求留下「我喜欢的音乐」，并且把它挪到书库墙的「收藏」页签
// （client.mjs 的 getUserPlaylists() 会把它放在列表最前面）。
//
// 宿主 BravaisHome 的 Te() 对 online 集合认 raw.isLiked === true，画成特殊卡 +
// 竖排快捷入口；卡片点开走 catalog.getPlaylistTracks → tracksOf('w-liked')，
// 再解析到播放器心形按钮真正写入的那个收藏夹。

export const LIKED_KEY = 'w-liked';

export function isLikedKey(key) {
    return String(key || '') === LIKED_KEY;
}

/**
 * 0.7.9 及更早的推荐页曾给每个视频发一张 `w-reco-<bvid>` 卡。
 * 卡片可能比 5 分钟 feed 缓存活得久，换批之后旧卡的 bvid 不在新批次里，
 * 所以优先用累积缓存里的完整元数据，找不到就用卡片自己的 name / coverUrl /
 * creator 兜底 —— 播放只认 sourceRef 里的 bvid，元数据不全也能正常播。
 */
export function recoTrackRaw(bvid, cached, collection) {
    if (cached && String(cached.bvid) === String(bvid)) return cached;
    const card = collection || {};
    return {
        bvid: String(bvid || ''),
        title: card.name || '',
        author: (card.creator && card.creator.nickname) || '',
        cover: card.coverUrl || '',
        durationMs: 0,
    };
}

/** 是不是旧版推荐视频卡 id；不是就返回 null，交给原来的收藏夹 / 合集路由。 */
export function parseRecoKey(key) {
    const match = /^w-reco-(BV[0-9A-Za-z]+)$/i.exec(String(key || ''));
    return match ? match[1] : null;
}

/** 「我喜欢的音乐」：宿主 BravaisHome 的 Te() 认 raw.isLiked，会画成特殊卡。 */
export function likedCollection(raw, providerId) {
    const card = {
        providerId: String(providerId || ''),
        id: LIKED_KEY,
        type: 'playlist',
        name: '我喜欢的音乐',
        trackCount: Math.max(0, Number(raw && raw.count) || 0),
        isLiked: true,
        description: 'bilibili',
        creator: { id: '', nickname: 'bilibili' },
    };
    if (raw && raw.cover) card.coverUrl = raw.cover;
    return card;
}

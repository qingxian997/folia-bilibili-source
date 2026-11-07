'use strict';

// lib/feed.cjs
// bilibili 首页推荐 feed（x/web-interface/index/top/feed/rcmd）→ 模组内部统一的视频条目。
//
// 为什么单独一层：这个接口返回的形状和 search/type 完全不同（duration 是秒、
// UP 主在 owner.name、混着直播 / 番剧 / 广告卡），而 client 侧的 toSong() 只认
// { bvid, title, author, cover, durationMs }。纯函数，不联网、不碰 DOM，
// 用例在 test/feed.test.mjs。

// 0.8.1 之前这里有个 MAX_FRESH_IDX = 400 的「刷到 400 就回到 1」回绕。
// 实测 fresh_idx = 1 / 201 / 401 / 601 / 801 / 1201 / 2001 每批 30 条、code=0、
// 210 首零重复，那个上限纯属模组自己加的，正是探索页刷久了整批重来的根因。删掉了。
/** rcmd 的 ps 上限：实测 30 正常、32 起一律 -400。宿主按 35 个推荐位问，也只能给 30 条。 */
const MAX_FEED_PAGE = 30;

/** 接口有时给 http 或 // 开头的图床地址，file:// 页面里会被安全策略拦。 */
function safeCover(url) {
    const text = String(url || '');
    if (!text) return '';
    if (text.startsWith('//')) return `https:${text}`;
    return text.replace(/^http:\/\//i, 'https://');
}

function stripTags(text) {
    return String(text || '').replace(/<[^>]+>/g, '').trim();
}

/** feed 的 duration 是整数秒；偶尔给 "3:20" 这种文本，也一并认。 */
function durationMs(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value * 1000);
    const parts = String(value || '').split(':').map(Number).filter(Number.isFinite);
    if (!parts.length) return 0;
    return Math.round(parts.reduce((total, item) => total * 60 + item, 0) * 1000);
}

/**
 * 只留真正能播的视频（goto === 'av' 且有 bvid）。
 * 直播、番剧、广告位直接丢掉：推荐卡没有分页下标，过滤掉不会像搜索那样弄乱 offset。
 */
function normalizeFeedItems(items) {
    const source = Array.isArray(items) ? items : [];
    const out = [];
    for (const item of source) {
        if (!item || item.goto !== 'av' || !item.bvid) continue;
        const reason = item.rcmd_reason || {};
        out.push({
            bvid: String(item.bvid),
            title: stripTags(item.title) || '未命名视频',
            author: String((item.owner && item.owner.name) || ''),
            cover: safeCover(item.pic),
            durationMs: durationMs(item.duration),
            pubdate: (Number(item.pubdate) || 0) * 1000,
            description: stripTags(reason.content || ''),
            index: out.length,
            playable: true,
        });
    }
    return out;
}

/**
 * 下一批的 fresh_idx。bilibili 用「已看过的条数」当游标，累加即可，没有上界。
 * 非法值（NaN / Infinity / 字符串）一律回落到 1，免得把 bad request 甩给宿主。
 */
function nextFeedCursor(freshIdx, delivered) {
    const from = Number(freshIdx);
    if (!Number.isFinite(from) || from <= 0) return 1;
    const count = Number(delivered);
    const step = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    return Math.floor(from) + step;
}

module.exports = { normalizeFeedItems, nextFeedCursor, MAX_FEED_PAGE };

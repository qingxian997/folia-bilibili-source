'use strict';

// lib/memoCache.cjs
// 主进程那层「短期记忆」的写入规则。
//
// 存在的理由很简单：宿主的墙一刷新就会连着问好几次同一件事，每次都真去打 bilibili
// 既慢又容易吃 -412。但 key 里带着搜索词、收藏夹分页和字幕 id，一个开着的窗口能攒下
// 几百上千条，而值往往是整页歌曲数组（每首带封面 URL）。
//
// 0.9.0 之前这里只有 clearCache 兜底，等于没有上限。现在写入时先入先出：超过上限就丢
// 最老的那条。300 条足够覆盖「一面墙 + 一次翻页 + 正在看的那首歌」的工作集。

const MEMO_MAX = 300;

/**
 * 写一条记忆，并把超出上限的最老条目挤掉。
 * @param {Map<string, {at: number, value: any}>} map
 * @param {string} key
 * @param {any} value
 * @param {number} [max]
 */
function remember(map, key, value, max = MEMO_MAX) {
    const limit = Number(max) > 0 ? Number(max) : MEMO_MAX;
    // 先删再写：同一个 key 重写时要挪到队尾，否则「最近用过」的反而先被挤掉。
    map.delete(key);
    map.set(key, { at: Date.now(), value });
    while (map.size > limit) {
        const oldest = map.keys().next().value;
        map.delete(oldest);
    }
    return value;
}

module.exports = { MEMO_MAX, remember };

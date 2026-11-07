// bilibili 首页推荐 feed → 统一视频条目：滤掉不能播的、秒转毫秒、封面补 https。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeFeedItems, nextFeedCursor, MAX_FEED_PAGE } = require('../lib/feed.cjs');

const video = (patch = {}) => ({
    goto: 'av',
    bvid: 'BV1mJ4w6HE29',
    title: '<em>花生</em>与葱花',
    duration: 672,
    pic: 'http://i1.hdslb.com/bfs/archive/cover.jpg',
    pubdate: 1760000000,
    owner: { mid: 11073, name: 'hanser' },
    rcmd_reason: { content: '关注 UP 主推荐' },
    ...patch,
});

test('首页 feed 的字段被翻译成 toSong 认识的形状', () => {
    const items = normalizeFeedItems([video()]);
    assert.equal(items.length, 1);
    assert.deepEqual(items[0], {
        bvid: 'BV1mJ4w6HE29',
        title: '花生与葱花',
        author: 'hanser',
        cover: 'https://i1.hdslb.com/bfs/archive/cover.jpg',
        durationMs: 672000,
        pubdate: 1760000000000,
        description: '关注 UP 主推荐',
        index: 0,
        playable: true,
    });
});

test('直播 / 番剧 / 广告 / 无 bvid 都不进推荐卡', () => {
    const items = normalizeFeedItems([
        video({ goto: 'live' }),
        video({ goto: 'bangumi' }),
        video({ bvid: '' }),
        null,
        video({ bvid: 'BV1good00001' }),
    ]);
    assert.equal(items.length, 1);
    assert.equal(items[0].bvid, 'BV1good00001');
    assert.equal(items[0].index, 0, 'index 按交付顺序重排');
});

test('// 开头的封面补协议，字符串时长也能认', () => {
    const [item] = normalizeFeedItems([video({ pic: '//i0.hdslb.com/a.jpg', duration: '3:20' })]);
    assert.equal(item.cover, 'https://i0.hdslb.com/a.jpg');
    assert.equal(item.durationMs, 200000);
});

test('不是数组时给空结果，不抛', () => {
    assert.deepEqual(normalizeFeedItems(null), []);
    assert.deepEqual(normalizeFeedItems({ item: [] }), []);
});

test('ps 上限不能超过 30：实测 32 起返回 -400，宿主问 35 也只能给 30', () => {
    assert.ok(MAX_FEED_PAGE > 0 && MAX_FEED_PAGE <= 30);
});

test('0.8.1：下一批游标按交付条数一直累加，不再有 400 回绕', () => {
    assert.equal(nextFeedCursor(1, 20), 21);
    assert.equal(nextFeedCursor(21, 0), 21);
    assert.equal(nextFeedCursor(399, 30), 429, '旧版会在这里回到 1，探索页就整批重来');
    assert.equal(nextFeedCursor(2001, 30), 2031, '实测 fresh_idx=2001 仍正常返回 30 条');
    assert.equal(nextFeedCursor('x', 'y'), 1);
    assert.equal(nextFeedCursor(Infinity, 30), 1, '坏值别把 Infinity 发给 bilibili');
});

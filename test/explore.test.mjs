// 宿主「探索」页签的歌曲瀑布流：游标、section/item 形状、空批收敛。
// 契约来自 0.7.26 的 remoteActions-*.js + useExploreWall-*.js。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    EXPLORE_TITLE, feedCursor, moreCursor, parseExploreCursor,
    songsToItems, exploreSection, feedAnswer, sectionAnswer,
} from '../lib/explore.mjs';

const song = (id) => ({
    id,
    name: `歌 ${id}`,
    title: `歌 ${id}`,
    artists: [{ id: `${id}#artist`, name: 'UP' }],
    album: { id: `${id}#album`, name: '', coverUrl: `https://i0.hdslb.com/${id}.jpg` },
    durationMs: 200000,
    sourceRef: { kind: 'online', providerId: 'folium.bili-fav-wall.bili', mediaId: id },
});

test('游标是宿主认得不透明字符串，也要能解回 fresh_idx', () => {
    assert.equal(feedCursor(31), 'bili:feed:31');
    assert.equal(moreCursor(31), 'bili:more:31');
    assert.equal(parseExploreCursor(feedCursor(31)), 31);
    assert.equal(parseExploreCursor(moreCursor(61)), 61);
    assert.notEqual(feedCursor(31), moreCursor(31), '两种游标不能撞');
    assert.equal(parseExploreCursor('read-already'), null, '宿主自己的哨兵交回滚动游标');
    assert.equal(parseExploreCursor(null), null);
    assert.equal(parseExploreCursor('bili:feed:0'), null);
    assert.equal(parseExploreCursor('netease:feed:3'), null);
});

test('歌曲卡的 item 形状：kind:song + 完整 DTO，坏歌被丢掉', () => {
    const items = songsToItems([song('BV1'), null, {}, song('BV2')]);
    assert.equal(items.length, 2);
    assert.deepEqual(items[0], { kind: 'song', song: song('BV1') });
    assert.equal(items[1].song.album.coverUrl, 'https://i0.hdslb.com/BV2.jpg');
    assert.deepEqual(songsToItems(null), []);
});

test('section 带稳定标题、独立 id 和 moreCursor；空批不交 section', () => {
    const section = exploreSection(1, 31, [song('BV1'), song('BV2')]);
    assert.equal(section.title, EXPLORE_TITLE);
    assert.equal(section.id, 'bili-reco-1');
    assert.equal(section.items.length, 2);
    assert.equal(section.moreCursor, moreCursor(31));
    assert.equal(exploreSection(1, 31, []), null);
    assert.equal(exploreSection(31, 61, [null, {}]), null);
});

test('getExploreFeed 的答复：nextCursor 必须推进，且不能声明 refreshReadsAnew', () => {
    const section = exploreSection(1, 31, [song('BV1')]);
    const answer = feedAnswer(section, 31);
    assert.equal(answer.sections.length, 1);
    assert.equal(answer.nextCursor, feedCursor(31));
    assert.notEqual(answer.nextCursor, feedCursor(1), '和上一批的游标相同会被宿主当成没进度');
    assert.equal(answer.refreshReadsAnew, undefined,
        '0.8.1：这一位让宿主 refresh 跳过 moreCursor 追加、重放旧池子，正是「换一批还是这些」的根因');
    assert.equal(parseExploreCursor(answer.nextCursor), 31);

    const empty = feedAnswer(null, 31);
    assert.deepEqual(empty.sections, []);
    assert.equal(empty.nextCursor, undefined, '空批别再给 nextCursor，否则宿主会连问 3 次');
});

test('0.8.1：fresh_idx 没有 400 回绕，游标一直往后走', () => {
    // 实测 bilibili fresh_idx=2001 仍返回 30 条 code=0；旧版 idxOf() 会把它压回 400 / 1。
    assert.equal(parseExploreCursor(feedCursor(401)), 401);
    assert.equal(parseExploreCursor(feedCursor(2001)), 2001);
    assert.equal(parseExploreCursor(moreCursor(2001)), 2001);
    assert.equal(exploreSection(2001, 2031, [song('BV1')]).id, 'bili-reco-2001');
    assert.equal(feedCursor(Infinity), 'bili:feed:1', '坏值回落到 1，不把 Infinity 塞进 RPC');
    assert.equal(feedCursor('x'), 'bili:feed:1');
});

test('每区「更多」：没有新歌就撤掉 moreCursor，按钮不会点了没反应', () => {
    const more = sectionAnswer([song('BV3')], 61);
    assert.equal(more.items.length, 1);
    assert.equal(more.moreCursor, moreCursor(61));
    assert.deepEqual(sectionAnswer([], 61), { items: [] });
});

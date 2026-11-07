// 额外列表的解析：链接认不认得出、键稳不稳、卡片字段对不对。
// 这些用例都不联网——真正的接口在 test/main.test.mjs 的联网用例里。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    cleanListName,
    extraKey,
    extrasToCollections,
    parseExtraList,
    parseExtraRef,
    splitExtraRefs,
} from '../lib/extras.mjs';

test('收藏夹的三种链接都认', () => {
    assert.deepEqual(parseExtraRef('https://www.bilibili.com/medialist/detail/ml337285064'), { kind: 'folder', mediaId: '337285064' });
    assert.deepEqual(parseExtraRef('https://space.bilibili.com/357648464/favlist?fid=337285064'), { kind: 'folder', mediaId: '337285064' });
    assert.deepEqual(parseExtraRef('337285064'), { kind: 'folder', mediaId: '337285064' });
});

test('合集的两种链接都认，且要带 UP 主 UID', () => {
    const modern = parseExtraRef('https://space.bilibili.com/357648464/lists/3466635?type=season');
    assert.deepEqual(modern, { kind: 'season', mid: '357648464', sid: '3466635' });
    const legacy = parseExtraRef('https://space.bilibili.com/357648464/channel/collectiondetail?sid=3466635');
    assert.deepEqual(legacy, { kind: 'season', mid: '357648464', sid: '3466635' });
    // 接口要 mid + sid 两个，只有 sid 认不出来
    assert.equal(parseExtraRef('https://www.bilibili.com/lists/3466635?type=season'), null);
});

test('系列能认，且不会被当成合集', () => {
    assert.deepEqual(parseExtraRef('https://space.bilibili.com/357648464/lists/402153?type=series'), {
        kind: 'series',
        mid: '357648464',
        sid: '402153',
    });
    assert.deepEqual(parseExtraRef('https://space.bilibili.com/357648464/channel/seriesdetail?sid=402153'), {
        kind: 'series',
        mid: '357648464',
        sid: '402153',
    });
});

test('认不出来的东西返回 null', () => {
    assert.equal(parseExtraRef(''), null);
    assert.equal(parseExtraRef('随便写的东西'), null);
    assert.equal(parseExtraRef('https://www.bilibili.com/video/BV1xx411c7mD'), null);
});

test('键带前缀，和账号自己的收藏夹 id 分得开', () => {
    assert.equal(extraKey({ kind: 'folder', mediaId: '123' }), 'x-fav-123');
    assert.equal(extraKey({ kind: 'season', mid: '9', sid: '8' }), 'x-season-9-8');
    assert.equal(extraKey({ kind: 'series', mid: '9', sid: '8' }), 'x-series-9-8');
    assert.equal(extraKey(null), '');
});

test('一串输入：按行/逗号拆开、去重、坏链接单独挑出来', () => {
    const text = [
        'https://www.bilibili.com/medialist/detail/ml111',
        'https://space.bilibili.com/2/favlist?fid=111',
        'https://space.bilibili.com/2/lists/222?type=season',
        '乱写的',
    ].join('\n');
    const { items, bad } = parseExtraList(text);
    assert.equal(items.length, 2);
    assert.deepEqual(items.map((item) => item.key), ['x-fav-111', 'x-season-2-222']);
    assert.deepEqual(bad, ['乱写的']);
});

test('空白输入给空列表，不会抛', () => {
    assert.deepEqual(parseExtraList(''), { items: [], bad: [] });
    assert.deepEqual(parseExtraList(null), { items: [], bad: [] });
    assert.deepEqual(splitExtraRefs('  a , b；c '), ['a', 'b', 'c']);
});

test('卡片照宿主的 ProviderCollection 形状给', () => {
    const cards = extrasToCollections(
        [{ key: 'x-fav-7', name: '别人的歌单', count: 12, cover: 'https://i0.hdslb.com/a.jpg', owner: '某UP', mid: '42' }],
        { providerId: 'folium.bili-fav.bili' },
    );
    assert.equal(cards.length, 1);
    assert.deepEqual(cards[0], {
        providerId: 'folium.bili-fav.bili',
        id: 'x-fav-7',
        type: 'playlist',
        name: '别人的歌单',
        trackCount: 12,
        coverUrl: 'https://i0.hdslb.com/a.jpg',
        creator: { id: '42', nickname: '某UP' },
        description: '某UP',
    });
});

test('缺名字/条数/封面的也能画出一张卡', () => {
    const [card] = extrasToCollections([{ key: 'x-fav-8' }], { providerId: 'p' });
    assert.equal(card.name, '未命名收藏夹');
    assert.equal(card.trackCount, 0);
    assert.equal(card.coverUrl, undefined);
    assert.equal(card.creator, undefined);
});

test('合集名前面的「合集·」去掉', () => {
    assert.equal(cleanListName('合集·绝区零·品鉴计划'), '绝区零·品鉴计划');
    assert.equal(cleanListName('系列：为你读诗'), '为你读诗');
    assert.equal(cleanListName('本来就干净'), '本来就干净');
    assert.equal(cleanListName(null), '');
});

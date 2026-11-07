// 纯映射层的用例：收藏夹/视频翻成宿主的数据形状，以及分页换算。
// 这些形状错了宿主就画不出卡片，所以断言写得具体一点。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    foldersToCollections,
    videoToSong,
    readTrackRange,
    refineCollection,
    toLoginState,
    FOLDER_PAGE_SIZE,
} from '../lib/collections.mjs';

const PROVIDER = 'folium.bili-fav-wall.bili';

test('收藏夹 → 歌单卡：providerId / type / 曲目数 / 封面都按宿主的字段来', () => {
    const collections = foldersToCollections(
        [
            { id: 900, title: '默认收藏夹', count: 968, isDefault: true },
            { id: 901, title: '纯音乐', count: 12 },
        ],
        { providerId: PROVIDER, covers: { 900: ['https://i0.hdslb.com/a.jpg'] }, owner: { id: '182', name: '青现' } },
    );

    assert.equal(collections.length, 2);
    assert.deepEqual(collections[0], {
        providerId: PROVIDER,
        id: '900',
        type: 'playlist',
        name: '默认收藏夹',
        trackCount: 968,
        coverUrl: 'https://i0.hdslb.com/a.jpg',
        isOwned: true,
        creator: { id: '182', nickname: '青现' },
    });
    // 没有封面就不写 coverUrl：宿主会画渐变占位，而不是去请求一个空地址。
    assert.equal('coverUrl' in collections[1], false);
    assert.equal(collections[1].isOwned, undefined);
});

test('视频 → 宿主的一首歌：sourceRef 指向本音源，专辑名用收藏夹名', () => {
    const song = videoToSong(
        { bvid: 'BV1xx411c7mD', title: '【周杰伦】晴天', author: '周董', cover: 'https://i0.hdslb.com/c.jpg', durationMs: 269000 },
        {
            providerId: PROVIDER,
            album: '默认收藏夹',
            decorate: () => ({ title: '晴天', artist: '周杰伦' }),
        },
    );

    assert.equal(song.id, 'BV1xx411c7mD');
    assert.equal(song.name, '晴天');
    assert.deepEqual(song.artists, [{ id: 'BV1xx411c7mD#artist', name: '周杰伦' }]);
    assert.equal(song.album.name, '默认收藏夹');
    assert.equal(song.album.coverUrl, 'https://i0.hdslb.com/c.jpg');
    assert.deepEqual(song.sourceRef, { kind: 'online', providerId: PROVIDER, mediaId: 'BV1xx411c7mD' });
});

test('没有 id 的视频直接丢掉，不给宿主制造点不动的卡片', () => {
    assert.equal(videoToSong({ title: '什么都没有' }, { providerId: PROVIDER }), null);
});

test('分页：offset 落在页中间时先切一刀，再整页拿', async () => {
    const asked = [];
    const pool = Array.from({ length: 60 }, (_, index) => ({ bvid: `BV${index}` }));
    const page = await readTrackRange({
        offset: 25,
        limit: 30,
        fetchPage: async (number) => {
            asked.push(number);
            const start = (number - 1) * FOLDER_PAGE_SIZE;
            return { items: pool.slice(start, start + FOLDER_PAGE_SIZE), total: 60, hasMore: start + FOLDER_PAGE_SIZE < 60 };
        },
    });

    // 25 起、30 条：第 2 页从第 5 条开始切，然后第 3 页整页
    assert.deepEqual(asked, [2, 3]);
    assert.equal(page.items.length, 30);
    assert.equal(page.items[0].bvid, 'BV25');
    assert.equal(page.items[29].bvid, 'BV54');
    assert.equal(page.nextOffset, 55);
    assert.equal(page.hasMore, true);
    assert.equal(page.total, 60);
});

test('分页：到底了就说没有更多，不多问一次接口', async () => {
    const asked = [];
    const page = await readTrackRange({
        offset: 0,
        limit: 40,
        fetchPage: async (number) => {
            asked.push(number);
            return { items: [{ bvid: 'A' }, { bvid: 'B' }], total: 2, hasMore: false };
        },
    });
    assert.deepEqual(asked, [1]);
    assert.equal(page.items.length, 2);
    assert.equal(page.hasMore, false);
});

test('分页：宿主一次要得太多时按上限翻，但老实说还有更多', async () => {
    let served = 0;
    const page = await readTrackRange({
        offset: 0,
        limit: 200,
        fetchPage: async () => {
            served += 1;
            return { items: Array.from({ length: 20 }, (_, i) => ({ bvid: `BV${served}-${i}` })), total: 9999, hasMore: true };
        },
    });
    // 上限 8 页
    assert.equal(served, 8);
    assert.equal(page.items.length, 160);
    assert.equal(page.hasMore, true);
});

// ---------------------------------------------------------------- 0.7.5 分页回归

/** 造一个收藏夹：raw 条目里混着失效视频（playable:false），位置必须保留。 */
function fakeFolder(total, deadAt = []) {
    const asked = [];
    const raw = Array.from({ length: total }, (_, index) => ({
        bvid: `BV${index}`,
        title: `第 ${index} 首`,
        playable: !deadAt.includes(index),
    }));
    return {
        asked,
        fetchPage: async (number) => {
            asked.push(number);
            const start = (number - 1) * FOLDER_PAGE_SIZE;
            const items = raw.slice(start, start + FOLDER_PAGE_SIZE);
            return { items, total, hasMore: start + items.length < total };
        },
    };
}

test('分页：页里有失效视频时 offset 按原始下标推进，拼接不重复', async () => {
    const folder = fakeFolder(45, [3, 11, 12]);
    const seen = [];
    let offset = 0;
    for (let round = 0; round < 4; round += 1) {
        const page = await readTrackRange({ offset, limit: 20, fetchPage: folder.fetchPage });
        seen.push(...page.items.map((item) => item.bvid));
        if (!page.hasMore) break;
        offset = page.nextOffset;
    }
    assert.equal(new Set(seen).size, seen.length, `拼接后出现重复：${seen.join(',')}`);
    assert.equal(seen.length, 42, '45 条里有 3 条失效，可交付应为 42');
    // 失效条目留在原位，但一条都不下发给宿主
    assert.ok(!seen.includes('BV3') && !seen.includes('BV11') && !seen.includes('BV12'));
});

test('分页：尾部整页失效时 hasMore 必须收敛，不能无限请求', async () => {
    const dead = Array.from({ length: 20 }, (_, i) => 40 + i);
    const folder = fakeFolder(60, dead);
    let offset = 0;
    let rounds = 0;
    let hasMore = true;
    while (hasMore && rounds < 10) {
        const page = await readTrackRange({ offset, limit: 20, fetchPage: folder.fetchPage });
        hasMore = page.hasMore;
        offset = page.nextOffset;
        rounds += 1;
    }
    assert.equal(hasMore, false, '尾部空页没有收敛，宿主会对着同一页无限滚动');
    assert.ok(rounds <= 4, `请求轮次过多：${rounds}`);
    assert.ok(folder.asked.length <= 6, `实际请求过多：${folder.asked.join(',')}`);
});

test('分页：一次要 50 条、夹里 45 条 → 45 条且到底', async () => {
    const folder = fakeFolder(45);
    const page = await readTrackRange({ offset: 0, limit: 50, fetchPage: folder.fetchPage });
    assert.equal(page.items.length, 45);
    assert.equal(page.hasMore, false);
    assert.equal(page.nextOffset, 45);
});

test('分页：keep 过滤掉的条目不占交付名额但占原始下标', async () => {
    const folder = fakeFolder(40);
    const long = new Set(['BV1', 'BV2', 'BV3']);
    const first = await readTrackRange({
        offset: 0,
        limit: 10,
        fetchPage: folder.fetchPage,
        keep: (item) => !long.has(item.bvid),
    });
    assert.equal(first.items.length, 10);
    assert.equal(first.items[0].bvid, 'BV0');
    assert.ok(!first.items.some((item) => long.has(item.bvid)));
    // 交付 10 条，但原始游标要走到 13（中间 3 条被过滤）
    assert.equal(first.nextOffset, 13);
    const second = await readTrackRange({
        offset: first.nextOffset,
        limit: 10,
        fetchPage: folder.fetchPage,
        keep: (item) => !long.has(item.bvid),
    });
    assert.equal(second.items[0].bvid, 'BV13');
});

test('歌单详情补上曲目数与作者，标题不被覆盖', () => {
    const refined = refineCollection({ id: '900', name: '默认收藏夹', type: 'playlist' }, { total: 968, owner: '青现' });
    assert.equal(refined.trackCount, 968);
    assert.equal(refined.description, '青现');
    assert.equal(refined.name, '默认收藏夹');
});

test('扫码状态翻成宿主认的那几种，未知一律算等待', () => {
    assert.deepEqual(toLoginState({ stage: 'ok' }), { state: 'confirmed' });
    assert.deepEqual(toLoginState({ stage: 'scanned' }), { state: 'scanned' });
    assert.deepEqual(toLoginState({ stage: 'expired' }), { state: 'expired' });
    assert.deepEqual(toLoginState({ stage: 'error', message: '被风控' }), { state: 'error', message: '被风控' });
    assert.deepEqual(toLoginState({ stage: 'waiting' }), { state: 'waiting' });
    assert.deepEqual(toLoginState(null), { state: 'waiting' });
});

test('分页：接口说到底时不再拿 total 硬撑（尾部有失效视频就无限转圈的老毛病）', async () => {
    // 100 首真实内容 + media_count 报 104：末 4 条是失效视频，接口第 5 页 has_more:false
    const raw = Array.from({ length: 100 }, (_, index) => ({ bvid: `BV${index}` }));
    const fetchPage = async (number) => {
        const start = (number - 1) * FOLDER_PAGE_SIZE;
        const items = raw.slice(start, start + FOLDER_PAGE_SIZE);
        return { items, total: 104, hasMore: start + items.length < raw.length };
    };

    let offset = 0;
    let cursor = 0;
    const seen = [];
    for (let round = 0; round < 8; round += 1) {
        const page = await readTrackRange({
            offset,
            limit: FOLDER_PAGE_SIZE,
            fetchPage,
            keep: (item) => Boolean(item.bvid),
        });
        seen.push(...page.items.map((item) => item.bvid));
        cursor = page.nextOffset;
        if (!page.hasMore) break;
        assert.notEqual(page.nextOffset, offset, 'hasMore 为真时游标必须前进，否则宿主原地打转');
        offset = page.nextOffset;
    }

    assert.equal(new Set(seen).size, 100, '100 首都要交付，且不重复');
    assert.equal(cursor, 100, '游标要走到末尾，不是停在 80');
});

test('分页：一页全被过滤掉就明确说「没有更多」', async () => {
    let calls = 0;
    const page = await readTrackRange({
        offset: 0,
        limit: 20,
        fetchPage: async (number) => {
            calls += 1;
            // 接口始终说还有下一页，但每一条都被 keep 挡掉
            return { items: Array.from({ length: 20 }, (_, i) => ({ bvid: `BV${number}-${i}`, long: true })), total: 9999, hasMore: true };
        },
        keep: (item) => !item.long,
    });
    assert.equal(page.items.length, 0);
    assert.equal(page.hasMore, false, '0 条还报 hasMore 就是死循环');
    assert.ok(calls <= 8, '最多翻到上限就停');
});

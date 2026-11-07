// 「我收藏的」列表：分类、去重、映射到宿主集合。全是纯函数，不联网。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    COLLECTED_FOLDER,
    COLLECTED_SEASON,
    buildLibrary,
    classifyCollected,
    parseCollected,
    readLibrarySources,
    resourceOf,
    mergeUnique,
    normalizeOwn,
    normalizeExtra,
    toCollection,
} from '../lib/collected.mjs';

const folder11 = {
    id: '1513762000', mid: '426949000', type: 11,
    title: '色差即坏苹果001宇宙', cover: 'https://i0.hdslb.com/a.jpg',
    owner: '某科学的FishHave', count: 138, state: 0,
};
const season21 = {
    id: '7422068', mid: '22331844', type: 21,
    title: '三体系列', cover: 'https://i0.hdslb.com/b.jpg',
    owner: '某UP', count: 12, state: 0,
};

test('type 11 是收藏的收藏夹，用完整 mlid 当 mediaId', () => {
    const raw = classifyCollected(folder11);
    assert.equal(raw.kind, 'folder');
    assert.equal(raw.key, COLLECTED_FOLDER + '1513762000');
    assert.equal(raw.mediaId, '1513762000');
    assert.equal(raw.name, '色差即坏苹果001宇宙');
    assert.equal(raw.count, 138);
    assert.equal(raw.cover, 'https://i0.hdslb.com/a.jpg');
    assert.equal(raw.owner, '某科学的FishHave');
    assert.equal(raw.source, 'collected');
});

test('type 21 是收藏的合集，要 mid + id 两个才能取曲目', () => {
    const raw = classifyCollected(season21);
    assert.equal(raw.kind, 'season');
    assert.equal(raw.key, COLLECTED_SEASON + '22331844-7422068');
    assert.equal(raw.mid, '22331844');
    assert.equal(raw.sid, '7422068');
});

test('失效项、音频、缺 id、合集缺 mid 都不收', () => {
    assert.equal(classifyCollected({ ...folder11, state: 1 }), null);
    assert.equal(classifyCollected({ ...folder11, type: 12 }), null);
    assert.equal(classifyCollected({ ...season21, id: '' }), null);
    assert.equal(classifyCollected({ ...season21, mid: '' }), null);
    assert.equal(classifyCollected(null), null);
    assert.equal(parseCollected([folder11, season21, { type: 12 }, null]).length, 2);
});

test('去重按真实资源算，跟 key 前缀无关', () => {
    const own = normalizeOwn({ id: '1513762000', title: '我的夹', count: 3, isDefault: true }, '我', '123', '');
    const extraFolder = normalizeExtra({ key: 'x-fav-1513762000', kind: 'folder', mediaId: '1513762000', name: '贴的夹' });
    const collectedFolder = classifyCollected(folder11);
    assert.equal(resourceOf(own), resourceOf(extraFolder));
    assert.equal(resourceOf(extraFolder), resourceOf(collectedFolder));

    const merged = mergeUnique([[own], [extraFolder], [collectedFolder]]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].source, 'own');
});

test('手贴的合集和账号收藏的同一个合集只留一条', () => {
    const extraSeason = normalizeExtra({
        key: 'x-season-22331844-7422068', kind: 'season', mid: '22331844', sid: '7422068', name: '三体系列',
    });
    const collectedSeason = classifyCollected(season21);
    const extrasSeries = normalizeExtra({
        key: 'x-series-22331844-402153', kind: 'series', mid: '22331844', sid: '402153', name: '另一个系列',
    });
    const merged = mergeUnique([[extraSeason, extrasSeries], [collectedSeason]]);
    assert.equal(merged.length, 2);
    assert.equal(merged[0].key, 'x-season-22331844-7422068');
    assert.equal(merged[1].kind, 'series');
});

test('收藏夹落到 playlist，合集与系列落到 album', () => {
    const pid = 'folium.bili-fav-wall.bili';
    const own = toCollection(normalizeOwn({ id: '1', title: '自建', count: 2, isDefault: true }, '我', '9', 'https://c.jpg'), pid);
    assert.equal(own.type, 'playlist');
    assert.equal(own.id, '1');
    assert.equal(own.isOwned, true);
    assert.equal(own.coverUrl, 'https://c.jpg');
    assert.deepEqual(own.creator, { id: '9', nickname: '我' });

    const season = toCollection(classifyCollected(season21), pid);
    assert.equal(season.type, 'album');
    assert.equal(season.trackCount, 12);
    assert.equal(season.coverUrl, 'https://i0.hdslb.com/b.jpg');

    const series = toCollection(normalizeExtra({ key: 'x-series-1-2', kind: 'series', mid: '1', sid: '2', name: '系列' }), pid);
    assert.equal(series.type, 'album');
    assert.equal(toCollection(null, pid), null);
});

test('三个来源合流：收藏夹进歌单、合集与系列进专辑，重复的只留一条', () => {
    const lib = buildLibrary({
        folders: [{ id: '100', title: '自建夹', count: 5, isDefault: true }],
        extras: [
            { key: 'x-fav-200', kind: 'folder', mediaId: '200', name: '贴的夹', count: 3 },
            { key: 'x-season-22331844-7422068', kind: 'season', mid: '22331844', sid: '7422068', name: '三体（贴的）', count: 12 },
            { key: 'x-series-22331844-402153', kind: 'series', mid: '22331844', sid: '402153', name: '系列', count: 4 },
        ],
        collected: parseCollected([
            { ...folder11, id: '200', mediaId: undefined },   // 和手贴的是同一个夹 → 丢掉
            season21,                                          // 和手贴的是同一个合集 → 丢掉
            { ...folder11, id: '300', title: '收藏的夹' },
            { ...season21, id: '999', title: '收藏的合集' },
        ]),
        covers: { 100: ['https://i0.hdslb.com/own.jpg'] },
        ownerName: '我',
        ownerId: '9',
    });

    assert.deepEqual(lib.playlists.map((raw) => raw.key), ['100', 'x-fav-200', 'c-fav-300']);
    assert.deepEqual(lib.albums.map((raw) => raw.key), [
        'x-season-22331844-7422068',
        'x-series-22331844-402153',
        'c-season-22331844-999',
    ]);
    assert.equal(lib.byKey.size, 6);
    assert.equal(lib.folders.length, 1);

    const pid = 'folium.bili-fav-wall.bili';
    assert.deepEqual(lib.playlists.map((raw) => toCollection(raw, pid).type), ['playlist', 'playlist', 'playlist']);
    assert.deepEqual(lib.albums.map((raw) => toCollection(raw, pid).type), ['album', 'album', 'album']);
    // 自建收藏夹的封面来自主进程的封面缓存
    assert.equal(lib.playlists[0].cover, 'https://i0.hdslb.com/own.jpg');
    // 取曲目要用的字段都在
    assert.equal(lib.byKey.get('c-fav-300').mediaId, '300');
    assert.equal(lib.byKey.get('c-season-22331844-999').sid, '999');
    assert.equal(lib.byKey.get('c-season-22331844-999').mid, '22331844');
});

test('三个来源都空时不炸，页签各给空数组', () => {
    const lib = buildLibrary();
    assert.deepEqual(lib.playlists, []);
    assert.deepEqual(lib.albums, []);
    assert.equal(lib.byKey.size, 0);
});

test('没登录时 folders 抛错，手贴列表和「我收藏的」照常进两个页签', async () => {
    const warnings = [];
    const sources = await readLibrarySources({
        folders: async () => { throw new Error('bili: 需要先登录才能读自己的收藏夹'); },
        extras: async () => [
            { key: 'x-fav-200', kind: 'folder', mediaId: '200', name: '贴的夹', count: 3 },
            { key: 'x-season-22331844-7422068', kind: 'season', mid: '22331844', sid: '7422068', name: '三体', count: 12 },
        ],
        collected: async () => parseCollected([folder11, { ...season21, id: '999' }]),
        onError: (error) => warnings.push(String(error && error.message)),
    });

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /需要先登录/);
    assert.deepEqual(sources.folders, { items: [], owner: '', mid: '' });

    const lib = buildLibrary({
        folders: sources.folders.items,
        extras: sources.extras,
        collected: sources.collected,
    });
    assert.deepEqual(lib.playlists.map((raw) => raw.key), ['x-fav-200', 'c-fav-1513762000']);
    assert.deepEqual(lib.albums.map((raw) => raw.key), [
        'x-season-22331844-7422068',
        'c-season-22331844-999',
    ]);
});

test('readLibrarySources 三个来源都正常时原样透传，不误报降级', async () => {
    const warnings = [];
    const sources = await readLibrarySources({
        folders: async () => ({ items: [{ id: '100', title: '自建夹', count: 5 }], owner: '我', mid: '9' }),
        extras: async () => [],
        collected: async () => [],
        onError: (error) => warnings.push(String(error)),
    });
    assert.deepEqual(warnings, []);
    assert.equal(sources.folders.owner, '我');
    assert.equal(sources.folders.items.length, 1);
});

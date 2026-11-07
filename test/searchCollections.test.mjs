// 0.7.26 新搜索页「专辑 / 歌单」两类结果的纯函数用例。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    matchesCollection,
    searchCollectionPage,
    collectCandidates,
    remoteSeasonRaw,
    remoteSeasonFromKey,
    hasLocalNameHit,
    WEB_SEASON_PREFIX,
} from '../lib/searchCollections.mjs';

const PID = 'folium.bili-fav-wall.bili';

const FOLDERS = [
    {
        key: '225458077', kind: 'folder', mediaId: '225458077', mid: '100',
        name: '默认收藏夹', count: 12, cover: 'cover-a.jpg', owner: '我自己', source: 'own',
    },
    {
        key: 'x-fav-337285064', kind: 'folder', mediaId: '337285064', mid: '200',
        name: 'ヨルシカ 精选', count: 8, cover: 'cover-b.jpg', owner: '某 UP 主', source: 'extra',
    },
];
const ALBUMS = [
    {
        key: 'c-season-1-2', kind: 'season', mid: '1', sid: '2',
        name: '初音未来 合辑', count: 20, cover: 'cover-c.jpg', owner: '初音社', source: 'collected',
    },
    {
        key: 'x-season-3-4', kind: 'series', mid: '3', sid: '4',
        name: 'VOCALOID Collection', count: 6, owner: 'VocaP', source: 'extra',
    },
];
const WEB_SEASON = {
    sid: '5482667', mid: '3493093607213343', name: '孙燕姿',
    cover: 'https://archive.biliimg.com/x.jpg', count: 15, owner: 'JLRS-LeoFM',
};

test('关键词命中名字 / UP 主，大小写不敏感', () => {
    assert.equal(matchesCollection(FOLDERS[1], 'ヨルシカ'), true);
    assert.equal(matchesCollection(FOLDERS[1], 'up 主'), true);
    assert.equal(matchesCollection(ALBUMS[1], 'vocaloid'), true);
    assert.equal(matchesCollection(FOLDERS[0], '初音'), false);
    // 空关键词 = 不过滤
    assert.equal(matchesCollection(FOLDERS[0], '  '), true);
});

test('空关键词返回全部，DTO 带上宿主要的 providerId / type / 封面', () => {
    const page = searchCollectionPage(FOLDERS, '', PID, 30, 0);
    assert.equal(page.total, 2);
    assert.equal(page.items.length, 2);
    assert.equal(page.hasMore, false);
    assert.equal(page.nextOffset, 2);
    for (const item of page.items) {
        assert.equal(item.providerId, PID);
        assert.equal(item.type, 'playlist');
        assert.ok(item.coverUrl);
        assert.ok(item.creator.nickname);
    }
    const albums = searchCollectionPage(ALBUMS, '', PID, 30, 0);
    assert.equal(albums.items.every((item) => item.type === 'album'), true);
});

test('关键词过滤 + 分页（关掉兜底），宿主拿 total 显示「共 N 条」', () => {
    const all = searchCollectionPage([...FOLDERS, ...ALBUMS], '合集', PID, 30, 0, null, { fallback: false });
    assert.equal(all.total, 0);
    assert.deepEqual(all.items, []);

    const page1 = searchCollectionPage([...FOLDERS, ...ALBUMS], '', PID, 2, 0);
    assert.equal(page1.items.length, 2);
    assert.equal(page1.total, 4);
    assert.equal(page1.hasMore, true);
    assert.equal(page1.nextOffset, 2);
    const page2 = searchCollectionPage([...FOLDERS, ...ALBUMS], '', PID, 2, page1.nextOffset);
    assert.equal(page2.items.length, 2);
    assert.equal(page2.hasMore, false);
    assert.equal(page2.nextOffset, 4);
    assert.equal(page1.items[0].id === page2.items[0].id, false);
});

test('设置里排除掉的收藏夹不会出现在搜索结果里', () => {
    const hidden = new Set(['fav:225458077']);
    const page = searchCollectionPage(FOLDERS, '', PID, 30, 0, hidden);
    assert.equal(page.total, 1);
    assert.equal(page.items[0].id, 'x-fav-337285064');
    // 合集的键是 season:mid:sid，不会被收藏夹的排除键误伤
    const albums = searchCollectionPage(ALBUMS, '', PID, 30, 0, hidden);
    assert.equal(albums.total, 2);
});

// ------------------------------------------------------------------ 0.7.8

test('0.7.8：合集排除只挡已接入的本地合集，全站反查结果照常出现', () => {
    const hidden = new Set(['season:1:2']);
    const page = searchCollectionPage(ALBUMS, '', PID, 30, 0, hidden, { remote: [WEB_SEASON] });
    const ids = page.items.map((item) => item.id);
    assert.equal(ids.includes('c-season-1-2'), false, '勾掉的那张不进结果');
    assert.equal(ids.includes('x-season-3-4'), true, '没勾的还在');
    assert.equal(ids.includes(`${WEB_SEASON_PREFIX}3493093607213343-5482667`), true, '全站反查不受排除影响');

    // 被排除的合集不能再算「本地名字命中」，否则会跳过全站反查
    assert.equal(hasLocalNameHit(ALBUMS, '初音未来', hidden), false);
    // 收藏夹那一页读的是另一份设置，不受这份黑名单影响
    assert.equal(searchCollectionPage(FOLDERS, '', PID, 30, 0, hidden).total, 2);
});

test('坏输入安静降级：不是数组 / 越界 offset / 非法 limit', () => {
    assert.deepEqual(searchCollectionPage(null, '', PID, 30, 0), {
        items: [], total: 0, hasMore: false, nextOffset: 0,
    });
    const page = searchCollectionPage(FOLDERS, '', PID, 0, 999);
    assert.equal(page.items.length, 0);
    assert.equal(page.hasMore, false);
    assert.equal(page.nextOffset, 999);
});

// ------------------------------------------------------------------ 0.7.4

test('全站合集元信息 → 自包含 id 的 raw，坏元信息直接丢掉', () => {
    const raw = remoteSeasonRaw(WEB_SEASON);
    assert.equal(raw.key, `${WEB_SEASON_PREFIX}3493093607213343-5482667`);
    assert.equal(raw.kind, 'season');
    assert.equal(raw.mid, '3493093607213343');
    assert.equal(raw.sid, '5482667');
    assert.equal(raw.name, '孙燕姿');
    assert.equal(raw.count, 15);
    assert.equal(remoteSeasonRaw({ sid: 'x', mid: '1' }), null);
    assert.equal(remoteSeasonRaw(null), null);
});

test('自包含 id 能反解出 mid / sid，普通键返回 null', () => {
    const raw = remoteSeasonRaw(WEB_SEASON);
    assert.deepEqual(remoteSeasonFromKey(raw.key), {
        key: raw.key, kind: 'season', mid: raw.mid, sid: raw.sid,
        name: '', count: 0, cover: '', owner: '', source: 'web',
    });
    assert.equal(remoteSeasonFromKey('x-season-3-4'), null);
    assert.equal(remoteSeasonFromKey('w-season-a-b'), null);
    assert.equal(remoteSeasonFromKey(null), null);
});

test('搜歌名时全站合集进结果，卡片带副标题说明来源', () => {
    const page = searchCollectionPage(ALBUMS, '风衣', PID, 30, 0, null, {
        remote: [WEB_SEASON],
    });
    assert.equal(page.total, 1);
    assert.equal(page.items[0].id, `${WEB_SEASON_PREFIX}3493093607213343-5482667`);
    assert.equal(page.items[0].type, 'album');
    assert.equal(page.items[0].name, '孙燕姿');
    assert.equal(page.items[0].trackCount, 15);
    assert.equal(page.items[0].coverUrl, WEB_SEASON.cover);
    assert.deepEqual(page.items[0].artists, [{ name: 'bilibili 合集' }]);
});

test('全站合集和本地同一个合集按真实资源键去重，不重复出卡', () => {
    const remote = remoteSeasonRaw({ sid: '2', mid: '1', name: '初音未来 合辑（全网版）', count: 20 });
    const page = searchCollectionPage(ALBUMS, '初音', PID, 30, 0, null, { remote: [remote] });
    assert.equal(page.total, 1);
    assert.equal(page.items[0].id, 'c-season-1-2', '本地那张优先，全站同资源不重复');
});

test('收藏夹内视频命中关键词：只把命中的夹子排进结果', () => {
    const page = searchCollectionPage(FOLDERS, '风衣', PID, 30, 0, null, {
        contentKeys: new Set(['225458077']),
    });
    assert.equal(page.total, 1);
    assert.equal(page.items[0].id, '225458077');
    assert.equal(page.items[0].creator.nickname, '包含《风衣》');
});

test('名字命中优先于内容命中，同一个夹子不出现两次', () => {
    const { hits } = collectCandidates({
        list: FOLDERS, query: '默认', excluded: null,
        contentKeys: new Set(['225458077']),
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].key, '225458077');
    assert.equal(hits[0].matchReason, undefined);
});

test('三层都没命中 → 兜底列出全部已接入列表，不再空白', () => {
    const { hits, usedFallback } = collectCandidates({
        list: FOLDERS, query: '风衣', excluded: null, remote: [], contentKeys: null,
    });
    assert.equal(usedFallback, true);
    assert.equal(hits.length, 2);
    const page = searchCollectionPage(FOLDERS, '风衣', PID, 30, 0);
    assert.equal(page.total, 2);
    assert.equal(page.items[0].id, '225458077');
});

test('兜底也遵守排除设置，且能显式关掉', () => {
    const hidden = new Set(['fav:225458077']);
    const page = searchCollectionPage(FOLDERS, '风衣', PID, 30, 0, hidden);
    assert.equal(page.total, 1);
    assert.equal(page.items[0].id, 'x-fav-337285064');
    const off = searchCollectionPage(FOLDERS, '风衣', PID, 30, 0, null, { fallback: false });
    assert.equal(off.total, 0);
});

test('本地名字已命中就跳过全站反查，没命中才去查', () => {
    assert.equal(hasLocalNameHit(ALBUMS, '初音', null), true);
    assert.equal(hasLocalNameHit(ALBUMS, '风衣', null), false);
    // 被排除掉的那张不算命中
    assert.equal(hasLocalNameHit(ALBUMS, '初音', new Set(['season:1:2'])), false);
    // 空关键词 = 全命中，也不会去查全站
    assert.equal(hasLocalNameHit(ALBUMS, '', null), true);
    assert.equal(hasLocalNameHit(null, '风衣', null), false);
});

test('空关键词不触发兜底，也不加全站结果', () => {
    const { usedFallback } = collectCandidates({ list: FOLDERS, query: '', excluded: null });
    assert.equal(usedFallback, false);
});

// 排除列表：纯函数层。设置面板写入、宿主取列表时读出，都得对得上。

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLibrary, classifyCollected, normalizeExtra, normalizeOwn, resourceOf } from '../lib/collected.mjs';
import {
    excludeCollections, excludedForKind, isExcluded, isVisible,
    parseExcluded, serializeExcluded, visibilityForKind,
} from '../lib/exclude.mjs';

const own = normalizeOwn({ id: '1001', title: '默认收藏夹', count: 3, isDefault: true }, '我', '1', '');
const manual = normalizeExtra({
    key: 'x-fav-1001', kind: 'folder', mediaId: '1001', mid: '9', name: '手贴的同一个夹子', count: 3, owner: '别人',
});
const collected = classifyCollected({
    id: '1001', mid: '9', type: 11, title: '我收藏的同一个夹子', count: 3, cover: '', owner: '别人', state: 0,
});
const season = classifyCollected({
    id: '7422068', mid: '22331844', type: 21, title: '三体系列', count: 12, cover: '', owner: 'UP', state: 0,
});

test('空设置值就是空集合，不会把 undefined 当成键', () => {
    for (const value of [undefined, null, '', '   ', []]) {
        assert.equal(parseExcluded(value).size, 0);
    }
});

test('一行一个键 / 逗号分号 / JSON 数组 / Set / 数组都能读', () => {
    assert.deepEqual([...parseExcluded('fav:1\nfav:2')], ['fav:1', 'fav:2']);
    assert.deepEqual([...parseExcluded('fav:1, fav:2;fav:3')], ['fav:1', 'fav:2', 'fav:3']);
    assert.deepEqual([...parseExcluded('["fav:1","fav:2"]')], ['fav:1', 'fav:2']);
    assert.deepEqual([...parseExcluded(new Set(['fav:1']))], ['fav:1']);
    assert.deepEqual([...parseExcluded(['fav:1', 'fav:1'])], ['fav:1']);
    assert.deepEqual([...parseExcluded('["坏的 JSON')], ['["坏的 JSON']);
});

test('写回设置是排序去重的纯文本，同样的勾选永远同一个字符串', () => {
    assert.equal(serializeExcluded(new Set(['fav:9', 'fav:1', 'fav:9'])), 'fav:1\nfav:9');
    assert.equal(parseExcluded(serializeExcluded(new Set(['fav:1']))).has('fav:1'), true);
    assert.equal(serializeExcluded(new Set()), '');
});

test('三个来源指向同一个夹子时，一个真实资源键就全挡住', () => {
    assert.equal(resourceOf(own), 'fav:1001');
    assert.equal(resourceOf(manual), 'fav:1001');
    assert.equal(resourceOf(collected), 'fav:1001');
    const hidden = parseExcluded('fav:1001');
    assert.equal(excludeCollections([own, manual, collected], hidden).length, 0);
    assert.equal(isExcluded(season, hidden), false, '合集有独立的键，不该被误排除');
});

test('没勾任何东西时返回原数组，不制造无谓的复制', () => {
    const list = [own, season];
    assert.equal(excludeCollections(list, ''), list);
    assert.equal(excludeCollections(list, new Set()), list);
});

test('buildLibrary 保持全量，宿主取列表时才过滤', () => {
    const lib = buildLibrary({
        folders: [{ id: '1001', title: '默认收藏夹', count: 3, isDefault: true }, { id: '1002', title: '音乐', count: 10 }],
        extras: [{ key: 'x-season-1-2', kind: 'season', mid: '1', sid: '2', name: '手贴合集', count: 5 }],
        collected: [season],
        covers: {},
        ownerName: '我',
        ownerId: '1',
    });
    assert.equal(lib.playlists.length, 2);
    assert.equal(lib.albums.length, 2);
    const hidden = parseExcluded(serializeExcluded(new Set([resourceOf(lib.playlists[0])])));
    const visible = excludeCollections(lib.playlists, hidden);
    assert.equal(visible.length, 1);
    assert.equal(visible[0].name, '音乐');
    assert.equal(lib.playlists.length, 2, '快照本身仍是全量，设置面板才能列出已排除项供取消');
    assert.equal(lib.byKey.size, 4, '取曲目的索引也不该被排除掉');
});

test('合集的键是 kind:mid:sid，和收藏夹不会撞', () => {
    assert.equal(resourceOf(season), 'season:22331844:7422068');
    assert.equal(excludeCollections([season], 'season:22331844:7422068').length, 0);
    assert.equal(excludeCollections([season], 'fav:7422068').length, 1);
});

// ------------------------------------------------------------------ 0.7.8

test('0.7.8：收藏夹和合集各读各的那份设置，勾一边不误伤另一边', () => {
    const values = {
        excludedFolders: 'fav:1001',
        excludedAlbums: 'season:22331844:7422068',
    };
    const folders = excludedForKind(values, 'playlist');
    const albums = excludedForKind(values, 'album');
    assert.equal(isExcluded(own, folders), true);
    assert.equal(isExcluded(season, folders), false);
    assert.equal(isExcluded(own, albums), false);
    assert.equal(isExcluded(season, albums), true);
    // 没勾合集的旧配置（升级上来只有 excludedFolders）不能把 44 张合集全挡掉
    assert.equal(excludedForKind({ excludedFolders: 'fav:1001' }, 'album').size, 0);
    assert.equal(excludedForKind(null, 'album').size, 0);
});

// ------------------------------------------------------------------ 0.8.4

test('0.8.4：默认仍是黑名单，老配置一个字不用改', () => {
    const view = visibilityForKind({ excludedFolders: 'fav:1001' }, 'playlist');
    assert.equal(view.mode, 'hide');
    assert.deepEqual([...view.hide], ['fav:1001']);
    // 自建和手贴指向同一个夹子，一条键就把两张卡都挡住
    assert.equal(excludeCollections([own, manual], view).length, 0);
    const other = normalizeOwn({ id: '2002', title: '另一个夹子', count: 1 }, '我', '1', '');
    assert.deepEqual(excludeCollections([own, other], view).map((raw) => raw.key), [other.key]);
});

test('0.8.4：白名单只留下勾选的，键用的是同一套真实资源键', () => {
    // 自建和手贴指向同一个夹子（fav:1001），勾它两处都该出现
    const view = visibilityForKind({ pickerMode: 'allow', visibleFolders: 'fav:1001' }, 'playlist');
    assert.equal(view.mode, 'allow');
    const kept = excludeCollections([own, manual, season], view);
    assert.deepEqual(kept.map((raw) => raw.key), [own.key, manual.key]);
    assert.equal(isVisible(season, view), false);
});

test('0.8.4：白名单空着回落成全部显示，刚切模式不会把墙清空', () => {
    const view = visibilityForKind({ pickerMode: 'allow' }, 'playlist');
    assert.equal(view.allow.size, 0);
    assert.equal(excludeCollections([own, manual], view).length, 2);
    assert.equal(isVisible(own, view), true);
});

test('0.8.4：两种模式各存一份，来回切换不丢勾选', () => {
    const values = {
        pickerMode: 'hide',
        excludedFolders: 'fav:1001',
        visibleFolders: 'fav:2002',
    };
    const hide = visibilityForKind(values, 'playlist');
    assert.equal(excludeCollections([own], hide).length, 0);
    const allow = visibilityForKind({ ...values, pickerMode: 'allow' }, 'playlist');
    assert.equal(excludeCollections([own], allow).length, 0, '白名单里没有它，就不该出现');
    assert.equal(allow.hide.size, 1, '黑名单原封不动留着');
    assert.equal(allow.allow.has('fav:2002'), true);
});

test('0.8.4：合集有自己的一对黑白名单，和收藏夹互不影响', () => {
    const view = visibilityForKind({ pickerMode: 'allow', visibleAlbums: 'season:22331844:7422068' }, 'album');
    assert.equal(excludeCollections([season], view).length, 1);
    assert.equal(excludeCollections([own], view).length, 0);
    const folders = visibilityForKind({ pickerMode: 'allow', visibleAlbums: 'season:22331844:7422068' }, 'playlist');
    assert.equal(folders.allow.size, 0, '合集的白名单不该串到收藏夹');
});

// ------------------------------------------------------------------ 0.8.6

test('0.8.6：收藏夹和合集的筛选方式各管各的', () => {
    // 合集没单独选过（albumPickerMode 空）= 跟收藏夹走，老配置升级上来不会突变。
    const inherit = { pickerMode: 'allow', visibleFolders: 'fav:1001' };
    assert.equal(visibilityForKind(inherit, 'playlist').mode, 'allow');
    assert.equal(visibilityForKind(inherit, 'album').mode, 'allow');

    // 合集自己选过之后就跟收藏夹分开：收藏夹白名单，合集黑名单。
    const split = {
        pickerMode: 'allow',
        visibleFolders: 'fav:1001',
        albumPickerMode: 'hide',
        excludedAlbums: 'season:22331844:7422068',
    };
    assert.equal(visibilityForKind(split, 'playlist').mode, 'allow');
    assert.equal(visibilityForKind(split, 'album').mode, 'hide');
    // 合集走黑名单：勾掉的那个合集消失，收藏夹那些条目不受影响。
    assert.equal(excludeCollections([season], visibilityForKind(split, 'album')).length, 0);
    // 收藏夹走白名单：只留勾上的那一个。
    assert.deepEqual(
        excludeCollections([own, manual], visibilityForKind(split, 'playlist')).map((raw) => raw.key),
        [own.key, manual.key],
    );
    assert.equal(excludeCollections([own, manual, season], visibilityForKind(split, 'album')).length, 2);
});

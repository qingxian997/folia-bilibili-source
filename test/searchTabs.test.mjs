// 0.7.26 搜索页改名串台回归：
// 书库墙当前音源和搜索页当前音源是两套状态，必须各自判定。

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { activeSearchSourceLabel, searchContextOf, createBiliTabPredicate } from '../lib/searchTabs.mjs';
import { createTabRelabel } from '../lib/tabLabel.mjs';

const PID = 'folium.bili-fav-wall.bili';

function page(activeSource = 'bilibili') {
    const dom = new JSDOM(
        '<!doctype html><html lang="zh-CN"><body>' +
        '<nav class="home-tabs">' +
        '<button class="home-tab wall-playlists">歌单</button>' +
        '<button class="home-tab wall-albums">专辑</button>' +
        '</nav>' +
        '<div class="search-overlay">' +
        '<nav class="search-sources">' +
        `<button class="search-source" ${activeSource === 'bilibili' ? 'aria-current="true"' : ''}>bilibili</button>` +
        `<button class="search-source" ${activeSource === '网易云' ? 'aria-current="true"' : ''}>网易云</button>` +
        '</nav>' +
        '<div class="search-kinds" role="tablist">' +
        '<button class="search-kind" role="tab"><span class="search-kind-label">单曲</span></button>' +
        '<button class="search-kind" role="tab"><span class="search-kind-label">专辑</span></button>' +
        '<button class="search-kind" role="tab"><span class="search-kind-label">歌单</span></button>' +
        '</div>' +
        '<div class="search-list"><span class="search-row-sub">专辑 · 12 首</span></div>' +
        '</div>' +
        '</body></html>',
        { pretendToBeVisual: true },
    );
    return dom;
}

const text = (dom, selector) => dom.window.document.querySelector(selector).textContent;
const wall = (dom) => [text(dom, '.wall-playlists'), text(dom, '.wall-albums')];
const kinds = (dom) => [...dom.window.document.querySelectorAll('.search-kind-label')].map((el) => el.textContent);

function switchSource(dom, label) {
    for (const button of dom.window.document.querySelectorAll('.search-source')) {
        if (button.textContent.trim() === label) button.setAttribute('aria-current', 'true');
        else button.removeAttribute('aria-current');
    }
}

test('读得到搜索页当前选中的音源，读不到就返回空串', () => {
    const dom = page('bilibili');
    assert.equal(activeSearchSourceLabel(dom.window.document), 'bilibili');
    switchSource(dom, '网易云');
    assert.equal(activeSearchSourceLabel(dom.window.document), '网易云');
    assert.equal(activeSearchSourceLabel(null), '');
});

test('节点语境：分类大标题 / 搜索页其它位置 / 书库墙', () => {
    const dom = page();
    const doc = dom.window.document;
    const kindNode = doc.querySelector('.search-kind-label').firstChild;
    const rowNode = doc.querySelector('.search-row-sub').firstChild;
    const wallNode = doc.querySelector('.wall-albums').firstChild;
    assert.equal(searchContextOf(kindNode), 'kinds');
    assert.equal(searchContextOf(rowNode), 'other');
    assert.equal(searchContextOf(wallNode), 'wall');
});

test('逐节点判定：搜索页选中 bilibili 时只放行分类标题', () => {
    const dom = page('bilibili');
    const doc = dom.window.document;
    const isActive = createBiliTabPredicate({
        document: doc,
        providerLabel: 'bilibili',
        providerId: PID,
        isWallActive: () => false,
    });
    assert.equal(isActive(doc.querySelector('.search-kind-label').firstChild), true);
    assert.equal(isActive(doc.querySelector('.wall-albums').firstChild), false);
    assert.equal(isActive(doc.querySelector('.search-row-sub').firstChild), false);
    switchSource(dom, '网易云');
    assert.equal(isActive(doc.querySelector('.search-kind-label').firstChild), false);
});

test('截图里的 bug：书库墙停在 bilibili、搜索页切到网易云，网易云仍显示「专辑 / 歌单」', () => {
    const dom = page('网易云');
    const relabel = createTabRelabel({
        document: dom.window.document,
        isActive: createBiliTabPredicate({
            document: dom.window.document,
            providerLabel: 'bilibili',
            providerId: PID,
            isWallActive: () => true,
        }),
    });
    relabel.start();
    assert.deepEqual(wall(dom), ['收藏', '合集'], '书库墙是 bilibili，该改');
    assert.deepEqual(kinds(dom), ['单曲', '专辑', '歌单'], '搜索页是网易云，一个字都不许改');
    assert.equal(text(dom, '.search-row-sub'), '专辑 · 12 首');
    relabel.stop();
});

test('反过来：书库墙是网易云、搜索页选中 bilibili，只改搜索页', () => {
    const dom = page('bilibili');
    const relabel = createTabRelabel({
        document: dom.window.document,
        isActive: createBiliTabPredicate({
            document: dom.window.document,
            providerLabel: 'bilibili',
            providerId: PID,
            isWallActive: () => false,
        }),
    });
    relabel.start();
    assert.deepEqual(wall(dom), ['歌单', '专辑']);
    assert.deepEqual(kinds(dom), ['单曲', '合集', '收藏']);
    relabel.stop();
});

test('搜索页里切走音源，已经改过的分类立刻还原', () => {
    const dom = page('bilibili');
    let wallActive = false;
    const relabel = createTabRelabel({
        document: dom.window.document,
        isActive: createBiliTabPredicate({
            document: dom.window.document,
            providerLabel: 'bilibili',
            providerId: PID,
            isWallActive: () => wallActive,
        }),
    });
    relabel.start();
    assert.deepEqual(kinds(dom), ['单曲', '合集', '收藏']);
    switchSource(dom, '网易云');
    relabel.tick();
    assert.deepEqual(kinds(dom), ['单曲', '专辑', '歌单']);
    wallActive = true;
    relabel.tick();
    assert.deepEqual(wall(dom), ['收藏', '合集']);
    assert.deepEqual(kinds(dom), ['单曲', '专辑', '歌单']);
    relabel.stop();
    assert.deepEqual(wall(dom), ['歌单', '专辑']);
});

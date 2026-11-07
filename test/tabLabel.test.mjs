// 胶囊的条件改名：只在 bilibili 是当前音源时，「歌单→收藏」「专辑→合集」；
// 切到别的平台一个字都不许改，已经改错的也要修回来。

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { createTabRelabel } from '../lib/tabLabel.mjs';

function page() {
    return new JSDOM(
        '<!doctype html><html lang="zh-CN"><body>' +
        '<nav><button class="home-tab is-active"><span>专辑</span></button>' +
        '<button class="home-tab playlists">歌单</button>' +
        '<button class="home-tab en">Albums</button>' +
        '<button class="home-tab en-playlists">Playlists</button></nav>' +
        '<div class="card-badge">专辑 · 12 首</div>' +
        '<div class="plain">专辑</div>' +
        '</body></html>',
        { pretendToBeVisual: true },
    );
}

const label = (dom) => dom.window.document.querySelector('button.home-tab.is-active span').textContent;
const playlists = (dom) => dom.window.document.querySelector('button.home-tab.playlists').textContent;
const enLabel = (dom) => dom.window.document.querySelector('button.home-tab.en').textContent;
const enPlaylists = (dom) => dom.window.document.querySelector('button.home-tab.en-playlists').textContent;

test('bilibili 是当前音源时，四个胶囊一起改，其它文字不动', () => {
    const dom = page();
    const relabel = createTabRelabel({ document: dom.window.document, isActive: () => true });
    relabel.start();
    assert.equal(label(dom), '合集');
    assert.equal(playlists(dom), '收藏');
    assert.equal(enLabel(dom), 'Collections');
    assert.equal(enPlaylists(dom), 'Favorites');
    // 卡片角标和页面里其它「专辑」不能误伤
    assert.equal(dom.window.document.querySelector('.card-badge').textContent, '专辑 · 12 首');
    assert.equal(dom.window.document.querySelector('.plain').textContent, '专辑');
    relabel.stop();
});

test('其它平台（isActive=false）从头到尾一个字都不改', () => {
    const dom = page();
    const relabel = createTabRelabel({ document: dom.window.document, isActive: () => false });
    relabel.start();
    assert.equal(label(dom), '专辑');
    assert.equal(playlists(dom), '歌单');
    assert.equal(enLabel(dom), 'Albums');
    assert.equal(enPlaylists(dom), 'Playlists');
    assert.equal(relabel.changed, 0);
    relabel.stop();
});

test('切到别的音源立刻还原成「专辑 / 歌单」', () => {
    const dom = page();
    let active = true;
    const relabel = createTabRelabel({ document: dom.window.document, isActive: () => active });
    relabel.start();
    assert.equal(label(dom), '合集');
    active = false;
    relabel.tick();
    assert.equal(label(dom), '专辑');
    assert.equal(playlists(dom), '歌单');
    assert.equal(enLabel(dom), 'Albums');
    assert.equal(enPlaylists(dom), 'Playlists');
    relabel.stop();
});

test('宿主复用同一个文本节点、又写回「合集」时，切走仍能修回来', () => {
    const dom = page();
    let active = true;
    const relabel = createTabRelabel({ document: dom.window.document, isActive: () => active });
    relabel.start();
    const node = dom.window.document.querySelector('button.home-tab.is-active span').firstChild;
    // React 常常复用文本节点：宿主以为文字没变，不会重绘，于是「合集」粘在别的平台上。
    node.nodeValue = '合集';
    active = false;
    relabel.tick();
    assert.equal(label(dom), '专辑');
    relabel.stop();
});

test('卸载后没有残留，改过的节点全部还原', () => {
    const dom = page();
    const relabel = createTabRelabel({ document: dom.window.document, isActive: () => true });
    relabel.start();
    assert.equal(relabel.changed > 0, true);
    relabel.stop();
    assert.equal(label(dom), '专辑');
    assert.equal(playlists(dom), '歌单');
    assert.equal(relabel.changed, 0);
});

test('自定义词表能只改中文', () => {
    const dom = page();
    const relabel = createTabRelabel({
        document: dom.window.document,
        isActive: () => true,
        map: { 专辑: '合集' },
    });
    relabel.start();
    assert.equal(label(dom), '合集');
    assert.equal(playlists(dom), '歌单');
    assert.equal(enLabel(dom), 'Albums');
    relabel.stop();
});

test('isActive 可以逐节点判定：同一个页面里一部分改、一部分不改', () => {
    const dom = page();
    const relabel = createTabRelabel({
        document: dom.window.document,
        // 只放行「专辑」那颗胶囊，其它节点一律保持宿主原文。
        // 判定要看 DOM 结构，不能看 nodeValue——改名之后文本已经不是原文了。
        isActive: (node) => {
            const button = node.parentElement.closest('button');
            return Boolean(button && button.classList.contains('is-active'));
        },
    });
    relabel.start();
    assert.equal(label(dom), '合集');
    assert.equal(playlists(dom), '歌单');
    assert.equal(enLabel(dom), 'Albums');
    relabel.stop();
});

test('逐节点判定变假后只还原那一颗，其余胶囊仍保持改名', () => {
    const dom = page();
    let albumAllowed = true;
    const relabel = createTabRelabel({
        document: dom.window.document,
        isActive: (node) => {
            const button = node.parentElement.closest('button');
            if (button && button.classList.contains('en-playlists')) return true;
            return albumAllowed;
        },
    });
    relabel.start();
    assert.equal(label(dom), '合集');
    assert.equal(enPlaylists(dom), 'Favorites');
    albumAllowed = false;
    relabel.tick();
    assert.equal(label(dom), '专辑');
    assert.equal(playlists(dom), '歌单');
    assert.equal(enLabel(dom), 'Albums');
    assert.equal(enPlaylists(dom), 'Favorites');
    relabel.stop();
});

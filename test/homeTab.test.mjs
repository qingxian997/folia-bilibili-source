// 只在 bilibili 是当前音源时隐藏宿主首页的「推荐」胶囊；切走 / 卸载必须原样还原。
// 宿主两套首页 DOM（Bravais 书库缝 / Grid 首页）都在用例里各造一份。

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import {
    createHomeTabHider, radioTabNodes, fallbackTab,
    RADIO_TAB_KEY, HOME_TAB_STORAGE_KEY,
} from '../lib/homeTab.mjs';

function bravais() {
    return new JSDOM(
        '<!doctype html><html lang="zh-CN"><body>' +
        '<div role="tablist" class="bravais-seam-tabs">' +
        '<button data-bravais-tab="playlist" class="bravais-seam-home-tab">收藏</button>' +
        '<button data-bravais-tab="radio" aria-selected="true" class="bravais-seam-home-tab is-active">推荐</button>' +
        '<button data-bravais-tab="explore" class="bravais-seam-home-tab">探索</button>' +
        '<button data-bravais-tab="albums" class="bravais-seam-home-tab">合集</button>' +
        '</div>' +
        // 设置页里的开关文案一样，但不是首页胶囊，绝不能被藏掉
        '<div class="settings"><button class="settings-toggle">显示推荐</button>' +
        '<button class="settings-toggle">推荐</button></div>' +
        '</body></html>',
        { pretendToBeVisual: true, url: 'http://localhost/' },
    );
}

function grid() {
    return new JSDOM(
        '<!doctype html><html lang="en"><body>' +
        '<div class="inline-flex items-center gap-0">' +
        '<span title="Playlists"><button aria-label="Playlists"><span>Playlists</span></button></span>' +
        '<span title="Radio"><button aria-label="Radio"><span>Radio</span></button></span>' +
        '<span title="Explore"><button aria-label="Explore"><span>Explore</span></button></span>' +
        '<span title="Albums"><button aria-label="Albums"><span>Albums</span></button></span>' +
        '</div>' +
        '<div class="card"><button aria-label="Radio">Radio</button></div>' +
        '</body></html>',
        { pretendToBeVisual: true, url: 'http://localhost/' },
    );
}

test('Bravais：data-bravais-tab="radio" 精确命中，其它胶囊和设置项不动', () => {
    const dom = bravais();
    const doc = dom.window.document;
    const found = radioTabNodes(doc);
    assert.equal(found.length, 1);
    assert.equal(found[0].getAttribute('data-bravais-tab'), RADIO_TAB_KEY);

    const hider = createHomeTabHider({ document: doc, isActive: () => true, currentTab: () => 'playlist' });
    hider.start();
    assert.equal(found[0].style.display, 'none');
    assert.equal(doc.querySelector('[data-bravais-tab="playlist"]').style.display, '');
    assert.equal(doc.querySelector('.settings-toggle').style.display, '');
    hider.stop();
});

test('Grid 首页没有 data 属性时按「正文 + 同排兄弟」命中，孤立按钮不误伤', () => {
    const dom = grid();
    const doc = dom.window.document;
    const found = radioTabNodes(doc);
    assert.equal(found.length, 1);
    assert.equal(found[0].textContent.trim(), 'Radio');
    assert.equal(doc.querySelector('.card button').textContent.trim(), 'Radio');
    assert.equal(found[0].closest('span').getAttribute('title'), 'Radio');

    const hider = createHomeTabHider({ document: doc, isActive: () => true, currentTab: () => 'playlist' });
    hider.start();
    assert.equal(found[0].style.display, 'none');
    assert.equal(doc.querySelector('.card button').style.display, '');
    hider.stop();
});

test('其它音源一个胶囊都不藏；切走之后已藏的立刻还原', () => {
    const dom = bravais();
    const doc = dom.window.document;
    let active = false;
    const hider = createHomeTabHider({ document: doc, isActive: () => active, currentTab: () => 'playlist' });
    hider.start();
    assert.equal(hider.hiddenCount, 0);
    active = true;
    hider.tick();
    assert.equal(hider.hiddenCount, 1);
    active = false;
    hider.tick();
    assert.equal(hider.hiddenCount, 0);
    assert.equal(doc.querySelector('[data-bravais-tab="radio"]').style.display, '');
    hider.stop();
});

test('当前正停在「推荐」时顺手切到「收藏」，别留在没有页签的空白页', () => {
    const dom = bravais();
    const doc = dom.window.document;
    let clicked = 0;
    doc.querySelector('[data-bravais-tab="playlist"]').addEventListener('click', () => { clicked += 1; });
    const hider = createHomeTabHider({ document: doc, isActive: () => true, currentTab: () => 'radio' });
    hider.start();
    assert.equal(clicked, 1);
    assert.equal(fallbackTab(doc, doc.querySelector('[data-bravais-tab="radio"]')).getAttribute('data-bravais-tab'), 'playlist');
    hider.stop();
});

test('currentTab 不传时读宿主的 last_home_view_tab', () => {
    const dom = bravais();
    const doc = dom.window.document;
    dom.window.localStorage.setItem(HOME_TAB_STORAGE_KEY, 'radio');
    let clicked = 0;
    doc.querySelector('[data-bravais-tab="playlist"]').addEventListener('click', () => { clicked += 1; });
    const hider = createHomeTabHider({ document: doc, isActive: () => true });
    hider.start();
    assert.equal(clicked, 1);
    hider.stop();
});

test('宿主重绘换掉按钮后，旧记录被丢弃、新按钮照样藏起来', () => {
    const dom = bravais();
    const doc = dom.window.document;
    const hider = createHomeTabHider({ document: doc, isActive: () => true, currentTab: () => 'playlist' });
    hider.start();
    const old = doc.querySelector('[data-bravais-tab="radio"]');
    const fresh = old.cloneNode(true);
    // React 重绘出来的是干净节点，不会继承我们写在旧节点上的 inline style。
    fresh.style.display = '';
    old.replaceWith(fresh);
    hider.tick();
    assert.equal(hider.hiddenCount, 1);
    assert.equal(fresh.style.display, 'none');
    hider.stop();
    assert.equal(fresh.style.display, '');
});

test('0.8.1 真机回归：重绘把 inline display:none 带到新节点，切到别的音源也要还原', () => {
    const dom = bravais();
    const doc = dom.window.document;
    let active = true;
    const hider = createHomeTabHider({ document: doc, isActive: () => active, currentTab: () => 'playlist' });
    hider.start();
    const old = doc.querySelector('[data-bravais-tab="radio"]');
    // 宿主切音源时的重绘会复用 / 克隆节点：inline style 带过来了，自定义 JS 属性没带来。
    const fresh = old.cloneNode(true);
    old.replaceWith(fresh);
    assert.equal(fresh.style.display, 'none');
    assert.equal(Boolean(fresh.__biliHomeTabHidden), false);

    active = false;
    hider.tick();
    assert.equal(fresh.style.display, '', '切到别的音源，推荐页签必须回来');
    assert.equal(doc.querySelector('.settings-toggle').style.display, '');
    hider.stop();
});

test('0.8.1：重绘残留的 none 不会被记成原值，来回切音源不死锁', () => {
    const dom = bravais();
    const doc = dom.window.document;
    let active = true;
    const hider = createHomeTabHider({ document: doc, isActive: () => active, currentTab: () => 'playlist' });
    hider.start();
    const old = doc.querySelector('[data-bravais-tab="radio"]');
    const fresh = old.cloneNode(true);
    old.replaceWith(fresh);

    active = true;
    hider.tick(); // 还在 bilibili：重新藏，此时 inline 已经是 none
    assert.equal(fresh.style.display, 'none');
    active = false;
    hider.tick(); // 切走：不能把 none 当「原值」写回去
    assert.equal(fresh.style.display, '');
    hider.stop();
});

test('卸载后没有残留：所有 display 都还原', () => {
    const dom = bravais();
    const doc = dom.window.document;
    const hider = createHomeTabHider({ document: doc, isActive: () => true, currentTab: () => 'playlist' });
    hider.start();
    assert.ok(hider.hiddenCount > 0);
    hider.stop();
    for (const button of doc.querySelectorAll('button')) assert.equal(button.style.display, '');
    assert.equal(hider.hiddenCount, 0);
});

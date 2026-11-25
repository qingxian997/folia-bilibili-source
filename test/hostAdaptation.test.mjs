// 宿主 DOM 适配：root 遍历和当前音源判断只有一份，页签改名 / 推荐隐藏都从它取信号。
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { collectHostRoots, activeSourceHint, createHostAdaptation } from '../lib/hostAdaptation.mjs';

test('收集主文档和 open shadow root', () => {
    const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { pretendToBeVisual: true });
    const shadow = dom.window.document.getElementById('host').attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button>页签</button>';
    assert.equal(collectHostRoots(dom.window.document).length, 2);
});

test('新装 profile 没写 localStorage 时，从当前音源按钮读信号', () => {
    const dom = new JSDOM('<!doctype html><html><body><button aria-label="切换在线音乐平台 · bilibili">账号</button></body></html>', { pretendToBeVisual: true });
    const roots = collectHostRoots(dom.window.document);
    assert.equal(activeSourceHint(dom.window.document, roots, 'bilibili'), true);
});

test('读不到页面信号才回退 localStorage；别的平台一律 false', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'https://example.test/' });
    dom.window.localStorage.setItem('active_online_provider_id', 'folium.bilibili.bili');
    const adapt = createHostAdaptation({
        document: dom.window.document,
        providerId: 'folium.bilibili.bili',
        providerLabel: 'bilibili',
    });
    assert.equal(adapt.isBiliActive(), true);
    assert.deepEqual(adapt.diagnostics(), { roots: 1, active: true });
    dom.window.localStorage.setItem('active_online_provider_id', 'folium.netease.netease');
    assert.equal(adapt.isBiliActive(), false);
});

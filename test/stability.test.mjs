// P1/P2 稳定性回归：失败不被当成功缓存、限流不翻倍请求、定时器必定清理。
// 全部打桩，不联网。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const activate = require('../index.cjs');

const makeApi = (folia = '0.7.29') => {
    const handlers = {};
    const store = {};
    const api = {
        log: { info() {}, warn() {}, error() {} },
        host: { folium: { major: 1, minor: 7 }, folia },
        manifest: { version: '0.9.2' },
        rpc: { handle(name, fn) { handlers[name] = fn; } },
        storage: {
            get: (key) => Promise.resolve(store[key] ?? null),
            set: (key, value) => { store[key] = value; return Promise.resolve(); },
            delete: (key) => { delete store[key]; return Promise.resolve(); },
        },
    };
    return { api, handlers, store };
};

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
});

test('buvid 申请失败不写进 state：下次请求会重试，不会全程缺指纹吃 412', async () => {
    const { api, handlers } = makeApi();
    const dispose = activate(api);
    const realFetch = globalThis.fetch;
    let spiCalls = 0;
    globalThis.fetch = async (url) => {
        const link = String(url);
        if (link.includes('/x/frontend/finger/spi')) {
            spiCalls += 1;
            if (spiCalls === 1) throw new Error('network down');
            return jsonResponse({ code: 0, data: { b_3: 'BUVID3', b_4: 'BUVID4' } });
        }
        return jsonResponse({ code: 0, data: {} });
    };
    try {
        // 第一次触发 buvid 申请：失败，但不会被缓存
        await handlers.status();
        assert.equal(spiCalls, 1);
        // 第二次：应该重新申请，而不是直接返回空指纹
        await handlers.status();
        assert.equal(spiCalls, 2, '失败后必须允许重试');
    } finally {
        globalThis.fetch = realFetch;
        dispose();
    }
});

test('nav 偶尔失败/空 mid 不缓存：不会让收藏夹 5 分钟内全变未登录', async () => {
    const { api, handlers } = makeApi();
    const dispose = activate(api);
    const realFetch = globalThis.fetch;
    let navCalls = 0;
    globalThis.fetch = async (url) => {
        const link = String(url);
        if (link.includes('/x/web-interface/nav')) {
            navCalls += 1;
            if (navCalls === 1) return jsonResponse({ code: 0, data: {} }); // 空 mid
            return jsonResponse({ code: 0, data: { mid: 12345 } });
        }
        return jsonResponse({ code: 0, data: {} });
    };
    try {
        await handlers.collected();
        await handlers.collected();
        assert.ok(navCalls >= 2, '空 mid 不该被缓存 5 分钟，再次调用应重新读 nav');
    } finally {
        globalThis.fetch = realFetch;
        dispose();
    }
});

test('签名接口遇到限流码不回退未签名：请求不翻倍', async () => {
    const { api, handlers } = makeApi();
    const dispose = activate(api);
    const realFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url) => {
        const link = String(url);
        calls.push(link);
        if (link.includes('wbi') || link.includes('w_rid')) {
            return jsonResponse({ code: -412, message: 'too fast' });
        }
        return jsonResponse({ code: 0, data: {} });
    };
    try {
        await handlers.search({ keyword: '测试', page: 1 });
        // 签名的 search 端点返回 -412 后，不应再打一发未签名的同端点
        const searchCalls = calls.filter((link) => link.includes('/x/web-interface/search/type'));
        assert.ok(searchCalls.length <= 1, `限流时不该翻倍请求，实际打了 ${searchCalls.length} 次`);
    } finally {
        globalThis.fetch = realFetch;
        dispose();
    }
});

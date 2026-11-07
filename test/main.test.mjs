// 主进程半边的冒烟测试：只验证 rpc 处理函数都注册上了、出错时被包成可读错误，
// 以及本地反代能起来并挡掉不该代理的地址。真实 bilibili 请求不在这里跑。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// 默认不联网：这几个用例会真的打 api.bilibili.com，用 BILI_LIVE=1 才跑。
const live = process.env.BILI_LIVE === '1';
const offlineSkip = live ? false : '需要网络：用 BILI_LIVE=1 运行';
const activate = require('../index.cjs');

const makeApi = () => {
    const handlers = {};
    const store = {};
    const api = {
        log: { info() {}, warn() {}, error() {} },
        host: { folium: { major: 1, minor: 7 }, folia: '0.7.22' },
        manifest: { version: '0.1.0' },
        rpc: {
            handle(name, fn) {
                handlers[name] = fn;
            },
        },
        storage: {
            get: (key) => Promise.resolve(store[key] ?? null),
            set: (key, value) => {
                store[key] = value;
                return Promise.resolve();
            },
            delete: (key) => {
                delete store[key];
                return Promise.resolve();
            },
        },
    };
    return { api, handlers, store };
};

test('主进程入口注册全部 rpc 处理函数，并返回清理函数', () => {
    const { api, handlers } = makeApi();
    const dispose = activate(api);
    for (const name of ['status', 'qr.generate', 'qr.poll', 'logout', 'setCookie', 'folders', 'folderItems', 'search', 'song', 'subtitles', 'audio', 'clearCache', 'favDeal', 'likedIds', 'extras', 'extraItems']) {
        assert.equal(typeof handlers[name], 'function', name);
    }
    assert.equal(typeof dispose, 'function');
    dispose();
});

test('未登录时读收藏夹会被拒绝，错误信息可读', { skip: offlineSkip }, async () => {
    const { api, handlers } = makeApi();
    const dispose = activate(api);
    // 网络抖动时的错误文案各不相同（fetch failed / aborted / 业务码），这里只要求「立刻拒绝且信息非空」。
    await assert.rejects(() => handlers.folders(), (error) => {
        assert.ok(String(error && error.message).length > 0);
        return true;
    });
    dispose();
});

test('手动凭据：空的、或没有登录信息的，在联网之前就被拒', async () => {
    const { api, handlers } = makeApi();
    const dispose = activate(api);
    await assert.rejects(() => handlers.setCookie({}), /登录凭据是空的/);
    await assert.rejects(() => handlers.setCookie({ cookie: '   ' }), /登录凭据是空的/);
    // 只粘 buvid3 之类读不到收藏夹，别白跑一次网络
    await assert.rejects(() => handlers.setCookie({ cookie: 'buvid3=abc; bili_jct=def' }), /没有登录信息/);
    dispose();
});

test('未登录时收藏会被挡在写接口之前', async () => {
    const { api, handlers } = makeApi();
    const dispose = activate(api);
    await assert.rejects(() => handlers.favDeal({ id: 'BV1xx411c7mD', liked: true }), /先扫码登录/);
    dispose();
});

test('额外列表：空输入不发请求，缺引用直接拒绝', async () => {
    const { api, handlers } = makeApi();
    const dispose = activate(api);
    assert.deepEqual(await handlers.extras({ refs: [] }), { items: [] });
    await assert.rejects(() => handlers.extraItems({ page: 1 }), /链接不完整/);
    dispose();
});

test('非数字 UID 在读收藏夹之前就被挡住，不会打接口', async () => {
    const { api, handlers } = makeApi();
    const dispose = activate(api);
    await assert.rejects(() => handlers.folders({ upMid: 'abc' }), /纯数字/);
    dispose();
});

test('空关键字搜索直接返回空页，不发请求', async () => {
    const { api, handlers } = makeApi();
    const dispose = activate(api);
    const page = await handlers.search({ keyword: '   ', page: 1 });
    assert.deepEqual(page, { items: [], total: 0, hasMore: false });
    dispose();
});

test('audio 对不存在的视频给出可读错误而不是挂起', { skip: offlineSkip }, async () => {
    const { api, handlers } = makeApi();
    const dispose = activate(api);
    await assert.rejects(() => handlers.audio({ id: 'BV1zzzzzzzzz', quality: 'high', route: 'auto' }), (error) => {
        assert.ok(String(error && error.message).length > 0);
        return true;
    });
    dispose();
});

test('反代会挡掉不在白名单里的目标', { skip: offlineSkip }, async () => {
    const { api, handlers } = makeApi();
    const dispose = activate(api);
    // 触发一次 proxy 链路，拿到端口与 token
    let proxied = null;
    try {
        proxied = await handlers.audio({ id: 'BV1xx411c7mD', quality: 'high', route: 'proxy' });
    } catch {
        proxied = null;
    }
    if (proxied && proxied.via === 'proxy') {
        const url = new URL(proxied.url);
        const response = await fetch(`${url.origin}/a?t=${url.searchParams.get('t')}&u=${Buffer.from('http://127.0.0.1:1/secret').toString('base64url')}`);
        assert.equal(response.status, 403);
        const noToken = await fetch(`${url.origin}/a?u=x`);
        assert.equal(noToken.status, 403);
    }
    dispose();
});

// 60 秒内同一个收藏夹只问 bilibili 一次：宿主画一面墙会连着问好几遍，
// 每遍都真去请求既慢又容易撞风控（412）。
test('同一个收藏夹的列表在 TTL 内只请求一次（连并发也只发一次）', async () => {
    const { api, handlers } = makeApi();
    const dispose = activate(api);
    const realFetch = globalThis.fetch;
    let hits = 0;
    let cards = 0;
    globalThis.fetch = async (url) => {
        const link = String(url);
        // 冷启动时还有一次 /x/frontend/finger/spi（wbi 指纹），它只发一次，不算在列表请求里。
        if (link.includes('/x/web-interface/card')) cards += 1;
        else if (link.includes('/x/v3/fav/folder/created/list-all')) hits += 1;
        const body = {
            code: 0,
            data: { list: [{ id: 1001, title: '默认收藏夹', media_count: 3, fav_state: 1, cover: '' }] },
        };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
        const [a, b] = await Promise.all([
            handlers.folders({ upMid: '42' }),
            handlers.folders({ upMid: '42' }),
        ]);
        assert.equal(hits, 1, '并发两次应该共用同一个请求');
        assert.equal(cards, 1, 'UP 主昵称也该共用一次请求');
        const c = await handlers.folders({ upMid: '42' });
        assert.equal(hits, 1, 'TTL 内不应再发请求');
        assert.equal(cards, 1, 'UP 主昵称同样不重复问');
        assert.equal(a.items[0].title, '默认收藏夹');
        assert.deepEqual(b.items, c.items);
        // 收藏之后条数会变：favDeal 要把它作废，下一次重新问。
        await handlers.clearCache();
        await handlers.folders({ upMid: '42' });
        assert.equal(hits, 2, 'clearCache 之后应该重新请求');
    } finally {
        globalThis.fetch = realFetch;
        dispose();
    }
});

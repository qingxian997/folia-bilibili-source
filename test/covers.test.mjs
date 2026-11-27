// 封面补抓的回归：限流不当成「没封面」、info.cover 兜底、失败不中断整批、force 绕过缓存。
// 全部用 globalThis.fetch 打桩，不联网。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const activate = require('../index.cjs');

const makeApi = () => {
    const handlers = {};
    const store = {};
    const api = {
        log: { info() {}, warn() {}, error() {} },
        host: { folium: { major: 1, minor: 7 }, folia: '0.7.29' },
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

test('封面 RPC 都注册上了', () => {
    const { api, handlers } = makeApi();
    const dispose = activate(api);
    for (const name of ['covers', 'fillCovers', 'folderCover', 'clearCache', 'ensureCovers', 'cover.state']) {
        assert.equal(typeof handlers[name], 'function', name);
    }
    dispose();
});

test('被 -412 限流时不写负缓存：下次还会重新问，封面不会空白五分钟', async () => {
    const { api, handlers, store } = makeApi();
    const dispose = activate(api);
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
        calls += 1;
        return jsonResponse({ code: -412, message: '风控' });
    };
    try {
        // 3 次重试都吃 -412，返回 ok 但 failed 计数，且不写空数组进缓存
        const answer = await handlers.fillCovers({ ids: ['1001'] });
        assert.equal(answer.failed, 1);
        assert.equal(answer.filled, 0);
        assert.ok(calls >= 3, '限流重试了几次');
        assert.ok(!answer.covers['1001'] || answer.covers['1001'].covers.length > 0,
            '限流不能被记成「没封面」的空数组负缓存');
        // 落盘的缓存里也不该有这个空条目
        await new Promise((r) => setTimeout(r, 1600)); // 等 coverSave 防抖写盘
        assert.ok(!store.covers || !store.covers['1001'] || store.covers['1001'].covers.length > 0);
    } finally {
        globalThis.fetch = realFetch;
        dispose();
    }
});

test('首屏全是失效视频时回退到 data.info.cover', async () => {
    const { api, handlers } = makeApi();
    const dispose = activate(api);
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => jsonResponse({
        code: 0,
        data: {
            medias: [
                { title: '已失效视频', cover: 'https://i0.hdslb.com/dead.jpg' },
                { title: '已失效视频', cover: 'https://i0.hdslb.com/dead2.jpg' },
            ],
            info: { cover: '//i0.hdslb.com/folder-cover.jpg' },
        },
    });
    try {
        const answer = await handlers.fillCovers({ ids: ['1002'] });
        assert.equal(answer.filled, 1);
        assert.equal(answer.covers['1002'].covers[0], 'https://i0.hdslb.com/folder-cover.jpg',
            'http 补齐 + info.cover 兜底');
    } finally {
        globalThis.fetch = realFetch;
        dispose();
    }
});

test('一条失败不会中断整批：后面的夹子照样取到封面', async () => {
    const { api, handlers } = makeApi();
    const dispose = activate(api);
    const realFetch = globalThis.fetch;
    let seen = [];
    globalThis.fetch = async (url) => {
        const id = /media_id=(\d+)/.exec(String(url))[1];
        seen.push(id);
        if (id === '2001') throw new Error('network down');
        return jsonResponse({ code: 0, data: { medias: [{ title: '歌', cover: `//i0.hdslb.com/${id}.jpg` }] } });
    };
    try {
        const answer = await handlers.fillCovers({ ids: ['2001', '2002'] });
        // 2001 重试 3 次都失败，2002 成功
        assert.ok(seen.includes('2002'), '失败那条之后仍然继续请求了后面的 id');
        assert.equal(answer.filled, 1);
        assert.equal(answer.failed, 1);
        assert.equal(answer.covers['2002'].covers[0], 'https://i0.hdslb.com/2002.jpg');
    } finally {
        globalThis.fetch = realFetch;
        dispose();
    }
});

test('清缓存会清掉封面：再读 covers 是空的', async () => {
    const { api, handlers, store } = makeApi();
    const dispose = activate(api);
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => jsonResponse({
        code: 0, data: { medias: [{ title: '歌', cover: '//i0.hdslb.com/1.jpg' }] },
    });
    try {
        await handlers.fillCovers({ ids: ['3001'] });
        assert.ok((await handlers.covers()).covers['3001'], '先有封面');
        await handlers.clearCache();
        const after = (await handlers.covers()).covers;
        assert.ok(!after['3001'], 'clearCache 后封面缓存被清掉');
        assert.ok(!store.covers, '落盘的封面缓存也被删掉');
    } finally {
        globalThis.fetch = realFetch;
        dispose();
    }
});

test('ensureCovers 入队后由后台补完，快照里只剩正结果', async () => {
    const { api, handlers } = makeApi();
    const dispose = activate(api);
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        const id = /media_id=(\d+)/.exec(String(url))[1];
        return jsonResponse({ code: 0, data: { medias: [{ title: '歌', cover: `//i0.hdslb.com/${id}.jpg` }] } });
    };
    try {
        const first = await handlers.ensureCovers({ ids: ['4001'] });
        assert.equal(first.pending, 1, '刚入队时应当是待补');
        await new Promise((r) => setTimeout(r, 800));
        const state = await handlers['cover.state']();
        assert.equal(state.pending, 0, '后台补完之后队列应当清空');
        assert.equal(state.covers['4001'][0], 'https://i0.hdslb.com/4001.jpg');
    } finally {
        globalThis.fetch = realFetch;
        dispose();
    }
});

test('被限流时不空转：夹子留在队列里，给出冷却时间，且不写负缓存', async () => {
    const { api, handlers } = makeApi();
    const dispose = activate(api);
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => jsonResponse({ code: -412, message: '风控' });
    try {
        const first = await handlers.ensureCovers({ ids: ['4101'] });
        assert.equal(first.pending, 1);
        // coverPage 内部会重试三次（700 + 1400ms 的间隔）
        await new Promise((r) => setTimeout(r, 3200));
        const state = await handlers['cover.state']();
        assert.ok(state.pending >= 1, '被限流的夹子留在队列里，等冷却结束再试');
        assert.ok(state.cooldownUntil > Date.now(), '要给出冷却结束时间，客户端据此停下');
        assert.equal(state.covers['4101'], undefined, '限流不能被记成「没封面」');
    } finally {
        globalThis.fetch = realFetch;
        dispose();
    }
});

test('已有新鲜封面的夹子不会被重复排队', async () => {
    const { api, handlers } = makeApi();
    const dispose = activate(api);
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => jsonResponse({
        code: 0, data: { medias: [{ title: '歌', cover: '//i0.hdslb.com/4201.jpg' }] },
    });
    try {
        await handlers.fillCovers({ ids: ['4201'] });
        const state = await handlers.ensureCovers({ ids: ['4201'] });
        assert.equal(state.pending, 0, '已经有封面的不该再排一次');
    } finally {
        globalThis.fetch = realFetch;
        dispose();
    }
});

test('force 过的夹子即使已有封面也会真的重取一次', async () => {
    const { api, handlers } = makeApi();
    const dispose = activate(api);
    const realFetch = globalThis.fetch;
    let calls = 0;
    // 只数封面接口：激活时还会打一次 buvid 的 finger/spi，那不算封面请求
    globalThis.fetch = async (url) => {
        if (String(url).includes('fav/resource/list')) calls += 1;
        return jsonResponse({ code: 0, data: { medias: [{ title: '歌', cover: '//i0.hdslb.com/5001.jpg' }] } });
    };
    try {
        await handlers.fillCovers({ ids: ['5001'] });
        assert.equal(calls, 1);
        const queued = await handlers.ensureCovers({ ids: ['5001'], force: true });
        assert.equal(queued.pending, 1, 'force 必须真的排进队列');
        await new Promise((r) => setTimeout(r, 800));
        assert.equal(calls, 2, 'worker 不能因为「已有新鲜封面」把它丢掉');
        const state = await handlers['cover.state']();
        assert.equal(state.pending, 0);
    } finally {
        globalThis.fetch = realFetch;
        dispose();
    }
});

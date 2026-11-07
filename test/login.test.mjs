// 扫码登录的「拿 Cookie」这一环：真机上报过「扫码已确认，但回跳地址里没有 SESSDATA」，
// 原因是 bilibili 把 Cookie 放在响应的 Set-Cookie 头里，而 data.url 是空串。
// 这里把 fetch 换掉，把三种返回形态都跑一遍，确认都能落地。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const activate = require('../index.cjs');

const SESSDATA = '8f2a91c0%2C1780000000%2Cabc123%2A11';

const makeApi = () => {
    const handlers = {};
    const files = new Map();
    const secrets = new Map();
    const api = {
        log: { info() {}, warn() {}, error() {} },
        host: { folium: { major: 1, minor: 7 }, folia: '0.7.22' },
        manifest: { version: '0.2.3' },
        rpc: { handle: (name, fn) => { handlers[name] = fn; } },
        storage: {
            get: async (key) => (files.has(key) ? files.get(key) : null),
            set: async (key, value) => { files.set(key, value); },
            delete: async (key) => { files.delete(key); },
        },
        secrets: {
            get: async (key) => (secrets.has(key) ? secrets.get(key) : ''),
            set: async (key, value) => {
                if (value === null) secrets.delete(key);
                else secrets.set(key, value);
            },
        },
    };
    return { api, handlers, files, secrets };
};

const NAV_OK = JSON.stringify({ code: 0, data: { isLogin: true, uname: '测试号', mid: 123456 } });
const POLL_OK = (extra) => JSON.stringify({ code: 0, data: { code: 0, message: '', url: '', ...extra } });

/** 把 fetch 换掉：poll 按给的方案应答，nav 一律说已登录。 */
const withFetch = async (poll, run) => {
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url) => {
        const target = String(url);
        calls.push(target);
        if (target.includes('/qrcode/poll')) return poll();
        if (target.includes('/x/web-interface/nav')) return new Response(NAV_OK, { status: 200 });
        if (target.includes('crossDomain')) {
            return new Response('', {
                status: 302,
                headers: {
                    location: 'https://www.bilibili.com',
                    'set-cookie': `SESSDATA=${SESSDATA}; Path=/; Domain=.bilibili.com; Expires=Wed, 01 Jan 2031 00:00:00 GMT`,
                },
            });
        }
        throw new Error(`unexpected fetch ${target}`);
    };
    try {
        return await run(calls);
    } finally {
        globalThis.fetch = original;
    }
};

test('Cookie 只在 Set-Cookie 头里（data.url 为空）也能登录', async () => {
    const { api, handlers, secrets, files } = makeApi();
    const dispose = activate(api);
    const answer = await withFetch(
        () => new Response(POLL_OK({}), {
            status: 200,
            headers: [
                ['set-cookie', `SESSDATA=${SESSDATA}; Path=/; Domain=.bilibili.com; Expires=Wed, 01 Jan 2031 00:00:00 GMT; HttpOnly; Secure`],
                ['set-cookie', 'bili_jct=deadbeef; Path=/; Domain=.bilibili.com; Expires=Wed, 01 Jan 2031 00:00:00 GMT'],
                ['set-cookie', 'DedeUserID=123456; Path=/; Domain=.bilibili.com'],
            ],
        }),
        () => handlers['qr.poll']({ key: 'k1' }),
    );
    dispose();
    assert.equal(answer.stage, 'ok');
    assert.equal(answer.uname, '测试号');
    const saved = secrets.get('cookie') || files.get('cookie') || '';
    // 值必须原样保留：%2C 解码成逗号会让 Cookie 头非法
    assert.match(saved, new RegExp(`SESSDATA=${SESSDATA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(saved, /bili_jct=deadbeef/);
    assert.ok(!saved.includes('SESSDATA=8f2a91c0,'), 'SESSDATA 不能被解码');
});

test('data.url 里带参数的老形态仍然可用', async () => {
    const { api, handlers, secrets } = makeApi();
    const dispose = activate(api);
    const url = `https://passport.biligame.com/crossDomain?DedeUserID=123456&DedeUserID__ckMd5=abc&Expires=1780000000&SESSDATA=${SESSDATA}&bili_jct=deadbeef&gourl=https%3A%2F%2Fwww.bilibili.com`;
    const answer = await withFetch(
        () => new Response(POLL_OK({ url }), { status: 200 }),
        () => handlers['qr.poll']({ key: 'k2' }),
    );
    dispose();
    assert.equal(answer.stage, 'ok');
    const saved = secrets.get('cookie') || '';
    assert.ok(saved.includes(`SESSDATA=${SESSDATA}`));
    assert.ok(saved.includes('bili_jct=deadbeef'));
});

test('两路都没有时给可读报错，并把诊断信息带出来', async () => {
    const { api, handlers } = makeApi();
    const dispose = activate(api);
    const answer = await withFetch(
        () => new Response(POLL_OK({}), { status: 200 }),
        () => handlers['qr.poll']({ key: 'k3' }),
    );
    dispose();
    assert.equal(answer.stage, 'error');
    assert.match(answer.message, /没拿到 SESSDATA/);
    assert.match(answer.message, /data\.url 为空/);
    assert.match(answer.message, /手动粘贴 Cookie/);
});

test('只给 Set-Cookie 的删除指令，不能当成登录成功', async () => {
    const { api, handlers } = makeApi();
    const dispose = activate(api);
    const answer = await withFetch(
        () => new Response(POLL_OK({}), {
            status: 200,
            headers: { 'set-cookie': 'SESSDATA=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT' },
        }),
        () => handlers['qr.poll']({ key: 'k4' }),
    );
    dispose();
    assert.equal(answer.stage, 'error');
});

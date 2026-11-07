import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCookieStore } = require('../lib/store.cjs');

/** 假宿主：secret 可以用不同方式「坏掉」，数据文件永远可用。 */
function host({ secretMode = 'works' } = {}) {
    const file = new Map();
    let secret = '';
    let nulls = 0;
    let delCalls = 0;
    const api = {
        storage: {
            get: async (key) => (file.has(key) ? file.get(key) : null),
            set: async (key, value) => void file.set(key, value),
            delete: async (key) => {
                delCalls += 1;
                file.delete(key);
            },
        },
    };
    if (secretMode !== 'absent') {
        api.secrets = {
            get: async () => {
                if (secretMode === 'throws') throw new Error('no such field');
                if (secretMode === 'map') return { cookie: secret };
                return secret;
            },
            set: async (key, value) => {
                if (secretMode === 'throws') throw new Error('no such field');
                if (secretMode === 'silent') return; // 静默 no-op
                if (value === null) {
                    nulls += 1;
                    secret = '';
                    return;
                }
                secret = value;
            },
        };
    }
    return { api, file, get secret() { return secret; }, get nulls() { return nulls; }, get delCalls() { return delCalls; } };
}

test('secret 能用时写进密钥字段，并清掉数据文件里的明文副本', async () => {
    const h = host();
    h.file.set('cookie', 'SESSDATA=old');
    const store = createCookieStore(h.api);
    assert.equal(await store.write('SESSDATA=abc%2C1%2C2'), 'secret');
    assert.equal(h.secret, 'SESSDATA=abc%2C1%2C2');
    assert.equal(h.file.has('cookie'), false);
    assert.equal(await store.read(true), 'SESSDATA=abc%2C1%2C2');
});

test('secrets.get 回整张表时也能读出来', async () => {
    const h = host({ secretMode: 'map' });
    const store = createCookieStore(h.api);
    await store.write('SESSDATA=x');
    assert.equal(await store.read(true), 'SESSDATA=x');
});

test('secret 静默 no-op 时回落到数据文件，不丢登录', async () => {
    const h = host({ secretMode: 'silent' });
    const store = createCookieStore(h.api);
    assert.equal(await store.write('SESSDATA=abc'), 'file');
    assert.equal(h.file.get('cookie'), 'SESSDATA=abc');
    assert.equal(await store.read(true), 'SESSDATA=abc');
});

test('宿主没有 secrets 或它抛异常时不崩', async () => {
    for (const mode of ['absent', 'throws']) {
        const h = host({ secretMode: mode });
        const store = createCookieStore(h.api);
        assert.equal(await store.write('SESSDATA=abc'), 'file');
        assert.equal(await store.read(true), 'SESSDATA=abc');
    }
});

test('ttl 内复用缓存，过期后重新读', async () => {
    const h = host();
    let clock = 1000;
    const store = createCookieStore(h.api, { ttl: 3000, now: () => clock });
    await store.write('SESSDATA=abc');
    h.api.secrets.set('cookie', 'SESSDATA=changed');
    assert.equal(await store.read(), 'SESSDATA=abc', 'ttl 内应该是缓存');
    clock += 3001;
    assert.equal(await store.read(), 'SESSDATA=changed', '过期后读到新值');
});

test('退出登录同时清数据文件与密钥字段（null）', async () => {
    const h = host();
    const store = createCookieStore(h.api);
    await store.write('SESSDATA=abc');
    await store.clear();
    assert.equal(h.secret, '');
    assert.equal(h.nulls, 1);
    assert.equal(h.file.has('cookie'), false);
    assert.equal(await store.read(true), '');
    assert.equal(store.peek(), '');
});

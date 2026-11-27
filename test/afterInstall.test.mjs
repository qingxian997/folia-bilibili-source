import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureEnabledAfterInstall } from '../lib/afterInstall.mjs';

test('更新后调宿主 setEnabled，走它自己的信任确认', async () => {
    const calls = [];
    const mods = { setEnabled: async (...args) => { calls.push(args); } };
    const result = await ensureEnabledAfterInstall({ mods, id: 'bilibili' });
    assert.equal(result, 'enabled');
    assert.deepEqual(calls, [['bilibili', true]]);
});

test('宿主没暴露 setEnabled 时给手动指引，不报错', async () => {
    let manual = 0;
    const result = await ensureEnabledAfterInstall({
        mods: {},
        id: 'bilibili',
        onManual: () => { manual += 1; },
    });
    assert.equal(result, 'manual');
    assert.equal(manual, 1);
});

test('完全拿不到 electron.mods 也走手动指引', async () => {
    let manual = 0;
    const result = await ensureEnabledAfterInstall({ mods: null, id: 'bilibili', onManual: () => { manual += 1; } });
    assert.equal(result, 'manual');
    assert.equal(manual, 1);
});

test('setEnabled 抛错时不冒泡，交给手动指引', async () => {
    let manual = 0;
    const mods = { setEnabled: async () => { throw new Error('trust denied'); } };
    const result = await ensureEnabledAfterInstall({ mods, id: 'bilibili', onManual: () => { manual += 1; } });
    assert.equal(result, 'manual');
    assert.equal(manual, 1);
});

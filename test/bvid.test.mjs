// BV 号 → av 号：只用来给收藏夹条目补 Subsonic 的歌曲 id（必须是纯数字）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { bvToAv } = require('../lib/bvid.cjs');

test('换算已知的 BV / av 对', () => {
    assert.equal(bvToAv('BV17x411w7KC'), 170001);
    assert.equal(bvToAv('BV1GJ411x7h7'), 80433022);
    assert.equal(bvToAv('BV1Q541167Qg'), 455017605);
});

test('格式不对就给 0，让调用方把这条丢掉', () => {
    assert.equal(bvToAv(''), 0);
    assert.equal(bvToAv('av170001'), 0);
    assert.equal(bvToAv('BV1xx411c7mD-extra'), 0);
    assert.equal(bvToAv('BV1IIIIIIIII'), 0, 'I 不在 base58 表里');
});

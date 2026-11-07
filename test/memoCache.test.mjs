import test from 'node:test';
import assert from 'node:assert/strict';

import { MEMO_MAX, remember } from '../lib/memoCache.cjs';

// 0.9.0：主进程的短期记忆以前没有上限（key 里带搜索词、收藏夹分页、字幕），
// 开一整天的窗口会一直涨。这里锁住「有上限」和「挤掉的是最老的」两件事。

test('memoCache：超过上限就丢最老的，条数不再增长', () => {
    const map = new Map();
    for (let i = 0; i < MEMO_MAX + 40; i += 1) remember(map, `k${i}`, { i });
    assert.equal(map.size, MEMO_MAX);
    assert.equal(map.has('k0'), false, '最早写进去的被挤掉');
    assert.equal(map.has(`k${MEMO_MAX + 39}`), true, '最新的还在');
});

test('memoCache：同一个 key 重写要挪到队尾，不会被当成最老的挤掉', () => {
    const map = new Map();
    for (let i = 0; i < MEMO_MAX; i += 1) remember(map, `k${i}`, { i });
    // 重写最老的那条，它应该活下来，替它被挤掉的是第二老的那条。
    remember(map, 'k0', { i: 'again' });
    remember(map, 'fresh', { i: 'fresh' });
    assert.equal(map.size, MEMO_MAX);
    assert.equal(map.get('k0').value.i, 'again');
    assert.equal(map.has('k1'), false);
});

test('memoCache：写进去的是 {at, value}，调用方仍能按 TTL 判过期', () => {
    const map = new Map();
    remember(map, 'sub:1:cc', ['line']);
    const hit = map.get('sub:1:cc');
    assert.ok(hit.at > 0);
    assert.deepEqual(hit.value, ['line']);
});

test('memoCache：max 传 0 或负数时回落到默认上限', () => {
    const map = new Map();
    for (let i = 0; i < MEMO_MAX + 5; i += 1) remember(map, `k${i}`, i, 0);
    assert.equal(map.size, MEMO_MAX);
});

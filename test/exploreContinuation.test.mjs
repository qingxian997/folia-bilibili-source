// test/exploreContinuation.test.mjs
// 0.8.2 P0 回归：探索页续命绝不能靠「任意输入 + 定时轮询」自激。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    canAppend, wheelDeltaPx, MIN_ADVANCE_PX, QUIET_MS, MAX_STEP_PX, SETTLE_MS, URGENT_ADVANCE_PX,
} from '../lib/exploreContinuation.mjs';

const FEED = {
    status: 'ready',
    loadingMore: false,
    refreshing: false,
    moreFailed: false,
    nextCursor: 'bili:feed:121',
    pages: 5,
    total: 110,
};

function base(overrides = {}) {
    return {
        active: true,
        visible: true,
        inFlight: false,
        feed: { ...FEED },
        now: 10_000,
        lastAppendAt: 0,
        advance: MIN_ADVANCE_PX,
        ...overrides,
    };
}

test('常量就是防自激的三道闸', () => {
    assert.equal(MIN_ADVANCE_PX, 600);
    assert.equal(QUIET_MS, 1500);
    assert.equal(MAX_STEP_PX, 400);
    assert.equal(SETTLE_MS, 220);
});

test('0.9.1：手指还在滑就不补，停下来才补', () => {
    // 真机 profile：补批那一下宿主重排整墙要 55~155ms，正撞在滑动中间就是「滑一下卡一下」。
    assert.equal(canAppend(base({ sinceInput: 0 })).reason, 'still-scrolling');
    assert.equal(canAppend(base({ sinceInput: SETTLE_MS - 1 })).reason, 'still-scrolling');
    assert.equal(canAppend(base({ sinceInput: SETTLE_MS })).ok, true, '停够了就补');
    assert.equal(canAppend(base({ sinceInput: 5000 })).ok, true);
});

test('0.9.1：没滚够时先报没滚够，别拿「还在滑」掩盖真正的原因', () => {
    assert.equal(canAppend(base({ advance: 0, sinceInput: 0 })).reason, 'no-advance');
});

test('0.9.1：一口气滑过头就别死等停下，先补上，别让墙空着', () => {
    assert.equal(canAppend(base({ advance: URGENT_ADVANCE_PX, sinceInput: 0 })).ok, true);
    assert.equal(canAppend(base({ advance: URGENT_ADVANCE_PX - 1, sinceInput: 0 })).reason, 'still-scrolling');
    assert.equal(URGENT_ADVANCE_PX, 2400, '大约四屏，正常滚动碰不到');
});

test('wheelDeltaPx：只累计向下滚，按 deltaMode 折算并限幅', () => {
    assert.equal(wheelDeltaPx(120), 120);
    assert.equal(wheelDeltaPx(-120), 0, '向上滚不算进度');
    assert.equal(wheelDeltaPx(0), 0);
    assert.equal(wheelDeltaPx(10, 1), 160, '行模式按 16px/行');
    assert.equal(wheelDeltaPx(2, 2, 1000), 400, '页模式按视口高，但被限幅');
    assert.equal(wheelDeltaPx(99999), MAX_STEP_PX, '一帧巨大 delta 不能一次满足阈值');
    assert.equal(wheelDeltaPx(NaN), 0);
    assert.equal(wheelDeltaPx('abc'), 0);
});

test('用户真的往下滚够一段，允许补一批', () => {
    assert.deepEqual(canAppend(base()), { ok: true, reason: 'append' });
});

test('P0 根因：宿主重排自派 scroll（scrollTop 恒 0）贡献不了进度', () => {
    assert.equal(canAppend(base({ advance: 0 })).reason, 'no-advance');
    assert.equal(canAppend(base({ advance: 100 })).reason, 'no-advance');
});

test('P0 根因：按空格 / 点界面不产生任何滚动进度', () => {
    // client 不再监听 keydown / click，advance 保持 0。
    assert.equal(canAppend(base({ advance: 0 })).ok, false);
});

test('P0 根因：向上滚累计 0，不会补', () => {
    assert.equal(wheelDeltaPx(-500) + wheelDeltaPx(-500), 0);
    assert.equal(canAppend(base({ advance: 0 })).reason, 'no-advance');
});

test('刚补过一批，静默窗口内即使又滚够也不补', () => {
    assert.equal(canAppend(base({ lastAppendAt: 9000, now: 10_000 })).reason, 'quiet');
});

test('补批后进度清零，再滚够 + 过静默窗口才能补下一批', () => {
    assert.equal(canAppend(base({ lastAppendAt: 9000, now: 10_000, advance: 0 })).reason, 'no-advance');
    assert.equal(canAppend(base({ lastAppendAt: 8000, now: 10_000, advance: MIN_ADVANCE_PX })).ok, true);
});

test('宿主自己还能续读时不插手', () => {
    assert.equal(canAppend(base({ feed: { ...FEED, pages: 3, total: 60 } })).reason, 'host-can-read');
});

test('feed 忙 / 没游标 / 没就绪时不补', () => {
    assert.equal(canAppend(base({ feed: { ...FEED, loadingMore: true } })).reason, 'feed-busy');
    assert.equal(canAppend(base({ feed: { ...FEED, moreFailed: true } })).reason, 'feed-busy');
    assert.equal(canAppend(base({ feed: { ...FEED, nextCursor: null } })).reason, 'no-cursor');
    assert.equal(canAppend(base({ feed: { ...FEED, status: 'loading' } })).reason, 'feed-not-ready');
});

test('非 bilibili / 不在探索页 / 模态挡着 / 上一批没完，都不补', () => {
    assert.equal(canAppend(base({ active: false })).reason, 'not-bili');
    assert.equal(canAppend(base({ visible: false })).reason, 'not-visible');
    assert.equal(canAppend(base({ blocked: true })).reason, 'blocked');
    assert.equal(canAppend(base({ inFlight: true })).reason, 'in-flight');
});

test('传空参数不抛异常', () => {
    assert.equal(canAppend().ok, false);
    assert.equal(canAppend(null).ok, false);
});

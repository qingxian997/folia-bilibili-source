// test/proxyStream.test.mjs
// 0.8.3：音频反代的流收尾。守的是 2026-11-06 / 11-07 三次 uncaughtException 崩溃：
// 上游 `TypeError: terminated` 逃成未捕获异常，整个 Folia 直接退出。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const require = createRequire(import.meta.url);
const { pipeUpstream } = require('../lib/proxyStream.cjs');

function webBody(chunks, errorAfter) {
    const encoder = new TextEncoder();
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            if (errorAfter) controller.error(errorAfter);
            else controller.close();
        },
    });
}

function fakeResponse() {
    const stream = new PassThrough();
    stream.headersSent = true;
    stream.chunks = [];
    stream.on('data', (chunk) => stream.chunks.push(Buffer.from(chunk)));
    stream.destroy = stream.destroy.bind(stream);
    return stream;
}

const flush = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

test('正常把上游内容灌给响应，结束后不报错', async () => {
    const response = fakeResponse();
    const errors = [];
    pipeUpstream({ body: webBody(['abc', 'def']), response, onError: (e) => errors.push(e) });
    await flush();
    assert.equal(Buffer.concat(response.chunks).toString(), 'abcdef');
    assert.deepEqual(errors, []);
});

test('上游中断（TypeError: terminated）只回调、不抛未捕获异常', async () => {
    const response = fakeResponse();
    const errors = [];
    const boom = new TypeError('terminated');
    // 这一行在旧实现里就是崩溃点：'error' 没有监听者 → uncaughtException。
    assert.doesNotThrow(() => {
        pipeUpstream({ body: webBody(['abc'], boom), response, onError: (e) => errors.push(e) });
    });
    await flush(80);
    assert.equal(errors.length, 1, '中断必须被接住并记一次日志');
    assert.equal(errors[0].message, 'terminated');
    assert.equal(response.destroyed, true, '出错后要把响应销毁，别让播放器永久缓冲');
});

test('上游立刻失败也不冒泡（响应还没 body 的极端情况）', async () => {
    const response = fakeResponse();
    const errors = [];
    pipeUpstream({ body: webBody([], new TypeError('terminated')), response, onError: (e) => errors.push(e) });
    await flush(80);
    assert.equal(errors.length, 1);
});

test('客户端先断开：掐掉上游，且不算故障', async () => {
    const response = fakeResponse();
    const request = new EventEmitter();
    const errors = [];
    const stream = pipeUpstream({ body: webBody(['abc']), response, request, onError: (e) => errors.push(e) });
    request.emit('close');
    await flush(60);
    assert.equal(stream.destroyed, true);
    assert.deepEqual(errors, [], '主动收尾不该记成失败');
});

test('没有 body 时直接结束响应', async () => {
    let ended = 0;
    const response = { end: () => { ended += 1; }, destroy: () => {} };
    const result = pipeUpstream({ body: null, response });
    assert.equal(result, null);
    assert.equal(ended, 1);
});

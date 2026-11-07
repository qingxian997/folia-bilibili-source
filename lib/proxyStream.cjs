// lib/proxyStream.cjs
// 0.8.3：音频反代的收尾。
//
// 事故形状（2026-11-06 两次、11-07 一次，Folia 全部写成 uncaughtException 崩溃报告）：
//   TypeError: terminated
//       at Fetch.onAborted (node:internal/deps/undici/undici:13877:53)
//       ... TLSSocket.onHttpSocketClose
//
// 根因：CDN 在传输中途把连接掐了（换歌、拖进度条、网络抖动都会），undici 让
// `upstream.body` 以 `TypeError: terminated` 失败，而 `Readable.fromWeb(...).pipe(response)`
// **不转发 'error'**。这个 'error' 没有任何监听者，Node 就把它升级成主进程
// uncaughtException —— 宿主直接崩，用户只看到窗口没了。
//
// 修法：用 `stream.pipeline` 接管。它会给两端都挂 error 监听、出错时互相销毁，
// 错误只进回调，不会再变成未捕获异常。客户端先走（`request`/`response` 的 close）
// 时主动掐掉上游，免得连接吊着。

const { Readable, pipeline } = require('node:stream');

function safeLog(onError, error) {
    if (typeof onError !== 'function') return;
    try {
        onError(error);
    } catch {
        /* 日志本身不该再抛一次 */
    }
}

/**
 * 把上游 fetch 的 body 灌给 HTTP 响应，任何一端出错都只记日志、不抛。
 *
 * @param {object}   options
 * @param {object}   options.body       `upstream.body`（web ReadableStream），可为空
 * @param {object}   options.response   http.ServerResponse
 * @param {object}  [options.request]   http.IncomingMessage，用来感知客户端断开
 * @param {function}[options.onError]   出错时的日志回调
 * @returns {object|null} 包装后的 Node 流，方便测试与手动销毁
 */
function pipeUpstream(options) {
    const { body, response, request, onError } = options || {};
    if (!body) {
        try {
            response.end();
        } catch {
            /* 客户端已经走了 */
        }
        return null;
    }

    let stream;
    try {
        stream = Readable.fromWeb(body);
    } catch (error) {
        safeLog(onError, error);
        try {
            response.destroy();
        } catch {
            /* 已经销毁 */
        }
        return null;
    }

    // 主动收尾（客户端断开 / 卸载模组）会让 pipeline 报「提前关闭」，那不是故障。
    const dispose = () => {
        try {
            stream.destroy();
        } catch {
            /* 已经销毁 */
        }
        try {
            if (typeof response.destroy === 'function') response.destroy();
        } catch {
            /* 已经销毁 */
        }
    };

    if (request && typeof request.on === 'function') request.on('close', dispose);
    if (response && typeof response.on === 'function') {
        // 没有这两个监听时，响应端的 'error'（客户端 RST）同样会升级成崩溃。
        response.on('close', dispose);
        response.on('error', dispose);
    }

    pipeline(stream, response, (error) => {
        if (!error) return;
        // 主动收尾的几种形态：提前关闭 / 已销毁 / 被 abort。
        // 注意不能只看「有没有 close 过」——pipeline 自己出错时也会先销毁目标，
        // 那样真实的上游中断会被一起吞掉（测试就是这么发现的）。
        const code = String((error && error.code) || '');
        const teardown = code === 'ERR_STREAM_PREMATURE_CLOSE'
            || code === 'ERR_STREAM_DESTROYED'
            || code === 'ABORT_ERR'
            || (error && error.name === 'AbortError');
        if (!teardown) safeLog(onError, error);
        try {
            response.destroy();
        } catch {
            /* 已经销毁 */
        }
    });

    return stream;
}

module.exports = { pipeUpstream };

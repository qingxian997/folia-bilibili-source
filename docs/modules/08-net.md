# 08 · 网络与凭据（`proxyStream.cjs` / `cookie.cjs` / `bvid.cjs`）

## `lib/proxyStream.cjs`（105 行，主进程）

### 职责

音频反代「本机中转」的收尾层。直连 CDN 拿不到时，主进程起一个本地 HTTP 服务转发音频流。

### 为什么单独一个模块

真实事故（2026-11-06 两次、11-07 一次，Folia 全写成 `uncaughtException` 崩溃报告）：

```text
TypeError: terminated
    at Fetch.onAborted (node:internal/deps/undici/undici:13877:53)
    ... TLSSocket.onHttpSocketClose
```

根因：CDN 在传输中途把连接掐了（换歌、拖进度条、网络抖动都会），
undici 让 `upstream.body` 以 `TypeError: terminated` 失败，
而 `Readable.fromWeb(...).pipe(response)` 不会把这个错误转给 response，
于是变成未捕获异常，整个宿主崩掉。

### 导出

| 导出 | 作用 |
| --- | --- |
| `pipeUpstream(upstream, response, options)` | 用 `pipeline` 转发，并按 `error.code` 分流 |

### 必须遵守

- **一律用 `stream.pipeline`**，不要用 `pipe()`。`pipe` 不转发 `'error'`。
- 这些错误码属于**主动收尾**，不是故障，不能记 error 日志：

```text
ERR_STREAM_PREMATURE_CLOSE   客户端断开（换歌 / 拖进度）
ERR_STREAM_DESTROYED         同上
ABORT_ERR                    AbortController 主动取消
```

- 其余错误才记日志，并且只记 `code` 和 `message`，不记完整 URL（带签名参数）。
- 崩溃日志在 `D:\folia\logs\crash-*.log`；栈里出现 `SimpleURLLoaderWrapper`
  说明是宿主自己的 Electron net，不是这里。

### 测试

`test/proxyStream.test.mjs`。

---

## `lib/cookie.cjs`（149 行，主进程）

### 职责

Cookie 的取、洗、验。纯函数，主进程 `require`，测试直接跑。

### 导出

| 导出 | 作用 |
| --- | --- |
| `WANTED` | 决定身份的 Cookie 名列表 |
| `passportCookiesFromUrl(url)` | 从扫码返回的 `data.url` 里摘 Cookie |
| `cookiesFromSetCookie(raw)` | 解析 `Set-Cookie` 响应头 |
| `mergeCookies(...groups)` | 多来源合并，后者覆盖前者 |
| `normalizeCookieInput(raw)` | 用户输入的 Cookie 串归一 |
| `parseCookiePairs(raw)` | 串 → `{ name: value }` |
| `hasSession(raw)` | 是否含 `SESSDATA` |

### 要点

- 真正决定身份的只有几个：`SESSDATA` / `bili_jct` / `DedeUserID` /
  `DedeUserID__ckMd5` / `sid`。其余（`buvid3` 等）由主进程自己补。
- **`SESSDATA` 不要 decode**。它是 URL 编码过的，decode 之后服务端认不出来，
  现象是「登录成功但所有接口 401」。
- `buvid3` 要持久化。不带它反复请求会触发 `-412` 风控。
- Cookie 只从宿主加密存储读，不落明文。

### 测试

`test/cookie.test.mjs`。

---

## `lib/bvid.cjs`（34 行，主进程）

### 职责

BV 号 → av 号的纯算法换算，不发请求。

`bvid#N` 的拆分**不在这个文件里**，而是 `index.cjs:421` 的内部函数 `splitId()`，
不导出，只给 `handle()` 用。两者不要混。

### 导出

| 导出 | 作用 |
| --- | --- |
| `bvToAv(bvid)` | BV 号 → 数字 av 号，非法输入返回 0 |

### 为什么需要 av 号

某些宿主路径会把歌曲 id 抠成数字
（`parseInt(song.id.replace(/\D/g, ''))`），所以交给宿主的 id 必须是纯数字的 av 号，
不能是 BV 号。收藏夹接口一般直接给 `id`（就是 av 号），缺了才用算法换算。

算法与 bilibili 前端一致：`BV1` + 9 位 base58，先按固定位置交换两位，
再去掉前缀解码，与 `XOR_CODE` 异或后取低 51 位。

### `bvid#N` 是全局约定

```text
'BV1xx411c7mD'    → { bvid: 'BV1xx411c7mD', page: 1 }
'BV1xx411c7mD#3'  → { bvid: 'BV1xx411c7mD', page: 3 }
```

拆分实现在 `index.cjs:421` 的 `splitId()`。
`subtitles` / `audio` / `levels` / `favDeal` 全部经它拆参数。
新增吃 `id` 的 RPC 时必须走同一条路，不要自己 `split('#')`。

### 测试

`test/bvid.test.mjs`。

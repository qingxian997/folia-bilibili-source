// mods/bili-fav/index.cjs
// 主进程半边：所有 bilibili HTTP 都走这里。
//
// 为什么都放在 main：
//   1) 需要自定义请求头（Referer / Cookie / User-Agent），渲染端的 folium.net.fetch 只保证 GET；
//   2) SESSDATA 不进渲染进程，QR 登录拿到的 cookie 直接落到主进程；
//   3) 音频防盗链兜底要开一个 127.0.0.1 反代，只有 Node 端能做。
//
// client.mjs 只做编排（provider 的四件套 + 界面），通过 api.rpc 调这些处理函数。

'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { listAsarDir } = require('./lib/asar.cjs');
const {
    passportCookiesFromUrl,
    cookiesFromSetCookie,
    mergeCookies,
    normalizeCookieInput,
    hasSession,
} = require('./lib/cookie.cjs');
const { createCookieStore } = require('./lib/store.cjs');
const { normalizeFeedItems, nextFeedCursor, MAX_FEED_PAGE } = require('./lib/feed.cjs');
const { pipeUpstream } = require('./lib/proxyStream.cjs');
const { remember } = require('./lib/memoCache.cjs');

const API = 'https://api.bilibili.com';
const PASSPORT = 'https://passport.bilibili.com';
const ORIGIN = 'https://www.bilibili.com';
const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// WBI 混淆表（bilibili Web 端同一张表；官方前端每季度可能整体换表，届时这里要跟着换）。
const MIXIN_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38,
    41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
    20, 34, 44, 52,
];

// 反代只放行这几家 CDN，避免这个端口被当成任意代理用。
const ALLOWED_HOSTS = /(^|\.)(bilivideo\.(com|cn)|akamaized\.net|hdslb\.com|bilibili\.com|biliapi\.(net|com)|szbdyd\.com)$/i;
/** 只有 bilibili 自己的接口域名才带 Cookie；CDN（bilivideo / hdslb / akamai / szbdyd）不带。 */
const COOKIE_HOSTS = /(^|\.)(bilibili\.com|biliapi\.(net|com))$/i;

/** 反代向上游要首字节的上限。到手后就不再计时，body 由 close 事件收。 */
const PROXY_TIMEOUT_MS = 20000;

const md5 = (text) => crypto.createHash('md5').update(text).digest('hex');

/** @param {import('folium').FoliumMainApi} api */
module.exports = function activate(api) {
    const state = {
        cookie: '',
        cookieAt: 0,
        buvid: null,
        wbi: null,
        views: new Map(),
        server: null,
        port: 0,
        pending: null,
        token: crypto.randomBytes(10).toString('hex'),
    };

    /**
     * 注册 RPC 时统一把「bili: 」前缀摘掉。
     *
     * 前缀是给日志看的（grep `bili:` 一眼能找到），但这些消息也会原样进宿主的
     * toast，用户看到「bili: 请求太频繁」只会困惑。日志里仍然带前缀，只在这里去掉。
     */
    const handle = (name, fn) => api.rpc.handle(name, async (payload) => {
        try {
            return await fn(payload);
        } catch (error) {
            const message = String((error && error.message) || error || '');
            if (!/^bili:\s*/i.test(message)) throw error;
            const clean = new Error(message.replace(/^bili:\s*/i, ''));
            if (error && error.done != null) clean.done = error.done;
            throw clean;
        }
    });

    // ---------------------------------------------------------------- cookie

    // 存哪、怎么回读校验都在 lib/store.cjs；这里只管把它同步到内存里的 state。
    const cookies = createCookieStore(api);

    async function loadCookie(force) {
        state.cookie = await cookies.read(force);
        state.cookieAt = Date.now();
        return state.cookie;
    }

    async function saveCookie(raw) {
        const where = await cookies.write(raw);
        state.cookie = String(raw || '');
        state.cookieAt = Date.now();
        return where === 'secret';
    }

    async function clearCookie() {
        state.cookie = '';
        state.cookieAt = 0;
        state.wbi = null;
        state.views.clear();
        await cookies.clear();
    }

    /** 游客指纹：没有 buvid3 时 bilibili 会把搜索当风控流量（-412）。 */
    async function ensureBuvid() {
        if (state.buvid) return state.buvid;
        if (state.buvidPending) return state.buvidPending;
        // 注意：这次请求不能带 cookie，否则 cookieHeader → ensureBuvid 会递归。
        state.buvidPending = (async () => {
            try {
                const json = await getJson(`${API}/x/frontend/finger/spi`, { noCookie: true });
                const data = json && json.data;
                state.buvid = { b3: (data && data.b_3) || '', b4: (data && data.b_4) || '' };
            } catch (error) {
                api.log.warn('bili: buvid bootstrap failed', error);
                state.buvid = { b3: '', b4: '' };
            } finally {
                state.buvidPending = null;
            }
            return state.buvid;
        })();
        return state.buvidPending;
    }

    async function cookieHeader(extra = '') {
        const parts = [];
        const buvid = await ensureBuvid();
        if (buvid.b3) parts.push(`buvid3=${buvid.b3}`);
        if (buvid.b4) parts.push(`buvid4=${buvid.b4}`);
        const saved = await loadCookie();
        if (saved) parts.push(saved);
        if (extra) parts.push(extra);
        return parts.join('; ');
    }

    // ------------------------------------------------------------------ http

    /**
     * 只发请求，不判 status、不解析 JSON。保留 `Set-Cookie`：
     * 扫码成功后 bilibili 很可能只在响应头里下发 SESSDATA（body 的 data.url 是空串）。
     */
    async function rawRequest(url, options = {}) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), options.timeout || 15000);
        try {
            const response = await fetch(url, {
                method: options.method || 'GET',
                ...(options.body ? { body: options.body } : {}),
                headers: {
                    'User-Agent': UA,
                    Referer: ORIGIN,
                    Origin: ORIGIN,
                    Accept: 'application/json, text/plain, */*',
                    'Accept-Language': 'zh-CN,zh;q=0.9',
                    Cookie: options.noCookie ? '' : await cookieHeader(options.extraCookie || ''),
                    ...(options.headers || {}),
                },
                redirect: options.redirect || 'follow',
                signal: controller.signal,
            });
            const text = await response.text();
            const setCookies = typeof response.headers.getSetCookie === 'function'
                ? response.headers.getSetCookie()
                : response.headers.get('set-cookie') || '';
            return { status: response.status, ok: response.ok, text, setCookies };
        } catch (error) {
            // fetch 自己抛的时候（连不上 / 超时 / 被掐断）errno 是英文的，换成能看懂的话
            if (error && error.name === 'AbortError') throw new Error('bili: 请求超时，稍后再试');
            if (error && /^bili: /.test(String(error.message))) throw error;
            throw new Error('bili: 连不上 bilibili，可能被限流了，过一会儿再试');
        } finally {
            clearTimeout(timer);
        }
    }

    async function fetchJson(url, options = {}) {
        const answer = await rawRequest(url, options);
        if (!answer.ok) {
            // 412 是 bilibili 的风控拦截页（不是 JSON），单独说清楚，别让用户看着「HTTP 412」发愣
            if (answer.status === 412) throw new Error('bili: 操作太快被 bilibili 拦了，过几分钟再试');
            throw new Error(`bili: HTTP ${answer.status} ${url.split('?')[0]}`);
        }
        try {
            return { json: JSON.parse(answer.text), setCookies: answer.setCookies };
        } catch {
            throw new Error(`bili: bilibili 这次没返回数据（${url.split('?')[0]}）`);
        }
    }

    async function getJson(url, options = {}) {
        return (await fetchJson(url, options)).json;
    }

    /** 连着翻几十页收藏夹时难免被 bilibili 掐一下，抖一下就整张夹子打不开太亏，退避着重试两回。 */
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    async function getJsonRetry(url, options = {}, attempts = 3) {
        let last = null;
        for (let index = 0; index < attempts; index += 1) {
            try {
                return await getJson(url, options);
            } catch (error) {
                last = error;
                if (index < attempts - 1) await sleep(600 * (index + 1));
            }
        }
        throw last;
    }

    // ------------------------------------------------------------------- wbi

    async function wbiKeys() {
        if (state.wbi && Date.now() - state.wbi.at < 30 * 60 * 1000) return state.wbi;
        const json = await getJson(`${API}/x/web-interface/nav`);
        const images = json && json.data && json.data.wbi_img;
        if (!images) throw new Error('bili: bilibili 的签名参数没拿到，稍后再试');
        const keyOf = (url) => String(url).split('/').pop().split('.')[0];
        state.wbi = { img: keyOf(images.img_url), sub: keyOf(images.sub_url), at: Date.now() };
        return state.wbi;
    }

    async function wbiQuery(params) {
        const keys = await wbiKeys();
        const origin = keys.img + keys.sub;
        const mixin = MIXIN_TAB.map((index) => origin[index]).join('').slice(0, 32);
        const all = { ...params, wts: Math.floor(Date.now() / 1000) };
        const query = Object.keys(all)
            .sort()
            .map((key) => {
                const value = String(all[key]).replace(/[!'()*]/g, '');
                return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
            })
            .join('&');
        return `${query}&w_rid=${md5(query + mixin)}`;
    }

    /** 带 WBI 的端点失败时退回未签名版本（部分端点仍然收），再失败才抛。 */
    async function getJsonSigned(signedPath, unsignedPath, params) {
        try {
            const json = await getJson(`${signedPath}?${await wbiQuery(params)}`);
            if (json && json.code === 0) return json;
            api.log.warn('bili: signed endpoint answered non-zero', json && json.code, signedPath);
        } catch (error) {
            api.log.warn('bili: signed request failed, retrying unsigned', String(error && error.message));
        }
        const query = Object.keys(params)
            .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
            .join('&');
        const json = await getJson(`${unsignedPath}?${query}`);
        if (json && json.code !== 0) throw new Error(`bili: ${json.code} ${json.message || ''}`.trim());
        return json;
    }

    /**
     * 只重试「抖一下会好」的错误：412 风控、超时、连接被重置。
     * 没音频流、需要大会员这类重试一万次也一样，直接抛回去让上层说人话。
     */
    const RETRYABLE = /(412|请求太频繁|timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|network)/i;

    async function withRetry(run, attempts = 3) {
        let last = null;
        for (let index = 0; index < attempts; index += 1) {
            try {
                return await run();
            } catch (error) {
                last = error;
                const text = String((error && error.message) || error || '');
                if (index === attempts - 1 || !RETRYABLE.test(text)) break;
                await sleep(600 * (index + 1));
            }
        }
        throw last;
    }

    // ------------------------------------------------------------------ view
    async function getView(bvid) {
        const cached = state.views.get(bvid);
        if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.data;
        const json = await getJson(`${API}/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
        if (!json || json.code !== 0) throw new Error(`bili: ${(json && json.message) || '视频不存在'}`);
        state.views.set(bvid, { at: Date.now(), data: json.data });
        if (state.views.size > 300) state.views.delete(state.views.keys().next().value);
        return json.data;
    }

    function splitId(id) {
        const match = /^(.+?)(?:#(\d+))?$/.exec(String(id || '').trim());
        return { bvid: match ? match[1] : String(id || ''), page: match && match[2] ? Number(match[2]) : 1 };
    }

    function pickCid(view, page) {
        const pages = Array.isArray(view.pages) ? view.pages : [];
        const hit = pages.find((item) => Number(item.page) === Number(page)) || pages[0];
        return hit ? hit.cid : view.cid;
    }

    const secToText = (seconds) => {
        const safe = Math.max(0, Number(seconds) || 0);
        const h = Math.floor(safe / 3600);
        const m = Math.floor((safe % 3600) / 60);
        const s = Math.floor(safe % 60);
        return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
    };

    const cover = (url) => {
        const text = String(url || '');
        if (!text) return '';
        if (text.startsWith('//')) return `https:${text}`;
        // 接口有时给 http 的图床地址，播放器页面是安全上下文，降级会被拦。
        return text.replace(/^http:\/\//i, 'https://');
    };

    function videoToRaw(view) {
        return {
            bvid: view.bvid,
            title: view.title,
            author: (view.owner && view.owner.name) || '',
            cover: cover(view.pic),
            durationMs: (Number(view.duration) || 0) * 1000,
            pubdate: (Number(view.pubdate) || 0) * 1000,
            pages: (view.pages || []).map((page) => ({ page: page.page, cid: page.cid, part: page.part })),
        };
    }

    // --------------------------------------------------------------- playurl

    const AUDIO_ORDER = {
        standard: [30216, 30232, 30280],
        high: [30280, 30232, 30216],
        // bilibili 在 192K 和 FLAC 之间没有中间档：「超高」按 192K 处理，
        // 以前这个键根本不存在，值是靠 `|| AUDIO_ORDER.high` 兜出来的——行为一样，
        // 但写清楚，改 hight 时不会连带改掉它。
        ultra: [30280, 30232, 30216],
        lossless: [30251, 30250, 30280],
        hires: [30251, 30250, 30280],
    };

    /**
     * bilibili 的音频流 id 对应什么档位，给界面显示用。
     *
     * 宿主那个「默认音质」下拉只有四个通名（标准 / 极高 / 无损 / Hi-Res），
     * 对它自己的音源合适，对 bilibili 就成了黑话——用户不知道自己选的是 64K 还是 192K。
     */
    const AUDIO_LABEL = {
        30216: '64K',
        30232: '132K',
        30280: '192K',
        30250: '杜比',
        30251: 'FLAC',
    };

    function collectAudio(dash) {
        const list = [];
        const push = (item, kind) => {
            if (!item) return;
            const url = item.baseUrl || item.base_url;
            if (!url) return;
            const backups = item.backupUrl || item.backup_url || [];
            list.push({ id: Number(item.id) || 0, kind, urls: [url, ...backups] });
        };
        if (dash) {
            (dash.audio || []).forEach((item) => push(item, 'dash'));
            if (dash.dolby && Array.isArray(dash.dolby.audio)) dash.dolby.audio.forEach((item) => push(item, 'dolby'));
            if (dash.flac && dash.flac.audio) push(dash.flac.audio, 'flac');
        }
        return list;
    }

    // ----------------------------------------------------------------- proxy

    function ensureProxy() {
        if (state.server) return Promise.resolve(state.port);
        if (state.pending) return state.pending;
        state.pending = new Promise((resolve, reject) => {
            const server = http.createServer((request, response) => {
                handleProxy(request, response).catch((error) => {
                    api.log.warn('bili: proxy failed', String(error && error.message));
                    try {
                        response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
                        response.end(String((error && error.message) || 'proxy failed'));
                    } catch {
                        /* 已经发过头了 */
                    }
                });
            });
            // 端口耗尽 / 防火墙拦 listen 时，必须把 pending 放掉再抛。
            // 否则这个 Promise 会一直保持 rejected，之后每次取流都直接失败到重启宿主。
            const fail = (error) => {
                state.pending = null;
                try {
                    server.close();
                } catch {
                    /* 没起来就没得关 */
                }
                reject(error);
            };
            server.on('error', fail);
            server.listen(0, '127.0.0.1', () => {
                state.server = server;
                state.port = server.address().port;
                state.pending = null;
                api.log.info('bili: audio proxy listening', state.port);
                resolve(state.port);
            });
        });
        return state.pending;
    }

    async function handleProxy(request, response) {
        const url = new URL(request.url, 'http://127.0.0.1');
        if (url.pathname !== '/a') return response.writeHead(404).end();
        if (url.searchParams.get('t') !== state.token) return response.writeHead(403).end();

        let target;
        try {
            target = Buffer.from(url.searchParams.get('u') || '', 'base64url').toString('utf8');
        } catch {
            return response.writeHead(400).end();
        }
        let parsed;
        try {
            parsed = new URL(target);
        } catch {
            return response.writeHead(400).end();
        }
        if (!/^https?:$/.test(parsed.protocol) || !ALLOWED_HOSTS.test(parsed.hostname)) {
            return response.writeHead(403).end();
        }

        const headers = { 'User-Agent': UA, Referer: ORIGIN, Origin: ORIGIN };
        if (request.headers.range) headers.Range = request.headers.range;
        // 音频 CDN 只认 UA/Referer，不需要凭据。SESSDATA 只发给 bilibili 自己的接口域名，
        // 别让它跟着音频请求落到一堆第三方 CDN 上。
        if (COOKIE_HOSTS.test(parsed.hostname)) {
            const cookie = await cookieHeader();
            if (cookie) headers.Cookie = cookie;
        }

        // 上游没有超时的话，CDN 半通（TCP 建好但没有首字节）会让播放器永久停在缓冲，
        // 而且不会触发任何失败事件——用户看到的就是一直转圈。
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
        if (typeof timer.unref === 'function') timer.unref();
        let upstream;
        try {
            upstream = await fetch(parsed.toString(), { headers, redirect: 'follow', signal: controller.signal });
        } catch (error) {
            clearTimeout(timer);
            if (!response.headersSent) {
                response.writeHead(504, { 'Content-Type': 'text/plain; charset=utf-8' });
                response.end('upstream timeout');
            }
            return;
        }
        // 头到手就算成功，body 用 request 的 close 事件收尾
        clearTimeout(timer);
        const out = {
            'Content-Type': upstream.headers.get('content-type') || 'audio/mp4',
            'Accept-Ranges': upstream.headers.get('accept-ranges') || 'bytes',
            'Cache-Control': 'no-store',
        };
        const length = upstream.headers.get('content-length');
        const range = upstream.headers.get('content-range');
        if (length) out['Content-Length'] = length;
        if (range) out['Content-Range'] = range;
        response.writeHead(upstream.status, out);
        // 0.8.3：这里原先是 `Readable.fromWeb(upstream.body).pipe(response)`。
        // pipe 不转发 'error'，CDN 中途掐连接时 undici 抛的 `TypeError: terminated`
        // 会变成主进程 uncaughtException，整个 Folia 直接崩（三次崩溃报告都是它）。
        // pipeUpstream 用 stream.pipeline 接住两端错误并互相销毁。
        pipeUpstream({
            body: upstream.body,
            response,
            request,
            onError: (error) => api.log.warn('bili: proxy stream ended', String(error && (error.message || error))),
        });
    }

    /** 直链能不能被「不带 Referer 的播放器」直接取到。取不到就走反代。 */
    async function probeDirect(url) {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 6000);
            const response = await fetch(url, {
                headers: { 'User-Agent': UA, Range: 'bytes=0-1' },
                redirect: 'follow',
                signal: controller.signal,
            });
            clearTimeout(timer);
            return response.status === 200 || response.status === 206;
        } catch {
            return false;
        }
    }

    // ------------------------------------------------------------------- rpc

    /*
     * 短期记忆 + 同请求合并。
     *
     * 宿主画一面墙会连着问好几次同一个问题（getUserPlaylists 一刷新就被调、集合页翻页来回滚、
     * 歌词面板和播放器各自要一次字幕），每次都真去 bilibili 问一遍，既慢又容易撞风控（412）。
     * 这里是唯一一层「同一件事 60 秒内只做一次」，不是长期缓存——`clearCache` 会整片清掉。
     */
    const memo = new Map();
    const inflight = new Map();
    const TTL = {
        nav: 5 * 60 * 1000,
        folders: 60 * 1000,
        collected: 5 * 60 * 1000,
        liked: 60 * 1000,
        items: 60 * 1000,
        subtitles: 5 * 60 * 1000,
    };

    async function cached(key, ttl, run) {
        const now = Date.now();
        const hit = memo.get(key);
        if (hit && now - hit.at < ttl) return hit.value;
        const running = inflight.get(key);
        if (running) return running;
        const task = (async () => {
            try {
                const value = await run();
                remember(memo, key, value);
                return value;
            } finally {
                inflight.delete(key);
            }
        })();
        inflight.set(key, task);
        return task;
    }

    /** 丢掉某一类记忆（收藏夹条数、喜欢列表在收藏之后必须重读）。 */
    function forget(prefix) {
        for (const key of memo.keys()) {
            if (key.startsWith(prefix)) memo.delete(key);
        }
    }

    handle('status', async () => {
        await loadCookie();
        try {
            const json = await getJson(`${API}/x/web-interface/nav`);
            const data = (json && json.data) || {};
            return {
                loggedIn: Boolean(data.isLogin),
                mid: data.mid ? String(data.mid) : '',
                uname: data.uname || '',
                face: cover(data.face),
                saved: Boolean(state.cookie),
            };
        } catch (error) {
            return { loggedIn: false, mid: '', uname: '', face: '', saved: Boolean(state.cookie), error: String(error.message) };
        }
    });

    handle('qr.generate', async () => {
        const json = await getJson(`${PASSPORT}/x/passport-login/web/qrcode/generate?source=main-fe-header`);
        const data = (json && json.data) || {};
        if (json.code !== 0 || !data.url) throw new Error('bili: 二维码生成失败');
        return { url: data.url, key: data.qrcode_key, expiresIn: 180 };
    });

    handle('qr.poll', async ({ key }) => {
        if (!key) throw new Error('bili: 二维码参数不对，重新扫一次');
        const { json, setCookies } = await fetchJson(
            `${PASSPORT}/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}&source=main-fe-header`,
        );
        const data = (json && json.data) || {};
        const code = Number(data.code);
        if (code === 86101) return { stage: 'waiting' };
        if (code === 86090) return { stage: 'scanned' };
        if (code === 86038) return { stage: 'expired' };
        if (code !== 0) return { stage: 'error', message: data.message || `code ${code}` };

        // 两路取 Cookie，值一律不 decode（SESSDATA 里的 %2C 是签名的一部分）：
        //   1. body 的 data.url（老行为，参数就在 URL 上）；
        //   2. 响应的 Set-Cookie（bilibili 现在常常只给这个，data.url 是空串——实测未扫码时 url 就是 ""）。
        let parts = mergeCookies(passportCookiesFromUrl(data.url), cookiesFromSetCookie(setCookies));

        // 3. 还不够就跟一次回跳地址：crossDomain 本身也会下发 Cookie，不跟随跳转以免跑到首页。
        if (!hasSession(parts.join('; ')) && data.url) {
            try {
                const hop = await rawRequest(data.url, { redirect: 'manual', noCookie: true });
                parts = mergeCookies(parts, cookiesFromSetCookie(hop.setCookies));
            } catch (error) {
                api.log.warn('bili: crossDomain hop failed', String(error && error.message));
            }
        }

        if (!hasSession(parts.join('; '))) {
            const seen = cookiesFromSetCookie(setCookies).length;
            const hint = `data.url ${data.url ? '有内容' : '为空'}、Set-Cookie ${seen} 条`;
            api.log.warn('bili: qr poll succeeded without SESSDATA', hint);
            return {
                stage: 'error',
                message: `扫码已确认，但没拿到 SESSDATA（${hint}）。请用下面的「手动粘贴 Cookie」——从浏览器 F12 复制 SESSDATA 即可。`,
            };
        }
        const raw = parts.join('; ');
        const stored = await saveCookie(raw);
        state.views.clear();
        state.wbi = null;
        forget('nav');
        forget('folders:');
        forget('liked:');

        // 写进去不代表能用：立刻拿它问一次 nav，别让界面显示「登录成功」其实没登。
        const check = await getJson(`${API}/x/web-interface/nav`).catch(() => null);
        const nav = (check && check.data) || {};
        if (!nav.isLogin) {
            return {
                stage: 'error',
                message: hasSession(raw)
                    ? '扫码成功但 Cookie 没通过校验，可能需要在手机上完成二次验证后重试'
                    : '扫码成功但没拿到有效的 SESSDATA',
            };
        }
        return { stage: 'ok', uname: nav.uname || '', mid: nav.mid ? String(nav.mid) : '', encrypted: stored };
    });

    handle('logout', async () => {
        await clearCookie();
        forget('nav');
        forget('folders:');
        forget('liked:');
        forget('items:');
        return { ok: true };
    });

    /** 手动粘 Cookie：设置里的密钥字段，或首页页签的输入框都走这里。 */
    handle('setCookie', async ({ cookie } = {}) => {
        const raw = normalizeCookieInput(cookie);
        if (!raw) throw new Error('bili: 登录凭据是空的');
        if (!hasSession(raw)) throw new Error('bili: 凭据里没有登录信息，读不到收藏夹');
        await saveCookie(raw);
        state.views.clear();
        state.wbi = null;
        forget('nav');
        forget('folders:');
        forget('liked:');
        const check = await getJson(`${API}/x/web-interface/nav`).catch(() => null);
        const nav = (check && check.data) || {};
        if (!nav.isLogin) {
            await clearCookie();
            throw new Error('bili: 这条凭据已经失效，重新扫码登录一次');
        }
        return { loggedIn: true, uname: nav.uname || '', mid: nav.mid ? String(nav.mid) : '' };
    });

    handle('folders', async ({ upMid } = {}) => {
        let mid = String(upMid || '').trim();
        const wantsOther = Boolean(mid);
        if (!wantsOther) {
            mid = await ownMid();
            if (!mid) {
                throw new Error('bili: 先登录才能读你的收藏夹（书库首页点音源扫码）');
            }
        } else if (!/^\d+$/.test(mid)) {
            throw new Error('bili: UID 应该是纯数字');
        }
        const list = await foldersOf(mid);
        return {
            mid,
            owner: wantsOther ? await ownerName(mid) : '',
            items: list.map(folderToRaw),
        };
    });

    /**
     * 「我收藏的」：别人公开的收藏夹（type 11）和视频合集（type 21）。
     *
     * `platform=web` 才会把收藏的视频合集一起返回（实测一页 20 条，data.has_more 翻页）。
     * 分类交给渲染端的 lib/collected.mjs 做（纯函数、可单测），这里只压平字段。
     * 拿不到自己的 mid（没登录 / Cookie 过期）就安静返回空，不能连累整面歌单墙。
     */
    handle('collected', async () => {
        const mid = await ownMid();
        if (!mid) return { mid: '', loggedIn: false, items: [] };
        return cached(`collected:${mid}`, TTL.collected, async () => {
            const all = [];
            // 一次最多 10 页（200 条）；收藏几百个夹子的账号也不要在这里打穿风控。
            for (let pn = 1; pn <= 10; pn += 1) {
                const json = await getJson(
                    `${API}/x/v3/fav/folder/collected/list?up_mid=${encodeURIComponent(mid)}&pn=${pn}&ps=20&platform=web`,
                );
                if (!json || json.code !== 0) {
                    if (pn === 1) throw new Error(`bili: 读不到「我收藏的」（${(json && json.code) || ''}）`);
                    break;
                }
                const data = json.data || {};
                all.push(...(data.list || []));
                if (!data.has_more) break;
            }
            return {
                mid,
                loggedIn: true,
                items: all.map((item) => ({
                    id: String((item && item.id) || ''),
                    mid: String((item && item.mid) || ''),
                    type: Number(item && item.type) || 0,
                    title: String((item && item.title) || ''),
                    cover: cover(item && item.cover),
                    owner: String((item && item.upper && item.upper.name) || ''),
                    count: Number(item && item.media_count) || 0,
                    state: Number(item && item.state) || 0,
                })),
            };
        });
    });

    async function ownMid() {
        return cached('nav', TTL.nav, async () => {
            try {
                const json = await getJson(`${API}/x/web-interface/nav`);
                return String((json && json.data && json.data.mid) || '');
            } catch {
                return '';
            }
        });
    }

    /** 某个账号建的全部收藏夹（公开信息，别人的也读得到）。 */
    async function foldersOf(mid) {
        return cached(`folders:${mid}`, TTL.folders, async () => {
            const json = await getJson(`${API}/x/v3/fav/folder/created/list-all?up_mid=${encodeURIComponent(mid)}&web_location=333.1387`);
            if (!json || json.code !== 0) throw new Error(`bili: 收藏夹读不到（${(json && json.code) || ''}）`);
            return (json.data && json.data.list) || [];
        });
    }

    function folderToRaw(folder) {
        return {
            id: String(folder.id),
            title: folder.title,
            count: Number(folder.media_count) || 0,
            cover: cover(folder.cover),
            isDefault: Boolean(folder.fav_state === 1),
        };
    }

    /** 默认收藏夹：bilibili 把「默认」标成 fav_state = 1，没有就取第一个。 */
    async function defaultFolderId() {
        const mid = await ownMid();
        if (!mid) return '';
        try {
            const list = await foldersOf(mid);
            const hit = list.find((folder) => Number(folder.fav_state) === 1) || list[0];
            return hit ? String(hit.id) : '';
        } catch {
            return '';
        }
    }

    /** 写操作要的 csrf（就是 Cookie 里的 bili_jct）。 */
    async function csrfToken() {
        const raw = await loadCookie();
        const hit = /(?:^|;\s*)bili_jct=([^;]+)/.exec(raw);
        return hit ? hit[1].trim() : '';
    }

    /**
     * 收藏 / 取消收藏一首歌。
     *
     * bilibili 把「喜欢」做成收藏夹里的条目——这也是为什么设置里要选一个收藏夹当「喜欢」。
     * `rid` 要的是 avid，bvid 得先查一次 view。
     */
    handle('favDeal', async ({ id, liked = true, folder } = {}) => {
        const { bvid } = splitId(id);
        if (!bvid) throw new Error('bili: 缺少视频 id');
        const csrf = await csrfToken();
        if (!csrf) throw new Error('bili: 先扫码登录才能收藏');
        let fid = String(folder || '').trim();
        if (!fid) fid = await defaultFolderId();
        if (!fid) throw new Error('bili: 还没有可用的收藏夹');
        const view = await getView(bvid);
        const body = new URLSearchParams({
            rid: String(view.aid),
            type: '2',
            add_media_ids: liked ? fid : '',
            del_media_ids: liked ? '' : fid,
            platform: 'web',
            csrf,
        });
        const { json } = await fetchJson(`${API}/x/v3/fav/resource/deal`, {
            method: 'POST',
            body: body.toString(),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        if (!json || json.code !== 0) {
            const text = (json && (json.message || json.code)) || '';
            throw new Error(`bili: ${liked ? '收藏' : '取消收藏'}没成功 ${text}`.trim());
        }
        // 条数和「喜欢」列表都变了：让下一次读重新问。
        forget('folders:');
        forget('liked:');
        forget('items:');
        return { ok: true, folder: fid };
    });

    /**
     * 一个收藏夹里的全部 bvid，一次请求拿完（这个接口不分页）。
     * 宿主拿它判断哪首歌已经「喜欢」了——心形按钮的初始状态就靠它。
     */
    handle('likedIds', async ({ folder } = {}) => {
        let fid = String(folder || '').trim();
        if (!fid) fid = await defaultFolderId();
        if (!fid) return { ids: [], folder: '' };
        const ids = await cached(`liked:${fid}`, TTL.liked, async () => {
            const json = await getJson(`${API}/x/v3/fav/resource/ids?media_id=${encodeURIComponent(fid)}&platform=web`);
            if (!json || json.code !== 0) throw new Error(`bili: 「喜欢」列表读不到（${(json && json.code) || ''}）`);
            return (json.data || [])
                .map((item) => (item && (item.bvid || item.bv_id)) || '')
                .filter(Boolean);
        });
        return { ids, folder: fid };
    });


    /** 他人的昵称。读不到就空字符串——不影响浏览，只是标题少一段。 */
    async function ownerName(mid) {
        return cached(`owner:${mid}`, TTL.folders, async () => {
            try {
                const json = await getJson(`${API}/x/web-interface/card?mid=${encodeURIComponent(mid)}`);
                return (json && json.data && json.data.card && json.data.card.name) || '';
            } catch {
                return '';
            }
        });
    }

    handle('folderItems', async ({ mediaId, page = 1 }) => {
        const pn = Number(page) || 1;
        return cached(`items:${mediaId}:${pn}`, TTL.items, async () => {
            const json = await getJson(
                `${API}/x/v3/fav/resource/list?media_id=${encodeURIComponent(mediaId)}&pn=${pn}&ps=20&keyword=&order=mtime&type=0&tid=0&platform=web`,
            );
            if (!json || json.code !== 0) throw new Error(`bili: 收藏夹内容读不到（${(json && json.code) || ''}）`);
            const data = json.data || {};
            const info = data.info || {};
            // 失效 / 私有视频**不删**，只打 playable:false 留着占位。
            // 删掉的话这一页就短于 20 条，调用方的 offset（原始下标）立刻错位：
            // 下一次会落回上一页中间交付重复曲目，尾部整页失效时还会原地打转。
            const list = (data.medias || []).map((item, index) => ({
                bvid: item && item.bvid ? item.bvid : '',
                title: (item && item.title) || '',
                author: (item && item.upper && item.upper.name) || '',
                cover: cover(item && item.cover),
                durationMs: (Number(item && item.duration) || 0) * 1000,
                pubdate: (Number(item && item.ctime) || 0) * 1000,
                index,
                playable: Boolean(item && item.bvid
                    && (item.attr === 0 || item.attr === undefined)
                    && String(item.title || '') !== '已失效视频'),
            }));
            return {
                title: info.title || '',
                owner: (info.upper && info.upper.name) || '',
                total: Number(info.media_count) || 0,
                hasMore: Boolean(data.has_more),
                items: list,
            };
        });
    });

    // ---------------------------------------------- 额外的公开收藏夹 / 合集 / 系列
    //
    // 用户可以在设置里贴链接，把别人的公开收藏夹、UP 主的合集或系列也当歌单放到墙上。
    // 这三种列表的接口未登录就能读（实测），所以不需要账号；只有「喜欢」和自建收藏夹要登录。

    const EXTRA_TTL = 10 * 60 * 1000;
    let extraCache = null;
    let extraSaveTimer = null;
    /** mid → { at, seasons, series }：系列的名字/封面只在「合集与系列列表」里，按 UP 主缓存一次。 */
    const seriesIndex = new Map();

    async function loadExtraCache() {
        if (extraCache) return extraCache;
        try {
            const saved = api.storage && typeof api.storage.get === 'function' ? await api.storage.get('extras') : null;
            extraCache = saved && typeof saved === 'object' ? saved : {};
        } catch {
            extraCache = {};
        }
        return extraCache;
    }

    function scheduleExtraSave() {
        if (extraSaveTimer) return;
        extraSaveTimer = setTimeout(() => {
            extraSaveTimer = null;
            try {
                if (api.storage && typeof api.storage.set === 'function') {
                    Promise.resolve(api.storage.set('extras', extraCache)).catch(() => {});
                }
            } catch {
                /* 存不下就下次再查 */
            }
        }, 1500);
        if (typeof extraSaveTimer.unref === 'function') extraSaveTimer.unref();
    }

    /** UP 主的合集与系列列表（接口一页最多 20 个），拿名字和封面。 */
    async function listOfOwner(mid) {
        const cached = seriesIndex.get(mid);
        if (cached && Date.now() - cached.at < EXTRA_TTL) return cached;
        const seasons = new Map();
        const series = new Map();
        // page_size 超过 20 会被 -400 挡回来（踩过），所以一页 20、最多翻三页。
        for (let page = 1; page <= 3; page += 1) {
            const json = await getJson(
                `${API}/x/polymer/web-space/seasons_series_list?mid=${encodeURIComponent(mid)}&page_num=${page}&page_size=20`,
            );
            if (!json || json.code !== 0) {
                if (page === 1) throw new Error(`读不到这个 UP 的合集（${(json && json.code) || '?'}）`);
                break;
            }
            const lists = (json.data && json.data.items_lists) || {};
            (lists.seasons_list || []).forEach((item) => {
                const meta = item.meta || {};
                if (meta.season_id) seasons.set(String(meta.season_id), meta);
            });
            (lists.series_list || []).forEach((item) => {
                const meta = item.meta || {};
                if (meta.series_id) series.set(String(meta.series_id), meta);
            });
            const total = Number((lists.page && lists.page.total) || 0);
            if (seasons.size + series.size >= total) break;
        }
        const entry = { at: Date.now(), seasons, series };
        seriesIndex.set(mid, entry);
        return entry;
    }

    /** 一条引用 → 歌单元信息（名字、条数、封面、UP 主）。 */
    async function resolveExtra(ref) {
        if (ref.kind === 'folder') {
            const json = await getJson(
                `${API}/x/v3/fav/resource/list?media_id=${encodeURIComponent(ref.mediaId)}&pn=1&ps=1&platform=web`,
            );
            if (!json || json.code !== 0) throw new Error(`收藏夹读不到（${(json && json.code) || '?'}）`);
            const info = json.data && json.data.info;
            if (!info) throw new Error('收藏夹不存在，或没有公开');
            return {
                name: info.title || '未命名收藏夹',
                count: Number(info.media_count) || 0,
                cover: cover(info.cover),
                owner: (info.upper && info.upper.name) || '',
                mid: String((info.upper && info.upper.mid) || info.mid || ''),
            };
        }
        const lists = await listOfOwner(ref.mid);
        const meta = (ref.kind === 'season' ? lists.seasons : lists.series).get(String(ref.sid));
        if (!meta || !meta.name) throw new Error(ref.kind === 'season' ? '找不到这个合集' : '找不到这个系列');
        return {
            name: meta.name,
            count: Number(meta.total) || 0,
            cover: cover(meta.cover),
            owner: (meta.upper && meta.upper.name) || (await ownerName(ref.mid)),
            mid: String(ref.mid),
        };
    }

    handle('extras', async ({ refs } = {}) => {
        const cache = await loadExtraCache();
        const wanted = Array.isArray(refs) ? refs.filter((ref) => ref && ref.key) : [];
        const items = [];
        let changed = false;
        for (const ref of wanted) {
            const key = String(ref.key);
            const saved = cache[key];
            if (saved && saved.info && Date.now() - Number(saved.at || 0) < EXTRA_TTL) {
                items.push({ key, ok: true, ...saved.info });
                continue;
            }
            try {
                const info = await resolveExtra(ref);
                cache[key] = { at: Date.now(), info };
                changed = true;
                items.push({ key, ok: true, ...info });
            } catch (error) {
                // 记住失败时的名字，墙上一眼能看出是哪条链接坏了
                items.push({ key, ok: false, error: String((error && error.message) || error), name: saved && saved.info ? saved.info.name : '' });
            }
        }
        if (changed) scheduleExtraSave();
        return { items };
    });

    const itemOfArchive = (archive) => ({
        bvid: archive.bvid,
        title: archive.title,
        author: '',
        cover: cover(archive.pic),
        durationMs: (Number(archive.duration) || 0) * 1000,
        pubdate: (Number(archive.pubdate || archive.ctime) || 0) * 1000,
    });

    /** 额外列表的一页。`page` 从 1 开始，一页 20 条，和宿主的换算一致。 */
    handle('extraItems', async ({ ref, page = 1, owner = '' } = {}) => {
        const number = Math.max(1, Math.min(50, Number(page) || 1));
        if (!ref || !ref.kind) throw new Error('bili: 链接不完整，重新粘贴一次');
        const withOwner = (items) => items.map((item) => ({ ...item, author: item.author || owner }));

        if (ref.kind === 'folder') {
            const json = await getJson(
                `${API}/x/v3/fav/resource/list?media_id=${encodeURIComponent(ref.mediaId)}&pn=${number}&ps=20&keyword=&order=mtime&type=0&tid=0&platform=web`,
            );
            if (!json || json.code !== 0) throw new Error(`bili: 列表内容读不到（${(json && json.code) || ''}）`);
            const data = json.data || {};
            const info = data.info || {};
            const items = (data.medias || []).map((item, index) => ({
                bvid: item && item.bvid ? item.bvid : '',
                title: (item && item.title) || '',
                author: (item && item.upper && item.upper.name) || owner,
                cover: cover(item && item.cover),
                durationMs: (Number(item && item.duration) || 0) * 1000,
                pubdate: (Number(item && item.ctime) || 0) * 1000,
                index,
                // 同 folderItems：失效条目留着占位，交付方过滤
                playable: Boolean(item && item.bvid
                    && (item.attr === 0 || item.attr === undefined)
                    && String(item.title || '') !== '已失效视频'),
            }));
            return {
                title: info.title || '',
                owner: (info.upper && info.upper.name) || owner,
                total: Number(info.media_count) || 0,
                hasMore: Boolean(data.has_more),
                items,
            };
        }

        if (ref.kind === 'season') {
            const json = await getJson(
                `${API}/x/polymer/web-space/seasons_archives_list?mid=${encodeURIComponent(ref.mid)}&season_id=${encodeURIComponent(ref.sid)}&sort_reverse=false&page_num=${number}&page_size=20`,
            );
            if (!json || json.code !== 0) throw new Error(`bili: 合集内容读不到（${(json && json.code) || ''}）`);
            const data = json.data || {};
            const pageInfo = data.page || {};
            const total = Number(pageInfo.total) || 0;
            const items = withOwner((data.archives || []).map(itemOfArchive));
            // 一页多少条以接口自己报的 page_size 为准（写死 20，接口改成 30 就会少翻半页）
            const size = Number(pageInfo.page_size) || 20;
            const hasMore = pageInfo.has_more != null
                ? Boolean(pageInfo.has_more)
                : items.length > 0 && number * size < total;
            return {
                title: (data.meta && data.meta.name) || '',
                owner: owner,
                total,
                // 空页必须收敛：total 是接口给的原始总数，翻过头时别再让宿主原地重试
                hasMore: items.length > 0 && hasMore,
                items,
            };
        }

        const json = await getJson(
            `${API}/x/series/archives?mid=${encodeURIComponent(ref.mid)}&series_id=${encodeURIComponent(ref.sid)}&only_normal=true&sort=desc&pn=${number}&ps=20`,
        );
        if (!json || json.code !== 0) throw new Error(`bili: 系列内容读不到（${(json && json.code) || ''}）`);
        const data = json.data || {};
        const pageInfo = data.page || {};
        const total = Number(pageInfo.total) || 0;
        const items = withOwner((data.archives || []).map(itemOfArchive));
        const size = Number(pageInfo.page_size) || 20;
        const hasMore = pageInfo.has_more != null ? Boolean(pageInfo.has_more) : number * size < total;
        return { title: '', owner, total, hasMore: items.length > 0 && hasMore, items };
    });


    /**
     * 收藏夹自己的封面：bilibili 的收藏夹接口几乎不返回封面（cover 基本是空串），
     * 网页上看到的那张图其实是夹里前几首的封面拼的。这里按同样思路取前四条。
     *
     * 这个接口特别容易 -412（翻完一张大收藏夹之后再问十条封面必挂），而封面本身一周也不变，
     * 所以取到的存进数据文件，重启后直接用，不再去撞风控。
     */
    const COVER_TTL = 7 * 24 * 60 * 60 * 1000;
    let coverCache = null;
    let coverSaveTimer = null;

    async function loadCoverCache() {
        if (coverCache) return coverCache;
        try {
            const saved = api.storage && typeof api.storage.get === 'function' ? await api.storage.get('covers') : null;
            coverCache = saved && typeof saved === 'object' ? saved : {};
        } catch {
            coverCache = {};
        }
        return coverCache;
    }

    function scheduleCoverSave() {
        if (coverSaveTimer) return;
        coverSaveTimer = setTimeout(() => {
            coverSaveTimer = null;
            try {
                if (api.storage && typeof api.storage.set === 'function') {
                    Promise.resolve(api.storage.set('covers', coverCache)).catch(() => {});
                }
            } catch {
                /* 存不下就算了，下次再取 */
            }
        }, 1500);
        if (typeof coverSaveTimer.unref === 'function') coverSaveTimer.unref();
    }

    handle('folderCover', async ({ mediaId }) => {
        const key = String(mediaId);
        const cache = await loadCoverCache();
        const saved = cache[key];
        if (saved && Array.isArray(saved.covers) && saved.covers.length && Date.now() - Number(saved.at || 0) < COVER_TTL) {
            return { covers: saved.covers, cached: true };
        }

        const json = await getJson(
            `${API}/x/v3/fav/resource/list?media_id=${encodeURIComponent(mediaId)}&pn=1&ps=4&keyword=&order=mtime&type=0&tid=0&platform=web`,
        );
        if (!json || json.code !== 0) {
            const code = json && json.code;
            // 抛出去而不是回空数组：渲染进程要靠这条消息判断「是被限流了」，好停下来歇一会儿
            if (code === -412 || code === -352) throw new Error('bili: 封面读太快被 bilibili 拦了，过几分钟再试');
            return { covers: [] };
        }
        const medias = (json.data && json.data.medias) || [];
        const covers = medias
            .filter((item) => item && item.cover && String(item.title || '') !== '已失效视频')
            .map((item) => cover(item.cover))
            .slice(0, 4);
        if (covers.length) {
            cache[key] = { at: Date.now(), covers };
            scheduleCoverSave();
        }
        return { covers };
    });

    /** 只读已经存下来的封面（不联网）：宿主画歌单卡时先要一份，没有的再慢慢补。 */
    handle('covers', async () => {
        const cache = await loadCoverCache();
        const now = Date.now();
        const result = {};
        Object.keys(cache).forEach((key) => {
            const entry = cache[key];
            if (!entry || !Array.isArray(entry.covers) || !entry.covers.length) return;
            if (now - Number(entry.at || 0) >= COVER_TTL) return;
            result[key] = entry.covers;
        });
        return { covers: result };
    });

    /**
     * 补封面：收藏夹接口不返回封面，只能进夹里取第一条视频的图。
     *
     * 串行 + 每条之间隔 700ms——并发十几条必然被 bilibili 412（实测）。
     * **0.8.4 修正两处**：
     *   1. 以前是 `if (filled) await sleep(700)`，只有成功才等；空夹 / 私有夹会
     *      `continue` 掉，于是 40 个 id 能毫秒级连发，正好踩在风控上。现在失败也等。
     *   2. 空结果以前不写缓存，于是每次库墙刷新都会把同一批空夹重问一遍。
     *      现在按 5 分钟负缓存记下来，刷墙只读本地。
     */
    const COVER_MISS_TTL = 5 * 60 * 1000;
    let filling = null;
    handle('fillCovers', async ({ ids } = {}) => {
        const cache = await loadCoverCache();
        const now = Date.now();
        const wanted = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean);
        const missing = wanted.filter((id) => {
            const entry = cache[id];
            const at = Number((entry && entry.at) || 0);
            if (entry && Array.isArray(entry.covers) && entry.covers.length) {
                return !(now - at < COVER_TTL);
            }
            // 空结果：5 分钟内不再问（负缓存）
            return !(entry && now - at < COVER_MISS_TTL);
        });
        if (!missing.length) return { covers: cache, filled: 0 };
        if (filling) return filling;

        filling = (async () => {
            let filled = 0;
            let attempted = 0;
            for (const id of missing.slice(0, 40)) {
                if (attempted) await sleep(700);
                attempted += 1;
                try {
                    const json = await getJson(
                        `${API}/x/v3/fav/resource/list?media_id=${encodeURIComponent(id)}&pn=1&ps=4&keyword=&order=mtime&type=0&tid=0&platform=web`,
                    );
                    if (!json || json.code !== 0) {
                        cache[id] = { at: Date.now(), covers: [] };
                        continue;
                    }
                    const medias = (json.data && json.data.medias) || [];
                    const list = medias
                        .filter((item) => item && item.cover && String(item.title || '') !== '已失效视频')
                        .map((item) => cover(item.cover))
                        .slice(0, 4);
                    if (!list.length) {
                        // 空夹、全是失效视频：记一笔负结果，别每次刷墙都重来
                        cache[id] = { at: Date.now(), covers: [] };
                        continue;
                    }
                    cache[id] = { at: Date.now(), covers: list };
                    filled += 1;
                } catch (error) {
                    api.log.warn('bili: 封面取不到', id, String(error && error.message));
                    break;
                }
            }
            if (attempted) scheduleCoverSave();
            return { covers: cache, filled };
        })();

        try {
            return await filling;
        } finally {
            filling = null;
        }
    });

    /**
     * 一个收藏夹的全部曲目。页面要一次画完整面墙，也要一次把整张收藏夹丢进队列，
     * 一页二十条来回问十几趟太慢，所以在这里按页抓完。`limit` 是页数上限（默认 50 页 = 1000 条）。
     */
    handle('folderAll', async ({ mediaId, maxPages = 50 } = {}) => {
        const pages = Math.min(60, Math.max(1, Number(maxPages) || 50));
        const items = [];
        let total = 0;
        let title = '';
        let owner = '';
        let truncated = false;
        for (let page = 1; page <= pages; page += 1) {
            if (page > 1) await sleep(150);
            const json = await getJsonRetry(
                `${API}/x/v3/fav/resource/list?media_id=${encodeURIComponent(mediaId)}&pn=${page}&ps=20&keyword=&order=mtime&type=0&tid=0&platform=web`,
            );
            if (!json || json.code !== 0) {
                if (!items.length) {
                    const code = json && json.code;
                    if (code === -412 || code === -352) throw new Error('bili: 操作太快被 bilibili 拦了，过几分钟再试');
                    throw new Error(`bili: 收藏夹内容读不到（${code || ''}）`.trim());
                }
                break;
            }
            const data = json.data || {};
            const info = data.info || {};
            title = title || info.title || '';
            owner = owner || (info.upper && info.upper.name) || '';
            total = Number(info.media_count) || total;
            const batch = (data.medias || [])
                .filter((item) => item && item.bvid && (item.attr === 0 || item.attr === undefined))
                .filter((item) => String(item.title || '') !== '已失效视频')
                .map((item) => ({
                    bvid: item.bvid,
                    title: item.title,
                    author: (item.upper && item.upper.name) || '',
                    cover: cover(item.cover),
                    durationMs: (Number(item.duration) || 0) * 1000,
                    pubdate: (Number(item.ctime) || 0) * 1000,
                }));
            items.push(...batch);
            if (!data.has_more) break;
            if (page === pages) truncated = true;
        }
        return { title, owner, total, items, truncated };
    });

    handle('search', async ({ keyword, page = 1 }) => {
        const query = String(keyword || '').trim();
        if (!query) return { items: [], total: 0, hasMore: false };
        await ensureBuvid();
        const json = await getJsonSigned(
            `${API}/x/web-interface/wbi/search/type`,
            `${API}/x/web-interface/search/type`,
            { search_type: 'video', keyword: query, page: Number(page) || 1, page_size: 20 },
        );
        const data = (json && json.data) || {};
        const result = Array.isArray(data.result) ? data.result : [];
        // 课堂（ketang）和无 bvid 的条目照样占位置：直接过滤会把一页 20 条变成 19 条，
        // 调用方按原始下标翻页就会和接口的页码错开，翻两屏就开始重复。
        const items = result.map((item, index) => ({
            bvid: item && item.bvid ? item.bvid : '',
            title: String((item && item.title) || '').replace(/<[^>]+>/g, ''),
            author: (item && item.author) || '',
            cover: cover(item && item.pic),
            durationMs: parseDuration(item && item.duration),
            pubdate: (Number(item && item.pubdate) || 0) * 1000,
            description: String((item && item.description) || '').replace(/<[^>]+>/g, ''),
            index,
            playable: Boolean(item && item.bvid && item.type !== 'ketang'),
        }));
        return { items, total: Number(data.numResults) || 0, hasMore: (Number(page) || 1) < (Number(data.numPages) || 1) };
    });

    // 书库首页「探索」页签 / 推荐 feed
    // 宿主 getHomeFeed() 只认集合卡，歌曲瀑布流走 omni.getExploreFeed() →
    // provider.explore.getFeed / getSectionItems，两边都用这个 RPC 拿首页推荐 feed。
    // fresh_idx 是「已看过多少条」的游标，一直往后累加即可，没有人为上界
    // （0.8.1 实测 fresh_idx=2001 仍正常返回 30 条）。
    handle('recommend', async ({ ps = MAX_FEED_PAGE, freshIdx = 1 } = {}) => {
        const size = Math.min(MAX_FEED_PAGE, Math.max(10, Number(ps) || MAX_FEED_PAGE));
        const rawIdx = Number(freshIdx);
        const idx = Number.isFinite(rawIdx) && rawIdx > 0 ? Math.floor(rawIdx) : 1;
        await ensureBuvid();
        const json = await getJsonSigned(
            `${API}/x/web-interface/wbi/index/top/feed/rcmd`,
            `${API}/x/web-interface/index/top/feed/rcmd`,
            {
                ps: size,
                fresh_type: 4,
                fresh_idx: idx,
                fresh_idx_1h: idx,
                feed_version: 'V8',
                homepage_ver: 1,
            },
        );
        const data = (json && json.data) || {};
        const items = normalizeFeedItems(data.item);
        return {
            items,
            nextFreshIdx: nextFeedCursor(idx, items.length),
            signedIn: hasSession(state.cookie),
        };
    });

    // --------------------------------------------- 0.7.26 新搜索页：合集 / 收藏
    // bilibili 没有「搜收藏夹 / 合集」的 search_type（media_list / fav / collection /
    // season 全被 -1200「被降级过滤的请求」挡回来）。合集改从视频搜索结果反查：
    // view?bvid= 会带 ugc_season = { id, title, cover, mid, ep_count, sections[].episodes[] }，
    // 拿到的 mid + season_id 正好对得上 seasons_archives_list，点开就能播。
    // 前 12 条视频通常能反查出 5~8 个合集，够铺满一页卡片；再多就要吃 -412 了。
    const SEASON_PROBE = 12;
    const PROBE_BATCH = 6;

    handle('searchSeasons', async ({ keyword, page = 1 } = {}) => {
        const query = String(keyword || '').trim();
        const pn = Math.max(1, Number(page) || 1);
        if (!query) return { items: [], hasMore: false, page: pn };
        return cached(`seasons:${query.toLowerCase()}:${pn}`, TTL.collected, async () => {
            await ensureBuvid();
            const json = await getJsonSigned(
                `${API}/x/web-interface/wbi/search/type`,
                `${API}/x/web-interface/search/type`,
                { search_type: 'video', keyword: query, page: pn, page_size: 20 },
            );
            const data = (json && json.data) || {};
            const probes = (Array.isArray(data.result) ? data.result : [])
                .filter((item) => item && item.bvid && item.type !== 'ketang')
                .slice(0, SEASON_PROBE);
            const seasons = new Map();
            for (let start = 0; start < probes.length; start += PROBE_BATCH) {
                // 批间留 200ms：3 并发是接口能接受的，但一批接一批地打仍然会吃 -412。
                if (start) await sleep(200);
                const batch = probes.slice(start, start + PROBE_BATCH);
                // 并发别开太大：短时间几十个 view 会吃 -412。getView 自己也带 10 分钟缓存。
                const answers = await Promise.all(batch.map(async (item) => {
                    try {
                        const view = await getView(item.bvid);
                        const season = view && view.ugc_season;
                        if (!season || !season.id || !season.mid) return null;
                        const episodes = (season.sections || []).flatMap((section) => section && section.episodes || []);
                        const first = episodes[0] || {};
                        return {
                            sid: String(season.id),
                            mid: String(season.mid),
                            name: String(season.title || '').trim() || '未命名合集',
                            cover: cover(season.cover),
                            count: Number(season.ep_count) || episodes.length || 0,
                            owner: String((first.arc && first.arc.author && first.arc.author.name) || item.author || ''),
                        };
                    } catch {
                        return null;
                    }
                }));
                for (const season of answers) {
                    if (season && !seasons.has(season.sid)) seasons.set(season.sid, season);
                }
            }
            const numPages = Number(data.numPages) || 1;
            return { items: [...seasons.values()], hasMore: pn < numPages, page: pn };
        });
    });

    /**
     * 收藏夹里有没有标题含关键词的视频。fav/resource/list 的 keyword 参数就是
     * bilibili 收藏夹页面那个「搜索收藏」；这里仍在渲染进程复核一次标题，
     * 免得接口哪天忽略 keyword、把第一页全都当成命中。
     */
    handle('matchFolders', async ({ keyword, ids = [] } = {}) => {
        const query = String(keyword || '').trim();
        const list = (Array.isArray(ids) ? ids : [])
            .map((id) => String(id || '')).filter((id) => /^\d+$/.test(id)).slice(0, 40);
        if (!query || !list.length) return { hits: {} };
        return cached(`folderMatch:${query.toLowerCase()}:${list.join(',')}`, TTL.items, async () => {
            const hits = {};
            const needle = query.toLowerCase();
            for (let start = 0; start < list.length; start += 3) {
                const batch = list.slice(start, start + 3);
                const answers = await Promise.all(batch.map(async (id) => {
                    try {
                        const json = await getJson(
                            `${API}/x/v3/fav/resource/list?media_id=${encodeURIComponent(id)}&pn=1&ps=20&keyword=${encodeURIComponent(query)}&order=mtime&type=0&tid=0&platform=web`,
                        );
                        if (!json || json.code !== 0) return null;
                        const medias = (json.data && json.data.medias) || [];
                        const hit = medias.find((media) => media && media.bvid && media.title
                            && String(media.title).toLowerCase().includes(needle));
                        return hit ? [id, String(hit.title).replace(/<[^>]*>/g, '')] : null;
                    } catch {
                        return null;
                    }
                }));
                for (const answer of answers) if (answer) hits[answer[0]] = answer[1];
            }
            return { hits };
        });
    });

    handle('song', async ({ id }) => {
        const { bvid, page } = splitId(id);
        const view = await getView(bvid);
        const raw = videoToRaw(view);
        return { ...raw, page, cid: pickCid(view, page) };
    });

    handle('subtitles', async ({ id, preferCC = true }) => {
        return cached(`sub:${id}:${preferCC ? 'cc' : 'auto'}`, TTL.subtitles, async () => {
            const { bvid, page } = splitId(id);
            const view = await getView(bvid);
            const cid = pickCid(view, page);
            const json = await getJsonSigned(`${API}/x/player/wbi/v2`, `${API}/x/player/v2`, { bvid, cid });
            const subtitle = (json && json.data && json.data.subtitle) || {};
            const list = Array.isArray(subtitle.subtitles) ? subtitle.subtitles : [];
            if (!list.length) return { lan: '', lanDoc: '', body: [] };
            const pick =
                (preferCC && list.find((item) => /^zh/i.test(item.lan))) ||
                list.find((item) => /ai-zh/i.test(item.lan)) ||
                list[0];
            const url = String(pick.subtitle_url || '');
            if (!url) return { lan: pick.lan || '', lanDoc: pick.lan_doc || '', body: [] };
            const json2 = await getJson(url.startsWith('//') ? `https:${url}` : url);
            return { lan: pick.lan || '', lanDoc: pick.lan_doc || '', body: Array.isArray(json2.body) ? json2.body : [] };
        });
    });

    /**
     * 这个视频的音频流清单。
     *
     * 换档位、读标签都要问 playurl，60 秒内只问一次——切歌时同一首会被连着问两遍
     * （先取一次标签，再取一次地址），合并掉省一个来回。
     */
    function streamsOf(id) {
        return cached(`streams:${id}`, TTL.items, async () => {
            const { bvid, page } = splitId(id);
            const view = await getView(bvid);
            const cid = pickCid(view, page);
            const json = await withRetry(() => getJsonSigned(
                `${API}/x/player/wbi/playurl`,
                `${API}/x/player/playurl`,
                { bvid, cid, fnval: 4048, fnver: 0, fourk: 1 },
            ));
            const dash = json && json.data && json.data.dash;
            return { cid, candidates: collectAudio(dash) };
        });
    }

    handle('levels', async ({ id }) => {
        const { candidates } = await streamsOf(id);
        const ids = Array.from(new Set(candidates.map((item) => item.id)))
            .filter((value) => value > 0)
            .sort((a, b) => a - b);
        return {
            ids,
            labels: ids.map((value) => ({ id: value, label: AUDIO_LABEL[value] || String(value) })),
        };
    });

    /**
     * 渲染进程要 import 宿主自己的 chunk，而 chunk 名带构建哈希，发版就变。这里把
     * dist/assets 列一次让它按前缀认；读不到就返回空名字，客户端会安静跳过这一步。
     */
    function assetSources() {
        const out = [];
        const seen = new Set();
        const addDir = (root) => {
            if (!root) return;
            const dir = path.join(String(root), 'dist', 'assets');
            if (seen.has(dir)) return;
            seen.add(dir);
            out.push({ dir });
        };
        const addAsar = (archive) => {
            if (!archive) return;
            const file = String(archive).replace(/[\\/]+$/, '');
            if (seen.has(file)) return;
            seen.add(file);
            out.push({ asar: file, segments: ['dist', 'assets'] });
        };

        let appPath = '';
        try {
            const electron = require('electron');
            if (electron && electron.app && typeof electron.app.getAppPath === 'function') {
                appPath = electron.app.getAppPath();
            }
        } catch {
            /* 不是 Electron 主进程，往下试别的 */
        }

        if (appPath) {
            if (/\.asar$/.test(appPath)) addAsar(appPath);
            else addDir(appPath);
        }
        if (typeof process !== 'undefined' && process.resourcesPath) {
            addAsar(path.join(process.resourcesPath, 'app.asar'));
            addDir(path.join(process.resourcesPath, 'app'));
        }
        if (typeof process !== 'undefined' && process.cwd) addDir(process.cwd());
        return out;
    }

    handle('assets', async ({ match } = {}) => {
        const want = String(match || '').trim();
        if (!want) return { name: '' };
        for (const source of assetSources()) {
            let names = null;
            try {
                names = source.dir ? fs.readdirSync(source.dir) : listAsarDir(source.asar, source.segments);
            } catch {
                continue;
            }
            const hit = (names || [])
                .filter((name) => name.startsWith(want) && name.endsWith('.js'))
                .sort();
            if (hit.length) return { name: hit[hit.length - 1] };
        }
        return { name: '' };
    });

    /**
     * 这条直链真实的有效期。bilibili 把时间戳写在 URL 的 `deadline` 里，
     * 以前这里硬编码 90 分钟纯属猜的：碰上短时效的会拿着过期地址播 403。
     * 拿不到就退回保守的 30 分钟，宁可早一点重取。
     */
    function deadlineOf(url) {
        try {
            const value = Number(new URL(url).searchParams.get('deadline'));
            return value > 0 ? value * 1000 : 0;
        } catch {
            return 0;
        }
    }

    handle('audio', async ({ id, quality = 'high', route = 'auto' }) => {
        const { cid, candidates } = await streamsOf(id);
        if (!candidates.length) {
            throw new Error('bili: 这首歌放不了（可能要登录或大会员）');
        }
        const order = AUDIO_ORDER[quality] || AUDIO_ORDER.high;
        const ranked = candidates.slice().sort((a, b) => {
            const ai = order.indexOf(a.id);
            const bi = order.indexOf(b.id);
            return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
        });
        const chosen = ranked[0];
        const target = chosen.urls.find(Boolean);

        const expiresAt = deadlineOf(target) || Date.now() + 30 * 60 * 1000;
        if (route === 'proxy') {
            const port = await ensureProxy();
            const encoded = Buffer.from(target).toString('base64url');
            // volatile：这条 URL 绑在本次激活的随机端口和 token 上，
            // 模组重载/停用再启用后就作废，宿主别把它当长期地址缓存。
            return { url: `http://127.0.0.1:${port}/a?t=${state.token}&u=${encoded}`, via: 'proxy', volatile: true, expiresAt, cid, audioId: chosen.id };
        }
        if (route === 'direct' || (await probeDirect(target))) {
            return { url: target, via: 'direct', expiresAt, cid, audioId: chosen.id };
        }
        const port = await ensureProxy();
        const encoded = Buffer.from(target).toString('base64url');
        api.log.info('bili: direct stream rejected, using local proxy');
        return { url: `http://127.0.0.1:${port}/a?t=${state.token}&u=${encoded}`, via: 'proxy', volatile: true, expiresAt, cid, audioId: chosen.id };
    });

    handle('clearCache', async () => {
        state.views.clear();
        state.wbi = null;
        memo.clear();
        inflight.clear();
        return { ok: true };
    });

    function parseDuration(value) {
        if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value * 1000);
        const text = String(value || '');
        const parts = text.split(':').map((item) => Number(item)).filter((item) => Number.isFinite(item));
        if (!parts.length) return 0;
        return parts.reduce((total, item) => total * 60 + item, 0) * 1000;
    }

    api.log.info('bili-fav main loaded', `${api.host.folium.major}.${api.host.folium.minor}`);

    return () => {
        if (state.server) {
            try {
                state.server.close();
            } catch {
                /* 已经关了 */
            }
            state.server = null;
        }
        state.views.clear();
    };
};

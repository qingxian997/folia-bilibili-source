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
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
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
const { createUpdateService } = require('./lib/update.cjs');

const { version: CURRENT_VERSION } = require('./mod.json');

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

    // ---------------------------------------------------------------- update

    /** 下载 GitHub Release 附件：流式落盘，限时、限大小，失败了不留半截文件。 */
    async function downloadFile(url, file, maxBytes) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 120000);
        try {
            const response = await fetch(url, {
                headers: { 'User-Agent': UA, Accept: 'application/octet-stream' },
                redirect: 'follow',
                signal: controller.signal,
            });
            if (!response.ok || !response.body) throw new Error(`bili: 下载更新包失败（HTTP ${response.status}）`);
            const declared = Number(response.headers.get('content-length') || 0);
            if (declared > maxBytes) throw new Error('bili: 更新包太大，已停止下载');
            let size = 0;
            const counted = (async function* () {
                for await (const chunk of Readable.fromWeb(response.body)) {
                    size += chunk.length;
                    if (size > maxBytes) throw new Error('bili: 更新包太大，已停止下载');
                    yield chunk;
                }
            })();
            await pipeline(counted, fs.createWriteStream(file));
        } catch (error) {
            if (error && error.name === 'AbortError') throw new Error('bili: 下载更新包超时，稍后再试');
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    let updateDir = '';
    const storagePaths = (api.storage && api.storage.paths) || {};
    try {
        if (storagePaths.cache) {
            updateDir = storagePaths.cache;
            fs.mkdirSync(updateDir, { recursive: true });
        }
    } catch (error) {
        api.log.warn('bili: 更新缓存目录不可用', String(error && error.message));
        updateDir = '';
    }

    const updater = createUpdateService({
        getJson,
        download: downloadFile,
        cacheDir: updateDir || path.join(storagePaths.data || os.tmpdir(), 'bili-update'),
        currentVersion: CURRENT_VERSION,
        storage: api.storage,
        log: api.log,
        notify: (name, payload) => api.rpc.send(name, payload),
    });

    // ---------------------------------------------------------------- cookie

    // 1.0.0 从 bili-fav-wall 改名。旧目录里的加密凭据和设置是按字节存的、
    // 不绑模组 id，搬到新目录就能接着用；不搬的话用户升级后会被要求重新扫码。
    // 只在凭据确实不存在时搬一次，绝不覆盖新目录里已有的数据。
    try {
        const here = path.dirname(api.storage.paths.data); // mods-data/bilibili
        const old = path.join(path.dirname(here), 'bili-fav-wall');
        for (const file of ['secrets.json', 'mod-data.json']) {
            const from = path.join(old, file);
            const to = path.join(here, file);
            if (!fs.existsSync(to) && fs.existsSync(from)) {
                fs.copyFileSync(from, to);
                api.log.info(`bili: 从旧模组目录迁移了 ${file}`);
            }
        }
    } catch (error) {
        api.log.warn('bili: 迁移旧模组数据失败', String(error && error.message));
    }

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

    /**
     * 游客指纹：没有 buvid3 时 bilibili 会把搜索当风控流量（-412）。
     *
     * 0.9.1：拿到之后存一份，下次启动**接着用同一个**。以前每次起进程都重新申请，
     * 等于每次重启都换一台「新设备」——同一个 SESSDATA 配一堆陌生指纹，
     * 是「昨天还登录着，今天要重扫」的常见诱因。存储失败就退回每次现取。
     */
    async function ensureBuvid() {
        if (state.buvid) return state.buvid;
        if (state.buvidPending) return state.buvidPending;
        // 注意：这次请求不能带 cookie，否则 cookieHeader → ensureBuvid 会递归。
        state.buvidPending = (async () => {
            try {
                const kept = await api.storage.get('buvid').catch(() => null);
                if (kept && typeof kept === 'object' && kept.b3) {
                    state.buvid = { b3: String(kept.b3), b4: String(kept.b4 || '') };
                    return state.buvid;
                }
            } catch {
                /* 老宿主没有 storage 就现取 */
            }
            try {
                const json = await getJson(`${API}/x/frontend/finger/spi`, { noCookie: true });
                const data = json && json.data;
                state.buvid = { b3: (data && data.b_3) || '', b4: (data && data.b_4) || '' };
                if (state.buvid.b3) {
                    void Promise.resolve(api.storage.set('buvid', state.buvid)).catch(() => {});
                }
            } catch (error) {
                api.log.warn('bili: buvid bootstrap failed', error);
                // 0.9.2：以前这里把空指纹写进 state.buvid，之后 `if (state.buvid) return`
                // 直接返回空值，本次进程再也不会重试，全程缺 buvid3 → 一直吃 -412。
                // 现在只返回一份临时空对象给这次调用，不缓存；下次请求会重新申请。
                return { b3: '', b4: '' };
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
        let json = null;
        try {
            json = await getJson(`${signedPath}?${await wbiQuery(params)}`);
            if (json && json.code === 0) return json;
            const code = Number(json && json.code);
            // 0.9.2：限流码直接抛，不回退未签名版本。以前这里被挡一下就再发一发，
            // 风控期请求翻倍，越补越狠。只有真正「签名不被收」的错误才回退。
            if (COVER_THROTTLE_CODES.has(code) || code === -403) {
                throw new Error(`bili: ${code} ${(json && json.message) || ''}`.trim());
            }
            api.log.warn('bili: signed endpoint answered non-zero', code, signedPath);
        } catch (error) {
            const text = String((error && error.message) || error || '');
            if (COVER_RETRYABLE.test(text) || /-412|-799|-352|-509|-403/.test(text)) throw error;
            api.log.warn('bili: signed request failed, retrying unsigned', text);
        }
        const query = Object.keys(params)
            .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
            .join('&');
        json = await getJson(`${unsignedPath}?${query}`);
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
        const data = json.data || {};
        // 有些视频的 view 响应不带 pages（实测「八爷全部MV合集」就是），
        // 但 pagelist 仍给完整分 P。没有这一步，这类视频就永远只显示整段时长、不拆 P。
        const have = Array.isArray(data.pages) ? data.pages.length : 0;
        if (have < 2) {
            try {
                const list = await getJson(`${API}/x/player/pagelist?bvid=${encodeURIComponent(bvid)}`);
                const rows = (list && list.code === 0 && Array.isArray(list.data)) ? list.data : [];
                if (rows.length > have) {
                    data.pages = rows.map((page) => ({
                        page: Number(page && page.page) || 0,
                        cid: page && page.cid,
                        part: String((page && page.part) || ''),
                        duration: Number((page && (page.duration || page.length)) || 0),
                    })).filter((page) => page.page > 0);
                }
            } catch {
                /* pagelist 也读不到就沿用 view 的原样结果，不影响播放 */
            }
        }
        state.views.set(bvid, { at: Date.now(), data });
        if (state.views.size > 300) state.views.delete(state.views.keys().next().value);
        return data;
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
            pages: (view.pages || []).map((page) => ({
                page: page.page,
                cid: page.cid,
                part: page.part,
                durationMs: (Number(page.duration) || 0) * 1000,
            })),
        };
    }

    // --------------------------------------------------------------- playurl

    // 映射 bilibili 的真实音频梯度，而不是宿主的通名：
    // 64K / 132K / 192K(320K) / Hi-Res FLAC；杜比只作为无损档的降级流。
    // hires 不对外声明，宿主请求 hires 时会回落到 lossless。
    const AUDIO_ORDER = {
        standard: [30216, 30232, 30280, 30380],
        high: [30232, 30280, 30216, 30380],
        ultra: [30380, 30280, 30232, 30216],
        lossless: [30251, 30252, 30250, 30380, 30280],
        hires: [30251, 30252, 30250, 30380, 30280],
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
        30380: '320K',
        30250: '杜比',
        30251: 'Hi-Res',
        30252: 'FLAC',
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
            // 0.9.2：listen 成功之后 server 再报 error（运行期出错），以前只 close 掉
            // 却留着 state.server / state.port 指向死端口，之后每次取流都拿到这个死地址。
            // 现在两种情形都把状态清干净；已 resolve 的 promise 再 reject 也无效，无妨。
            const fail = (error) => {
                if (state.server === server) {
                    state.server = null;
                    state.port = 0;
                }
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
        const controller = new AbortController();
        // 0.9.2：以前 timer 只在 fetch 成功路径 clear，失败时悬着 6 秒才自己烧掉，
        // 反复切歌会堆一堆短命定时器；也没 unref。现在 finally 里一律清掉。
        const timer = setTimeout(() => controller.abort(), 6000);
        if (typeof timer.unref === 'function') timer.unref();
        try {
            const response = await fetch(url, {
                headers: { 'User-Agent': UA, Range: 'bytes=0-1' },
                redirect: 'follow',
                signal: controller.signal,
            });
            return response.status === 200 || response.status === 206;
        } catch {
            return false;
        } finally {
            clearTimeout(timer);
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

    /**
     * 列表接口（收藏夹 / 搜索 / 合集）不给 pages，但分P只有 view 接口能拿到。
     * 这里按 bvid 批量补，复用 getView 的 10 分钟缓存和 cached 的 60 秒合并；
     * 失败就原样返回，别因为一条视频的分P读不到就让整页空掉或吃 -412。
     */
    async function withPages(list) {
        const items = Array.isArray(list) ? list : [];
        const need = items.filter((item) => item && item.bvid
            && !Array.isArray(item.pages)
            && Number(item.partCount) !== 1);
        const found = new Map();
        for (let start = 0; start < need.length; start += 4) {
            const batch = need.slice(start, start + 4);
            const results = await Promise.all(batch.map(async (item) => {
                try {
                    const view = await cached(`pages:${item.bvid}`, 10 * 60 * 1000, () => getView(item.bvid));
                    const pages = Array.isArray(view && view.pages) ? view.pages : [];
                    return [item.bvid, pages
                        .filter((page) => Number(page && page.page) > 0)
                        .map((page) => ({
                            page: Number(page.page),
                            cid: page.cid,
                            part: page.part || '',
                            durationMs: (Number(page.duration) || 0) * 1000,
                        }))];
                } catch {
                    return [item.bvid, null];
                }
            }));
            for (const [bvid, pages] of results) {
                if (pages && pages.length > 1) found.set(bvid, pages);
            }
            if (start + 4 < need.length) await sleep(120);
        }
        return items.map((item) => {
            const next = { ...item };
            const pages = Array.isArray(next.pages) ? next.pages : found.get(next.bvid);
            if (pages) next.pages = pages;
            delete next.partCount;
            return next;
        });
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
            const code = Number(json && json.code);
            return {
                loggedIn: Boolean(data.isLogin),
                mid: data.mid ? String(data.mid) : '',
                uname: data.uname || '',
                face: cover(data.face),
                // 宿主账号行只要 vipType 非 0 就会画会员标记；bilibili 的 1/2 分别
                // 是月度 / 年度大会员，宿主不区分。nav 偶尔只给 vipStatus，兜底成 1。
                vipType: Number(data.vipType) > 0
                    ? Number(data.vipType)
                    : (Number(data.vipStatus) > 0 || data.isVIP === true ? 1 : 0),
                vipDueDate: Number(data.vipDueDate) || 0,
                vipLabel: String((data.vipLabel && data.vipLabel.text) || ''),
                saved: Boolean(state.cookie),
                /**
                 * 0.9.1：接口到底有没有给出答案。
                 *
                 * `-101` 是「未登录 / 凭据过期」，属于明确回答；`-412`（风控）、`-799`
                 * （限流）和网络错误都不是 —— 那些情况 Cookie 还好好的，只是这一次没问到。
                 * 以前一律返回 loggedIn:false，宿主就把整个音源画成未登录，用户以为掉号了。
                 */
                settled: code === 0 || code === -101,
                code,
            };
        } catch (error) {
            return {
                loggedIn: false,
                mid: '',
                uname: '',
                face: '',
                saved: Boolean(state.cookie),
                settled: false,
                error: String(error.message),
            };
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
        try {
            const mid = await cached('nav', TTL.nav, async () => {
                // 网络抖动直接往外抛，别把失败当「没有 mid」交给上面的 cached 记住。
                const json = await getJson(`${API}/x/web-interface/nav`);
                return String((json && json.data && json.data.mid) || '');
            });
            // 0.9.2：nav 回答里没有 mid（临时异常 / 未登录）也不缓存 —— 以前一次
            // 抖动会被 cached 记 5 分钟空串，folders / collected / liked 全走「未登录」。
            if (!mid) memo.delete('nav');
            return mid;
        } catch (error) {
            memo.delete('nav');
            api.log.warn('bili: 读取账号 mid 失败', String(error && error.message));
            return '';
        }
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
    handle('likedIds', async ({ folder, expandParts = false } = {}) => {
        let fid = String(folder || '').trim();
        if (!fid) fid = await defaultFolderId();
        if (!fid) return { ids: [], folder: '', baseCount: 0 };
        const ids = await cached(`liked:${fid}`, TTL.liked, async () => {
            const json = await getJson(`${API}/x/v3/fav/resource/ids?media_id=${encodeURIComponent(fid)}&platform=web`);
            if (!json || json.code !== 0) throw new Error(`bili: 「喜欢」列表读不到（${(json && json.code) || ''}）`);
            return (json.data || [])
                .map((item) => (item && (item.bvid || item.bv_id)) || '')
                .filter(Boolean);
        });
        if (!expandParts) return { ids, folder: fid, baseCount: ids.length };
        // 宿主按 sourceRef.mediaId 匹配喜欢态；分P歌曲是 bvid#N，所以要把已展开的 P
        // 也放进 likedSongIds。只补前 200 个，多于 200 的只保留 bvid，避免启动时打爆 view 接口。
        const expanded = await cached(`likedParts:${fid}`, TTL.liked, async () => {
            const result = new Set(ids);
            const targets = ids.slice(0, 200).map((bvid) => ({ bvid }));
            const rows = await withPages(targets);
            for (const row of rows) {
                for (const page of (row && row.pages) || []) {
                    if (Number(page && page.page) > 1) result.add(`${row.bvid}#${Number(page.page)}`);
                }
            }
            return [...result];
        });
        return { ids: expanded, folder: fid, baseCount: ids.length };
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
                partCount: Math.max(0, Number(item && item.page) || 0),
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
                items: await withPages(list),
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
                partCount: Math.max(0, Number(item && item.page) || 0),
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
                items: await withPages(items),
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
                items: await withPages(items),
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
        return { title: '', owner, total, hasMore: items.length > 0 && hasMore, items: await withPages(items) };
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

    /**
     * 取一个收藏夹的封面（夹里前几条视频的图）。单夹封面和批量补封面共用这一条路。
     *
     * 0.9.2：**限流 != 没有封面**。以前批量补封面把 -412 也写成空数组，空结果进
     * 5 分钟负缓存，于是被挡一下之后有封面也空白五分钟 —— 这就是「封面时不时取不到」。
     * 现在网络错误和限流码重试几次；无论哪种失败都绝不写负缓存，交给调用方记一笔。
     * code=0 但确实没有可用视频（空夹 / 全是失效视频）才返回 ok:true + 空数组。
     */
    const COVER_THROTTLE_CODES = new Set([-412, -799, -352, -509]);
    const COVER_RETRYABLE = /(412|请求太频繁|timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|network)/i;
    async function coverPage(id) {
        let last = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            let json = null;
            try {
                json = await getJson(
                    `${API}/x/v3/fav/resource/list?media_id=${encodeURIComponent(id)}&pn=1&ps=4&keyword=&order=mtime&type=0&tid=0&platform=web`,
                );
            } catch (error) {
                const throttled = COVER_RETRYABLE.test(String((error && error.message) || error || ''));
                last = { throttled, code: null };
                if (!throttled || attempt === 2) break;
                await sleep(700 * (attempt + 1));
                continue;
            }
            const code = json && json.code;
            if (code !== 0) {
                const throttled = COVER_THROTTLE_CODES.has(Number(code));
                last = { throttled, code };
                if (!throttled || attempt === 2) break;
                await sleep(700 * (attempt + 1));
                continue;
            }
            const data = (json && json.data) || {};
            const list = ((data.medias) || [])
                .filter((item) => item && item.cover && String(item.title || '') !== '已失效视频')
                .map((item) => cover(item.cover))
                .slice(0, 4);
            // 首屏几条恰好全失效时，退回收藏夹自己的封面（贴链接那条路用的就是它）。
            if (!list.length && data.info && data.info.cover) list.push(cover(data.info.cover));
            return { ok: true, covers: list };
        }
        return { ok: false, throttled: Boolean(last && last.throttled), code: last && last.code };
    }

    handle('folderCover', async ({ mediaId, force } = {}) => {
        const key = String(mediaId);
        const cache = await loadCoverCache();
        const saved = cache[key];
        if (!force && saved && Array.isArray(saved.covers) && saved.covers.length && Date.now() - Number(saved.at || 0) < COVER_TTL) {
            return { covers: saved.covers, cached: true };
        }

        const answer = await coverPage(key);
        if (!answer.ok) {
            // 抛出去而不是回空数组：渲染进程要靠这条消息判断「是被限流了」，好停下来歇一会儿
            if (answer.throttled) throw new Error('bili: 封面读太快被 bilibili 拦了，过几分钟再试');
            return { covers: [] };
        }
        if (answer.covers.length) {
            cache[key] = { at: Date.now(), covers: answer.covers };
            scheduleCoverSave();
        }
        return { covers: answer.covers };
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
     * 串行 + 每条之间隔 700ms——并发十几条必然被 bilibili 412（实测）。失败也照样等，
     * 否则 40 个 id 会毫秒级连发，正好踩在风控上（0.8.4 的教训）。
     *
     * 0.9.2：限流 / 网络失败不再写成「没封面」的负缓存，也不再 `break` 掉整批 ——
     * 以前一次 -412 会让后面所有夹子都空白、还空白五分钟。现在只跳过失败那条。
     * `force:true` 忽略 TTL 和负缓存，给「清缓存」按钮强制重取用。
     */
    const COVER_MISS_TTL = 5 * 60 * 1000;
    let filling = null;
    handle('fillCovers', async ({ ids, force } = {}) => {
        const cache = await loadCoverCache();
        const now = Date.now();
        const wanted = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean);
        const missing = force ? wanted : wanted.filter((id) => {
            const entry = cache[id];
            const at = Number((entry && entry.at) || 0);
            if (entry && Array.isArray(entry.covers) && entry.covers.length) {
                return !(now - at < COVER_TTL);
            }
            // 空结果：5 分钟内不再问（负缓存，只用于 code=0 的真·空夹）
            return !(entry && now - at < COVER_MISS_TTL);
        });
        if (!missing.length) return { covers: cache, filled: 0, failed: 0 };
        if (filling) return filling;

        filling = (async () => {
            let filled = 0;
            let failed = 0;
            let attempted = 0;
            // 只回本次新补到的正结果。以前回吐整份 cache，客户端一合并就把过期项和
            // 空数组又合回去了，表现是「封面闪一下又没了」。
            const gained = {};
            for (const id of missing.slice(0, 40)) {
                if (attempted) await sleep(700);
                attempted += 1;
                try {
                    const answer = await coverPage(id);
                    if (!answer.ok) {
                        failed += 1;
                        api.log.warn('bili: 封面取不到', id, answer.code == null ? 'network' : String(answer.code));
                        // 关键：绝不为限流/网络失败写负缓存，否则空白五分钟。
                        continue;
                    }
                    if (answer.covers.length) {
                        cache[id] = { at: Date.now(), covers: answer.covers };
                        gained[id] = cache[id];
                        filled += 1;
                    } else {
                        // code=0，确实是空夹 / 全是失效视频：合法负结果
                        cache[id] = { at: Date.now(), covers: [] };
                    }
                } catch (error) {
                    failed += 1;
                    api.log.warn('bili: 封面取不到', id, String(error && error.message));
                    continue;
                }
            }
            if (attempted) scheduleCoverSave();
            return { covers: gained, filled, failed };
        })();

        try {
            return await filling;
        } finally {
            filling = null;
        }
    });

    // ------------------------------------------------------ 封面补全队列
    //
    // 状态放在主进程：哪些夹子还缺封面、剩几个、冷却到什么时候，全由这里说了算。
    // 渲染进程只消费一份「只有新鲜正结果」的快照，不再自己算 missing、也不再把整份
    // 原始 cache 合并回去——那正是「封面闪一下又没了」「空白好几分钟」的来源。
    //
    // 队列落盘，重启后接着补；限流按 1 → 5 → 15 分钟退避，被限流的那条留在队首。
    const COVER_QUEUE_MAX = 200;
    const COVER_ROUND_MAX = 12;
    const COVER_GAP_MS = 900;
    const COVER_BACKOFF = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000];

    let coverQueue = null;
    let coverCooldown = 0;
    let coverStep = 0;
    let coverWorker = null;
    let coverLastError = '';
    let coverQueueTimer = null;
    /** 被 force 要求重取的 id：worker 不能因为「已有新鲜封面」把它们丢掉。 */
    const coverForce = new Set();

    async function loadCoverQueue() {
        if (coverQueue) return coverQueue;
        let saved = null;
        try {
            saved = api.storage && typeof api.storage.get === 'function' ? await api.storage.get('coverQueue') : null;
        } catch {
            saved = null;
        }
        coverQueue = Array.isArray(saved && saved.ids) ? saved.ids.map(String).slice(0, COVER_QUEUE_MAX) : [];
        coverCooldown = Number((saved && saved.cooldownUntil) || 0) || 0;
        coverStep = Number((saved && saved.step) || 0) || 0;
        return coverQueue;
    }

    function scheduleCoverQueueSave() {
        if (coverQueueTimer) return;
        coverQueueTimer = setTimeout(() => {
            coverQueueTimer = null;
            try {
                if (api.storage && typeof api.storage.set === 'function') {
                    Promise.resolve(api.storage.set('coverQueue', {
                        ids: coverQueue || [],
                        cooldownUntil: coverCooldown,
                        step: coverStep,
                    })).catch(() => {});
                }
            } catch {
                /* 存不下就算了，下次重来 */
            }
        }, 1200);
        if (typeof coverQueueTimer.unref === 'function') coverQueueTimer.unref();
    }

    const coverIsFresh = (entry, now) => Boolean(
        entry && Array.isArray(entry.covers) && entry.covers.length && now - Number(entry.at || 0) < COVER_TTL,
    );

    /** 只含新鲜的正结果：空数组、限流、过期项一律不出现。 */
    async function coverSnapshot() {
        const cache = await loadCoverCache();
        const now = Date.now();
        const fresh = {};
        Object.keys(cache).forEach((key) => {
            const entry = cache[key];
            if (!coverIsFresh(entry, now)) return;
            fresh[key] = entry.covers;
        });
        return {
            covers: fresh,
            pending: (coverQueue || []).length,
            cooldownUntil: coverCooldown,
            lastError: coverLastError,
        };
    }

    /**
     * 队列只入队，不阻塞调用方；真正的请求由 worker 一条一条发。
     * `force` 的 id 记在 coverForce 里：worker 不能拿「已有新鲜封面」把它们直接扔掉，
     * 否则「刷新缓存」按下去什么都不会重取。
     */
    async function enqueueCovers(ids, force = false) {
        await loadCoverQueue();
        const cache = await loadCoverCache();
        const now = Date.now();
        const queued = new Set(coverQueue);
        for (const raw of (Array.isArray(ids) ? ids : [])) {
            const id = String(raw || '');
            if (!id || queued.has(id)) continue;
            const entry = cache[id];
            const at = Number((entry && entry.at) || 0);
            if (!force) {
                if (coverIsFresh(entry, now)) continue;
                // 空结果只在「code=0 的真·空夹」时才会写，5 分钟内不重复问
                if (entry && !entry.covers.length && now - at < COVER_MISS_TTL) continue;
            } else {
                coverForce.add(id);
            }
            if (coverQueue.length >= COVER_QUEUE_MAX) break;
            coverQueue.push(id);
            queued.add(id);
        }
        scheduleCoverQueueSave();
        return coverQueue.length;
    }

    async function runCoverQueue() {
        if (coverWorker) return coverWorker;
        const job = (async () => {
            await loadCoverQueue();
            const cache = await loadCoverCache();
            let done = 0;
            const drop = (id) => {
                const at = coverQueue.indexOf(id);
                if (at >= 0) coverQueue.splice(at, 1);
                coverForce.delete(id);
            };
            while (coverQueue.length && done < COVER_ROUND_MAX) {
                if (coverCooldown > Date.now()) break;
                const id = coverQueue[0];
                // force 过的 id 即使已有新鲜封面也要真的重取一次
                if (!coverForce.has(id) && coverIsFresh(cache[id], Date.now())) {
                    drop(id);
                    continue;
                }
                if (done) await sleep(COVER_GAP_MS);
                done += 1;
                try {
                    const answer = await coverPage(id);
                    if (!answer.ok) {
                        coverLastError = answer.code == null ? 'network' : String(answer.code);
                        if (answer.throttled) {
                            // 被限流：这条留在队首，整队停下来等冷却
                            coverStep = Math.min(coverStep + 1, COVER_BACKOFF.length - 1);
                            coverCooldown = Date.now() + COVER_BACKOFF[coverStep];
                            api.log.warn('bili: 封面补全被限流，暂停', coverLastError);
                            break;
                        }
                        // 单条失效 / 网络错误：跳过这条，继续后面的
                        drop(id);
                        continue;
                    }
                    coverStep = 0;
                    drop(id);
                    cache[id] = { at: Date.now(), covers: answer.covers.length ? answer.covers : [] };
                } catch (error) {
                    coverLastError = String(error && error.message);
                    drop(id);
                    api.log.warn('bili: 封面取不到', id, coverLastError);
                }
            }
            if (done) scheduleCoverSave();
            scheduleCoverQueueSave();
            return done;
        })();
        coverWorker = job;
        try {
            return await job;
        } finally {
            if (coverWorker === job) coverWorker = null;
        }
    }

    /** 把要补封面的夹子交给队列，立刻返回快照；客户端按 pending 决定要不要再来问。 */
    handle('ensureCovers', async ({ ids, force } = {}) => {
        await enqueueCovers(ids, Boolean(force));
        // 不 await：这一轮可能十几秒，接口要立刻返回，让首屏先画出来
        void runCoverQueue();
        return coverSnapshot();
    });

    /** 只读快照：客户端轮询用，不会新增请求。 */
    handle('cover.state', async () => {
        await loadCoverQueue();
        return coverSnapshot();
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
        return { title, owner, total, items: await withPages(items), truncated };
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
            partCount: Math.max(0, Number(item && item.page) || 0),
            index,
            playable: Boolean(item && item.bvid && item.type !== 'ketang'),
        }));
        return {
            items: await withPages(items),
            total: Number(data.numResults) || 0,
            hasMore: (Number(page) || 1) < (Number(data.numPages) || 1),
        };
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
            items: await withPages(items),
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
        const hit = (view.pages || []).find((item) => Number(item && item.page) === page);
        return {
            ...raw,
            page,
            cid: pickCid(view, page),
            part: (hit && hit.part) || '',
            ...(hit && Number(hit.duration) > 0 ? { durationMs: Number(hit.duration) * 1000 } : {}),
        };
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

    handle('update.check', async ({ force = false } = {}) => updater.check(Boolean(force)));

    handle('update.state', async () => updater.state());

    handle('update.download', async () => {
        const saved = await updater.download();
        return { ok: true, version: saved.version, file: saved.file, sha256: saved.sha256 };
    });

    handle('update.skip', async ({ version = '' } = {}) => updater.skip(version));

    handle('clearCache', async () => {
        state.views.clear();
        state.wbi = null;
        memo.clear();
        inflight.clear();
        // 0.9.2：封面和额外列表以前没清 —— 点了「刷新缓存」它们还是从磁盘读回旧的，
        // 「清缓存让封面重取」根本不起作用。连待写盘的定时器一起取消，防旧值回写。
        coverCache = null;
        extraCache = null;
        if (coverSaveTimer) {
            clearTimeout(coverSaveTimer);
            coverSaveTimer = null;
        }
        // 补封面的队列也要一起清：否则「刷新缓存」之后它还会拿旧队列去撞接口。
        coverQueue = null;
        coverCooldown = 0;
        coverStep = 0;
        coverLastError = '';
        coverForce.clear();
        if (coverQueueTimer) {
            clearTimeout(coverQueueTimer);
            coverQueueTimer = null;
        }
        for (const key of ['covers', 'extras', 'coverQueue']) {
            try {
                if (api.storage && typeof api.storage.delete === 'function') {
                    await api.storage.delete(key);
                }
            } catch {
                /* 老宿主没这个接口就算了 */
            }
        }
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

// mods/bili-fav/lib/cookie.cjs
// Cookie 的取、洗、验，纯函数，主进程 require 它，测试也直接跑它。

'use strict';

/** 登录 Cookie 里真正决定身份的几个；其余（buvid3 等）由主进程自己补。 */
const WANTED = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid'];

/**
 * 从扫码轮询返回的 `data.url` 里摘 Cookie。
 *
 * 关键：**不要 decodeURIComponent**。SESSDATA 长这样 `abc%2Cdef%2C...%2A11`，逗号是签名的一部分，
 * 解码后塞进 Cookie 头会变成非法的 cookie-octet（RFC 6265 不允许逗号），服务端按别的值校验，
 * 于是「扫码成功但一直是未登录」。
 *
 * @param {string} url passport 的 crossDomain 回跳地址
 * @returns {string[]} `['SESSDATA=...', 'bili_jct=...']`
 */
function passportCookiesFromUrl(url) {
    const text = String(url || '');
    const mark = text.indexOf('?');
    if (mark < 0) return [];
    const query = text.slice(mark + 1).split('#')[0];
    const out = [];
    const seen = new Set();
    query.split('&').forEach((pair) => {
        const index = pair.indexOf('=');
        if (index <= 0) return;
        const key = pair.slice(0, index);
        const value = pair.slice(index + 1);
        if (!WANTED.includes(key) || !value || seen.has(key)) return;
        seen.add(key);
        out.push(`${key}=${value}`);
    });
    return out;
}

/**
 * 用户在输入框里粘的东西 → 一条能直接用的 Cookie 头。
 * 认：整条 `a=1; b=2`、带 `Cookie:` 前缀的、只有一个 SESSDATA 值、带换行/空格的。
 *
 * @param {string} raw
 * @returns {string}
 */
function normalizeCookieInput(raw) {
    let text = String(raw || '')
        .replace(/\r?\n/g, ' ')
        .replace(/^\s*cookie\s*:\s*/i, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
    if (!text) return '';
    // 只粘了 SESSDATA 的值（里面没有分号也没有等号以外的结构）
    if (!text.includes(';') && !/^[A-Za-z0-9_]+=/.test(text)) {
        text = `SESSDATA=${text}`;
    }
    const parts = text
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)
        // `SESSDATA=abc=def` 这种多等号的值要留住，只去掉空的 `k=`
        .filter((part) => {
            const index = part.indexOf('=');
            return index > 0 && index < part.length - 1;
        });
    return parts.join('; ');
}

/**
 * 从响应的 `Set-Cookie` 里摘登录 Cookie。
 *
 * 扫码轮询成功时，bilibili 有时不给 `data.url`（空字符串），而是把 `SESSDATA / bili_jct / ...`
 * 直接写在响应头的 `Set-Cookie` 里；只读 body 的代码就会以为「回跳地址里没有 SESSDATA」。
 *
 * 取值同样**不 decode**。`Expires=Thu, 01 Jan 1970` 里带逗号，所以只有当逗号后面紧跟
 * `名字=` 时才算「下一条 Cookie」，不能简单 `split(',')`。
 *
 * @param {string[]|string} raw 响应头里的 set-cookie（可能是多条，也可能是一条被合并的）
 * @returns {string[]} `['SESSDATA=...', 'bili_jct=...']`
 */
function cookiesFromSetCookie(raw) {
    const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
    const jar = new Map();
    list.forEach((entry) => {
        String(entry || '')
            .split(/,(?=\s*[A-Za-z0-9_\-]+=)/)
            .forEach((one) => {
                const head = one.split(';')[0];
                const index = head.indexOf('=');
                if (index <= 0) return;
                const key = head.slice(0, index).trim();
                const value = head.slice(index + 1).trim();
                if (!WANTED.includes(key) || !value) return;
                // 浏览器删 Cookie 的写法：值为空、Max-Age<=0、或 Expires 已是过去。
                if (/max-age\s*=\s*(0|-\d+)/i.test(one)) return;
                const expires = /expires\s*=\s*([^;]+)/i.exec(one);
                if (expires) {
                    const at = Date.parse(expires[1].trim());
                    if (Number.isFinite(at) && at < Date.now()) return;
                }
                if (!jar.has(key)) jar.set(key, value);
            });
    });
    return WANTED.filter((key) => jar.has(key)).map((key) => `${key}=${jar.get(key)}`);
}

/** 多路来源合并成一条 Cookie：按 WANTED 排好，前面的来源优先。 */
function mergeCookies(...groups) {
    const jar = new Map();
    groups.forEach((group) => {
        (Array.isArray(group) ? group : []).forEach((part) => {
            const index = String(part).indexOf('=');
            if (index <= 0) return;
            const key = String(part).slice(0, index).trim();
            if (!WANTED.includes(key) || jar.has(key)) return;
            jar.set(key, String(part).slice(index + 1));
        });
    });
    return WANTED.filter((key) => jar.has(key)).map((key) => `${key}=${jar.get(key)}`);
}

/** `a=1; b=2` → `{ a: '1', b: '2' }`，值保持原样（可能仍是 %2C 编码）。 */
function parseCookiePairs(raw) {
    const jar = {};
    String(raw || '')
        .split(';')
        .forEach((part) => {
            const index = part.indexOf('=');
            if (index <= 0) return;
            const key = part.slice(0, index).trim();
            if (key) jar[key] = part.slice(index + 1).trim();
        });
    return jar;
}

/** 有没有能读收藏夹的身份。 */
function hasSession(raw) {
    const jar = parseCookiePairs(raw);
    return Boolean(jar.SESSDATA);
}

module.exports = {
    passportCookiesFromUrl,
    cookiesFromSetCookie,
    mergeCookies,
    normalizeCookieInput,
    parseCookiePairs,
    hasSession,
    WANTED,
};

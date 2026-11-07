import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    passportCookiesFromUrl,
    cookiesFromSetCookie,
    mergeCookies,
    normalizeCookieInput,
    parseCookiePairs,
    hasSession,
} = require('../lib/cookie.cjs');

test('扫码回跳地址里的 Cookie 保持原始编码', () => {
    const url =
        'https://passport.biligame.com/crossDomain?DedeUserID=123456&DedeUserID__ckMd5=abcdef0123456789' +
        '&Expires=1730000000&SESSDATA=6a1b%2C1730000000%2Cb7c8%2A11' +
        '&SESSDATA__ckMd5=ff00ff00&bili_jct=deadbeefcafe&gourl=https%3A%2F%2Fwww.bilibili.com';
    const got = passportCookiesFromUrl(url);
    assert.deepEqual(got, [
        'DedeUserID=123456',
        'DedeUserID__ckMd5=abcdef0123456789',
        'SESSDATA=6a1b%2C1730000000%2Cb7c8%2A11',
        'bili_jct=deadbeefcafe',
    ]);
    // 逗号必须是 %2C：解码后的值放进 Cookie 头不合法
    assert.ok(!got.join(';').includes(','));
});

test('不要的字段（Expires / gourl / refresh_token）不进 Cookie', () => {
    const url = 'https://passport.bilibili.com/x?Expires=1&gourl=https%3A%2F%2Fb23.tv&SESSDATA=abc%2C1%2C2&refresh_token=zzz';
    assert.deepEqual(passportCookiesFromUrl(url), ['SESSDATA=abc%2C1%2C2']);
});

test('没有查询串时不瞎猜', () => {
    assert.deepEqual(passportCookiesFromUrl(''), []);
    assert.deepEqual(passportCookiesFromUrl('https://www.bilibili.com'), []);
});

test('整条 Cookie / 带前缀 / 只给 SESSDATA 值都能收', () => {
    assert.equal(
        normalizeCookieInput('Cookie: buvid3=abc; SESSDATA=6a1b%2C1%2C2; bili_jct=de'),
        'buvid3=abc; SESSDATA=6a1b%2C1%2C2; bili_jct=de',
    );
    assert.equal(normalizeCookieInput('6a1b%2C1730000000%2Cb7c8%2A11'), 'SESSDATA=6a1b%2C1730000000%2Cb7c8%2A11');
    assert.equal(normalizeCookieInput('  SESSDATA=abc \n bili_jct=de  '), 'SESSDATA=abc bili_jct=de');
});

test('空值 / 只有键名的不算 Cookie', () => {
    assert.equal(normalizeCookieInput(''), '');
    assert.equal(normalizeCookieInput(';; ;'), '');
    assert.equal(hasSession('buvid3=abc'), false);
    assert.equal(hasSession('SESSDATA=x'), true);
});

test('解析成键值对时值不被改写', () => {
    const jar = parseCookiePairs('SESSDATA=6a1b%2C1%2C2; bili_jct=de');
    assert.equal(jar.SESSDATA, '6a1b%2C1%2C2');
    assert.equal(jar.bili_jct, 'de');
});

test('Set-Cookie 头里摘登录 Cookie，值和编码都不动', () => {
    const raw = [
        'SESSDATA=8f2a%2C1780000000%2Cabc%2A11; Path=/; Domain=.bilibili.com; Expires=Wed, 01 Jan 2031 00:00:00 GMT; HttpOnly',
        'bili_jct=deadbeef; Path=/',
        'DedeUserID=123456; Path=/',
        'buvid3=ignored; Path=/',
    ];
    assert.deepEqual(cookiesFromSetCookie(raw), [
        'SESSDATA=8f2a%2C1780000000%2Cabc%2A11',
        'bili_jct=deadbeef',
        'DedeUserID=123456',
    ]);
});

test('多条被合并成一行（Expires 里带逗号）也能切开', () => {
    const merged =
        'SESSDATA=a%2Cb; Path=/; Expires=Wed, 01 Jan 2031 00:00:00 GMT, bili_jct=de; Path=/, sid=xyz; Path=/';
    assert.deepEqual(cookiesFromSetCookie(merged), ['SESSDATA=a%2Cb', 'bili_jct=de', 'sid=xyz']);
});

test('删除指令不算登录：空值 / Max-Age=0 / 过期的 Expires', () => {
    assert.deepEqual(cookiesFromSetCookie(['SESSDATA=; Max-Age=0']), []);
    assert.deepEqual(cookiesFromSetCookie(['SESSDATA=; Expires=Thu, 01 Jan 1970 00:00:00 GMT']), []);
    assert.deepEqual(cookiesFromSetCookie(['SESSDATA=abc; Max-Age=0']), []);
});

test('两个来源合并时按固定顺序、先到的优先', () => {
    const merged = mergeCookies(
        ['SESSDATA=from-url', 'DedeUserID=1'],
        ['SESSDATA=from-header', 'bili_jct=2'],
    );
    assert.deepEqual(merged, ['SESSDATA=from-url', 'bili_jct=2', 'DedeUserID=1']);
});

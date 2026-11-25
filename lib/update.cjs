// lib/update.cjs —— GitHub Release 更新检查与下载（纯逻辑 + 注入 IO）
//
// 主进程负责访问 GitHub、下载 zip、校验 sha256；客户端负责调用宿主的
// installModFromZip。宿主会弹信任确认，这里不尝试绕过。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const RELEASES_LATEST = 'https://api.github.com/repos/qingxian997/folia-bilibili-source/releases/latest';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_ZIP_BYTES = 64 * 1024 * 1024;
const ASSET_RE = /^bilibili-\d+\.\d+\.\d+\.zip$/;

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

function parseVersion(text) {
    const match = VERSION_RE.exec(String(text || '').trim().replace(/^v/, ''));
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** 返回正数表示 left 更新，负数表示 right 更新。 */
function compareVersions(left, right) {
    const a = parseVersion(left);
    const b = parseVersion(right);
    if (!a || !b) return 0;
    for (let index = 0; index < 3; index += 1) {
        if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
    }
    return 0;
}

/** Release 正文里由 scripts/release-github.cjs 生成的校验表。 */
function checksumOf(body, name) {
    const rows = String(body || '').split(/\r?\n/);
    const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const row = rows.find((line) => new RegExp(`\\|\\s*\`${escaped}\`\\s*\\|`).test(line));
    if (!row) return null;
    const match = /`([a-f0-9]{64})`/.exec(row);
    return match ? match[1] : null;
}

/**
 * 从 GitHub 的 release 对象里挑出可自动安装的运行包。
 * 预发布、草稿、缺校验值、版本不比当前新，一律返回 null。
 */
function releaseInfo(release, currentVersion, skipped) {
    if (!release || release.draft || release.prerelease) return null;
    const current = parseVersion(currentVersion);
    const tag = parseVersion(release.tag_name);
    if (!current || !tag || compareVersions(release.tag_name, currentVersion) <= 0) return null;
    const version = String(release.tag_name).trim().replace(/^v/, '');
    if (version === skipped) return { available: false, reason: 'skipped', version, name: release.name || null };
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const asset = assets.find((item) => ASSET_RE.test(String(item?.name || '')));
    if (!asset || !asset.browser_download_url) return null;
    const sha256 = checksumOf(release.body, asset.name);
    if (!sha256) return null;
    return {
        available: true,
        version,
        name: release.name || version,
        url: asset.browser_download_url,
        size: Number(asset.size) || 0,
        sha256,
        notes: typeof release.body === 'string' ? release.body.slice(0, 4000) : '',
    };
}

function sha256OfFile(file) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(file);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

/**
 * @param {object} options
 * @param {(url: string, options?: object) => Promise<object>} options.getJson 宿主已有的 JSON GET
 * @param {(url: string, file: string, maxBytes: number) => Promise<void>} options.download 下载到临时文件
 * @param {string} options.cacheDir 可写缓存目录
 * @param {string} options.currentVersion mod.json / client.mjs 的版本
 * @param {(name: string, payload: object) => void} options.notify 推给客户端
 * @param {object} options.storage 模组存储，可读写 update 状态
 */
function createUpdateService(options) {
    const { getJson, download, cacheDir, currentVersion, notify, storage, log } = options;
    try { fs.mkdirSync(cacheDir, { recursive: true }); } catch { /* 下载时再报错 */ }
    let state = { lastCheck: 0, result: null, skipped: null, downloaded: null };
    let chain = Promise.resolve();

    const inform = (payload) => {
        try { if (typeof notify === 'function') notify('update.state', payload); } catch { /* 推送失败不影响功能 */ }
    };
    const save = async () => {
        try {
            if (storage && typeof storage.set === 'function') await storage.set('update', state);
        } catch { /* 存储坏了就只在本次会话里生效 */ }
    };
    const ready = storage && typeof storage.get === 'function'
        ? Promise.resolve(storage.get('update')).then((saved) => {
            if (saved && typeof saved === 'object') state = { ...state, ...saved, result: null };
        }).catch(() => {})
        : Promise.resolve();

    /** 串行化，避免自动检查和手动点击叠在一起。 */
    const queue = (fn) => {
        chain = chain.catch(() => {}).then(fn);
        return chain;
    };

    const check = (force = false) => queue(async () => {
        await ready;
        const now = Date.now();
        if (!force && state.result && now - state.lastCheck < CHECK_INTERVAL_MS) {
            inform(state.result);
            return state.result;
        }
        const release = await getJson(RELEASES_LATEST, {
            noCookie: true,
            headers: { Accept: 'application/vnd.github+json', Referer: '', Origin: '' },
            timeout: 15000,
        });
        const result = releaseInfo(release, currentVersion, state.skipped);
        state.lastCheck = now;
        state.result = result || {
            available: false,
            reason: 'up-to-date',
            version: String(release?.tag_name || '').replace(/^v/, ''),
            current: currentVersion,
        };
        state.downloaded = null;
        await save();
        inform(state.result);
        return state.result;
    });

    const downloadUpdate = () => queue(async () => {
        await ready;
        const info = state.result;
        if (!info || !info.available) throw new Error('bili: 当前没有可下载的新版本');
        const file = path.join(cacheDir, `bilibili-${info.version}.zip`);
        if (fs.existsSync(file)) {
            const digest = await sha256OfFile(file);
            if (digest === info.sha256 && (!info.size || fs.statSync(file).size === info.size)) {
                state.downloaded = { version: info.version, file, sha256: digest };
                inform({ ...info, downloaded: true, file });
                return state.downloaded;
            }
            try { fs.unlinkSync(file); } catch { /* 下次覆盖 */ }
        }
        const temp = `${file}.${crypto.randomBytes(4).toString('hex')}.part`;
        try {
            await download(info.url, temp, MAX_ZIP_BYTES);
            const digest = await sha256OfFile(temp);
            if (digest !== info.sha256) throw new Error('bili: 更新包校验失败，可能是下载不完整，请重试');
            if (info.size && fs.statSync(temp).size !== info.size) throw new Error('bili: 更新包大小不对，请重试');
            fs.renameSync(temp, file);
        } finally {
            try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch { /* 已经清掉 */ }
        }
        state.downloaded = { version: info.version, file, sha256: info.sha256 };
        await save();
        inform({ ...info, downloaded: true, file });
        if (log && typeof log.info === 'function') log.info(`bili: 更新包已下载 ${info.version}`);
        return state.downloaded;
    });

    const skip = (version) => queue(async () => {
        await ready;
        state.skipped = String(version || '');
        state.result = null;
        await save();
        inform({ available: false, reason: 'skipped', version: state.skipped });
        return { ok: true, version: state.skipped };
    });

    const getState = () => queue(async () => {
        await ready;
        return {
            current: currentVersion,
            skipped: state.skipped,
            result: state.result,
            downloaded: state.downloaded,
        };
    });

    return { check, download: downloadUpdate, skip, state: getState, releaseInfo, compareVersions, parseVersion, CHECK_INTERVAL_MS };
}

module.exports = {
    createUpdateService,
    releaseInfo,
    checksumOf,
    compareVersions,
    parseVersion,
    RELEASES_LATEST,
    CHECK_INTERVAL_MS,
    MAX_ZIP_BYTES,
};

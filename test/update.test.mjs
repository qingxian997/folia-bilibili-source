// GitHub Release 更新器：只测纯逻辑与注入 IO，不联网。
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    createUpdateService,
    releaseInfo,
    checksumOf,
    compareVersions,
    parseVersion,
} from '../lib/update.cjs';

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const assetName = 'bilibili-2.1.0.zip';
const digest = sha256('fake zip');
const body = `## 校验\n\n| 文件 | 大小 | sha256 |\n| --- | --- | --- |\n| \`${assetName}\` | 1 KB | \`${digest}\` |`;

const release = {
    tag_name: 'v2.1.0',
    name: '2.1.0 — 适配 Folia 0.8.0',
    draft: false,
    prerelease: false,
    body,
    assets: [{ name: assetName, size: 8, browser_download_url: 'https://example.test/bilibili-2.1.0.zip' }],
};

test('版本号比较只认三段数字', () => {
    assert.deepEqual(parseVersion('v2.1.0'), [2, 1, 0]);
    assert.equal(parseVersion('2.1'), null);
    assert.ok(compareVersions('2.1.0', '2.0.0') > 0);
    assert.ok(compareVersions('2.0.0', '2.0.1') < 0);
    assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
});

test('从 Release 正文读 sha256 表格', () => {
    assert.equal(checksumOf(body, assetName), digest);
    assert.equal(checksumOf(body, 'bilibili-2.1.0-source.zip'), null);
});

test('releaseInfo 过滤预发布、旧版本和缺校验的包', () => {
    assert.equal(releaseInfo({ ...release, prerelease: true }, '2.0.0'), null);
    assert.equal(releaseInfo({ ...release, tag_name: 'v1.9.0' }, '2.0.0'), null);
    assert.equal(releaseInfo({ ...release, body: '没有校验表' }, '2.0.0'), null);
    const info = releaseInfo(release, '2.0.0');
    assert.equal(info.available, true);
    assert.equal(info.version, '2.1.0');
    assert.equal(info.sha256, digest);
    assert.equal(info.url, 'https://example.test/bilibili-2.1.0.zip');
    assert.equal(releaseInfo(release, '2.0.0', '2.1.0').reason, 'skipped');
});

test('createUpdateService 检查有缓存、跳过可持久化、下载校验 sha256', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-update-'));
    let calls = 0;
    const saved = new Map();
    const notices = [];
    const service = createUpdateService({
        getJson: async () => { calls += 1; return release; },
        download: async (_url, file) => fs.writeFileSync(file, 'fake zip'),
        cacheDir: dir,
        currentVersion: '2.0.0',
        storage: {
            get: async (key) => saved.get(key) || null,
            set: async (key, value) => saved.set(key, value),
        },
        log: { info() {} },
        notify: (name, payload) => notices.push([name, payload]),
    });

    const first = await service.check();
    assert.equal(first.version, '2.1.0');
    await service.check();
    assert.equal(calls, 1, '六小时内不该重复问 GitHub');
    assert.ok(notices.some(([name]) => name === 'update.state'));

    const downloaded = await service.download();
    assert.equal(downloaded.version, '2.1.0');
    assert.equal(fs.readFileSync(downloaded.file, 'utf8'), 'fake zip');

    await service.skip('2.1.0');
    const afterSkip = await service.check(true);
    assert.equal(afterSkip.reason, 'skipped');
    assert.equal(saved.get('update').skipped, '2.1.0');
    fs.rmSync(dir, { recursive: true, force: true });
});

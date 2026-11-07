import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import qrcode from '../vendor/qrcode.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const matrixOf = (payload) => {
    const qr = qrcode(0, 'M');
    qr.addData(payload);
    qr.make();
    const size = qr.getModuleCount();
    let rows = '';
    for (let row = 0; row < size; row += 1) {
        let line = '';
        for (let column = 0; column < size; column += 1) line += qr.isDark(row, column) ? '1' : '0';
        rows += `${line}\n`;
    }
    return { size, rows };
};

test('二维码库能编出结构合法的矩阵（尺寸 4n+1、三个定位图形）', () => {
    const { size, rows } = matrixOf('https://www.bilibili.com/h5/login?qrcode_key=9f2b1c7d4e6a8b0c5d3e1f7a9b2c4d6e');
    assert.equal(size, 37);
    assert.equal((size - 17) % 4, 0);
    const lines = rows.trim().split('\n');
    // 左上 / 右上 / 左下的 7x7 定位图形
    assert.equal(lines[0].slice(0, 7), '1111111');
    assert.equal(lines[0].slice(-7), '1111111');
    assert.equal(lines[6].slice(0, 7), '1111111');
    assert.equal(lines[size - 1].slice(0, 7), '1111111');
});

test('二维码输出与已验证矩阵一致（OpenCV 解码通过的那一份）', () => {
    const { rows } = matrixOf('https://www.bilibili.com/h5/login?qrcode_key=9f2b1c7d4e6a8b0c5d3e1f7a9b2c4d6e');
    assert.equal(createHash('sha256').update(rows).digest('hex'), 'e016b60ea880723ecdd857e1620c99b69afa59f48af5971f1e88b2b06701b8b0');
});

test('清单按 Folium 1 的规则自洽', async () => {
    const manifest = JSON.parse(await readFile(join(root, 'mod.json'), 'utf8'));
    assert.equal(manifest.folium, 1);
    assert.match(manifest.id, /^[a-z0-9][a-z0-9-]*$/);
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    assert.ok(manifest.client, '至少要有一个入口');
    const known = new Set([
        'filesystem.data',
        'playback.read',
        'render.export',
        'playback.control',
        'playback.queue',
        'equalizer.control',
        'visualizer.renderQuality',
        'visualizer.mode',
        'visualizer.tuning',
        'visualizer.beatEffects',
        'net.fetch',
        'net.embed',
        'stageLayers',
        'platform.netease.read',
        'platform.netease.write',
    ]);
    for (const permission of manifest.permissions || []) {
        assert.ok(known.has(permission), `未知权限：${permission}`);
    }
    // 入口文件真实存在
    await readFile(join(root, manifest.client), 'utf8');
    if (manifest.main) await readFile(join(root, manifest.main), 'utf8');
});

test('client 不 import 裸模块名（只能相对路径）', async () => {
    const source = await readFile(join(root, 'client.mjs'), 'utf8');
    const specifiers = [...source.matchAll(/^\s*import\s+[^'"]*['"]([^'"]+)['"]/gm)].map((match) => match[1]);
    assert.ok(specifiers.length > 0);
    for (const specifier of specifiers) {
        assert.ok(specifier.startsWith('./') || specifier.startsWith('../'), `裸模块名：${specifier}`);
    }
});

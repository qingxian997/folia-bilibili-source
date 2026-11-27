// 运行包里的 client.mjs 必须把相对 import 都换成带版本号的写法。
// 否则升级后同一 Folia 进程内会命中旧的 lib 模块缓存，静态 import 直接抛错。
// 这里不测「能不能跑」，只测改写本身是否自洽——跑起来由 panel.test.mjs 负责。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const BUILD = path.join(ROOT, 'build');

const SPEC = /(\bfrom\s*|\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\2/g;

function walk(dir, base = '') {
    let out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = base ? `${base}/${entry.name}` : entry.name;
        if (entry.isDirectory()) out = out.concat(walk(path.join(dir, entry.name), rel));
        else out.push(rel);
    }
    return out;
}

function runBuild() {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'version-imports.mjs')], { cwd: ROOT });
}

test('build/ 由源码生成，入口和 vendor 都在', () => {
    runBuild();
    assert.ok(fs.existsSync(path.join(BUILD, 'client.mjs')), '缺 build/client.mjs');
    assert.ok(fs.existsSync(path.join(BUILD, 'vendor', 'qrcode.mjs')), '缺 build/vendor/qrcode.mjs');
    assert.ok(fs.existsSync(path.join(BUILD, 'lib', 'collections.mjs')), '缺 build/lib/collections.mjs');
});

test('build/ 里每个相对 import 都带版本号，且指向真实文件', () => {
    runBuild();
    const files = walk(BUILD);
    const missing = [];
    const bare = [];

    for (const rel of files) {
        if (!rel.endsWith('.mjs')) continue;
        const text = fs.readFileSync(path.join(BUILD, rel), 'utf8');
        for (const match of text.matchAll(SPEC)) {
            const spec = match[3];
            if (!spec.includes('?v=')) {
                bare.push(`${rel} -> ${spec}`);
                continue;
            }
            const target = spec.split('?')[0];
            const resolved = path.resolve(path.dirname(path.join(BUILD, rel)), target);
            if (!fs.existsSync(resolved)) missing.push(`${rel} -> ${spec}`);
        }
    }

    assert.deepEqual(bare, [], '有相对 import 没带版本号，升级后会命中旧模块缓存');
    assert.deepEqual(missing, [], '版本化后的路径指向了不存在的文件');
});

test('同一个目标模块在各处引用时版本一致', () => {
    runBuild();
    const seen = new Map();
    const conflicts = [];

    for (const rel of walk(BUILD)) {
        if (!rel.endsWith('.mjs')) continue;
        const text = fs.readFileSync(path.join(BUILD, rel), 'utf8');
        for (const match of text.matchAll(SPEC)) {
            const [target, version] = match[3].split('?v=');
            if (!version) continue;
            const key = path.resolve(path.dirname(path.join(BUILD, rel)), target);
            if (seen.has(key) && seen.get(key) !== version) {
                conflicts.push(`${key}: ${seen.get(key)} vs ${version}`);
            }
            seen.set(key, version);
        }
    }

    assert.deepEqual(conflicts, [], '同一个文件出现了两个版本号，说明改写时映射错了目标');
});

test('build/client.mjs 能真正加载，默认导出是 activate', async () => {
    runBuild();
    const mod = await import(pathToFileURL(path.join(BUILD, 'client.mjs')).href);
    assert.equal(typeof mod.default, 'function', '产物加载不了，说明改写把 import 弄坏了');
});

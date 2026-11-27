#!/usr/bin/env node
// scripts/version-imports.mjs
//
// 给 client.mjs 和 lib/*.mjs 里的**相对 import** 加上内容版本 query。
//
// 为什么要这么做：宿主只给模组入口加版本号
//   folia-mod://bilibili/client.mjs?v=<digest>
// 而 `client.mjs` 里的 `import './lib/collections.mjs'` 解析出来**不带 query**。
// 于是在同一个 Folia 进程里升级模组时，新 client 会命中旧的 lib 模块缓存，
// 静态 import 阶段直接抛：
//   The requested module './lib/collections.mjs' does not provide an export named 'expandPages'
// 重启宿主能好，但用户第一眼看到的是「模组坏了」。
//
// 这里把每个被 import 文件的内容摘要写进 URL。内容一变，URL 就变，模块缓存自然失效；
// 内容没变就复用缓存，也不浪费。
//
// 宿主的协议处理只读 `url.pathname`（见 electron/modProtocol.cjs），query 被忽略，
// 所以带 query 仍然能取到同一个文件。
//
// 产物在 build/：runtime 包和本机部署都用它，源码结构保持不变。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'build');
const ENTRY = 'client.mjs';
/** 只有渲染进程的 .mjs 需要改写；主进程的 .cjs 走 require，原样复制。 */
const RENDER_DIRS = ['lib', 'vendor'];

const SPEC = /(\bfrom\s*|\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\2/g;

const shortHash = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 8);

function walk(dir, base = '') {
    let out = [];
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = base ? `${base}/${entry.name}` : entry.name;
        if (entry.isDirectory()) out = out.concat(walk(path.join(dir, entry.name), rel));
        else out.push(rel);
    }
    return out;
}

/** 源码里所有要进包的文件（相对路径，正斜杠）。 */
function sourceFiles() {
    const files = [ENTRY];
    for (const dir of RENDER_DIRS) {
        for (const rel of walk(path.join(ROOT, dir), dir)) files.push(rel);
    }
    return files;
}

/**
 * 把相对 import 换成带版本的写法。
 *
 * 版本取**目标文件原始内容**的摘要，所以它和「谁 import 它」无关：
 * 同一个模块被多个文件引用时 URL 一致，仍然只加载一次。
 */
function rewrite(text, versions) {
    return text.replace(SPEC, (whole, lead, quote, specifier) => {
        if (specifier.includes('?v=')) return whole;
        const target = specifier.replace(/^\.\//, '').replace(/^\.\.\//, '');
        // 相对路径按「引用方所在目录」解析，所以这里只查文件名尾部。
        const hit = versions.find((item) => item.rel === target || item.rel.endsWith(`/${target}`));
        if (!hit) return whole;
        return `${lead}${quote}${specifier}?v=${hit.hash}${quote}`;
    });
}

/** 纯 .mjs 的相对引用才算「必须带版本」。 */
const relativeSpecs = (text) => {
    const out = [];
    for (const match of text.matchAll(SPEC)) out.push(match[3]);
    return out;
};

/**
 * 生成 build/。可重复执行，输出稳定。
 * @returns {{ files: string[], warnings: string[] }}
 */
export function build() {
    const files = sourceFiles();
    const versions = files
        .filter((rel) => rel.endsWith('.mjs'))
        .map((rel) => ({ rel, hash: shortHash(fs.readFileSync(path.join(ROOT, rel), 'utf8')) }));

    const warnings = [];

    for (const rel of files) {
        const from = path.join(ROOT, rel);
        const to = path.join(OUT, rel);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        const raw = fs.readFileSync(from);
        if (!rel.endsWith('.mjs')) {
            fs.writeFileSync(to, raw);
            continue;
        }
        const text = raw.toString('utf8');
        const next = rewrite(text, versions);
        for (const spec of relativeSpecs(next)) {
            if (!spec.includes('?v=')) warnings.push(`${rel} 的 ${spec} 没找到对应文件，未加版本`);
        }
        fs.writeFileSync(to, next);
    }

    // 不删目录，只覆盖写。哪些文件该进包以这份清单为准：
    // 源码里删掉的模块会留在 build/ 里，但不会被打进包。
    fs.writeFileSync(
        path.join(OUT, 'manifest.json'),
        `${JSON.stringify({ entry: ENTRY, files }, null, 4)}\n`,
        'utf8',
    );

    return { files, warnings };
}

/** 把 build/ 里的入口和 lib 目录路径暴露出去，pack.py / 部署脚本照着拷贝即可。 */
export function buildManifest() {
    return { root: OUT, files: sourceFiles() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
    const { files, warnings } = build();
    for (const warning of warnings) console.warn('警告:', warning);
    console.log(`已生成 build/：${files.length} 个文件（入口 ${ENTRY}）`);
}

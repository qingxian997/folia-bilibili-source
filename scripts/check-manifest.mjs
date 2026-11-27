#!/usr/bin/env node
// scripts/check-manifest.mjs
//
// 在 CI 里替宿主把一遍关：mod.json 写错的话，装进去只会看到一行红字，还得开 Folia 才知道。
// 规则抄自宿主 electron/modSystem/manifest.cjs（Folium 2），只覆盖这个模组会碰到的字段。
//
// 额外查一件宿主不查的事：mod.json 的 version 和 client.mjs 里的 MOD_VERSION 必须一致，
// 否则设置面板底部显示的版本号和模组卡片对不上，排查时非常容易看错。

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const errors = [];

const FOLIUM_MAJOR = 2;
const MOD_ID = /^[a-z0-9][a-z0-9-]*$/;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const VERSION = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/;

// 宿主认识的全部字段；Folium 2 里多写一个就是错误。
const FIELDS = new Set([
    'folium', 'id', 'name', 'version', 'author', 'description', 'main', 'client',
    'depends', 'permissions', 'experimental', 'embedOrigins', 'folia', 'preview',
    'sources', 'locales', 'assets', 'secrets', 'contexts', 'native', 'repository', 'bugs',
]);
const CAPABILITIES = new Set([
    'search', 'songs', 'playback.audio', 'playback.external', 'playback.surface',
    'reports', 'lyrics', 'auth', 'library', 'catalog', 'recommendations',
    'explore', 'mutations', 'covers', 'raw',
]);

// foliumShared.json 里的权限与实验位
const PERMISSIONS = new Set([
    'filesystem.data', 'playback.read', 'playback.control', 'playback.queue',
    'equalizer.control', 'visualizer.renderQuality', 'visualizer.mode',
    'visualizer.tuning', 'visualizer.beatEffects', 'render.export',
    'net.fetch', 'net.embed', 'stageLayers',
    'platform.netease.read', 'platform.netease.write',
]);
const EXPERIMENTAL = new Set([
    'omni.providers', 'omni.hooks', 'ponder.targets',
    'player.layout', 'remote.actions', 'platform.raw',
]);

const safeRelative = (value) => (
    typeof value === 'string'
    && value.trim().length > 0
    && !value.includes('..')
    && !value.includes('\\')
    && !value.startsWith('/')
    && !/^[a-zA-Z]:/.test(value)
);

function checkHostRange(range) {
    if (typeof range !== 'string' || !range.trim()) return false;
    if (range.trim() === '*') return true;
    return range.trim().split(/\s+/).every((token) => /^(>=|>|<=|<|=|\^)?[0-9]+\.[0-9]+\.[0-9]+$/.test(token));
}

let manifest;
try {
    manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'mod.json'), 'utf8'));
} catch (error) {
    console.error('读不了 mod.json:', error.message);
    process.exit(1);
}

if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    errors.push('mod.json 的根必须是对象');
} else {
    for (const field of Object.keys(manifest)) {
        if (!FIELDS.has(field)) errors.push(`未知字段 "${field}"；mod.json 只允许：${[...FIELDS].join(', ')}`);
    }
    if (manifest.folium !== FOLIUM_MAJOR) errors.push(`folium 必须是 ${FOLIUM_MAJOR}，现在是 ${JSON.stringify(manifest.folium)}`);
    if (typeof manifest.id !== 'string' || !MOD_ID.test(manifest.id)) errors.push('id 必须匹配 /^[a-z0-9][a-z0-9-]*$/');
    if (typeof manifest.name !== 'string' || !manifest.name.trim()) errors.push('name 必填');
    else if (manifest.name.length > 64) errors.push('name 最多 64 个字符');

    const parsed = VERSION.exec(String(manifest.version ?? '').trim());
    if (!parsed) errors.push('version 必须是三段数字，例如 0.9.0（0.9.0-preview 会被宿主拒绝）');

    if (!manifest.main && !manifest.client) errors.push('至少要有一个入口：main 或 client');
    if (manifest.main && (!safeRelative(manifest.main) || manifest.main.includes('/') || !/\.c?js$/.test(manifest.main))) {
        errors.push('main 必须是模组目录下的单个 .cjs/.js 文件名（不能带路径）');
    }
    if (manifest.client && (!safeRelative(manifest.client) || !/\.m?js$/.test(manifest.client))) {
        errors.push('client 必须是模组目录下的相对 .mjs/.js 路径');
    }
    if (manifest.preview && (!safeRelative(manifest.preview) || !/\.(png|jpe?g|webp)$/i.test(manifest.preview))) {
        errors.push('preview 必须是模组目录下的 .png/.jpg/.webp 相对路径');
    }

    const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
    for (const permission of permissions) {
        if (!PERMISSIONS.has(permission)) errors.push(`未知权限 "${permission}"`);
    }
    if (new Set(permissions).size !== permissions.length) errors.push('权限有重复项');

    const experimental = Array.isArray(manifest.experimental) ? manifest.experimental : [];
    for (const feature of experimental) {
        if (!EXPERIMENTAL.has(feature)) errors.push(`未知实验位 "${feature}"`);
    }

    if (manifest.folia && !checkHostRange(manifest.folia)) {
        errors.push(`folia 版本范围写法不对："${manifest.folia}"（例：">=0.8.0 <0.9.0"）`);
    }

    if (!Array.isArray(manifest.sources) || manifest.sources.length === 0) {
        errors.push('folium:2 音源模组必须用 sources 列出至少一个音源');
    } else {
        for (const source of manifest.sources) {
            if (!source || !SOURCE_ID.test(String(source.id || ''))) errors.push('sources[].id 必须是字母数字开头的最多 64 字符 id');
            const requires = source.requires === undefined ? [] : source.requires;
            if (!Array.isArray(requires)) errors.push('sources[].requires 必须是数组');
            else for (const capability of requires) {
                const match = /^([a-z][a-z0-9.-]*)@([1-9][0-9]*)$/.exec(String(capability));
                if (!match || !CAPABILITIES.has(match[1]) || match[2] !== '1') {
                    errors.push(`sources[].requires 里的 "${capability}" 不是宿主实现的能力`);
                }
            }
        }
    }

    // 权限声明了却从没用过，等于在信任弹窗里多要一项，属于过度授权。
    const sources = ['index.cjs', 'client.mjs']
        .map((file) => {
            try {
                return fs.readFileSync(path.join(ROOT, file), 'utf8');
            } catch {
                return '';
            }
        })
        .join('\n');
    const usage = {
        'filesystem.data': /folium\.rpc\.call|api\.storage\./,
        'playback.control': /folium\.playback\.(play|pause|toggle|seek|next|previous|playSong|enqueue|toggleLike)/,
        'playback.queue': /folium\.playback\.(replaceQueue|enqueue)/,
    };
    for (const [permission, pattern] of Object.entries(usage)) {
        if (permissions.includes(permission) && !pattern.test(sources)) {
            errors.push(`声明了 ${permission}，但代码里没找到对应的调用（多余授权）`);
        }
    }

    // 版本跟客户端常量对齐
    const client = sources;
    const modVersion = /const MOD_VERSION = '([^']+)'/.exec(client);
    if (!modVersion) errors.push('client.mjs 里找不到 MOD_VERSION');
    else if (parsed && modVersion[1] !== manifest.version) {
        errors.push(`版本不一致：mod.json 是 ${manifest.version}，client.mjs 是 ${modVersion[1]}`);
    }

    // 入口文件必须真的在
    for (const field of ['main', 'client']) {
        const rel = manifest[field];
        if (typeof rel === 'string' && !fs.existsSync(path.join(ROOT, rel))) {
            errors.push(`${field} 指向的文件不存在：${rel}`);
        }
    }
}

// 运行包里的相对 import 必须带内容版本号。
// 宿主只给入口 URL 加 digest，相对 import 不带版本；升级后同一进程内会命中旧模块缓存，
// 报「does not provide an export named …」。这条检查同时保证 build/ 与源码同步。
try {
    const { build } = await import('./version-imports.mjs');
    build();
    const bare = [];
    const scan = (rel) => {
        const text = fs.readFileSync(path.join(ROOT, 'build', rel), 'utf8');
        for (const quote of ['"', "'"]) {
            for (const chunk of text.split(`from ${quote}`).slice(1)) {
                const spec = chunk.split(quote)[0];
                if (spec.startsWith('.') && !spec.includes('?v=')) bare.push(`${rel} -> ${spec}`);
            }
        }
    };
    scan('client.mjs');
    const libDir = path.join(ROOT, 'build', 'lib');
    if (fs.existsSync(libDir)) {
        for (const name of fs.readdirSync(libDir)) {
            if (name.endsWith('.mjs')) scan(`lib/${name}`);
        }
    }
    if (!fs.existsSync(path.join(ROOT, 'build', 'vendor', 'qrcode.mjs'))) {
        errors.push('build/vendor/qrcode.mjs 不存在：version-imports 没把 vendor 复制进去');
    }
    if (bare.length) {
        errors.push(`build/ 里有 ${bare.length} 处相对 import 没带版本号：${bare.slice(0, 3).join('，')}`);
    }
} catch (error) {
    errors.push(`生成 build/ 失败：${error && error.message}`);
}

if (errors.length) {
    console.error('mod.json 有 %d 处问题：', errors.length);
    for (const message of errors) console.error('  -', message);
    process.exit(1);
}
console.log(`mod.json 通过：${manifest.id} ${manifest.version}（folia ${manifest.folia}）`);

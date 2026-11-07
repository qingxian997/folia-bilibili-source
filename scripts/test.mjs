#!/usr/bin/env node
// scripts/test.mjs
//
// 为什么要这一层：`node --test "test/*.test.mjs"` 在 Windows 上要靠 Node 自己展开通配符
// （cmd 不展开），在 Linux 上靠 shell 展开，两边行为不一样，Node 20 早期版本还不支持。
// 这里直接列文件名再交给 `node --test`，三个平台、各个 Node 版本都一样。

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const dir = path.join(root, 'test');
const files = readdirSync(dir)
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => path.join('test', name));

if (!files.length) {
    console.error('test/ 下没有 *.test.mjs');
    process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);

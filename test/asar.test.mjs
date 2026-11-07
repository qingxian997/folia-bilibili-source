// 宿主装在 app.asar 里，主进程不一定带 Electron 的 fs 补丁。这个解析器就是那条退路：
// 只按格式读头，不依赖任何 Electron API。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readAsarIndex, listAsarDir } from '../lib/asar.cjs';

/** 照 asar 的头格式拼一个最小包：16 字节头 + JSON 目录树。 */
const makeAsar = (tree) => {
    const json = Buffer.from(JSON.stringify(tree), 'utf8');
    const head = Buffer.alloc(16);
    head.writeUInt32LE(4, 0);
    head.writeUInt32LE(8, 4);
    head.writeUInt32LE(json.length, 12);
    const file = path.join(os.tmpdir(), `asar-test-${process.pid}-${Math.random().toString(36).slice(2)}.bin`);
    fs.writeFileSync(file, Buffer.concat([head, json]));
    return file;
};

const TREE = {
    files: {
        dist: {
            files: {
                assets: {
                    files: {
                        'useLyricSettingsStore-Cbyi_7vr.js': { size: 14389, offset: '1' },
                        'useAppViewStore-D7tzcNtE.js': { size: 1544, offset: '2' },
                        nested: { files: { 'skip.js': { size: 1, offset: '3' } } },
                    },
                },
            },
        },
    },
};

test('asar：读得出头里的目录树', () => {
    const file = makeAsar(TREE);
    try {
        const index = readAsarIndex(file);
        assert.ok(index.files.dist.files.assets.files);
    } finally {
        fs.unlinkSync(file);
    }
});

test('asar：列目录只给文件，不给子目录', () => {
    const file = makeAsar(TREE);
    try {
        const names = listAsarDir(file, ['dist', 'assets']);
        assert.deepEqual(names.sort(), ['useAppViewStore-D7tzcNtE.js', 'useLyricSettingsStore-Cbyi_7vr.js']);
        assert.equal(names.includes('nested'), false, '子目录不算进去');
    } finally {
        fs.unlinkSync(file);
    }
});

test('asar：目录不存在就是空数组，不抛', () => {
    const file = makeAsar(TREE);
    try {
        assert.deepEqual(listAsarDir(file, ['dist']), []);
        assert.deepEqual(listAsarDir(file, ['nope']), []);
    } finally {
        fs.unlinkSync(file);
    }
});

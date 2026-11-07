'use strict';

// Electron 的 fs 对 asar 有内建补丁，但模组主进程不一定跑在那样的环境里。
// 这里直接按格式读：16 字节头，offset 12 起是 uint32 的 JSON 长度，紧跟着目录树。
// 只读、不依赖任何 Electron API，所以纯 Node 下也能用。

const fs = require('node:fs');

const HEAD = 16;
const LIMIT = 64 * 1024 * 1024;

/** asar 头里的目录树（`{ files: { ... } }`）。 */
function readAsarIndex(archive) {
    const fd = fs.openSync(archive, 'r');
    try {
        const head = Buffer.alloc(HEAD);
        const got = fs.readSync(fd, head, 0, HEAD, 0);
        if (got < HEAD) throw new Error('asar: 文件太短');
        const size = head.readUInt32LE(12);
        if (!size || size > LIMIT) throw new Error('asar: 头部长度不对劲');
        const body = Buffer.alloc(size);
        fs.readSync(fd, body, 0, size, HEAD);
        return JSON.parse(body.toString('utf8').replace(/\0+$/, ''));
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * asar 里某个目录下的文件名（只列文件，不含子目录）。
 * 目录不存在就返回空数组——调用方按「这层没找到」处理。
 */
function listAsarDir(archive, segments) {
    let node = readAsarIndex(archive);
    for (const segment of segments || []) {
        const files = node && node.files;
        if (!files || !files[segment] || !files[segment].files) return [];
        node = files[segment];
    }
    const files = (node && node.files) || {};
    return Object.keys(files).filter((name) => files[name] && !files[name].files);
}

module.exports = { readAsarIndex, listAsarDir };

#!/usr/bin/env python3
"""打发布包。

    python scripts/pack.py            # 版本号读 mod.json
    python scripts/pack.py 0.9.1      # 临时改个版本号（不会写回 mod.json）

产物在 dist/：
    bili-fav-wall-<ver>.zip          只要运行需要的文件，解压到模组目录就能用
    bili-fav-wall-<ver>-source.zip   多带 test/ 和 docs/，给别人看代码用

用 zipfile 写正斜杠条目名：PowerShell 5.1 的 Compress-Archive 会写反斜杠，
宿主的解压会判成「包含不安全的路径」。
"""

import hashlib
import json
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

RUNTIME_FILES = ['mod.json', 'index.cjs', 'client.mjs', 'README.md', 'LICENSE']
RUNTIME_DIRS = ['lib', 'vendor']
SOURCE_EXTRA_DIRS = ['test', 'docs', 'scripts']
SOURCE_EXTRA_FILES = ['package.json', 'package-lock.json', 'CONTRIBUTING.md']


def version_from_manifest():
    with open(os.path.join(ROOT, 'mod.json'), encoding='utf-8') as handle:
        return json.load(handle)['version']


def collect(dirs, files):
    out = [name for name in files if os.path.exists(os.path.join(ROOT, name))]
    for name in dirs:
        base = os.path.join(ROOT, name)
        if not os.path.isdir(base):
            continue
        for current, _dirs, names in os.walk(base):
            # 测试夹具里的 node_modules 之类一律不进包
            if 'node_modules' in current.split(os.sep):
                continue
            for name_ in sorted(names):
                full = os.path.join(current, name_)
                out.append(os.path.relpath(full, ROOT).replace(os.sep, '/'))
    return sorted(set(out))


def build(target, entries):
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
        for rel in entries:
            archive.write(os.path.join(ROOT, rel.replace('/', os.sep)), rel)

    with zipfile.ZipFile(target) as archive:
        names = archive.namelist()
        bad = [name for name in names if '\\' in name]
        assert not bad, '出现反斜杠条目: %r' % bad[:3]
        assert 'mod.json' in names, 'mod.json 必须在根目录'
        assert 'index.cjs' in names and 'client.mjs' in names, '缺入口文件'
        digest = hashlib.sha256(open(target, 'rb').read()).hexdigest()
        print('%-42s %3d 个文件  %7.1f KB' % (os.path.basename(target), len(names), os.path.getsize(target) / 1024))
        print('  sha256 %s' % digest)
        return digest


def main():
    version = sys.argv[1] if len(sys.argv) > 1 else version_from_manifest()
    out_dir = os.path.join(ROOT, 'dist')
    os.makedirs(out_dir, exist_ok=True)

    runtime = collect(RUNTIME_DIRS, RUNTIME_FILES)
    source = collect(RUNTIME_DIRS + SOURCE_EXTRA_DIRS, RUNTIME_FILES + SOURCE_EXTRA_FILES)

    print('版本 %s' % version)
    build(os.path.join(out_dir, 'bili-fav-wall-%s.zip' % version), runtime)
    build(os.path.join(out_dir, 'bili-fav-wall-%s-source.zip' % version), source)
    print('\n把上面两行 sha256 贴进 GitHub Release 说明。')


if __name__ == '__main__':
    main()

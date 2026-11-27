#!/usr/bin/env python3
"""打发布包。

    python scripts/pack.py            # 版本号读 mod.json
    python scripts/pack.py 2.0.2      # 临时改个版本号（不会写回 mod.json）

产物在 dist/：
    bilibili-<ver>.zip          只要运行需要的文件，解压到模组目录就能用
    bilibili-<ver>-source.zip   多带 test/ 和 docs/，给别人看代码用

runtime 包的 client.mjs、lib/、vendor/ 取自 build/（由 scripts/version-imports.mjs 生成），
里面每个相对 import 都带内容版本号，用来避免升级后命中旧的模块缓存。
source 包保持原始源码结构，方便阅读和 diff。

用 zipfile 写正斜杠条目名：PowerShell 5.1 的 Compress-Archive 会写反斜杠，
宿主的解压会判成「包含不安全的路径」。
"""

import hashlib
import json
import os
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, 'build')

# 渲染进程那份带版本号的入口与模块，来自 build/
BUILT_FILES = ['client.mjs']
BUILT_DIRS = ['lib', 'vendor']

# 其余运行必需文件直接用源码
RUNTIME_FILES = ['mod.json', 'index.cjs', 'README.md', 'LICENSE']
SOURCE_EXTRA_DIRS = ['test', 'docs', 'scripts']
SOURCE_EXTRA_FILES = ['package.json', 'package-lock.json', 'CONTRIBUTING.md']


def version_from_manifest():
    with open(os.path.join(ROOT, 'mod.json'), encoding='utf-8') as handle:
        return json.load(handle)['version']


def walk(base, prefix):
    out = []
    for current, _dirs, names in os.walk(base):
        # 测试夹具里的 node_modules 之类一律不进包
        if 'node_modules' in current.split(os.sep):
            continue
        for name in sorted(names):
            full = os.path.join(current, name)
            rel = os.path.relpath(full, base).replace(os.sep, '/')
            out.append((full, f'{prefix}/{rel}' if prefix else rel))
    return out


def collect(files, dirs=()):
    out = []
    for name in files:
        full = os.path.join(ROOT, name)
        if os.path.exists(full):
            out.append((full, name))
    for name in dirs:
        base = os.path.join(ROOT, name)
        if os.path.isdir(base):
            out.extend(walk(base, name))
    return out


def built_entries():
    """build/ 里该进包的文件，以 manifest.json 为准（不扫目录，免得带上已删除模块的残留）。"""
    manifest_path = os.path.join(BUILD, 'manifest.json')
    if not os.path.exists(manifest_path):
        raise SystemExit('build/manifest.json 不存在，先跑 node scripts/version-imports.mjs')
    with open(manifest_path, encoding='utf-8') as handle:
        data = json.load(handle)
    entries = []
    for rel in data.get('files', []):
        full = os.path.join(BUILD, rel.replace('/', os.sep))
        if os.path.exists(full):
            entries.append((full, rel))
    return entries


def build_zip(target, entries):
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
        for source, rel in entries:
            archive.write(source, rel)

    with zipfile.ZipFile(target) as archive:
        names = archive.namelist()
        bad = [name for name in names if '\\' in name]
        assert not bad, '出现反斜杠条目: %r' % bad[:3]
        assert 'mod.json' in names, 'mod.json 必须在根目录'
        assert 'index.cjs' in names and 'client.mjs' in names, '缺入口文件'
        digest = hashlib.sha256(open(target, 'rb').read()).hexdigest()
        print('%-42s %3d 个文件  %7.1f KB' % (os.path.basename(target), len(names), os.path.getsize(target) / 1024))
        print('  sha256 %s' % digest)
        return digest, names


def ensure_build():
    """重跑一次 version-imports，保证 build/ 和源码一致。"""
    script = os.path.join(ROOT, 'scripts', 'version-imports.mjs')
    result = subprocess.run(['node', script], cwd=ROOT, capture_output=True, text=True, encoding='utf-8')
    if result.returncode != 0:
        raise SystemExit('生成 build/ 失败:\n%s%s' % (result.stdout, result.stderr))
    print(result.stdout.strip())


def bare_relative_imports(names, archive):
    """运行包里不允许出现不带版本号的相对 import。"""
    bare = []
    for name in names:
        if not name.endswith('.mjs'):
            continue
        text = archive.read(name).decode('utf-8')
        for quote in ('"', "'"):
            for chunk in text.split('from ' + quote)[1:]:
                spec = chunk.split(quote)[0]
                if spec.startswith('.') and '?v=' not in spec:
                    bare.append('%s -> %s' % (name, spec))
            for chunk in text.split('import(' + quote)[1:]:
                spec = chunk.split(quote)[0]
                if spec.startswith('.') and '?v=' not in spec:
                    bare.append('%s -> %s' % (name, spec))
    return sorted(set(bare))


def main():
    version = sys.argv[1] if len(sys.argv) > 1 else version_from_manifest()
    out_dir = os.path.join(ROOT, 'dist')
    os.makedirs(out_dir, exist_ok=True)

    ensure_build()

    runtime = collect(RUNTIME_FILES) + built_entries()
    source = collect(RUNTIME_FILES + BUILT_FILES + SOURCE_EXTRA_FILES, BUILT_DIRS + SOURCE_EXTRA_DIRS)

    print('版本 %s' % version)
    runtime_zip = os.path.join(out_dir, 'bilibili-%s.zip' % version)
    _, runtime_names = build_zip(runtime_zip, runtime)
    build_zip(os.path.join(out_dir, 'bilibili-%s-source.zip' % version), source)

    with zipfile.ZipFile(runtime_zip) as archive:
        bare = bare_relative_imports(runtime_names, archive)
    if bare:
        raise SystemExit('运行包里有不带版本号的相对 import:\n  ' + '\n  '.join(bare))

    print('\n把上面两行 sha256 贴进 GitHub Release 说明。')


if __name__ == '__main__':
    main()

# AGENTS.md

给在这个仓库里干活的人（和 AI）看的入口文档。模块细节见 `docs/modules/`。

| 文档 | 内容 |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 分层、九项能力、状态归属、分页与音质模型 |
| [docs/API-RPC.md](docs/API-RPC.md) | 33 个 RPC 的参数与返回字段 |
| [docs/modules/](docs/modules/README.md) | 26 个模块的分域文档 |
| [docs/TODO-2.0.3.md](docs/TODO-2.0.3.md) | 当前待办与已定方案 |

## 这是什么

Folia / Folium 2 的 bilibili 音源模组。只做视频音源：把公开视频的音频、字幕和曲库信息
整理成宿主认识的形状。不碰番剧、电影、课程，也不接管宿主自己的播放器。

- 宿主范围：`folia: ">=0.8.0 <0.9.0"`，模组系统 0.2.0 / Folium 2
- 当前版本：2.0.2
- 许可：MIT，未上架官方市场，是未签名社区模组

## 分层

```text
client.mjs（渲染进程，2909 行）
    ↓ folium.rpc(name, [payload])
index.cjs（主进程，1935 行）
    ↓ https
bilibili API
```

**渲染进程不直接联网**。所有请求经 RPC 交给主进程，因为要自定义 Referer / Cookie，
也因为浏览器的 CORS 和 UA 不可控。

## 目录

| 路径 | 作用 |
| --- | --- |
| `client.mjs` | 渲染进程入口，default export `activate(folium)` |
| `index.cjs` | 主进程，`handle(name, fn)` 注册 RPC，`mod.json` 的 main |
| `lib/*.mjs` | 渲染侧纯函数模块，测试直接 import |
| `lib/*.cjs` | 主进程模块（cookie、store、asar、update、feed、proxyStream、memoCache） |
| `vendor/qrcode.mjs` | 二维码生成，第三方，勿改 |
| `test/*.test.mjs` | `node:test` + jsdom，按模块一文件 |
| `scripts/test.mjs` | 跑全部测试 |
| `scripts/check-manifest.mjs` | 清单字段白名单校验 |
| `scripts/pack.py` | 打 runtime / source 两个 zip |
| `docs/` | 变更记录、限制、发布说明、模块文档 |

## 常用命令

```bash
npm test                       # 全部测试（node --test）
node --test test/collections.test.mjs   # 单文件
npm run check                  # manifest 字段校验 + 重建 build/ 并检查版本号
npm run build                  # 只生成 build/（带版本号的 client + lib + vendor）
python scripts/pack.py         # 产出 dist/bilibili-<ver>.zip
```

本机部署（在 `D:/download/歌词` 下）：

```bash
node tools/deploy-mod.cjs      # 同步文件 + 重算信任摘要 + 写 enabled
```

## 硬规则

- **不写宿主 trust 记录**，不改 `mod-system.json` 的 `mods.enabled`。启用确认只走宿主接口。
- runtime zip 只含运行必需文件；`dist/` 不进 git。
- 改 `pack.py` 的文件清单时，同步 `check-manifest.mjs` 和 `docs/modules/09-infra.md`。
- 发布默认只本地提交 + 打包，**不 push、不发 Release**，除非明确要求。
- 注释和文档用中文；代码 4 空格缩进、单引号、带分号。
- 界面文案不写接口路径、进程名、宿主黑话；不用「即 / 通过 / 一键」。

## 容易踩的坑

1. **ESM 模块缓存**：宿主只给 client 入口加 digest query，相对 import 不带。
   升级后同进程内会命中旧 `lib/*.mjs`，报「does not provide an export named」。
   现在靠 `scripts/version-imports.mjs` 给每个相对 import 加内容版本号（产物在 `build/`）。
   **新增 `lib/*.mjs` 时不用手动登记**，脚本按目录扫；但别把 import 写成绝对路径或裸模块名。
2. **分页 offset 语义**：对外是**歌曲** offset，bilibili 内部是**视频** offset。
   宿主会校验 `nextOffset >= tracks.length`，回吐视频游标会被判为无效快照。
3. **分 P 元数据**：`view.pages` 可能为空，要回落 `x/player/pagelist`。
4. **音质**：只声明 `standard / high / ultra / lossless`，不声明 `hires`。
   界面显示实际流名（64K / 132K / 192K / FLAC / 杜比），不显示宿主通名。
5. **歌词行必须带 `words`**：`lyrics.lines` 少这个字段宿主渲染期直接崩。
6. **封面**：收藏夹接口不给封面，取夹内第一条视频，可能与内容不一致。
7. **确认 `settings` 字段类型**：只认 `number / text / boolean / select / color / secret`，
   界面形态放自定义键 `ui`。

## 提交前

```text
npm test 全绿 → npm run check 通过 → python scripts/pack.py → 真机覆盖安装验一次
```

`pack.py` 会自己先跑一次 `version-imports`，并在打完之后检查运行包里没有不带版本号的
相对 import。

真机验证时先完全退出 Folia（`taskkill //F //IM Folia.exe`），否则 CDP 可能连到旧实例。

# 模块文档

`lib/` 下 26 个模块按职责域分成 10 份文档。想快速定位某个文件，看下面的索引。

## 索引

| 文档 | 覆盖 | 什么时候看 |
| --- | --- | --- |
| [01-collections](01-collections.md) | `collections.mjs`、`extras.mjs` | 改分 P、改分页、改歌曲 DTO |
| [02-collected](02-collected.md) | `collected.mjs`、`searchCollections.mjs`、`exclude.mjs` | 改书库来源、搜索合集、黑白名单 |
| [03-lyrics](03-lyrics.md) | `lrc.mjs` | 歌词显示异常、逐字不生效 |
| [04-title](04-title.md) | `title.mjs` | 歌名/歌手解析不对 |
| [05-explore](05-explore.md) | `explore.mjs`、`recommend.mjs`、`feed.cjs` | 探索页、我喜欢的音乐 |
| [06-host-adapt](06-host-adapt.md) | `hostAdaptation`、`tabLabel`、`homeTab`、`searchTabs`、`hostlib` | 页签不改名、推荐没藏、书库墙空白 |
| [07-ui](07-ui.md) | `settingsPanel.mjs` | 改设置面板 |
| [08-net](08-net.md) | `proxyStream.cjs`、`cookie.cjs`、`bvid.cjs` | 音频中断、登录掉线 |
| [09-infra](09-infra.md) | `store`、`memoCache`、`asar`、`update`、`afterInstall`、`link` | 缓存、自更新、chunk 查找 |
| [10-vendor](10-vendor.md) | `vendor/qrcode.mjs` | 二维码 |

## 文件 → 文档

```text
lib/asar.cjs                → 09
lib/afterInstall.mjs        → 09
lib/bvid.cjs                → 08
lib/collected.mjs           → 02
lib/collections.mjs         → 01
lib/cookie.cjs              → 08
lib/exclude.mjs             → 02
lib/explore.mjs             → 05
lib/extras.mjs              → 01
lib/feed.cjs                → 05
lib/homeTab.mjs             → 06
lib/hostAdaptation.mjs      → 06
lib/hostlib.mjs             → 06
lib/link.mjs                → 09
lib/lrc.mjs                 → 03
lib/memoCache.cjs           → 09
lib/proxyStream.cjs         → 08
lib/recommend.mjs           → 05
lib/searchCollections.mjs   → 02
lib/searchTabs.mjs          → 06
lib/settingsPanel.mjs       → 07
lib/store.cjs               → 09
lib/tabLabel.mjs            → 06
lib/title.mjs               → 04
lib/update.cjs              → 09
vendor/qrcode.mjs           → 10
```

入口文件不在模块文档里：

- `client.mjs`：看 [ARCHITECTURE](../ARCHITECTURE.md) 和 [API-RPC](../API-RPC.md)
- `index.cjs`：看 [API-RPC](../API-RPC.md)

## 每份文档的固定结构

```text
职责      一句话，说清「为什么需要它」
导出      函数表：签名 / 参数 / 返回
数据流    输入 → 输出 的字段对照
不变量    破坏了会出什么错
已知坑    踩过的具体报错和触发条件
测试      对应的 test/*.test.mjs
```

改代码前先读「不变量」和「已知坑」两节，那两条比导出表更值钱。

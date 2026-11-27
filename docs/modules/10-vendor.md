# 10 · 第三方（`vendor/qrcode.mjs`）

## 职责

生成扫码登录用的二维码矩阵，默认导出 `qrcode(text)`。

## 为什么是 vendored

- 渲染进程不能随便 `npm install`，宿主的模组加载器不跑打包器
- 依赖树越小越好审：这是唯一一个第三方运行时依赖
- 换成在线二维码服务等于把登录 URL 发给第三方，不可接受

## 使用方式

```js
import qrcode from './vendor/qrcode.mjs';
const matrix = qrcode(url);   // 二维数组，true/false
// 由 settingsPanel 画成 <canvas> 或一组 <rect>
```

## 规则

- **不要改这个文件。** 需要换实现就整个替换，并在这里记一笔来源与许可。
- 不要在这里加网络请求、日志或 DOM 操作。它是纯计算。
- 测试 `test/qr.test.mjs` 只验「同一输入稳定输出 + 尺寸正确」，
  不验具体矩阵值（换实现就会变）。

## 已知坑

- 输入必须是完整 URL（`https://...`），传空串会抛错，调用方要先判空。
- 二维码模块尺寸固定，面板缩放靠 CSS，不要改矩阵分辨率。

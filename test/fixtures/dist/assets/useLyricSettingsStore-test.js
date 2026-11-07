// 假的宿主歌词源表，形状照抄真宿主的 useLyricSettingsStore。
//
// 真宿主导出的只有 S（这里叫 y）和 C（这里叫 b）；那张 id→元数据 的 Map 是**模块私有**的，
// 没导出（导出的 `w` 其实是版权词表数组）。这一点很关键——踩过一次：
// 早先 fixture 里把 `w` 写成真 Map，测试全绿，真机上却把数组当 Map 写，直接 TypeError。
//
// 所以这里严格照真宿主来：私有的 map 不导出，只通过 `tone`/`lookup` 暴露它的行为，
// 供测试观察「模组有没有让宿主那张私有表认出新 id」。

export const y = [
    { id: 'netease', labelKey: 'lyricProvider.netease', platform: true },
    { id: 'amll', labelKey: 'lyricProvider.amll', platform: false },
    { id: 'qq', labelKey: 'lyricProvider.qq', platform: true },
    { id: 'kugou', labelKey: 'lyricProvider.kugou', platform: true },
    { id: 'qishui', labelKey: 'lyricProvider.qishui', platform: true },
    { id: 'spotify', labelKey: 'lyricProvider.spotify', platform: true },
];

/** S.map(e=>e.id) 的快照，宿主拿它拼优先级列表。 */
export const b = y.map((item) => item.id);

/** 真宿主里 `w` 这个导出名是版权词表，是个数组，不是 Map。 */
export const w = [
    { id: 'copyright', words: ['版权所有', 'all rights reserved'] },
    { id: 'lyricSource', words: ['歌词来源', 'lrc by'] },
];

/** 模块私有的 id→元数据表。真宿主里它就是这个角色，且不导出。 */
const meta = new Map(y.map((item) => [item.id, item]));

/** 取词实现表。真宿主里每个源一条，`get` 没有兜底，拿不到就会炸。 */
const impl = new Map(y.map((item) => [item.id, { kind: item.id }]));

/** 宿主的 `E`：`E = id => meta.get(id)`。 */
export const lookup = (id) => meta.get(id);

/** 宿主的 `T`：`T = id => meta.has(id)`，页签文字走它决定用哪个 labelKey。 */
export const knows = (id) => meta.has(id);

/** 宿主的 `Xk`：`Xk = id => impl.get(id)`，取词前必查。 */
export const implOf = (id) => impl.get(id);

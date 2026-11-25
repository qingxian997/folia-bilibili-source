// 假的 Folium 2 歌词源注册表，形状照抄 0.8.0 的 loginDiagnosticReport-*.js。
// 模组只走 h(声明) / g(实现) / _(撤销)；lookup/knows/implOf 暴露内部表给测试观察。

const sources = [
    { id: 'netease', labelKey: 'lyricProvider.netease', platform: true },
    { id: 'amll', labelKey: 'lyricProvider.amll', platform: false },
    { id: 'qq', labelKey: 'lyricProvider.qq', platform: true },
    { id: 'kugou', labelKey: 'lyricProvider.kugou', platform: true },
    { id: 'qishui', labelKey: 'lyricProvider.qishui', platform: true },
    { id: 'spotify', labelKey: 'lyricProvider.spotify', platform: true },
];
const meta = new Map(sources.map((item) => [item.id, item]));
const impl = new Map(sources.map((item) => [item.id, { kind: item.id }]));

/** 宿主画页签用的声明数组。 */
export const c = sources;

/** 注册声明，返回撤销函数。 */
export function h(definition) {
    const item = Object.freeze({ ...definition });
    sources.push(item);
    meta.set(item.id, item);
    return () => {
        const at = sources.indexOf(item);
        if (at >= 0) sources.splice(at, 1);
        if (meta.get(item.id) === item) meta.delete(item.id);
    };
}

/** 注册取词实现。 */
export function g(id, value) {
    impl.set(id, value);
}

/** 撤销取词实现（只在还是同一份时撤，避免误删别人后装的实现）。 */
export function _(id, value) {
    if (impl.get(id) === value) impl.delete(id);
}

/** 测试探针：宿主 E(id)。 */
export const lookup = (id) => meta.get(id);

/** 测试探针：宿主 T(id)。 */
export const knows = (id) => meta.has(id);

/** 测试探针：宿主取词实现表。 */
export const implOf = (id) => impl.get(id);

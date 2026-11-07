// lib/exclude.mjs
// 「排除列表」：收藏夹和合集各有独立的一份设置值，但存的都是「真实资源键」，
// 跟去重用的键是同一套，所以自建 / 手贴 / 账号收藏三个来源指向同一个夹子时，
// 勾一次就全挡住，换号或改链接也不会漏。
//
// 纯函数，不联网、不碰 DOM，测试在 test/exclude.test.mjs。
import { resourceOf } from './collected.mjs';

/**
 * 把设置值读成 Set。
 * 面板写的是「一行一个键」的纯文本；同时兼容 JSON 数组（便于手改 / 迁移）。
 * 传进来的已经是 Set 或数组时原样收下。
 */
export function parseExcluded(value) {
    const out = new Set();
    const add = (item) => {
        const key = String(item == null ? '' : item).trim();
        if (key) out.add(key);
    };
    if (value instanceof Set) {
        value.forEach(add);
        return out;
    }
    if (Array.isArray(value)) {
        value.forEach(add);
        return out;
    }
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return out;
    if (text.startsWith('[')) {
        try {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed)) {
                parsed.forEach(add);
                return out;
            }
        } catch {
            /* 不是合法 JSON 就当纯文本读 */
        }
    }
    text.split(/[\n,;]+/).forEach(add);
    return out;
}

/** Set → 写回设置的文本。排序保证同样的勾选永远得到同一个字符串，不触发无谓的重读。 */
export function serializeExcluded(set) {
    return [...parseExcluded(set)].sort().join('\n');
}

/**
 * 0.7.8：按页签取对应那份排除设置。
 * 收藏夹（playlist）→ excludedFolders，合集（album）→ excludedAlbums。
 * 两份互不影响；全站反查出来的合集不是本地列表，不进任何一份。
 */
export function excludedForKind(values, kind) {
    const key = kind === 'album' ? 'excludedAlbums' : 'excludedFolders';
    return parseExcluded(values && values[key]);
}

/** 0.8.4：两种选择方式。hide = 勾掉的隐藏（老行为）；allow = 只显示勾选的。 */
export const PICKER_MODES = ['hide', 'allow'];

/**
 * 0.8.6：收藏夹和合集各记各的筛选方式。
 *
 * `pickerMode` 仍是收藏夹那份（老配置直接沿用，零迁移）；
 * `albumPickerMode` 是合集自己的。合集没单独选过时（空值）跟着收藏夹走 ——
 * 这样从老版本升上来不会突然多出一整类或整类消失。
 */
export function pickerModeOf(values, kind) {
    const album = kind === 'album';
    const own = values && values[album ? 'albumPickerMode' : 'pickerMode'];
    const raw = own || (values && values.pickerMode);
    return raw === 'allow' ? 'allow' : 'hide';
}

/**
 * 0.8.4：一次拿到某一类列表的「可见性规则」。
 *
 * 黑名单和白名单各存一份设置值，切换模式不会丢另一份 —— 用户来回切两次，
 * 原来的勾选还在。白名单为空时回落成「全部显示」：刚切过去不该整面墙空掉。
 *
 * @returns {{mode: 'hide'|'allow', hide: Set<string>, allow: Set<string>}}
 */
export function visibilityForKind(values, kind) {
    const album = kind === 'album';
    return {
        mode: pickerModeOf(values, kind),
        hide: parseExcluded(values && values[album ? 'excludedAlbums' : 'excludedFolders']),
        allow: parseExcluded(values && values[album ? 'visibleAlbums' : 'visibleFolders']),
    };
}

/** 一条统一列表项按这套规则该不该出现。 */
export function isVisible(raw, view) {
    if (!raw) return false;
    if (!view || !view.mode) return true;
    const key = resourceOf(raw);
    if (!key) return view.mode !== 'allow' || !view.allow.size;
    if (view.mode === 'allow' && view.allow.size) return view.allow.has(key);
    return !view.hide.has(key);
}

/** 一条统一列表项是不是被排除了。 */
export function isExcluded(raw, excluded) {
    if (!raw) return false;
    const key = resourceOf(raw);
    if (!key) return false;
    const set = excluded instanceof Set ? excluded : parseExcluded(excluded);
    return set.has(key);
}

/**
 * 过滤一页列表。
 *
 * 第二个参数既可以是老的「排除集合」（Set / 文本 / 数组），
 * 也可以是 0.8.4 的 `visibilityForKind()` 结果（带 mode / hide / allow）。
 * 没有任何要挡的时候返回原数组本身，省一次复制。
 */
export function excludeCollections(list, filter) {
    const source = Array.isArray(list) ? list : [];
    if (filter && typeof filter === 'object' && !(filter instanceof Set) && filter.mode) {
        if (filter.mode === 'allow') {
            // 白名单空着 = 还没选过，回落成全部显示（否则刚切过去墙就空了）。
            if (!filter.allow.size) return source;
            return source.filter((raw) => filter.allow.has(resourceOf(raw)));
        }
        const hide = filter.hide instanceof Set ? filter.hide : parseExcluded(filter.hide);
        if (!hide.size) return source;
        return source.filter((raw) => !hide.has(resourceOf(raw)));
    }
    const set = filter instanceof Set ? filter : parseExcluded(filter);
    if (!set.size) return source;
    return source.filter((raw) => !isExcluded(raw, set));
}

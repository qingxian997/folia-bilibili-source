// lib/homeTab.mjs
// 0.8.1：只在 bilibili 是当前音源时，把宿主书库首页的「推荐」胶囊整个藏起来；切走立刻还原。
//
// 「推荐」是宿主顶栏的全局页签（home.radioTab），所有音源共用，模组没有「按音源隐藏页签」的
// API：关 capabilities.recommendations 只会让它变灰，写 localStorage.show_home_tab_radio
// 又会把别的平台一起藏掉。所以这里只在 DOM 层动那一颗胶囊，不动宿主状态、不改字典。
//
// 宿主两套首页的页签长得不一样：
//   Bravais 书库缝  <button data-bravais-tab="radio" role="tab">推荐</button>
//   Grid 首页       <span title="推荐"><button aria-label="推荐"><span>推荐</span></button></span>
// 先按 data 属性精确命中；再退回「按钮正文等于推荐/Radio，且同一排里还有别的首页页签」。
// 设置页的「显示推荐」开关、卡片角标、搜索页的音源 tab 都不在这排里，不会误伤。
//
// 注意：0.8.1 起本模组不再声明 capabilities.recommendations，宿主会给这颗按钮挂上
// disabledReason（aria-label / title 变成「该音源不支持推荐」）。所以判定必须看**正文**，
// 不能只看 aria-label —— 正文始终是 i18n 的 home.radioTab。
//
// 纯 DOM，测试在 test/homeTab.test.mjs（jsdom）。

export const RADIO_TAB_KEY = 'radio';
export const PLAYLIST_TAB_KEY = 'playlist';
/** home.radioTab 在多语言里的实际文案（中文 / 繁中 / 其它语言回落 Radio）。 */
export const RADIO_LABELS = ['推荐', '推薦', 'Radio'];
/** 同一排里至少要有两个别的首页页签，才认定这颗按钮是「首页胶囊」而不是普通按钮。 */
export const HOME_TAB_LABELS = [
    '歌单', '收藏', 'Playlists', 'Favorites',
    '专辑', '合集', 'Albums', 'Collections',
    '探索', 'Explore',
    '本地', '本地音乐', '本地音樂', 'Local', 'Local Music',
    'Navidrome', '云盘', '雲盤',
    ...RADIO_LABELS,
];
export const PLAYLIST_TAB_LABELS = ['歌单', '收藏', 'Playlists', 'Favorites'];
/** 宿主把当前首页页签写在这个 key 里（remoteActions 的 Lr / setHomeViewTab）。 */
export const HOME_TAB_STORAGE_KEY = 'last_home_view_tab';

const MARK = '__biliHomeTabHidden';

function textOf(el) {
    return String((el && el.textContent) || '').trim();
}

function attrOf(el) {
    if (!el || typeof el.getAttribute !== 'function') return '';
    return String(el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
}

function labelOf(el) {
    return textOf(el) || attrOf(el);
}

function stripOf(el) {
    if (!el || typeof el.closest !== 'function') return null;
    try {
        return el.closest('[role="tablist"], nav, div');
    } catch {
        return null;
    }
}

function stripButtons(strip) {
    if (!strip || typeof strip.querySelectorAll !== 'function') return [];
    return [...strip.querySelectorAll('button')];
}

function isHomeStrip(el, labels) {
    const strip = stripOf(el);
    if (!strip) return false;
    const known = new Set(labels || HOME_TAB_LABELS);
    let others = 0;
    for (const button of stripButtons(strip)) {
        if (button === el) continue;
        if (known.has(labelOf(button))) others += 1;
    }
    return others >= 2;
}

/** 找出这一刻该藏的页签元素；导出给测试直接验证判定，不依赖定时器。 */
export function radioTabNodes(doc, options) {
    const opts = options || {};
    const radio = new Set(opts.radioLabels || RADIO_LABELS);
    const labels = opts.homeLabels || HOME_TAB_LABELS;
    if (!doc || typeof doc.querySelectorAll !== 'function') return [];
    const out = [];
    const seen = new Set();
    const push = (el) => {
        if (!el || seen.has(el)) return;
        seen.add(el);
        out.push(el);
    };
    // 1) Bravais：宿主自己把 tab key 写在 data 属性上，最精确。
    for (const el of doc.querySelectorAll(`button[data-bravais-tab="${RADIO_TAB_KEY}"]`)) push(el);
    // 2) Grid 首页等没有 data 属性的版本：按正文 + 同排兄弟判定。
    for (const el of doc.querySelectorAll('button')) {
        if (seen.has(el)) continue;
        const label = labelOf(el);
        if (!radio.has(label)) continue;
        if (!isHomeStrip(el, labels)) continue;
        push(el);
    }
    return out;
}

/** 藏掉之后如果当前页签正好是「推荐」，挑一颗还点得动的「歌单 / 收藏」替上。 */
export function fallbackTab(doc, el, options) {
    const opts = options || {};
    const wanted = new Set(opts.playlistLabels || PLAYLIST_TAB_LABELS);
    if (!doc || typeof doc.querySelector !== 'function') return null;
    const direct = doc.querySelector(`button[data-bravais-tab="${PLAYLIST_TAB_KEY}"]`);
    if (direct && direct !== el && !direct.disabled) return direct;
    const buttons = stripButtons(stripOf(el)).filter((button) => button !== el && !button.disabled);
    return buttons.find((button) => wanted.has(labelOf(button))) || buttons[0] || null;
}

/**
 * @param {object} options
 * @param {Document} options.document
 * @param {() => boolean} options.isActive 当前音源是不是 bilibili
 * @param {() => string} [options.currentTab] 宿主当前首页页签（默认读 localStorage）
 * @param {(el: Element) => void} [options.onHidden] 命中后回调（用来把当前页签切走）
 * @param {number} [options.intervalMs]
 */
export function createHomeTabHider(options) {
    const opts = options || {};
    const doc = opts.document || (typeof document !== 'undefined' ? document : null);
    const isActive = typeof opts.isActive === 'function' ? opts.isActive : () => false;
    const win = doc && doc.defaultView;
    const currentTab = typeof opts.currentTab === 'function'
        ? opts.currentTab
        : () => {
            try {
                return String((win && win.localStorage && win.localStorage.getItem(HOME_TAB_STORAGE_KEY)) || '');
            } catch {
                return '';
            }
        };
    const onHidden = typeof opts.onHidden === 'function' ? opts.onHidden : () => {};
    const gap = Math.max(120, Number(opts.intervalMs) || 400);

    let observer = null;
    let interval = 0;
    let debounce = 0;
    let running = false;
    let hidden = [];

    function restoreOne(hit) {
        try {
            hit.el.style.display = hit.display;
            delete hit.el[MARK];
        } catch {
            /* 节点已脱离文档 */
        }
    }

    function restore() {
        for (const hit of hidden) restoreOne(hit);
        hidden = [];
    }

    function hideOne(el) {
        // 判「打没打过标记」而不是「标记的值是不是真」：最常见的原值是空串，
        // 用值判断会让同一颗胶囊每个 tick 都被重新记一遍，hidden 数组越滚越大。
        if (MARK in el) return;
        const inline = String((el.style && el.style.display) || '');
        // 宿主重绘可能把上一轮的 inline display:none 带到新节点上，而自定义标记丢了。
        // 这时 'none' 不是「原值」：照原样记下来，还原时又设回 none，页签就永远回不来。
        const original = inline === 'none' ? '' : inline;
        try {
            el.style.display = 'none';
            el[MARK] = original;
        } catch {
            return;
        }
        hidden.push({ el, display: original });
        // 当前正停在「推荐」上：顺手切到「收藏」，别把用户留在没有页签的空白页。
        if (currentTab() === RADIO_TAB_KEY) {
            const next = fallbackTab(doc, el);
            if (next && typeof next.click === 'function') {
                try {
                    next.click();
                } catch {
                    /* 宿主刚好在重绘，下一轮再试 */
                }
            }
        }
        try {
            onHidden(el);
        } catch {
            /* 回调是可选钩子，别让它影响隐藏 */
        }
    }

    function tick() {
        // 宿主重绘会换掉节点：先扔掉已经不在文档里的记录。
        hidden = hidden.filter((hit) => {
            if (hit.el.isConnected !== false) return true;
            restoreOne(hit);
            return false;
        });
        let active = false;
        try {
            active = Boolean(isActive());
        } catch {
            active = false;
        }
        if (!active) {
            if (hidden.length) restore();
            // 真机 0.8.1：切音源时宿主会重绘那排胶囊，新节点带着 inline
            // display:none 却没有我们打的标记（cloneNode / React 复用 style）。
            // 只还原 hidden 里的旧记录会漏掉它，结果「切到网易云，推荐页签还是不见」。
            // 非 bilibili 时一律把当前这颗胶囊扫干净；radioTabNodes 精确限定，
            // 不会碰到设置页开关、卡片按钮或搜索页音源 tab。
            for (const el of radioTabNodes(doc)) {
                if (MARK in el) continue;
                if (el.style && el.style.display === 'none') el.style.display = '';
            }
            return;
        }
        const wanted = new Set(radioTabNodes(doc));
        for (let i = hidden.length - 1; i >= 0; i -= 1) {
            const hit = hidden[i];
            if (wanted.has(hit.el)) continue;
            restoreOne(hit);
            hidden.splice(i, 1);
        }
        for (const el of wanted) hideOne(el);
    }

    function schedule() {
        if (debounce) return;
        debounce = setTimeout(() => {
            debounce = 0;
            if (running) tick();
        }, 120);
        if (debounce && typeof debounce.unref === 'function') debounce.unref();
    }

    function start() {
        if (running) return;
        running = true;
        const Watcher =
            (win && win.MutationObserver) ||
            (typeof MutationObserver === 'function' ? MutationObserver : null);
        if (Watcher && doc && doc.body) {
            try {
                observer = new Watcher(schedule);
                // 0.8.4：**不再监听 attributes**。宿主那面墙是 transform 虚拟墙，
                // 滚动时每帧都在改 style，attributes:true 等于让这里每 120ms 全量扫一遍
                // 文档里的 button。切音源触发的是 childList（胶囊被替换），够用了。
                observer.observe(doc.body, { childList: true, subtree: true, characterData: true });
            } catch {
                observer = null;
            }
        }
        interval = setInterval(() => {
            if (running) tick();
        }, gap);
        if (interval && typeof interval.unref === 'function') interval.unref();
        tick();
    }

    function stop() {
        running = false;
        if (observer) {
            try {
                observer.disconnect();
            } catch {
                /* 已经断了 */
            }
        }
        observer = null;
        if (interval) clearInterval(interval);
        interval = 0;
        if (debounce) clearTimeout(debounce);
        debounce = 0;
        restore();
    }

    return { start, stop, tick, get hiddenCount() { return hidden.length; } };
}

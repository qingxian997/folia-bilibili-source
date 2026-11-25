// lib/hostAdaptation.mjs
// 宿主 DOM 适配的唯一入口：收集可遍历的 root、判断当前音源是不是 bilibili。
// tabLabel / homeTab 都从这里取信号，避免各自维护一套 shadow root 遍历和音源判定。

const MAX_DEPTH = 8;
const SOURCE_BUTTON_SELECTORS = [
    '.bravais-account-entry',
    'button[aria-label*="平台"]',
    'button[aria-label*="platform" i]',
    'nav.search-sources button[aria-current="true"]',
    'nav.search-sources button.is-active',
];
const OTHER_SOURCE = /网易云|QQ音乐|酷狗|波点|汽水|netease|kugou|qishui|bodian/i;

/** 主文档 + 所有 open shadow root，够宿主 0.8.x 的页签和搜索页使用了。 */
export function collectHostRoots(doc, maxDepth = MAX_DEPTH) {
    const out = [];
    const visit = (root, depth) => {
        if (!root || depth > maxDepth) return;
        out.push(root);
        if (!root.querySelectorAll) return;
        for (const el of root.querySelectorAll('*')) {
            if (el.shadowRoot) visit(el.shadowRoot, depth + 1);
        }
    };
    visit(doc, 0);
    return out;
}

/**
 * 当前音源信号。新装 profile 的 localStorage 可能是空的，所以先看页面上「当前音源」
 * 自己的按钮 / 搜索页 aria-current；读不到才回退 localStorage。完全读不到就返回 false，
 * 宁可不改名，也不要把别的平台的文案改掉。
 */
export function activeSourceHint(doc, roots, providerLabel = 'bilibili') {
    const list = Array.isArray(roots) ? roots : collectHostRoots(doc);
    const name = String(providerLabel || 'bilibili');
    const pattern = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    for (const root of list) {
        if (!root.querySelectorAll) continue;
        for (const button of root.querySelectorAll(SOURCE_BUTTON_SELECTORS.join(','))) {
            const text = [
                button.getAttribute('aria-label') || '',
                button.getAttribute('title') || '',
                button.textContent || '',
            ].join(' ');
            if (pattern.test(text)) return true;
            if (OTHER_SOURCE.test(text)) return false;
        }
    }
    return null;
}

export function createHostAdaptation(options) {
    const opts = options || {};
    const doc = opts.document || (typeof document !== 'undefined' ? document : null);
    const providerId = String(opts.providerId || '');
    const providerLabel = String(opts.providerLabel || 'bilibili');
    const storageKey = String(opts.storageKey || 'active_online_provider_id');
    let lastRoots = [];

    function roots() {
        lastRoots = collectHostRoots(doc);
        return lastRoots;
    }

    function isBiliActive() {
        const hint = activeSourceHint(doc, roots(), providerLabel);
        if (hint !== null) return hint;
        try {
            const store = doc && doc.defaultView ? doc.defaultView.localStorage : (typeof localStorage !== 'undefined' ? localStorage : null);
            const stored = String((store && store.getItem(storageKey)) || '');
            return Boolean(stored) && stored === providerId;
        } catch {
            return false;
        }
    }

    return {
        document: doc,
        roots,
        isBiliActive,
        diagnostics() {
            return { roots: lastRoots.length, active: isBiliActive() };
        },
    };
}

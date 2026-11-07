// lib/searchTabs.mjs
// 0.7.26 新搜索页有自己的音源切换器，和书库墙的「当前音源」是两套状态。
//
// 宿主搜索页 DOM（bootstrap-*.js 里的 uTe）：
//   <nav class="search-sources">
//     <button class="search-source is-active" aria-current="true">bilibili</button> ...
//   </nav>
//   <div class="search-kinds" role="tablist">
//     <button class="search-kind" role="tab">
//       <span class="search-kind-number">01</span>
//       <span class="search-kind-label">专辑</span>   ← i18n 全局共用词
//     </button> ...
//   </div>
//
// 书库墙当前音源写在 localStorage.active_online_provider_id；搜索页切音源只改
// 自己的 store，不动这个键。以前拿书库墙的音源去改全页面文本，就会出现
// 「书库墙停在 bilibili、搜索页切到网易云，网易云的分类却叫合集 / 收藏」。
//
// 所以这里按节点所在语境分开判定：
//   * .search-kinds 里的分类标题 → 看 nav.search-sources 当前选中的是不是 bilibili
//   * 搜索页其它位置 → 一律不改（宁可少改，也不能串）
//   * 其余（书库墙）→ 沿用 active_online_provider_id
//
// 纯函数，测试在 test/searchTabs.test.mjs。

/** 当前搜索音源的显示名；读不到就返回空串，让调用方选择「不改」。 */
export function activeSearchSourceLabel(doc) {
    if (!doc || typeof doc.querySelector !== 'function') return '';
    const active =
        doc.querySelector('nav.search-sources button.search-source[aria-current="true"]') ||
        doc.querySelector('nav.search-sources button.search-source.is-active');
    if (!active) return '';
    return String(active.textContent || '').trim();
}

/** 'kinds' = 搜索分类大标题；'other' = 搜索页其它位置；'wall' = 书库墙等正常页面。 */
export function searchContextOf(node) {
    const el = node && node.parentElement;
    if (!el || typeof el.closest !== 'function') return 'wall';
    try {
        if (el.closest('.search-kinds')) return 'kinds';
        if (el.closest('[class*="search-"]')) return 'other';
    } catch {
        return 'wall';
    }
    return 'wall';
}

/**
 * 给 createTabRelabel 用的逐节点判定。
 *
 * @param {object} options
 * @param {Document} options.document
 * @param {string} options.providerLabel  宿主 getProviderLabel 的返回值（这里是 shortName）
 * @param {string} options.providerId     音源 id，label 偶尔会退化成 id
 * @param {() => boolean} options.isWallActive 书库墙当前是不是 bilibili
 * @returns {(node: Node) => boolean}
 */
export function createBiliTabPredicate({ document: doc, providerLabel, providerId, isWallActive }) {
    const label = String(providerLabel || '');
    const id = String(providerId || '');
    return (node) => {
        const context = searchContextOf(node);
        if (context === 'other') return false;
        if (context === 'kinds') {
            const current = activeSearchSourceLabel(doc);
            return Boolean(current) && (current === label || current === id);
        }
        try {
            return Boolean(isWallActive());
        } catch {
            return false;
        }
    };
}

// lib/tabLabel.mjs
// 只在「当前语境确实是 bilibili」时，把宿主几个共用胶囊换成 bilibili 的说法。
//
// 宿主页签文字来自全局 i18n（playlists / albums / kindAlbum / kindPlaylist），所有音源共用。
// 直接改字典会把网易云、QQ 音乐、Apple Music 的「专辑 / 歌单」一起改掉，
// 所以这里只改渲染出来的文本节点，并且：
//   * isActive(node) 是**逐节点**判定：0.7.26 的书库墙和新搜索页各有各的当前音源，
//     不能用同一个信号去改全页面（见 lib/searchTabs.mjs）。判定只看 DOM 结构 / 语境，
//     不要读 node.nodeValue —— 节点被改名之后文本已经不是原文了；
//   * 读不到当前音源宁可不改；
//   * 判定变假立刻还原，连 React 复用了同一个文本节点的情况也修得回来；
//   * 只认「文本精确等于标签 + 长在按钮/标签里」的节点，不会误伤卡片角标
//     「专辑 · N 首」或设置里的「显示专辑」。
//
// 0.7.26 起宿主会跨平台预取多个 provider 的库（新搜索页 / 跨平台队列），
// 「最近宿主读过我们的库」不再是当前音源的信号，不要再加回来了。

const DEFAULT_MAP = {
    歌单: '收藏',
    Playlists: 'Favorites',
    专辑: '合集',
    Albums: 'Collections',
};
const CAPSULE = /\b(tab|capsule|pill|chip)\b/i;
const MARK = '__biliTabLabel';

export function createTabRelabel(options) {
    const opts = options || {};
    const map = opts.map || DEFAULT_MAP;
    // 传 () => true/false 的旧调用方同样有效：JS 会忽略多出来的 node 参数。
    const isActive = typeof opts.isActive === 'function' ? opts.isActive : () => false;
    const doc = opts.document || (typeof document !== 'undefined' ? document : null);
    let observer = null;
    let interval = 0;
    let debounce = 0;
    let applied = [];
    let running = false;

    function looksLikeCapsule(el) {
        let cur = el;
        let depth = 0;
        while (cur && depth < 4) {
            const tag = String(cur.tagName || '').toUpperCase();
            const role = cur.getAttribute ? cur.getAttribute('role') : '';
            const rawClass = cur.className;
            const cls = String(rawClass && rawClass.baseVal !== undefined ? rawClass.baseVal : rawClass || '');
            if (tag === 'BUTTON' || role === 'tab' || role === 'tablist' || CAPSULE.test(cls)) return true;
            cur = cur.parentElement;
            depth += 1;
        }
        return false;
    }

    function walkText(visit) {
        if (!doc || !doc.body || typeof doc.createTreeWalker !== 'function') return;
        const walker = doc.createTreeWalker(doc.body, 4);
        let node = walker.nextNode();
        while (node) {
            visit(node);
            node = walker.nextNode();
        }
    }

    function eachLabel(visit) {
        walkText((node) => {
            const original = String(node.nodeValue || '');
            const trimmed = original.trim();
            if (!map[trimmed]) return;
            if (looksLikeCapsule(node.parentElement)) visit(node, trimmed, original);
        });
    }

    function applyOne(node, label, original) {
        const wanted = original.replace(label, map[label]);
        if (node.nodeValue === wanted) return;
        if (!applied.some((hit) => hit.node === node)) {
            applied.push({ node, original });
            try {
                node[MARK] = original;
            } catch {
                /* 文本节点不让挂属性也没关系，还有 applied 这条快速路径 */
            }
        }
        try {
            node.nodeValue = wanted;
        } catch {
            /* 节点被宿主换掉了，下一轮再来 */
        }
    }

    function restoreOne(hit) {
        try {
            if (hit.node.nodeValue !== hit.original) hit.node.nodeValue = hit.original;
        } catch {
            /* 节点已脱离文档 */
        }
        try {
            delete hit.node[MARK];
        } catch {
            /* 同上 */
        }
    }

    /**
     * React 会复用文本节点：宿主以为文字没变就不重绘，于是「合集」粘在别的平台上。
     * 只还原现在**不该**改名的带标记节点，仍该改名的留着。
     */
    function sweepMarks() {
        walkText((node) => {
            const original = node[MARK];
            if (typeof original !== 'string') return;
            if (isActive(node)) return;
            try {
                if (node.nodeValue !== original) node.nodeValue = original;
                delete node[MARK];
            } catch {
                /* 节点已脱离文档 */
            }
        });
    }

    function restore() {
        for (const hit of applied) restoreOne(hit);
        if (applied.length) {
            walkText((node) => {
                const original = node[MARK];
                if (typeof original !== 'string') return;
                try {
                    if (node.nodeValue !== original) node.nodeValue = original;
                    delete node[MARK];
                } catch {
                    /* 节点已脱离文档 */
                }
            });
        }
        applied = [];
    }

    function tick() {
        // 宿主重绘会把节点整个换掉，先扔掉已经不在文档里的记录。
        applied = applied.filter((hit) => hit.node.isConnected !== false);
        let restored = false;
        for (let i = applied.length - 1; i >= 0; i -= 1) {
            const hit = applied[i];
            if (isActive(hit.node)) continue;
            restoreOne(hit);
            applied.splice(i, 1);
            restored = true;
        }
        eachLabel((node, label, original) => {
            if (isActive(node)) applyOne(node, label, original);
        });
        if (restored) sweepMarks();
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
            (doc && doc.defaultView && doc.defaultView.MutationObserver) ||
            (typeof MutationObserver === 'function' ? MutationObserver : null);
        if (Watcher && doc && doc.body) {
            try {
                observer = new Watcher(schedule);
                observer.observe(doc.body, { childList: true, subtree: true, characterData: true });
            } catch {
                observer = null;
            }
        }
        // 0.7.26 切音源是即时的，还原也要跟上；太长会让人看见别的平台顶着「合集」。
        interval = setInterval(() => {
            if (running) tick();
        }, 400);
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

    return { start, stop, tick, get changed() { return applied.length; } };
}

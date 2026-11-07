// lib/exploreContinuation.mjs
// 0.8.2：宿主「探索」页 96 首之后由模组续命的触发判定。纯函数，不碰 DOM、不联网。
//
// 0.8.1 的做法是 600ms 定时轮询，拿「最近 4.5 秒有过任意 wheel/scroll/touchmove/
// keydown」当「用户还在刷」的信号。宿主 loadMore() 追加 section 会重排整面墙，
// 重排派发的 scroll 又把这个时间戳续上 —— 自激闭环：随便动一下就唤醒，之后
// 每 1.8s 整页重绘一次，停不下来（P0）。
//
// 0.8.2 改成纯事件驱动，唯一的「进度」是**用户向下滚动的累计像素**：
//   * 不再定时轮询，不监听 keydown，不设总批数上限；
//   * 累计量不足 MIN_ADVANCE_PX 不补 —— 宿主自派 scroll 的 scrollTop 恒为 0，
//     一点累计量都贡献不了；按键 / 点击贡献 0；
//   * 只累计 deltaY > 0（往下滚），向上滚不算；
//   * 补批后有静默窗口 + in-flight 锁，上一批没结束不补；
//   * 宿主自己还能续读（nu(): t<96 && n<4）时不插手。
//
// 为什么不用「接近底部」：真机实测宿主探索墙是 `lattice-field{overflow:clip}` +
// `lattice-world{transform:matrix(...)}` 的 transform 虚拟墙，**滚轮时根本不派发
// 原生 scroll 事件**，`scrollTop` 恒为 0、写也写不进去。所以用 wheel 的累计
// deltaY 作进度（同时兼容 scrollTop 前进的宿主版本）。wheel 只由真实用户输入
// 产生，宿主重排不会派发它 —— 自激从根上断开。
// 宿主版本变了、找不到 explore store 时，这些判定不会被调用，安静退化成 4 批。

/** 两次补批之间，用户至少要真往下滚这么多 px。防「随便动一下」的硬闸。 */
export const MIN_ADVANCE_PX = 600;
/** 补批后的静默窗口（ms），也给 bilibili 留喘息，避免连续打接口被限流。 */
export const QUIET_MS = 1500;
/** 单个事件最多计入这么多 px，防止一帧巨大 delta 直接满足阈值。 */
export const MAX_STEP_PX = 400;
/** 宿主 nu() 的上限：1 初始 + 4 批 / 96 首。 */
export const HOST_PAGE_LIMIT = 5;
export const HOST_ITEM_LIMIT = 96;

/**
 * 把一次滚轮事件折算成「向下滚动的像素」，向上滚 / 坏值一律记 0。
 * deltaMode: 0 = px, 1 = 行, 2 = 页。
 */
export function wheelDeltaPx(deltaY, deltaMode = 0, viewportHeight = 800) {
    const raw = Number(deltaY);
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    const unit = deltaMode === 1 ? 16
        : deltaMode === 2 ? Math.max(1, Number(viewportHeight) || 800)
            : 1;
    return Math.min(MAX_STEP_PX, raw * unit);
}

/**
 * 这一刻该不该追加一批。
 *
 * @param {object} params
 * @param {boolean} params.active          bilibili 是当前书库墙音源
 * @param {boolean} params.visible         当前真的在探索页且窗口可见
 * @param {boolean} [params.blocked]      有模态 / 输入框 / 设置面板等挡着
 * @param {boolean} [params.inFlight]     上一批 loadMore() 还没结束
 * @param {object}  params.feed           宿主 feed 的精简快照
 * @param {number}  params.now            Date.now()
 * @param {number}  [params.lastAppendAt] 上次补批时间
 * @param {number}  [params.advance]      自上次补批以来累计的向下滚动像素
 * @returns {{ ok: boolean, reason: string }} reason 只给诊断现场看
 */
export function canAppend(params) {
    const {
        active, visible, blocked = false, inFlight = false,
        feed, now, lastAppendAt = 0, advance = 0,
    } = params || {};

    if (inFlight) return { ok: false, reason: 'in-flight' };
    if (!active) return { ok: false, reason: 'not-bili' };
    if (!visible) return { ok: false, reason: 'not-visible' };
    if (blocked) return { ok: false, reason: 'blocked' };

    const f = feed || {};
    if (f.status !== 'ready') return { ok: false, reason: 'feed-not-ready' };
    if (f.loadingMore || f.refreshing || f.moreFailed) return { ok: false, reason: 'feed-busy' };
    if (!f.nextCursor) return { ok: false, reason: 'no-cursor' };

    const total = Number(f.total) || 0;
    const pages = Number(f.pages) || 1;
    if (pages < HOST_PAGE_LIMIT && total < HOST_ITEM_LIMIT) {
        return { ok: false, reason: 'host-can-read' };
    }

    // 硬闸：没有「真的往下滚过一段」就绝不补。宿主自派 scroll（scrollTop 不变）、
    // keydown、点击都贡献 0，因此不会再出现自激式整页刷新。
    if (!(Number(advance) >= MIN_ADVANCE_PX)) return { ok: false, reason: 'no-advance' };
    if (now - lastAppendAt < QUIET_MS) return { ok: false, reason: 'quiet' };
    return { ok: true, reason: 'append' };
}

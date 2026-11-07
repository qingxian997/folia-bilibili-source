// lib/hostlib.mjs
// 拿到宿主自己的音源注册表，把本模组的 provider 补成「有账号、有曲库」的完整音源。
//
// 为什么要有这一步：宿主给模组音源的适配层把能力位写死了
// （auth / userLibrary / playlists 全是 false，见宿主 experimental-*.js 里的 buildProvider），
// 于是「收藏」页签（宿主原文「歌单」）对它永远显示不可用，墙面认定这个源没有账户、一张卡都不画。
// 补齐之后，收藏夹就变成宿主自己的数据：墙、集合页、缝、方向键、无限滚动全是它渲染的。
//
// 宿主没有为这件事提供 API，所以这里靠动态 import 同一份 chunk 拿到那个模块单例：
// 页面里已经加载过的模块，按同一个 URL 再 import 一次拿到的是同一个实例，
// 于是 registry 里的 Map 和宿主用的是同一张。
// 不去改安装包。宿主升级后 chunk 的 hash 会变，所以文件名从入口 chunk 的依赖表里现读，
// 函数按行为探测（拿本模组的 provider id 试一次，返回的对象里有这个 id 才算找到），不写死压缩名。

/** 候选 chunk 的名字里通常带这些词：先试它们，省得把几十个 chunk 全 import 一遍。
 *  0.8.1 加 remoteActions / explore：探索页那张 store 就在 remoteActions-*.js 里。 */
const PREFERRED = /usePlaybackStore|provider|omni|service|account|library|online|remoteActions|explore/i;

const isObject = (value) => Boolean(value) && typeof value === 'object';

/** 看起来是「按 id 去 Map 里取」的一元函数：不碰写操作，调用它是安全的。 */
function looksLikeGetter(fn) {
    if (typeof fn !== 'function' || fn.length !== 1) return false;
    let source = '';
    try {
        source = Function.prototype.toString.call(fn);
    } catch {
        return false;
    }
    if (source.length > 400) return false;
    if (!/\.get\(/.test(source)) return false;
    return !/\.set\(|\.delete\(|\.push\(|\.register\(/.test(source);
}

/** 入口 chunk 里有一张 __vite__mapDeps 依赖表，chunk 的文件名全在里面。 */
async function chunkNames(entrySrc) {
    const text = await (await fetch(entrySrc)).text();
    const names = [...new Set((text.match(/\.\/[A-Za-z0-9_\-.]+\.js/g) || []).map((name) => name.slice(2)))];
    return names;
}

function findOmni(module) {
    for (const value of Object.values(module)) {
        if (!isObject(value)) continue;
        if (typeof value.readAccount === 'function'
            && typeof value.getUserPlaylists === 'function'
            && typeof value.getCollectionTracks === 'function') {
            return value;
        }
    }
    return null;
}

function findProviderAccessors(module) {
    const found = [];
    for (const value of Object.values(module)) {
        if (looksLikeGetter(value)) found.push(value);
    }
    return found;
}

/**
 * 0.8.1：找宿主探索页那张 zustand store（remoteActions-*.js 里的 Sl）。
 * 按行为认：getState() 同时有 show / refresh / loadMore / loadMoreOf。
 * 只调 getState()，不写宿主状态。
 *
 * 为什么需要它：useExploreWall 的 nu() 写死了「一次 read 最多自动续读 4 批 / 96 首」，
 * 模组改不了宿主 chunk，但可以在宿主停手后自己调 loadMore() 接着追加新 section。
 */
export function findExploreStore(module) {
    if (!module || typeof module !== 'object') return null;
    for (const value of Object.values(module)) {
        if (!value || typeof value.getState !== 'function') continue;
        let state = null;
        try {
            state = value.getState();
        } catch {
            continue;
        }
        if (!state || typeof state.loadMore !== 'function' || typeof state.loadMoreOf !== 'function'
            || typeof state.show !== 'function' || typeof state.refresh !== 'function') continue;
        return value;
    }
    return null;
}

/**
 * 打开宿主的音源注册表。
 *
 * @param {{ log?: { warn: (message: string, detail?: unknown) => void } }} [options]
 * @returns {Promise<null | {
 *   provider: (providerId: string) => object | null,
 *   omni: object,
 *   exploreStore: object | null,
 *   refreshAccount: (providerId: string) => Promise<unknown>,
 * }>}
 */
export async function openHostLibrary(options) {
    const log = (options && options.log) || { warn() {} };
    if (typeof document === 'undefined') return null;
    const entry = document.querySelector('script[type="module"]');
    if (!entry || !entry.src) return null;

    let names = [];
    try {
        names = await chunkNames(entry.src);
    } catch (error) {
        log.warn('bili: 读不到宿主入口 chunk', String(error && error.message));
        return null;
    }
    if (!names.length) return null;

    const ordered = [
        ...names.filter((name) => PREFERRED.test(name)),
        ...names.filter((name) => !PREFERRED.test(name)),
    ];

    let omni = null;
    let accessor = null;
    let exploreStore = null;

    let scanned = 0;
    for (const name of ordered) {
        // 找不到 exploreStore 时别把几十个 chunk 全 import 一遍：够用就收手。
        if (omni && accessor && (exploreStore || scanned >= 24)) break;
        scanned += 1;
        let module;
        try {
            // 已经加载过的 chunk 走模块缓存，不会产生请求。
            module = await import(new URL(`./${name}`, entry.src).href);
        } catch {
            continue;
        }
        if (!omni) omni = findOmni(module);
        if (!accessor) accessor = findProviderAccessors(module)[0] || null;
        if (!exploreStore) exploreStore = findExploreStore(module);
    }

    if (!omni || !accessor) {
        log.warn('bili: 没找到宿主的音源注册表，收藏夹墙用不了（搜索和播放不受影响）');
        return null;
    }

    const provider = (providerId) => {
        try {
            const hit = accessor(providerId);
            return isObject(hit) && hit.id === providerId ? hit : null;
        } catch {
            return null;
        }
    };

    return {
        provider,
        omni,
        // 拿不到就退化成「宿主自己续读 4 批」，模组其余功能不受影响。
        exploreStore,
        refreshAccount: async (providerId) => {
            try {
                return await omni.readAccount(providerId, 'start');
            } catch (error) {
                log.warn('bili: 读账户失败', String(error && error.message));
                return null;
            }
        },
    };
}

/**
 * 把曲库、登录、以及「bilibili」这个记号挂到宿主手里的 provider 上。
 *
 * 能力位要一起改：宿主是拿 `capabilities.auth` 当「这个源有没有账号」的
 * （omni.getProviderSummaries 里 `requiresAccount: provider.capabilities.auth`），
 * 而 `userLibrary && playlists` 决定「收藏」页签（宿主原文「歌单」）能不能点。
 *
 * `likes`（心形按钮）和 `mutations`（写入）另外开：宿主 `canLikeSong()` 两个都要，
 * 少一个播放器上的心就是灰的。
 *
 * @param {object} provider 宿主 buildProvider 造出来的那个对象（未冻结，可以直接改）
 * @param {{
 *   auth: object,
 *   library: object,
 *   catalog: object,
 *   mutations?: object,
 *   search?: { searchAlbums?: Function, searchPlaylists?: Function },
 *   recommendations?: { getDailySongs?: Function, getRecommendedCollections?: Function },
 *   explore?: { getFeed: Function, getSectionItems: Function },
 *   playback?: object,
 *   mark?: { letter: string, color: string },
 * }} parts
 */
/**
 * 0.7.26 速记簿「加进歌单」：只有自建收藏夹能写。
 * 宿主给的自建收藏夹 id 是纯数字；账号「我收藏的」和手贴的公开收藏夹
 * 分别是 c-fav-… / x-fav-… 前缀，是别人的夹子，只读。
 */
export function canMutateOwnCollection(collection) {
    if (!collection || collection.type !== 'playlist') return false;
    return /^\d+$/.test(String(collection.id || ''));
}

export function attachLibrary(provider, parts) {
    if (!isObject(provider)) return false;
    if (!isObject(provider.capabilities)) provider.capabilities = {};
    provider.capabilities.auth = true;
    provider.capabilities.userLibrary = true;
    provider.capabilities.playlists = true;
    // 「专辑」页签：宿主判的是 canUseAlbums = userLibrary && !!userAlbums。
    // 模组 provider 的默认 capabilities 里压根没有 userAlbums 这个键（只有 albums:!1），
    // 所以补上这一位，宿主才会点亮胶囊并调 library.getUserAlbums / catalog.getAlbumTracks。
    if (parts.library && typeof parts.library.getUserAlbums === 'function') {
        provider.capabilities.userAlbums = true;
    }
    provider.auth = parts.auth;
    provider.library = parts.library;
    provider.catalog = parts.catalog;
    if (parts.mutations) {
        provider.capabilities.mutations = true;
        provider.capabilities.likes = true;
        // 0.7.26 速记簿「加进歌单」看的是这一位 + mutations.updatePlaylistTracks。
        // 少一位，canAddSongToPlaylist() 就是 false，按钮直接灰掉。
        if (typeof parts.mutations.updatePlaylistTracks === 'function') {
            provider.capabilities.playlistTrackMutations = true;
        }
        provider.mutations = parts.mutations;
        // 宿主 canEditCollectionTracks 的逻辑是「有 playlistTrackMutations 且
        // canEditPlaylistTracks?.() !== false」——不实现这一位就默认 true，于是只读的
        // 合集（type:'album'）在界面上也有增删曲目入口，点下去只能报错。补一位收回来。
        if (typeof provider.mutations.canEditPlaylistTracks !== 'function') {
            provider.mutations.canEditPlaylistTracks = canMutateOwnCollection;
        }
    }
    // 0.7.26 新搜索页的「专辑 / 歌单」两类：getProviderSearchKinds 要同时看到
    // capabilities.search / albums / playlists 和 provider.search 上的这两个函数，
    // 少一样宿主就把 searchKind 强制回落到 song，第二类第三类根本不画出来。
    if (parts.search && isObject(provider.search)) {
        try {
            provider.capabilities.search = true;
            if (typeof parts.search.searchAlbums === 'function') {
                provider.search.searchAlbums = parts.search.searchAlbums;
                provider.capabilities.albums = true;
            }
            if (typeof parts.search.searchPlaylists === 'function') {
                provider.search.searchPlaylists = parts.search.searchPlaylists;
                provider.capabilities.playlists = true;
            }
        } catch {
            // 宿主哪天把 search 冻结了，最多是搜索页少两类，书库墙照常用。
        }
    }
    if (parts.playback && isObject(parts.playback)) {
        // 宿主 Qt() 读 provider.playback.audioQualityLevels，按这个顺序过滤标准档位表。
        // 不声明就回落四档（standard/high/lossless/hires），而 bilibili 的 hires 和无损
        // 是同一个 FLAC 流——用户会以为选了两档，其实听的是同一个。
        if (!isObject(provider.playback)) provider.playback = {};
        try {
            Object.assign(provider.playback, parts.playback);
        } catch {
            // 冻结时最多是多显示一档，不影响播放
        }
    }
    if (parts.recommendations && isObject(parts.recommendations)) {
        // 书库首页「推荐」页签：宿主 homeSources.ts 判 canUseRadio = capabilities.recommendations，
        // 真正取数走 omni.getHomeFeed() → provider.recommendations.getDailySongs()
        // / getRecommendedCollections()。
        // 能力位和方法都得挂上，少一个就是「页签能点但永远空白」。
        provider.recommendations = parts.recommendations;
        provider.capabilities.recommendations = true;
    }
    if (parts.explore && isObject(parts.explore)) {
        // 0.8.0 书库首页「探索」页签：宿主 supportsExplore() 看的是 capabilities.explore，
        // canUseExplore 也看这一位；真正取数走 omni.getExploreFeed() /
        // getExploreSectionItems() → provider.explore.getFeed / getSectionItems。
        // 少了能力位，设置页「显示探索」的勾是灰的、页签根本不画。
        provider.explore = parts.explore;
        provider.capabilities.explore = true;
    }
    if (parts.mark) provider.mark = parts.mark;
    // 宿主哪天把 provider 对象冻结了，上面这些赋值会静默失败：收藏/合集页签变空白，
    // 但用户完全看不出原因。这里回读一次，确认真的挂上去了。
    if (provider.catalog !== parts.catalog || provider.library !== parts.library) return false;
    if (parts.mutations && provider.mutations !== parts.mutations) return false;
    if (parts.recommendations && provider.recommendations !== parts.recommendations) return false;
    if (parts.explore && provider.explore !== parts.explore) return false;
    return true;
}

// mods/bili-fav-wall/client.mjs
// bilibili 收藏夹音源：把收藏夹交给宿主自己画。
//
// 以前的版本是「自绘一层墙」（DOM 注入磁贴），闪烁、胶囊、书脊重叠、方向键失灵全来自那一层。
// 现在改成只供数据：模组把 provider 补成「有账号、有曲库」的完整音源（lib/hostlib.mjs），
// 收藏夹就是宿主自己的歌单——墙、集合页、缝、方向键、翻牌、无限滚动、隐藏书脊，全是它渲染的。
//
// 这个模组不直接联网：所有 bilibili 请求都经 folium.rpc 交给 index.cjs（需要自定义请求头）。

import qrcode from './vendor/qrcode.mjs';

import { parseVideoTitle, normalizeForMatch } from './lib/title.mjs';
import { subtitleToLines, subtitleToLrc, omniLyricsToTracks, fillMissingWords } from './lib/lrc.mjs';
import { openHostLibrary, attachLibrary, canMutateOwnCollection } from './lib/hostlib.mjs';
import {
    FOLDER_PAGE_SIZE,
    videoToSong,
    readTrackRange,
    refineCollection,
    toLoginState,
} from './lib/collections.mjs';
import {
    cleanListName,
    parseExtraList,
    parseExtraRef,
    extraKey,
} from './lib/extras.mjs';
import { buildLibrary, parseCollected, readLibrarySources, resourceOf, toCollection } from './lib/collected.mjs';
import { createSettingsPanel } from './lib/settingsPanel.mjs';
import { createTabRelabel } from './lib/tabLabel.mjs';
import { createHomeTabHider } from './lib/homeTab.mjs';
import { createBiliTabPredicate } from './lib/searchTabs.mjs';
import {
    parseExcluded, serializeExcluded, excludeCollections, visibilityForKind,
} from './lib/exclude.mjs';
import {
    parseRecoKey, recoTrackRaw, isLikedKey, likedCollection,
} from './lib/recommend.mjs';
import {
    parseExploreCursor, exploreSection, feedAnswer, sectionAnswer,
} from './lib/explore.mjs';
import { canAppend, wheelDeltaPx, MAX_STEP_PX, SETTLE_MS } from './lib/exploreContinuation.mjs';
import {
    searchCollectionPage, remoteSeasonRaw, remoteSeasonFromKey, hasLocalNameHit,
} from './lib/searchCollections.mjs';

const SITE_PAGE = 20;
const FOLDER_PAGE = FOLDER_PAGE_SIZE;
const META_TTL = 10 * 60 * 1000;

const HOST_LYRIC_ORDER = ['netease', 'qq', 'kugou'];
/** 宿主用它画音源徽标：bilibili 的粉。 */
const BILI_PINK = '#FB7299';
/** 面板上显示的版本号，和 mod.json 保持一致（打包校验会盯这一条）。 */
const MOD_VERSION = '0.9.1';
/** 批量改收藏夹时每首之间的间隔：fav/resource/deal 连发几十个必吃 -412。 */
const ADD_INTERVAL_MS = 250;

export default function activate(folium) {
    if (folium.env.context !== 'main') return;
    if (!folium.omni || folium.host.folium.minor < 7) {
        throw new Error('bilibili 收藏夹需要 Folium 1.7（Folia 0.7.22 及以上）');
    }

    const rpc = (name, payload) => folium.rpc.call(name, payload || {});
    const log = folium.log;

    /**
     * 停用后还在跑的定时器会把回调打到已经注销的 provider 上（幽灵重画 / 日志报错）。
     * 所有延迟执行统一走 later()，dispose 时一把清干净。
     */
    let disposed = false;
    const timers = new Set();
    function later(fn, ms) {
        if (disposed) return 0;
        const id = setTimeout(() => {
            timers.delete(id);
            if (!disposed) fn();
        }, ms);
        timers.add(id);
        if (id && typeof id.unref === 'function') id.unref();
        return id;
    }

    /**
     * 停用时也要能「放行」的等待。
     *
     * `later()` 在 disposed 之后不回调，dispose() 还会把已排上的定时器清掉——
     * 于是 `await new Promise((resolve) => later(resolve, ms))` 会永远吊着，
     * 调用它的宿主 API（比如「加入歌单」）就一直转圈不返回。
     * 这里额外竞一条「停用即放行」的 Promise，保证无论如何都能往下走。
     */
    let releaseDisposeGate = () => {};
    const disposeGate = new Promise((resolve) => {
        releaseDisposeGate = resolve;
    });
    const settle = (ms) => Promise.race([
        new Promise((resolve) => later(resolve, ms)),
        disposeGate,
    ]);

    /** bvid → { song, at }，供歌词匹配和 getSong 复用。 */
    const meta = new Map();
    const siteCache = new Map();
    const folderCache = new Map();
    /** 二维码 payload → qrcode_key（宿主把 startLogin 的返回值原样交给 createQr / checkLogin）。 */
    const qrKeys = new Map();
    /** 收藏夹封面（第一条视频的封面），宿主画卡片用。 */
    let covers = {};
    let coverFill = null;
    /** 0.7.4：全站合集反查 / 收藏夹内容匹配的短缓存，按关键词隔离。 */
    const seasonSearchCache = new Map();
    const folderMatchCache = new Map();
    const inflightSeason = new Map();
    /** 同一关键词同一页只发一次请求：连点搜索不会再叠出 N 倍 412 风险。 */
    const inflightPages = new Map();
    const WEB_CACHE_TTL = 5 * 60 * 1000;

    // ------------------------------------------------------------ provider

    const handle = folium.experimental['omni.providers'].register({
        id: 'bili',
        displayName: 'bilibili',
        shortName: 'bilibili',
        search: (query, page) => search(query, page),
        getSong: (id) => getSong(id),
        getAudioUrl: (song, quality) => getAudioUrl(song, quality),
        getLyrics: (song) => getLyrics(song),
    });

    let providerId = '';

    /** 宿主把 provider id 命名成什么，以 listProviders 为准（注册表返回的是条目 id）。 */
    function myProviderId() {
        if (providerId) return providerId;
        try {
            const mine = folium.omni.listProviders().find((item) => item.origin === 'mod' && String(item.providerId).includes(folium.modId));
            if (mine) providerId = mine.providerId;
        } catch (error) {
            log.warn('bili: listProviders failed', String(error && error.message));
        }
        if (!providerId) providerId = `folium.${folium.modId}.bili`;
        return providerId;
    }

    /** 宿主界面是中文就说中文：<html lang> 是换语言时唯一稳定的信号。 */
    const zhNow = () => {
        try {
            const lang =
                (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang) ||
                (typeof navigator !== 'undefined' && navigator.language) ||
                '';
            return lang ? /^zh/i.test(lang) : true;
        } catch {
            return true;
        }
    };
    const t = (cn, en) => (zhNow() ? cn : en);
    const toast = (message, type) => folium.ui.toast(message, { type: type || 'info', durationMs: 2600 });
    const reason = (error) => String((error && error.message) || error || t('未知错误', 'Unknown error'));

    function passesFilter(song) {
        const max = Number(config().maxMinutes) || 0;
        if (!max) return true;
        if (!song.durationMs) return true;
        return song.durationMs <= max * 60000;
    }

    /** 标题怎么显示：默认拆成「歌名 / 歌手」，打开开关就是 UP 主原话。 */
    function decorate(raw) {
        const parsed = parseVideoTitle(raw.title, raw.author);
        const showRaw = Boolean(config().rawTitle);
        return {
            title: (showRaw && raw.title ? raw.title : parsed.title) || raw.title || '未知曲目',
            artist: parsed.artist || raw.author || '',
            flags: parsed.flags,
        };
    }

    /**
     * 搜索结果的一条 → 交付给宿主的歌曲对象。
     *
     * 0.9.1 两处坑，都只在搜索这条路上：
     *   1. 以前手搓的简化版少 `name` 和 `sourceRef`，宿主按歌曲 DTO 过滤时整批丢掉，
     *      表现就是「搜索永远未找到相关结果」，而卡片墙上一切正常；
     *   2. 补成完整 DTO 后又撞上 React #31 —— 搜索页那一行把整条 `artists` 当 React child
     *      渲染，元素是 `{id,name}` 对象就抛「Objects are not valid as a React child」。
     *      宿主自己的标准化函数会把字符串补成对象，所以这一层交字符串数组。
     * 完整 DTO 仍然留在 meta 里，`getSong()` 和播放器拿到的都是完整形状。
     */
    function toSong(raw) {
        const made = decorate(raw);
        const full = videoToSong(raw, { providerId: myProviderId(), decorate: () => made });
        if (!full) return null;
        meta.set(full.id, {
            at: Date.now(),
            song: full,
            flags: made.flags,
            rawTitle: raw.title || '',
            author: raw.author || '',
        });
        trimMap(meta, 2000);
        return {
            ...full,
            artists: [made.artist || raw.author || '未知歌手'],
            // 搜索列表行按旧读法读顶层 coverUrl / 字符串 album
            ...(raw.cover ? { coverUrl: raw.cover } : {}),
            album: '',
        };
    }

    // -------------------------------------------------------------- search

    async function search(query, options) {
        const limit = Math.min(50, Math.max(1, Number(options && options.limit) || SITE_PAGE));
        const offset = Math.max(0, Number(options && options.offset) || 0);
        // 超长关键词后端会直接 -400，截到 80 字符比抛原始错误体面
        const text = String(query || '').trim().slice(0, 80);

        const folderQuery = /^@fav\/(\d+)/i.exec(text);
        if (folderQuery) return fromFolder(folderQuery[1], limit, offset);
        if (text.startsWith('@')) return { items: [], hasMore: false, total: 0 };
        if (!text) return { items: [], hasMore: false, total: 0 };
        return fromSite(text, limit, offset);
    }

    /** 搜索结果的按关键词缓存：页面本体 + 已交付过的 offset（跨页去重用）。 */
    function siteEntry(keyword) {
        const key = String(keyword || '').toLowerCase();
        let entry = siteCache.get(key);
        if (!entry) {
            entry = { pages: new Map(), total: 0, delivered: new Map() };
            siteCache.set(key, entry);
            if (siteCache.size > 12) siteCache.delete(siteCache.keys().next().value);
        }
        if (!entry.delivered) entry.delivered = new Map();
        return entry;
    }

    async function pageOfSite(keyword, page) {
        const entry = siteEntry(keyword);
        if (entry.pages.has(page)) return entry.pages.get(page);
        const flight = `${String(keyword || '').toLowerCase()}:${page}`;
        const running = inflightPages.get(flight);
        if (running) return running;
        const task = (async () => {
            try {
                const answer = await rpc('search', { keyword, page });
                const raw = answer.items || [];
                // 原始条目原样缓存：交给 readTrackRange 按原始下标推进，
                // 在这里先过滤会把页码和 offset 的关系弄丢（旧版分页错位就出在这）。
                const value = { items: raw, hasMore: Boolean(answer && answer.hasMore) };
                entry.pages.set(page, value);
                entry.total = Number(answer.total) || entry.total;
                // 一直往下翻的时候这些原始页不会有人再要，留 40 页够翻回去一两屏了
                if (entry.pages.size > 40) entry.pages.delete(entry.pages.keys().next().value);
                return value;
            } finally {
                inflightPages.delete(flight);
            }
        })();
        inflightPages.set(flight, task);
        return task;
    }

    async function fromSite(keyword, limit, offset) {
        const entry = siteEntry(keyword);
        const cached = entry.delivered.get(offset);
        // 宿主重试同一 offset 要幂等：原样返回上次那一份
        if (cached) return cached;

        // bilibili 的视频搜索窗口会漂移：第 2 页末尾几条经常就是第 3 页开头那几条。
        // 把「别的 offset 已经交付过的 id」挡在 keep 里，readTrackRange 会自动继续往后翻补足这一页，
        // 既不会让宿主看到重复行，也不会因为去重而把一页喂短。
        const prior = new Set();
        for (const [key, answer] of entry.delivered) {
            if (key === offset) continue;
            for (const song of (answer && answer.items) || []) prior.add(song.id);
        }

        const range = await readTrackRange({
            offset,
            limit,
            pageSize: SITE_PAGE,
            fetchPage: (page) => pageOfSite(keyword, page),
            // 「过滤长视频」只在交付层生效，不参与页码换算，否则一页筛掉几条就被判到底
            keep: (raw) => raw.playable !== false && Boolean(raw && raw.bvid)
                && passesFilter(raw) && !prior.has(String(raw.bvid)),
        });
        const items = range.items.map(toSong).filter(Boolean);
        const total = Number(range.total) || 0;
        // 一条都交付不出来时明确说「没有更多」：宿主适配层用交付条数算下一个 offset，
        // 0 条就是原地不动，再配 hasMore:true 就成了永远停在同一个 offset 上打转。
        const answer = { items, hasMore: items.length > 0 && range.hasMore, ...(total ? { total } : {}) };
        // 空结果不缓存：留着它，同一 offset 再来一次还是空，而且挡掉了「后面几页其实有内容」的可能
        if (items.length > 0) {
            entry.delivered.set(offset, answer);
            if (entry.delivered.size > 20) entry.delivered.delete(entry.delivered.keys().next().value);
        }
        return answer;
    }

    async function pageOfFolder(mediaId, page) {
        let entry = folderCache.get(mediaId);
        if (!entry) {
            entry = { pages: new Map(), total: 0 };
            folderCache.set(mediaId, entry);
        }
        if (entry.pages.has(page)) return entry.pages.get(page);
        const answer = await rpc('folderItems', { mediaId, page });
        // 失效条目带 playable:false 保留在数组里占位，由 readTrackRange 统一过滤
        const value = { items: answer.items || [], total: Number(answer.total) || 0, hasMore: Boolean(answer.hasMore) };
        entry.pages.set(page, value);
        entry.total = value.total || entry.total;
        if (entry.pages.size > 40) entry.pages.delete(entry.pages.keys().next().value);
        trimMap(folderCache, 40);
        return value;
    }

    async function fromFolder(mediaId, limit, offset) {
        const range = await readTrackRange({
            offset,
            limit,
            pageSize: FOLDER_PAGE,
            fetchPage: (page) => pageOfFolder(mediaId, page),
        });
        const items = range.items.map(toSong).filter(Boolean);
        return { items, hasMore: range.hasMore, total: Number(range.total) || 0 };
    }

    async function getSong(id) {
        const cached = meta.get(String(id));
        if (cached && Date.now() - cached.at < META_TTL) return cached.song;
        const raw = await rpc('song', { id });
        if (!raw) return null;
        return toSong(raw);
    }

    // --------------------------------------------------------------- audio

    /** 直连被 CDN 拒过、这次必须走反代的歌。 */
    const forceProxy = new Set();
    /** 播放失败后自动重取的冷却表：同一首 8 秒内只抢救一次，避免失败→重播→再失败死循环。 */
    const failedAt = new Map();

    async function getAudioUrl(song, quality) {
        const route = forceProxy.has(song.id) ? 'proxy' : config().route;
        const answer = await rpc('audio', { id: song.id, quality: quality || 'high', route: route || 'auto' });
        if (!answer || !answer.url) throw new Error('没有拿到播放地址，稍后再试或换个音质');
        if (answer.via === 'direct') forceProxy.delete(song.id);
        return { url: answer.url, ...(answer.expiresAt ? { expiresAt: answer.expiresAt } : {}) };
    }

    /**
     * 反代 URL 的生命周期只到「本次模组激活」：端口随机、token 每次重新生成。
     * 队列里持久化的旧地址在重载/停用再启用之后必然 403 或连接被拒，
     * 宿主不会自己回头问我们，所以只能在这里接住失败信号自愈一次。
     */
    function onPlaybackFailed(payload) {
        const song = payload && payload.song;
        const provider = String((song && song.sourceRef && song.sourceRef.providerId) || '');
        const id = String((song && (song.id || (song.sourceRef && song.sourceRef.mediaId))) || '');
        if (!id || !provider.includes(folium.modId)) return;
        const now = Date.now();
        if (now - (failedAt.get(id) || 0) < 8000) return;
        failedAt.set(id, now);
        if (failedAt.size > 200) failedAt.delete(failedAt.keys().next().value);
        forceProxy.add(id);
        if (forceProxy.size > 500) forceProxy.delete(forceProxy.keys().next().value);
        void (async () => {
            await rpc('clearCache').catch(() => {});
            try {
                await folium.playback.playSong(song);
                log.info('bili: 播放失败后已重取地址重试', id);
            } catch (error) {
                log.warn('bili: 播放失败后重取没成功', reason(error));
            }
        })();
    }

    let offPlaybackFailed = null;
    try {
        if (folium.events && typeof folium.events.on === 'function') {
            offPlaybackFailed = folium.events.on('playback.failed', onPlaybackFailed);
        }
    } catch (error) {
        // 宿主哪天改了这个事件名，最多是少一层自愈，别连带整个模组启动失败
        log.warn('bili: 订阅播放失败事件失败', reason(error));
    }

    // -------------------------------------------------------------- lyrics
    //
    // 一首歌的两种歌词来源各自只取一次：provider 的 getLyrics、播放器里的「歌词来源」面板、
    // 手动切换命令走的是同一份记忆。以前这三处各问一遍，切一次歌能打好几个网络来回。

    const LYRIC_TTL = 10 * 60 * 1000;
    /**
     * 「这个来源没有」只能记 60 秒。
     *
     * 匹配是联网的，抖一下就会回空；要是把空当成结论记 10 分钟，用户看到的就是
     * 「没匹配到」再也不变——比没有缓存更像坏了。
     */
    const LYRIC_MISS_TTL = 60 * 1000;
    /** `songId:cc` / `songId:match` → { at, value }。value 为 null 表示「这个来源没有」。 */
    const lyricCache = new Map();
    const lyricInflight = new Map();

    /** 简单的容量上限：长会话里 map 不能无限长。 */
    function trimMap(map, max) {
        if (map.size <= max) return;
        const drop = map.size - max;
        let index = 0;
        for (const key of map.keys()) {
            map.delete(key);
            if (++index >= drop) break;
        }
    }

    /** 某个来源给这首歌的歌词（带 10 分钟记忆 + 同请求合并）。 */
    function lyricOnce(song, kind, run) {
        const key = `${song.id}:${kind}`;
        const hit = lyricCache.get(key);
        if (hit) {
            const age = Date.now() - hit.at;
            if (age < (hit.value ? LYRIC_TTL : LYRIC_MISS_TTL)) return Promise.resolve(hit.value);
        }
        const running = lyricInflight.get(key);
        if (running) return running;
        const task = (async () => {
            try {
                const value = await run();
                lyricCache.set(key, { at: Date.now(), value });
                trimMap(lyricCache, 240);
                return value;
            } finally {
                lyricInflight.delete(key);
            }
        })();
        lyricInflight.set(key, task);
        return task;
    }

    /** LRC 里有几句。给面板显示「53 行」用，比先解析成 FoliumLine 便宜。 */
    function countLines(text) {
        return String(text || '')
            .split('\n')
            .filter((line) => /\[\d/.test(line)).length;
    }

    /** 这个视频的 CC 字幕：`{ track, lines, lan, lanDoc, count }`，没有就 null。 */
    function ccTrack(song) {
        return lyricOnce(song, 'cc', async () => {
            try {
                const answer = await rpc('subtitles', { id: song.id });
                const body = answer && answer.body;
                const lines = subtitleToLines(body);
                if (!lines.length) return null;
                return {
                    track: { format: 'lrc', text: subtitleToLrc(body) },
                    lines,
                    lan: (answer && answer.lan) || '',
                    lanDoc: (answer && answer.lanDoc) || '',
                    count: lines.length,
                };
            } catch (error) {
                log.warn('bili: CC 字幕读取失败', String(error && error.message));
                return null;
            }
        });
    }

    /** CC 字幕的歌词，宿主取词时用。 */
    async function ccLyrics(song) {
        const found = await ccTrack(song);
        return found ? { main: found.track } : null;
    }

    /**
     * 歌词来源顺序：
     * match-then-cc（默认）第三方歌词匹配 → CC 字幕；
     * cc-then-match 反过来；cc / match 只用一种；off 不要歌词。
     */
    async function getLyrics(song) {
        const mode = config().lyrics || 'match-then-cc';
        if (mode === 'off') return null;
        if (mode === 'match-then-cc') return (await rawMatch(song)) || (await rawCc(song));
        if (mode === 'cc-then-match') return (await rawCc(song)) || (await rawMatch(song));
        if (mode === 'cc') return rawCc(song);
        return rawMatch(song);
    }

    const rawCc = async (song) => {
        const found = await ccTrack(song);
        return found ? { main: found.track } : null;
    };

    const rawMatch = async (song) => {
        const found = await matchTrack(song);
        return found ? { main: found.track } : null;
    };

    function pickBest(candidates, title, artist, durationMs) {
        const wantTitle = normalizeForMatch(title);
        const wantArtist = normalizeForMatch(artist);
        let best = null;
        let bestScore = 0;
        candidates.forEach((song) => {
            const gotTitle = normalizeForMatch(song.title);
            if (!gotTitle || !wantTitle) return;
            let score = 0;
            if (gotTitle === wantTitle) score += 5;
            else if (gotTitle.includes(wantTitle) || wantTitle.includes(gotTitle)) score += 3;
            else if (wantTitle.length >= 2 && gotTitle.length >= 2) {
                const head = wantTitle.slice(0, 2);
                if (gotTitle.startsWith(head) || wantTitle.startsWith(gotTitle.slice(0, 2))) score += 1;
            }
            if (score === 0) return;
            const gotArtist = normalizeForMatch(song.artist);
            if (wantArtist && gotArtist && (gotArtist.includes(wantArtist) || wantArtist.includes(gotArtist))) score += 2;
            if (durationMs && song.durationMs && Math.abs(song.durationMs - durationMs) < 4000) score += 1;
            if (score > bestScore) {
                bestScore = score;
                best = song;
            }
        });
        return bestScore >= 3 ? best : null;
    }

    /**
     * 能用来匹配歌词的宿主音源。
     *
     * `folium.omni.listProviders()` 返回的是宿主包装过的一张表，除 displayName 这些
     * 还有 `origin`（host/mod）和 `supports`（search / lyrics / albums / artists）；
     * 内部那个 `getProviderSummaries()` 才没有这两个字段——别拿它当依据，否则会误判成「永远匹配不到」。
     * 万一哪天包装变了，退一步用「已登录 + 不是模组音源」兜底，至少不让功能整体消失。
     */
    function hostProviders() {
        try {
            const all = folium.omni.listProviders();
            const strict = all.filter((item) => item.origin === 'host' && item.supports && item.supports.search && item.supports.lyrics);
            const hosts = strict.length
                ? strict
                : all.filter((item) => {
                    const id = String((item && item.providerId) || '');
                    return id && !id.startsWith('folium.') && item.status === 'authenticated';
                });
            const rank = (id) => {
                const index = HOST_LYRIC_ORDER.indexOf(id);
                return index < 0 ? HOST_LYRIC_ORDER.length : index;
            };
            return hosts.sort((a, b) => rank(a.providerId) - rank(b.providerId));
        } catch {
            return [];
        }
    }

    /** 启动时把「哪些平台可以用来匹配歌词」记一行：出问题时一眼能看出是没登录还是筛错了。 */
    try {
        const all = folium.omni.listProviders();
        const usable = hostProviders().map((item) => item.providerId);
        if (typeof window !== 'undefined') {
            // 和 __biliLyricSource 一样，留一份现场给控制台排查用
            window.__biliHosts = {
                at: new Date().toISOString(),
                usable,
                fields: all[0] ? Object.keys(all[0]) : [],
                supports: all[0] ? all[0].supports || null : null,
                origins: all.map((item) => `${item.providerId}:${item.origin || '?'}`),
            };
        }
        log.info('bili: 可匹配歌词的平台', usable.length ? usable.join(', ') : '（一个都没有）');
    } catch {
        /* 记日志失败不影响任何功能 */
    }

    /**
     * 跨平台匹配来的歌词：`{ track, title, artist, providerId, count }`，没有就 null。
     *
     * 按 HOST_LYRIC_ORDER 一家一家问，先搜后取词。一家没匹配上就换下一家——最多三家，
     * 所以最坏情况是 6 个请求；结果按歌记住，切歌来回不会再打一遍。
     */
    function matchTrack(song) {
        return lyricOnce(song, 'match', async () => {
            const first = song.artists && song.artists[0];
            // getSong() 交付的是完整 DTO，`artists` 是 [{id,name}]；搜索列表那条是字符串。
            // 直接拿对象去拼搜索词会得到 "[object Object]"，歌手加权也一起失效。
            const artist = typeof first === 'string'
                ? first
                : String((first && (first.name || first.title)) || '');
            const query = [song.title, artist].filter(Boolean).join(' ').trim();
            if (!query) return null;
            const providers = hostProviders();
            if (!providers.length) {
                // 只在真的要匹配时打一条：既方便排查「为什么匹配不到词」，也不会刷屏
                log.info('bili: 没有可用来匹配歌词的平台（都没登录，或宿主没暴露 supports 字段）');
                return null;
            }
            for (const provider of providers.slice(0, 3)) {
                try {
                    const page = await folium.omni.searchSongs(query, { providerId: provider.providerId, limit: 8 });
                    const best = pickBest(page.items, song.title, artist, song.durationMs);
                    if (!best) continue;
                    const lyrics = await folium.omni.getLyrics(best);
                    const tracks = omniLyricsToTracks(lyrics);
                    if (tracks && tracks.main) {
                        return {
                            track: tracks.main,
                            title: best.title || song.title || '',
                            artist: best.artist || artist,
                            providerId: provider.providerId,
                            count: countLines(tracks.main.text),
                        };
                    }
                } catch (error) {
                    log.warn('bili: 跨平台歌词匹配失败', provider.providerId, String(error && error.message));
                }
            }
            return null;
        });
    }

    /** 跨平台匹配的 `{ main }` 形状，宿主取词时用。 */
    async function matchLyrics(song) {
        const found = await matchTrack(song);
        return found ? { main: found.track } : null;
    }

    /** 正在播放的、属于本模组的歌；不是就 null。 */
    function playingBiliSong() {
        try {
            const state = folium.playback.getState();
            const song = state && state.song;
            if (!song || !song.id) return null;
            if (song.source !== myProviderId()) return null;
            return { song, durationMs: Math.round((Number(state.duration) || 0) * 1000) };
        } catch {
            return null;
        }
    }


    // -------------------------------- 把 bilibili 接成宿主歌词源表的最后一项
    //
    // 宿主把歌词源写成常量数组 S，在 useLyricSettingsStore 里导出成 `y`：
    //   S=[{id:'netease',…},…,{id:'spotify',…},{id:'appleMusic',…}]  // 0.7.26 起是 7 项
    // 取词实现另有一张按官方那几个 id 建好的私有 Map（0.7.26 起是 7 个，没有兜底）。
    //
    // const 只锁绑定不锁内容——push 一项进去，宿主自己的页签行就多一个，样式、选中态、
    // 搜索框、结果列表全是它原生的，模组一行界面都不用画。
    //
    // 另一侧只要让那张实现 Map 也认这个 id。两张表都只做 get，所以在 get 上补一条：
    // 条件收得很死（键是 bili、本来没值、而且表里查得到官方那几个 id），别的 Map 一律原样返回。

    const LYRIC_SOURCE_ID = 'bili';
    /** 官方表最少有几项：0.7.25 是 6，0.7.26 加了 appleMusic 是 7。用下界，两版都认。 */
    const LYRIC_TABLE_SIZE = 6;

    let lyricChunk = { url: '' };
    let lyricSource = null; // { meta, table, ids, restore() }
    /**
     * 安装代数。`import()` 是异步的，装到一半可能已经被卸载了，那时候得自己收尾；
     * 而卸载之后**还得能再装回来**（宿主热重载、设置里关掉再打开都会走一遍）。
     * 早先用的是 `retired` 布尔标志，卸载一次就把这个模块实例永久钉死了，
     * 表现是「关掉再打开就再也没有 bilibili 页签」。所以改成比代数：装完发现代数变了就自己拆。
     */
    let lyricGeneration = 0;

    /**
     * 装歌词源是个「失败就安静跳过」的活儿，出问题时界面上一片平静、很难查。
     * 所以每一步都往 window 上记一笔，连上调试端口一眼就能看到断在哪。
     */
    const lyricDiag = { steps: [], ok: false, chunk: '', url: '', error: '' };
    function note(step, detail) {
        try {
            lyricDiag.steps.push({ at: new Date().toISOString(), step, detail: detail || null });
            if (typeof window !== 'undefined') window.__biliLyricSource = lyricDiag;
        } catch {
            /* 诊断本身不该影响主流程 */
        }
    }
    note('模组启动');
    let watchTimer = 0;
    let lastQualityAt = 0;
    let observer = null;
    const qualityCache = new Map();

    const QUALITY_LABELS = {
        '标准': 'standard',
        '极高': 'high',
        '超高': 'ultra',
        '无损': 'lossless',
        'Hi-Res': 'hires',
    };

    const textOf = (node) => (node ? String(node.textContent || '').replace(/\s+/g, ' ').trim() : '');

    /**
     * 宿主那个 chunk 的文件名带构建哈希，发一次版就换一个，写死不行。
     *
     * 主路是读入口 chunk：页面上那个 `type=module` 的 script，浏览器已经把相对路径解析成
     * 绝对 URL 了，而入口 chunk 的依赖清单里就写着 `./useLyricSettingsStore-Cbyi_7vr.js`
     * 这样的原样文件名。asar 里 fetch 得到（实测 33509 字节读全），宿主换协议也不受影响。
     * 主进程那条路留着当兜底：万一哪天入口改成动态 import，依赖清单就不在入口里了。
     */
    async function lyricChunkUrl() {
        // 只在认出来之后才缓存；失败不记，下次重装还能再试一遍。
        if (lyricChunk.url) return lyricChunk.url;
        if (typeof document === 'undefined' || !document.baseURI) {
            note('没有 document.baseURI', { hasDocument: typeof document !== 'undefined' });
            return '';
        }
        lyricDiag.baseURI = document.baseURI;
        let name = '';

        try {
            const script = document.querySelector('script[type="module"][src]');
            const entry = script && script.src;
            if (entry && typeof fetch === 'function') {
                lyricDiag.entry = entry;
                const text = await (await fetch(entry)).text();
                const hit = text.match(/useLyricSettingsStore-[A-Za-z0-9_-]+\.js/);
                if (hit) name = hit[0];
                note('读入口 chunk 认文件名', { entry, name, bytes: text.length });
            } else {
                note('页面上没有可用的入口 script', { hasEntry: !!entry, hasFetch: typeof fetch });
            }
        } catch (error) {
            note('读入口 chunk 失败', String(error && error.message));
        }

        if (!name) {
            try {
                const answer = await rpc('assets', { match: 'useLyricSettingsStore' });
                name = (answer && answer.name) || '';
                note('退到主进程查文件名', answer || null);
            } catch (error) {
                lyricDiag.error = String(error && error.message);
                note('主进程也没查着', String(error && error.message));
                log.warn('bili: 读不到宿主 chunk 列表', String(error && error.message));
            }
        }

        lyricDiag.chunk = name;
        if (!name) {
            note('没拿到 chunk 名，放弃注册');
            return '';
        }
        try {
            lyricChunk.url = new URL(`./assets/${name}`, document.baseURI).href;
            lyricDiag.url = lyricChunk.url;
            note('拼出 chunk 地址', lyricChunk.url);
        } catch (error) {
            lyricChunk.url = '';
            note('拼不出 chunk 地址', String(error && error.message));
        }
        return lyricChunk.url;
    }

    /**
     * omni 交回来的是「统一搜索结果」：{ id, title, artist(字符串), album(字符串), source, ref }。
     * 但「匹配歌词」窗口把每条结果当成宿主歌曲对象用——`Lm` 读 `name`、打分函数 `Es`
     * 读 `name` / `artists[].name` / `album.name` / `durationMs`，`rj` 保存时读同一批字段。
     * 不补这个形状，窗口里就是一排空的「0% · Unknown Album」。收藏夹/队列那条路不受影响。
     */
    function toLyricSong(item) {
        if (!item) return null;
        const id = String(item.id || '');
        const title = String(item.title || item.name || '');
        const artist =
            typeof item.artist === 'string'
                ? item.artist
                : String((item.artist && (item.artist.name || item.artist.title)) || '');
        const album =
            typeof item.album === 'string'
                ? item.album
                : String((item.album && item.album.name) || '');
        // `meta` 是 activate 顶层那张视频缓存，toSong 时存过原始封面；omni 的标准化把它丢了。
        const cached = id ? meta.get(id) : null;
        const cachedSong = cached && cached.song;
        const cover = item.coverUrl || (cachedSong && cachedSong.coverUrl) || undefined;
        return {
            ...item,
            id,
            name: title,
            title,
            artists: artist ? [{ id: `${id}#artist`, name: artist }] : [],
            // 宿主封面提取器读的是 album.coverUrl（结果行的 $A() 和右侧预览同一份来源）。
            // 只给顶层 coverUrl，两处都会渲染成占位音符方块。
            album: { id: 0, name: album, ...(cover ? { coverUrl: cover } : {}) },
            durationMs: Number(item.durationMs) || Number(cachedSong && cachedSong.durationMs) || 0,
            coverUrl: cover,
            // omni 定位 provider 看的是 sourceRef.providerId。补上它，选中之后取词才不会
            // 被当成网易云的歌（否则会报 "Invalid NetEase id: BV1..."）。
            sourceRef: { kind: 'online', providerId: myProviderId(), mediaId: id },
            aliases: [],
            translatedNames: [],
        };
    }

    /** 窗口里搜一下：走 omni，再补成宿主歌曲形状交给窗口渲染。 */
    async function lyricSearch(query, limit) {
        const text = String(query || '').trim();
        if (!text) return [];
        const want = Math.min(50, Math.max(1, Number(limit) || 30));
        const answer = await folium.omni.searchSongs(text, { providerId: myProviderId(), limit: want });
        return ((answer && answer.items) || []).map(toLyricSong).filter(Boolean);
    }

    /**
     * 窗口里选中一条之后取词：这个页签代表「bilibili 视频的 CC 字幕」，所以只取 CC，
     * 不回落第三方歌词匹配。正常播放仍按设置里的歌词模式走，两边互不影响。
     *
     * 不再借道 folium.omni.getLyrics —— 那条路会调本模组的 getLyrics(song)，默认
     * match-then-cc，第三方先命中时窗口里就变成网易云那套带翻译/罗马音的词了。
     * 宿主的 Zk 只校验 lyrics.lines 里有 fullText，直接把 CC 字幕转成行交给它。
     */
    async function lyricFetch(song) {
        if (!song) return null;
        const id = String(song.id || (song.sourceRef && song.sourceRef.mediaId) || '');
        if (!id) return null;
        const found = await ccTrack({ ...song, id });
        if (!found || !found.lines.length) return null;
        return {
            lyrics: {
                lines: found.lines,
                isPureMusic: false,
                isWordByWord: false,
            },
            isPureMusic: false,
        };
    }

    /**
     * 一次性修复 0.7.6 及更早版本留下的歌词缓存。
     *
     * 旧版把 CC 字幕行直接交给宿主，行里只有 startTime / endTime / fullText，
     * 宿主把这份歌词写进了自己的 metadata_cache（key 形如
     * `lyric_online:folium.bili-fav-wall.bili:<bvid>_state`，歌词在 `data.onlineOverrideLyrics.lines`）。
     * 之后每次播到那首歌，宿主歌词模型 `monetLyricsModel` 的 `G(line)` 第一句就是
     * `line.words.length`，键不在就抛 TypeError——而它跑在 React 渲染期间，
     * 异常直接把整棵树卸载掉：**整个窗口变白、点什么都没反应**。
     *
     * 现在 `subtitleToLines` 每行都带 `words: []`，但已经落盘的旧记录不会自己变。
     * 这里给它们补上，幂等，跑过一次就记标记，不再扫库。
     */
    const LYRIC_CACHE_REPAIR_KEY = 'bili:lyric-cache-repair:v1';

    function repairLegacyLyricCache() {
        if (typeof indexedDB === 'undefined') return;
        try {
            if (localStorage.getItem(LYRIC_CACHE_REPAIR_KEY)) return;
        } catch {
            // 拿不到 localStorage 就别动宿主数据，下次启动再试
            return;
        }
        let prefix = '';
        try {
            prefix = `lyric_online:${myProviderId()}:`;
        } catch {
            return;
        }

        let request;
        try {
            request = indexedDB.open('KineticPlayerDB');
        } catch {
            return;
        }

        request.onerror = () => {};
        request.onupgradeneeded = () => {};
        request.onsuccess = () => {
            const db = request.result;
            let settled = false;
            const finish = (fixed) => {
                if (settled) return;
                settled = true;
                try {
                    db.close();
                } catch {
                    /* 已经关了 */
                }
                try {
                    localStorage.setItem(LYRIC_CACHE_REPAIR_KEY, String(fixed));
                } catch {
                    /* 存不了标记就下次再扫一遍，不影响正确性 */
                }
                if (fixed > 0) log.info(`bili: 补齐了 ${fixed} 条旧歌词缓存的 words 字段`);
            };

            if (!db.objectStoreNames.contains('metadata_cache')) return finish(0);

            let fixed = 0;
            let tx;
            try {
                tx = db.transaction('metadata_cache', 'readwrite');
            } catch {
                return finish(0);
            }

            tx.objectStore('metadata_cache').openCursor().onsuccess = (event) => {
                const cursor = event.target.result;
                if (!cursor) return;
                const key = String(cursor.key || '');
                if (key.startsWith(prefix)) {
                    const record = cursor.value;
                    const lyrics = record && record.data && record.data.onlineOverrideLyrics;
                    const lines = lyrics && Array.isArray(lyrics.lines) ? lyrics.lines : null;
                    if (lines && fillMissingWords(lines) > 0) {
                        fixed += 1;
                        cursor.update(record);
                    }
                }
                cursor.continue();
            };
            tx.oncomplete = () => finish(fixed);
            tx.onerror = () => finish(fixed);
            tx.onabort = () => finish(fixed);
        };
    }

    /**
     * 往宿主那张表里加一项，并让实现表也认这个 id。
     * 找不到那个 chunk（宿主改版、或者不是这个运行环境）就安静跳过——只是少一个页签，
     * 播放、搜索、取词照旧全走 provider。
     */
    async function installLyricSource() {
        if (lyricSource) return false;
        const generation = (lyricGeneration += 1);
        const url = await lyricChunkUrl();
        if (!url) return false;

        let mod = null;
        try {
            mod = await import(url);
            note('import 宿主 chunk 成功', { keys: Object.keys(mod || {}).length });
        } catch (error) {
            lyricDiag.error = String(error && error.message);
            note('import 宿主 chunk 失败', String(error && error.message));
            log.warn('bili: 加载宿主歌词源表失败', String(error && error.message));
            return false;
        }

        const table = mod && mod.y; // S：元数据数组，宿主拿它画页签
        const ids = mod && mod.b; // C：S.map(e=>e.id) 的快照
        // 宿主那个 id→元数据 的 Map 是模块私有的，没导出；`w` 这个导出名是版权词表数组，
        // 不是它。所以拿不到就靠下面拦 Map.prototype 的办法顶上。
        const metaMap = mod && mod.w instanceof Map ? mod.w : null;
        if (!Array.isArray(table)) {
            log.warn('bili: 宿主歌词源表结构变了，跳过注册');
            note('宿主歌词源表不是数组，可能是宿主改版了');
            return false;
        }

        const meta = {
            id: LYRIC_SOURCE_ID,
            labelKey: t('bilibili', 'bilibili'),
            platform: true,
            search: (query, limit) => lyricSearch(query, limit),
            fetch: (song) => lyricFetch(song),
            songKey: (song) => String((song && song.id) || ''),
        };

        // 宿主内部有两张按官方那几个 id 建的 Map：`w`（id→元数据）和取词实现表；
        // 页签文字是 `t(E(T(id) ? id : 'netease').labelKey)`，其中 T 是 `w.has`；
        // 取词是 `实现表.get(id)`，没有兜底。两张都拿不到实例，只能拦原型。
        // 条件收死：宿主那两张表都是「按官方音源 id 建」的，所以要求表中确实存在
        // 绝大多数官方 id（而不只是碰巧有 'netease' 这一条）才认，其余 Map 原样返回。
        // 补丁打的是 Map.prototype，跨模组可见，宁可判严也不要误伤别人的表。
        const originalGet = Map.prototype.get;
        const originalHas = Map.prototype.has;
        const officialIds = table
            .map((item) => String((item && item.id) || ''))
            .filter((id) => id && id !== LYRIC_SOURCE_ID);
        const needIds = Math.min(LYRIC_TABLE_SIZE, officialIds.length) || LYRIC_TABLE_SIZE;
        const isHostTable = (map) => {
            if (map.size < needIds || map.size > officialIds.length + 3) return false;
            let hit = 0;
            for (const id of officialIds) {
                if (originalHas.call(map, id)) hit += 1;
                if (hit >= needIds) return true;
            }
            return false;
        };

        const patchedGet = function (key) {
            const own = originalGet.call(this, key);
            if (own !== undefined) return own;
            if (key === LYRIC_SOURCE_ID && isHostTable(this)) return meta;
            return own;
        };
        const patchedHas = function (key) {
            if (key === LYRIC_SOURCE_ID && !originalHas.call(this, key) && isHostTable(this)) return true;
            return originalHas.call(this, key);
        };
        Map.prototype.get = patchedGet;
        Map.prototype.has = patchedHas;

        // 补丁打在 Map.prototype 上，跨模组可见：先卸载的那个不能把别人后装的补丁一起抹掉。
        // 只在「现在挂的还是我这一份」时才换回去。
        const unpatch = () => {
            if (Map.prototype.get === patchedGet) Map.prototype.get = originalGet;
            if (Map.prototype.has === patchedHas) Map.prototype.has = originalHas;
        };

        // 装好的这瞬间可能已经被卸载过、甚至还装过一轮新的（import 是异步的）。
        // 代数对不上就说明我这一份已经过时了：原型换回去，数组一个字都还没写，干净退出。
        if (generation !== lyricGeneration) {
            unpatch();
            note('装好时已经过时了，就地拆掉', { generation, current: lyricGeneration });
            return false;
        }

        if (!table.some((item) => item && item.id === LYRIC_SOURCE_ID)) table.push(meta);
        if (Array.isArray(ids) && !ids.includes(LYRIC_SOURCE_ID)) ids.push(LYRIC_SOURCE_ID);
        if (metaMap && !metaMap.has(LYRIC_SOURCE_ID)) metaMap.set(LYRIC_SOURCE_ID, meta);
        note('已写入宿主歌词源表', {
            table: table.length,
            ids: ids && ids.length,
            exportedMap: !!metaMap,
        });

        lyricSource = {
            meta,
            table,
            ids: Array.isArray(ids) ? ids : null,
            metaMap,
            restore: () => {
                unpatch();
            },
        };
        lyricDiag.ok = true;
        note('注册完成');
        return true;
    }

    /**
     * 反向操作：把页签、id 快照、元数据 Map 里那一项都拿掉，再把原型换回去。
     * 少撤一样，模组停用后页签还杵在那儿，点一下就报错。
     */
    function uninstallLyricSource() {
        // 先把代数推开，作废任何还在路上的安装，再回滚已经落地的这一份。
        lyricGeneration += 1;
        if (!lyricSource) {
            note('没有落地的安装，只作废了在路上的');
            return;
        }
        const { meta, table, ids, metaMap, restore } = lyricSource;
        try {
            restore();
        } catch {
            /* 已经换回去了 */
        }
        try {
            const at = Array.isArray(table) ? table.indexOf(meta) : -1;
            if (at >= 0) table.splice(at, 1);
        } catch {
            /* 宿主把数组换掉了 */
        }
        try {
            const at = Array.isArray(ids) ? ids.indexOf(LYRIC_SOURCE_ID) : -1;
            if (at >= 0) ids.splice(at, 1);
        } catch {
            /* 同上 */
        }
        try {
            if (metaMap) metaMap.delete(LYRIC_SOURCE_ID);
        } catch {
            /* 同上 */
        }
        lyricDiag.ok = false;
        note('已从宿主的表里撤掉');
        lyricSource = null;
    }

    // ------------------------------------------ 音质：把宿主的通名换成 bilibili 的说法
    //
    // 宿主「默认音质」那张表是写死的四个 id，模组改不了选项本身；能改的是它画出来的字。
    // 所以按这个视频实际有哪些音频流，把「标准/极高/无损/Hi-Res」换成 64K/132K/192K/FLAC。

    /**
     * 0.8.4：找到一次就记住。
     *
     * 以前每 1.2 秒把整个文档的 div 扫一遍找「默认音质」那行——播放页 DOM 再小，
     * 也是白白每秒钟扔一次全量选择器。控件还在文档里就直接复用，只有它被换掉才重扫。
     */
    let qualityAnchor = null;
    function findQualityControl() {
        if (typeof document === 'undefined') return null;
        if (qualityAnchor && qualityAnchor.trigger && qualityAnchor.trigger.isConnected) return qualityAnchor;
        qualityAnchor = null;
        const labels = ['默认音质', 'Default quality', 'Audio quality'];
        const nodes = document.querySelectorAll('div');
        let anchor = null;
        for (const node of nodes) {
            if (node.children.length) continue;
            if (labels.includes(textOf(node))) {
                anchor = node;
                break;
            }
        }
        if (!anchor) return null;
        const row = anchor.parentElement;
        if (!row) return null;
        const trigger = row.lastElementChild;
        if (!trigger || trigger === anchor) return null;
        qualityAnchor = { anchor, row, trigger };
        return qualityAnchor;
    }

    /** 把 `el` 里等于 `from` 的那个文本节点换成 `to`（保留按钮里的图标）。 */
    function replaceText(el, from, to) {
        if (!el || !from || from === to) return false;
        const walker = document.createTreeWalker(el, 4); // 4 = NodeFilter.SHOW_TEXT
        let node = walker.nextNode();
        while (node) {
            if (String(node.nodeValue || '').trim() === from) {
                node.nodeValue = String(node.nodeValue).replace(from, to);
                return true;
            }
            node = walker.nextNode();
        }
        return false;
    }

    async function qualityLabelsFor(song) {
        const key = String(song.id);
        const hit = qualityCache.get(key);
        if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.map;
        const answer = await rpc('levels', { id: key });
        const ids = (answer && answer.ids) || [];
        const has = (value) => ids.includes(value);
        const top = has(30251) ? 'FLAC' : has(30250) ? t('杜比', 'Dolby') : has(30280) ? '192K' : has(30232) ? '132K' : '64K';
        const map = {
            standard: '64K',
            high: has(30280) ? '192K' : has(30232) ? '132K' : '64K',
            ultra: has(30280) ? '192K' : has(30232) ? '132K' : '64K',
            lossless: top,
            hires: top,
        };
        qualityCache.set(key, { at: Date.now(), map });
        if (qualityCache.size > 40) qualityCache.delete(qualityCache.keys().next().value);
        return map;
    }

    async function patchQualityLabels() {
        const playing = playingBiliSong();
        if (!playing) return;
        const control = findQualityControl();
        if (!control) return;
        let map = null;
        try {
            map = await qualityLabelsFor(playing.song);
        } catch (error) {
            log.warn('bili: 读音频档位失败', String(error && error.message));
            return;
        }
        if (!map) return;
        const rename = (el) => {
            if (!el) return;
            const current = textOf(el);
            const key = QUALITY_LABELS[current];
            if (!key || !map[key]) return;
            replaceText(el, current, map[key]);
        };
        rename(control.trigger);
        // 下拉展开时选项在浮层里，顺手一起改。
        for (const node of document.querySelectorAll('button, [role="option"], [role="menuitem"], li')) {
            const label = textOf(node);
            if (!QUALITY_LABELS[label]) continue;
            if (control.row.contains(node)) continue;
            const rect = node.getBoundingClientRect();
            if (!rect.width || !rect.height) continue;
            rename(node);
        }
    }

    function tick() {
        watchTimer = 0;
        if (typeof document === 'undefined') return;
        const hash = document.location ? document.location.hash : '';
        if (hash === '#player' && Date.now() - lastQualityAt > 1200) {
            lastQualityAt = Date.now();
            void patchQualityLabels().catch(() => {});
        }
    }

    function schedule() {
        if (watchTimer) return;
        watchTimer = setTimeout(tick, 120);
        if (watchTimer && typeof watchTimer.unref === 'function') watchTimer.unref();
    }

    try {
        // 渲染进程里是全局的；jsdom 之类的环境挂在 window 上。
        const Watcher =
            typeof MutationObserver === 'function'
                ? MutationObserver
                : (document.defaultView && document.defaultView.MutationObserver) || null;
        if (!Watcher) throw new Error('no MutationObserver');
        observer = new Watcher(schedule);
        observer.observe(document.body, { childList: true, subtree: true });
    } catch (error) {
        log.warn('bili: 歌词窗口监听没起来', String(error && error.message));
    }

    // ------------------------------------------------------------ settings

    /** 标签可以是 `{ 'zh-CN': …, en: … }`，按界面语言挑一个。 */
    function pickLabel(label, locale) {
        if (!label) return '';
        if (typeof label === 'string') return label;
        const lang = String(locale || 'zh-CN').toLowerCase();
        if (lang.startsWith('zh')) return label['zh-CN'] || label.zh || label.en || '';
        return label.en || label['zh-CN'] || '';
    }

    /**
     * 面板上的两组：常用的两张卡放外面，一次性的调参折起来。
     * 折叠状态只活在这个面板实例里——既不该污染设置值，也不该在两个实例之间串。
     */

    const GROUPS = {
        account: {
            label: { 'zh-CN': '账号', en: 'Account' },
            // 折叠起来也要能看出登没登录，否则四个组全收起时用户只能逐组点开找。
            summary: (values, L, ctx) => {
                if (ctx && ctx.loading) return L({ 'zh-CN': '正在读…', en: 'reading…' });
                const me = ctx && ctx.me;
                return me
                    ? me.nickname
                    : L({ 'zh-CN': '未登录 · 点开扫码', en: 'signed out · tap to sign in' });
            },
        },
        content: {
            label: { 'zh-CN': '内容', en: 'Content' },
            summary: (values, L) => {
                // 0.8.6：收藏夹和合集的筛选方式是分开的，摘要也得分开算。
                const bits = [];
                const describe = (kind, name, nameEn) => {
                    const view = visibilityForKind(values, kind);
                    const picked = view.mode === 'allow' ? view.allow.size : view.hide.size;
                    if (!picked) return;
                    bits.push(view.mode === 'allow'
                        ? L({ 'zh-CN': `只显示 ${picked} 个${name}`, en: `showing ${picked} ${nameEn}` })
                        : L({ 'zh-CN': `隐藏 ${picked} 个${name}`, en: `hiding ${picked} ${nameEn}` }));
                };
                describe('playlist', '收藏夹', 'favorites');
                describe('album', '合集', 'collections');
                if (!bits.length) bits.push(L({ 'zh-CN': '全部显示', en: 'showing all' }));
                const extra = parseExtraList(values.extraCollections).items.length;
                if (extra) bits.push(L({ 'zh-CN': `外加 ${extra} 个`, en: `+${extra}` }));
                return bits.join(' · ');
            },
        },
        playback: {
            label: { 'zh-CN': '播放与歌词', en: 'Playback and lyrics' },
            summary: (values, L) => {
                const bits = [];
                const lyrics = (SETTING_FIELDS.find((field) => field.key === 'lyrics') || {});
                const hit = (lyrics.options || []).find((option) => option.value === values.lyrics);
                if (hit) bits.push(L(hit.shortLabel || hit.label));
                bits.push(values.route === 'direct'
                    ? L({ 'zh-CN': '只直连', en: 'direct' })
                    : values.route === 'proxy'
                        ? L({ 'zh-CN': '本机中转', en: 'relay' })
                        : L({ 'zh-CN': '自动', en: 'auto' }));
                return bits.join(' · ');
            },
        },
        advanced: {
            label: { 'zh-CN': '高级', en: 'Advanced' },
            summary: (values, L) => {
                const minutes = Number(values.maxMinutes) || 0;
                const bits = [minutes > 0
                    ? L({ 'zh-CN': `跳过超 ${minutes} 分钟的`, en: `skip >${minutes} min` })
                    : L({ 'zh-CN': '不按时长过滤', en: 'no length filter' })];
                if (values.rawTitle) bits.push(L({ 'zh-CN': '原始标题', en: 'raw titles' }));
                return bits.join(' · ');
            },
        },
    };

    /**
     * 设置项：既是宿主的 schema，也是自绘面板的字段表。
     *
     * 0.8.4：从「常用 / 更多」两组改成「账号 / 内容 / 播放与歌词 / 高级」四组。
     * 每条带 `hint`（面板上常显的一行）和 `description`（点「?」才展开的全文）——
     * 之前的 2~4 行说明把面板撑得很长，真正需要看细节的时候反而不想看。
     *
     * 面板只画非 secret、非 hidden 的字段。`cookie` 仍然要留在 schema 里——
     * Folium 1.7 只给「声明过的 secret 字段」做加密存储（electron/modSystem/modSecrets.cjs 的
     * requireKey 会拒绝没声明过的键），删掉它，扫码登录拿到的 Cookie 就只能明文落盘了。
     * `visibleFolders` / `visibleAlbums` 是白名单的存储位，同样不直接画（由选择器写）。
     *
     * 注意 `type` 只能用宿主认的六种（number / text / boolean / select / color / secret）。
     * 0.8.4 一度想写 picker / extras / folder-select 这些自造类型，结果宿主在模组卡片上
     * 直接报「settings xxx: type must be one of …」——声明式表单那边是会校验的。
     * 面板本来就按字段 key 硬编码挑渲染器（renderPicker / renderExtras…），不看 type，
     * 所以自定义的「画成什么」全放在 `ui` 键里，type 老老实实写 text。
     */
    const SETTING_FIELDS = [
        {
            // 收藏夹和合集的筛选方式各存一份。面板上画在各自的列表里（见 renderPicker），
            // 所以这两条不进通用行；`type: select` 仍然按宿主认的类型写。
            key: 'pickerMode',
            group: 'content',
            type: 'select',
            ui: 'hidden',
            label: { 'zh-CN': '收藏夹的筛选方式', en: 'Favorites filter mode' },
            options: [
                { value: 'hide', label: { 'zh-CN': '勾掉的隐藏', en: 'Hide checked' } },
                { value: 'allow', label: { 'zh-CN': '只显示勾选的', en: 'Show checked only' } },
            ],
            defaultValue: 'hide',
        },
        {
            key: 'albumPickerMode',
            group: 'content',
            type: 'select',
            ui: 'hidden',
            label: { 'zh-CN': '合集的筛选方式', en: 'Collections filter mode' },
            options: [
                // 空值 = 还没单独选过，跟收藏夹用同一个，老配置升级上来不会突变。
                { value: '', label: { 'zh-CN': '跟收藏夹用同一个', en: 'Same as favorites' } },
                { value: 'hide', label: { 'zh-CN': '勾掉的隐藏', en: 'Hide checked' } },
                { value: 'allow', label: { 'zh-CN': '只显示勾选的', en: 'Show checked only' } },
            ],
            defaultValue: '',
        },
        {
            key: 'excludedFolders',
            group: 'content',
            type: 'text',
            ui: 'picker',
            picker: 'folders',
            label: { 'zh-CN': '收藏夹', en: 'Favorites' },
            hint: {
                'zh-CN': '「收藏」页签里显示哪些收藏夹。',
                en: 'Which favorites show on the Favorites tab.',
            },
            description: {
                'zh-CN':
                    '自建的、我收藏的、手动添加的都列在这里。勾了立刻生效，不用保存；' +
                    '同一个夹子出现两次时，勾一次两边都跟着变。',
                en:
                    'Every folder you own, collected or pasted is listed. Changes apply at once; ' +
                    'one folder reached two ways is one checkbox.',
            },
            defaultValue: '',
        },
        {
            key: 'visibleFolders',
            group: 'content',
            type: 'text',
            ui: 'hidden',
            label: { 'zh-CN': '显示的收藏夹', en: 'Visible favorites' },
            defaultValue: '',
        },
        {
            key: 'excludedAlbums',
            group: 'content',
            type: 'text',
            ui: 'picker',
            picker: 'albums',
            label: { 'zh-CN': '合集 / 系列', en: 'Collections' },
            hint: {
                'zh-CN': '「合集」页签里显示哪些。',
                en: 'Which collections show on the Collections tab.',
            },
            description: {
                'zh-CN':
                    '接进来的 UP 主合集和系列都在这里，已经挡掉的也在。' +
                    '搜索里翻到的合集不在这张表里，不受它影响。',
                en:
                    'Connected UP collections are listed, including hidden ones. ' +
                    'Collections found by web search are not affected.',
            },
            defaultValue: '',
        },
        {
            key: 'visibleAlbums',
            group: 'content',
            type: 'text',
            ui: 'hidden',
            label: { 'zh-CN': '显示的合集', en: 'Visible collections' },
            defaultValue: '',
        },
        {
            key: 'likedFolder',
            group: 'content',
            type: 'text',
            ui: 'folder-select',
            label: { 'zh-CN': '「喜欢」存到哪个收藏夹', en: 'Where the heart saves' },
            hint: {
                'zh-CN': '点心形按钮，歌就收进这个夹子。',
                en: 'The heart puts the song here.',
            },
            description: {
                'zh-CN':
                    '不选就是默认收藏夹。再点一次心形就取消收藏。' +
                    '列表按条数排，默认夹放最前面。',
                en:
                    'Leaving it unset uses the default folder. Clicking the heart again removes ' +
                    'the song. Sorted by track count, default folder first.',
            },
            defaultValue: '',
        },
        {
            key: 'extraCollections',
            group: 'content',
            type: 'text',
            ui: 'extras',
            label: { 'zh-CN': '别人的公开收藏夹 / 合集', en: 'Other people’s public lists' },
            hint: {
                'zh-CN': '把别人的公开收藏夹或 UP 主合集也接进来。',
                en: 'Add someone else’s public favorites or a UP collection.',
            },
            description: {
                'zh-CN':
                    '粘贴链接就行：公开收藏夹、UP 主合集、系列都能认。' +
                    '名字和条数会去 bilibili 读，读不到会标红。',
                en:
                    'Paste a link: public favorites, UP collections and series all work. ' +
                    'Names and counts are read from bilibili; failures are flagged.',
            },
            defaultValue: '',
        },
        {
            key: 'lyrics',
            group: 'playback',
            type: 'select',
            label: { 'zh-CN': '歌词来源', en: 'Lyrics' },
            hint: {
                'zh-CN': '先找其他平台的歌词，找不到就用视频字幕。',
                en: 'Match elsewhere first, then use the video’s subtitles.',
            },
            description: {
                'zh-CN':
                    '默认按歌名歌手去已登录的平台找，找不到就用视频的 CC 字幕。' +
                    '播的时候想临时换，去播放器面板的「歌词来源」页签。' +
                    '「匹配歌词」窗口里的 bilibili 页签固定只用字幕，不受这里影响。',
                en:
                    'Match on a signed-in platform by song and artist, then fall back to the ' +
                    'video’s CC subtitles. To switch one song on the spot, use the “Lyrics” tab ' +
                    'in the player panel. The bilibili tab in the match window always uses subtitles.',
            },
            options: [
                {
                    value: 'match-then-cc',
                    label: { 'zh-CN': '先匹配其他平台，再 CC 字幕', en: 'Match elsewhere, then CC' },
                    shortLabel: { 'zh-CN': '先匹配其他平台，再 CC 字幕', en: 'match, then CC' },
                },
                {
                    value: 'cc-then-match',
                    label: { 'zh-CN': '先用 CC 字幕，再匹配其他平台', en: 'CC first, then match' },
                    shortLabel: { 'zh-CN': '先 CC 字幕，再匹配其他平台', en: 'CC, then match' },
                },
                {
                    value: 'cc',
                    label: { 'zh-CN': '只用 CC 字幕', en: 'CC subtitles only' },
                    shortLabel: { 'zh-CN': '只用 CC 字幕', en: 'CC only' },
                },
                {
                    value: 'match',
                    label: { 'zh-CN': '只匹配其他平台', en: 'Match elsewhere only' },
                    shortLabel: { 'zh-CN': '只匹配其他平台', en: 'match only' },
                },
                {
                    value: 'off',
                    label: { 'zh-CN': '不要歌词', en: 'No lyrics' },
                    shortLabel: { 'zh-CN': '不要歌词', en: 'off' },
                },
            ],
            defaultValue: 'match-then-cc',
        },
        {
            key: 'route',
            group: 'playback',
            type: 'select',
            label: { 'zh-CN': '播放线路', en: 'Stream route' },
            hint: {
                'zh-CN': '一般不用改，走不通会自动换一条。',
                en: 'Leave it alone; it falls back on its own.',
            },
            description: {
                'zh-CN':
                    '自动：先直连 bilibili 的音频服务器，拿不到再走本机中转。' +
                    '直连省资源，中转更稳，但每首歌都要过一遍本机端口。',
                en:
                    'Auto tries the CDN directly, then falls back to a local relay. Direct is ' +
                    'lightest; the relay is steadier but every song passes through a local port.',
            },
            options: [
                { value: 'auto', label: { 'zh-CN': '自动', en: 'Auto' } },
                { value: 'direct', label: { 'zh-CN': '只用直连', en: 'Direct only' } },
                { value: 'proxy', label: { 'zh-CN': '只用本机中转', en: 'Relay only' } },
            ],
            defaultValue: 'auto',
        },
        {
            key: 'rawTitle',
            group: 'advanced',
            type: 'boolean',
            label: { 'zh-CN': '显示原始标题', en: 'Show original titles' },
            hint: {
                'zh-CN': '用 UP 主的原标题，不拆成歌名和歌手。',
                en: 'Use the uploader’s title instead of song / artist.',
            },
            description: {
                'zh-CN':
                    '打开后列表、队列、播放器都显示原标题。歌词还是按拆出来的歌名歌手去匹配。',
                en:
                    'Lists, queue and player all show the uploader’s title. Lyric matching still ' +
                    'uses the parsed song and artist.',
            },
            defaultValue: false,
        },
        {
            key: 'maxMinutes',
            group: 'advanced',
            type: 'number',
            label: { 'zh-CN': '跳过超过（分钟）的视频', en: 'Skip videos longer than (min)' },
            hint: {
                'zh-CN': '填 0 就不过滤。合集和直播回放通常很长。',
                en: '0 turns it off. Collections and replays are often long.',
            },
            description: {
                'zh-CN':
                    '合集、直播回放动辄几十分钟，会把搜索结果和探索页冲乱。' +
                    '只影响列表里出现的条目，已经加进队列的歌不受影响。',
                en:
                    'Collections and live replays run tens of minutes and flood search and explore. ' +
                    'Only affects listed items, not songs already queued.',
            },
            min: 0,
            max: 300,
            step: 5,
            defaultValue: 0,
        },
        {
            // 只为加密存储而声明：面板不画（见 mountSettings 的 secret 过滤）。
            // 主进程用 api.secrets.get('cookie') 读、扫码登录写入。
            key: 'cookie',
            type: 'secret',
            label: { 'zh-CN': '登录凭据', en: 'Sign-in credential' },
            description: { 'zh-CN': '扫码登录后由宿主加密保存，不用手填。', en: 'Saved encrypted by the host after QR sign-in.' },
        },
    ];


    const section = folium.registries.settingsSections.register({
        id: 'bili-source',
        label: { 'zh-CN': 'bilibili', en: 'bilibili' },
        description: {
            'zh-CN':
                '把 bilibili 当成一个音源。搜索搜全站视频；收藏夹和 UP 主合集会变成「收藏」「合集」' +
                '页签里的卡片，点一首就把整张列表放进队列。',
            en:
                'Use bilibili as a music source. Search covers all of bilibili; your favorites and ' +
                'UP collections become cards on the Favorites and Collections tabs.',
        },
        settings: SETTING_FIELDS,
        settingsPanel: mountSettings,
    });

    const config = () => section.settings.get();

    /**
     * 自绘的设置面板。
     *
     * 宿主的声明式表单只有单行文本和静态选项，这里需要两样它没有的东西：
     * 一个多行的「额外列表」输入、一个从账号里现读的「喜欢收藏夹」下拉。
     * 顺便也就不画 Cookie 那条了。
     *
     * 面板在 ShadowRoot 里（宿主给容器加了 `all: initial`），所以颜色得自己定，
     * 按主题的日夜挑一套，再跟着 `ctx.onChange` 换。
     */
    /**
     * 设置面板本体在 lib/settingsPanel.mjs（约 900 行）。
     *
     * 依赖里有 auth（定义在下面）和几张缓存，所以先占位，等依赖齐了再接线；
     * 宿主只会在用户点开设置时调这个函数，那会儿早就接好了。
     */
    let settingsPanel = null;

    function mountSettings(container, ctx) {
        return settingsPanel(container, ctx);
    }

    /**
     * 改设置之后要不要重读，得看改的是哪一项。
     *
     * 以前是任何一个值一动就把四层缓存全清、再让宿主重读一次账号：在「额外列表」里打字
     * （600ms 防抖）也会连着触发，墙面一直重画——这就是卡顿的来源。现在只看真正影响数据的
     * 那几项，而且合并成一次，800ms 内连改多次只重读一次。
     */
    let settingSig = '';
    const sigOfSettings = (values) =>
        [
            values.rawTitle ? '1' : '0',
            String(values.maxMinutes || 0),
            String(values.extraCollections || ''),
            String(values.route || 'auto'),
            String(values.excludedFolders || ''),
            String(values.excludedAlbums || ''),
            // 0.8.4：白名单和模式也要进签名，否则切过去墙不会重读。
            // 0.8.6：合集有自己的模式位，漏了它切合集的筛选方式墙不动。
            String(values.visibleFolders || ''),
            String(values.visibleAlbums || ''),
            String(values.pickerMode || 'hide'),
            String(values.albumPickerMode || ''),
        ].join('|');

    const unwatchSettings =
        typeof section.settings.onChange === 'function'
            ? section.settings.onChange(() => {
                  const values = section.settings.get();
                  const sig = sigOfSettings(values);
                  if (sig === settingSig) return;
                  settingSig = sig;
                  meta.clear();
                  siteCache.clear();
                  folderCache.clear();
                  extraCache = { sig: '', items: [], at: 0 };
                  scheduleWallRefresh(500);
              })
            : () => {};
    settingSig = sigOfSettings(section.settings.get());

    // ------------------------------------------------------- 宿主的曲库接口

    /** 读一次封面缓存（只有本地存过的，不联网）。 */
    async function loadCovers() {
        try {
            const answer = await rpc('covers');
            return (answer && answer.covers) || {};
        } catch {
            return {};
        }
    }

    // ------------------------------------- 「我收藏的」+ 三个来源的合流
    //
    // 「收藏」页签（宿主原文「歌单」）= 自建收藏夹 + 手贴的收藏夹 + 账号「我收藏的」里的收藏夹（type 11）
    // 「合集」页签（宿主原文「专辑」）= 手贴的合集 / 系列 + 账号「我收藏的」里的视频合集（type 21）
    // 手贴的和账号收藏的可能是同一个夹子/合集，按真实资源 id 去重（手贴优先）。

    const COLLECTED_TTL = 5 * 60 * 1000;
    let collectedCache = { at: 0, items: [] };
    let collectedLoading = null;
    let snapshotLoading = null;

    /** 账号「我收藏的」列表。没登录 / 接口挂了都返回空，不能连累整面墙。 */
    async function collectedNow() {
        if (Date.now() - collectedCache.at < COLLECTED_TTL) return collectedCache.items;
        if (collectedLoading) return collectedLoading;
        collectedLoading = (async () => {
            try {
                const answer = await rpc('collected');
                const items = parseCollected(answer && answer.items).map((raw) => ({
                    ...raw,
                    name: cleanListName(raw.name),
                }));
                collectedCache = { at: Date.now(), items };
                return items;
            } catch (error) {
                log.warn('bili: 「我收藏的」读取失败', String(error && error.message));
                return collectedCache.items;
            } finally {
                collectedLoading = null;
            }
        })();
        return collectedLoading;
    }

    /**
     * 三个来源合一次，歌单和专辑各自排好。
     * 不按时间缓存：宿主改设置、补完封面、重新登录都要立刻看到新列表；
     * 底下的 rpc / extrasNow / collectedNow 各有自己的缓存，多一次 IPC 不贵。
     * 只合并并发请求，避免同一帧里发三遍。
     */
    async function librarySnapshot() {
        if (snapshotLoading) return snapshotLoading;
        snapshotLoading = (async () => {
            try {
                // 没登录 / Cookie 过期时 folders 会抛错，但设置里手贴的公开列表和
                // 「我收藏的」不该被连累：把这一个来源降级成空，另外两个照常上墙。
                const sources = await readLibrarySources({
                    folders: () => rpc('folders'),
                    extras: () => extrasNow(),
                    collected: () => collectedNow(),
                    onError: (error) => log.warn(
                        'bili: 自建收藏夹读不到（多半是没登录），其余列表照常显示',
                        String(error && error.message),
                    ),
                });
                return buildLibrary({
                    folders: sources.folders.items || [],
                    extras: sources.extras,
                    collected: sources.collected,
                    covers,
                    ownerName: sources.folders.owner || '',
                    ownerId: sources.folders.mid || '',
                });
            } finally {
                snapshotLoading = null;
            }
        })();
        return snapshotLoading;
    }

    /** 宿主要的 { items, hasMore, nextOffset, total } 分页。 */
    function pageOf(list, limit, offset) {
        const start = Math.max(0, Number(offset) || 0);
        const want = Math.max(1, Number(limit) || list.length || 1);
        const items = list.slice(start, start + want);
        return {
            items,
            hasMore: start + items.length < list.length,
            nextOffset: start + items.length,
            total: list.length,
        };
    }

    // ---------------------------------------------- 额外的公开收藏夹 / 合集

    const EXTRA_TTL = 10 * 60 * 1000;
    /** 上一次解析出来的额外列表；设置一改就作废。 */
    let extraCache = { sig: '', items: [], at: 0 };
    /** 正在读的那一次：宿主连着问两遍时共用一个请求。 */
    let extraLoading = null;

    /**
     * 设置里贴的那些链接 → 能上墙的列表。
     *
     * 名字、条数、封面在主进程问一次（那边按 10 分钟缓存、还落盘），这里再按 5 分钟记一层，
     * 免得宿主每翻一页都问一遍。读不到的那条直接丢掉，只记一条日志——不能因为一条坏链接
     * 把整个「收藏」页签搞空。
     */
    async function extrasNow() {
        const { items } = parseExtraList(config().extraCollections);
        const sig = items.map((item) => item.key).join('|');
        if (sig === extraCache.sig && Date.now() - extraCache.at < EXTRA_TTL) return extraCache.items;
        if (!items.length) {
            extraCache = { sig: '', items: [], at: Date.now() };
            return [];
        }
        // 宿主连着问（翻页、重读账号）时共用一个请求，别同时发两遍。
        if (extraLoading && extraLoading.sig === sig) return extraLoading.task;
        const task = (async () => {
            try {
                const answer = await rpc('extras', {
                    refs: items.map(({ key, kind, mediaId, mid, sid }) => ({ key, kind, mediaId, mid, sid })),
                });
                const byKey = new Map(((answer && answer.items) || []).map((item) => [item.key, item]));
                const resolved = items
                    .map((ref) => {
                        const hit = byKey.get(ref.key);
                        if (!hit || !hit.ok) {
                            log.warn('bili: 额外列表读不到', ref.raw, (hit && hit.error) || '');
                            return null;
                        }
                        return {
                            ...ref,
                            name: cleanListName(hit.name) || '未命名列表',
                            count: Number(hit.count) || 0,
                            cover: hit.cover || '',
                            owner: hit.owner || '',
                            mid: String(hit.mid || ref.mid || ''),
                        };
                    })
                    .filter(Boolean);
                extraCache = { sig, items: resolved, at: Date.now() };
                return resolved;
            } catch (error) {
                log.warn('bili: 额外列表读取失败', String(error && error.message));
                return extraCache.items;
            } finally {
                if (extraLoading && extraLoading.sig === sig) extraLoading = null;
            }
        })();
        extraLoading = { sig, task };
        return task;
    }

    /**
     * 宿主问「这个账号有哪些歌单」：自建收藏夹 + 手贴的收藏夹 + 「我收藏的」里的收藏夹，
     * 减掉设置里勾掉的那些。快照本身保持全量，设置面板才能把已排除的也列出来供取消勾选。
     *
     * 0.8.1：「推荐」页签撤掉后，原来那 8 张入口卡只剩「我喜欢的音乐」，搬到这个
     * 「收藏」页签里。宿主 BravaisHome.Te() 认 raw.isLiked === true 画特殊卡；
     * 点开走 tracksOf('w-liked')，落到播放器心形按钮真正写入的那个夹子。
     * 那个夹子本身从普通列表里去掉，免得同一批歌出现两张卡。
     */
    async function getUserPlaylists(userId, limit, offset) {
        const snap = await librarySnapshot();
        // 0.8.4：黑名单 / 白名单都走这一条。白名单空着时回落成全部显示。
        const view = visibilityForKind(section.settings.get(), 'playlist');
        const likedRaw = likedRawOf(snap);
        const collections = excludeCollections(snap.playlists, view)
            .filter((raw) => raw !== likedRaw)
            .map((raw) => toCollection(raw, myProviderId()));
        if (likedRaw) {
            collections.unshift(likedCollection(
                { count: likedRaw.count, cover: likedCoverOf(likedRaw) },
                myProviderId(),
            ));
        }
        void fillMissingCovers(snap.folders);
        return pageOf(collections, limit, offset);
    }

    /**
     * 宿主问「收藏了哪些专辑」：bilibili 这边其实是 UP 主的合集 / 系列 + 账号收藏的视频合集。
     * 宿主判 canUseAlbums = userLibrary && userAlbums（见 lib/hostlib.mjs），
     * 点开 type:'album' 的卡片会走 catalog.getAlbumTracks，不是 getPlaylistTracks。
     */
    async function getUserAlbums(userId, limit, offset) {
        const snap = await librarySnapshot();
        // 0.7.8 起合集有自己那份「不显示的合集」列表，和收藏夹那份完全独立。
        // 0.8.4：这份也支持白名单模式。快照保持全量，设置面板才能把已排除的也列出来。
        const view = visibilityForKind(section.settings.get(), 'album');
        const collections = excludeCollections(snap.albums, view).map((raw) => toCollection(raw, myProviderId()));
        return pageOf(collections, limit, offset);
    }

    /**
     * 0.7.26 新搜索页的「专辑 / 歌单」两类（选中 bilibili 时叫「合集 / 收藏」）。
     *
     * 宿主 omni.searchProviderCollections 直接调 provider.search.searchAlbums /
     * searchPlaylists(query, limit, offset)，再把 items 过滤成 providerId 等于自己。
     * 点开卡片时宿主拿 id 去 catalog.getPlaylistTracks / getAlbumTracks。
     *
     * bilibili Web 端没有「按关键词搜别人的收藏夹」的接口（media_list / fav /
     * collection / season 这些 search_type 全被降级过滤），所以三类候选：
     *   本地名字命中 → 夹内视频命中 / 全站反查合集 → 都没有就列出全部已接入列表。
     * 「合集」的全站结果 id 自带 mid / sid，catalog 不查库快照也能打开。
     */
    function cacheRead(store, key) {
        const hit = store.get(key);
        if (hit && Date.now() - hit.at < WEB_CACHE_TTL) return hit.value;
        return null;
    }

    function cacheWrite(store, key, value) {
        store.set(key, { at: Date.now(), value });
        if (store.size > 24) store.delete(store.keys().next().value);
        return value;
    }

    /** 搜视频 → view?bvid= 里的 ugc_season → 全站合集 raw。失败安静降级为空。 */
    async function remoteSeasonsFor(query) {
        const needle = String(query || '').trim().toLowerCase();
        if (!needle) return [];
        const hit = cacheRead(seasonSearchCache, needle);
        if (hit) return hit;
        const running = inflightSeason.get(needle);
        if (running) return running;
        const task = (async () => {
            try {
                const answer = await rpc('searchSeasons', { keyword: query, page: 1 });
                const raws = ((answer && answer.items) || []).map(remoteSeasonRaw).filter(Boolean);
                return cacheWrite(seasonSearchCache, needle, raws);
            } catch (error) {
                log.warn('bili: 全站合集没搜到', String(error && error.message));
                return cacheWrite(seasonSearchCache, needle, []);
            } finally {
                inflightSeason.delete(needle);
            }
        })();
        inflightSeason.set(needle, task);
        return task;
    }

    /** 收藏夹里真的有标题含关键词的视频 → 命中的 raw.key 集合。 */
    async function contentKeysFor(query, list) {
        const needle = String(query || '').trim().toLowerCase();
        if (!needle) return null;
        const mediaIds = [...new Set((Array.isArray(list) ? list : [])
            .filter((raw) => raw && raw.kind === 'folder' && /^\d+$/.test(String(raw.mediaId || '')))
            .map((raw) => String(raw.mediaId)))];
        if (!mediaIds.length) return null;
        let titles = cacheRead(folderMatchCache, needle);
        if (!titles) {
            try {
                const answer = await rpc('matchFolders', { keyword: query, ids: mediaIds });
                const rawHits = (answer && answer.hits) || {};
                // 复核标题：万一接口哪天忽略了 keyword，别把第一页 20 条全当成命中。
                titles = Object.fromEntries(Object.entries(rawHits)
                    .filter(([, title]) => String(title).toLowerCase().includes(needle)));
                cacheWrite(folderMatchCache, needle, titles);
            } catch (error) {
                log.warn('bili: 收藏夹内容搜索失败', String(error && error.message));
                return null;
            }
        }
        const keys = new Set();
        for (const raw of list) {
            if (raw && raw.kind === 'folder' && titles[String(raw.mediaId)]) keys.add(String(raw.key));
        }
        return keys;
    }

    async function searchCollections(kind, query, limit, offset) {
        const snap = await librarySnapshot();
        const isAlbum = kind === 'album';
        const list = isAlbum ? snap.albums : snap.playlists;
        // 0.7.8 起两类各有自己的排除列表。0.8.4 起这份规则也可能来自白名单。
        // 全站反查出来的合集不是「已接入」的，collectCandidates 只用它过滤本地 source，remote 那一路不受影响。
        const hidden = visibilityForKind(section.settings.get(), kind);
        if (isAlbum) {
            // 本地已经有名字精确命中的合集，就不再花十几秒去反查全站：
            // 用户这时找的是自己接进来的那张卡，混进一堆陌生合集反而更难找。
            const localHit = hasLocalNameHit(list, query, hidden);
            const remote = localHit ? [] : await remoteSeasonsFor(query);
            return searchCollectionPage(list, query, myProviderId(), limit, offset, hidden, { remote });
        }
        const contentKeys = await contentKeysFor(query, list);
        return searchCollectionPage(list, query, myProviderId(), limit, offset, hidden, { contentKeys });
    }

    const searchAlbums = (query, limit, offset) => searchCollections('album', query, limit, offset);
    const searchPlaylists = (query, limit, offset) => searchCollections('playlist', query, limit, offset);

    // ------------------------------------------- 书库首页：只保留「探索」页签的歌曲瀑布流
    // 0.8.1：「推荐」页签撤掉了。宿主那排胶囊是全局的，模组没有按音源隐藏的 API，
    // 由 lib/homeTab.mjs 在 bilibili 是当前音源时把「推荐」那颗藏起来（切走还原），
    // 同时不再声明 capabilities.recommendations，键盘循环页签也不会再落进空的推荐页。
    // 原来 0.8.0 的 8 张入口卡只剩「我喜欢的音乐」，已搬到 getUserPlaylists() 的
    // 「收藏」页签。这里只留「我喜欢的音乐」点开时要用的红心夹解析。
    //
    // 歌曲卡一律用 videoToSong() 给完整 DTO（name / album.coverUrl / sourceRef）：
    // 0.7.8 整窗白屏就是因为给宿主透传了只有 title、album:'' 的裸对象，
    // 集合页墙读 song.name 得到 undefined，抛 TypeError 卸载整棵 React 树。

    /** 「我喜欢的音乐」= 播放器心形按钮写入的那个夹子：设置里指定了就用它，否则默认夹。 */
    function likedRawOf(snap) {
        const wanted = String(config().likedFolder || '').trim();
        if (wanted) {
            const hit = snap.byKey.get(wanted);
            if (hit && hit.kind === 'folder') return hit;
        }
        const playlists = (snap && snap.playlists) || [];
        return playlists.find((raw) => raw.isDefault) || playlists.find((raw) => raw.source === 'own') || null;
    }

    function likedCoverOf(raw) {
        if (!raw) return '';
        return (covers[String(raw.key)] || [])[0] || raw.cover || '';
    }

    // ------------------------------------------------ 探索页：歌曲瀑布流
    // 宿主 useExploreWall 的 nu() 写死「一次 read 最多自动续读 4 批 / 96 首」，之后靠
    // 每区「更多」(moreCursor)、顶部「换一批」(refresh)，以及本模组下面的「自动续命」
    // 继续往下刷。我们只负责按 fresh_idx 不停给新的歌：
    //   * 0.8.1 删掉了 400 回绕（实测 fresh_idx=2001 仍正常给 30 首、零重复），
    //     那才是「刷久了整批重来」的真凶；
    //   * 按用户选择「照原样显示」，模组侧不再做全局去重，宿主自己在 section pool
    //     里用 fl() / xl() 去重；
    //   * feedAnswer() 不再带 refreshReadsAnew，否则「换一批」会重放旧池子。
    // 0.9.1：每批从 30 降到 18。宿主每追加一次就重排整面 transform 墙，
    // 实测一次 55~155ms（27 张卡），掉帧全落在这一刻。批量小了单次重排更轻，
    // 代价是同样的滚动距离内批次数多一点 —— 但人感知的是单次卡顿的长度，不是次数。
    // bilibili 的 fresh_idx 没有上界，18 一首不少。
    const EXPLORE_PAGE = 18;
    let exploreNextIdx = 1;
    const exploreFlights = new Map();

    /** fresh_idx 没有上界，只挡 NaN / Infinity / 负数这类坏值。 */
    function safeIdx(value) {
        const num = Number(value);
        return Number.isFinite(num) && num > 0 ? Math.floor(num) : 1;
    }

    async function exploreBatch(startIdx) {
        const idx = safeIdx(startIdx);
        if (exploreFlights.has(idx)) return exploreFlights.get(idx);
        const task = (async () => {
            try {
                const answer = await rpc('recommend', { ps: EXPLORE_PAGE, freshIdx: idx });
                const max = Number(config().maxMinutes) || 0;
                const raw = ((answer && answer.items) || []).filter(
                    (item) => item && item.bvid && (!max || !item.durationMs || item.durationMs <= max * 60000),
                );
                // 「照原样显示」：接口给什么就画什么，模组侧不再按 bvid 去重。
                // 宿主自己在 section pool 里用 fl() / xl() 过滤重复条目。
                return {
                    songs: raw
                        .map((item) => videoToSong(item, { providerId: myProviderId(), decorate }))
                        .filter(Boolean),
                    nextIdx: safeIdx(Number(answer && answer.nextFreshIdx) || idx + EXPLORE_PAGE),
                };
            } catch (error) {
                log.warn('bili: 探索页推荐读取失败', String(error && error.message));
                return { songs: [], nextIdx: idx + EXPLORE_PAGE };
            } finally {
                exploreFlights.delete(idx);
            }
        })();
        exploreFlights.set(idx, task);
        return task;
    }

    async function getExploreFeed(cursor) {
        const parsed = parseExploreCursor(cursor);
        const idx = parsed || exploreNextIdx;
        const batch = await exploreBatch(idx);
        exploreNextIdx = Math.max(exploreNextIdx, batch.nextIdx);
        return feedAnswer(exploreSection(idx, batch.nextIdx, batch.songs), batch.nextIdx);
    }

    async function getExploreSectionItems(cursor) {
        // 每区「更多」和分区自动续读可能指向同一个 nextIdx；错开 7，免得两边抢同一批。
        const parsed = parseExploreCursor(cursor);
        const idx = (parsed ? parsed + 7 : exploreNextIdx);
        const batch = await exploreBatch(idx);
        exploreNextIdx = Math.max(exploreNextIdx, batch.nextIdx);
        return sectionAnswer(batch.songs, batch.nextIdx);
    }

    /**
     * 收藏夹封面 = 夹里第一条视频的封面。bilibili 一次只给一条，所以串行、慢慢来，
     * 拿齐了再让宿主重读一次账号（它自己会把封面画上）。
     */
    function fillMissingCovers(folders) {
        const missing = folders.filter((folder) => !(covers[String(folder.id)] || []).length).map((folder) => String(folder.id));
        if (!missing.length || coverFill) return;
        coverFill = (async () => {
            try {
                const answer = await rpc('fillCovers', { ids: missing });
                if (answer && answer.covers) {
                    covers = answer.covers;
                    await refreshWall();
                }
            } catch (error) {
                log.warn('bili: 收藏夹封面没取全', String(error && error.message));
            } finally {
                coverFill = null;
            }
        })();
    }

    /**
     * 一张卡里的曲目。不管它落在「收藏」还是「合集」页签，都按 raw.kind 路由：
     *   folder        → fav/resource/list（自建、手贴、收藏的收藏夹走同一条）
     *   season/series → seasons_archives_list / series/archives（手贴的和收藏的也一样）
     */
    async function tracksOf(key, limit, offset, collection) {
        const id = String(key || '');
        // 「我喜欢的音乐」是张虚拟卡，落到红心真正写入的那个收藏夹上。
        // 0.8.1 起它是「收藏」页签里唯一的入口卡（推荐页签已经撤掉）。
        if (isLikedKey(id)) {
            const snap = await librarySnapshot();
            const liked = likedRawOf(snap);
            if (!liked) return { items: [], hasMore: false, nextOffset: Math.max(0, Number(offset) || 0) };
            return tracksOf(liked.key, limit, offset, collection);
        }
        // 旧版本（<=0.7.9）留下的推荐视频卡不在书库墙快照里，key 自带 bvid。
        // 累积缓存已经随推荐页一起撤掉，靠卡片自身信息兜底，点开照样能播。
        const recoId = parseRecoKey(id);
        if (recoId) {
            const raw = recoTrackRaw(recoId, null, collection);
            const song = videoToSong(raw, { providerId: myProviderId(), decorate, album: (collection && collection.name) || '' });
            return {
                items: song ? [song] : [],
                hasMore: false,
                nextOffset: Math.max(0, Number(offset) || 0) + (song ? 1 : 0),
            };
        }
        const snap = await librarySnapshot();
        // 全站搜到的合集不在书库墙快照里，但 id 自带 mid / sid，照样能取曲目。
        const raw = snap.byKey.get(key) || remoteSeasonFromKey(key);
        if (!raw) return { items: [], hasMore: false, nextOffset: Math.max(0, Number(offset) || 0) };
        const albumName = (collection && collection.name) || raw.name || '';
        const page = await readTrackRange({
            offset,
            limit,
            fetchPage: async (number) => {
                if (raw.kind === 'folder') {
                    const answer = await rpc('folderItems', { mediaId: raw.mediaId, page: number });
                    return { items: answer.items || [], total: answer.total, hasMore: answer.hasMore };
                }
                const answer = await rpc('extraItems', {
                    ref: { key: raw.key, kind: raw.kind, mid: raw.mid, sid: raw.sid },
                    page: number,
                    owner: raw.owner || '',
                });
                return { items: answer.items || [], total: answer.total, hasMore: answer.hasMore };
            },
        });
        return {
            ...page,
            items: page.items
                .map((item) => videoToSong(item, { providerId: myProviderId(), decorate, album: albumName }))
                .filter(Boolean),
        };
    }

    async function getPlaylistTracks(id, limit, offset, collection) {
        return tracksOf(String(id || ''), limit, offset, collection);
    }

    async function getAlbumTracks(id, limit, offset, collection) {
        return tracksOf(String(id || ''), limit, offset, collection);
    }

    /** 集合页顶上的标题 / 条数 / 简介：直接用列表元信息，不再多打一次接口。 */
    async function detailOf(key, collection) {
        try {
            const snap = await librarySnapshot();
            const raw = snap.byKey.get(key);
            if (!raw) return collection || null;
            return refineCollection(
                {
                    ...(collection || {}),
                    id: key,
                    name: raw.name,
                    ...(raw.cover ? { coverUrl: raw.cover } : {}),
                },
                { total: raw.count, owner: raw.owner },
            );
        } catch {
            return collection || null;
        }
    }

    async function getPlaylistDetail(id, collection) {
        return detailOf(String(id || ''), collection);
    }

    async function getAlbumDetail(id, collection) {
        return detailOf(String(id || ''), collection);
    }

    // ------------------------------------------------------------- 「喜欢」

    /**
     * 宿主问「这个账号喜欢了哪些歌」：读「喜欢」收藏夹里的全部 bvid。
     *
     * 这个接口一次给完（不分页），所以 whole 可以老实说 true；读失败时说 false，
     * 宿主就不会把「空」当成「一首都没喜欢」写进账号缓存。
     */
    async function getLikedSongIds() {
        try {
            const answer = await rpc('likedIds', { folder: String(config().likedFolder || '') });
            return { ids: (answer && answer.ids) || [], whole: true };
        } catch (error) {
            log.warn('bili: 读「喜欢」列表失败', String(error && error.message));
            return { ids: [], whole: false };
        }
    }

    /** 心形按钮：收藏 = 加进「喜欢」收藏夹，取消 = 移出来。 */
    async function likeSong(song, liked) {
        const id =
            typeof song === 'object' && song
                ? String(song.id || (song.sourceRef && song.sourceRef.mediaId) || '')
                : String(song || '');
        if (!id) throw new Error('不知道是哪首歌');
        await rpc('favDeal', {
            id,
            liked: liked !== false,
            folder: String(config().likedFolder || ''),
        });
        // 收藏夹条数变了，下一次读要重新问；墙面稍后再重画（宿主自己也会先改一次心形）。
        folderCache.clear();
        extraCache = { sig: '', items: [], at: 0 };
        scheduleWallRefresh(900);
    }

    /**
     * 0.7.26 速记簿「加进歌单」：宿主按 50 首一批调
     * `updatePlaylistTracks('add'|'remove', collection, songs)`。
     * bilibili 的 resource/deal 一次只收一个 rid，所以逐首走现成的 favDeal。
     *
     * 连着打几十个 deal 很容易吃 -412，中间隔一下；中途失败就停，把已经成功的首数
     * 报回去——宿主会提示「加了 N 首」，比整批失败、其实已经加了一半要诚实。
     */
    async function updatePlaylistTracks(action, collection, songs) {
        const folder = String((collection && collection.id) || '');
        if (!folder) throw new Error('不知道要加进哪个收藏夹');
        if (!canAddToPlaylist(collection)) throw new Error('只能改自己的收藏夹');
        const add = action !== 'remove';
        const list = Array.isArray(songs) ? songs : [];
        let done = 0;
        let failure = null;
        for (const song of list) {
            const id =
                typeof song === 'object' && song
                    ? String(song.id || (song.sourceRef && song.sourceRef.mediaId) || '')
                    : String(song || '');
            if (!id) continue;
            if (done > 0) {
                // 模组被停用时就别再等了，直接收尾
                if (disposed) break;
                await settle(ADD_INTERVAL_MS);
                if (disposed) break;
            }
            try {
                await rpc('favDeal', { id, liked: add, folder });
            } catch (error) {
                failure = error;
                break;
            }
            done += 1;
        }
        folderCache.clear();
        extraCache = { sig: '', items: [], at: 0 };
        if (done > 0) scheduleWallRefresh(900);
        if (failure) {
            log.warn('bili: 批量改收藏夹中途失败', String(failure && failure.message));
            const error = new Error(done > 0
                ? `改到第 ${done + 1} 首时失败了，前面 ${done} 首已经改好`
                : String((failure && failure.message) || '改收藏夹失败'));
            error.done = done;
            throw error;
        }
        return { ok: true, count: done };
    }

    /** 只有自建收藏夹可写；账号收藏的 / 手贴的公开收藏夹 id 带 c- / x- 前缀，是只读的。 */
    const canAddToPlaylist = canMutateOwnCollection;

    // ------------------------------------------------------------------ 登录

    /** 二维码画成 data URL：宿主负责在登录窗口里显示，不再自己贴 DOM。 */
    function qrImage(payload) {
        if (typeof document === 'undefined' || !payload) return '';
        const qr = qrcode(0, 'M');
        qr.addData(payload);
        qr.make();
        const count = qr.getModuleCount();
        const quiet = 4;
        const scale = Math.max(2, Math.floor(240 / (count + quiet * 2)));
        const size = (count + quiet * 2) * scale;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const brush = canvas.getContext('2d');
        if (!brush) return '';
        brush.fillStyle = '#ffffff';
        brush.fillRect(0, 0, size, size);
        brush.fillStyle = '#111111';
        for (let row = 0; row < count; row += 1) {
            for (let column = 0; column < count; column += 1) {
                if (qr.isDark(row, column)) brush.fillRect((column + quiet) * scale, (row + quiet) * scale, scale, scale);
            }
        }
        return canvas.toDataURL('image/png');
    }

    function clearCaches() {
        siteCache.clear();
        folderCache.clear();
        meta.clear();
        collectedCache = { at: 0, items: [] };
        extraCache = { sig: '', items: [], at: 0 };
    }

    /**
     * 上一次成功读到的账号信息。
     *
     * 0.9.1：用户反馈「登录老是失效」。查下来 Cookie 大多是好的，是 nav 接口偶尔
     * 被限流 / 风控（-412、-799）或者请求超时，而宿主一拿到 null 就把整个音源
     * 画成未登录 —— 一次网络抖动看起来就像掉号。现在把上次的身份留一份：
     * 读不到时先按已登录显示，等下次真读到再说。只有接口**明确**说没登录（-101）
     * 才清掉，所以真过期、真退登不会一直被旧信息挡着。
     */
    const PROFILE_KEY = 'bili:profile';

    function readProfile() {
        try {
            const raw = localStorage.getItem(PROFILE_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            return parsed && parsed.id ? parsed : null;
        } catch {
            return null;
        }
    }

    function writeProfile(status) {
        const kept = {
            id: String(status.mid || ''),
            nickname: status.uname || 'bilibili 用户',
            ...(status.face ? { avatarUrl: status.face } : {}),
            at: Date.now(),
        };
        if (!kept.id) return kept;
        try {
            localStorage.setItem(PROFILE_KEY, JSON.stringify(kept));
        } catch {
            /* 隐私模式 / 配额满：只是下次没得回落，不影响本次 */
        }
        return kept;
    }

    function clearProfile() {
        try {
            localStorage.removeItem(PROFILE_KEY);
        } catch {
            /* 没有就算了 */
        }
    }

    const auth = {
        async getLoginStatus() {
            try {
                const status = await rpc('status');
                if (status && status.loggedIn) return writeProfile(status);
                // 接口没给明确答案（限流 -799、风控 -412、超时）：Cookie 还在，
                // 就沿用上次读到的身份，别把整个音源画成未登录。
                if (status && status.saved && !status.settled) return readProfile();
                // 明确回答「没登录 / 凭据过期」（-101）才真算掉号，旧身份一并清掉。
                if (status && status.settled) clearProfile();
                return null;
            } catch (error) {
                log.warn('bili: 读登录状态失败', String(error && error.message));
                return readProfile();
            }
        },
        async logout() {
            await rpc('logout');
            clearProfile();
            clearCaches();
            try {
                await rpc('clearCache');
            } catch {
                /* 清缓存失败不影响退出 */
            }
            covers = {};
            await refreshWall();
        },
        async startLogin() {
            const answer = await rpc('qr.generate');
            if (!answer || !answer.url) throw new Error('二维码生成失败，稍后再试');
            qrKeys.set(answer.url, answer.key);
            return answer.url;
        },
        createQr(payload) {
            return qrImage(payload);
        },
        async checkLogin(payload) {
            const key = qrKeys.get(payload);
            if (!key) return { state: 'expired' };
            const answer = await rpc('qr.poll', { key });
            const state = toLoginState(answer);
            if (state.state === 'confirmed') {
                qrKeys.delete(payload);
                clearCaches();
                covers = {};
                // 宿主读账户之前先把封面拿上，墙一出现就是带图的。
                covers = await loadCovers();
                await refreshWall();
            }
            if (state.state === 'expired' || state.state === 'error') qrKeys.delete(payload);
            return state;
        },
        async cancelLogin(payload) {
            qrKeys.delete(payload);
        },
    };

    // 设置面板的依赖到这里全了（auth、缓存、重读墙），统一接一次线。
    settingsPanel = createSettingsPanel({
        pickLabel,
        settingFields: SETTING_FIELDS,
        groups: GROUPS,
        rpc,
        reason,
        later,
        resourceOf,
        visibilityForKind,
        parseExcluded,
        serializeExcluded,
        parseExtraList,
        parseExtraRef,
        extraKey,
        cleanListName,
        buildLibrary,
        auth,
        extrasNow,
        collectedNow,
        clearCaches,
        refreshWall,
        reloadCovers: async () => {
            covers = await loadCovers();
        },
        version: MOD_VERSION,
        accent: BILI_PINK,
        fallbackSettings: () => section.settings,
    });

    // ------------------------------------------------- 把曲库交给宿主

    const hostRef = { value: null };
    /** 0.8.1：宿主探索页那张 zustand store，用来在 96 首上限之后继续追加新歌。 */
    const exploreStoreRef = { value: null };
    /** 宿主重读一次这个源：墙面跟着账户数据重画。 */
    async function refreshWall() {
        if (disposed) return;
        const host = hostRef.value;
        if (!host) return;
        await host.refreshAccount(myProviderId());
    }

    /**
     * 合并同一阵子里的多声「重读」。
     *
     * 收藏一首歌、换一项设置、补完封面都会想重读，宿主那边一次重读要跑一遍
     * getUserPlaylists + getLikedSongIds（1000 个 id）。合并成一次，别让它排队。
     */
    let wallTimer = 0;
    let wallRunning = false;
    let wallAgain = false;
    function scheduleWallRefresh(delay = 600) {
        if (disposed) return;
        if (wallTimer) clearTimeout(wallTimer);
        wallTimer = later(() => {
            wallTimer = 0;
            if (wallRunning) {
                wallAgain = true;
                return;
            }
            wallRunning = true;
            void refreshWall()
                .catch(() => {})
                .finally(() => {
                    wallRunning = false;
                    if (wallAgain) {
                        wallAgain = false;
                        scheduleWallRefresh(400);
                    }
                });
        }, delay);
    }

    // ------------------------------------------- 0.8.2：探索页 96 首之后按需续命
    // 宿主 useExploreWall 的 nu() 写死「e.nextCursor && t<96 && n<4」——一次 read
    // 最多自动续读 4 批 / 96 首；到顶之后书库墙按取模循环铺同一批 tile。
    // 模组改不了宿主 chunk，但能拿到同一张 explore store，在宿主停手后自己调
    // loadMore() 追加新 section：不重置滚动、不新增页签、不改卡片样式。
    //
    // **P0（0.8.2）**：0.8.1 用 600ms 定时轮询 + 「最近 4.5s 有过任意
    // wheel / scroll / touchmove / keydown」当「用户还在刷」的信号，而宿主
    // loadMore() 重排整面墙派发的 scroll 会反过来把这个时间戳续上，形成自激：
    // 随便动一下就唤醒，之后每 1.8s 整页重绘一次，停不下来。
    // 现在改成纯事件驱动，判定全在 lib/exploreContinuation.mjs 的纯函数里：
    // 唯一的「进度」是用户**向下滚动的累计像素**，不足 600px 一律不补。
    // 真机实测宿主探索墙是 `lattice-field{overflow:clip}` + `lattice-world
    // {transform:matrix(...)}` 的 transform 虚拟墙，滚轮时**不派发原生 scroll**、
    // scrollTop 恒为 0，所以 wheel 的 deltaY 是主要进度来源（也兼容真会滚的版本）。
    // wheel 只由真实输入产生，宿主重排不会派发它 —— 自激从根上断开。
    // 不再有定时器、不监听 keydown / click，也不设总批数上限。
    const EXPLORE_STALL_LIMIT = 3;
    const EXPLORE_SCROLL_SETTLE_MS = 90;
    const EXPLORE_INPUT_EVENTS = ['wheel', 'scroll', 'touchmove'];
    let exploreLastAppendAt = 0;
    /** 自上次补批以来累计的向下滚动像素；补批后清零，离开探索页也清零。 */
    let exploreAdvance = 0;
    /** 原生滚动路径下上一次看到的 scrollTop，用来只累计「前进」的部分。 */
    let exploreLastObservedTop = null;
    let exploreTouchY = null;
    /** 累计补了多少批，只给诊断现场看；**不做上限**。 */
    let exploreForcedCount = 0;
    let exploreLastCursor = null;
    let exploreStallCount = 0;
    let exploreLoading = false;
    let exploreWatchOn = false;
    let exploreWatchDoc = null;
    let exploreScrollQueued = false;
    let exploreLastReason = '';
    /** 最后一次真实滚动输入的时刻：补批要等它过去 SETTLE_MS，把重排挪到停下之后。 */
    let exploreLastInputAt = 0;
    /** 「停下来再补」的兜底定时器：滚动结束不会再有事件，得自己醒一次。 */
    let exploreSettleTimer = 0;

    function currentHomeTab() {
        try {
            return String(localStorage.getItem('last_home_view_tab') || '');
        } catch {
            return '';
        }
    }

    function exploreVisible() {
        const doc = typeof document !== 'undefined' ? document : null;
        if (!doc) return false;
        // 窗口不可见、或者盖着模态对话框时，任何滚动都不算「在刷探索页」。
        try {
            if (doc.visibilityState && doc.visibilityState !== 'visible') return false;
            if (doc.querySelector('[role="dialog"][aria-modal="true"], dialog[open]')) return false;
        } catch {
            /* 宿主版本变了就只按下面的页签判定 */
        }
        if (currentHomeTab() === 'explore') return true;
        try {
            return Boolean(doc.querySelector('[data-explore-surface]')
                || doc.querySelector('button[data-bravais-tab="explore"][aria-selected="true"]'));
        } catch {
            return false;
        }
    }

    /** 设置面板 / 搜索框 / 弹层里的滚动不算数。 */
    function blockedScrollTarget(target) {
        if (!target || typeof target.closest !== 'function') return false;
        try {
            return Boolean(target.closest(
                'input, textarea, [contenteditable="true"], [role="dialog"], [aria-modal="true"],'
                + ' [class*="settings"], [class*="search-"], [class*="modal"]'));
        } catch {
            return false;
        }
    }

    /** 原生 scroll 在 capture 阶段会经过 document；只取 scrollTop 的前进量。 */
    function scrollTopOf(event) {
        const raw = event && event.target;
        const doc = typeof document !== 'undefined' ? document : null;
        let el = raw;
        if (raw && raw.nodeType === 9) el = raw.scrollingElement || raw.documentElement;
        else if (typeof window !== 'undefined' && raw === window) el = doc && doc.scrollingElement;
        return el && typeof el.scrollTop === 'number' ? el.scrollTop : null;
    }

    function feedSnapshot(feed) {
        if (!feed) return null;
        const sections = Array.isArray(feed.sections) ? feed.sections : [];
        return {
            status: feed.status,
            loadingMore: Boolean(feed.loadingMore),
            refreshing: Boolean(feed.refreshing),
            moreFailed: Boolean(feed.moreFailed),
            nextCursor: feed.nextCursor,
            pages: Number(feed.pages) || 1,
            total: sections.reduce((sum, section) => sum
                + ((section && section.items && section.items.length) || 0), 0),
        };
    }

    /** 把一个真实输入事件折算成「向下滚动的距离」。宿主重排不会产生这些事件。 */
    function progressOf(event) {
        const type = event && event.type;
        if (type === 'wheel') {
            const vh = (typeof window !== 'undefined' && window.innerHeight) || 800;
            return wheelDeltaPx(event.deltaY, event.deltaMode, vh);
        }
        if (type === 'scroll') {
            const top = scrollTopOf(event);
            if (top == null) return 0;
            const delta = exploreLastObservedTop == null ? 0 : top - exploreLastObservedTop;
            exploreLastObservedTop = top;
            return delta > 0 ? Math.min(delta, MAX_STEP_PX) : 0;
        }
        if (type === 'touchmove') {
            const touch = event.touches && event.touches[0];
            if (!touch) return 0;
            const y = touch.clientY;
            const delta = exploreTouchY == null ? 0 : exploreTouchY - y;
            exploreTouchY = y;
            return delta > 0 ? Math.min(delta, MAX_STEP_PX) : 0;
        }
        return 0;
    }

    function onExploreProgress(event) {
        if (disposed || !exploreWatchOn) return;
        if (blockedScrollTarget(event && event.target)) return;
        // 任何真实滚动输入都记时间戳：补批要等手指离开再动手。
        exploreLastInputAt = Date.now();
        const gained = progressOf(event);
        // 向上滚、宿主重排自派的 scroll（scrollTop 恒 0）都是 0，直接不排队。
        if (!(gained > 0)) return;
        exploreAdvance += gained;
        if (exploreScrollQueued) return;
        exploreScrollQueued = true;
        const id = later(() => {
            exploreScrollQueued = false;
            appendIfNeeded();
        }, EXPLORE_SCROLL_SETTLE_MS);
        if (!id) exploreScrollQueued = false;
    }

    function appendIfNeeded() {
        if (disposed || !exploreWatchOn) return;
        const store = exploreStoreRef.value;
        if (!store) return;
        const active = isBiliActive();
        const visible = exploreVisible();
        if (!visible) {
            // 不在探索页（或盖着模态）：累计量作废，回来要重新滚。
            exploreAdvance = 0;
            exploreLastObservedTop = null;
            exploreTouchY = null;
            return;
        }
        let state = null;
        try {
            state = store.getState();
        } catch {
            return;
        }
        const now = Date.now();
        const verdict = canAppend({
            active,
            visible,
            blocked: false,
            inFlight: exploreLoading,
            feed: feedSnapshot(state && state.feed),
            now,
            lastAppendAt: exploreLastAppendAt,
            advance: exploreAdvance,
            sinceInput: exploreLastInputAt ? now - exploreLastInputAt : Infinity,
        });
        exploreLastReason = verdict.reason;
        if (!verdict.ok) {
            // 用户还在滑：推迟到手指离开。滚动一停就不再派发事件，得自己排一次重试，
            // 否则最后那 600px 永远等不到补批。只留一个定时器，不叠。
            if (verdict.reason === 'still-scrolling' && !exploreSettleTimer) {
                exploreSettleTimer = later(() => {
                    exploreSettleTimer = 0;
                    appendIfNeeded();
                }, SETTLE_MS + 40);
            }
            return;
        }

        // 万一宿主版本变了、loadMore 不再推进游标，连续几次没进展就安静放弃。
        const feed = state && state.feed;
        const cursor = feed && feed.nextCursor;
        if (exploreLastCursor === cursor) {
            exploreStallCount += 1;
            if (exploreStallCount >= EXPLORE_STALL_LIMIT) return;
        } else {
            exploreLastCursor = cursor;
            exploreStallCount = 0;
        }
        // 进度清零：必须再真往下滚一段才补下一批，狂滚也只按 QUIET_MS 限速。
        exploreAdvance = 0;
        exploreLoading = true;
        exploreLastAppendAt = Date.now();
        exploreForcedCount += 1;
        try {
            void Promise.resolve(state.loadMore())
                .catch(() => {})
                .finally(() => { exploreLoading = false; });
        } catch {
            exploreLoading = false;
        }
    }

    function startExploreWatch() {
        const doc = typeof document !== 'undefined' ? document : null;
        if (exploreWatchOn || !doc || typeof doc.addEventListener !== 'function') return;
        if (!exploreStoreRef.value) return;
        exploreWatchOn = true;
        exploreWatchDoc = doc;
        // 只有真实用户输入才产生这些事件；宿主重排不会派发 wheel / touchmove，
        // 自派 scroll 的 scrollTop 恒为 0 也贡献不了进度。没有定时器，没有 keydown。
        for (const name of EXPLORE_INPUT_EVENTS) {
            doc.addEventListener(name, onExploreProgress, { capture: true, passive: true });
        }
    }

    function stopExploreWatch() {
        exploreWatchOn = false;
        exploreScrollQueued = false;
        exploreAdvance = 0;
        exploreLastObservedTop = null;
        exploreTouchY = null;
        exploreLoading = false;
        exploreLastInputAt = 0;
        if (exploreSettleTimer) {
            clearTimeout(exploreSettleTimer);
            exploreSettleTimer = 0;
        }
        if (exploreWatchDoc && typeof exploreWatchDoc.removeEventListener === 'function') {
            for (const name of EXPLORE_INPUT_EVENTS) {
                try {
                    exploreWatchDoc.removeEventListener(name, onExploreProgress, { capture: true });
                } catch {
                    /* 已经撤下 */
                }
            }
        }
        exploreWatchDoc = null;
    }

    let attaching = false;
    async function attachToHost(attempt = 0) {
        if (hostRef.value || attaching) return;
        attaching = true;
        try {
            const host = await openHostLibrary({ log });
            if (!host) return;
            // openHostLibrary 要连着 import 十几个 chunk，这么长时间里完全可能已经被停用。
            // 那时 dispose() 已经把监听骨架拆掉了，再往下走会新挂一批永不释放的
            // wheel / scroll / touchmove 监听，用户每滚一下还在让宿主继续加载。
            if (disposed) return;
            const id = myProviderId();
            const provider = host.provider(id);
            if (!provider) {
                // 注册刚发生、宿主还没把它放进注册表：等一下再试。
                if (attempt < 6) {
                    hostRef.value = null;
                    attaching = false;
                    later(() => void attachToHost(attempt + 1), 350);
                    return;
                }
                log.warn('bili: 宿主里找不到本模组的音源', id);
                // 不静默：宿主启动慢一点、首帧还没把注册表建好时，书库墙会永久空白，
                // 用户只会以为「模组坏了」。给一条能自己动手的提示。
                toast(t('bilibili 还没接上。在命令面板跑一次「bilibili：重新接入」再试。',
                    'bilibili is not attached to the host library yet. Run “bilibili: reattach library” from the command palette to retry.'), 'warning');
                return;
            }
            const wired = attachLibrary(provider, {
                auth,
                library: { getUserPlaylists, getUserAlbums, getLikedSongIds },
                catalog: { getPlaylistTracks, getPlaylistDetail, getAlbumTracks, getAlbumDetail },
                mutations: { likeSong, updatePlaylistTracks, canAddToPlaylist },
                search: { searchAlbums, searchPlaylists },
                // 0.8.1：**不挂 recommendations**。宿主 canUseRadio 会因此为 false，
                // 键盘循环页签会跳过「推荐」；界面上那颗胶囊由 lib/homeTab.mjs 在
                // bilibili 是当前音源时藏掉，切到别的音源自动还原。
                // 「探索」页签：宿主原生歌曲卡 + 滚到底自动续读。
                // 能力位在 attachLibrary() 里一起打开，设置页「显示探索」才亮。
                explore: { getFeed: getExploreFeed, getSectionItems: getExploreSectionItems },
                // 只有三档是真实不同的：64K / 192K / FLAC。宿主默认还列一个 hires，
                // 但 bilibili 没有比 FLAC 更高的档，选它和选无损听到的是同一个流。
                playback: { audioQualityLevels: ['standard', 'high', 'lossless'] },
                mark: { letter: 'B', color: BILI_PINK },
            });
            if (!wired) {
                // 冻结 / 改形状时不静默：宁可让用户看到一句提示，也不要书库墙空白还查不出原因
                toast(t('bilibili 没能接上（宿主版本可能变了），搜索和播放还能用',
                    'bilibili could not attach to the host library; search and playback still work'), 'warning');
                log.warn('bili: attachLibrary 返回 false，宿主 provider 可能被冻结');
                return;
            }
            hostRef.value = host;
            exploreStoreRef.value = host.exploreStore || null;
            startExploreWatch();
            // 客户端日志不进宿主日志文件，真机排查把现场挂到 window 上给 CDP 读。
            // 尤其是「96 首后续命」：拿不到 exploreStore 时会静默退化成宿主自读 4 批。
            try {
                if (typeof window !== 'undefined') {
                    window.__bili081 = {
                        version: MOD_VERSION,
                        attached: true,
                        exploreStoreFound: Boolean(host.exploreStore),
                        caps: {
                            explore: Boolean(provider.capabilities && provider.capabilities.explore),
                            recommendations: Boolean(provider.capabilities && provider.capabilities.recommendations),
                        },
                        watch: () => {
                            let feed = null;
                            try {
                                const s = exploreStoreRef.value && exploreStoreRef.value.getState();
                                const f = s && s.feed;
                                if (f) feed = {
                                    status: f.status,
                                    pages: f.pages,
                                    read: f.read,
                                    sections: Array.isArray(f.sections) ? f.sections.length : 0,
                                    total: Array.isArray(f.sections)
                                        ? f.sections.reduce((n, x) => n + (((x && x.items) || []).length), 0)
                                        : 0,
                                    nextCursor: f.nextCursor,
                                    loadingMore: Boolean(f.loadingMore),
                                };
                            } catch { /* store 还没建好 */ }
                            return {
                                on: exploreWatchOn,
                                inFlight: exploreLoading,
                                reason: exploreLastReason,
                                forcedCount: exploreForcedCount,
                                stall: exploreStallCount,
                                lastCursor: exploreLastCursor,
                                lastAppendAt: exploreLastAppendAt,
                                advance: exploreAdvance,
                                biliActive: isBiliActive(),
                                homeTab: currentHomeTab(),
                                feed,
                            };
                        },
                    };
                    // 0.8.2 起的新名字；旧名保留，历史验证脚本继续能读。
                    window.__bili082 = window.__bili081;
                }
            } catch { /* 诊断现场不该影响功能 */ }
            covers = await loadCovers();
            await host.refreshAccount(id);
        } catch (error) {
            log.warn('bili: 接管宿主曲库失败', String(error && error.message));
        } finally {
            attaching = false;
        }
    }

    void attachToHost();

    // 0.7.6 及更早写进宿主缓存的歌词缺 words，播到那首歌会让整个窗口崩掉；
    // 启动后延迟一点补上（等宿主自己的 DB 连接先建好，避免抢锁）。
    later(repairLegacyLyricCache, 2500);

    // 「歌单 / 专辑」胶囊只在「当前语境确实是 bilibili」时叫「收藏 / 合集」。
    //
    // 书库墙把当前音源写在 localStorage.active_online_provider_id；0.7.26 新搜索页
    // 自己另有一排音源 tab（nav.search-sources），切它不会动这个键。以前拿书库墙的音源
    // 去改全页面文本，就出现「书库墙停在 bilibili、搜索页切到网易云，网易云的分类
    // 也叫合集 / 收藏」。现在按节点所在语境分别判定，读不到就一律不改。
    function isBiliActive() {
        try {
            if (typeof localStorage === 'undefined') return false;
            const stored = String(localStorage.getItem('active_online_provider_id') || '');
            return Boolean(stored) && stored === myProviderId();
        } catch {
            return false;
        }
    }

    const tabRelabel = createTabRelabel({
        document: typeof document !== 'undefined' ? document : null,
        isActive: createBiliTabPredicate({
            document: typeof document !== 'undefined' ? document : null,
            providerLabel: 'bilibili',
            providerId: myProviderId(),
            isWallActive: isBiliActive,
        }),
    });
    tabRelabel.start();

    // 0.8.1：「推荐」是宿主顶栏的全局胶囊，删不掉也关不了单个音源。
    // 只在 bilibili 是当前音源时把它藏起来；切到网易云 / QQ 音乐立刻还原。
    // 藏的正好是当前页签时，createHomeTabHider 会顺手点一下「收藏」，
    // 不把用户留在没有页签的空白页。
    const homeTabHider = createHomeTabHider({
        document: typeof document !== 'undefined' ? document : null,
        isActive: isBiliActive,
    });
    homeTabHider.start();

    // ------------------------------------------------------------------ 命令

    const openCommand = folium.registries.commands.register({
        id: 'open',
        label: { 'zh-CN': '打开 bilibili 收藏夹', en: 'Open bilibili favorites' },
        keywords: ['bilibili', 'b站', '收藏夹', 'fav', 'playlist'],
        run: async () => {
            folium.ui.navigate('home');
            await refreshWall();
            toast(t('收藏夹就在「收藏」页签里。', 'Your favorites are on the Favorites tab.'), 'success');
            return 'ok';
        },
    });

    const loginCommand = folium.registries.commands.register({
        id: 'login',
        label: { 'zh-CN': 'bilibili：扫码登录', en: 'bilibili: sign in with QR' },
        keywords: ['bilibili', 'b站', '登录', '扫码', '二维码', 'login', 'qr'],
        run: () => {
            folium.ui.navigate('home');
            // 登录界面是宿主的：点缝里的音源位和用户自己点完全一样。
            const toggle = typeof document !== 'undefined' ? document.querySelector('[data-bravais-account-toggle]') : null;
            if (!toggle) {
                toast(t('回到书库首页，点音源那里的扫码按钮登录。', 'Go to the library home and sign in from the source menu.'), 'info');
                return 'unavailable';
            }
            toggle.click();
            return 'ok';
        },
    });

    const logoutCommand = folium.registries.commands.register({
        id: 'logout',
        label: { 'zh-CN': 'bilibili：退出登录', en: 'bilibili: sign out' },
        keywords: ['bilibili', 'b站', '退出', '登出', 'logout'],
        run: async () => {
            await auth.logout();
            toast(t('已退出 bilibili 账号', 'Signed out of bilibili'), 'success');
            return 'signed-out';
        },
    });

    const refreshCommand = folium.registries.commands.register({
        id: 'refresh',
        label: { 'zh-CN': 'bilibili：刷新缓存', en: 'bilibili: refresh cache' },
        keywords: ['bilibili', 'b站', '缓存'],
        run: async () => {
            clearCaches();
            await rpc('clearCache');
            covers = await loadCovers();
            await refreshWall();
            toast(t('缓存清好了', 'Cache cleared'), 'success');
            return 'cleared';
        },
    });

    // 一启动就把 bilibili 挂进宿主那张表；拿不到 chunk 只记一条日志，别的功能不受影响。
    void installLyricSource().catch((error) => {
        log.warn('bili: 注册歌词源失败', String(error && error.message));
    });

    /** 接入失败后的手动重试：宿主启动顺序偶尔会比模组晚一步，不必为此重载整个模组。 */
    const reattachCommand = folium.registries.commands.register({
        id: 'reattach',
        label: { 'zh-CN': 'bilibili：重新接入', en: 'bilibili: reattach' },
        keywords: ['bilibili', 'b站', '曲库', '接入', '重试', 'library', 'attach', 'retry'],
        run: async () => {
            hostRef.value = null;
            attaching = false;
            await attachToHost();
            if (hostRef.value) {
                toast(t('接上了。', 'Attached.'), 'success');
                return 'ok';
            }
            toast(t('还是没接上。重启 Folia 再试一次。',
                'Still not attached; the host internals may have changed. Restart Folia and try again.'), 'warning');
            return 'unavailable';
        },
    });

    return () => {
        disposed = true;
        releaseDisposeGate();
        for (const id of timers) clearTimeout(id);
        timers.clear();
        try {
            if (typeof offPlaybackFailed === 'function') offPlaybackFailed();
        } catch {
            /* 已经撤下 */
        }
        offPlaybackFailed = null;
        try {
            handle.unregister();
        } catch {
            /* 已经撤下 */
        }
        openCommand.unregister();
        loginCommand.unregister();
        refreshCommand.unregister();
        logoutCommand.unregister();
        reattachCommand.unregister();
        lyricCache.clear();
        lyricInflight.clear();
        try {
            if (observer) observer.disconnect();
        } catch {
            /* 已经断了 */
        }
        observer = null;
        if (watchTimer) clearTimeout(watchTimer);
        watchTimer = 0;
        wallTimer = 0;
        coverFill = null;
        seasonSearchCache.clear();
        folderMatchCache.clear();
        inflightSeason.clear();
        inflightPages.clear();
        forceProxy.clear();
        failedAt.clear();
        tabRelabel.stop();
        homeTabHider.stop();
        stopExploreWatch();
        uninstallLyricSource();
        qualityCache.clear();
        unwatchSettings();
        section.unregister();
        meta.clear();
        siteCache.clear();
        folderCache.clear();
        qrKeys.clear();
        exploreFlights.clear();
        exploreStoreRef.value = null;
        hostRef.value = null;
    };
}

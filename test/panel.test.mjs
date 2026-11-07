// 界面那几处「借宿主的壳」：设置面板的折叠分组、把 bilibili 接成宿主歌词源表的最后一项、音质码率。
// 用 jsdom 跑，不碰网络——rpc 全是桩，宿主那张歌词源表用一个假的 chunk 顶替。

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import activate from '../client.mjs';
import * as host from './fixtures/dist/assets/useLyricSettingsStore-test.js';

// baseURI 得是 file://，客户端才能把 chunk 名拼成可 import 的 URL。
const PAGE = new URL('./fixtures/dist/index.html', import.meta.url).href;
const dom = new JSDOM('<!doctype html><html lang="zh-CN"><body></body></html>', { pretendToBeVisual: true, url: PAGE });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.Event = dom.window.Event;

const PROVIDER = 'folium.bili-fav-wall.bili';
const SONG_ID = 'BV1mUAzeWEkr';

const install = ({ song = null, settings = {}, signedIn = true, lyricsMissFirst = false, emptySubtitles = false, folders = null } = {}) => {
    const registered = { settings: [], commands: [] };
    const settingsValues = {
        pickerMode: 'hide',
        // 0.8.6：合集有自己的筛选方式位；空着就跟着收藏夹那份走。
        albumPickerMode: '',
        lyrics: 'match-then-cc',
        likedFolder: '',
        extraCollections: 'https://www.bilibili.com/medialist/detail/ml337285064',
        excludedFolders: '',
        excludedAlbums: '',
        visibleFolders: '',
        visibleAlbums: '',
        route: 'auto',
        rawTitle: false,
        maxMinutes: 0,
        ...settings,
    };
    const calls = { refreshed: 0, parsed: [], names: [], omniLyrics: 0, omniLyricsArgs: [], searched: [], omniSearch: [] };
    const rpcAnswers = {
        status: signedIn ? { loggedIn: true, mid: '1', uname: '测试账号' } : { loggedIn: false },
        folders: {
            mid: '1',
            owner: '',
            items: folders || [{ id: '1001', title: '默认收藏夹', count: 3, isDefault: true }],
        },
        extras: { items: [] },
        collected: { items: [] },
        clearCache: { ok: true },
        search: {
            items: [{ bvid: 'BV1other', title: 'また夏を追う（official）', author: 'ヨルシカ', durationMs: 254000, cover: '' }],
            total: 1,
            hasMore: false,
        },
        levels: { ids: [30216, 30232, 30280] },
        subtitles: emptySubtitles
            ? { lan: '', lanDoc: '', body: [] }
            : {
                lan: 'ai-zh',
                lanDoc: '中文（AI）',
                body: [
                    { from: 1, to: 2, content: '第一句' },
                    { from: 3, to: 4, content: '第二句' },
                ],
            },
        covers: { covers: {} },
        assets: { name: 'useLyricSettingsStore-test.js' },
    };

    const folium = {
        modId: 'bili-fav-wall',
        env: { context: 'main' },
        host: { folium: { major: 1, minor: 7 }, folia: '0.7.25' },
        log: { info() {}, warn() {}, error() {} },
        rpc: {
            call(name, payload) {
                calls.names.push(name);
                if (name === 'search') calls.searched.push(payload && payload.keyword);
                if (rpcAnswers[name] === undefined) throw new Error(`unstubbed rpc: ${name}`);
                return Promise.resolve(rpcAnswers[name]);
            },
        },
        omni: {
            listProviders: () => [
                { providerId: PROVIDER, origin: 'mod', supports: { search: true, resolve: true, lyrics: true } },
                { providerId: 'netease', origin: 'host', supports: { search: true, resolve: true, lyrics: true } },
            ],
            searchSongs: (query, options) => {
                calls.omniSearch.push({ query, options });
                return Promise.resolve({ items: [{ id: '1', ref: 'song-1', source: PROVIDER, title: 'また夏を追う', artist: 'ヨルシカ', durationMs: 254000, coverUrl: 'https://i0.hdslb.com/bfs/archive/cover.jpg' }] });
            },
            getLyrics: (song) => {
                calls.omniLyrics += 1;
                calls.omniLyricsArgs.push(song);
                if (typeof song?.ref !== 'string' || !song.ref.startsWith('song-')) {
                    return Promise.reject(new Error('invalid-arguments: pass a song DTO that came from the host'));
                }
                if (lyricsMissFirst && calls.omniLyrics === 1) return Promise.resolve(null);
                return Promise.resolve({
                    isPureMusic: false,
                    isWordByWord: false,
                    lines: [
                        { startTime: 1, fullText: '匹配到的第一句' },
                        { startTime: 2, fullText: '匹配到的第二句' },
                        { startTime: 3, fullText: '匹配到的第三句' },
                    ],
                });
            },
        },
        experimental: { 'omni.providers': { register: (definition) => { registered.provider = definition; return { unregister() {} }; } } },
        registries: {
            settingsSections: {
                register(definition) {
                    registered.settings.push(definition);
                    return {
                        id: definition.id,
                        unregister() {},
                        settings: {
                            get: () => settingsValues,
                            set: (patch) => Object.assign(settingsValues, patch || {}),
                            onChange: () => () => {},
                        },
                    };
                },
            },
            commands: { register: (definition) => { registered.commands.push(definition); return { unregister() {} }; } },
        },
        events: { on: () => () => {} },
        playback: {
            getState: () => ({ song, duration: song ? 254 : 0 }),
        },
        lyrics: {
            parse: (track) => {
                calls.parsed.push(track);
                return Promise.resolve({ lines: String(track.text || '').split('\n').filter(Boolean).map((line, index) => ({ text: line, startTime: index })) });
            },
            refresh: () => { calls.refreshed += 1; },
        },
        ui: { toast() {}, navigate() {}, openPlayerPanel() {} },
        storage: { get: () => Promise.resolve(null), set: () => Promise.resolve() },
    };

    return { folium, registered, calls, settingsValues };
};

const ctxOf = (extra = {}) => ({
    locale: 'zh-CN',
    getTheme: () => ({ isDaylight: true }),
    onChange: () => () => {},
    ...extra,
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const biliSong = { id: SONG_ID, title: 'また夏を追う', artist: 'ヨルシカ', source: PROVIDER };

test('设置面板：四组结构，内容默认展开、播放与高级折起来', async () => {
    const { folium, registered } = install();
    const dispose = activate(folium);
    const container = document.createElement('div');
    document.body.appendChild(container);
    registered.settings[0].settingsPanel(container, ctxOf({ settings: null }));

    const heads = [...container.querySelectorAll('.bf-group-head')];
    assert.equal(heads.length, 4, '0.8.4 起是账号 / 内容 / 播放与歌词 / 高级');
    assert.deepEqual(
        heads.map((head) => head.querySelector('.bf-group-name').textContent),
        ['账号', '内容', '播放与歌词', '高级'],
    );
    assert.deepEqual(heads.map((head) => head.getAttribute('data-open')), ['1', '1', '0', '0']);

    const boxes = [...container.querySelectorAll('.bf-group-body')];
    assert.deepEqual(boxes.map((box) => box.hidden), [false, false, true, true], '播放和高级默认折起来');

    // 折起来的组在标题右边给一句摘要，省得为了看一眼展开。
    const summary = heads[3].querySelector('.bf-group-summary').textContent;
    assert.match(summary, /不按时长过滤|跳过超/);
    assert.match(heads[2].querySelector('.bf-group-summary').textContent, /先匹配其他平台，再 CC 字幕/);
    // 0.8.6：筛选方式不再单占一行，画在各自的表里（收藏夹一张、合集一张）。
    const contentGroup = [...container.querySelectorAll('.bf-group')][1];
    assert.match(contentGroup.textContent, /勾掉的隐藏/);
    assert.match(contentGroup.textContent, /只显示勾选的/);

    // 展开之后，那组的内容才看得见。
    heads[2].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    const boxesAfter = [...container.querySelectorAll('.bf-group-body')];
    assert.equal(boxesAfter[2].hidden, false);
    assert.equal([...container.querySelectorAll('.bf-group-head')][2].getAttribute('data-open'), '1');
    // Cookie 那条永远不画。
    assert.equal(container.querySelector('[data-field="cookie"]'), null, '凭据那条不进面板');

    container.remove();
    dispose();
});

test('设置面板：说明默认只留一行，点「?」才展开全文', async () => {
    const { folium, registered } = install();
    const dispose = activate(folium);
    const container = document.createElement('div');
    document.body.appendChild(container);
    registered.settings[0].settingsPanel(container, ctxOf({ settings: null }));

    const row = container.querySelector('[data-field="route"]');
    assert.ok(row, '播放链路那一行在');
    assert.equal(row.querySelector('.bf-details'), null, '默认不展开');
    assert.equal(row.querySelector('.bf-desc').textContent.includes('自动换'), true, '常显的一行说明还在');

    const help = row.querySelector('.bf-help');
    help.click();
    const details = row.querySelector('.bf-details');
    assert.ok(details, '点一下展开全文');
    assert.match(details.textContent, /本机中转/);
    assert.equal(help.getAttribute('data-on'), '1');

    help.click();
    assert.equal(row.querySelector('.bf-details'), null, '再点一下收回');

    container.remove();
    dispose();
});

test('设置面板：没登录时不去问收藏夹，只给一句占位', async () => {
    const { folium, registered, calls } = install({ signedIn: false });
    const dispose = activate(folium);
    const container = document.createElement('div');
    document.body.appendChild(container);
    registered.settings[0].settingsPanel(container, ctxOf({ settings: null }));
    await tick();

    // 'folders' 在未登录时会回「需要先登录」，问它只会在控制台留一行没用的错误。
    assert.equal(calls.names.includes('folders'), false, '未登录不该请求 folders');
    const row = container.querySelector('[data-field="likedFolder"]');
    const select = row && row.querySelector('select');
    assert.ok(select, '喜欢收藏夹仍然是下拉');
    assert.equal(select.disabled, true);
    assert.match(row.textContent, /先登录才能选/);

    container.remove();
    dispose();
});

test('模组不再注册播放器页签，也不再有「歌词来源」命令', async () => {
    const { folium, registered } = install();
    const dispose = activate(folium);
    assert.equal(registered.commands.some((item) => item.id === 'lyrics'), false, '页签那套已经拆掉了');
    dispose();
});

test('歌词记忆：一次没匹配上不算结论，过了 60 秒会再试', async () => {
    const { folium, registered, calls } = install({ song: biliSong, lyricsMissFirst: true });
    const dispose = activate(folium);
    const provider = registered.provider;

    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
        // 第一次：匹配回空，退到 CC 字幕。
        const first = await provider.getLyrics(biliSong);
        assert.ok(first && first.main, '匹配不到也要有 CC 字幕兜底');
        const afterFirst = calls.omniLyrics;
        assert.equal(afterFirst, 1);

        // 一分钟内再要一次：两个来源都记着，不再打网络。
        await provider.getLyrics(biliSong);
        assert.equal(calls.omniLyrics, afterFirst, '一分钟内不该再问一次');

        // 过了 60 秒：「没匹配到」这条记忆过期，重新问，这次匹配上了。
        now += 61 * 1000;
        const third = await provider.getLyrics(biliSong);
        assert.equal(calls.omniLyrics, afterFirst + 1, '空结果只记 60 秒');
        assert.match(third.main.text, /匹配到的第一句/);
    } finally {
        Date.now = realNow;
    }

    dispose();
});

test('歌词源：把 bilibili 加进宿主那张表，页签交给宿主自己画', async () => {
    const { folium } = install({ song: biliSong });
    const dispose = activate(folium);
    await wait(120);

    assert.ok(host.y.some((item) => item && item.id === 'bili'), 'S 里多了一项 bilibili');
    assert.ok(host.b.includes('bili'), 'id 快照也补上了');

    // 宿主那张 id→元数据表是模块私有的，只能靠拦原型顶上；`T(id)` 和 `E(id)` 都得认。
    assert.equal(host.knows('bili'), true, 'T(id) 认得 bilibili，页签文字才不会回落成网易云');
    assert.equal(host.lookup('bili') && host.lookup('bili').labelKey, 'bilibili', 'E(id) 拿得到元数据');
    assert.equal(host.implOf('bili') && host.implOf('bili').labelKey, 'bilibili', '取词实现表也认得，否则选中就炸');

    assert.equal(host.knows('netease'), true, '别的源原样返回');
    assert.equal(host.lookup('netease') && host.lookup('netease').labelKey, 'lyricProvider.netease');
    assert.equal(host.implOf('netease') && host.implOf('netease').kind, 'netease', '别的源的实现没被污染');

    dispose();
    assert.equal(host.lookup('bili'), undefined, '卸载之后把 get 换回去');
    assert.equal(host.knows('bili'), false, 'has 也换回去了');
    assert.equal(host.implOf('bili'), undefined);
    assert.equal(host.y.some((item) => item && item.id === 'bili'), false, '数组里那一项也撤了');
    assert.equal(host.b.includes('bili'), false, 'id 快照也撤了');
});

test('歌词源：卸载之后还能再装回来（宿主热重载走的就是这条路）', async () => {
    const { folium } = install({ song: biliSong });

    const first = activate(folium);
    await wait(120);
    assert.equal(host.knows('bili'), true, '第一次装上了');
    first();
    assert.equal(host.knows('bili'), false, '卸载干净了');

    const second = activate(folium);
    await wait(120);
    assert.equal(host.knows('bili'), true, '重新激活之后又认得 bilibili 了');
    assert.ok(host.y.some((item) => item && item.id === 'bili'), '数组里又有了');
    assert.equal(host.lookup('bili').labelKey, 'bilibili', '标签没回落成网易云');
    second();
    assert.equal(host.knows('bili'), false, '第二次也卸载干净');
    assert.equal(host.y.some((item) => item && item.id === 'bili'), false);
});

test('歌词源：窗口里搜索走 omni，并补成宿主歌曲形状', async () => {
    const { folium, calls } = install({ song: biliSong });
    const dispose = activate(folium);
    await wait(120);

    const meta = host.lookup('bili');
    const items = await meta.search('また夏を追う', 8);

    assert.equal(calls.omniSearch.length, 1, '只问了一次');
    assert.equal(calls.omniSearch[0].query, 'また夏を追う');
    assert.equal(calls.omniSearch[0].options.providerId, PROVIDER, '限定在自己的 provider 上');
    assert.equal(calls.omniSearch[0].options.limit, 8);
    assert.ok(Array.isArray(items) && items.length === 1, '直接返回条目数组');

    // omni 交回来的是 title / artist(字符串)；窗口的 Lm、Es、rj 读的是 name / artists[] / album{}
    const song = items[0];
    assert.equal(song.id, '1', 'id 留着，选中之后取词要用');
    assert.equal(song.name, 'また夏を追う', '窗口读的是 name');
    assert.equal(song.title, 'また夏を追う', 'title 也留着');
    assert.deepEqual(song.artists, [{ id: '1#artist', name: 'ヨルシカ' }], 'artists 是 [{name}] 数组');
    assert.deepEqual(
        song.album,
        { id: 0, name: '', coverUrl: 'https://i0.hdslb.com/bfs/archive/cover.jpg' },
        'album 是对象，封面放在 album.coverUrl —— 宿主结果行和右侧预览都读这里',
    );
    assert.equal(song.coverUrl, 'https://i0.hdslb.com/bfs/archive/cover.jpg', '顶层 coverUrl 也留着');
    assert.equal(song.durationMs, 254000, '时长留着，打分函数要读');
    assert.equal(song.sourceRef.providerId, PROVIDER, 'sourceRef 留着，omni 靠它定位 provider');
    assert.equal(song.sourceRef.mediaId, '1');
    assert.equal(song.ref, 'song-1', '宿主 DTO 句柄不能丢，取词要用');
    assert.deepEqual(song.aliases, [], '别名别让 Lm 拿不到');

    dispose();
});

test('歌词源：选中一条之后只取 CC 字幕，不借第三方歌词', async () => {
    const { folium, calls } = install({ song: biliSong });
    const dispose = activate(folium);
    await wait(120);

    const items = await host.lookup('bili').search('また夏を追う', 8);
    const got = await host.lookup('bili').fetch(items[0]);

    assert.equal(calls.omniLyrics, 0, '完全没问 omni 取词，第三方歌词匹配不会掺进来');
    assert.ok(calls.names.includes('subtitles'), '只问了 CC 字幕');
    assert.deepEqual(got.lyrics.lines, [
        { startTime: 1, endTime: 2, fullText: '第一句', words: [] },
        { startTime: 3, endTime: 4, fullText: '第二句', words: [] },
    ], '给的就是字幕逐行内容（words 空数组是宿主歌词模型的硬要求）');
    assert.equal(
        got.lyrics.lines.some((line) => line.translation || line.romanization),
        false,
        '没有翻译/罗马音，不是网易云那套词',
    );
    assert.equal(got.lyrics.isWordByWord, false);
    assert.equal(got.isPureMusic, false);

    dispose();
});

test('歌词源：视频没有 CC 字幕时明确返回空，不拿第三方歌词冒充', async () => {
    const { folium, calls } = install({ song: biliSong, emptySubtitles: true });
    const dispose = activate(folium);
    await wait(120);

    const items = await host.lookup('bili').search('また夏を追う', 8);
    const got = await host.lookup('bili').fetch(items[0]);

    assert.equal(got, null, '告诉宿主这个视频没词');
    assert.equal(calls.omniLyrics, 0, '没有偷偷回落第三方');

    dispose();
});

test('音质面板：把宿主的「极高」换成这个视频实际的 192K', async () => {
    const { folium } = install({ song: biliSong });
    dom.window.location.hash = '#player';
    const dispose = activate(folium);

    const row = document.createElement('div');
    row.innerHTML = '<div>默认音质</div><button><span>极高</span></button>';
    document.body.appendChild(row);

    await wait(1400);
    assert.match(row.textContent, /192K/);
    assert.equal(row.textContent.includes('极高'), false, '通名换成实际码率');

    row.remove();
    dom.window.location.hash = '';
    dispose();
});

test('设置面板：两个实例的折叠状态互不影响', async () => {
    const { folium, registered } = install();
    const dispose = activate(folium);
    const one = document.createElement('div');
    const two = document.createElement('div');
    document.body.append(one, two);
    registered.settings[0].settingsPanel(one, ctxOf({ settings: null }));
    registered.settings[0].settingsPanel(two, ctxOf({ settings: null }));

    // 在第一个实例里展开「播放与歌词」
    const head = [...one.querySelectorAll('.bf-group-head')][2];
    head.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.equal([...one.querySelectorAll('.bf-group-head')][2].getAttribute('data-open'), '1');

    // 第二个实例还应该保持默认的折起状态（以前是模块级共享，会一起被改）
    assert.equal([...two.querySelectorAll('.bf-group-head')][2].getAttribute('data-open'), '0');

    one.remove();
    two.remove();
    dispose();
});

const checkRows = (picker) => [...picker.querySelectorAll('.bf-check-row')];
const clickEvent = () => new dom.window.MouseEvent('click', { bubbles: true });

test('收藏夹选择器：能搜、能按来源筛，勾一下写进黑名单', async () => {
    const folders = [
        { id: '1001', title: '默认收藏夹', count: 30, isDefault: true },
        { id: '2002', title: '日语歌', count: 120 },
        { id: '3003', title: '纯音乐', count: 5 },
    ];
    const { folium, registered, settingsValues } = install({ folders });
    const dispose = activate(folium);
    const container = document.createElement('div');
    document.body.appendChild(container);
    registered.settings[0].settingsPanel(container, ctxOf({ settings: null }));
    await tick();

    const picker = container.querySelector('[data-field="excludedFolders"]');
    assert.equal(checkRows(picker).length, 3, '三个收藏夹都列出来');

    const search = picker.querySelector('input[type="search"]');
    search.value = '日语';
    search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    assert.equal(checkRows(picker).length, 1, '搜索立刻过滤');
    assert.match(picker.textContent, /日语歌/);

    search.value = '没有这个';
    search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    assert.match(picker.textContent, /没有匹配的/);

    // 清空搜索，勾第二个（日语歌）→ 写进 excludedFolders
    search.value = '';
    search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    const row = checkRows(picker).find((node) => node.textContent.includes('日语歌'));
    const box = row.querySelector('input[type="checkbox"]');
    box.checked = true;
    box.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    assert.equal(settingsValues.excludedFolders.includes('fav:2002'), true);
    assert.match(picker.textContent, /隐藏 1 个/);

    // 「只看已勾选」只留刚勾的那条
    const only = [...picker.querySelectorAll('button')].find((node) => node.textContent.includes('只看已勾选'));
    only.click();
    assert.equal(checkRows(picker).length, 1);

    container.remove();
    dispose();
});

test('收藏夹选择器：勾选里留着已经不存在的夹子时，计数点出来并能一键清掉', async () => {
    const folders = [
        { id: '1001', title: '默认收藏夹', count: 30, isDefault: true },
        { id: '2002', title: '日语歌', count: 120 },
    ];
    const { folium, registered, settingsValues } = install({
        folders,
        settings: { excludedFolders: 'fav:2002\nfav:999999' },
    });
    const dispose = activate(folium);
    const container = document.createElement('div');
    document.body.appendChild(container);
    registered.settings[0].settingsPanel(container, ctxOf({ settings: null }));
    await tick();

    const picker = container.querySelector('[data-field="excludedFolders"]');
    assert.equal(checkRows(picker).length, 2, '失效的 id 不占列表行');
    assert.match(picker.textContent, /隐藏 2 个/);
    assert.match(picker.textContent, /其中 1 个已经不在了/);

    const drop = [...picker.querySelectorAll('button')].find((node) => node.textContent.includes('清掉失效的'));
    assert.ok(drop, '有失效项时才出现这个按钮');
    assert.notEqual(drop.style.display, 'none');
    drop.click();
    await tick();

    assert.equal(settingsValues.excludedFolders.includes('fav:999999'), false, '失效项被清掉');
    assert.equal(settingsValues.excludedFolders.includes('fav:2002'), true, '有效勾选留着');
    const after = container.querySelector('[data-field="excludedFolders"]');
    assert.match(after.textContent, /隐藏 1 个/);
    assert.doesNotMatch(after.textContent, /已经不在了/);

    container.remove();
    dispose();
});

test('收藏夹选择器：列表没读到东西时不把勾选当成失效（否则一点清理就清空黑名单）', async () => {
    const { folium, registered, settingsValues } = install({
        folders: [],
        settings: { excludedFolders: 'fav:1001\nfav:2002' },
    });
    const dispose = activate(folium);
    const container = document.createElement('div');
    document.body.appendChild(container);
    registered.settings[0].settingsPanel(container, ctxOf({ settings: null }));
    await tick();

    const picker = container.querySelector('[data-field="excludedFolders"]');
    assert.doesNotMatch(picker.textContent, /已经不在了/);
    const drop = [...picker.querySelectorAll('button')].find((node) => node.textContent.includes('清掉失效的'));
    assert.equal(drop.style.display, 'none', '列表空着时按钮不露出来');
    drop.click();
    assert.equal(settingsValues.excludedFolders, 'fav:1001\nfav:2002', '点了也不动设置');

    container.remove();
    dispose();
});

test('收藏夹选择器：点「只显示勾选的」后全选写 visibleFolders，空着时说明「先全部显示」', async () => {
    const folders = [
        { id: '1001', title: '默认收藏夹', count: 30, isDefault: true },
        { id: '2002', title: '日语歌', count: 120 },
    ];
    const { folium, registered, settingsValues } = install({ folders });
    const dispose = activate(folium);
    const container = document.createElement('div');
    document.body.appendChild(container);
    registered.settings[0].settingsPanel(container, ctxOf({ settings: null }));
    await tick();

    const pickerOf = (key) => container.querySelector(`[data-field="${key}"]`);
    const chipOf = (key, text) => [...pickerOf(key).querySelectorAll('button')]
        .find((node) => node.textContent === text);

    // 0.8.6：筛选方式是每张表自己的，点一下就写 pickerMode，不再有全局下拉。
    chipOf('excludedFolders', '只显示勾选的').click();
    assert.equal(settingsValues.pickerMode, 'allow');
    assert.equal(settingsValues.albumPickerMode, '', '改收藏夹不碰合集那份');

    assert.match(pickerOf('excludedFolders').textContent, /还没勾，先全部显示/);

    const selectAll = [...pickerOf('excludedFolders').querySelectorAll('button')]
        .find((node) => node.textContent.includes('全选'));
    selectAll.click();
    assert.equal(settingsValues.visibleFolders.includes('fav:1001'), true);
    assert.equal(settingsValues.visibleFolders.includes('fav:2002'), true);
    assert.equal(settingsValues.excludedFolders, '', '白名单不碰黑名单那份');

    const clear = [...pickerOf('excludedFolders').querySelectorAll('button')]
        .find((node) => node.textContent === '清空');
    clear.click();
    assert.equal(settingsValues.visibleFolders, '');

    container.remove();
    dispose();
});

test('0.8.6：收藏夹和合集的筛选方式分开，各自记各自的', async () => {
    const { folium, registered, settingsValues } = install();
    const dispose = activate(folium);
    const container = document.createElement('div');
    document.body.appendChild(container);
    registered.settings[0].settingsPanel(container, ctxOf({ settings: null }));
    await tick();

    const pickerOf = (key) => container.querySelector(`[data-field="${key}"]`);
    const chipOf = (key, text) => [...pickerOf(key).querySelectorAll('button')]
        .find((node) => node.textContent === text);

    // 默认两边都是「勾掉的隐藏」。
    assert.equal(chipOf('excludedFolders', '勾掉的隐藏').getAttribute('data-on'), '1');
    assert.equal(chipOf('excludedAlbums', '勾掉的隐藏').getAttribute('data-on'), '1');

    chipOf('excludedAlbums', '只显示勾选的').click();
    assert.equal(settingsValues.albumPickerMode, 'allow');
    assert.equal(settingsValues.pickerMode, 'hide', '合集切成白名单，收藏夹还是黑名单');
    assert.equal(chipOf('excludedFolders', '勾掉的隐藏').getAttribute('data-on'), '1');
    assert.equal(chipOf('excludedAlbums', '只显示勾选的').getAttribute('data-on'), '1');

    container.remove();
    dispose();
});

test('额外列表：粘贴一行就多一条，坏链接标红，移除写回设置', async () => {
    const { folium, registered, settingsValues } = install();
    const dispose = activate(folium);
    const container = document.createElement('div');
    document.body.appendChild(container);
    registered.settings[0].settingsPanel(container, ctxOf({ settings: null }));
    await tick();

    const extras = () => container.querySelector('[data-field="extraCollections"]');
    assert.equal(extras().querySelectorAll('.bf-ext-row').length, 1, '默认那条 ml337285064 显示成一行');

    const input = extras().querySelector('input[type="text"]');
    input.value = 'https://space.bilibili.com/357648464/lists/3466635?type=season';
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick();
    assert.match(settingsValues.extraCollections, /3466635/, '赛季链接被收进设置');
    assert.equal(extras().querySelectorAll('.bf-ext-row').length, 2, '列表里多一行');

    const bad = extras().querySelector('input[type="text"]');
    bad.value = '这不是链接';
    bad.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick();
    assert.match(extras().textContent, /看不懂/, '坏链接当场提示，不悄悄吞掉');
    assert.equal(extras().querySelectorAll('.bf-ext-row').length, 2, '坏链接不会写进设置');
    assert.equal(settingsValues.extraCollections.includes('这不是链接'), false);

    // 移除第一条
    const remove = extras().querySelector('.bf-ext-row .bf-btn');
    remove.click();
    await tick();
    assert.equal(settingsValues.extraCollections.includes('ml337285064'), false);

    container.remove();
    dispose();
});

test('额外列表：旧配置里认不出的那一行标红，可以手动移除', async () => {
    const { folium, registered, settingsValues } = install({
        settings: { extraCollections: 'https://www.bilibili.com/medialist/detail/ml337285064\n这一行是坏的' },
    });
    const dispose = activate(folium);
    const container = document.createElement('div');
    document.body.appendChild(container);
    registered.settings[0].settingsPanel(container, ctxOf({ settings: null }));
    await tick();

    const extras = () => container.querySelector('[data-field="extraCollections"]');
    assert.equal(extras().querySelectorAll('.bf-ext-row').length, 2);
    assert.equal(extras().querySelectorAll('.bf-ext-row.bf-ext-bad').length, 1, '坏的那行标红');

    const badRow = extras().querySelector('.bf-ext-row.bf-ext-bad');
    badRow.querySelector('.bf-btn').click();
    await tick();
    assert.equal(settingsValues.extraCollections.includes('这一行是坏的'), false);
    assert.equal(extras().querySelectorAll('.bf-ext-row.bf-ext-bad').length, 0);

    container.remove();
    dispose();
});

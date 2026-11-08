// 用假的 folium 对象跑一遍 client.mjs：验证 provider 四件套的输出形状与歌词兜底链路。
// 不模拟 DOM：宿主界面的注入在 Node 里整段跳过，只验证注册了什么。

import test from 'node:test';
import assert from 'node:assert/strict';

import activate from '../client.mjs';

const install = (overrides = {}) => {
    const calls = [];
    const registered = { providers: [], commands: [], homeTabs: [], settings: [], panelTabs: [] };
    const settingsValues = { lyrics: 'match-then-cc', route: 'auto', maxMinutes: 0, rawTitle: false, ...overrides.settings };
    const settingsListeners = [];
    const rpcAnswers = {
        search: { items: [{ bvid: 'BV1xx411c7mD', title: '【周杰伦】晴天', author: '周董', cover: '//i0.hdslb.com/a.jpg', durationMs: 269000 }], total: 1 },
        song: { bvid: 'BV1xx411c7mD', title: '【周杰伦】晴天', author: '周董', cover: 'https://i0.hdslb.com/a.jpg', durationMs: 269000, cid: 123 },
        audio: { url: 'https://upos-sz-mirror.bilivideo.com/a.m4s', via: 'direct', expiresAt: Date.now() + 1000 },
        subtitles: { lan: 'zh-CN', body: [{ from: 1, to: 2, content: '第一句' }] },
        status: { loggedIn: false, mid: '', uname: '' },
        folders: { items: [] },
        collected: { mid: '', loggedIn: false, items: [] },
        extras: { items: [] },
        covers: { covers: {} },
        fillCovers: { covers: {}, filled: 0 },
        folderItems: { items: [], hasMore: false, total: 0 },
        clearCache: { ok: true },
        ...overrides.rpc,
    };

    const folium = {
        modId: 'bili-fav',
        env: { context: 'main' },
        host: { folium: { major: 1, minor: 7 }, folia: '0.7.22' },
        log: { info() {}, warn() {}, error() {} },
        rpc: {
            call(name, payload) {
                calls.push([name, payload]);
                const answer = rpcAnswers[name];
                if (answer === undefined) throw new Error(`unstubbed rpc: ${name}`);
                return Promise.resolve(answer);
            },
        },
        omni: {
            listProviders: () => [
                { providerId: 'folium.bili-fav.bili', displayName: 'bilibili', shortName: 'bilibili', origin: 'mod', configured: true, supports: { search: true, resolve: true, lyrics: true, albums: false, artists: false } },
                { providerId: 'netease', displayName: '网易云', shortName: '网易云', origin: 'host', configured: true, supports: { search: true, resolve: true, lyrics: true, albums: true, artists: true } },
            ],
            searchSongs: () => {
                calls.push(['omni.searchSongs', null]);
                return Promise.resolve({
                    items: [{ id: '1', title: '晴天', artist: '周杰伦', album: '叶惠美', source: 'netease', ref: 'song-1', durationMs: 269000 }],
                    nextCursor: null,
                    total: 1,
                });
            },
            getLyrics: () => {
                calls.push(['omni.getLyrics', null]);
                return Promise.resolve({ isPureMusic: false, isWordByWord: false, lines: [{ startTime: 1, fullText: '第一句' }] });
            },
            resolveSongs: (keys) => Promise.resolve(keys.map((key) => ({ status: 'found', song: { id: key.id, title: '晴天', artist: '周杰伦', source: 'folium.bili-fav.bili', ref: `song-${key.id}` } }))),
        },
        experimental: {
            'omni.providers': {
                register(definition) {
                    registered.providers.push(definition);
                    return { id: `bili-fav:${definition.id}`, unregister() {} };
                },
            },
        },
        registries: {
            settingsSections: {
                register(definition) {
                    registered.settings.push(definition);
                    return {
                        id: definition.id,
                        unregister() {},
                        settings: {
                            get: () => settingsValues,
                            onChange(listener) {
                                settingsListeners.push(listener);
                                return () => {
                                    const index = settingsListeners.indexOf(listener);
                                    if (index >= 0) settingsListeners.splice(index, 1);
                                };
                            },
                        },
                    };
                },
            },
            homeTabs: {
                register(definition) {
                    registered.homeTabs.push(definition);
                    return { id: definition.id, unregister() {} };
                },
            },
            commands: {
                register(definition) {
                    registered.commands.push(definition);
                    return { id: definition.id, unregister() {} };
                },
            },
            playerPanelTabs: {
                register(definition) {
                    registered.panelTabs.push(definition);
                    return { id: definition.id, unregister() {} };
                },
            },
        },
        events: { on: () => () => {} },
        playback: { playSong: () => Promise.resolve(), enqueue: () => Promise.resolve() },
        ui: { toast() {}, openHomeTab() {}, navigate() {} },
        storage: { get: () => Promise.resolve(null), set: () => Promise.resolve() },
    };

    return {
        folium,
        calls,
        registered,
        setSettings(patch) {
            Object.assign(settingsValues, patch);
            settingsListeners.slice().forEach((listener) => listener());
        },
    };
};

test('activate 注册 provider / 设置分区 / 首页页面 / 命令', () => {
    const { folium, registered } = install();
    const dispose = activate(folium);
    assert.equal(registered.providers.length, 1);
    const provider = registered.providers[0];
    assert.equal(provider.id, 'bili');
    for (const method of ['search', 'getSong', 'getAudioUrl', 'getLyrics']) {
        assert.equal(typeof provider[method], 'function', method);
    }
    assert.equal(registered.settings.length, 1);
    const fields = registered.settings[0].settings;
    assert.equal(fields.length, 13);
    // 不再有 Navidrome 地址：收藏夹改成模组自己的整页。
    assert.equal(fields.some((field) => field.key === 'bridgeServer'), false);
    const rawTitle = fields.find((field) => field.key === 'rawTitle');
    assert.equal(rawTitle.type, 'boolean');
    assert.equal(rawTitle.defaultValue, false);
    // 凭证必须是 secret 字段：普通字段会把 SESSDATA 明文写进设置值，并且能被导出
    const secret = fields.find((field) => field.key === 'cookie');
    assert.equal(secret.type, 'secret');
    assert.equal(secret.defaultValue, undefined, 'secret 的 defaultValue 会被宿主忽略，别写');
    // 心形按钮用哪个收藏夹；白名单是 0.8.4 新增的存储位，不直接画在面板上。
    // 「画成什么」记在 ui 里，type 必须是宿主认的六种之一（否则模组卡片上报红字）。
    assert.equal(fields.find((field) => field.key === 'likedFolder').ui, 'folder-select');
    assert.equal(fields.find((field) => field.key === 'extraCollections').ui, 'extras');
    assert.equal(fields.find((field) => field.key === 'excludedFolders').ui, 'picker');
    assert.equal(fields.find((field) => field.key === 'excludedAlbums').ui, 'picker');
    assert.equal(fields.find((field) => field.key === 'visibleFolders').ui, 'hidden');
    assert.equal(fields.find((field) => field.key === 'visibleAlbums').ui, 'hidden');
    assert.equal(fields.find((field) => field.key === 'pickerMode').defaultValue, 'hide');
    // 0.8.6：收藏夹和合集的筛选方式各存一份；合集默认空着 = 跟收藏夹走。
    assert.equal(fields.find((field) => field.key === 'albumPickerMode').defaultValue, '');
    // 回归：0.8.4 初版把 picker / extras / folder-select 写进 type，
    // 宿主在模组卡片上直接报「settings xxx: type must be one of …」。
    const HOST_TYPES = ['number', 'text', 'boolean', 'select', 'color', 'secret'];
    for (const field of fields) {
        assert.ok(HOST_TYPES.includes(field.type), `${field.key}.type=${field.type} 不是宿主认的类型`);
    }
    // 自绘面板（设置里不再画 Cookie 输入框）
    assert.equal(typeof registered.settings[0].settingsPanel, 'function');
    // 0.8.4 起分成四组：账号 / 内容 / 播放与歌词 / 高级
    assert.deepEqual(
        fields.filter((field) => field.type !== 'secret').map((field) => [field.key, field.group]),
        [
            ['pickerMode', 'content'],
            ['albumPickerMode', 'content'],
            ['excludedFolders', 'content'],
            ['visibleFolders', 'content'],
            ['excludedAlbums', 'content'],
            ['visibleAlbums', 'content'],
            ['likedFolder', 'content'],
            ['extraCollections', 'content'],
            ['lyrics', 'playback'],
            ['route', 'playback'],
            ['rawTitle', 'advanced'],
            ['maxMinutes', 'advanced'],
        ],
    );
    // 注入版不注册页面：收藏夹画在宿主自己的歌单墙上。
    assert.equal(registered.homeTabs.length, 0);
    const open = registered.commands.find((command) => command.id === 'open');
    assert.ok(open, '缺少打开收藏夹的命令');
    assert.equal(registered.commands.some((command) => command.id === 'bridge'), false);
    // 宿主那个「登录到 bilibili」弹窗对 mod 音源永远是「无需登录」，所以模组自己得给一条能搜到的入口。
    const login = registered.commands.find((command) => command.id === 'login');
    assert.ok(login, '缺少扫码登录命令');
    assert.equal(typeof login.run, 'function');
    // 换歌词不再占用命令：页签直接塞进宿主自己的「匹配歌词」窗口，命令里一条都不留。
    const lyricCommands = registered.commands.filter((command) => String(command.id).startsWith('lyric'));
    assert.deepEqual(lyricCommands.map((command) => command.id), []);
    assert.equal(registered.commands.some((command) => command.id === 'lyric-cc'), false);
    assert.equal(registered.commands.some((command) => command.id === 'lyric-match'), false);
    assert.equal(registered.commands.some((command) => command.id === 'lyric-auto'), false);
    // 也不再自建播放器页签（实测用的是宿主那个窗口）。
    assert.equal(registered.panelTabs.length, 0);
    assert.equal(typeof dispose, 'function');
    dispose();
});

test('打开命令在没有宿主接管时也只是提示，不抛错', async () => {
    const bag = install();
    const toasts = [];
    bag.folium.ui.toast = (message) => toasts.push(message);
    activate(bag.folium);
    const result = await bag.registered.commands.find((command) => command.id === 'open').run();
    assert.equal(result, 'ok');
    assert.equal(toasts.length, 1);
});

test('登录命令在没有宿主界面时给提示而不是崩掉', () => {
    const bag = install();
    const toasts = [];
    bag.folium.ui.toast = (message) => toasts.push(message);
    activate(bag.folium);
    const result = bag.registered.commands.find((command) => command.id === 'login').run();
    assert.equal(result, 'unavailable');
    assert.equal(toasts.length, 1);
});

test('search 把 bilibili 标题拆成歌名与歌手，并给出 provider 形状', async () => {
    const { folium, registered, calls } = install();
    const dispose = activate(folium);
    const page = await registered.providers[0].search('晴天', { limit: 20, offset: 0 });
    assert.equal(calls[0][0], 'search');
    assert.equal(page.items.length, 1);
    // 0.9.1：搜索交付必须带 name / sourceRef（少了宿主按 DTO 过滤掉整批，搜索页永远空），
    // 但 artists 要留在字符串形态 —— 搜索页那一行把整条 artists 当 React child 渲染，
    // 元素是 {id,name} 对象会抛 React #31 白屏。
    const song = page.items[0];
    assert.equal(song.id, 'BV1xx411c7mD');
    assert.equal(song.name, '晴天', 'name 是宿主列表行直接读的字段');
    assert.equal(song.title, '晴天');
    assert.deepEqual(song.artists, ['周杰伦'], '搜索交付的 artists 必须是字符串');
    assert.equal(song.album, '');
    assert.equal(song.coverUrl, '//i0.hdslb.com/a.jpg');
    assert.equal(song.durationMs, 269000);
    assert.equal(song.sourceRef.kind, 'online');
    assert.equal(song.sourceRef.mediaId, 'BV1xx411c7mD');
    assert.match(song.sourceRef.providerId, /bili$/, 'providerId 指回自己');
    dispose();
});

test('@fav/<media_id> 走收藏夹分页', async () => {
    const { folium, registered, calls } = activate2();
    const page = await registered.providers[0].search('@fav/12345', { limit: 20, offset: 0 });
    assert.equal(calls[0][0], 'folderItems');
    assert.equal(calls[0][1].mediaId, '12345');
    assert.equal(page.items.length, 0);
});

const activate2 = () => {
    const bag = install({ rpc: { folderItems: { items: [], hasMore: false, total: 0 } } });
    activate(bag.folium);
    return bag;
};

test('getSong 复用缓存，getAudioUrl 透传音质与链路', async () => {
    const { folium, registered, calls } = install();
    activate(folium);
    const provider = registered.providers[0];
    await provider.search('晴天', { limit: 20, offset: 0 });
    const song = await provider.getSong('BV1xx411c7mD');
    assert.equal(song.title, '晴天');
    // 搜索交付是字符串 artists，但 getSong 给播放器的必须是完整 DTO（宿主读 artists[0].name）
    assert.deepEqual(song.artists, [{ id: 'BV1xx411c7mD#artist', name: '周杰伦' }]);
    assert.equal(song.album.id, 'BV1xx411c7mD#album');
    assert.ok(!calls.some(([name]) => name === 'song'), '缓存命中时不该再问一次');
    const audio = await provider.getAudioUrl(song, 'lossless');
    const call = calls.find(([name]) => name === 'audio');
    assert.equal(call[1].quality, 'lossless');
    assert.equal(call[1].route, 'auto');
    assert.match(audio.url, /^https:/);
});

test('默认先跨平台匹配歌词，命中就不去读 CC 字幕', async () => {
    const { folium, registered, calls } = install();
    activate(folium);
    const lyrics = await registered.providers[0].getLyrics({ id: 'BV1xx411c7mD', title: '晴天', artists: ['周杰伦'] });
    assert.ok(calls.some(([name]) => name === 'omni.searchSongs'), '应该去宿主平台匹配');
    assert.ok(!calls.some(([name]) => name === 'subtitles'), '匹配到就不该再读 CC');
    assert.equal(lyrics.main.format, 'lrc');
    assert.equal(lyrics.main.text, '[00:01.000]第一句');
});

test('匹配不到时再退回 CC 字幕', async () => {
    const { folium, registered, calls } = install({
        rpc: { subtitles: { lan: 'zh-CN', body: [{ from: 3, to: 4, content: '第二句' }] } },
    });
    folium.omni.searchSongs = () => Promise.resolve({ items: [], nextCursor: null, total: 0 });
    activate(folium);
    const lyrics = await registered.providers[0].getLyrics({ id: 'BV1xx411c7mD', title: '晴天', artists: ['周杰伦'] });
    assert.ok(calls.some(([name]) => name === 'subtitles'), '匹配空了要读 CC');
    assert.equal(lyrics.main.text, '[00:03.000]第二句');
});

test('选「CC 字幕 → 跨平台匹配」时顺序反过来', async () => {
    const { folium, registered, calls } = install({ settings: { lyrics: 'cc-then-match' } });
    activate(folium);
    const lyrics = await registered.providers[0].getLyrics({ id: 'BV1xx411c7mD', title: '晴天', artists: ['周杰伦'] });
    assert.ok(calls.some(([name]) => name === 'subtitles'));
    assert.ok(!calls.some(([name]) => name === 'omni.searchSongs'), 'CC 有词就不该再匹配');
    assert.equal(lyrics.main.text, '[00:01.000]第一句');
});

test('选「不要歌词」时不发任何请求', async () => {
    const { folium, registered, calls } = install({ settings: { lyrics: 'off' } });
    activate(folium);
    const lyrics = await registered.providers[0].getLyrics({ id: 'BV1xx411c7mD', title: '晴天', artists: ['周杰伦'] });
    assert.equal(lyrics, null);
    assert.equal(calls.length, 0);
});

test('「显示原始标题」打开后 provider 输出 UP 主原话，歌手仍然解析', async () => {
    const { folium, registered } = install({ settings: { rawTitle: true } });
    activate(folium);
    const page = await registered.providers[0].search('晴天', { limit: 20, offset: 0 });
    assert.equal(page.items[0].title, '【周杰伦】晴天');
    assert.deepEqual(page.items[0].artists, ['周杰伦'], '原始标题只改 title，歌手还是解析出来的');
});

test('开关切换后缓存失效，标题跟着变回来', async () => {
    const { folium, registered, setSettings } = install();
    activate(folium);
    const provider = registered.providers[0];
    const first = await provider.search('晴天', { limit: 20, offset: 0 });
    assert.equal(first.items[0].title, '晴天');
    setSettings({ rawTitle: true });
    const second = await provider.search('晴天', { limit: 20, offset: 0 });
    assert.equal(second.items[0].title, '【周杰伦】晴天');
});

test('歌词匹配：artists 是 {id,name} 对象时也能拼出正确的搜索词（0.9.1）', async () => {
    const { folium, registered } = install();
    const queries = [];
    folium.omni.searchSongs = (query) => {
        queries.push(query);
        return Promise.resolve({
            items: [{ id: '1', title: '晴天', artist: '周杰伦', album: '叶惠美', source: 'netease', ref: 'song-1', durationMs: 269000 }],
            nextCursor: null,
            total: 1,
        });
    };
    const dispose = activate(folium);
    // getSong()/播放队列交付的是完整 DTO，artists 是对象数组
    const lyrics = await registered.providers[0].getLyrics({
        id: 'BV1xx411c7mD',
        title: '晴天',
        artists: [{ id: 'BV1xx411c7mD#artist', name: '周杰伦' }],
    });
    assert.ok(lyrics && lyrics.main, '仍然要匹配到歌词');
    assert.equal(queries.length, 1);
    assert.equal(queries[0].includes('[object Object]'), false, '不能把对象拼进搜索词');
    assert.match(queries[0], /周杰伦/, '歌手要带上');
    dispose();
});

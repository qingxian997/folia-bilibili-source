// 宿主接管层的用例：能力位怎么补、找不到宿主时怎么安静地放弃。
// 真机上的探测（动态 import 宿主 chunk）不在这里跑，那需要浏览器环境。

import test from 'node:test';
import assert from 'node:assert/strict';

import { attachLibrary, canMutateOwnCollection, openHostLibrary, findExploreStore } from '../lib/hostlib.mjs';

test('没有 DOM（Node）时打开宿主库返回 null，不抛错', async () => {
    assert.equal(await openHostLibrary(), null);
});

test('0.8.1：按行为认出宿主探索页 store，认错的一律跳过', () => {
    const state = {
        show: () => {}, refresh: () => {}, loadMore: async () => {}, loadMoreOf: async () => {},
    };
    const store = { getState: () => state };
    const module = {
        randomStore: { getState: () => ({ play: () => {} }) },
        brokenStore: { getState: () => { throw new Error('not ready'); } },
        exploreStore: store,
        number: 42,
    };
    assert.equal(findExploreStore(module), store);
    assert.equal(findExploreStore({ randomStore: module.randomStore }), null);
    assert.equal(findExploreStore(null), null);
});

test('补齐能力位：auth / userLibrary / playlists 三个开关决定宿主画不画墙', () => {
    const provider = {
        id: 'folium.bili-fav-wall.bili',
        capabilities: { search: true, playback: true, lyrics: true, auth: false, userLibrary: false, playlists: false },
    };
    const auth = { getLoginStatus: async () => null, logout: async () => {} };
    const library = { getUserPlaylists: async () => ({ items: [], hasMore: false, nextOffset: 0 }) };
    const catalog = { getPlaylistTracks: async () => ({ items: [], hasMore: false, nextOffset: 0 }) };

    const ok = attachLibrary(provider, { auth, library, catalog, mark: { letter: 'B', color: '#FB7299' } });

    assert.equal(ok, true);
    assert.equal(provider.capabilities.auth, true, 'auth 是宿主判断「这个源有没有账号」的依据');
    assert.equal(provider.capabilities.userLibrary, true);
    assert.equal(provider.capabilities.playlists, true);
    // 原有能力不能被覆盖掉
    assert.equal(provider.capabilities.search, true);
    assert.equal(provider.auth, auth);
    assert.equal(provider.library, library);
    assert.equal(provider.catalog, catalog);
    assert.deepEqual(provider.mark, { letter: 'B', color: '#FB7299' });
});

test('provider 上没有 capabilities 时补一个，而不是崩掉', () => {
    const provider = { id: 'x' };
    attachLibrary(provider, { auth: {}, library: {}, catalog: {} });
    assert.equal(provider.capabilities.userLibrary, true);
    // 没给 mark 就不写 mark：宿主会退回「短名首字 + 中性色」
    assert.equal('mark' in provider, false);
    // 没给 mutations 就不开喜欢：心形按钮该是灰的
    assert.equal('likes' in provider.capabilities, false);
    assert.equal(provider.mutations, undefined);
});

test('给了 mutations 才打开心形按钮需要的两个能力位', () => {
    const provider = { id: 'x', capabilities: { lyrics: true } };
    const mutations = { likeSong: async () => {} };
    attachLibrary(provider, { auth: {}, library: {}, catalog: {}, mutations });
    // 宿主 canLikeSong() 要 mutations 和 likes 同时为真
    assert.equal(provider.capabilities.mutations, true);
    assert.equal(provider.capabilities.likes, true);
    assert.equal(provider.mutations, mutations);
    assert.equal(provider.capabilities.lyrics, true);
});

test('给了 getUserAlbums 才点亮「专辑」页签，且方法原样透传', () => {
    const provider = { id: 'x', capabilities: {} };
    const getUserAlbums = async () => ({ items: [], hasMore: false, nextOffset: 0 });
    const getAlbumTracks = async () => ({ items: [], hasMore: false, nextOffset: 0 });
    const getAlbumDetail = async () => null;
    attachLibrary(provider, {
        auth: {},
        library: { getUserAlbums },
        catalog: { getAlbumTracks, getAlbumDetail },
    });
    // 宿主 canUseAlbums = userLibrary && !!userAlbums
    assert.equal(provider.capabilities.userAlbums, true);
    assert.equal(provider.library.getUserAlbums, getUserAlbums);
    assert.equal(provider.catalog.getAlbumTracks, getAlbumTracks);
    assert.equal(provider.catalog.getAlbumDetail, getAlbumDetail);
});

test('没给 getUserAlbums 时不碰 userAlbums，别让空专辑页签冒出来', () => {
    const provider = { id: 'x', capabilities: {} };
    attachLibrary(provider, { auth: {}, library: {}, catalog: {} });
    assert.equal('userAlbums' in provider.capabilities, false);
});

test('0.7.26：给了 updatePlaylistTracks 才点亮速记簿「加进歌单」', () => {
    const provider = { id: 'x', capabilities: {} };
    const mutations = { likeSong: async () => {}, updatePlaylistTracks: async () => {} };
    attachLibrary(provider, { auth: {}, library: {}, catalog: {}, mutations });
    // 宿主 canAddSongToPlaylist() 要 mutations + playlistTrackMutations + updatePlaylistTracks 三者齐
    assert.equal(provider.capabilities.mutations, true);
    assert.equal(provider.capabilities.playlistTrackMutations, true);
    assert.equal(provider.mutations.updatePlaylistTracks, mutations.updatePlaylistTracks);
});

test('只有 likeSong 时不开 playlistTrackMutations，别让按钮亮着却点不动', () => {
    const provider = { id: 'x', capabilities: {} };
    attachLibrary(provider, { auth: {}, library: {}, catalog: {}, mutations: { likeSong: async () => {} } });
    assert.equal('playlistTrackMutations' in provider.capabilities, false);
});

test('0.7.26 搜索页：给了两个集合搜索函数才点亮 album / playlist 两类', () => {
    const searchSongs = async () => ({ items: [], hasMore: false, nextOffset: 0 });
    const searchAlbums = async () => ({ items: [], hasMore: false, nextOffset: 0 });
    const searchPlaylists = async () => ({ items: [], hasMore: false, nextOffset: 0 });
    const provider = { id: 'x', capabilities: { albums: false }, search: { searchSongs } };
    attachLibrary(provider, {
        auth: {}, library: {}, catalog: {},
        search: { searchAlbums, searchPlaylists },
    });
    // getProviderSearchKinds 要 capabilities.search + search.xxx + capabilities.albums / playlists
    assert.equal(provider.capabilities.search, true);
    assert.equal(provider.capabilities.albums, true);
    assert.equal(provider.capabilities.playlists, true);
    assert.equal(provider.search.searchSongs, searchSongs, '宿主原本的单曲搜索不能被覆盖');
    assert.equal(provider.search.searchAlbums, searchAlbums);
    assert.equal(provider.search.searchPlaylists, searchPlaylists);
});

test('没给集合搜索时不谎报 albums，宿主会自己把分类回落到「单曲」', () => {
    const provider = { id: 'x', capabilities: { albums: false }, search: { searchSongs: async () => ({}) } };
    attachLibrary(provider, { auth: {}, library: {}, catalog: {} });
    assert.equal(provider.capabilities.albums, false);
    assert.equal('searchAlbums' in provider.search, false);
});

test('速记簿只列自建收藏夹，别人的公开收藏夹是只读的', () => {
    assert.equal(canMutateOwnCollection({ id: '225458077', type: 'playlist' }), true);
    assert.equal(canMutateOwnCollection({ id: 'c-fav-3532801487', type: 'playlist' }), false);
    assert.equal(canMutateOwnCollection({ id: 'x-fav-337285064', type: 'playlist' }), false);
    assert.equal(canMutateOwnCollection({ id: '225458077', type: 'album' }), false);
    assert.equal(canMutateOwnCollection(null), false);
});

test('拿到的不是 provider 对象就什么都不做', () => {
    assert.equal(attachLibrary(null, { auth: {}, library: {}, catalog: {} }), false);
    assert.equal(attachLibrary('nope', { auth: {}, library: {}, catalog: {} }), false);
});

test('合集不能被当成可编辑曲目：补上 canEditPlaylistTracks 这一位', () => {
    const provider = { id: 'folium.bili-fav-wall.bili', capabilities: {} };
    const mutations = {
        likeSong: async () => {},
        updatePlaylistTracks: async () => ({ ok: true, count: 0 }),
        canAddToPlaylist: canMutateOwnCollection,
    };
    attachLibrary(provider, {
        auth: {},
        library: {},
        catalog: {},
        mutations,
    });

    // 宿主 canEditCollectionTracks 的逻辑是「有这一位且没返回 false」才算可编辑，
    // 不实现就默认 true —— 只读的合集会出现假的删改入口。
    assert.equal(typeof provider.mutations.canEditPlaylistTracks, 'function');
    assert.equal(provider.mutations.canEditPlaylistTracks({ type: 'playlist', id: '225458077' }), true);
    assert.equal(provider.mutations.canEditPlaylistTracks({ type: 'album', id: 'w-season-1-2' }), false);
    assert.equal(provider.mutations.canEditPlaylistTracks({ type: 'playlist', id: 'c-999' }), false);
});

test('音质档位按声明走：bilibili 只有三档真实不同（无损和 Hi-Res 是同一个 FLAC）', () => {
    const provider = { id: 'x', capabilities: {} };
    attachLibrary(provider, {
        auth: {},
        library: {},
        catalog: {},
        playback: { audioQualityLevels: ['standard', 'high', 'lossless'] },
    });
    assert.deepEqual(provider.playback.audioQualityLevels, ['standard', 'high', 'lossless']);

    // 没声明就不动它：宿主的默认四档还在，行为跟以前一致
    const plain = { id: 'y', capabilities: {} };
    attachLibrary(plain, { auth: {}, library: {}, catalog: {} });
    assert.equal(plain.playback, undefined);
});

test('0.8.0 推荐页：能力位和方法一起挂上，宿主 getHomeFeed 才取得到数', () => {
    const getRecommendedCollections = async () => [];
    const provider = { id: 'x', capabilities: {} };
    const ok = attachLibrary(provider, {
        auth: {}, library: {}, catalog: {},
        recommendations: { getRecommendedCollections },
    });
    assert.equal(ok, true);
    assert.equal(provider.capabilities.recommendations, true);
    assert.equal(provider.recommendations.getRecommendedCollections, getRecommendedCollections);
    // 「每日推荐」卡由 supportsDailySongs 控制：不实现就不画。
    assert.equal(provider.recommendations.getDailySongs, undefined);

    // 没给推荐实现时别谎报能力位：否则「推荐」页签能点却永远空白
    const plain = { id: 'y', capabilities: {} };
    attachLibrary(plain, { auth: {}, library: {}, catalog: {} });
    assert.equal(plain.capabilities.recommendations, undefined);
    assert.equal(plain.recommendations, undefined);
});

test('0.8.0 探索页：capabilities.explore 与两个取数方法必须同时挂上', () => {
    const getFeed = async () => ({ sections: [] });
    const getSectionItems = async () => ({ items: [] });
    const explore = { getFeed, getSectionItems };
    const provider = { id: 'x', capabilities: {} };
    const ok = attachLibrary(provider, {
        auth: {}, library: {}, catalog: {}, explore,
    });
    assert.equal(ok, true);
    assert.equal(provider.capabilities.explore, true, '设置页「显示探索」和 canUseExplore 都看这一位');
    assert.equal(provider.explore, explore);
    assert.equal(provider.explore.getFeed, getFeed);
    assert.equal(provider.explore.getSectionItems, getSectionItems);

    // 没给实现就别点亮页签，否则点进去永远空白
    const plain = { id: 'y', capabilities: {} };
    attachLibrary(plain, { auth: {}, library: {}, catalog: {} });
    assert.equal(plain.capabilities.explore, undefined);
    assert.equal(plain.explore, undefined);
});

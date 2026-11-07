// 0.8.1：推荐页签撤掉之后，只保留「我喜欢的音乐」特殊卡与旧卡开卡兜底。
// 回归 0.7.8：裸 song（缺 name / album.coverUrl）会让集合页整窗白屏。

import test from 'node:test';
import assert from 'node:assert/strict';
import * as recommend from '../lib/recommend.mjs';
import { videoToSong } from '../lib/collections.mjs';

const PROVIDER = 'folium.bili-fav-wall.bili';
const liked = { bvid: 'BV1aaaaaaaa', title: '第一首', author: 'UP甲', cover: 'https://i0.hdslb.com/a.jpg', durationMs: 200000 };

test('0.8.1 推荐层只剩「我喜欢的音乐」和旧卡兜底，不再有 8 张入口卡', () => {
    assert.deepEqual(Object.keys(recommend).sort(), [
        'LIKED_KEY', 'isLikedKey', 'likedCollection', 'parseRecoKey', 'recoTrackRaw',
    ].sort());
});

test('「我喜欢的音乐」是宿主 isLiked 特殊卡，且不再是「每日推荐」', () => {
    const card = recommend.likedCollection({ count: 42, cover: 'https://i0.hdslb.com/like.jpg' }, PROVIDER);
    assert.equal(card.id, recommend.LIKED_KEY);
    assert.equal(recommend.isLikedKey(recommend.LIKED_KEY), true);
    assert.equal(recommend.isLikedKey('daily_recommendations'), false);
    assert.equal(card.name, '我喜欢的音乐');
    assert.equal(card.isLiked, true, '宿主 BravaisHome.Te() 靠 raw.isLiked 画特殊卡和竖排快捷入口');
    assert.equal(card.type, 'playlist');
    assert.equal(card.trackCount, 42);
    assert.equal(card.coverUrl, 'https://i0.hdslb.com/like.jpg');
    // 没登录 / 没指定红心夹时也能安全退化成 0 首，不抛
    assert.equal(recommend.likedCollection(null, PROVIDER).trackCount, 0);
});

test('旧推荐卡的 key 自带 bvid，且不会和收藏夹 / 合集的键撞', () => {
    assert.equal(recommend.parseRecoKey('w-reco-BV1aaaaaaaa'), 'BV1aaaaaaaa');
    assert.equal(recommend.parseRecoKey('season:22331844:7422068'), null);
    assert.equal(recommend.parseRecoKey('w-liked'), null);
    assert.equal(recommend.parseRecoKey('w-season-1-2'), null);
    assert.equal(recommend.parseRecoKey('fav:7422068'), null);
    assert.equal(recommend.parseRecoKey(null), null);
});

test('换批之后旧卡仍可取曲：优先累积缓存，否则用卡片元数据兜底', () => {
    assert.equal(recommend.recoTrackRaw('BV1aaaaaaaa', liked, null), liked);
    const card = { name: '旧卡标题', coverUrl: 'https://i0.hdslb.com/old.jpg', creator: { nickname: '旧UP' } };
    const fallback = recommend.recoTrackRaw('BV9zzzzzzzz', null, card);
    assert.deepEqual(fallback, {
        bvid: 'BV9zzzzzzzz', title: '旧卡标题', author: '旧UP',
        cover: 'https://i0.hdslb.com/old.jpg', durationMs: 0,
    });
    assert.ok(videoToSong(recommend.recoTrackRaw('BV9zzzzzzzz', null, null), { providerId: PROVIDER }));
});

test('推荐曲目必须用完整 DTO：name / album.coverUrl / sourceRef 一个都不能少', () => {
    // 0.7.8 白屏的直接原因：宿主不做标准化，墙的文本排版读 song.name，
    // 读到 undefined 就抛 TypeError 卸载整棵 React 树。
    const song = videoToSong(liked, { providerId: PROVIDER });
    assert.equal(song.name, '第一首');
    assert.equal(song.title, '第一首');
    assert.equal(song.album.coverUrl, 'https://i0.hdslb.com/a.jpg');
    assert.equal(song.artists[0].name, 'UP甲');
    assert.deepEqual(song.sourceRef, { kind: 'online', providerId: PROVIDER, mediaId: 'BV1aaaaaaaa' });
});

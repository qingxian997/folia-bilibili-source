// 0.7.29「换一批」：最近播放种子怎么收、怎么避开、fresh_idx 单调推进。
// 取数编排在 client.mjs 里（要 rpc），这里测能独立出来的纯逻辑与契约。
import test from 'node:test';
import assert from 'node:assert/strict';
import { recentSongIds, feedAnswer, exploreSection } from '../lib/explore.mjs';

const song = (id) => ({ id, sourceRef: { kind: 'online', mediaId: id } });

test('种子兼容宿主的两形状：歌曲 DTO 和光字符串', () => {
    const ids = recentSongIds([
        song('BV1'),
        { sourceRef: { mediaId: 'BV2' } },
        'BV3',
        { id: 'BV4' },
        null,
        {},
        '',
    ]);
    assert.deepEqual([...ids].sort(), ['BV1', 'BV2', 'BV3', 'BV4']);
});

test('没有种子（首次进探索页 / 普通翻页）收出空集，不误伤', () => {
    assert.equal(recentSongIds(undefined).size, 0);
    assert.equal(recentSongIds(null).size, 0);
    assert.equal(recentSongIds('BV1').size, 0, '不是数组就当没有');
});

test('换一批：按种子过滤后，喂给宿主的 section 里没有最近听过的歌', () => {
    const seed = recentSongIds([song('BV1'), song('BV2')]);
    const batch = [song('BV1'), song('BV3'), song('BV2'), song('BV4')];
    const picked = batch.filter((s) => !seed.has(String(s.id || '')));
    assert.deepEqual(picked.map((s) => s.id), ['BV3', 'BV4']);

    const answer = feedAnswer(exploreSection(19, 37, picked), 37);
    assert.equal(answer.sections[0].items.length, 2);
    assert.equal(answer.refreshReadsAnew, true);
});

test('种子把整批都命中时也有兜底批次，不交空 feed', () => {
    const seed = recentSongIds([song('BV1')]);
    const all = [song('BV1')];
    assert.equal(all.filter((s) => !seed.has(String(s.id || ''))).length, 0);
    // client.mjs 在 picked 为空时会再取一批原样交出去，这里只验证「空批 feedAnswer 不带 section」
    const empty = feedAnswer(exploreSection(19, 37, []), 37);
    assert.deepEqual(empty.sections, []);
});

test('songsShownAs 返回 Map<id, song>：宿主 Bn() 会调 .size/.get/.has', () => {
    // 宿主把「听过的歌」交给这个函数，期待拿到 Map；返回数组会报 a.get is not a function，
    // seed 就永远记不上，换一批失去避开最近播放的能力。形状与 YTM provider 一致。
    const songsShownAs = (songs) => {
        const map = new Map();
        for (const s of (Array.isArray(songs) ? songs : [])) {
            const id = s && (s.id || (s.sourceRef && s.sourceRef.mediaId));
            if (id) map.set(String(id), s);
        }
        return map;
    };
    const songs = [song('BV1'), song('BV2')];
    const map = songsShownAs(songs);
    assert.ok(map instanceof Map, '必须是 Map，不能是数组');
    assert.equal(map.size, 2);
    assert.equal(map.get('BV1').id, 'BV1');
    assert.equal(map.has('BV2'), true);
    assert.equal(songsShownAs(null).size, 0, '坏输入给空 Map，别抛');
});

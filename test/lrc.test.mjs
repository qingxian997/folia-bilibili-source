import test from 'node:test';
import assert from 'node:assert/strict';

import { subtitleToLines, subtitleToLrc, omniLyricsToTracks, fillMissingWords, stamp, formatDuration } from '../lib/lrc.mjs';

test('时间戳格式与宿主一致（[mm:ss.xxx]）', () => {
    assert.equal(stamp(0), '[00:00.000]');
    assert.equal(stamp(63.5), '[01:03.500]');
    assert.equal(stamp(3723.25), '[62:03.250]');
});

test('CC 字幕转 LRC：排序、丢空行、压掉换行', () => {
    const body = [
        { from: 3.2, to: 5, content: '第二句' },
        { from: 0.5, to: 3, content: '第一句\n换行压平' },
        { from: 6, to: 7, content: '   ' },
    ];
    assert.equal(subtitleToLrc(body), '[00:00.500]第一句 换行压平\n[00:03.200]第二句');
});

test('CC 字幕转宿主歌词行：秒、排序、压平换行、带 words 空数组', () => {
    const body = [
        { from: 3.2, to: 5, content: '第二句' },
        { from: 0.5, to: 3, content: '第一句\n换行压平' },
        { from: 6, to: 7, content: '   ' },
    ];
    assert.deepEqual(subtitleToLines(body), [
        { startTime: 0.5, endTime: 3, fullText: '第一句 换行压平', words: [] },
        { startTime: 3.2, endTime: 5, fullText: '第二句', words: [] },
    ]);
    assert.deepEqual(subtitleToLines(null), []);
    assert.deepEqual(subtitleToLines({ body: [] }), []);
});

test('宿主歌词模型要求每行都有 words，缺了会整窗崩溃', () => {
    // monetLyricsModel 的 G(line) 第一句就是 line.words.length，
    // 键不在 -> TypeError -> React 整树卸载。这条断言守住这个契约。
    const lines = subtitleToLines([{ from: 0, to: 1, content: '一句' }]);
    assert.equal(Array.isArray(lines[0].words), true);
    assert.equal(lines[0].words.length, 0);
});

test('缺 to 或 to 不晚于 from 的行会补齐时间区间', () => {
    const lines = subtitleToLines([
        { from: 0, content: '没有 to' },
        { from: 2, to: 2, content: '时长为零' },
        { from: 4, to: 6, content: '正常' },
    ]);
    assert.equal(lines[0].endTime, 2);
    assert.ok(lines[1].endTime > 2);
    assert.equal(lines[2].endTime, 6);
    // 末行缺 to 时给 3 秒，不能是 undefined
    const last = subtitleToLines([{ from: 10, content: '末行' }]);
    assert.equal(last[0].endTime, 13);
});

test('补齐旧歌词缓存里缺 words 的行，且是幂等的', () => {
    const lines = [
        { startTime: 0, endTime: 1, fullText: 'a' },
        { startTime: 2, endTime: 3, fullText: 'b', words: [] },
    ];
    assert.equal(fillMissingWords(lines), 1, '只补真正缺的那一行');
    assert.deepEqual(lines[0].words, []);
    assert.equal(fillMissingWords(lines), 0, '再跑一次不该改任何东西');
    assert.equal(fillMissingWords(null), 0);
    assert.equal(fillMissingWords([null, 3]), 0, '脏数据不抛');
});

test('不是数组时给空字符串，不抛', () => {
    assert.equal(subtitleToLrc(null), '');
    assert.equal(subtitleToLrc({ body: [] }), '');
});

test('omni 歌词转两条轨道，翻译与罗马音各自成行', () => {
    const lyrics = {
        isPureMusic: false,
        isWordByWord: true,
        lines: [
            { startTime: 1, endTime: 3, fullText: 'hello', translation: '你好', words: [{ startTime: 1, text: 'he' }, { startTime: 1.5, text: 'llo' }] },
            { startTime: 3.5, endTime: 5, fullText: 'world', romanization: 'wa-rudo', words: [{ startTime: 3.5, text: 'world' }] },
        ],
    };
    const tracks = omniLyricsToTracks(lyrics);
    assert.equal(tracks.main.format, 'lrc');
    assert.equal(tracks.main.text, '[00:01.000]hello\n[00:03.500]world');
    assert.equal(tracks.main.translationText, '[00:01.000]你好');
    assert.equal(tracks.main.romanizationText, '[00:03.500]wa-rudo');
    assert.equal(tracks.wordByWord.format, 'enhanced-lrc');
    assert.equal(tracks.wordByWord.text, '[00:01.000]<00:01.000>he<00:01.500>llo<00:03.000>\n[00:03.500]<00:03.500>world<00:05.000>');
});

test('没有逐字信息时不给 wordByWord 轨道', () => {
    const tracks = omniLyricsToTracks({ isPureMusic: false, isWordByWord: false, lines: [{ startTime: 0, fullText: 'x' }] });
    assert.equal(tracks.wordByWord, undefined);
});

test('空歌词返回 null', () => {
    assert.equal(omniLyricsToTracks(null), null);
    assert.equal(omniLyricsToTracks({ lines: [] }), null);
});

test('时长显示', () => {
    assert.equal(formatDuration(273000), '04:33');
    assert.equal(formatDuration(0), '00:00');
    assert.equal(formatDuration(NaN), '00:00');
});

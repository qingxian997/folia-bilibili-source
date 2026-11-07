import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFavInput } from '../lib/link.mjs';

test('收藏夹链接里的 fid 就是 media_id', () => {
    const got = parseFavInput('https://space.bilibili.com/2267573/favlist?fid=63692673&ftype=create');
    assert.deepEqual(got, { mid: '2267573', mediaId: '63692673' });
});

test('没带 fid 的空间链接只认到人', () => {
    assert.deepEqual(parseFavInput('https://space.bilibili.com/2267573'), { mid: '2267573', mediaId: '' });
    assert.deepEqual(parseFavInput('space.bilibili.com/2/favlist'), { mid: '2', mediaId: '' });
});

test('medialist 详情页直接拿到 media_id', () => {
    assert.deepEqual(parseFavInput('https://www.bilibili.com/medialist/detail/ml63692673?spm=333'), {
        mid: '',
        mediaId: '63692673',
    });
    assert.deepEqual(parseFavInput('https://www.bilibili.com/list/ml1866229573'), { mid: '', mediaId: '1866229573' });
});

test('@fav/ 前缀与纯数字', () => {
    assert.deepEqual(parseFavInput('@fav/63692673'), { mid: '', mediaId: '63692673' });
    assert.deepEqual(parseFavInput('  2267573 '), { mid: '2267573', mediaId: '' });
});

test('不是收藏夹的输入不会瞎猜', () => {
    assert.equal(parseFavInput(''), null);
    assert.equal(parseFavInput('周杰伦'), null);
    assert.equal(parseFavInput('https://www.bilibili.com/video/BV1xx411c7mD'), null);
    assert.equal(parseFavInput('2267573abc'), null);
});


import test from 'node:test';
import assert from 'node:assert/strict';

import { parseVideoTitle, normalizeForMatch, parseDurationText } from '../lib/title.mjs';

const cases = [
    {
        name: '括号歌手 + 纯歌名',
        raw: '【初音ミク】千本桜',
        upper: 'みく',
        title: '千本桜',
        artist: '初音ミク',
    },
    {
        name: '画质包装词被丢掉，歌手在斜杠后面',
        raw: '【4K修复】夜に駆ける / YOASOBI',
        upper: 'Ayase',
        title: '夜に駆ける',
        artist: 'YOASOBI',
    },
    {
        name: '半角方括号 MV 标记',
        raw: '[MV] 晴天 - 周杰伦',
        upper: '',
        title: '晴天',
        artist: '周杰伦',
    },
    {
        name: '书名号拿走歌名，剩下的分段是歌手',
        raw: '《晴天》- 周杰伦',
        upper: '',
        title: '晴天',
        artist: '周杰伦',
    },
    {
        name: 'UP 主名字出现在分段里',
        raw: '晴天 - 周杰伦',
        upper: '周杰伦',
        title: '晴天',
        artist: '周杰伦',
    },
    {
        name: '没有元数据时退回 UP 主',
        raw: '随便录的一段',
        upper: '某某UP',
        title: '随便录的一段',
        artist: '某某UP',
    },
    {
        name: '歌名 / 歌手，歌手后面挂着画质尾巴',
        raw: 'Lemon / 米津玄師 4K修复 MV',
        upper: '搬运工',
        title: 'Lemon',
        artist: '米津玄師',
    },
    {
        name: '中日字幕这类组合包装词',
        raw: '【中日字幕】Lemon',
        upper: '',
        title: 'Lemon',
        artist: '',
    },
    // 下面几条是真实搜索结果的标题（2026-11 抓的），用来钉住规则别退化。
    {
        name: '真实：数学粗体包裹 + 书名号 + 尾巴注释',
        raw: '【𝐇𝐢-𝐑𝐞𝐬无损音质】｜《晴天》- 周杰伦 -‘故事的小黄花’',
        upper: 'VV音乐局',
        title: '晴天',
        artist: '周杰伦',
    },
    {
        name: '真实：画质 + 粘连的 MV/修复版尾巴',
        raw: '【4K修复】周杰伦 - 晴天MV 2160P修复版',
        upper: 'zyl2012_音乐无限',
        title: '晴天',
        artist: '周杰伦',
    },
    {
        name: '真实：书名号夹在破折号中间',
        raw: '周杰伦——《晴天》',
        upper: '如歌如梦',
        title: '晴天',
        artist: '周杰伦',
    },
    {
        name: '真实：中文之间的连字符当分隔',
        raw: '【4K Hi-Res】晴天-周杰伦',
        upper: '如歌如梦',
        title: '晴天',
        artist: '周杰伦',
    },
    {
        name: '真实：书名号 + Hi-Res 无损音乐尾巴',
        raw: '《晴天》- 周杰伦 Hi-Res 无损音乐',
        upper: '电台情歌FM',
        title: '晴天',
        artist: '周杰伦',
    },
];

for (const item of cases) {
    test(`标题解析：${item.name}`, () => {
        const parsed = parseVideoTitle(item.raw, item.upper);
        assert.equal(parsed.title, item.title);
        assert.equal(parsed.artist, item.artist);
    });
}

test('翻唱 / 纯音乐 / 现场标记会被识别', () => {
    assert.equal(parseVideoTitle('【翻唱】千本桜').flags.cover, true);
    assert.equal(parseVideoTitle('千本桜 伴奏').flags.instrumental, true);
    assert.equal(parseVideoTitle('千本桜 Live ver.').flags.live, true);
    assert.equal(parseVideoTitle('千本桜').flags.cover, false);
});

test('比对用的归一化去掉括号、标点与大小写', () => {
    assert.equal(normalizeForMatch('【初音ミク】千本桜 (4K)'), normalizeForMatch('千本桜'));
    assert.equal(normalizeForMatch('Lemon / 米津玄師'), normalizeForMatch('lemon米津玄師'));
});

test('时长文本解析', () => {
    assert.equal(parseDurationText('4:33'), 273000);
    assert.equal(parseDurationText('1:02:03'), 3723000);
    assert.equal(parseDurationText(273), 273000);
    assert.equal(parseDurationText(''), 0);
});

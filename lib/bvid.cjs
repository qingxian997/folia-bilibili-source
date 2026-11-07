// mods/bili-fav/lib/bvid.cjs
// BV 号 ⇄ av 号。
//
// 为什么需要：Subsonic 的歌曲 id 会被 Folia 抠成数字
// （navidromeService.toNavidromeSong 里 `parseInt(song.id.replace(/\D/g, ''))`），
// 所以交给宿主的 id 必须是纯数字的 av 号，不能是 BV 号。
// 收藏夹接口一般直接给 `id`（就是 av 号），缺了的时候用这个换算，不发额外请求。
//
// 算法与 bilibili 前端一致：BV1 + 9 位 base58，先按固定位置交换两位，再去掉前缀解码，
// 与 XOR_CODE 异或后取低 51 位。

'use strict';

const XOR_CODE = 23442827791579n;
const MASK_CODE = (1n << 51n) - 1n;
const BASE = 58n;
const ALPHABET = 'FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf';

function bvToAv(bvid) {
    const text = String(bvid || '');
    if (!/^BV1[0-9A-Za-z]{9}$/.test(text)) return 0;
    const chars = text.split('');
    [chars[3], chars[9]] = [chars[9], chars[3]];
    [chars[4], chars[7]] = [chars[7], chars[4]];
    let value = 0n;
    for (let index = 3; index < 12; index += 1) {
        const digit = ALPHABET.indexOf(chars[index]);
        if (digit < 0) return 0;
        value = value * BASE + BigInt(digit);
    }
    return Number((value & MASK_CODE) ^ XOR_CODE);
}

module.exports = { bvToAv };

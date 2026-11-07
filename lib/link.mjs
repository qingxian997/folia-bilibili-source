// mods/bili-fav/lib/link.mjs
// 把用户粘进输入框的东西认成「某个人的收藏夹列表」或「某一个收藏夹」。
//
// 认得：
//   https://space.bilibili.com/2267573/favlist?fid=63692673&ftype=create
//   https://www.bilibili.com/medialist/detail/ml63692673
//   @fav/63692673
//   2267573（纯数字按 UID 处理；media_id 请用链接或 @fav/ 前缀，因为两者都是数字，没法自动分辨）

const SPACE_URL = /^(?:https?:\/\/)?(?:space|www|m)\.bilibili\.com\/(?:space\/)?(\d+)/i;
const FID_PARAM = /[?&#]fid=(\d+)/i;
const MEDIA_PARAM = /[?&#]media_id=(\d+)/i;
const MEDIA_LIST_PATH = /\/(?:medialist\/detail|list)\/ml(\d+)/i;
const AT_FAV = /^@fav\/(\d+)$/i;
const DIGITS = /^\d{1,12}$/;

/**
 * @param {string} raw
 * @returns {{ mid: string, mediaId: string } | null}
 *   mid 有值 → 列出这个人的收藏夹；mediaId 有值 → 直接打开这一个收藏夹。
 */
export function parseFavInput(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;

    const at = AT_FAV.exec(text);
    if (at) return { mid: '', mediaId: at[1] };

    if (DIGITS.test(text)) return { mid: text, mediaId: '' };

    const space = SPACE_URL.exec(text);
    if (space) {
        const fid = FID_PARAM.exec(text);
        return { mid: space[1], mediaId: fid ? fid[1] : '' };
    }

    const ml = MEDIA_LIST_PATH.exec(text);
    if (ml) return { mid: '', mediaId: ml[1] };

    const media = MEDIA_PARAM.exec(text);
    if (media) return { mid: '', mediaId: media[1] };

    return null;
}

// lib/afterInstall.mjs
// 更新装完之后，替用户把开关再打开一次。
//
// 为什么需要：宿主认为「换了文件 = 旧信任作废」。installModFromZip() 只替换文件和重载，
// 换完之后模组必然落到 disabled（旧 approval 的 digest 和新内容对不上），而且**不会**弹确认——
// 弹确认的代码在宿主 setModEnabled() 里，只有用户手动点开关才会走到。
// 于是用户看到的是一次「更新完模组就没了」。
//
// 这里只做一件事：调宿主的 setEnabled(id, true)，让它走自己的确认流程。
// **不写宿主的信任记录**，那是安全边界；接口不存在时退化成一句明确的手动指引。

/**
 * @param {object} options
 * @param {any} options.mods            宿主的 window.electron.mods（可能不存在）
 * @param {string} options.id           模组 id
 * @param {(error?: any) => void} [options.onManual]  需要用户手动确认时调用
 * @returns {Promise<'enabled' | 'manual'>}
 */
export async function ensureEnabledAfterInstall({ mods, id, onManual } = {}) {
    if (!mods || typeof mods.setEnabled !== 'function') {
        if (typeof onManual === 'function') onManual(null);
        return 'manual';
    }
    try {
        // 已经是启用状态时这一步是空操作；刚更新过时它会弹宿主的原生信任确认。
        await mods.setEnabled(id, true);
        return 'enabled';
    } catch (error) {
        if (typeof onManual === 'function') onManual(error);
        return 'manual';
    }
}

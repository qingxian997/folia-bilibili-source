// mods/bili-fav/lib/store.cjs
// Cookie 落在哪：Folium 1.7 的 secret 设置字段（宿主加密）优先，写不进去才退回数据文件。
//
// 为什么不能只用数据文件：`filesystem.data` 是明文的，SESSDATA 等于账号密码。
// 为什么要回读校验：宿主有的版本 `secrets.set` 是静默 no-op（字段被当成未知类型丢掉），
// 只看「没抛异常」会以为存上了，重启就掉登录。

'use strict';

/**
 * @param {{ secrets?: any, storage?: any }} api 主进程 api
 * @param {{ ttl?: number, now?: () => number }} [options]
 */
function createCookieStore(api, options = {}) {
    const ttl = Number(options.ttl) > 0 ? Number(options.ttl) : 3000;
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    let cached = '';
    let cachedAt = 0;

    async function readSecret() {
        if (!api.secrets || typeof api.secrets.get !== 'function') return '';
        try {
            const value = await Promise.resolve(api.secrets.get('cookie'));
            if (typeof value === 'string') return value;
            // 有的实现让 get() 不带参数、直接回整张表
            if (value && typeof value === 'object' && typeof value.cookie === 'string') return value.cookie;
        } catch {
            /* Folium 1.6，或字段没声明 */
        }
        return '';
    }

    async function readStorage() {
        if (!api.storage || typeof api.storage.get !== 'function') return '';
        try {
            const saved = await api.storage.get('cookie');
            return typeof saved === 'string' ? saved : '';
        } catch {
            return '';
        }
    }

    /** 读当前 Cookie；ttl 内复用，避免每个 HTTP 请求都解一次密。 */
    async function read(force) {
        if (!force && cached && now() - cachedAt < ttl) return cached;
        let value = await readSecret();
        if (!value) value = await readStorage();
        cached = value || '';
        cachedAt = now();
        return cached;
    }

    /** @returns {Promise<'secret'|'file'>} 实际落到了哪 */
    async function write(raw) {
        const value = String(raw || '');
        cached = value;
        cachedAt = now();

        if (api.secrets && typeof api.secrets.set === 'function' && value) {
            try {
                await Promise.resolve(api.secrets.set('cookie', value));
                // 回读比对：静默失败要能发现
                if ((await readSecret()) === value) {
                    // 加密存好之后，把可能存在的明文副本删掉
                    try {
                        await api.storage.delete('cookie');
                    } catch {
                        /* 没存过 */
                    }
                    return 'secret';
                }
            } catch {
                /* 落到下面 */
            }
        }
        await api.storage.set('cookie', value);
        return 'file';
    }

    /** 退出登录：数据文件与密钥字段都要清（文档里 secret 用 null 清空）。 */
    async function clear() {
        cached = '';
        cachedAt = 0;
        try {
            await api.storage.delete('cookie');
        } catch {
            /* 没存过 */
        }
        if (api.secrets && typeof api.secrets.set === 'function') {
            try {
                await Promise.resolve(api.secrets.set('cookie', null));
            } catch {
                /* 老宿主 */
            }
        }
    }

    return { read, write, clear, peek: () => cached };
}

module.exports = { createCookieStore };

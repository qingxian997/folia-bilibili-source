// lib/settingsPanel.mjs
//
// 设置面板本体：四个分组、说明折叠、收藏夹/合集选择器、额外列表、扫码登录、维护。
// 从 client.mjs 搬出来的一整块（约 900 行），行为没改。
//
// 这里只认 deps 传进来的东西，不碰 client 的内部状态：要读缓存、要重读墙、要升级
// 登录状态，都由 client.mjs 包一层薄函数再交进来。这样一来面板能单独改、单独测，
// 也就不用在一个 3700 行的文件里翻半天。

/**
 * @param {object} deps
 * @param {(label: any, locale: string) => string} deps.pickLabel
 * @param {Array} deps.settingFields        设置项定义（有 key / group / hint / description）
 * @param {object} deps.groups              分组定义（label、summary）
 * @param {(name: string, payload?: any) => Promise<any>} deps.rpc  调主进程
 * @param {(error: any) => string} deps.reason                      把异常变成一句人话
 * @param {(fn: Function, ms: number) => any} deps.later            受控的延迟执行（停用后不再跑）
 * @param {(raw: any) => string} deps.resourceOf                    收藏夹/合集的真实资源键
 * @param {(values: any, kind: string) => any} deps.visibilityForKind
 * @param {(text: any) => Set<string>} deps.parseExcluded
 * @param {(set: Set<string>) => string} deps.serializeExcluded
 * @param {(text: any) => any} deps.parseExtraList
 * @param {(name: any) => string} deps.cleanListName
 * @param {() => void} deps.clearCaches     清客户端缓存
 * @param {() => Promise<any>} deps.refreshWall  让宿主重读墙面
 * @param {() => Promise<any>} deps.reloadCovers 重读封面缓存
 * @param {string} deps.version             显示在维护区的版本号
 * @param {() => any} deps.fallbackSettings 宿主没给 ctx.settings 时的退路
 */
export function createSettingsPanel(deps) {
    const {
        pickLabel,
        settingFields: SETTING_FIELDS,
        groups: GROUPS,
        rpc,
        reason,
        later,
        resourceOf,
        visibilityForKind,
        parseExcluded,
        serializeExcluded,
        parseExtraList,
        parseExtraRef,
        extraKey,
        buildLibrary,
        auth,
        extrasNow,
        collectedNow,
        cleanListName,
        clearCaches,
        refreshWall,
        reloadCovers,
        version: MOD_VERSION,
        accent: BILI_PINK,
        fallbackSettings,
    } = deps;

    /**
     * 宿主的声明式表单只有单行文本和静态选项，这里需要两样它没有的东西：
     * 一个多行的「额外列表」输入、一个从账号里现读的「喜欢收藏夹」下拉。
     * 顺便也就不画 Cookie 那条了。
     *
     * 面板在 ShadowRoot 里（宿主给容器加了 `all: initial`），所以颜色得自己定，
     * 按主题的日夜挑一套，再跟着 `ctx.onChange` 换。
     */
    function mountSettings(container, ctx) {
        const doc = container.ownerDocument || document;
        const locale = (ctx && ctx.locale) || 'zh-CN';
        const L = (label) => pickLabel(label, locale);
        const settings = (ctx && ctx.settings) || fallbackSettings();

        const state = {
            me: null,
            signedOut: false,
            error: '',
            collections: [],
            albums: [],
            folders: [],
            extras: [],
            loading: true,
        };

        /**
         * 面板级 UI 状态。paint() 会重建整棵 DOM，折叠 / 搜索词 / 分段 / 已展开的说明
         * 都存在这里，否则改一项设置就把用户正在看的列表重置回顶部。
         */
        const ui = {
            // 0.9.1：四组一律默认收起。以前账号和内容默认展开，一进设置就是一屏半的
            // 长表单（收藏夹 9 行 + 合集 37 行全铺开），真正要改的那一项反而要翻很久。
            // 现在先看到四个标题和它们的摘要，点哪组开哪组。
            open: { account: false, content: false, playback: false, advanced: false },
            /** 收藏夹 / 合集列表自己的折叠（组里的组）。 */
            lists: { folders: false, albums: false },
            help: new Set(),
            folders: { q: '', seg: 'all', sort: 'default', only: false },
            albums: { q: '', seg: 'all', sort: 'default', only: false },
            login: { step: 'idle', qr: '', payload: '', message: '', timer: 0, note: null },
        };

        const root = doc.createElement('div');
        root.className = 'bf-form';
        container.replaceChildren(root);

        const style = doc.createElement('style');
        style.textContent = `
            .bf-form { color: var(--bf-fg); font-family: var(--folium-font, system-ui, -apple-system, "Segoe UI", sans-serif); }
            .bf-body { display: flex; flex-direction: column; gap: 15px; }
            .bf-row { display: flex; flex-direction: column; gap: 5px; }
            .bf-head { display: flex; align-items: center; gap: 8px; }
            /* 标题占满剩下的宽度，右边的东西（? 和开关）就都靠右排。
               0.8.6 之前用 space-between + 三段式，带开关的那一行「?」会被顶到正中间。 */
            .bf-label { flex: 1 1 auto; min-width: 0; font-size: 12.5px; font-weight: 600; letter-spacing: .01em; }
            .bf-desc { font-size: 11.5px; line-height: 1.55; color: var(--bf-dim); }
            .bf-details { font-size: 11.5px; line-height: 1.65; color: var(--bf-dim); padding: 7px 9px;
                border-left: 2px solid var(--bf-line); background: var(--bf-field); border-radius: 0 7px 7px 0; }
            .bf-field, .bf-form select, .bf-form input, .bf-form textarea {
                width: 100%; box-sizing: border-box; font: inherit; font-size: 12.5px; color: var(--bf-fg);
                background: var(--bf-field); border: 1px solid var(--bf-line); border-radius: 8px;
                padding: 6px 8px; outline: none; transition: border-color .15s;
            }
            .bf-form select:focus, .bf-form input:focus, .bf-form textarea:focus { border-color: var(--bf-accent, #FB7299); }
            .bf-switch { flex: none; width: 34px; height: 19px; border-radius: 999px; background: var(--bf-line);
                position: relative; cursor: pointer; transition: background .16s; }
            .bf-switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 15px; height: 15px;
                border-radius: 50%; background: #fff; transition: transform .16s; box-shadow: 0 1px 2px #0003; }
            .bf-switch[data-on="1"] { background: var(--bf-accent, #FB7299); }
            .bf-switch[data-on="1"]::after { transform: translateX(15px); }
            .bf-note { font-size: 11px; color: var(--bf-dim); }
            .bf-note.bad { color: var(--bf-bad); }
            .bf-check-list { display: flex; flex-direction: column; gap: 1px; max-height: 280px; overflow: auto;
                padding: 5px; border: 1px solid var(--bf-line); border-radius: 8px; background: var(--bf-field); }
            .bf-check-row { display: flex; align-items: center; gap: 8px; padding: 5px 6px;
                border-radius: 6px; cursor: pointer; font-size: 12px; }
            .bf-check-row:hover { background: rgba(127,127,127,.12); }
            .bf-form .bf-check-row input { width: 14px; height: 14px; flex: none; margin: 0; padding: 0;
                border: 0; accent-color: var(--bf-accent, #FB7299); }
            .bf-check-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .bf-check-tag { flex: none; font-size: 10px; color: var(--bf-dim); }
            .bf-check-empty { font-size: 11.5px; color: var(--bf-dim); padding: 6px 3px; }
            .bf-group { display: flex; flex-direction: column; gap: 12px; }
            .bf-group + .bf-group { margin-top: 2px; padding-top: 12px; border-top: 1px solid var(--bf-line); }
            .bf-group-head { display: flex; align-items: center; gap: 7px; width: 100%; padding: 0; border: 0;
                background: none; font: inherit; color: inherit; cursor: pointer; text-align: left; }
            .bf-group-head:hover .bf-group-name { color: var(--bf-accent, #FB7299); }
            .bf-chevron { flex: none; width: 10px; font-size: 13px; line-height: 1; color: var(--bf-dim);
                transition: transform .16s; transform: rotate(90deg); }
            .bf-group-head[data-open="0"] .bf-chevron { transform: rotate(0deg); }
            .bf-group-name { font-size: 12px; font-weight: 650; letter-spacing: .02em; }
            .bf-group-summary { flex: 1 1 auto; min-width: 0; font-size: 11px; color: var(--bf-dim);
                text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .bf-group-body { display: flex; flex-direction: column; gap: 15px; }
            .bf-group-body[hidden] { display: none; }
            /* 组里的「收藏夹 / 合集」各自还能再收一层：不收起时 30 多个合集会铺满整屏。 */
            .bf-sub-head { display: flex; align-items: center; gap: 7px; width: 100%; padding: 5px 0 2px;
                border: 0; background: none; font: inherit; color: inherit; cursor: pointer; text-align: left; }
            .bf-sub-head[data-open="0"] .bf-chevron { transform: rotate(0deg); }
            .bf-sub-name { flex: none; font-size: 11.5px; font-weight: 600; }
            .bf-sub-summary { flex: 1 1 auto; min-width: 0; font-size: 11px; color: var(--bf-dim);
                text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .bf-sub { display: flex; flex-direction: column; gap: 8px; }
            .bf-sub[hidden] { display: none; }
            .bf-help { flex: none; width: 16px; height: 16px; padding: 0; border-radius: 50%;
                border: 1px solid var(--bf-line); background: none; color: var(--bf-dim);
                font: inherit; font-size: 10px; line-height: 14px; text-align: center; cursor: pointer; }
            .bf-help[data-on="1"] { border-color: var(--bf-accent, #FB7299); color: var(--bf-accent, #FB7299); }
            .bf-tools { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
            .bf-search { flex: 1 1 140px; min-width: 110px; }
            .bf-sort { flex: 0 0 auto; width: auto; }
            .bf-btn { flex: none; border: 1px solid var(--bf-line); background: none; color: var(--bf-fg);
                font: inherit; font-size: 11.5px; padding: 5px 10px; border-radius: 7px; cursor: pointer;
                transition: border-color .15s, color .15s; }
            .bf-btn:hover { border-color: var(--bf-accent, #FB7299); color: var(--bf-accent, #FB7299); }
            .bf-btn[disabled] { opacity: .4; cursor: default; }
            .bf-btn[disabled]:hover { border-color: var(--bf-line); color: var(--bf-fg); }
            .bf-btn.danger:hover { border-color: var(--bf-bad); color: var(--bf-bad); }
            .bf-btn[data-on="1"] { border-color: var(--bf-accent, #FB7299); color: var(--bf-accent, #FB7299); }
            .bf-seg { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
            .bf-chip { flex: none; border: 1px solid var(--bf-line); background: none; color: var(--bf-dim);
                font: inherit; font-size: 11.5px; padding: 4px 10px; border-radius: 999px; cursor: pointer; }
            .bf-chip[data-on="1"] { border-color: var(--bf-accent, #FB7299); color: var(--bf-accent, #FB7299); }
            .bf-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
            .bf-pill { flex: none; font-size: 10.5px; color: var(--bf-dim); border: 1px solid var(--bf-line);
                border-radius: 999px; padding: 1px 7px; }
            .bf-ext { display: flex; flex-direction: column; gap: 6px; }
            .bf-ext-row { display: flex; align-items: center; gap: 8px; padding: 6px 8px;
                border: 1px solid var(--bf-line); border-radius: 8px; font-size: 12px; }
            .bf-ext-row.bf-ext-bad { border-color: var(--bf-bad); color: var(--bf-bad); }
            .bf-account { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
            .bf-qr { display: flex; align-items: center; gap: 12px; padding: 10px; border: 1px solid var(--bf-line);
                border-radius: 10px; background: var(--bf-field); }
            .bf-qr img { width: 128px; height: 128px; border-radius: 8px; background: #fff; padding: 6px; flex: none; }
            .bf-qr-side { display: flex; flex-direction: column; gap: 8px; }
        `;
        root.appendChild(style);

        const body = doc.createElement('div');
        body.className = 'bf-body';
        root.appendChild(body);

        const applyTheme = () => {
            let daylight = true;
            let accent = BILI_PINK;
            try {
                const theme = ctx && typeof ctx.getTheme === 'function' ? ctx.getTheme() : null;
                daylight = !theme || theme.isDaylight !== false;
                // 宿主主题里能拿到强调色就跟着走（用户换过主题色时不会突兀），拿不到用 bilibili 粉
                const picked = theme && (theme.accentColor || theme.accent || theme.primaryColor);
                if (typeof picked === 'string' && /^[#rgbahsl(]/i.test(picked)) accent = picked;
            } catch {
                daylight = true;
            }
            root.style.setProperty('--bf-accent', accent);
            root.style.setProperty('--bf-fg', daylight ? '#1b1b1f' : '#ededf0');
            root.style.setProperty('--bf-dim', daylight ? '#6a6a72' : '#9b9ba4');
            root.style.setProperty('--bf-field', daylight ? 'rgba(0,0,0,0.035)' : 'rgba(255,255,255,0.07)');
            root.style.setProperty('--bf-line', daylight ? 'rgba(0,0,0,0.14)' : 'rgba(255,255,255,0.2)');
            root.style.setProperty('--bf-bad', daylight ? '#c0392b' : '#ff8b7f');
        };
        applyTheme();
        if (ctx && typeof ctx.onChange === 'function') ctx.onChange(applyTheme);

        // ---------------------------------------------------------------- 小工具

        const el = (tag, className, text) => {
            const node = doc.createElement(tag);
            if (className) node.className = className;
            if (text !== undefined && text !== null) node.textContent = String(text);
            return node;
        };

        const button = (text, onClick, className) => {
            const node = el('button', className || 'bf-btn', text);
            node.type = 'button';
            node.addEventListener('click', onClick);
            return node;
        };

        const optionOf = (text, value) => {
            const option = el('option', '', text);
            option.value = value;
            return option;
        };

        /**
         * 一行设置：标题 + 常显的一行说明，全文收进「?」里。
         * 之前的 2~4 行说明把面板撑得很长，真正想查细节时反而不想翻。
         */
        const rowOf = (labelText, hintText, helpKey, description) => {
            const wrap = el('div', 'bf-row');
            // 给测试和 CDP 一个稳定锚点：字段顺序以后再变也不用数第几个控件。
            if (helpKey) wrap.setAttribute('data-field', helpKey);
            const head = el('div', 'bf-head');
            head.appendChild(el('div', 'bf-label', labelText));
            let details = null;
            const paintDetails = (open) => {
                if (open && !details && description) {
                    details = el('div', 'bf-details', description);
                    wrap.appendChild(details);
                } else if (!open && details) {
                    details.remove();
                    details = null;
                }
            };
            if (description) {
                const help = button('?', () => {
                    const open = !ui.help.has(helpKey);
                    if (open) ui.help.add(helpKey);
                    else ui.help.delete(helpKey);
                    help.setAttribute('data-on', open ? '1' : '0');
                    paintDetails(open);
                }, 'bf-help');
                help.setAttribute('data-on', ui.help.has(helpKey) ? '1' : '0');
                help.title = L({ 'zh-CN': '说明', en: 'More info' });
                head.appendChild(help);
            }
            wrap.appendChild(head);
            if (hintText) wrap.appendChild(el('div', 'bf-desc', hintText));
            paintDetails(ui.help.has(helpKey));
            return { wrap, head };
        };

        const fieldOf = (key) => SETTING_FIELDS.find((field) => field.key === key);

        // ------------------------------------------------------------ 各类字段

        const renderSelect = (target, field, values) => {
            if (!field) return;
            const { wrap } = rowOf(L(field.label), L(field.hint), field.key, L(field.description));
            const select = el('select', 'bf-field');
            const current = values[field.key] !== undefined ? values[field.key] : field.defaultValue;
            (field.options || []).forEach((option) => {
                const item = optionOf(L(option.label), option.value);
                if (option.value === current) item.selected = true;
                select.appendChild(item);
            });
            select.addEventListener('change', () => {
                settings.set({ [field.key]: select.value });
            });
            wrap.appendChild(select);
            target.appendChild(wrap);
        };

        const renderBoolean = (target, field, values) => {
            if (!field) return;
            const { wrap, head } = rowOf(L(field.label), L(field.hint), field.key, L(field.description));
            const value = values[field.key] !== undefined ? Boolean(values[field.key]) : Boolean(field.defaultValue);
            const knob = el('div', 'bf-switch');
            knob.setAttribute('data-on', value ? '1' : '0');
            knob.setAttribute('role', 'switch');
            knob.setAttribute('tabindex', '0');
            knob.setAttribute('aria-checked', value ? 'true' : 'false');
            const flip = () => {
                const next = knob.getAttribute('data-on') !== '1';
                knob.setAttribute('data-on', next ? '1' : '0');
                knob.setAttribute('aria-checked', next ? 'true' : 'false');
                settings.set({ [field.key]: next });
            };
            knob.addEventListener('click', flip);
            knob.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    flip();
                }
            });
            head.appendChild(knob);
            target.appendChild(wrap);
        };

        const renderNumber = (target, field, values) => {
            if (!field) return;
            const { wrap } = rowOf(L(field.label), L(field.hint), field.key, L(field.description));
            const input = el('input', 'bf-field');
            input.type = 'number';
            if (field.min !== undefined) input.min = String(field.min);
            if (field.max !== undefined) input.max = String(field.max);
            if (field.step !== undefined) input.step = String(field.step);
            const value = values[field.key] !== undefined ? values[field.key] : field.defaultValue;
            input.value = String(value === undefined || value === null ? '' : value);
            input.addEventListener('change', () => {
                const number = Number(input.value);
                settings.set({ [field.key]: Number.isFinite(number) ? number : Number(field.defaultValue) || 0 });
            });
            wrap.appendChild(input);
            target.appendChild(wrap);
        };

        const renderFolderSelect = (target, field, values) => {
            if (!field) return;
            const { wrap } = rowOf(L(field.label), L(field.hint), field.key, L(field.description));
            const select = el('select', 'bf-field');
            const folders = (state.folders || []).slice();
            if (state.loading) {
                select.appendChild(optionOf(L({ 'zh-CN': '正在读收藏夹…', en: 'Loading…' }), ''));
                select.disabled = true;
            } else if (!folders.length) {
                // 没登录和「登录了但一个夹子都没有」不是一回事，别混成一句话。
                select.appendChild(optionOf(state.signedOut
                    ? L({ 'zh-CN': '先登录才能选', en: 'Signed out · sign in to pick' })
                    : L({ 'zh-CN': '这个账号没有收藏夹', en: 'This account has no folder' }), ''));
                select.disabled = true;
            } else {
                select.appendChild(optionOf(L({ 'zh-CN': '不指定（用默认夹）', en: 'Automatic (default folder)' }), ''));
                // 收藏夹多的账号，原生下拉没有搜索，只能靠排序补救：默认夹最前，其余按条数从多到少。
                folders.sort((a, b) => {
                    if (Boolean(a.isDefault) !== Boolean(b.isDefault)) return a.isDefault ? -1 : 1;
                    const diff = (Number(b.count) || 0) - (Number(a.count) || 0);
                    return diff || String(a.title || '').localeCompare(String(b.title || ''), 'zh-Hans-CN');
                }).forEach((folder) => {
                    const label = `${folder.title || folder.id}${folder.count ? ` · ${folder.count}` : ''}`;
                    const option = optionOf(folder.isDefault
                        ? `${label}${L({ 'zh-CN': '（默认）', en: ' (default)' })}`
                        : label, String(folder.id));
                    select.appendChild(option);
                });
                const wanted = String(values[field.key] || '');
                select.value = wanted;
                // 存的夹子已经不在了（删了/换号），退回默认
                if (wanted && select.value !== wanted) {
                    select.value = '';
                    settings.set({ [field.key]: '' });
                }
            }
            select.addEventListener('change', () => settings.set({ [field.key]: select.value }));
            wrap.appendChild(select);
            if (state.error) wrap.appendChild(el('div', 'bf-note bad', state.error));
            target.appendChild(wrap);
        };

        // ------------------------------------------------------------ 账号

        const stopLogin = () => {
            if (ui.login.timer) clearTimeout(ui.login.timer);
            ui.login = { step: 'idle', qr: '', payload: '', message: '', timer: 0, note: null };
        };

        const renderAccount = (target) => {
            const wrap = el('div', 'bf-row');
            const line = el('div', 'bf-account');
            const who = el('div', 'bf-label');
            who.textContent = state.loading
                ? L({ 'zh-CN': '正在读登录状态…', en: 'Reading sign-in state…' })
                : state.me
                    ? L({ 'zh-CN': `已登录 · ${state.me.nickname}`, en: `Signed in as ${state.me.nickname}` })
                    : L({ 'zh-CN': '未登录', en: 'Signed out' });
            line.appendChild(who);

            const actions = el('div', 'bf-tools');
            if (state.me) {
                actions.appendChild(button(L({ 'zh-CN': '退出登录', en: 'Sign out' }), () => { void doLogout(); }, 'bf-btn danger'));
            } else {
                actions.appendChild(button(L({ 'zh-CN': '扫码登录', en: 'Sign in' }), () => { void beginLogin(); }, 'bf-btn'));
            }
            line.appendChild(actions);
            wrap.appendChild(line);

            wrap.appendChild(el('div', 'bf-desc', L({
                'zh-CN': '登录后才能读到你的收藏夹、合集和我喜欢的音乐。登录凭据由宿主加密保存。',
                en: 'Sign in to get favorites, collections and the liked-songs card. The host stores the credential encrypted.',
            })));

            if (ui.login.message) {
                const note = el('div', 'bf-note', ui.login.message);
                ui.login.note = note;
                wrap.appendChild(note);
            }

            if (ui.login.step === 'qr' && ui.login.qr) {
                const card = el('div', 'bf-qr');
                const img = el('img');
                img.src = ui.login.qr;
                img.alt = 'QR';
                card.appendChild(img);
                const side = el('div', 'bf-qr-side');
                side.appendChild(el('div', 'bf-desc', L({
                    'zh-CN': '用 bilibili App 扫一下，确认后这里会自动刷新。',
                    en: 'Scan with the bilibili app; this panel refreshes itself.',
                })));
                side.appendChild(button(L({ 'zh-CN': '取消', en: 'Cancel' }), () => { stopLogin(); paint(); }, 'bf-btn'));
                card.appendChild(side);
                wrap.appendChild(card);
            }
            target.appendChild(wrap);
        };

        const beginLogin = async () => {
            stopLogin();
            ui.login.step = 'busy';
            ui.login.message = L({ 'zh-CN': '正在取二维码…', en: 'Requesting a QR code…' });
            paint();
            try {
                const url = await auth.startLogin();
                if (!root.isConnected) return;
                ui.login = {
                    step: 'qr',
                    qr: auth.createQr(url),
                    payload: url,
                    message: L({ 'zh-CN': '等待扫码…', en: 'Waiting for scan…' }),
                    timer: 0,
                    note: null,
                };
                paint();
                pollLogin();
            } catch (error) {
                if (!root.isConnected) return;
                ui.login = { step: 'idle', qr: '', payload: '', message: reason(error), timer: 0, note: null };
                paint();
            }
        };

        /** 2.2 秒问一次，只改那行提示，不整块重画（否则会把用户正在打的搜索词清掉）。 */
        const pollLogin = () => {
            if (ui.login.timer) clearTimeout(ui.login.timer);
            ui.login.timer = later(async () => {
                ui.login.timer = 0;
                if (!root.isConnected || ui.login.step !== 'qr') return;
                let answer = null;
                try {
                    answer = await auth.checkLogin(ui.login.payload);
                } catch (error) {
                    answer = { state: 'error', message: reason(error) };
                }
                if (!root.isConnected || ui.login.step !== 'qr') return;
                if (answer && answer.state === 'confirmed') {
                    stopLogin();
                    await reloadAll();
                    return;
                }
                if (answer && (answer.state === 'expired' || answer.state === 'error')) {
                    ui.login.step = 'idle';
                    ui.login.qr = '';
                    ui.login.message = (answer && answer.message)
                        || L({ 'zh-CN': '二维码过期了，再点一次扫码登录', en: 'The QR expired, try again' });
                    paint();
                    return;
                }
                ui.login.message = L({ 'zh-CN': '扫到了，等你在手机上确认…', en: 'Scanned, waiting for confirmation…' });
                if (ui.login.note && ui.login.note.isConnected) ui.login.note.textContent = ui.login.message;
                pollLogin();
            }, 2200);
        };

        const doLogout = async () => {
            stopLogin();
            ui.login.message = L({ 'zh-CN': '正在退出…', en: 'Signing out…' });
            paint();
            try {
                await auth.logout();
            } catch {
                /* 退出失败也要把面板刷回未登录态 */
            }
            await reloadAll();
        };

        // ------------------------------------------------------------ 选择器

        const SOURCE_LABEL = {
            own: { 'zh-CN': '我建的', en: 'Mine' },
            collected: { 'zh-CN': '我收藏的', en: 'Collected' },
            link: { 'zh-CN': '手动添加', en: 'Added' },
        };

        const sourceOf = (raw) => (raw && (raw.source === 'own' || raw.source === 'collected') ? raw.source : 'link');

        /**
         * 收藏夹 / 合集共用的勾选列表。0.8.4：
         *   · 搜索、按来源分段、按名称/条数排序，收藏夹几十个也找得到；
         *   · 「只看已勾选」直接在长列表里定位；
         *   · 勾掉的隐藏 / 只显示勾选的，两种勾选各存一份、互不覆盖。
         * 0.8.6：每张表自带上面那两个筛选方式（`pickerMode` / `albumPickerMode`），
         * 收藏夹设成黑名单不影响合集 —— 以前是一个全局开关，改一处两张表全变。
         */
        const renderPicker = (target, listKey, values) => {
            const isAlbum = listKey === 'albums';
            const field = fieldOf(isAlbum ? 'excludedAlbums' : 'excludedFolders');
            const items = ((isAlbum ? state.albums : state.collections) || []).filter((raw) => resourceOf(raw));
            const modeKey = isAlbum ? 'albumPickerMode' : 'pickerMode';
            const mode = visibilityForKind(values, isAlbum ? 'album' : 'playlist').mode;
            const valueKey = isAlbum
                ? (mode === 'allow' ? 'visibleAlbums' : 'excludedAlbums')
                : (mode === 'allow' ? 'visibleFolders' : 'excludedFolders');
            const filters = ui[listKey];
            const selected = () => parseExcluded(settings.get()[valueKey]);

            const { wrap } = rowOf(L(field.label), L(field.hint), field.key, L(field.description));

            // 0.9.1：列表本身也收一层。收藏夹十来个、合集三十多个，光靠 max-height 里
            // 滚一条 280px 的窄缝，内容组还是要占半屏。收起时只留一行「共 N 个 · 显示 M 个」。
            const opened = Boolean(ui.lists[listKey]);
            const bar = el('button', 'bf-sub-head');
            bar.type = 'button';
            bar.setAttribute('data-open', opened ? '1' : '0');
            bar.setAttribute('aria-expanded', opened ? 'true' : 'false');
            const subName = el('span', 'bf-sub-name', L(isAlbum
                ? { 'zh-CN': '合集', en: 'Collections' }
                : { 'zh-CN': '收藏夹', en: 'Favorites' }));
            const subMeta = el('span', 'bf-sub-summary');
            bar.append(el('span', 'bf-chevron', '›'), subName, subMeta);
            bar.addEventListener('click', () => {
                ui.lists[listKey] = !ui.lists[listKey];
                paint();
            });
            wrap.appendChild(bar);
            const body = el('div', 'bf-sub');

            const tools = el('div', 'bf-tools');
            const search = el('input', 'bf-field bf-search');
            search.type = 'search';
            search.placeholder = L(isAlbum
                ? { 'zh-CN': '搜索合集名 / UP 主…', en: 'Search collections…' }
                : { 'zh-CN': '搜索收藏夹名 / UP 主…', en: 'Search favorites…' });
            search.value = filters.q;
            search.addEventListener('input', () => {
                filters.q = search.value;
                drawList();
            });
            tools.appendChild(search);

            const only = button(L({ 'zh-CN': '只看已勾选', en: 'Only picked' }), () => {
                filters.only = !filters.only;
                only.setAttribute('data-on', filters.only ? '1' : '0');
                drawList();
            }, 'bf-btn');
            only.setAttribute('data-on', filters.only ? '1' : '0');
            tools.appendChild(only);
            body.appendChild(tools);

            // 0.8.6：筛选方式挪到各自的表里。两张表各管各的，改收藏夹不会连带合集。
            const modeRow = el('div', 'bf-seg');
            modeRow.appendChild(el('span', 'bf-note', L({ 'zh-CN': '筛选方式', en: 'Mode' })));
            [
                ['hide', { 'zh-CN': '勾掉的隐藏', en: 'Hide checked' }],
                ['allow', { 'zh-CN': '只显示勾选的', en: 'Show checked only' }],
            ].forEach(([value, text]) => {
                const chip = button(L(text), () => {
                    if (mode === value) return;
                    settings.set({ [modeKey]: value });
                    paint();
                }, 'bf-chip');
                if (mode === value) chip.setAttribute('data-on', '1');
                modeRow.appendChild(chip);
            });
            body.appendChild(modeRow);

            const sources = ['all', 'own', 'collected', 'link']
                .filter((key) => key === 'all' || items.some((raw) => sourceOf(raw) === key));
            if (sources.length > 2) {
                const segs = el('div', 'bf-seg');
                sources.forEach((key) => {
                    const chip = button(key === 'all' ? L({ 'zh-CN': '全部', en: 'All' }) : L(SOURCE_LABEL[key]), () => {
                        filters.seg = key;
                        [...segs.children].forEach((node) => {
                            if (node === chip) node.setAttribute('data-on', '1');
                            else node.removeAttribute('data-on');
                        });
                        drawList();
                    }, 'bf-chip');
                    if (filters.seg === key) chip.setAttribute('data-on', '1');
                    segs.appendChild(chip);
                });
                body.appendChild(segs);
            }

            const list = el('div', 'bf-check-list');
            const counter = el('div', 'bf-note');
            const actions = el('div', 'bf-tools');

            const drawList = () => {
                const set = selected();
                const q = filters.q.trim().toLowerCase();
                let rows = items.filter((raw) => {
                    const key = resourceOf(raw);
                    if (filters.only && !set.has(key)) return false;
                    if (filters.seg !== 'all' && sourceOf(raw) !== filters.seg) return false;
                    if (!q) return true;
                    return `${raw.name || ''} ${raw.owner || ''}`.toLowerCase().includes(q);
                });
                if (filters.sort === 'name') {
                    rows = rows.slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN'));
                } else if (filters.sort === 'count') {
                    rows = rows.slice().sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0));
                }

                list.replaceChildren();
                if (!rows.length) {
                    list.appendChild(el('div', 'bf-check-empty', items.length
                        ? L({ 'zh-CN': '没有匹配的', en: 'Nothing matches' })
                        : (state.loading
                            ? L({ 'zh-CN': '正在读…', en: 'Loading…' })
                            : state.error || L(isAlbum
                                ? { 'zh-CN': '还没有合集', en: 'No collections yet' }
                                : { 'zh-CN': '还没有收藏夹', en: 'No favorites yet' }))));
                }
                for (const raw of rows) {
                    const key = resourceOf(raw);
                    const row = el('label', 'bf-check-row');
                    const box = el('input');
                    box.type = 'checkbox';
                    box.checked = set.has(key);
                    const name = el('span', 'bf-check-name', raw.name || key);
                    name.title = `${raw.name || ''} · ${key}`;
                    const tag = el('span', 'bf-check-tag',
                        `${L(SOURCE_LABEL[sourceOf(raw)])}${raw.count ? ` · ${raw.count}` : ''}`);
                    box.addEventListener('change', () => {
                        const next = selected();
                        if (box.checked) next.add(key);
                        else next.delete(key);
                        settings.set({ [valueKey]: serializeExcluded(next) });
                        updateCount();
                        if (filters.only && !box.checked) row.remove();
                    });
                    row.append(box, name, tag);
                    list.appendChild(row);
                }
                updateCount();
            };

            function updateCount() {
                const set = selected();
                // 勾选里可能留着早就删掉 / 换了号的收藏夹 id：它们在排除集合里，
                // 但列表上找不到对应行。以前只报「已隐藏 10 个」，用户看着 0 个勾选
                // 会以为面板坏了，所以单独点出来，并给一个清掉的入口。
                const known = new Set(items.map(resourceOf).filter(Boolean));
                // 只在这个列表真的读到了东西时才敢说「失效」：未登录 / 接口失败时
                // items 是空的，那样所有勾选都会被判成失效，清理就等于把黑名单一次删光。
                const stale = items.length ? [...set].filter((key) => !known.has(key)).length : 0;
                const shown = items.filter((raw) => {
                    const key = resourceOf(raw);
                    return mode === 'allow' ? (!set.size || set.has(key)) : !set.has(key);
                }).length;
                const tail = stale
                    ? L({
                        'zh-CN': `（其中 ${stale} 个已经不在了，可能删掉或换了账号）`,
                        en: ` (${stale} of them no longer exist)`,
                    })
                    : '';
                counter.textContent = mode === 'allow'
                    ? (set.size
                        ? L({
                            'zh-CN': `只显示 ${set.size} 个${tail} · 共 ${items.length} 个`,
                            en: `${set.size} picked${tail} · showing ${shown} of ${items.length}`,
                        })
                        : L({
                            'zh-CN': `还没勾，先全部显示（共 ${items.length} 个）`,
                            en: `Empty allow list, showing all ${items.length}`,
                        }))
                    : L({
                        'zh-CN': `隐藏 ${set.size} 个${tail} · 显示 ${shown} / ${items.length}`,
                        en: `${set.size} hidden${tail} · showing ${shown} of ${items.length}`,
                    });
                staleBtn.style.display = stale ? '' : 'none';
                // 折叠起来时，这一行就是用户能看到的全部信息：多少个、实际显示几个、
                // 有没有已经失效的。省得为了确认一眼再展开。
                const staleTag = stale
                    ? L({ 'zh-CN': ` · ${stale} 个已失效`, en: ` · ${stale} stale` })
                    : '';
                subMeta.textContent = mode === 'allow'
                    ? (set.size
                        ? L({
                            'zh-CN': `共 ${items.length} 个 · 只显示 ${shown} 个${staleTag}`,
                            en: `${items.length} total · ${shown} shown${staleTag}`,
                        })
                        : L({
                            'zh-CN': `共 ${items.length} 个 · 全部显示`,
                            en: `${items.length} total · all shown`,
                        }))
                    : L({
                        'zh-CN': `共 ${items.length} 个 · 显示 ${shown} 个${staleTag}`,
                        en: `${items.length} total · ${shown} shown${staleTag}`,
                    });
            }

            const staleBtn = button(L({ 'zh-CN': '清掉失效的', en: 'Drop missing' }), () => {
                const set = selected();
                const known = new Set(items.map(resourceOf).filter(Boolean));
                // 列表空的（未登录 / 读取失败）时候一个都不动，避免把黑名单清空。
                if (!known.size) return;
                settings.set({ [valueKey]: serializeExcluded(new Set([...set].filter((key) => known.has(key)))) });
                paint();
            }, 'bf-btn');
            staleBtn.style.display = 'none';
            actions.appendChild(staleBtn);

            if (mode === 'allow') {
                actions.appendChild(button(L({ 'zh-CN': `全选（${items.length}）`, en: `Select all (${items.length})` }), () => {
                    const all = new Set(items.map(resourceOf).filter(Boolean));
                    settings.set({ [valueKey]: serializeExcluded(all) });
                    paint();
                }, 'bf-btn'));
                const clear = button(L({ 'zh-CN': '清空', en: 'Clear' }), () => {
                    settings.set({ [valueKey]: '' });
                    paint();
                }, 'bf-btn');
                if (!selected().size) clear.disabled = true;
                actions.appendChild(clear);
            } else {
                actions.appendChild(button(L({ 'zh-CN': '全部显示', en: 'Show all' }), () => {
                    settings.set({ [valueKey]: '' });
                    paint();
                }, 'bf-btn'));
            }

            body.appendChild(list);
            const foot = el('div', 'bf-foot');
            foot.append(counter, actions);
            body.appendChild(foot);
            body.hidden = !opened;
            wrap.appendChild(body);
            target.appendChild(wrap);
            drawList();
        };

        // ------------------------------------------------------ 额外列表（条目化）

        const renderExtras = (target, field, values) => {
            if (!field) return;
            const { wrap } = rowOf(L(field.label), L(field.hint), field.key, L(field.description));
            const parsed = parseExtraList(values[field.key]);
            const resolved = new Map((state.extras || []).map((item) => [String(item.key), item]));
            const list = el('div', 'bf-ext');

            const remove = (raw) => {
                // 分隔符必须和 splitExtraRefs 一致：那边空格、全角逗号都算分隔，
                // 这边只按换行/半角逗号切的话，一行里塞了两条就永远删不掉（点了没反应）。
                const lines = String(settings.get()[field.key] || '')
                    .split(/[\s,;，；]+/)
                    .map((line) => line.trim())
                    .filter(Boolean)
                    .filter((line) => line !== raw);
                settings.set({ [field.key]: lines.join('\n') });
                void refreshExtras();
            };

            const addRow = (raw, nameText, tagText, bad) => {
                const row = el('div', `bf-ext-row${bad ? ' bf-ext-bad' : ''}`);
                row.appendChild(el('span', 'bf-check-name', nameText));
                if (tagText) row.appendChild(el('span', 'bf-pill', tagText));
                row.appendChild(button(L({ 'zh-CN': '移除', en: 'Remove' }), () => remove(raw), 'bf-btn danger'));
                list.appendChild(row);
            };

            for (const item of parsed.items) {
                const meta = resolved.get(item.key) || {};
                const kindLabel = item.kind === 'folder'
                    ? L({ 'zh-CN': '收藏夹', en: 'Favorites' })
                    : item.kind === 'season'
                        ? L({ 'zh-CN': '合集', en: 'Collection' })
                        : L({ 'zh-CN': '系列', en: 'Series' });
                addRow(
                    item.raw,
                    meta.name ? cleanListName(meta.name) : L({ 'zh-CN': '正在读…', en: 'Loading…' }),
                    `${kindLabel}${meta.count ? ` · ${meta.count}` : ''}`,
                    false,
                );
            }
            for (const raw of parsed.bad) {
                addRow(raw, L({ 'zh-CN': `看不懂：${raw}`, en: `Unrecognized: ${raw}` }), '', true);
            }
            if (!parsed.items.length && !parsed.bad.length) {
                list.appendChild(el('div', 'bf-check-empty', L({
                    'zh-CN': '还没添加',
                    en: 'No extra lists yet',
                })));
            }
            wrap.appendChild(list);

            const tools = el('div', 'bf-tools');
            const input = el('input', 'bf-field bf-search');
            input.type = 'text';
            input.placeholder = 'https://www.bilibili.com/medialist/detail/ml…';
            const note = el('div', 'bf-note');
            const submit = async () => {
                const raw = input.value.trim();
                if (!raw) return;
                const ref = parseExtraRef(raw);
                if (!ref) {
                    note.className = 'bf-note bad';
                    note.textContent = L({
                        'zh-CN': '这个链接看不懂。公开收藏夹、UP 主合集、系列都行。',
                        en: 'Unrecognized link; paste a favorites, collection or series URL',
                    });
                    return;
                }
                const current = parseExtraList(settings.get()[field.key]);
                if (current.items.some((item) => item.key === extraKey(ref))) {
                    note.className = 'bf-note';
                    note.textContent = L({ 'zh-CN': '这个列表已经加过了', en: 'Already added' });
                    return;
                }
                const lines = current.items.map((item) => item.raw).concat(current.bad, raw);
                settings.set({ [field.key]: lines.join('\n') });
                input.value = '';
                note.className = 'bf-note';
                note.textContent = L({ 'zh-CN': '已加入，正在读名字…', en: 'Added, reading name…' });
                await refreshExtras();
            };
            input.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    void submit();
                }
            });
            tools.append(input, button(L({ 'zh-CN': '添加', en: 'Add' }), () => { void submit(); }, 'bf-btn'));
            wrap.appendChild(tools);
            wrap.appendChild(note);
            target.appendChild(wrap);
        };

        // ------------------------------------------------------------ 高级：维护

        const renderMaintenance = (target) => {
            const wrap = el('div', 'bf-row');
            wrap.appendChild(el('div', 'bf-label', L({ 'zh-CN': '维护', en: 'Maintenance' })));
            const tools = el('div', 'bf-tools');
            const note = el('div', 'bf-note');
            const clear = button(L({ 'zh-CN': '清缓存并重新读一遍', en: 'Clear cache and reload' }), async () => {
                clear.disabled = true;
                note.className = 'bf-note';
                note.textContent = L({ 'zh-CN': '正在清理…', en: 'Clearing…' });
                try {
                    clearCaches();
                    await rpc('clearCache');
                    await reloadCovers();
                    await refreshWall();
                    note.textContent = L({ 'zh-CN': '清好了，墙已经重新读过', en: 'Cleared and reloaded' });
                } catch (error) {
                    note.className = 'bf-note bad';
                    note.textContent = reason(error);
                } finally {
                    clear.disabled = false;
                }
            }, 'bf-btn');
            tools.appendChild(clear);
            wrap.appendChild(tools);
            wrap.appendChild(note);
            wrap.appendChild(el('div', 'bf-note', L({
                'zh-CN': `版本 ${MOD_VERSION} · 收藏夹 ${(state.collections || []).length} · 合集 ${(state.albums || []).length}`,
                en: `Version ${MOD_VERSION} · ${(state.collections || []).length} favorites · ${(state.albums || []).length} collections`,
            })));
            target.appendChild(wrap);
        };

        // ------------------------------------------------------------ 装配

        const paint = () => {
            body.replaceChildren();
            const values = settings.get();
            const buckets = {};
            const bucket = (name) => {
                if (!buckets[name]) {
                    const group = GROUPS[name] || GROUPS.advanced;
                    const wrap = el('div', 'bf-group');
                    const head = el('button', 'bf-group-head');
                    head.type = 'button';
                    head.setAttribute('data-open', ui.open[name] ? '1' : '0');
                    const chevron = el('span', 'bf-chevron', '›');
                    const nameEl = el('span', 'bf-group-name', L(group.label));
                    const summary = el('span', 'bf-group-summary');
                    summary.textContent = ui.open[name]
                        ? ''
                        : ((group.summary && group.summary(values, L, { me: state.me, loading: state.loading })) || '');
                    head.append(chevron, nameEl, summary);
                    head.addEventListener('click', () => {
                        ui.open[name] = !ui.open[name];
                        paint();
                    });
                    const box = el('div', 'bf-group-body');
                    box.hidden = !ui.open[name];
                    wrap.append(head, box);
                    body.appendChild(wrap);
                    buckets[name] = box;
                }
                return buckets[name];
            };

            renderAccount(bucket('account'));

            const content = bucket('content');
            // 0.8.6：心形存哪个收藏夹提到内容组最上面；筛选方式跟着各自的表走，不再单占一行。
            renderFolderSelect(content, fieldOf('likedFolder'), values);
            renderPicker(content, 'folders', values);
            renderPicker(content, 'albums', values);
            renderExtras(content, fieldOf('extraCollections'), values);

            const playback = bucket('playback');
            renderSelect(playback, fieldOf('lyrics'), values);
            renderSelect(playback, fieldOf('route'), values);

            const advanced = bucket('advanced');
            renderBoolean(advanced, fieldOf('rawTitle'), values);
            renderNumber(advanced, fieldOf('maxMinutes'), values);
            renderMaintenance(advanced);
        };

        // ------------------------------------------------------------ 数据

        const refreshData = async () => {
            try {
                state.error = '';
                let me = null;
                try {
                    me = await auth.getLoginStatus();
                } catch {
                    me = null;
                }
                state.me = me;
                state.signedOut = !me;
                const [foldersAnswer, extras, collected] = await Promise.all([
                    me ? rpc('folders') : Promise.resolve({ items: [], owner: '', mid: '' }),
                    extrasNow(),
                    me ? collectedNow() : Promise.resolve([]),
                ]);
                state.extras = extras || [];
                const snap = buildLibrary({
                    folders: (foldersAnswer && foldersAnswer.items) || [],
                    extras,
                    collected,
                    covers: {},
                    ownerName: (foldersAnswer && foldersAnswer.owner) || '',
                    ownerId: (foldersAnswer && foldersAnswer.mid) || '',
                });
                state.collections = snap.playlists || [];
                state.albums = snap.albums || [];
                state.folders = snap.folders || [];
            } catch (error) {
                state.error = reason(error);
            } finally {
                state.loading = false;
            }
        };

        /** 只把额外列表的名字读回来；不整块重载，避免刚登录/刚改完又去问一遍账号。 */
        const refreshExtras = async () => {
            try {
                state.extras = await extrasNow();
            } catch {
                /* 读不到就保留「正在读取…」 */
            }
            if (root.isConnected) paint();
        };

        const reloadAll = async () => {
            state.loading = true;
            paint();
            await refreshData();
            if (root.isConnected) paint();
        };

        paint();
        void (async () => {
            await refreshData();
            if (root.isConnected) paint();
        })();
    }

    return mountSettings;
}


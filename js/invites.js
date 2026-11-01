// ============================================
// Личные приглашения и открытие ссылок в приложении
// ============================================
// Приглашение по нику хранится на сервере и висит уведомлением справа внизу,
// пока человек не ответит - даже если он был офлайн или закрывал страницу.

const Invites = {
    POLL_MS: 10000,
    POLL_HIDDEN_MS: 30000,
    OPEN_LINKS_KEY: 'openLinksIn', // 'app' | 'browser'

    _started: false,
    _shown: new Set(),

    get _base() {
        API.initBaseUrls();
        return `${API.baseUrls.groups}/api/Groups/invites`;
    },

    // В приложении страницы открываются без .html
    _groupPage() {
        return typeof API !== 'undefined' && API.serverOrigin ? 'group' : ['group', 'html'].join('.');
    },

    // Сначала проверяем ник, чтобы сразу сказать об опечатке
    async send(groupId, nickName, channelId, channelName) {
        const params = new URLSearchParams({ nickName });
        const check = await API.get(`${API.baseUrls.auth}/api/Auth/user-exists?${params}`);
        if (!check || !check.exists) {
            throw new Error('Пользователь с таким никнеймом не найден');
        }
        return API.post(this._base, { groupId, nickName, channelId, channelName });
    },

    // ---------- Уведомления ----------

    start() {
        if (this._started) return;
        this._started = true;
        const tick = async () => {
            await this._poll();
            setTimeout(tick, document.hidden ? this.POLL_HIDDEN_MS : this.POLL_MS);
        };
        tick();
    },

    async _poll() {
        try {
            const invites = await API.get(this._base);
            (Array.isArray(invites) ? invites : []).forEach((invite) => this._render(invite));
        } catch (error) {
            // Нет сети или сервер обновляется - проверим в следующий раз
            console.warn('Invites poll:', error);
        }
        try {
            const notices = await API.get(this._noticesBase);
            (Array.isArray(notices) ? notices : []).forEach((notice) => this._renderNotice(notice));
        } catch (error) {
            console.warn('Notices poll:', error);
        }
    },

    _stack() {
        let stack = document.getElementById('inviteToasts');
        if (!stack) {
            stack = document.createElement('div');
            stack.id = 'inviteToasts';
            stack.className = 'invite-toasts';
            stack.setAttribute('aria-live', 'polite');
            document.body.appendChild(stack);
        }
        return stack;
    },

    // ---------- Уведомления от участников группы ----------

    get _noticesBase() {
        API.initBaseUrls();
        return `${API.baseUrls.groups}/api/Groups/notices`;
    },

    sendNotice(groupId, text, userIds) {
        return API.post(this._noticesBase, { groupId, text, userIds });
    },

    _renderNotice(notice) {
        if (this._shown.has(notice.id)) return;
        this._shown.add(notice.id);

        const toast = document.createElement('div');
        toast.className = 'invite-toast';
        toast.setAttribute('role', 'alert');
        toast.innerHTML = `
            <div class="invite-toast__text">
                <strong>${Utils.escapeHtml(notice.fromNickName)}</strong> из группы «${Utils.escapeHtml(notice.groupName)}»
                <div class="notice-text">${Utils.escapeHtml(notice.text)}</div>
            </div>
            <div class="invite-toast__actions">
                <button type="button" class="btn btn-sm btn-primary" data-action="open">Открыть группу</button>
                <button type="button" class="btn btn-sm" data-action="close">Закрыть</button>
            </div>
        `;
        const openBtn = toast.querySelector('[data-action="open"]');
        const here = new URLSearchParams(window.location.search).get('id') === notice.groupId;
        if (here) {
            openBtn.remove();
        } else {
            openBtn.onclick = async () => {
                await this._dismissNotice(notice, toast);
                const params = new URLSearchParams({ id: notice.groupId, here: '1' });
                window.location.href = `${this._groupPage()}?${params}`;
            };
        }
        toast.querySelector('[data-action="close"]').onclick = () => this._dismissNotice(notice, toast);
        this._stack().appendChild(toast);
    },

    async _dismissNotice(notice, toast) {
        toast.remove();
        try {
            await API.post(`${this._noticesBase}/${encodeURIComponent(notice.id)}/dismiss`, {});
        } catch (error) {
            console.warn('Notice dismiss:', error);
        }
    },

    _render(invite) {
        if (this._shown.has(invite.id)) return;
        this._shown.add(invite.id);

        const place = invite.channelName
            ? `в голосовой канал «${Utils.escapeHtml(invite.channelName)}» группы «${Utils.escapeHtml(invite.groupName)}»`
            : `в группу «${Utils.escapeHtml(invite.groupName)}»`;

        const toast = document.createElement('div');
        toast.className = 'invite-toast';
        toast.setAttribute('role', 'alert');
        toast.innerHTML = `
            <div class="invite-toast__text">
                <strong>${Utils.escapeHtml(invite.fromNickName)}</strong> приглашает вас ${place}
            </div>
            <div class="invite-toast__actions">
                <button type="button" class="btn btn-sm btn-primary" data-action="accept">Принять</button>
                <button type="button" class="btn btn-sm" data-action="decline">Отклонить</button>
            </div>
        `;
        toast.querySelector('[data-action="accept"]').onclick = () => this._accept(invite, toast);
        toast.querySelector('[data-action="decline"]').onclick = () => this._decline(invite, toast);
        this._stack().appendChild(toast);
    },

    async _accept(invite, toast) {
        toast.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        try {
            const result = await API.post(`${this._base}/${encodeURIComponent(invite.id)}/accept`, {});
            const params = new URLSearchParams({ id: result.groupId, join: '1' });
            if (result.channelId) params.set('channel', result.channelId);
            if (result.inviteCode) params.set('invite', result.inviteCode);
            // Уже в браузере или приложении человека - спрашивать, где открыть, незачем
            params.set('here', '1');
            window.location.href = `${this._groupPage()}?${params}`;
        } catch (error) {
            Utils.showError(error.message || 'Приглашение больше не действует');
            toast.remove();
        }
    },

    async _decline(invite, toast) {
        toast.remove();
        try {
            await API.post(`${this._base}/${encodeURIComponent(invite.id)}/decline`, {});
        } catch (error) {
            console.warn('Invite decline:', error);
        }
    },

    // ---------- Открытие ссылки в приложении ----------

    _isWindowsBrowser() {
        return !window.AppPages && /Windows NT/.test(navigator.userAgent);
    },

    // «В браузере» запоминаем только до закрытия вкладки: иначе одно нажатие навсегда отключило бы
    // приложение, а вопрос не должен повторяться после входа, куда ссылка перебрасывает
    _readChoice() {
        try {
            return sessionStorage.getItem(this.OPEN_LINKS_KEY) || localStorage.getItem(this.OPEN_LINKS_KEY);
        } catch (e) {
            return null;
        }
    },

    _saveChoice(value) {
        try {
            if (value === 'browser') {
                sessionStorage.setItem(this.OPEN_LINKS_KEY, value);
            } else {
                localStorage.setItem(this.OPEN_LINKS_KEY, value);
            }
        } catch (e) {
            // не запомнится - спросим в следующий раз
        }
    },

    _appLink() {
        const current = new URLSearchParams(window.location.search);
        const params = new URLSearchParams();
        ['id', 'join', 'channel', 'invite'].forEach((key) => {
            if (current.has(key)) params.set(key, current.get(key));
        });
        return `audiochat://group?${params}`;
    },

    /**
     * Ссылка-приглашение открыта в браузере на Windows: предлагаем приложение.
     * Сайт не может узнать, установлено ли оно, поэтому в первый раз спрашиваем, а ответ запоминаем.
     * Промис завершается, когда надо продолжать в браузере; если открыли приложение - ждёт выбора.
     */
    offerOpenInApp(cameByLink) {
        const here = new URLSearchParams(window.location.search).has('here');
        if (!cameByLink || here || !this._isWindowsBrowser() || this._readChoice() === 'browser') {
            return Promise.resolve();
        }

        return new Promise((resolve) => {
            const launch = () => {
                window.location.href = this._appLink();
            };
            const remembered = this._readChoice() === 'app';

            const modal = document.createElement('div');
            modal.className = 'modal-backdrop';
            modal.style.zIndex = '1004';
            modal.innerHTML = `
                <div class="card open-app-card" style="max-width: 420px; width: 100%;">
                    <img src="images/logo-256.webp" alt="" width="72" height="72">
                    <h3 class="card-title" id="openAppTitle"></h3>
                    <p id="openAppText"></p>
                    <button type="button" class="btn btn-primary" id="openAppBtn" style="width: 100%;">Открыть в приложении</button>
                    <button type="button" class="btn" id="openBrowserBtn" style="width: 100%;">Продолжить в браузере</button>
                    <a class="open-app-card__download" href="downloads/AudioChat-Setup.exe" download>Нет приложения? Скачать для Windows</a>
                </div>
            `;
            document.body.appendChild(modal);

            const title = modal.querySelector('#openAppTitle');
            const text = modal.querySelector('#openAppText');
            const showOpened = () => {
                title.textContent = 'Открываем в приложении';
                text.textContent = 'Если браузер спросит разрешение, подтвердите. Эту вкладку потом можно закрыть.';
            };
            title.textContent = 'Открыть в приложении Audio Chat?';
            text.textContent = 'Если приложение установлено, приглашение откроется в нём.';

            modal.querySelector('#openAppBtn').onclick = () => {
                this._saveChoice('app');
                showOpened();
                launch();
            };
            modal.querySelector('#openBrowserBtn').onclick = () => {
                this._saveChoice('browser');
                modal.remove();
                resolve();
            };

            if (remembered) {
                showOpened();
                launch();
            }
        });
    }
};

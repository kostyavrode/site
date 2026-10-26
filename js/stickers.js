// ============================================
// Стикеры
// ============================================
// Каталог (паки и ID) отдаёт ChatService: GET /api/Messages/stickers.
// Картинки - статика сайта: stickers/{id}.webp. В сообщении хранится только ID стикера.

const Stickers = {
    RECENT_KEY: 'stickers.recent',
    RECENT_LIMIT: 24,
    RECENT_TAB: '__recent',
    FALLBACK_TEXT: '[Стикер]',
    PICKER_MAX_HEIGHT: 320,

    _catalogPromise: null,
    _catalog: null,
    _activeTab: null,
    _picker: null,
    _lastSelectAt: 0,

    // Адрес картинки. В приложении страницы открываются из локального wwwroot,
    // поэтому там (API.serverOrigin задан) берём картинки с сервера.
    imageUrl(stickerId) {
        const origin = (typeof API !== 'undefined' && API.serverOrigin) ? `${API.serverOrigin}/` : '';
        return `${origin}stickers/${encodeURIComponent(stickerId)}.webp`;
    },

    isSticker(message) {
        return !!message && message.type === 'sticker' &&
            Number.isInteger(message.stickerId) && message.stickerId > 0;
    },

    // HTML содержимого сообщения: картинка для стикера, экранированный текст для остального
    renderContent(message) {
        if (this.isSticker(message)) {
            return `<img class="message-sticker" src="${this.imageUrl(message.stickerId)}" ` +
                `alt="${this.FALLBACK_TEXT}" width="128" height="128" decoding="async">`;
        }
        return Utils.escapeHtml(message ? message.content : '');
    },

    // Каталог грузится один раз за страницу; при ошибке следующая попытка запросит его заново
    loadCatalog() {
        if (!this._catalogPromise) {
            API.initBaseUrls();
            this._catalogPromise = API.get(`${API.baseUrls.chat}/api/Messages/stickers`)
                .then((data) => {
                    this._catalog = this._normalizeCatalog(data);
                    return this._catalog;
                })
                .catch((error) => {
                    this._catalogPromise = null;
                    throw error;
                });
        }
        return this._catalogPromise;
    },

    _normalizeCatalog(data) {
        const packs = (data && Array.isArray(data.packs) ? data.packs : [])
            .map((pack) => ({
                id: String(pack.id),
                title: String(pack.title || pack.id),
                iconStickerId: pack.iconStickerId,
                stickers: (Array.isArray(pack.stickers) ? pack.stickers : [])
                    .filter((s) => s && Number.isInteger(s.id) && s.id > 0)
                    .map((s) => ({ id: s.id, emoji: s.emoji || '' }))
            }))
            .filter((pack) => pack.stickers.length > 0);

        const byId = new Map();
        packs.forEach((pack) => pack.stickers.forEach((s) => byId.set(s.id, s)));
        return { version: data && data.version, packs, byId };
    },

    // ---------- Недавние (только в этом браузере) ----------

    _readRecent() {
        try {
            const list = JSON.parse(localStorage.getItem(this.RECENT_KEY) || '[]');
            return Array.isArray(list) ? list.filter((id) => Number.isInteger(id) && id > 0) : [];
        } catch {
            return [];
        }
    },

    _rememberRecent(stickerId) {
        const list = [stickerId, ...this._readRecent().filter((id) => id !== stickerId)].slice(0, this.RECENT_LIMIT);
        try {
            localStorage.setItem(this.RECENT_KEY, JSON.stringify(list));
        } catch {
            // localStorage недоступен (приватный режим) - просто не запоминаем
        }
    },

    // Недавние, которые ещё есть в каталоге
    _recentStickers() {
        if (!this._catalog) return [];
        return this._readRecent()
            .map((id) => this._catalog.byId.get(id))
            .filter(Boolean);
    },

    // ---------- Окно выбора ----------

    /**
     * Подключает окно выбора к кнопке.
     * container - элемент, над которым окно открывается (поле ввода чата);
     * boundary - элемент, за границы которого окно не должно вылезать по высоте;
     * onSelect(stickerId) - отправка выбранного стикера.
     */
    initPicker({ button, container, boundary, onSelect }) {
        // В приложении страница группы открывается повторно без перезагрузки - снимаем старые обработчики
        this.destroyPicker();
        if (!button || !container) return;

        const root = document.createElement('div');
        root.className = 'sticker-picker';
        root.hidden = true;
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-label', 'Стикеры');
        root.innerHTML = `
            <div class="sticker-picker-tabs" role="tablist"></div>
            <div class="sticker-picker-body"><div class="sticker-picker-grid"></div></div>
        `;
        container.appendChild(root);

        const picker = {
            root,
            button,
            container,
            boundary,
            onSelect,
            tabs: root.querySelector('.sticker-picker-tabs'),
            body: root.querySelector('.sticker-picker-body'),
            grid: root.querySelector('.sticker-picker-grid')
        };

        picker.onButtonClick = (e) => {
            e.preventDefault();
            this.isPickerOpen() ? this.closePicker() : this.openPicker();
        };
        picker.onTabClick = (e) => {
            const tab = e.target.closest('.sticker-picker-tab');
            if (!tab) return;
            this._activeTab = tab.dataset.tab;
            this._renderPicker();
            picker.body.scrollTop = 0;
        };
        picker.onGridClick = (e) => {
            const item = e.target.closest('.sticker-picker-item');
            if (item) {
                this._select(Number(item.dataset.stickerId));
                return;
            }
            if (e.target.closest('.sticker-picker-retry')) {
                this._loadIntoPicker();
            }
        };
        // Клик мимо окна и кнопки закрывает окно
        picker.onDocumentPointerDown = (e) => {
            if (!this.isPickerOpen()) return;
            if (picker.root.contains(e.target) || picker.button.contains(e.target)) return;
            this.closePicker();
        };
        picker.onDocumentKeyDown = (e) => {
            if (e.key === 'Escape' && this.isPickerOpen()) {
                this.closePicker();
                picker.button.focus();
            }
        };
        // Картинка не загрузилась (удалили файл, нет сети) - прячем её, чтобы не было «битых» значков
        picker.onImageError = (e) => {
            const img = e.target;
            if (img && img.tagName === 'IMG') {
                const cell = img.closest('.sticker-picker-item, .sticker-picker-tab');
                if (cell) cell.classList.add('is-broken');
            }
        };

        button.setAttribute('aria-haspopup', 'dialog');
        button.setAttribute('aria-expanded', 'false');
        button.addEventListener('click', picker.onButtonClick);
        picker.tabs.addEventListener('click', picker.onTabClick);
        picker.body.addEventListener('click', picker.onGridClick);
        root.addEventListener('error', picker.onImageError, true);
        document.addEventListener('pointerdown', picker.onDocumentPointerDown, true);
        document.addEventListener('keydown', picker.onDocumentKeyDown);

        this._picker = picker;
    },

    destroyPicker() {
        const picker = this._picker;
        if (!picker) return;
        picker.button.removeEventListener('click', picker.onButtonClick);
        document.removeEventListener('pointerdown', picker.onDocumentPointerDown, true);
        document.removeEventListener('keydown', picker.onDocumentKeyDown);
        picker.root.remove();
        this._picker = null;
    },

    isPickerOpen() {
        return !!this._picker && !this._picker.root.hidden;
    },

    openPicker() {
        const picker = this._picker;
        if (!picker) return;
        this._fitPicker();
        picker.root.hidden = false;
        picker.button.setAttribute('aria-expanded', 'true');
        if (this._catalog) {
            this._renderPicker();
        } else {
            this._loadIntoPicker();
        }
    },

    closePicker() {
        const picker = this._picker;
        if (!picker) return;
        picker.root.hidden = true;
        picker.button.setAttribute('aria-expanded', 'false');
    },

    // Окно открывается вверх над полем ввода; на низких экранах уменьшаем его, чтобы не обрезалось
    _fitPicker() {
        const picker = this._picker;
        let height = this.PICKER_MAX_HEIGHT;
        if (picker.boundary) {
            const available = picker.container.getBoundingClientRect().top -
                picker.boundary.getBoundingClientRect().top - 8;
            if (available > 0) height = Math.min(height, available);
        }
        picker.root.style.height = `${Math.max(height, 160)}px`;
    },

    async _loadIntoPicker() {
        this._showStatus('Загрузка стикеров...');
        try {
            await this.loadCatalog();
            if (this.isPickerOpen()) this._renderPicker();
        } catch (error) {
            console.error('Sticker catalog load error:', error);
            if (this.isPickerOpen()) {
                this._showStatus('Не удалось загрузить стикеры', true);
            }
        }
    },

    _showStatus(text, withRetry = false) {
        const picker = this._picker;
        picker.tabs.innerHTML = '';
        picker.grid.innerHTML = '';
        const status = document.createElement('div');
        status.className = 'sticker-picker-status';
        status.textContent = text;
        if (withRetry) {
            const retry = document.createElement('button');
            retry.type = 'button';
            retry.className = 'btn btn-sm sticker-picker-retry';
            retry.textContent = 'Повторить';
            status.appendChild(document.createElement('br'));
            status.appendChild(retry);
        }
        picker.grid.appendChild(status);
    },

    _renderPicker() {
        const picker = this._picker;
        const catalog = this._catalog;
        if (!picker || !catalog) return;

        if (catalog.packs.length === 0) {
            this._showStatus('Стикеров пока нет');
            return;
        }

        const recent = this._recentStickers();
        const tabIds = [...(recent.length ? [this.RECENT_TAB] : []), ...catalog.packs.map((p) => p.id)];
        if (!tabIds.includes(this._activeTab)) {
            this._activeTab = tabIds[0];
        }

        // Вкладки: «Недавние» и паки (иконка - стикер пака)
        picker.tabs.innerHTML = '';
        if (recent.length) {
            picker.tabs.appendChild(this._createTab(this.RECENT_TAB, 'Недавние', null, '🕘'));
        }
        catalog.packs.forEach((pack) => {
            picker.tabs.appendChild(this._createTab(pack.id, pack.title, pack.iconStickerId || pack.stickers[0].id));
        });

        const stickers = this._activeTab === this.RECENT_TAB
            ? recent
            : catalog.packs.find((p) => p.id === this._activeTab).stickers;

        const fragment = document.createDocumentFragment();
        stickers.forEach((sticker) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'sticker-picker-item';
            item.dataset.stickerId = String(sticker.id);
            if (sticker.emoji) item.title = sticker.emoji;

            const img = document.createElement('img');
            img.src = this.imageUrl(sticker.id);
            img.alt = sticker.emoji || 'Стикер';
            img.loading = 'lazy';
            img.decoding = 'async';
            img.width = 64;
            img.height = 64;
            item.appendChild(img);
            fragment.appendChild(item);
        });
        picker.grid.innerHTML = '';
        picker.grid.appendChild(fragment);
    },

    _createTab(tabId, title, iconStickerId, iconText) {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'sticker-picker-tab' + (tabId === this._activeTab ? ' active' : '');
        tab.dataset.tab = tabId;
        tab.title = title;
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', tabId === this._activeTab ? 'true' : 'false');
        if (iconStickerId) {
            const img = document.createElement('img');
            img.src = this.imageUrl(iconStickerId);
            img.alt = title;
            img.decoding = 'async';
            tab.appendChild(img);
        } else {
            tab.textContent = iconText || title.charAt(0);
        }
        return tab;
    },

    _select(stickerId) {
        if (!Number.isInteger(stickerId) || stickerId <= 0) return;
        // Защита от двойного клика: один стикер за раз
        const now = Date.now();
        if (now - this._lastSelectAt < 400) return;
        this._lastSelectAt = now;

        const picker = this._picker;
        this._rememberRecent(stickerId);
        this.closePicker();
        if (picker && picker.onSelect) {
            picker.onSelect(stickerId);
        }
    }
};

// Стикер в ленте не загрузился (файл удалили, нет сети) - показываем текст вместо «битой» картинки.
// Событие error не всплывает, поэтому ловим его на фазе перехвата.
document.addEventListener('error', (e) => {
    const img = e.target;
    if (img && img.tagName === 'IMG' && img.classList.contains('message-sticker')) {
        img.replaceWith(document.createTextNode(Stickers.FALLBACK_TEXT));
    }
}, true);

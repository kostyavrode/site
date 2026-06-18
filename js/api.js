// ============================================
// API Client
// ============================================

const API = {
    // Базовые URL сервисов
    baseUrls: {
        auth: '',
        groups: '',
        chat: '',
        audio: '',
        notification: ''
    },

    _baseUrlsInitialized: false,

    initBaseUrls() {
        if (this._baseUrlsInitialized &&
            this.baseUrls.auth &&
            this.baseUrls.groups &&
            this.baseUrls.chat &&
            this.baseUrls.audio &&
            this.baseUrls.notification) {
            return;
        }

        const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
        const host = window.location.hostname;
        const port = window.location.port ? `:${window.location.port}` : '';
        const baseUrl = `${protocol}//${host}${port}`;
        const isProduction = host !== 'localhost' && host !== '127.0.0.1';
        const isTestEnv = window.location.pathname.startsWith('/test/');
        const apiPrefix = isTestEnv ? '/test' : '';
        const isLocalTest = port === ':8001' || new URLSearchParams(window.location.search).get('test') === 'true';
        const hostOnly = baseUrl.replace(/:\d+$/, '');

        if (isProduction) {
            const prodBase = `${baseUrl}${apiPrefix}`;
            this.baseUrls.auth = prodBase;
            this.baseUrls.groups = prodBase;
            this.baseUrls.chat = prodBase;
            this.baseUrls.audio = prodBase;
            this.baseUrls.notification = prodBase;
        } else if (isLocalTest) {
            this.baseUrls.auth = `${hostOnly}:10001`;
            this.baseUrls.groups = `${hostOnly}:10002`;
            this.baseUrls.chat = `${hostOnly}:10003`;
            this.baseUrls.audio = `${hostOnly}:10004`;
            this.baseUrls.notification = `${hostOnly}:10005`;
        } else {
            this.baseUrls.auth = `${hostOnly}:5001`;
            this.baseUrls.groups = `${hostOnly}:5002`;
            this.baseUrls.chat = `${hostOnly}:5003`;
            this.baseUrls.audio = `${hostOnly}:5004`;
            this.baseUrls.notification = `${hostOnly}:5005`;
        }

        this._baseUrlsInitialized = true;
    },

    // Флаг, что refresh уже в процессе
    _isRefreshing: false,
    _refreshPromise: null,

    // Таймер автоматического обновления токена (setTimeout)
    _refreshInterval: null,

    /** Время истечения access JWT (ms) из cookie, если токен читается из JS; иначе null */
    _getAccessTokenExpMs() {
        const t = this.getToken();
        if (!t || t.split('.').length < 2) return null;
        try {
            let b64 = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
            while (b64.length % 4) b64 += '=';
            const payload = JSON.parse(atob(b64));
            return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
        } catch {
            return null;
        }
    },

    // Получить токен из cookies
    getToken() {
        const cookies = document.cookie.split(';');
        for (let cookie of cookies) {
            const [name, value] = cookie.trim().split('=');
            if (name === 'access_token') {
                return value;
            }
        }
        return null;
    },

    // Установить токен в cookies
    setToken(token) {
        document.cookie = `access_token=${token}; path=/; SameSite=Lax`;
    },

    // Удалить токен
    removeToken() {
        document.cookie = 'access_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
    },

    // Базовый метод для HTTP запросов
    async request(url, options = {}) {
        this.initBaseUrls();

        const token = this.getToken();
        
        const defaultOptions = {
            headers: {
                'Content-Type': 'application/json',
            },
            credentials: 'include'
        };

        // Добавляем токен в заголовок Authorization, если он есть
        if (token) {
            defaultOptions.headers['Authorization'] = `Bearer ${token}`;
        }

        const finalOptions = {
            ...defaultOptions,
            ...options,
            headers: {
                ...defaultOptions.headers,
                ...options.headers
            }
        };

        try {
            const isLoginRequest = url.includes('/api/Auth/login');
            const isRegisterRequest = url.includes('/api/Auth/register');
            const isRefreshRequest = url.includes('/api/Auth/refresh');
            const shouldSkipRefresh = isLoginRequest || isRegisterRequest || isRefreshRequest;

            let response = await fetch(url, finalOptions);
            
            if (response.status === 401) {
                if (shouldSkipRefresh) {
                    throw new Error('Unauthorized');
                }

                // Пытаемся обновить токен
                const refreshed = await this.tryRefreshToken();
                
                if (refreshed) {
                    // Обновляем токен в заголовках для повторного запроса
                    const newToken = this.getToken();
                    if (newToken) {
                        finalOptions.headers['Authorization'] = `Bearer ${newToken}`;
                    }
                    // Повторяем оригинальный запрос
                    response = await fetch(url, finalOptions);
                    
                    if (response.status === 401) {
                        // Refresh не помог, токен недействителен
                        this.removeToken();
                        const currentPath = window.location.pathname;
                        if (!currentPath.includes('login.html') && !currentPath.includes('register.html') && !currentPath.includes('group.html')) {
                            window.location.href = 'login.html';
                        }
                        throw new Error('Unauthorized');
                    }
                } else {
                    // Refresh не удался
                    this.removeToken();
                    const currentPath = window.location.pathname;
                    if (!currentPath.includes('login.html') && !currentPath.includes('register.html') && !currentPath.includes('group.html')) {
                        window.location.href = 'login.html';
                    }
                    throw new Error('Unauthorized');
                }
            }
            
            // Для 403 и 404 на странице группы не делаем редирект
            if ((response.status === 403 || response.status === 404) && window.location.pathname.includes('group.html')) {
                // Позволяем обработать ошибку на странице группы
                const error = await response.json().catch(() => ({ error: response.statusText }));
                throw new Error(error.error || `HTTP ${response.status}`);
            }

            if (!response.ok) {
                const error = await response.json().catch(() => ({ error: response.statusText }));
                throw new Error(error.error || `HTTP ${response.status}`);
            }

            const contentType = response.headers.get('content-type');
            if (contentType && contentType.includes('application/json')) {
                return await response.json();
            }
            
            return await response.text();
        } catch (error) {
            console.error('API request error:', error);
            throw error;
        }
    },

    // GET запрос
    async get(url) {
        return this.request(url, { method: 'GET' });
    },

    // POST запрос
    async post(url, data) {
        return this.request(url, {
            method: 'POST',
            body: JSON.stringify(data)
        });
    },

    // PUT запрос
    async put(url, data) {
        return this.request(url, {
            method: 'PUT',
            body: JSON.stringify(data)
        });
    },

    // DELETE запрос
    async delete(url) {
        return this.request(url, { method: 'DELETE' });
    },

    // Попытка обновить токен
    async tryRefreshToken() {
        // Если уже идёт refresh, ждём результат
        if (this._isRefreshing) {
            return this._refreshPromise;
        }

        this._isRefreshing = true;
        this._refreshPromise = (async () => {
            try {
                const response = await fetch(`${this.baseUrls.auth}/api/Auth/refresh`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({})
                });
                
                if (response.ok) {
                    console.log('Token refreshed successfully');
                    // Небольшая задержка чтобы cookie успел обновиться
                    await new Promise(resolve => setTimeout(resolve, 100));
                    return true;
                }
                
                // Получаем детали ошибки
                let errorMessage = `Status: ${response.status}`;
                try {
                    const errorData = await response.json();
                    errorMessage = errorData.error || errorMessage;
                } catch (e) {
                    // Игнорируем ошибку парсинга JSON
                }
                
                console.error('Token refresh failed:', errorMessage);
                return false;
            } catch (error) {
                console.error('Token refresh error:', error);
                return false;
            } finally {
                this._isRefreshing = false;
                this._refreshPromise = null;
            }
        })();

        return this._refreshPromise;
    },

    // Плановое обновление: за несколько минут до exp JWT или каждые 15 мин (если exp не виден — HttpOnly)
    startAutoRefresh() {
        this.stopAutoRefresh();

        const scheduleNext = () => {
            const now = Date.now();
            const exp = this._getAccessTokenExpMs();
            const beforeExpMs = 5 * 60 * 1000;
            const fallbackMs = 15 * 60 * 1000;
            const minDelayMs = 45 * 1000;
            const maxDelayMs = 20 * 60 * 1000;

            let delay = fallbackMs;
            if (exp) {
                delay = exp - now - beforeExpMs;
                delay = Math.max(minDelayMs, delay);
                delay = Math.min(delay, maxDelayMs);
            }

            console.log(
                `[API] Следующий auto-refresh через ${Math.round(delay / 1000 / 60)} мин` +
                    (exp ? ` (exp JWT ~${new Date(exp).toISOString()})` : '')
            );

            this._refreshInterval = setTimeout(async () => {
                console.log('Auto-refreshing token...');
                const refreshed = await this.tryRefreshToken();
                if (refreshed) {
                    this._lastRefreshTime = Date.now();
                    scheduleNext();
                } else {
                    console.warn('Auto-refresh failed, stopping automatic refresh');
                    this.stopAutoRefresh();
                }
            }, delay);
        };

        scheduleNext();
    },

    // Остановить автоматическое обновление токена
    stopAutoRefresh() {
        if (this._refreshInterval !== null) {
            clearTimeout(this._refreshInterval);
            this._refreshInterval = null;
            console.log('Stopped automatic token refresh');
        }
    },
    
    // Время последнего обновления токена
    _lastRefreshTime: null,
    
    // Обновить токен при возврате на вкладку / активности: без «мёртвой зоны» 5–25 минут
    async refreshIfNeeded() {
        const now = Date.now();
        const debounceMs = 45 * 1000;
        if (this._lastRefreshTime && now - this._lastRefreshTime < debounceMs) {
            return true;
        }

        const exp = this._getAccessTokenExpMs();
        if (exp && exp - now > 3 * 60 * 1000) {
            return true;
        }

        const refreshed = await this.tryRefreshToken();
        if (refreshed) {
            this._lastRefreshTime = now;
        }
        return refreshed;
    }
};

// Отладочная функция: при нажатии клавиши ' (апостроф) обновить токен вручную
document.addEventListener('keydown', async (event) => {
    // Проверяем, что нажата клавиша ' (апостроф) и не в поле ввода
    if (event.key === "'" && event.target.tagName !== 'INPUT' && event.target.tagName !== 'TEXTAREA') {
        // Предотвращаем стандартное действие, если оно есть
        event.preventDefault();
        
        console.log('[DEBUG] Manual token refresh triggered by pressing apostrophe key');
        const refreshed = await API.tryRefreshToken();
        
        if (refreshed) {
            API._lastRefreshTime = Date.now();
            console.log('[DEBUG] ✅ Token refreshed successfully!');
        } else {
            console.log('[DEBUG] ❌ Token refresh failed!');
        }
    }
});

// При загрузке страницы: если пользователь уже авторизован, запускаем auto-refresh
// Это критически важно, потому что после перезагрузки страницы auto-refresh не работает!
document.addEventListener('DOMContentLoaded', async () => {
    // Даем время на инициализацию API (baseUrls могут устанавливаться позже)
    setTimeout(async () => {
        // Проверяем, есть ли токен (через cookie)
        const hasToken = document.cookie.split(';').some(c => c.trim().startsWith('access_token='));
        
        if (hasToken) {
            console.log('[API] Обнаружен токен при загрузке страницы');
            // Синхронизируем время жизни токена с сервером: нельзя считать «только что обновлённым»
            // момент загрузки страницы — cookie могла остаться от сессии с почти истёкшим JWT.
            const refreshed = await API.tryRefreshToken();
            API._lastRefreshTime = refreshed ? Date.now() : null;
            API.startAutoRefresh();
            console.log('[API] ✅ Auto-refresh запущен' + (refreshed ? ' (токен обновлён при загрузке)' : ''));
        } else {
            console.log('[API] Токен не найден при загрузке страницы');
        }
    }, 500); // Небольшая задержка для инициализации baseUrls
});

// ВАЖНО: Обновляем токен когда пользователь возвращается на вкладку
// Браузер может "замораживать" неактивные вкладки и setInterval не сработает
document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
        const hasToken = document.cookie.split(';').some(c => c.trim().startsWith('access_token='));
        if (hasToken) {
            console.log('[API] Вкладка стала активной, проверяем токен...');
            await API.refreshIfNeeded();
        }
    }
});

// Также обновляем токен при любой активности пользователя (каждые 10 минут максимум)
let lastActivityRefresh = 0;
const ACTIVITY_REFRESH_INTERVAL = 10 * 60 * 1000; // 10 минут

['click', 'keydown', 'scroll', 'mousemove'].forEach(eventType => {
    document.addEventListener(eventType, async () => {
        const now = Date.now();
        if (now - lastActivityRefresh > ACTIVITY_REFRESH_INTERVAL) {
            const hasToken = document.cookie.split(';').some(c => c.trim().startsWith('access_token='));
            if (hasToken) {
                lastActivityRefresh = now;
                // Проверяем в фоне, не блокируя
                API.refreshIfNeeded().catch(e => console.warn('[API] Ошибка обновления токена:', e));
            }
        }
    }, { passive: true });
});
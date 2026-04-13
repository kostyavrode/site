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

    // Флаг, что refresh уже в процессе
    _isRefreshing: false,
    _refreshPromise: null,

    // Интервал автоматического обновления токена
    _refreshInterval: null,

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

    // Запустить автоматическое обновление токена каждые 29 минут
    startAutoRefresh() {
        // Останавливаем предыдущий интервал, если он есть
        this.stopAutoRefresh();

        // 29 минут = 29 * 60 * 1000 миллисекунд
        const REFRESH_INTERVAL_MS = 29 * 60 * 1000;

        console.log('Starting automatic token refresh every 29 minutes');
        
        this._refreshInterval = setInterval(async () => {
            console.log('Auto-refreshing token...');
            const refreshed = await this.tryRefreshToken();
            if (refreshed) {
                this._lastRefreshTime = Date.now();
            } else {
                console.warn('Auto-refresh failed, stopping automatic refresh');
                this.stopAutoRefresh();
            }
        }, REFRESH_INTERVAL_MS);
    },

    // Остановить автоматическое обновление токена
    stopAutoRefresh() {
        if (this._refreshInterval !== null) {
            clearInterval(this._refreshInterval);
            this._refreshInterval = null;
            console.log('Stopped automatic token refresh');
        }
    },
    
    // Время последнего обновления токена
    _lastRefreshTime: null,
    
    // Обновить токен если прошло достаточно времени с последнего обновления
    async refreshIfNeeded() {
        const now = Date.now();
        const MIN_REFRESH_INTERVAL = 5 * 60 * 1000; // 5 минут минимум между обновлениями
        const MAX_TOKEN_AGE = 25 * 60 * 1000; // Обновляем если токену > 25 минут
        
        // Если недавно обновляли - пропускаем
        if (this._lastRefreshTime && (now - this._lastRefreshTime) < MIN_REFRESH_INTERVAL) {
            console.log('[API] Токен обновлялся недавно, пропускаем');
            return true;
        }
        
        // Если прошло много времени - обновляем
        if (!this._lastRefreshTime || (now - this._lastRefreshTime) > MAX_TOKEN_AGE) {
            console.log('[API] Требуется обновление токена (прошло времени с последнего обновления:', 
                this._lastRefreshTime ? Math.round((now - this._lastRefreshTime) / 1000 / 60) + ' мин' : 'никогда', ')');
            const refreshed = await this.tryRefreshToken();
            if (refreshed) {
                this._lastRefreshTime = now;
            }
            return refreshed;
        }
        
        return true;
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
// ============================================
// API Client
// ============================================

const API = {
    // Базовые URL сервисов
    baseUrls: {
        auth: '',
        groups: '',
        chat: '',
        audio: ''
    },

    // Флаг, что refresh уже в процессе
    _isRefreshing: false,
    _refreshPromise: null,

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
        const defaultOptions = {
            headers: {
                'Content-Type': 'application/json',
            },
            credentials: 'include'
        };

        const finalOptions = {
            ...defaultOptions,
            ...options,
            headers: {
                ...defaultOptions.headers,
                ...options.headers
            }
        };

        try {
            let response = await fetch(url, finalOptions);
            
            if (response.status === 401) {
                // Пытаемся обновить токен
                const refreshed = await this.tryRefreshToken();
                
                if (refreshed) {
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
                    return true;
                }
                
                console.log('Token refresh failed:', response.status);
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
    }
};

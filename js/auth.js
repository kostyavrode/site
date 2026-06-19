const Auth = {
    async register(nickName, password, confirmPassword, email = null) {
        try {
            const data = { nickName, password, confirmPassword };
            if (email) data.email = email;
            
            const response = await API.post(`${API.baseUrls.auth}/api/Auth/register`, data);
            Utils.showSuccess('Регистрация успешна!');
            return response;
        } catch (error) {
            Utils.showError(error.message || 'Ошибка при регистрации');
            throw error;
        }
    },

    async login(nickName, password) {
        try {
            const response = await API.post(`${API.baseUrls.auth}/api/Auth/login`, {
                nickName,
                password
            });
            Utils.showSuccess('Вход выполнен успешно!');
            API.markSessionActive();
            API._lastRefreshTime = Date.now();
            API.startAutoRefresh();
            return response;
        } catch (error) {
            Utils.showError(error.message || 'Ошибка при входе');
            throw error;
        }
    },

    // Выход
    async logout() {
        try {
            await API.post(`${API.baseUrls.auth}/api/Auth/logout`, {});
            API.clearSession();
            Utils.showSuccess('Выход выполнен');
        } catch (error) {
            console.error('Logout error:', error);
            API.clearSession();
        }
    },

    // Получить информацию о текущем пользователе
    async getCurrentUser() {
        try {
            return await API.get(`${API.baseUrls.auth}/api/Auth/me`);
        } catch (error) {
            console.error('Get current user error:', error);
            return null;
        }
    },

    // Проверить, авторизован ли пользователь
    async isAuthenticated() {
        try {
            const user = await this.getCurrentUser();
            if (user !== null) {
                API.markSessionActive();
                return true;
            }
            return false;
        } catch (error) {
            return false;
        }
    },

    // Обновить токен
    async refreshToken() {
        try {
            const response = await API.post(`${API.baseUrls.auth}/api/Auth/refresh`, {});
            return response;
        } catch (error) {
            console.error('Refresh token error:', error);
            return null;
        }
    }
};

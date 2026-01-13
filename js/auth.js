// ============================================
// Authentication Module
// ============================================

const Auth = {
    // Регистрация
    async register(email, password, nickName, confirmPassword) {
        try {
            const response = await API.post(`${API.baseUrls.auth}/api/Auth/register`, {
                email,
                password,
                nickName,
                confirmPassword
            });
            
            Utils.showSuccess('Регистрация успешна!');
            return response;
        } catch (error) {
            Utils.showError(error.message || 'Ошибка при регистрации');
            throw error;
        }
    },

    // Вход
    async login(email, password) {
        try {
            const response = await API.post(`${API.baseUrls.auth}/api/Auth/login`, {
                email,
                password
            });
            
            Utils.showSuccess('Вход выполнен успешно!');
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
            Utils.showSuccess('Выход выполнен');
        } catch (error) {
            console.error('Logout error:', error);
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
            return user !== null;
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

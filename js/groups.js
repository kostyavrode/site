// ============================================
// Groups Module
// ============================================

const Groups = {
    // Создать группу
    async createGroup(name, description, password) {
        try {
            const data = { name };
            if (description) data.description = description;
            if (password) data.password = password;
            
            const response = await API.post(`${API.baseUrls.groups}/api/Groups`, data);
            Utils.showSuccess('Группа создана успешно!');
            return response;
        } catch (error) {
            Utils.showError(error.message || 'Ошибка при создании группы');
            throw error;
        }
    },

    // Получить группу по ID
    async getGroupById(groupId) {
        try {
            return await API.get(`${API.baseUrls.groups}/api/Groups/${groupId}`);
        } catch (error) {
            Utils.showError(error.message || 'Ошибка при получении группы');
            throw error;
        }
    },

    // Получить группы пользователя
    async getUserGroups() {
        try {
            return await API.get(`${API.baseUrls.groups}/api/Groups`);
        } catch (error) {
            Utils.showError(error.message || 'Ошибка при получении групп');
            throw error;
        }
    },

    // Поиск групп
    async searchGroups(query, limit = 20, offset = 0) {
        try {
            const params = new URLSearchParams({ query, limit: limit.toString(), offset: offset.toString() });
            return await API.get(`${API.baseUrls.groups}/api/Groups/search?${params}`);
        } catch (error) {
            Utils.showError(error.message || 'Ошибка при поиске групп');
            throw error;
        }
    },

    // Глобальный список групп (пагинация: page + pageSize)
    async getBrowseGroups(page = 1, pageSize = 10) {
        try {
            const offset = (page - 1) * pageSize;
            const params = new URLSearchParams({
                query: '',
                page: page.toString(),
                pageSize: pageSize.toString(),
                limit: pageSize.toString(),
                offset: offset.toString()
            });
            return await API.get(`${API.baseUrls.groups}/api/Groups/search?${params}`);
        } catch (error) {
            console.error('Browse groups error:', error);
            throw error;
        }
    },

    // Присоединиться к группе
    async joinGroup(groupId, password) {
        try {
            const data = password ? { password } : {};
            const response = await API.post(`${API.baseUrls.groups}/api/Groups/${groupId}/join`, data);
            Utils.showSuccess('Вы успешно присоединились к группе!');
            return response;
        } catch (error) {
            Utils.showError(error.message || 'Ошибка при присоединении к группе');
            throw error;
        }
    },

    // Покинуть группу
    async leaveGroup(groupId) {
        try {
            await API.post(`${API.baseUrls.groups}/api/Groups/${groupId}/leave`, {});
            Utils.showSuccess('Вы покинули группу');
        } catch (error) {
            Utils.showError(error.message || 'Ошибка при выходе из группы');
            throw error;
        }
    },

    // Получить участников группы
    async getGroupMembers(groupId) {
        try {
            return await API.get(`${API.baseUrls.groups}/api/Groups/${groupId}/members`);
        } catch (error) {
            Utils.showError(error.message || 'Ошибка при получении участников');
            throw error;
        }
    },

    // Изменить роль участника (только владелец)
    async updateMemberRole(groupId, userId, role, options = {}) {
        const { showSuccess = true } = options;

        try {
            API.initBaseUrls();
            const payload = {
                groupId,
                GroupId: groupId,
                userId,
                UserId: userId,
                role,
                Role: role
            };
            const response = await API.post(
                `${API.baseUrls.groups}/api/Groups/member-role`,
                payload
            );
            if (showSuccess) {
                Utils.showSuccess('Роль участника обновлена');
            }
            return response;
        } catch (error) {
            const message = error.message || 'Ошибка при изменении роли';
            Utils.showError(message.includes('404')
                ? 'Сервис групп не поддерживает смену ролей. Перезапустите GroupsService.'
                : message);
            throw error;
        }
    },

    // Обновить группу
    async updateGroup(groupId, name, description, password) {
        try {
            const data = {};
            if (name) data.name = name;
            if (description !== undefined) data.description = description;
            if (password !== undefined) data.password = password;
            
            const response = await API.put(`${API.baseUrls.groups}/api/Groups/${groupId}`, data);
            Utils.showSuccess('Группа обновлена!');
            return response;
        } catch (error) {
            Utils.showError(error.message || 'Ошибка при обновлении группы');
            throw error;
        }
    },

    // Удалить группу
    async deleteGroup(groupId) {
        try {
            await API.delete(`${API.baseUrls.groups}/api/Groups/${groupId}`);
            Utils.showSuccess('Группа удалена');
        } catch (error) {
            Utils.showError(error.message || 'Ошибка при удалении группы');
            throw error;
        }
    }
};

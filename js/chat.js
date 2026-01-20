// ============================================
// Chat Module (SignalR)
// ============================================

const Chat = {
    connection: null,
    groupId: null,

    // Инициализация SignalR подключения
    async init(groupId) {
        this.groupId = groupId;
        
        const signalRUrl = `${API.baseUrls.notification}/hubs/notification`;
        
        this.connection = new signalR.HubConnectionBuilder()
            .withUrl(signalRUrl, {
                accessTokenFactory: () => API.getToken() || '',
                transport: signalR.HttpTransportType.WebSockets
            })
            .withAutomaticReconnect()
            .build();

        // Обработка получения сообщения
        this.connection.on('ReceiveMessage', (message) => {
            if (window.onReceiveMessage) {
                window.onReceiveMessage(message);
            }
        });

        // Обработка уведомлений о подключении участника к аудио каналу
        this.connection.on('AudioParticipantJoined', (data) => {
            if (window.onAudioParticipantJoined) {
                window.onAudioParticipantJoined(data);
            }
        });

        // Обработка уведомлений об отключении участника от аудио канала
        this.connection.on('AudioParticipantLeft', (data) => {
            if (window.onAudioParticipantLeft) {
                window.onAudioParticipantLeft(data);
            }
        });

        // Обработка ошибок подключения
        this.connection.onclose((error) => {
            console.error('SignalR connection closed', error);
            if (window.onChatDisconnected) {
                window.onChatDisconnected(error);
            }
        });

        // Начало подключения
        try {
            await this.connection.start();
            await this.connection.invoke('JoinGroup', groupId);
            if (window.onChatConnected) {
                window.onChatConnected();
            }
        } catch (error) {
            console.error('SignalR connection error:', error);
            if (window.onChatError) {
                window.onChatError(error);
            }
        }
    },

    // Отправить сообщение
    async sendMessage(content) {
        if (!this.connection || this.connection.state !== signalR.HubConnectionState.Connected) {
            throw new Error('Чат не подключен');
        }

        try {
            await this.connection.invoke('SendMessage', {
                groupId: this.groupId,
                content: content
            });
        } catch (error) {
            console.error('Send message error:', error);
            throw error;
        }
    },

    // Отключиться от группы
    async leaveGroup() {
        if (this.connection && this.groupId) {
            try {
                await this.connection.invoke('LeaveGroup', this.groupId);
            } catch (error) {
                console.error('Leave group error:', error);
            }
        }
        
        if (this.connection) {
            await this.connection.stop();
            this.connection = null;
        }
        this.groupId = null;
    },

    // Получить историю сообщений
    async getMessages(pageSize = 50, page = 1) {
        try {
            const params = new URLSearchParams({ page: page.toString(), pageSize: pageSize.toString() });
            return await API.get(`${API.baseUrls.chat}/api/Messages/${this.groupId}?${params}`);
        } catch (error) {
            Utils.showError(error.message || 'Ошибка при получении сообщений');
            throw error;
        }
    }
};

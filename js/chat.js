// ============================================
// Chat Module (SignalR)
// ============================================

const Chat = {
    connection: null,
    groupId: null,
    _restartTimer: null,

    // Инициализация SignalR подключения
    async init(groupId) {
        this.groupId = groupId;
        
        const signalRUrl = `${API.baseUrls.notification}/hubs/notification`;
        
        this.connection = new signalR.HubConnectionBuilder()
            .withUrl(signalRUrl, {
                // Вызывается при каждом (пере)подключении. За время жизни вкладки access-токен
                // успевает истечь, поэтому сначала обновляем его - иначе переподключение
                // после обрыва сети упиралось бы в 401.
                accessTokenFactory: async () => {
                    await API.ensureFreshToken();
                    return API.getToken() || '';
                },
                transport: signalR.HttpTransportType.WebSockets
            })
            // Переподключаемся бесконечно (по умолчанию SignalR сдаётся после 4 попыток,
            // и страница навсегда перестаёт получать события)
            .withAutomaticReconnect({
                nextRetryDelayInMilliseconds: (ctx) => Math.min(1000 * Math.pow(2, ctx.previousRetryCount), 15000)
            })
            .build();

        // После переподключения у соединения новый ConnectionId, и сервер забывает,
        // в какой SignalR-группе оно было. Без повторного JoinGroup события
        // AudioParticipantJoined/Left и сообщения чата сюда больше не приходят.
        this.connection.onreconnected(async () => {
            console.log('SignalR reconnected, rejoining group', this.groupId);
            await this._rejoinGroup();
        });

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

        // Обработка уведомлений о начале видео-трансляции
        this.connection.on('VideoStreamStarted', (data) => {
            console.log('📹 SignalR событие VideoStreamStarted получено от сервера:', data);
            if (window.onVideoStreamStarted) {
                console.log('📹 Вызываем window.onVideoStreamStarted');
                window.onVideoStreamStarted(data);
            } else {
                console.warn('⚠️ window.onVideoStreamStarted не определён!');
            }
        });

        // Обработка уведомлений об остановке видео-трансляции
        this.connection.on('VideoStreamStopped', (data) => {
            console.log('🔴 SignalR событие VideoStreamStopped получено от сервера:', data);
            if (window.onVideoStreamStopped) {
                console.log('🔴 Вызываем window.onVideoStreamStopped');
                window.onVideoStreamStopped(data);
            } else {
                console.warn('⚠️ window.onVideoStreamStopped не определён!');
            }
        });

        // Обработка списка активных видео-стримов (при подключении)
        this.connection.on('ActiveVideoStreams', (data) => {
            console.log('📹 SignalR событие ActiveVideoStreams получено от сервера:', data);
            if (window.onActiveVideoStreams) {
                console.log('📹 Вызываем window.onActiveVideoStreams');
                window.onActiveVideoStreams(data);
            } else {
                console.warn('⚠️ window.onActiveVideoStreams не определён!');
            }
        });

        // Обработка ошибок подключения
        this.connection.onclose((error) => {
            console.error('SignalR connection closed', error);
            if (window.onChatDisconnected) {
                window.onChatDisconnected(error);
            }
            this._scheduleRestart();
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
            this._scheduleRestart();
        }
    },

    // Повторно войти в SignalR-группу и догнать пропущенные изменения
    async _rejoinGroup() {
        if (!this.connection || !this.groupId) return;
        try {
            await this.connection.invoke('JoinGroup', this.groupId);
        } catch (error) {
            console.error('Rejoin group error:', error);
        }
        // Пока соединения не было, события могли потеряться - берём актуальное состояние
        if (window.resyncAudioParticipants) {
            window.resyncAudioParticipants();
        }
    },

    // Соединение закрылось окончательно (не leaveGroup) - поднимаем его заново
    _scheduleRestart() {
        const connection = this.connection;
        if (!connection || !this.groupId || this._restartTimer) return;
        this._restartTimer = setTimeout(async () => {
            this._restartTimer = null;
            if (this.connection !== connection || !this.groupId) return;
            try {
                await connection.start();
                await this._rejoinGroup();
            } catch (error) {
                console.error('SignalR restart error:', error);
                this._scheduleRestart();
            }
        }, 5000);
    },

    // Отправить сообщение
    async sendMessage(content) {
        if (!this.connection || this.connection.state !== signalR.HubConnectionState.Connected) {
            throw new Error('Чат не подключен');
        }

        try {
            // Хаб пересылает сообщение в ChatService от имени пользователя. Токен, с которым
            // соединение было открыто, через 30 минут истекает - поэтому передаём актуальный.
            await API.ensureFreshToken();
            await this.connection.invoke('SendMessage', {
                groupId: this.groupId,
                content: content,
                accessToken: API.getToken() || undefined
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
        
        if (this._restartTimer) {
            clearTimeout(this._restartTimer);
            this._restartTimer = null;
        }
        if (this.connection) {
            const connection = this.connection;
            this.connection = null;
            this.groupId = null;
            await connection.stop();
        }
        this.groupId = null;
    },

    // Уведомить о начале видео-трансляции
    async startVideoStream(channelId, videoType) {
        console.log('🔔 Chat.startVideoStream вызван:', {
            channelId,
            videoType,
            groupId: this.groupId,
            connectionState: this.connection?.state,
            hasConnection: !!this.connection
        });
        
        if (!this.connection || this.connection.state !== signalR.HubConnectionState.Connected) {
            console.warn('⚠️ SignalR не подключен, не можем отправить уведомление о видео', {
                state: this.connection?.state,
                hasConnection: !!this.connection
            });
            return;
        }

        try {
            console.log('📤 Вызываем StartVideoStream:', this.groupId, channelId, videoType);
            await this.connection.invoke('StartVideoStream', this.groupId, channelId, videoType);
            console.log('✅ Отправлено уведомление о начале видео-трансляции:', videoType);
        } catch (error) {
            console.error('❌ Ошибка при отправке уведомления о начале видео:', error);
        }
    },

    // Уведомить об остановке видео-трансляции
    async stopVideoStream(channelId) {
        if (!this.connection || this.connection.state !== signalR.HubConnectionState.Connected) {
            console.warn('SignalR не подключен, не можем отправить уведомление о видео');
            return;
        }

        try {
            await this.connection.invoke('StopVideoStream', this.groupId, channelId);
            console.log('✅ Отправлено уведомление об остановке видео-трансляции');
        } catch (error) {
            console.error('Ошибка при отправке уведомления об остановке видео:', error);
        }
    },

    // Запросить список активных видео-стримов
    async getActiveVideoStreams(channelId) {
        console.log('🔔 Chat.getActiveVideoStreams вызван:', {
            channelId,
            connectionState: this.connection?.state,
            hasConnection: !!this.connection
        });
        
        if (!this.connection || this.connection.state !== signalR.HubConnectionState.Connected) {
            console.warn('⚠️ SignalR не подключен, не можем запросить активные видео-стримы', {
                state: this.connection?.state,
                hasConnection: !!this.connection
            });
            return;
        }

        try {
            console.log('📤 Вызываем GetActiveVideoStreams:', channelId);
            await this.connection.invoke('GetActiveVideoStreams', channelId);
            console.log('✅ Запрошен список активных видео-стримов для канала:', channelId);
        } catch (error) {
            console.error('❌ Ошибка при запросе активных видео-стримов:', error);
        }
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

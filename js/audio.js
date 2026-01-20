// Создаем модуль с явным именем, чтобы избежать конфликтов
var AudioModule = {
    janus: null,
    audioBridge: null,
    roomId: null,
    channelId: null,
    displayName: 'User',
    participantId: null,
    localStream: null,
    remoteAudio: null,
    isMuted: false,
    participantsUpdateInterval: null,
    offerCreated: false,
    jsepProcessed: false,
    
    // Настройки аудио
    audioSettings: {
        noiseSuppression: true,
        echoCancellation: true,
        autoGainControl: true
    },
    
    // RNNoise настройки
    rnnoiseEnabled: false,
    rnnoiseModule: null,
    audioContext: null,
    rnnoiseProcessor: null,
    rnnoiseSourceNode: null,
    rnnoiseDestinationNode: null,
    
    // Управление громкостью участников
    participantVolumes: new Map(), // Map<participantId, volume>
    gainNodes: new Map(), // Map<participantId, GainNode>
    remoteAudioContext: null, // AudioContext для удаленного аудио

    async init(roomId, channelId = null, displayName = 'User') {
        console.log('🎯 Audio.init:', roomId, channelId, displayName);
        this.roomId = roomId;
        this.channelId = channelId;
        this.displayName = displayName;
        
        // Загружаем сохраненные настройки аудио
        this.loadAudioSettings();
        // Загружаем настройку RNNoise
        this.loadRNNoiseSetting();
        
        // Проверка, загружена ли библиотека adapter (WebRTC)
        // Adapter может быть доступен как window.adapter
        const adapterObj = typeof adapter !== 'undefined' ? adapter : (typeof window !== 'undefined' ? window.adapter : undefined);
        if (!adapterObj) {
            console.error('Adapter check failed. typeof adapter:', typeof adapter);
            console.error('window.adapter:', typeof window !== 'undefined' ? typeof window.adapter : 'window undefined');
            throw new Error('Библиотека WebRTC adapter не загружена. Проверьте консоль браузера и обновите страницу.');
        }
        
        console.log('Adapter found:', typeof adapterObj);
        
        // Проверка, загружена ли библиотека Janus
        if (typeof Janus === 'undefined') {
            throw new Error('Библиотека Janus не загружена. Проверьте подключение к интернету и обновите страницу.');
        }
        
        const janusUrl = 'wss://audio-kostya.online/janus-ws';
        
        return new Promise((resolve, reject) => {
            try {
                console.log('Initializing Janus...');
                
                // Убеждаемся, что adapter доступен глобально для Janus.useDefaultDependencies()
                if (typeof adapter === 'undefined' && typeof window !== 'undefined') {
                    window.adapter = adapterObj;
                    console.log('Set window.adapter for Janus');
                }
                
                // Не передаем dependencies - Janus.useDefaultDependencies() автоматически
                // использует глобальный adapter и другие зависимости по умолчанию
                Janus.init({
                    debug: 'all',
                    callback: () => {
                        if (!Janus.isWebrtcSupported()) {
                            reject(new Error('WebRTC не поддерживается в этом браузере'));
                            return;
                        }

                        // Используем HTTP для REST API, WebSocket для реального времени
                        // Заменяем порт 8088 на 8188 и протокол http на ws
                        let wsUrl = janusUrl;
                        // Заменяем протокол
                        wsUrl = wsUrl.replace('http://', 'ws://');
                        // Заменяем порт 8088 на 8188
                        wsUrl = wsUrl.replace(':8088', ':8188');
                        
                        this.janus = new Janus({
                            server: wsUrl,
                            success: () => {
                                console.log('✅ Janus connected successfully, attaching AudioBridge...');
                                this.attachAudioBridge();
                                resolve();
                            },
                            error: (error) => {
                                console.error('Janus connection error:', error);
                                const errorMsg = error.message || 'Ошибка подключения к Janus Gateway';
                                if (window.onAudioError) {
                                    window.onAudioError(errorMsg);
                                }
                                reject(new Error(errorMsg));
                            },
                            destroyed: () => {
                                console.log('Janus connection destroyed');
                                if (window.onAudioDisconnected) {
                                    window.onAudioDisconnected();
                                }
                            },
                            iceServers: [
                                { urls: 'stun:stun.l.google.com:19302' },
                                { urls: 'stun:stun1.l.google.com:19302' },
                                { urls: 'stun:stun2.l.google.com:19302' }
                            ]
                        });
                    }
                });
            } catch (error) {
                console.error('Janus init error:', error);
                reject(error);
            }
        });
    },

    // Присоединиться к AudioBridge плагину
    attachAudioBridge() {
        console.log('🔌 Присоединяемся к AudioBridge плагину...');
        this.janus.attach({
            plugin: 'janus.plugin.audiobridge',
            success: (pluginHandle) => {
                console.log('✅ AudioBridge плагин успешно подключен, handle:', pluginHandle);
                this.audioBridge = pluginHandle;
                console.log('🚪 Вызываем joinRoom()...');
                this.joinRoom();
            },
            error: (error) => {
                console.error('AudioBridge attach error:', error);
                if (window.onAudioError) {
                    window.onAudioError(error);
                }
            },
            iceState: (state) => {
                console.log('ICE state:', state);
            },
            webrtcState: (on) => {
                console.log('WebRTC state:', on ? 'up' : 'down');
                if (on) {
                    console.log('✅ WebRTC соединение установлено - аудио пакеты передаются!');
                    if (window.onAudioConnected) {
                        window.onAudioConnected();
                    }
                } else {
                    console.log('❌ WebRTC соединение разорвано');
                }
            },
            onmessage: (msg, jsep) => {
                // ВАЖНО: Janus.js АВТОМАТИЧЕСКИ обрабатывает JSEP answer
                // Мы НЕ должны вызывать handleRemoteJsep вручную
                // Просто обрабатываем события для логирования и UI
                this.handleMessage(msg, jsep);
                
                // Janus.js автоматически обработает JSEP, если он есть
                // Нам нужно только логировать и обновлять UI
            },
            onlocalstream: (stream) => {
                this.localStream = stream;
                console.log('🎤 Локальный аудио поток получен:', stream);
                // Проверяем активность микрофона
                if (stream.getAudioTracks().length > 0) {
                    const track = stream.getAudioTracks()[0];
                    console.log('🎤 Микрофон активен:', track.enabled, 'Muted:', track.muted);
                    // Мониторинг уровня звука (если доступно)
                    if (window.AudioContext && track.getSettings) {
                        console.log('🎤 Настройки микрофона:', track.getSettings());
                    }
                }
                if (window.onLocalStream) {
                    window.onLocalStream(stream);
                }
            },
            // Новый API Janus.js - onlocaltrack
            onlocaltrack: (track, on) => {
                console.log('🎤 Локальный трек:', { kind: track.kind, on: on, id: track.id, enabled: track.enabled });
                if (track.kind === 'audio' && on) {
                    console.log('✅ Локальный аудио трек отправляется на сервер!');
                }
            },
            // Новый API Janus.js - onremotetrack вместо onremotestream
            onremotetrack: (track, mid, on) => {
                console.log('🔊 Удаленный трек получен:', { kind: track.kind, mid: mid, on: on, id: track.id });
                
                if (track.kind === 'audio' && on) {
                    console.log('🔊 Получен аудио трек от AudioBridge!');
                    
                    // Создаем MediaStream из трека
                    const stream = new MediaStream([track]);
                    
                    // Сохраняем ссылку на удаленный аудио элемент
                    if (!this.remoteAudio) {
                        this.remoteAudio = document.createElement('audio');
                        this.remoteAudio.id = 'remoteAudio';
                        this.remoteAudio.autoplay = true;
                        document.body.appendChild(this.remoteAudio);
                        console.log('🔊 Создан audio элемент для воспроизведения');
                    }
                    
                    // Временно отключено Web Audio API для удаленного аудио
                    // Используем простой способ для избежания конфликтов с микрофоном
                    this.remoteAudio.srcObject = stream;
                    
                    this.remoteAudio.play().then(() => {
                        console.log('✅ Удаленный аудио поток воспроизводится!');
                    }).catch((error) => {
                        console.error('❌ Ошибка воспроизведения:', error);
                        // Пробуем воспроизвести после клика пользователя
                        console.log('⚠️ Аудио заблокировано браузером. Нужен клик пользователя.');
                    });
                    
                    if (window.onRemoteStream) {
                        window.onRemoteStream(stream);
                    }
                } else if (!on && this.remoteAudio) {
                    console.log('🔇 Удаленный трек остановлен');
                }
            },
            // Старый API для совместимости
            onremotestream: (stream) => {
                console.log('🔊 [Legacy] Удаленный аудио поток получен:', stream);
                if (stream && stream.getAudioTracks().length > 0) {
                    console.log('🔊 Получено аудио от другого участника! Количество треков:', stream.getAudioTracks().length);
                    
                    if (!this.remoteAudio) {
                        this.remoteAudio = document.createElement('audio');
                        this.remoteAudio.id = 'remoteAudio';
                        this.remoteAudio.autoplay = true;
                        document.body.appendChild(this.remoteAudio);
                    }
                    
                    this.remoteAudio.srcObject = stream;
                    this.remoteAudio.play().then(() => {
                        console.log('✅ Удаленный аудио поток воспроизводится');
                    }).catch((error) => {
                        console.error('❌ Ошибка воспроизведения удаленного аудио:', error);
                    });
                }
                if (window.onRemoteStream) {
                    window.onRemoteStream(stream);
                }
            },
            oncleanup: () => {
                console.log('🧹 Очистка WebRTC ресурсов...');
                if (this.localStream) {
                    this.localStream.getTracks().forEach(track => track.stop());
                    this.localStream = null;
                }
                if (this.remoteAudio) {
                    this.remoteAudio.pause();
                    this.remoteAudio.srcObject = null;
                }
                this.offerCreated = false;
                this.jsepProcessed = false;
            }
        });
    },

    // Получить настройки аудио constraints
    getAudioConstraints() {
        return {
            audio: {
                noiseSuppression: this.audioSettings.noiseSuppression,
                echoCancellation: this.audioSettings.echoCancellation,
                autoGainControl: this.audioSettings.autoGainControl
            },
            video: false
        };
    },

    // Обновить настройки аудио
    updateAudioSettings(settings) {
        const oldSettings = { ...this.audioSettings };
        this.audioSettings = { ...this.audioSettings, ...settings };
        
        // Сохраняем в localStorage
        try {
            localStorage.setItem('audioSettings', JSON.stringify(this.audioSettings));
        } catch (e) {
            console.warn('Не удалось сохранить настройки в localStorage:', e);
        }
        
        console.log('🔧 Настройки аудио обновлены:', {
            старые: oldSettings,
            новые: this.audioSettings
        });
        
        return this.audioSettings;
    },

    // Загрузить настройки из localStorage
    loadAudioSettings() {
        try {
            const saved = localStorage.getItem('audioSettings');
            if (saved) {
                const parsed = JSON.parse(saved);
                this.audioSettings = { ...this.audioSettings, ...parsed };
                console.log('📥 Настройки аудио загружены из localStorage:', this.audioSettings);
            }
        } catch (e) {
            console.warn('Не удалось загрузить настройки из localStorage:', e);
        }
        return this.audioSettings;
    },

    // Запрос доступа к микрофону с настройками
    async requestMicrophoneAccess() {
        try {
            const constraints = this.getAudioConstraints();
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            console.log('🎤 Разрешение на микрофон получено с настройками:', this.audioSettings);
            // Останавливаем временный поток, он будет создан Janus
            stream.getTracks().forEach(track => track.stop());
            return stream;
        } catch (error) {
            console.error('❌ Ошибка доступа к микрофону:', error);
            throw error;
        }
    },
    
    // Пересоздать аудио трек с новыми настройками (во время разговора)
    async replaceAudioTrack() {
        if (!this.audioBridge || !this.localStream) {
            console.warn('⚠️ Невозможно заменить трек: нет активного соединения');
            return false;
        }
        
        try {
            console.log('🔄 Пересоздаем аудио трек с настройками:', this.audioSettings);
            
            // Получаем текущий аудио трек
            const oldTrack = this.localStream.getAudioTracks()[0];
            if (!oldTrack) {
                console.warn('⚠️ Не найден старый аудио трек');
                return false;
            }
            
            // Создаем новый поток с новыми настройками
            const constraints = this.getAudioConstraints();
            const newStream = await navigator.mediaDevices.getUserMedia(constraints);
            const newTrack = newStream.getAudioTracks()[0];
            
            if (!newTrack) {
                console.error('❌ Не удалось получить новый аудио трек');
                newStream.getTracks().forEach(track => track.stop());
                return false;
            }
            
            // Получаем RTCPeerConnection из Janus
            const webrtcStuff = this.audioBridge.webrtcStuff;
            if (!webrtcStuff || !webrtcStuff.pc) {
                console.error('❌ RTCPeerConnection не найден');
                newStream.getTracks().forEach(track => track.stop());
                return false;
            }
            
            const pc = webrtcStuff.pc;
            
            // Находим sender для аудио трека
            const sender = pc.getSenders().find(s => {
                return s.track && s.track.kind === 'audio' && s.track.id === oldTrack.id;
            });
            
            if (!sender) {
                console.error('❌ Не найден RTCRtpSender для замены трека');
                newStream.getTracks().forEach(track => track.stop());
                return false;
            }
            
            // Заменяем трек
            await sender.replaceTrack(newTrack);
            console.log('✅ Аудио трек заменен успешно');
            
            // Обновляем локальный поток
            oldTrack.stop();
            this.localStream.removeTrack(oldTrack);
            this.localStream.addTrack(newTrack);
            
            // Обновляем локальный поток в Janus (если нужно)
            if (webrtcStuff.localStream) {
                webrtcStuff.localStream.removeTrack(oldTrack);
                webrtcStuff.localStream.addTrack(newTrack);
            }
            
            // Останавливаем временный поток (оставляем только трек)
            newStream.getVideoTracks().forEach(track => track.stop());
            
            return true;
        } catch (error) {
            console.error('❌ Ошибка при замене аудио трека:', error);
            return false;
        }
    },

    // Запросить список участников
    requestParticipantsList() {
        if (this.audioBridge && this.roomId) {
            console.log('📋 Запрашиваем список участников для комнаты', this.roomId, '...');
            this.audioBridge.send({
                message: { 
                    request: 'listparticipants',
                    room: this.roomId
                }
            });
        } else {
            console.warn('⚠️ audioBridge или roomId не доступен, не могу запросить список участников');
        }
    },

    // Присоединиться к комнате
    joinRoom() {
        if (!this.audioBridge) {
            console.error('❌ audioBridge не инициализирован, не могу присоединиться к комнате');
            return;
        }
        if (!this.roomId) {
            console.error('❌ roomId не установлен, не могу присоединиться к комнате');
            return;
        }
        console.log('🚪 Отправляем запрос на присоединение к комнате:', this.roomId);
        const joinRequest = {
            request: 'join',
            room: this.roomId,
            display: this.displayName
        };
        console.log('📤 Отправляем join запрос:', joinRequest);
        try {
            this.audioBridge.send({ message: joinRequest });
            console.log('✅ Join запрос отправлен успешно');
        } catch (error) {
            console.error('❌ Ошибка при отправке join запроса:', error);
        }
    },

    // Обработка сообщений от Janus
    async handleMessage(msg, jsep) {
        console.log('📨 Получено сообщение от Janus:', msg);
        console.log('🔍 Структура msg:', {
            has_plugindata: 'plugindata' in msg,
            plugindata: msg.plugindata,
            jsep: jsep ? 'есть' : 'нет',
            msg_keys: Object.keys(msg),
            has_audiobridge: 'audiobridge' in msg
        });
        
        // Пытаемся извлечь event из разных структур
        let event = null;
        if (msg.plugindata && msg.plugindata.data) {
            // Стандартная структура: msg.plugindata.data
            event = msg.plugindata.data;
            console.log('✅ event извлечен из msg.plugindata.data');
        } else if (msg.audiobridge) {
            // Прямая структура: msg уже является событием
            event = msg;
            console.log('✅ event извлечен напрямую из msg (прямая структура)');
        } else {
            console.warn('⚠️ Не удалось извлечь event из сообщения');
        }
        
        console.log('🔍 event извлечен:', event);
        
        if (event) {
            console.log('📦 Данные события:', event);
            console.log('🔍 Проверка audiobridge:', {
                audiobridge: event.audiobridge,
                audiobridge_type: typeof event.audiobridge,
                is_joined: event.audiobridge === 'joined',
                is_joined_strict: event.audiobridge === 'joined',
                has_participants: 'participants' in event,
                participants_count: event.participants ? event.participants.length : 'N/A',
                event_keys: Object.keys(event)
            });
            
            // Проверяем разные варианты события joined
            const isOurJoin = event.audiobridge === 'joined' && event.id; 
                           
                           
            
            if (isOurJoin) {
                console.log('✅ УСЛОВИЕ JOINED СРАБОТАЛО! Присоединились к аудио комнате:', event.room);
                this.participantId = event.id;
                console.log('✅ Сохранен participantId:', this.participantId);
                const participants = event.participants || [];
                console.log('👥 Участники в комнате (из joined):', participants.length, participants);
                
                // Обновляем счетчик участников (даже если пустой массив)
                console.log('📊 Обновляем счетчик участников через onParticipantsUpdate...');
                if (window.onParticipantsUpdate) {
                    window.onParticipantsUpdate(participants, this.participantId);
                    console.log('✅ onParticipantsUpdate вызван с', participants.length, 'участниками');
                } else {
                    console.warn('⚠️ window.onParticipantsUpdate не определен!');
                }
                
                // Явно запрашиваем список участников
                console.log('📋 Запрашиваем список участников...');
                this.requestParticipantsList();
                
                // Устанавливаем периодический запрос списка участников (каждые 5 секунд)
                if (this.participantsUpdateInterval) {
                    clearInterval(this.participantsUpdateInterval);
                }
                this.participantsUpdateInterval = setInterval(() => {
                    console.log('🔄 Периодический запрос списка участников...');
                    this.requestParticipantsList();
                }, 5000);
                
                // Создаем offer только если еще не создан (проверяем по наличию локального потока)
                if (!this.localStream && !this.offerCreated) {
                    // Запрашиваем доступ к микрофону перед созданием offer
                    console.log('🎤 Запрашиваем доступ к микрофону...');
                    this.requestMicrophoneAccess().then(() => {
                        console.log('✅ Доступ к микрофону получен, создаем WebRTC offer...');
                        const audioConstraints = this.getAudioConstraints();
                        this.audioBridge.createOffer({
                            media: audioConstraints,
                        success: (jsepOffer) => {
                            console.log('✅ WebRTC offer создан, отправляем configure...');
                            this.offerCreated = true; // Устанавливаем флаг, что offer создан
                            
                            // Отправляем configure с JSEP offer
                            // Janus ответит с JSEP answer
                            this.audioBridge.send({
                                message: { request: 'configure', muted: this.isMuted },
                                jsep: jsepOffer
                            });
                            console.log('📤 Configure отправлен (muted:', this.isMuted, ')');
                        },
                            error: (error) => {
                                console.error('❌ Create offer error:', error);
                            }
                        });
                    }).catch((error) => {
                        console.error('❌ Microphone access denied:', error);
                        console.log('🔇 Создаем offer без микрофона (muted)...');
                        // Все равно создаем offer, но без микрофона
                        this.audioBridge.createOffer({
                            media: { audioRecv: true, audioSend: false, video: false },
                            success: (jsep) => {
                                console.log('✅ WebRTC offer создан (без микрофона), отправляем configure...');
                                this.audioBridge.send({
                                    message: { request: 'configure', muted: true },
                                    jsep: jsep
                                });
                                console.log('📤 Configure отправлен (muted: true)');
                            },
                            error: (error) => {
                                console.error('❌ Create offer (muted) error:', error);
                            }
                        });
                    });
                } else {
                    console.log('ℹ️ Локальный поток уже существует, пропускаем создание offer');
                }
            } else if (event.audiobridge === 'event') {
                // Обработка ошибок
                if (event.error_code) {
                    console.error('❌ Ошибка от Janus:', event.error_code, event.error);
                    console.log('🔍 Проверка условия пересоздания:', {
                        error_code: event.error_code,
                        error_code_type: typeof event.error_code,
                        error: event.error,
                        error_type: typeof event.error,
                        error_includes: event.error ? String(event.error).includes('No such room') : false,
                        channelId: this.channelId,
                        roomId: this.roomId
                    });
                    
                    // Проверяем ошибку "No such room" - может быть как строка, так и число
                    const errorCode = typeof event.error_code === 'number' ? event.error_code : parseInt(event.error_code);
                    const errorMessage = event.error ? String(event.error) : '';
                    const isNoSuchRoom = errorCode === 485 && errorMessage.includes('No such room');
                    
                    if (isNoSuchRoom) {
                        console.error('❌ Комната не существует в Janus. Пытаемся пересоздать...');
                        console.log('🔍 channelId доступен:', this.channelId ? 'ДА' : 'НЕТ');
                        
                        // Пытаемся автоматически пересоздать комнату, если есть channelId
                        if (this.channelId) {
                            try {
                                console.log('🔄 Вызываем API для пересоздания комнаты для канала:', this.channelId);
                                const response = await API.post(`${API.baseUrls.audio}/api/audio/AudioChannels/${this.channelId}/recreate-room`);
                                console.log('✅ Комната успешно пересоздана! Пытаемся подключиться снова...');
                                
                                // Небольшая задержка перед повторным подключением
                                setTimeout(() => {
                                    // Повторно вызываем joinRoom
                                    this.joinRoom();
                                }, 1000);
                                
                                return; // Не отключаемся, ждем переподключения
                            } catch (recreateError) {
                                console.error('❌ Не удалось пересоздать комнату:', recreateError);
                                const errorMsg = `Комната ${this.roomId} не существует в Janus Gateway. Не удалось автоматически пересоздать комнату. Обратитесь к администратору группы.`;
                                if (window.onAudioError) {
                                    window.onAudioError(errorMsg);
                                }
                                this.disconnect();
                                return;
                            }
                        }
                        
                        // Если channelId нет, показываем ошибку
                        const errorMsg = `Комната ${this.roomId} не существует в Janus Gateway. Возможно, Janus был перезапущен. Попробуйте пересоздать аудио канал или обратитесь к администратору группы.`;
                        console.error('❌', errorMsg);
                        if (window.onAudioError) {
                            window.onAudioError(errorMsg);
                        }
                        // Отключаемся от несуществующей комнаты
                        this.disconnect();
                    } else {
                        // Другие ошибки
                        const errorMsg = event.error || `Ошибка ${event.error_code} от Janus`;
                        if (window.onAudioError) {
                            window.onAudioError(errorMsg);
                        }
                    }
                    return;
                }
                
                // Обработка ответа на listparticipants
                if (event.list) {
                    const participants = Array.isArray(event.list) ? event.list : [];
                    console.log('📋 Список участников (из list):', participants.length, 'участников', participants);
                    
                    if (!this.participantId && participants.length > 0) {
                        const self = participants.find(p => (p.display || p.displayName || '').trim() === this.displayName.trim());
                        if (self && self.id) {
                            this.participantId = self.id;
                            console.log('✅ Найден свой participantId из списка:', this.participantId);
                        }
                    }
                    
                    console.log('🔍 Вызываем onParticipantsUpdate с', participants.length, 'участниками');
                    if (window.onParticipantsUpdate) {
                        window.onParticipantsUpdate(participants, this.participantId);
                        console.log('✅ onParticipantsUpdate вызван');
                    } else {
                        console.warn('⚠️ window.onParticipantsUpdate не определен при обработке list');
                    }
                }
                
                if (event.participants) {
                    const participants = Array.isArray(event.participants) ? event.participants : [];
                    console.log('👥 Обновление списка участников (из event):', participants.length, 'участников', participants);
                    
                    if (!this.participantId && participants.length > 0) {
                        const self = participants.find(p => (p.display || p.displayName || '').trim() === this.displayName.trim());
                        if (self && self.id) {
                            this.participantId = self.id;
                            console.log('✅ Найден свой participantId из списка участников:', this.participantId);
                        }
                    }
                    
                    if (window.onParticipantsUpdate) {
                        window.onParticipantsUpdate(participants, this.participantId);
                    }
                }
                
                // Логируем другие события для отладки
                if (event.talking) {
                    console.log('🗣️ Кто-то говорит:', event.talking);
                }
                
                // Логируем все события для отладки
                console.log('📨 Получено событие от Janus:', event);
            }
        }

        // Обрабатываем JSEP answer вручную, т.к. Janus.js НЕ делает это автоматически для AudioBridge
        // PeerConnection хранится в audioBridge.webrtcStuff.pc, а не в audioBridge.pc
        if (jsep) {
            console.log('📡 Получен JSEP:', {
                type: jsep.type,
                has_sdp: !!jsep.sdp,
                sdp_length: jsep.sdp ? jsep.sdp.length : 0,
                event_result: event ? event.result : 'N/A'
            });
            
            if (jsep.type === 'answer' && event && event.result === 'ok' && !this.jsepProcessed) {
                this.jsepProcessed = true;
                console.log('✅ JSEP answer получен, обрабатываем вручную...');
                console.log('🔍 JSEP детали:', {
                    type: jsep.type,
                    sdp_preview: jsep.sdp ? jsep.sdp.substring(0, 100) + '...' : 'нет SDP',
                    sdp_length: jsep.sdp ? jsep.sdp.length : 0
                });
                
                // Проверяем webrtcStuff.pc вместо audioBridge.pc
                const webrtcStuff = this.audioBridge.webrtcStuff;
                console.log('🔍 webrtcStuff:', webrtcStuff ? 'найден' : 'не найден');
                if (webrtcStuff) {
                    console.log('🔍 webrtcStuff.pc:', webrtcStuff.pc ? 'найден' : 'не найден');
                    if (webrtcStuff.pc) {
                        console.log('🔍 PeerConnection состояние:', {
                            signalingState: webrtcStuff.pc.signalingState,
                            iceConnectionState: webrtcStuff.pc.iceConnectionState,
                            connectionState: webrtcStuff.pc.connectionState
                        });
                    }
                }
                
                // Обрабатываем JSEP вручную
                try {
                    this.audioBridge.handleRemoteJsep({ jsep: jsep });
                    console.log('✅ JSEP answer обработан, WebRTC соединение устанавливается...');
                } catch (error) {
                    console.error('❌ Ошибка при обработке JSEP:', error);
                    this.jsepProcessed = false;
                }
            }
        }
    },

    // Инициализация RNNoise
    async initRNNoise(stream) {
        // Проверяем наличие библиотеки (может быть window.webNoiseSuppressor или другой глобальный объект)
        const noiseSuppressor = typeof webNoiseSuppressor !== 'undefined' ? webNoiseSuppressor :
                                typeof window !== 'undefined' && window.webNoiseSuppressor ? window.webNoiseSuppressor :
                                null;
        
        if (!noiseSuppressor) {
            console.warn('⚠️ RNNoise библиотека не загружена. Убедитесь, что скрипт загружен.');
            return null;
        }
        
        try {
            if (!this.audioContext) {
                this.audioContext = new AudioContext({ sampleRate: 48000 });
            }
            
            // Создаем источник из потока
            const sourceNode = this.audioContext.createMediaStreamSource(stream);
            
            // Пытаемся создать RNNoise процессор
            let processor;
            if (typeof noiseSuppressor.createRnnoiseWorkletNode === 'function') {
                processor = await noiseSuppressor.createRnnoiseWorkletNode(this.audioContext);
            } else if (typeof noiseSuppressor.RnnoiseWorkletNode !== 'undefined') {
                // Альтернативный способ
                processor = new noiseSuppressor.RnnoiseWorkletNode(this.audioContext);
            } else {
                console.error('❌ Не найден метод создания RNNoise процессора');
                return null;
            }
            
            // Создаем назначение для обработанного потока
            const destinationNode = this.audioContext.createMediaStreamDestination();
            
            // Подключаем цепочку: источник -> RNNoise -> назначение
            sourceNode.connect(processor);
            processor.connect(destinationNode);
            
            this.rnnoiseProcessor = processor;
            this.rnnoiseSourceNode = sourceNode;
            this.rnnoiseDestinationNode = destinationNode;
            
            console.log('✅ RNNoise инициализирован');
            return destinationNode.stream;
        } catch (error) {
            console.error('❌ Ошибка инициализации RNNoise:', error);
            console.error('Детали ошибки:', error.stack);
            return null;
        }
    },
    
    // Включить/выключить RNNoise
    async toggleRNNoise() {
        if (!this.rnnoiseEnabled) {
            // Включаем RNNoise
            if (!this.localStream) {
                console.warn('⚠️ Нет активного аудио потока для RNNoise');
                return false;
            }
            
            const processedStream = await this.initRNNoise(this.localStream);
            if (!processedStream) {
                console.error('❌ Не удалось создать обработанный поток RNNoise');
                return false;
            }
            
            // Проверяем наличие треков в потоках
            if (!this.localStream || !this.localStream.getAudioTracks || this.localStream.getAudioTracks().length === 0) {
                console.error('❌ Локальный поток не содержит аудио треков');
                return false;
            }
            
            if (!processedStream.getAudioTracks || processedStream.getAudioTracks().length === 0) {
                console.error('❌ Обработанный поток не содержит аудио треков');
                return false;
            }
            
            // Заменяем трек в RTCPeerConnection
            const oldTrack = this.localStream.getAudioTracks()[0];
            const newTrack = processedStream.getAudioTracks()[0];
            
            if (!oldTrack || !newTrack) {
                console.error('❌ Не найдены треки для замены:', { oldTrack: !!oldTrack, newTrack: !!newTrack });
                if (processedStream) {
                    processedStream.getTracks().forEach(track => track.stop());
                }
                return false;
            }
            
            if (!this.audioBridge) {
                console.error('❌ audioBridge недоступен');
                processedStream.getTracks().forEach(track => track.stop());
                return false;
            }
            
            const webrtcStuff = this.audioBridge.webrtcStuff;
            if (!webrtcStuff || !webrtcStuff.pc) {
                console.error('❌ RTCPeerConnection недоступен');
                processedStream.getTracks().forEach(track => track.stop());
                return false;
            }
            
            const sender = webrtcStuff.pc.getSenders().find(s => 
                s.track && s.track.kind === 'audio' && s.track.id === oldTrack.id
            );
            
            if (!sender) {
                console.error('❌ Не найден RTCRtpSender для замены трека');
                processedStream.getTracks().forEach(track => track.stop());
                return false;
            }
            
            try {
                await sender.replaceTrack(newTrack);
                this.localStream.removeTrack(oldTrack);
                this.localStream.addTrack(newTrack);
                oldTrack.stop();
                this.rnnoiseEnabled = true;
                console.log('✅ RNNoise включен');
                
                // Сохраняем настройку
                try {
                    localStorage.setItem('rnnoiseEnabled', 'true');
                } catch (e) {
                    console.warn('Не удалось сохранить настройку RNNoise:', e);
                }
                
                return true;
            } catch (error) {
                console.error('❌ Ошибка при замене трека:', error);
                processedStream.getTracks().forEach(track => track.stop());
                return false;
            }
        } else {
            // Выключаем RNNoise - пересоздаем поток без обработки
            if (this.rnnoiseProcessor) {
                this.rnnoiseProcessor.disconnect();
                if (this.rnnoiseSourceNode) {
                    this.rnnoiseSourceNode.disconnect();
                }
                this.rnnoiseProcessor = null;
                this.rnnoiseSourceNode = null;
                this.rnnoiseDestinationNode = null;
            }
            
            // Пересоздаем поток без RNNoise
            const constraints = this.getAudioConstraints();
            const newStream = await navigator.mediaDevices.getUserMedia(constraints);
            
            if (!newStream || !newStream.getAudioTracks || newStream.getAudioTracks().length === 0) {
                console.error('❌ Не удалось создать новый поток без RNNoise');
                return false;
            }
            
            const newTrack = newStream.getAudioTracks()[0];
            
            if (!newTrack || !this.audioBridge) {
                console.error('❌ Новый трек не найден или audioBridge недоступен');
                if (newStream) {
                    newStream.getTracks().forEach(track => track.stop());
                }
                return false;
            }
            
            const webrtcStuff = this.audioBridge.webrtcStuff;
            if (!webrtcStuff || !webrtcStuff.pc) {
                console.error('❌ RTCPeerConnection недоступен');
                newStream.getTracks().forEach(track => track.stop());
                return false;
            }
            
            // Находим текущий активный трек из RTCPeerConnection
            const sender = webrtcStuff.pc.getSenders().find(s => 
                s.track && s.track.kind === 'audio'
            );
            
            if (!sender || !sender.track) {
                console.error('❌ Не найден RTCRtpSender или активный трек');
                newStream.getTracks().forEach(track => track.stop());
                return false;
            }
            
            const oldTrack = sender.track;
            
            try {
                await sender.replaceTrack(newTrack);
                this.localStream.removeTrack(oldTrack);
                this.localStream.addTrack(newTrack);
                oldTrack.stop();
                this.rnnoiseEnabled = false;
                console.log('✅ RNNoise выключен');
                
                // Сохраняем настройку
                try {
                    localStorage.setItem('rnnoiseEnabled', 'false');
                } catch (e) {
                    console.warn('Не удалось сохранить настройку RNNoise:', e);
                }
                
                return true;
            } catch (error) {
                console.error('❌ Ошибка при замене трека:', error);
                newStream.getTracks().forEach(track => track.stop());
                return false;
            }
        }
    },
    
    // Загрузить настройку RNNoise из localStorage (временно отключено)
    loadRNNoiseSetting() {
        // RNNoise временно отключен
        this.rnnoiseEnabled = false;
    },
    
    async setParticipantVolume(participantId, volume) {
        if (!this.channelId) {
            console.warn('⚠️ channelId не установлен, не могу установить громкость');
            return;
        }
        
        const participantIdNum = typeof participantId === 'string' ? parseInt(participantId, 10) : participantId;
        if (isNaN(participantIdNum)) {
            console.error('❌ Неверный participantId:', participantId);
            return;
        }
        
        const volumePercent = Math.round(volume * 100);
        this.participantVolumes.set(participantId, volume);
        
        try {
            await API.post(
                `${API.baseUrls.audio}/api/audio/AudioChannels/${this.channelId}/participants/${participantIdNum}/volume`,
                { volume: volumePercent }
            );
            console.log(`✅ Громкость участника ${participantIdNum} установлена на ${volumePercent}%`);
        } catch (error) {
            console.error(`❌ Ошибка при установке громкости для участника ${participantIdNum}:`, error);
        }
    },

    // Переключить микрофон (mute/unmute)
    toggleMute() {
        this.isMuted = !this.isMuted;
        if (this.audioBridge) {
            this.audioBridge.send({
                message: { request: 'configure', muted: this.isMuted }
            });
        }
        return this.isMuted;
    },

    // Отключиться
    async disconnect() {
        // Останавливаем периодический запрос участников
        if (this.participantsUpdateInterval) {
            clearInterval(this.participantsUpdateInterval);
            this.participantsUpdateInterval = null;
        }
        
        this.participantId = null;
        
        // Очищаем RNNoise ресурсы
        if (this.rnnoiseProcessor) {
            try {
                this.rnnoiseProcessor.disconnect();
            } catch (e) {
                console.warn('Ошибка при отключении RNNoise процессора:', e);
            }
            this.rnnoiseProcessor = null;
        }
        if (this.rnnoiseSourceNode) {
            try {
                this.rnnoiseSourceNode.disconnect();
            } catch (e) {
                console.warn('Ошибка при отключении RNNoise источника:', e);
            }
            this.rnnoiseSourceNode = null;
        }
        this.rnnoiseDestinationNode = null;
        if (this.audioContext && this.audioContext.state !== 'closed') {
            try {
                await this.audioContext.close();
            } catch (e) {
                console.warn('Ошибка при закрытии AudioContext:', e);
            }
        }
        this.audioContext = null;
        this.rnnoiseEnabled = false;
        
        // Очищаем управление громкостью
        this.gainNodes.clear();
        this.participantVolumes.clear();
        if (this.remoteAudioContext && this.remoteAudioContext.state !== 'closed') {
            try {
                this.remoteAudioContext.close();
            } catch (e) {
                console.warn('Ошибка при закрытии remoteAudioContext:', e);
            }
        }
        this.remoteAudioContext = null;
        
        if (this.audioBridge) {
            try {
                this.audioBridge.send({ message: { request: 'leave' } });
                this.audioBridge.detach();
            } catch (error) {
                console.error('Leave room error:', error);
            }
        }
        
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
        }
        
        // Удаляем аудио элемент для воспроизведения
        if (this.remoteAudio) {
            this.remoteAudio.pause();
            this.remoteAudio.srcObject = null;
            if (this.remoteAudio.parentNode) {
                this.remoteAudio.parentNode.removeChild(this.remoteAudio);
            }
            this.remoteAudio = null;
        }
        
        if (this.janus) {
            this.janus.destroy();
            this.janus = null;
        }
        
        this.audioBridge = null;
        this.roomId = null;
        this.isMuted = false;
        this.offerCreated = false; // Сбрасываем флаг при отключении
        this.jsepProcessed = false; // Сбрасываем флаг при отключении
    }
};

// Экспортируем в window для глобального доступа
// НЕ перезаписываем встроенный Audio (HTML5 Audio API)
(function() {
    try {
        if (typeof window !== 'undefined') {
            window.AudioModule = AudioModule;
            // НЕ перезаписываем window.Audio, так как это встроенный класс браузера
            console.log('✅ AudioModule экспортирован в window.AudioModule');
            console.log('✅ AudioModule методы:', Object.keys(AudioModule).slice(0, 10));
        } else {
            console.error('❌ window не определен, не могу экспортировать AudioModule');
        }
    } catch (error) {
        console.error('❌ Ошибка при экспорте AudioModule в window:', error);
    }
})();

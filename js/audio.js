// Создаем модуль с явным именем, чтобы избежать конфликтов
var AudioModule = {
    janus: null,
    publisherHandle: null, // Handle для публикации потока (Videoroom)
    subscriberHandles: new Map(), // Map<PublisherId, Handle> для подписок
    roomId: null,
    channelId: null,
    displayName: 'User',
    participantId: null, // Publisher ID в Videoroom
    localStream: null,
    isMuted: false,
    participantsUpdateInterval: null,
    
    // Настройки аудио
    audioSettings: {
        noiseSuppression: true,
        echoCancellation: true,
        autoGainControl: true
    },
    
    // RNNoise настройки
    rnnoiseEnabled: false,
    rnnoiseModule: null,
    audioContext: null, // Web Audio API контекст для микширования
    audioMixer: null, // Главный GainNode для микширования
    rnnoiseProcessor: null,
    rnnoiseSourceNode: null,
    rnnoiseDestinationNode: null,
    
    // Управление громкостью участников (клиентское микширование)
    streamVolumes: new Map(), // Map<PublisherId, {gainNode, source, volume, display}>
    remoteStreams: new Map(), // Map<PublisherId, MediaStream>

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
                                console.log('✅ Janus connected successfully, initializing Videoroom...');
                                // Инициализируем AudioContext для клиентского микширования
                                this.initializeAudioContext();
                                // Присоединяемся как Publisher
                                this.joinAsPublisher();
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

    // Инициализация AudioContext для клиентского микширования
    initializeAudioContext() {
        if (this.audioContext) {
            if (this.audioContext.state === 'suspended') {
                this.audioContext.resume();
            }
            return;
        }
        
        // Создаем AudioContext (должен быть вызван после пользовательского взаимодействия)
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        
        // Создаем главный микшер
        this.audioMixer = this.audioContext.createGain();
        this.audioMixer.gain.value = 1.0;
        this.audioMixer.connect(this.audioContext.destination);
        
        console.log('✅ AudioContext инициализирован для клиентского микширования');
    },

    // Присоединиться к Videoroom как Publisher
    async joinAsPublisher() {
        console.log('🔌 Присоединяемся к Videoroom как Publisher...');
        
        // Получаем локальный поток
        const constraints = this.getAudioConstraints();
        
        try {
            this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
            
            // Прикрепляем плагин Videoroom
            this.janus.attach({
                plugin: 'janus.plugin.videoroom',
                opaqueId: this.displayName,
                success: (handle) => {
                    this.publisherHandle = handle;
                    
                    // Присоединяемся к комнате как publisher
                    handle.send({
                        message: {
                            request: 'join',
                            room: this.roomId,
                            ptype: 'publisher', // Ключевое отличие: всегда publisher
                            display: this.displayName
                        },
                        success: (result) => {
                            console.log('✅ Присоединились к комнате как Publisher:', result);
                            
                            // Сохраняем participantId (publisher ID)
                            if (result.id) {
                                this.participantId = result.id;
                                console.log('✅ Сохранен participantId (publisher ID):', this.participantId);
                                
                                // Регистрируем подключение на сервере
                                if (this.channelId && this.participantId && window.registerAudioConnection) {
                                    window.registerAudioConnection(this.channelId, this.participantId);
                                }
                            }
                            
                            // Публикуем поток
                            const hasAudio = this.localStream.getAudioTracks().length > 0;
                            
                            handle.createOffer({
                                media: { 
                                    audioRecv: false, 
                                    videoRecv: false, 
                                    audioSend: hasAudio, 
                                    videoSend: false // Видео не используем
                                },
                                stream: this.localStream,
                                success: (jsep) => {
                                    handle.send({
                                        message: {
                                            request: 'publish',
                                            audio: hasAudio,
                                            video: false
                                        },
                                        jsep: jsep
                                    });
                                },
                                error: (error) => {
                                    console.error('❌ Create offer error:', error);
                                }
                            });
                            
                            // Подписываемся на существующих publishers
                            if (result.publishers && result.publishers.length > 0) {
                                console.log('📋 Найдено publishers:', result.publishers.length);
                                if (window.onParticipantsUpdate) {
                                    window.onParticipantsUpdate(result.publishers, this.participantId);
                                }
                                result.publishers.forEach(publisher => {
                                    this.subscribeToPublisher(publisher);
                                });
                            }
                            
                            // Устанавливаем периодический запрос списка publishers
                            if (this.participantsUpdateInterval) {
                                clearInterval(this.participantsUpdateInterval);
                            }
                            this.participantsUpdateInterval = setInterval(() => {
                                this.requestPublishersList();
                            }, 2000);
                        },
                        error: (error) => {
                            console.error('❌ Join error:', error);
                            if (window.onAudioError) {
                                window.onAudioError(error);
                            }
                        }
                    });
                    
                    // Обработка сообщений от сервера
                    handle.onmessage = (msg, jsep) => {
                        this.handlePublisherMessage(msg, jsep);
                    };
                    
                    handle.onlocalstream = (stream) => {
                        this.localStream = stream;
                        console.log('🎤 Локальный аудио поток получен:', stream);
                        if (window.onLocalStream) {
                            window.onLocalStream(stream);
                        }
                    };
                    
                    handle.webrtcState = (on) => {
                        console.log('WebRTC state:', on ? 'up' : 'down');
                        if (on) {
                            console.log('✅ WebRTC соединение установлено - аудио пакеты передаются!');
                            if (window.onAudioConnected) {
                                window.onAudioConnected();
                            }
                        } else {
                            console.log('❌ WebRTC соединение разорвано');
                        }
                    };
                },
                error: (error) => {
                    console.error('Videoroom attach error:', error);
                    if (window.onAudioError) {
                        window.onAudioError(error);
                    }
                }
            });
        } catch (error) {
            console.error('❌ Ошибка получения медиа:', error);
            if (window.onAudioError) {
                window.onAudioError(error.message || 'Ошибка доступа к микрофону');
            }
        }
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
        if (!this.publisherHandle || !this.localStream) {
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
            const webrtcStuff = this.publisherHandle.webrtcStuff;
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

    // Старые методы удалены - используются новые методы для Videoroom
    // requestParticipantsList -> requestPublishersList
    // joinRoom -> joinAsPublisher (вызывается автоматически при init)
    // handleMessage -> handlePublisherMessage

    // Установить громкость потока (клиентское управление)
    setParticipantVolume(publisherId, volume) {
        const streamData = this.streamVolumes.get(publisherId);
        if (streamData && streamData.gainNode) {
            // Ограничиваем значение (0.0 - 2.0)
            const clampedVolume = Math.max(0.0, Math.min(2.0, volume));
            
            // Устанавливаем громкость
            streamData.gainNode.gain.value = clampedVolume;
            streamData.volume = clampedVolume;
            
            console.log(`✅ Громкость потока ${publisherId} установлена: ${Math.round(clampedVolume * 100)}%`);
        } else {
            console.warn(`⚠️ Поток ${publisherId} не найден для установки громкости`);
        }
    },

    // Переключить микрофон (mute/unmute)
    toggleMute() {
        this.isMuted = !this.isMuted;
        if (this.publisherHandle && this.localStream) {
            // Отключаем трек в WebRTC transceiver
            if (this.publisherHandle.webrtcStuff && this.publisherHandle.webrtcStuff.pc) {
                const pc = this.publisherHandle.webrtcStuff.pc;
                const transceivers = pc.getTransceivers();
                
                transceivers.forEach(transceiver => {
                    if (transceiver.sender && transceiver.sender.track && 
                        transceiver.sender.track.kind === 'audio') {
                        transceiver.sender.track.enabled = !this.isMuted;
                    }
                });
            }
            
            // Также отключаем локальные треки
            this.localStream.getAudioTracks().forEach(track => {
                track.enabled = !this.isMuted;
            });
        }
        console.log(`Микрофон ${this.isMuted ? 'отключен' : 'включен'}`);
        return this.isMuted;
    },

    // Отключиться
    async disconnect() {
        // Регистрируем отключение на сервере перед очисткой
        if (this.channelId && this.participantId && window.registerAudioDisconnection) {
            await window.registerAudioDisconnection(this.channelId, this.participantId);
        }
        
        // Останавливаем периодический запрос publishers
        if (this.participantsUpdateInterval) {
            clearInterval(this.participantsUpdateInterval);
            this.participantsUpdateInterval = null;
        }
        
        // Закрываем все subscriber handles
        this.subscriberHandles.forEach((handle, publisherId) => {
            try {
                handle.detach();
            } catch (e) {
                console.warn(`Ошибка при закрытии subscriber handle для ${publisherId}:`, e);
            }
        });
        this.subscriberHandles.clear();
        
        // Отключаем все потоки от микшера
        this.streamVolumes.forEach((streamData, publisherId) => {
            try {
                streamData.source.disconnect();
                streamData.gainNode.disconnect();
            } catch (e) {
                console.warn(`Ошибка при отключении потока ${publisherId}:`, e);
            }
        });
        this.streamVolumes.clear();
        this.remoteStreams.clear();
        
        // Закрываем publisher handle
        if (this.publisherHandle) {
            try {
                this.publisherHandle.send({ message: { request: 'leave' } });
                this.publisherHandle.detach();
            } catch (error) {
                console.error('Leave room error:', error);
            }
            this.publisherHandle = null;
        }
        
        // Останавливаем локальный поток
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
        }
        
        // Закрываем AudioContext
        if (this.audioContext && this.audioContext.state !== 'closed') {
            try {
                await this.audioContext.close();
            } catch (e) {
                console.warn('Ошибка при закрытии AudioContext:', e);
            }
        }
        this.audioContext = null;
        this.audioMixer = null;
        
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
        this.rnnoiseEnabled = false;
        
        // Закрываем Janus соединение
        if (this.janus) {
            this.janus.destroy();
            this.janus = null;
        }
        
        this.participantId = null;
        this.roomId = null;
        this.isMuted = false;
    },

    // Обработка сообщений от Publisher handle
    handlePublisherMessage(msg, jsep) {
        console.log('📨 Получено сообщение от Publisher:', msg);
        
        // Обработка JSEP answer от сервера
        if (jsep) {
            this.publisherHandle.handleRemoteJsep({ jsep: jsep });
        }
        
        // Извлекаем данные события
        let event = null;
        if (msg.plugindata && msg.plugindata.data) {
            event = msg.plugindata.data;
        } else if (msg.videoroom) {
            event = msg;
        }
        
        if (event) {
            // Новые publishers
            if (event.publishers) {
                console.log('📋 Новые publishers:', event.publishers.length);
                event.publishers.forEach(publisher => {
                    // Пропускаем себя
                    if (publisher.id !== this.participantId) {
                        this.subscribeToPublisher(publisher);
                    }
                });
                
                // Обновляем UI
                if (window.onParticipantsUpdate) {
                    window.onParticipantsUpdate(event.publishers, this.participantId);
                }
            }
            
            // Удаленные publishers
            if (event.unpublished) {
                console.log('🔴 Publisher отключился:', event.unpublished);
                this.removePublisher(event.unpublished);
            }
            
            // Ошибки
            if (event.error_code) {
                console.error('❌ Ошибка от Janus:', event.error_code, event.error);
                if (window.onAudioError) {
                    window.onAudioError(event.error || `Ошибка ${event.error_code}`);
                }
            }
        }
    },

    // Подписаться на поток другого publisher
    subscribeToPublisher(publisher) {
        const publisherId = publisher.id;
        const displayName = publisher.display || `Publisher ${publisherId}`;
        
        // Проверяем, не подписаны ли уже
        if (this.subscriberHandles.has(publisherId)) {
            console.log(`⚠️ Уже подписаны на publisher ${publisherId}`);
            return;
        }
        
        console.log(`📡 Подписываемся на publisher ${publisherId} (${displayName})`);
        
        // Создаем отдельный handle для каждого subscriber
        this.janus.attach({
            plugin: 'janus.plugin.videoroom',
            opaqueId: `subscriber-${publisherId}`,
            success: (handle) => {
                this.subscriberHandles.set(publisherId, handle);
                
                // Присоединяемся как subscriber
                handle.send({
                    message: {
                        request: 'join',
                        room: this.roomId,
                        ptype: 'subscriber', // Ключевое отличие: subscriber
                        feed: publisherId, // ID publisher, на которого подписываемся
                        private_id: publisher.private_id
                    },
                    success: (result) => {
                        console.log(`✅ Подписались на publisher ${publisherId}`);
                        // Сервер отправит offer в onmessage
                    },
                    error: (error) => {
                        console.error(`❌ Ошибка подписки на publisher ${publisherId}:`, error);
                        this.subscriberHandles.delete(publisherId);
                    }
                });
                
                // Обработка сообщений
                handle.onmessage = (msg, jsep) => {
                    if (jsep) {
                        // Получили offer от сервера
                        handle.createAnswer({
                            jsep: jsep,
                            media: { 
                                audioRecv: true, 
                                videoRecv: false, 
                                audioSend: false, 
                                videoSend: false 
                            },
                            success: (answerJsep) => {
                                handle.send({
                                    message: { request: 'start' },
                                    jsep: answerJsep
                                });
                            },
                            error: (error) => {
                                console.error(`❌ Ошибка создания answer для ${publisherId}:`, error);
                            }
                        });
                    }
                    
                    // Когда поток начался
                    if (msg.plugindata && msg.plugindata.data && msg.plugindata.data.started === 'ok') {
                        console.log(`✅ Поток от publisher ${publisherId} начался`);
                        // Получаем поток из RTCPeerConnection
                        setTimeout(() => {
                            const pc = handle.webrtcStuff.pc;
                            if (pc) {
                                const receivers = pc.getReceivers();
                                const remoteStream = new MediaStream();
                                
                                receivers.forEach(receiver => {
                                    if (receiver.track && receiver.track.kind === 'audio') {
                                        remoteStream.addTrack(receiver.track);
                                    }
                                });
                                
                                if (remoteStream.getAudioTracks().length > 0) {
                                    this.handleRemoteStream(remoteStream, publisherId, displayName);
                                }
                            }
                        }, 500);
                    }
                };
                
                // Альтернативный способ получения потока
                handle.onremotestream = (stream) => {
                    this.handleRemoteStream(stream, publisherId, displayName);
                };
                
                handle.ontrack = (event) => {
                    if (event.streams && event.streams.length > 0) {
                        this.handleRemoteStream(event.streams[0], publisherId, displayName);
                    }
                };
            },
            error: (error) => {
                console.error(`❌ Ошибка создания subscriber handle для ${publisherId}:`, error);
            }
        });
    },

    // Обработка удаленного потока - подключение к микшеру
    handleRemoteStream(stream, publisherId, displayName) {
        // Проверяем, не обработан ли уже
        if (this.remoteStreams.has(publisherId)) {
            return;
        }
        
        this.remoteStreams.set(publisherId, stream);
        
        // Подключаем аудио к микшеру
        if (this.audioContext && this.audioMixer) {
            this.processAudioForMixing(stream, publisherId, displayName);
        } else {
            console.warn('⚠️ AudioContext не инициализирован');
        }
    },

    // Обработка аудио потока для микширования
    processAudioForMixing(stream, publisherId, displayName) {
        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length === 0) {
            return;
        }
        
        try {
            // Создаем источник из потока
            const source = this.audioContext.createMediaStreamSource(stream);
            
            // Создаем GainNode для управления громкостью
            const gainNode = this.audioContext.createGain();
            gainNode.gain.value = 1.0; // Начальная громкость 100%
            
            // Подключаем: source -> gainNode -> audioMixer -> destination
            source.connect(gainNode);
            gainNode.connect(this.audioMixer);
            
            // Сохраняем для управления
            this.streamVolumes.set(publisherId, {
                gainNode: gainNode,
                source: source,
                volume: 1.0,
                display: displayName
            });
            
            console.log(`✅ Аудио поток ${publisherId} (${displayName}) подключен к микшеру`);
        } catch (error) {
            console.error('❌ Ошибка обработки аудио:', error);
        }
    },

    // Удалить publisher
    removePublisher(publisherId) {
        console.log(`🔴 Удаляем publisher ${publisherId}`);
        
        // Отключаем поток от микшера
        const streamData = this.streamVolumes.get(publisherId);
        if (streamData) {
            try {
                streamData.source.disconnect();
                streamData.gainNode.disconnect();
            } catch (e) {
                console.warn(`Ошибка при отключении потока ${publisherId}:`, e);
            }
            this.streamVolumes.delete(publisherId);
        }
        
        // Удаляем stream
        this.remoteStreams.delete(publisherId);
        
        // Закрываем subscriber handle
        const handle = this.subscriberHandles.get(publisherId);
        if (handle) {
            try {
                handle.detach();
            } catch (e) {
                console.warn(`Ошибка при закрытии subscriber handle для ${publisherId}:`, e);
            }
            this.subscriberHandles.delete(publisherId);
        }
        
        // Обновляем UI
        if (window.onParticipantsUpdate) {
            const publishers = Array.from(this.streamVolumes.values()).map(s => ({
                id: Array.from(this.streamVolumes.entries()).find(([id, _]) => s === this.streamVolumes.get(id))?.[0],
                display: s.display
            }));
            window.onParticipantsUpdate(publishers, this.participantId);
        }
    },

    // Запросить список publishers
    requestPublishersList() {
        if (this.publisherHandle && this.roomId) {
            console.log('📋 Запрашиваем список publishers для комнаты', this.roomId, '...');
            this.publisherHandle.send({
                message: { 
                    request: 'list',
                    room: this.roomId
                }
            });
        } else {
            console.warn('⚠️ publisherHandle или roomId не доступен');
        }
    },

    // Старые методы удалены - используются новые методы для Videoroom
    // requestParticipantsList -> requestPublishersList
    // joinRoom -> joinAsPublisher (вызывается автоматически при init)
    // handleMessage -> handlePublisherMessage

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
            
            if (!this.publisherHandle) {
                console.error('❌ publisherHandle недоступен');
                processedStream.getTracks().forEach(track => track.stop());
                return false;
            }
            
            const webrtcStuff = this.publisherHandle.webrtcStuff;
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
            
            if (!newTrack || !this.publisherHandle) {
                console.error('❌ Новый трек не найден или publisherHandle недоступен');
                if (newStream) {
                    newStream.getTracks().forEach(track => track.stop());
                }
                return false;
            }
            
            const webrtcStuff = this.publisherHandle.webrtcStuff;
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
        
        console.log(`📤 Отправка запроса на изменение громкости: ChannelId=${this.channelId}, ParticipantId=${participantIdNum}, Volume=${volumePercent}%`);
        
        try {
            const response = await API.post(
                `${API.baseUrls.audio}/api/audio/AudioChannels/${this.channelId}/participants/${participantIdNum}/volume`,
                { volume: volumePercent }
            );
            console.log(`✅ Громкость участника ${participantIdNum} установлена на ${volumePercent}% через Janus Gateway`, response);
        } catch (error) {
            console.error(`❌ Ошибка при установке громкости для участника ${participantIdNum}:`, error);
        }
    },

    // Дублирующиеся методы удалены - используются методы выше (строки 441 и 467)
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

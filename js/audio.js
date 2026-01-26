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
        autoGainControl: true,
        monitorLocalAudio: false // Воспроизведение локального аудио для мониторинга (side-tone) - по умолчанию выключено
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
            
            // Убеждаемся, что все локальные треки enabled и не muted перед публикацией
            this.localStream.getAudioTracks().forEach(track => {
                track.enabled = true;
                // muted - read-only свойство для локальных треков, но можем проверить
                if (track.muted) {
                    console.warn(`⚠️ Локальный трек ${track.id} muted, пытаемся исправить...`);
                }
                console.log(`✅ Локальный трек ${track.id}: enabled=${track.enabled}, muted=${track.muted}, readyState=${track.readyState}`);
            });
            
            // Убеждаемся, что AudioContext активен
            if (this.audioContext && this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }
            
            // Подключаем локальный поток к микшеру для мониторинга (side-tone) только если включено в настройках
            // Это позволяет слышать свой голос в наушниках
            if (this.audioSettings.monitorLocalAudio && this.audioContext && this.audioMixer && this.localStream) {
                try {
                    const source = this.audioContext.createMediaStreamSource(this.localStream);
                    const gainNode = this.audioContext.createGain();
                    gainNode.gain.value = 0.3; // 30% громкости для мониторинга
                    source.connect(gainNode);
                    gainNode.connect(this.audioMixer);
                    console.log('🎧 Локальный аудио поток подключен для мониторинга (side-tone)');
                } catch (error) {
                    console.warn('⚠️ Не удалось подключить локальный поток для мониторинга:', error);
                }
            }
            
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
                            // participantId будет установлен в handlePublisherMessage при получении события 'joined'
                            
                            // Убеждаемся, что все треки enabled перед публикацией
                            this.localStream.getAudioTracks().forEach(track => {
                                track.enabled = true;
                                console.log(`✅ Перед публикацией трек ${track.id}: enabled=${track.enabled}, muted=${track.muted}, readyState=${track.readyState}`);
                            });
                            
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
                                    // Убеждаемся, что треки enabled перед отправкой publish
                                    this.localStream.getAudioTracks().forEach(track => {
                                        track.enabled = true;
                                    });
                                    
                                    // Контролируем через RTCPeerConnection и RTCRtpTransceiver
                                    if (handle.webrtcStuff && handle.webrtcStuff.pc) {
                                        const pc = handle.webrtcStuff.pc;
                                        
                                        // Убеждаемся что все transceivers настроены правильно
                                        const transceivers = pc.getTransceivers();
                                        transceivers.forEach(transceiver => {
                                            if (transceiver.sender && transceiver.sender.track && transceiver.sender.track.kind === 'audio') {
                                                transceiver.sender.track.enabled = true;
                                                // Убеждаемся что direction правильный
                                                if (transceiver.direction !== 'sendonly' && transceiver.direction !== 'sendrecv') {
                                                    transceiver.direction = 'sendonly';
                                                }
                                                console.log(`✅ RTCRtpTransceiver: track=${transceiver.sender.track.id}, enabled=${transceiver.sender.track.enabled}, direction=${transceiver.direction}`);
                                            }
                                        });
                                        
                                        // Также проверяем senders
                                        const senders = pc.getSenders();
                                        senders.forEach(sender => {
                                            if (sender.track && sender.track.kind === 'audio') {
                                                sender.track.enabled = true;
                                                console.log(`✅ RTCRtpSender перед publish: ${sender.track.id} enabled=${sender.track.enabled}, muted=${sender.track.muted}`);
                                            }
                                        });
                                    }
                                    
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
                            this.requestPublishersList();
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
                        
                        // Убеждаемся, что все треки enabled и не muted
                        stream.getAudioTracks().forEach(track => {
                            track.enabled = true;
                            console.log(`✅ onlocalstream трек ${track.id}: enabled=${track.enabled}, muted=${track.muted}, readyState=${track.readyState}`);
                        });
                        
                        // Убеждаемся, что треки отправляются через RTCRtpSender
                        if (handle.webrtcStuff && handle.webrtcStuff.pc) {
                            const pc = handle.webrtcStuff.pc;
                            const senders = pc.getSenders();
                            senders.forEach(sender => {
                                if (sender.track && sender.track.kind === 'audio') {
                                    sender.track.enabled = true;
                                    console.log(`✅ RTCRtpSender трек ${sender.track.id}: enabled=${sender.track.enabled}, muted=${sender.track.muted}`);
                                }
                            });
                        }
                        
                        // Мониторинг локального потока уже настроен в joinAsPublisher при получении getUserMedia
                        // Здесь просто обновляем ссылку на поток
                        
                        if (window.onLocalStream) {
                            window.onLocalStream(stream);
                        }
                    };
                    
                    handle.webrtcState = (on) => {
                        console.log('WebRTC state:', on ? 'up' : 'down');
                        if (on) {
                            console.log('✅ WebRTC соединение установлено - аудио пакеты передаются!');
                            
                            // Убеждаемся, что все треки enabled после установки соединения
                            if (this.localStream) {
                                this.localStream.getAudioTracks().forEach(track => {
                                    track.enabled = true;
                                    console.log(`✅ WebRTC up трек ${track.id}: enabled=${track.enabled}, muted=${track.muted}`);
                                });
                            }
                            
                            // Контролируем через RTCPeerConnection и RTCRtpTransceiver
                            if (handle.webrtcStuff && handle.webrtcStuff.pc) {
                                const pc = handle.webrtcStuff.pc;
                                
                                // Убеждаемся что все transceivers настроены правильно
                                const transceivers = pc.getTransceivers();
                                transceivers.forEach(transceiver => {
                                    if (transceiver.sender && transceiver.sender.track && transceiver.sender.track.kind === 'audio') {
                                        transceiver.sender.track.enabled = true;
                                        // Убеждаемся что direction правильный
                                        if (transceiver.direction !== 'sendonly' && transceiver.direction !== 'sendrecv') {
                                            transceiver.direction = 'sendonly';
                                        }
                                        console.log(`✅ WebRTC up RTCRtpTransceiver: track=${transceiver.sender.track.id}, enabled=${transceiver.sender.track.enabled}, direction=${transceiver.direction}, muted=${transceiver.sender.track.muted}`);
                                    }
                                });
                                
                                // Также проверяем senders
                                const senders = pc.getSenders();
                                senders.forEach(sender => {
                                    if (sender.track && sender.track.kind === 'audio') {
                                        sender.track.enabled = true;
                                        console.log(`✅ WebRTC up RTCRtpSender: ${sender.track.id} enabled=${sender.track.enabled}, muted=${sender.track.muted}`);
                                    }
                                });
                            }
                            
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
        // Преобразуем publisherId в строку для поиска в Map
        const publisherIdStr = String(publisherId);
        
        // Если volume больше 1, предполагаем что это проценты (0-100), преобразуем в 0.0-1.0
        let normalizedVolume = volume;
        if (volume > 1.0) {
            normalizedVolume = volume / 100.0;
        }
        
        const streamData = this.streamVolumes.get(publisherIdStr);
        if (!streamData) {
            // Пробуем найти по числовому ID
            const numericId = typeof publisherId === 'string' ? parseInt(publisherId, 10) : publisherId;
            const streamDataByNum = this.streamVolumes.get(String(numericId));
            if (streamDataByNum && streamDataByNum.gainNode) {
                const clampedVolume = Math.max(0.0, Math.min(2.0, normalizedVolume));
                streamDataByNum.gainNode.gain.value = clampedVolume;
                streamDataByNum.volume = clampedVolume;
                console.log(`✅ Громкость потока ${numericId} установлена: ${Math.round(clampedVolume * 100)}%`);
                return;
            }
            console.warn(`⚠️ Поток ${publisherId} не найден для установки громкости. Доступные потоки:`, Array.from(this.streamVolumes.keys()));
            return;
        }
        
        if (streamData.gainNode) {
            // Ограничиваем значение (0.0 - 2.0)
            const clampedVolume = Math.max(0.0, Math.min(2.0, normalizedVolume));
            
            // Устанавливаем громкость
            streamData.gainNode.gain.value = clampedVolume;
            streamData.volume = clampedVolume;
            
            console.log(`✅ Громкость потока ${publisherIdStr} установлена: ${Math.round(clampedVolume * 100)}%`);
        } else {
            console.warn(`⚠️ GainNode не найден для потока ${publisherIdStr}`);
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
            // Событие 'joined' - мы присоединились к комнате
            if (event.videoroom === 'joined' && event.id) {
                this.participantId = event.id;
                console.log('✅ Сохранен participantId (publisher ID):', this.participantId);
                
                // Регистрируем подключение на сервере
                if (this.channelId && this.participantId && window.registerAudioConnection) {
                    window.registerAudioConnection(this.channelId, this.participantId);
                }
                
                // Запрашиваем список publishers после присоединения
                this.requestPublishersList();
            }
            
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
                    
                    // Когда поток начался (как в инструкции)
                    if (msg.plugindata && msg.plugindata.data && msg.plugindata.data.started === 'ok') {
                        console.log(`✅ Поток от publisher ${publisherId} начался`);
                        // Получаем поток из RTCPeerConnection (как в инструкции)
                        setTimeout(() => {
                            const pc = handle.webrtcStuff.pc;
                            if (pc) {
                                // Проверяем статистику соединения
                                pc.getStats().then(stats => {
                                    stats.forEach(report => {
                                        if (report.type === 'inbound-rtp' && report.kind === 'audio') {
                                            console.log(`📊 Статистика аудио для ${publisherId}:`, {
                                                bytesReceived: report.bytesReceived,
                                                packetsReceived: report.packetsReceived,
                                                packetsLost: report.packetsLost,
                                                jitter: report.jitter,
                                                audioLevel: report.audioLevel
                                            });
                                            
                                            if (report.bytesReceived === 0) {
                                                console.warn(`⚠️ Нет полученных байт для ${publisherId}!`);
                                            }
                                        }
                                    });
                                });
                                
                                const receivers = pc.getReceivers();
                                const remoteStream = new MediaStream();
                                
                                receivers.forEach(receiver => {
                                    if (receiver.track && receiver.track.kind === 'audio') {
                                        console.log(`🔍 Receiver трек ${receiver.track.id}: enabled=${receiver.track.enabled}, muted=${receiver.track.muted}, readyState=${receiver.track.readyState}`);
                                        remoteStream.addTrack(receiver.track);
                                    }
                                });
                                
                                if (remoteStream.getAudioTracks().length > 0) {
                                    console.log(`✅ Создан поток из receivers для ${publisherId}, треков: ${remoteStream.getAudioTracks().length}`);
                                    this.handleRemoteStream(remoteStream, publisherId, displayName);
                                } else {
                                    console.warn(`⚠️ Нет аудио треков в receivers для ${publisherId}`);
                                }
                            }
                        }, 500);
                    }
                };
                
                // Обработка удаленного трека (новый API Janus.js)
                handle.onremotetrack = (track, mid, on) => {
                    console.log(`🔊 onremotetrack вызван: publisherId=${publisherId}, track.kind=${track.kind}, on=${on}, mid=${mid}, muted=${track.muted}`);
                    
                    // Проверяем статистику WebRTC соединения
                    if (handle.webrtcStuff && handle.webrtcStuff.pc) {
                        const pc = handle.webrtcStuff.pc;
                        pc.getStats().then(stats => {
                            stats.forEach(report => {
                                if (report.type === 'inbound-rtp' && report.kind === 'audio') {
                                    console.log(`📊 [onremotetrack] Статистика аудио для ${publisherId}:`, {
                                        bytesReceived: report.bytesReceived,
                                        packetsReceived: report.packetsReceived,
                                        packetsLost: report.packetsLost,
                                        jitter: report.jitter,
                                        audioLevel: report.audioLevel,
                                        totalAudioEnergy: report.totalAudioEnergy
                                    });
                                    
                                    if (report.bytesReceived === 0) {
                                        console.warn(`⚠️ [onremotetrack] Нет полученных байт для ${publisherId}!`);
                                    }
                                }
                            });
                        });
                    }
                    
                    if (track.kind === 'audio' && on) {
                        // Если трек muted - ждем unmute перед обработкой
                        if (track.muted) {
                            console.log(`⏳ Трек ${track.id} muted, ждем unmute для ${publisherId}...`);
                            const unmuteHandler = () => {
                                console.log(`🔊 Трек ${track.id} unmuted для ${publisherId}, ждем 100мс перед обработкой...`);
                                track.removeEventListener('unmute', unmuteHandler);
                                // Небольшая задержка чтобы трек точно был активен
                                setTimeout(() => {
                                    if (!track.muted && track.readyState === 'live') {
                                        console.log(`✅ Трек ${track.id} активен, создаем источник...`);
                                        const stream = new MediaStream([track]);
                                        this.handleRemoteStream(stream, publisherId, displayName);
                                    } else {
                                        console.warn(`⚠️ Трек ${track.id} все еще не активен после unmute`);
                                    }
                                }, 100);
                            };
                            track.addEventListener('unmute', unmuteHandler);
                            
                            // Проверка через таймаут на случай если событие уже произошло
                            setTimeout(() => {
                                if (!track.muted && track.readyState === 'live') {
                                    console.log(`🔊 Трек ${track.id} уже unmuted (таймаут) для ${publisherId}, обрабатываем...`);
                                    track.removeEventListener('unmute', unmuteHandler);
                                    const stream = new MediaStream([track]);
                                    this.handleRemoteStream(stream, publisherId, displayName);
                                }
                            }, 1000);
                        } else {
                            // Трек не muted - обрабатываем сразу, но проверяем readyState
                            if (track.readyState === 'live') {
                                console.log(`🔊 Трек ${track.id} не muted и live, обрабатываем сразу для ${publisherId}`);
                                const stream = new MediaStream([track]);
                                this.handleRemoteStream(stream, publisherId, displayName);
                            } else {
                                console.log(`⏳ Трек ${track.id} не muted но readyState=${track.readyState}, ждем...`);
                                const liveHandler = () => {
                                    console.log(`✅ Трек ${track.id} стал live, обрабатываем...`);
                                    track.removeEventListener('live', liveHandler);
                                    const stream = new MediaStream([track]);
                                    this.handleRemoteStream(stream, publisherId, displayName);
                                };
                                track.addEventListener('live', liveHandler);
                            }
                        }
                    } else if (!on) {
                        console.log(`🔇 Трек от publisher ${publisherId} остановлен`);
                    }
                };
                
                // Альтернативный способ получения потока (старый API)
                handle.onremotestream = (stream) => {
                    console.log(`🔊 [Legacy] Получен удаленный поток от publisher ${publisherId}, треков: ${stream.getAudioTracks().length}`);
                    this.handleRemoteStream(stream, publisherId, displayName);
                };
                
                handle.ontrack = (event) => {
                    console.log(`🔊 ontrack вызван: publisherId=${publisherId}, streams.length=${event.streams ? event.streams.length : 0}`);
                    if (event.streams && event.streams.length > 0) {
                        console.log(`🔊 [ontrack] Получен поток от publisher ${publisherId}`);
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
        // Преобразуем publisherId в строку для консистентности
        const publisherIdStr = String(publisherId);
        
        console.log(`🔊 handleRemoteStream вызван: publisherId=${publisherId} (строка: ${publisherIdStr}), displayName=${displayName}`);
        
        // Проверяем состояние треков
        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length === 0) {
            console.warn(`⚠️ Нет аудио треков в потоке для ${publisherIdStr}`);
            return;
        }
        
        // Проверяем, есть ли muted треки
        const mutedTracks = audioTracks.filter(track => track.muted);
        if (mutedTracks.length > 0) {
            console.warn(`⚠️ Поток ${publisherIdStr} содержит muted треки, пропускаем до unmute`);
            return;
        }
        
        // Проверяем, есть ли уже источник для этого потока
        const existingData = this.streamVolumes.get(publisherIdStr);
        if (existingData && existingData.source) {
            console.log(`⚠️ Поток ${publisherIdStr} уже обработан, источник уже создан`);
            
            // ВАЖНО: Если источник был создан из muted трека, он может не работать
            // Пересоздаем источник из нового unmuted потока
            console.log(`🔄 Пересоздаем источник ${publisherIdStr} из unmuted потока...`);
            try {
                existingData.source.disconnect();
                existingData.gainNode.disconnect();
            } catch (e) {
                console.warn(`⚠️ Ошибка отключения старого источника:`, e);
            }
            this.streamVolumes.delete(publisherIdStr);
            // Продолжаем создавать новый источник
        }
        
        // Сохраняем поток
        this.remoteStreams.set(publisherIdStr, stream);
        
        // Подключаем аудио к микшеру
        if (this.audioContext && this.audioMixer) {
            // Проверяем состояние AudioContext
            if (this.audioContext.state === 'suspended') {
                console.warn('⚠️ AudioContext suspended, возобновляем...');
                this.audioContext.resume().then(() => {
                    this.processAudioForMixing(stream, publisherId, displayName);
                });
                return;
            }
            
            // Проверяем подключение audioMixer
            if (this.audioMixer.numberOfOutputs === 0) {
                console.warn('⚠️ audioMixer не подключен к destination, переподключаем...');
                this.audioMixer.connect(this.audioContext.destination);
            }
            
            this.processAudioForMixing(stream, publisherId, displayName);
        } else {
            console.warn(`⚠️ AudioContext не инициализирован: audioContext=${!!this.audioContext}, audioMixer=${!!this.audioMixer}`);
        }
    },

    // Обработка аудио потока для микширования
    processAudioForMixing(stream, publisherId, displayName) {
        // Преобразуем publisherId в строку для консистентности
        const publisherIdStr = String(publisherId);
        
        console.log(`🎵 processAudioForMixing ВЫЗВАН: publisherId=${publisherId} (строка: ${publisherIdStr}), displayName=${displayName}`);
        console.log(`🔍 Поток:`, stream);
        console.log(`🔍 Треков в потоке:`, stream.getAudioTracks().length);
        
        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length === 0) {
            console.warn(`⚠️ Нет аудио треков в потоке для ${publisherIdStr}`);
            return;
        }
        
        // Проверяем состояние треков перед созданием источника
        audioTracks.forEach(track => {
            console.log(`🔍 Трек ${track.id}: enabled=${track.enabled}, muted=${track.muted}, readyState=${track.readyState}`);
        });
        
        // Если есть muted треки - не создаем источник
        const mutedTracks = audioTracks.filter(track => track.muted);
        if (mutedTracks.length > 0) {
            console.warn(`⚠️ Поток ${publisherIdStr} содержит ${mutedTracks.length} muted треков, не создаем источник`);
            return;
        }
        
        console.log(`✅ Все треки unmuted, создаем источник для ${publisherIdStr}...`);
        
        try {
            // Убеждаемся, что AudioContext активен
            if (this.audioContext.state === 'suspended') {
                console.warn('⚠️ AudioContext suspended в processAudioForMixing');
                this.audioContext.resume().then(() => {
                    this.processAudioForMixing(stream, publisherId, displayName);
                });
                return;
            }
            
            // Убеждаемся, что audioMixer подключен
            if (this.audioMixer.numberOfOutputs === 0) {
                console.warn('⚠️ audioMixer не подключен в processAudioForMixing, переподключаем...');
                this.audioMixer.connect(this.audioContext.destination);
            }
            
            // Создаем источник из потока
            const source = this.audioContext.createMediaStreamSource(stream);
            console.log(`✅ Источник создан для ${publisherIdStr}, source:`, source);
            
            // Создаем GainNode для управления громкостью
            const gainNode = this.audioContext.createGain();
            gainNode.gain.value = 1.0; // Начальная громкость 100%
            console.log(`✅ GainNode создан для ${publisherIdStr}, gain=${gainNode.gain.value}`);
            
            // Подключаем: source -> gainNode -> audioMixer -> destination
            source.connect(gainNode);
            console.log(`✅ source подключен к gainNode для ${publisherIdStr}`);
            
            gainNode.connect(this.audioMixer);
            console.log(`✅ gainNode подключен к audioMixer для ${publisherIdStr}`);
            
            console.log(`🔗 Подключено: source (${source.numberOfOutputs} outputs) -> gainNode (${gainNode.numberOfInputs} inputs, ${gainNode.numberOfOutputs} outputs) -> audioMixer (${this.audioMixer.numberOfInputs} inputs, ${this.audioMixer.numberOfOutputs} outputs)`);
            
            // Добавляем обработчик для проверки активности трека
            audioTracks.forEach(track => {
                track.addEventListener('ended', () => {
                    console.warn(`⚠️ Трек ${track.id} от ${publisherIdStr} завершен`);
                });
                
                track.addEventListener('mute', () => {
                    console.warn(`⚠️ Трек ${track.id} от ${publisherIdStr} стал muted!`);
                });
                
                track.addEventListener('unmute', () => {
                    console.log(`✅ Трек ${track.id} от ${publisherIdStr} стал unmuted`);
                });
                
                // Проверяем активность трека через некоторое время
                setTimeout(() => {
                    console.log(`🔍 Проверка трека ${track.id} через 2 сек: enabled=${track.enabled}, muted=${track.muted}, readyState=${track.readyState}`);
                    if (track.muted) {
                        console.warn(`⚠️ Трек ${track.id} все еще muted после 2 секунд!`);
                    }
                    
                    // Проверяем, есть ли данные в потоке через AudioContext
                    try {
                        const testSource = this.audioContext.createMediaStreamSource(new MediaStream([track]));
                        const analyser = this.audioContext.createAnalyser();
                        analyser.fftSize = 256;
                        testSource.connect(analyser);
                        
                        const dataArray = new Uint8Array(analyser.frequencyBinCount);
                        analyser.getByteFrequencyData(dataArray);
                        
                        const max = Math.max(...dataArray);
                        console.log(`🔍 Анализ трека ${track.id}: максимальная частота=${max}, есть данные=${max > 0}`);
                        
                        if (max === 0) {
                            console.warn(`⚠️ Трек ${track.id} не передает данные!`);
                        }
                        
                        testSource.disconnect();
                        analyser.disconnect();
                    } catch (e) {
                        console.error(`❌ Ошибка анализа трека ${track.id}:`, e);
                    }
                }, 2000);
            });
            
            // Сохраняем для управления
            this.streamVolumes.set(publisherIdStr, {
                gainNode: gainNode,
                source: source,
                volume: 1.0,
                display: displayName
            });
            
            console.log(`✅ Аудио поток ${publisherIdStr} (${displayName}) подключен к микшеру`);
            console.log(`🔍 AudioContext состояние: ${this.audioContext.state}, audioMixer подключен: ${this.audioMixer.numberOfOutputs > 0}`);
            console.log(`🔍 AudioContext destination: ${this.audioContext.destination ? 'есть' : 'нет'}, numberOfInputs: ${this.audioContext.destination ? this.audioContext.destination.numberOfInputs : 'N/A'}`);
            
            // Проверяем источник через AnalyserNode сразу после создания
            console.log(`🔍 Создан источник для ${publisherIdStr}, проверяем данные...`);
            
            // Первая проверка через 500мс
            setTimeout(() => {
                try {
                    const analyser = this.audioContext.createAnalyser();
                    analyser.fftSize = 256;
                    source.connect(analyser);
                    
                    const dataArray = new Uint8Array(analyser.frequencyBinCount);
                    analyser.getByteFrequencyData(dataArray);
                    
                    const max = Math.max(...dataArray);
                    const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
                    console.log(`🔍 [500мс] Источник ${publisherIdStr}: max=${max}, avg=${avg.toFixed(2)}, есть данные=${max > 0}`);
                    
                    source.disconnect(analyser);
                    analyser.disconnect();
                    // Переподключаем source к gainNode
                    source.connect(gainNode);
                } catch (e) {
                    console.error(`❌ Ошибка проверки источника ${publisherIdStr}:`, e);
                }
            }, 500);
            
            // Вторая проверка через 2 секунды
            setTimeout(() => {
                try {
                    const analyser = this.audioContext.createAnalyser();
                    analyser.fftSize = 256;
                    source.connect(analyser);
                    
                    const dataArray = new Uint8Array(analyser.frequencyBinCount);
                    analyser.getByteFrequencyData(dataArray);
                    
                    const max = Math.max(...dataArray);
                    const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
                    console.log(`🔍 [2сек] Источник ${publisherIdStr}: max=${max}, avg=${avg.toFixed(2)}, есть данные=${max > 0}`);
                    
                    if (max === 0) {
                        console.warn(`⚠️ Источник ${publisherIdStr} НЕ получает данные через 2 секунды!`);
                        console.warn(`⚠️ Проверка треков:`, audioTracks.map(t => ({
                            id: t.id,
                            enabled: t.enabled,
                            muted: t.muted,
                            readyState: t.readyState
                        })));
                    }
                    
                    source.disconnect(analyser);
                    analyser.disconnect();
                    // Переподключаем source к gainNode
                    source.connect(gainNode);
                } catch (e) {
                    console.error(`❌ Ошибка проверки источника ${publisherIdStr}:`, e);
                }
            }, 2000);
            
            // Третья проверка через 5 секунд
            setTimeout(() => {
                try {
                    const analyser = this.audioContext.createAnalyser();
                    analyser.fftSize = 256;
                    source.connect(analyser);
                    
                    const dataArray = new Uint8Array(analyser.frequencyBinCount);
                    analyser.getByteFrequencyData(dataArray);
                    
                    const max = Math.max(...dataArray);
                    const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
                    console.log(`🔍 [5сек] Источник ${publisherIdStr}: max=${max}, avg=${avg.toFixed(2)}, есть данные=${max > 0}`);
                    
                    source.disconnect(analyser);
                    analyser.disconnect();
                    // Переподключаем source к gainNode
                    source.connect(gainNode);
                } catch (e) {
                    console.error(`❌ Ошибка проверки источника ${publisherIdStr}:`, e);
                }
            }, 5000);
            
            // Тестовый тон для проверки что микшер работает
            setTimeout(() => {
                const testOscillator = this.audioContext.createOscillator();
                const testGain = this.audioContext.createGain();
                testOscillator.frequency.value = 440; // A4
                testGain.gain.value = 0.1;
                testOscillator.connect(testGain);
                testGain.connect(this.audioMixer);
                testOscillator.start();
                testOscillator.stop(this.audioContext.currentTime + 0.1);
                console.log('🔊 Тестовый тон отправлен через микшер для проверки');
            }, 3500);
        } catch (error) {
            console.error('❌ Ошибка обработки аудио:', error);
            console.error('Детали:', error.stack);
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
    // Дублирующиеся методы удалены - используются методы выше (строки 436 и 453)
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

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
    pendingPublishers: new Map(), // Map<PublisherId, {id, display}> - publishers, на которых подписались, но поток ещё не получен
    
    // Управление видео (screen share / webcam)
    localVideoStream: null, // Локальный видео-поток (screen или camera)
    isScreenSharing: false, // Флаг демонстрации экрана
    isCameraEnabled: false, // Флаг веб-камеры
    remoteVideoStreams: new Map(), // Map<PublisherId, {stream, videoElement, display}> - удаленные видео-потоки

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
        
        // Ограничиваем значение (0.0 - 2.0)
        const clampedVolume = Math.max(0.0, Math.min(2.0, normalizedVolume));
        
        if (streamData.gainNode) {
            // Устанавливаем громкость через GainNode (Web Audio API)
            streamData.gainNode.gain.value = clampedVolume;
            streamData.volume = clampedVolume;
            
            // Проверяем, что значение действительно установлено
            const actualGain = streamData.gainNode.gain.value;
            console.log(`✅ Громкость потока ${publisherIdStr}: запрошено ${Math.round(clampedVolume * 100)}%, фактически gain.value=${actualGain.toFixed(3)}`);
            
            // Также устанавливаем громкость на audioElement как запасной вариант
            if (streamData.audioElement) {
                streamData.audioElement.volume = Math.min(1.0, clampedVolume);
                console.log(`🔊 Также установлена громкость audioElement: ${streamData.audioElement.volume}`);
            }
        } else if (streamData.audioElement) {
            // Устанавливаем громкость через HTMLAudioElement (только 0.0-1.0)
            streamData.audioElement.volume = Math.min(1.0, clampedVolume);
            streamData.volume = clampedVolume;
            console.log(`✅ Громкость потока ${publisherIdStr} установлена через audioElement: ${Math.round(Math.min(1.0, clampedVolume) * 100)}%`);
        } else {
            console.warn(`⚠️ Ни GainNode, ни audioElement не найдены для потока ${publisherIdStr}`);
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
        // Уведомляем через SignalR об остановке видео-трансляции (если была активна)
        if ((this.isScreenSharing || this.isCameraEnabled) && window.Chat && this.channelId) {
            await Chat.stopVideoStream(this.channelId);
        }
        
        // Регистрируем отключение на сервере перед очисткой
        if (this.channelId && this.participantId && window.registerAudioDisconnection) {
            await window.registerAudioDisconnection(this.channelId, this.participantId);
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
        
        // Отключаем все потоки от микшера и удаляем аудио элементы
        this.streamVolumes.forEach((streamData, publisherId) => {
            try {
                if (streamData.source) {
                    streamData.source.disconnect();
                }
                if (streamData.gainNode) {
                    streamData.gainNode.disconnect();
                }
                // Удаляем HTMLAudioElement из DOM
                if (streamData.audioElement) {
                    streamData.audioElement.pause();
                    streamData.audioElement.srcObject = null;
                    if (streamData.audioElement.parentNode) {
                        streamData.audioElement.parentNode.removeChild(streamData.audioElement);
                    }
                }
            } catch (e) {
                console.warn(`Ошибка при отключении потока ${publisherId}:`, e);
            }
        });
        this.streamVolumes.clear();
        this.remoteStreams.clear();
        this.pendingPublishers.clear();
        
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
        
        // Останавливаем видео-поток
        if (this.localVideoStream) {
            this.localVideoStream.getTracks().forEach(track => track.stop());
            this.localVideoStream = null;
        }
        this.isScreenSharing = false;
        this.isCameraEnabled = false;
        
        // Очищаем удаленные видео-потоки
        this.remoteVideoStreams.forEach((videoData, publisherId) => {
            try {
                if (videoData.videoElement) {
                    videoData.videoElement.pause();
                    videoData.videoElement.srcObject = null;
                    if (videoData.videoElement.parentNode) {
                        videoData.videoElement.parentNode.removeChild(videoData.videoElement);
                    }
                }
                if (videoData.stream) {
                    videoData.stream.getTracks().forEach(track => track.stop());
                }
            } catch (e) {
                console.warn(`Ошибка при очистке видео-потока ${publisherId}:`, e);
            }
        });
        this.remoteVideoStreams.clear();
        
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

    // ============================================
    // Методы для работы с видео (screen share / webcam)
    // ============================================
    
    // Запустить демонстрацию экрана
    async startScreenShare() {
        if (this.isScreenSharing) {
            console.warn('⚠️ Демонстрация экрана уже активна');
            return false;
        }
        
        if (!this.publisherHandle) {
            console.error('❌ Publisher handle не найден. Подключитесь к каналу сначала.');
            return false;
        }
        
        try {
            console.log('🖥️ Запускаем демонстрацию экрана...');
            
            // Останавливаем камеру, если она была включена
            if (this.isCameraEnabled) {
                await this.stopVideo();
            }
            
            // Запрашиваем доступ к экрану
            const stream = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    cursor: 'always',
                    displaySurface: 'monitor'
                },
                audio: false // Экран не передает аудио
            });
            
            this.localVideoStream = stream;
            this.isScreenSharing = true;
            
            // Обработка остановки пользователем через UI браузера
            stream.getVideoTracks()[0].addEventListener('ended', () => {
                console.log('🖥️ Пользователь остановил демонстрацию экрана через UI браузера');
                this.stopVideo();
            });
            
            // Публикуем видео-трек
            await this.publishVideo(stream);
            
            // Уведомляем через SignalR о начале видео-трансляции
            if (window.Chat && this.channelId) {
                await Chat.startVideoStream(this.channelId, 'screen');
            }
            
            console.log('✅ Демонстрация экрана запущена');
            return true;
        } catch (error) {
            console.error('❌ Ошибка при запуске демонстрации экрана:', error);
            this.isScreenSharing = false;
            this.localVideoStream = null;
            return false;
        }
    },
    
    // Запустить веб-камеру
    async startCamera() {
        if (this.isCameraEnabled) {
            console.warn('⚠️ Веб-камера уже активна');
            return false;
        }
        
        if (!this.publisherHandle) {
            console.error('❌ Publisher handle не найден. Подключитесь к каналу сначала.');
            return false;
        }
        
        try {
            console.log('📷 Запускаем веб-камеру...');
            
            // Останавливаем screen share, если он был включен
            if (this.isScreenSharing) {
                await this.stopVideo();
            }
            
            // Запрашиваем доступ к камере
            const stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    width: { ideal: 1280 },
                    height: { ideal: 720 },
                    facingMode: 'user'
                },
                audio: false // Аудио уже идет отдельно
            });
            
            this.localVideoStream = stream;
            this.isCameraEnabled = true;
            
            // Публикуем видео-трек
            await this.publishVideo(stream);
            
            // Уведомляем через SignalR о начале видео-трансляции
            if (window.Chat && this.channelId) {
                await Chat.startVideoStream(this.channelId, 'camera');
            }
            
            console.log('✅ Веб-камера запущена');
            return true;
        } catch (error) {
            console.error('❌ Ошибка при запуске веб-камеры:', error);
            this.isCameraEnabled = false;
            this.localVideoStream = null;
            return false;
        }
    },
    
    // Остановить видео (screen share или webcam)
    async stopVideo() {
        if (!this.isScreenSharing && !this.isCameraEnabled) {
            console.warn('⚠️ Видео не активно');
            return false;
        }
        
        if (!this.publisherHandle) {
            console.error('❌ Publisher handle не найден');
            return false;
        }
        
        try {
            console.log('🛑 Останавливаем видео...');
            
            // Останавливаем видео-трек
            if (this.localVideoStream) {
                this.localVideoStream.getTracks().forEach(track => {
                    track.stop();
                    console.log('🛑 Трек остановлен:', track.id);
                });
            }
            
            // Создаем новый offer только с аудио
            if (this.localStream) {
                this.publisherHandle.createOffer({
                    media: {
                        audioRecv: false,
                        videoRecv: false,
                        audioSend: true,
                        videoSend: false,
                        replaceAudio: true,
                        removeVideo: true // Удаляем видео
                    },
                    stream: this.localStream,
                    success: (jsep) => {
                        console.log('✅ Offer создан без видео');
                        
                        // Отправляем configure без видео
                        this.publisherHandle.send({
                            message: {
                                request: 'configure',
                                video: false,
                                audio: true
                            },
                            jsep: jsep
                        });
                    },
                    error: (error) => {
                        console.error('❌ Ошибка создания offer без видео:', error);
                    }
                });
            }
            
            // Уведомляем через SignalR об остановке видео-трансляции
            if (window.Chat && this.channelId) {
                await Chat.stopVideoStream(this.channelId);
            }
            
            // Уведомляем UI об удалении своего видео
            if (window.onVideoStreamRemoved && this.participantId) {
                window.onVideoStreamRemoved(this.participantId);
            }
            
            this.localVideoStream = null;
            this.isScreenSharing = false;
            this.isCameraEnabled = false;
            
            console.log('✅ Видео остановлено');
            return true;
        } catch (error) {
            console.error('❌ Ошибка при остановке видео:', error);
            return false;
        }
    },
    
    // Публиковать видео-трек в Janus
    async publishVideo(stream) {
        if (!this.publisherHandle) {
            console.error('❌ Publisher handle не найден');
            return false;
        }
        
        const videoTrack = stream.getVideoTracks()[0];
        if (!videoTrack) {
            console.error('❌ Видео-трек не найден в потоке');
            return false;
        }
        
        try {
            console.log('📤 Публикуем видео-трек:', videoTrack.id);
            
            // Создаем комбинированный поток с аудио и видео
            const combinedStream = new MediaStream();
            
            // Добавляем аудио-треки из localStream
            if (this.localStream) {
                this.localStream.getAudioTracks().forEach(track => {
                    combinedStream.addTrack(track);
                    console.log('📤 Добавлен аудио-трек:', track.id);
                });
            }
            
            // Добавляем видео-трек
            combinedStream.addTrack(videoTrack);
            console.log('📤 Добавлен видео-трек:', videoTrack.id);
            
            // Используем Janus.js createOffer для корректной работы
            this.publisherHandle.createOffer({
                media: {
                    audioRecv: false,
                    videoRecv: false,
                    audioSend: true,
                    videoSend: true,
                    replaceAudio: true, // Заменяем аудио
                    replaceVideo: true  // Заменяем/добавляем видео
                },
                stream: combinedStream,
                success: (jsep) => {
                    console.log('✅ Offer создан для видео через Janus.js');
                    
                    // Отправляем configure
                    this.publisherHandle.send({
                        message: {
                            request: 'configure',
                            video: true,
                            audio: true
                        },
                        jsep: jsep,
                        success: (result) => {
                            console.log('✅ Видео опубликовано, ответ:', result);
                        },
                        error: (error) => {
                            console.error('❌ Ошибка публикации видео:', error);
                        }
                    });
                },
                error: (error) => {
                    console.error('❌ Ошибка создания offer для видео:', error);
                }
            });
            
            // Уведомляем UI о своем видео
            if (window.onVideoStreamAdded) {
                window.onVideoStreamAdded(this.participantId, stream, this.displayName + ' (Вы)', null);
            }
            
            return true;
        } catch (error) {
            console.error('❌ Ошибка при публикации видео:', error);
            return false;
        }
    },
    
    // Обработать удаленный видео-поток
    handleRemoteVideoStream(stream, publisherId, displayName) {
        const publisherIdStr = String(publisherId);
        console.log(`📹 Обрабатываем удаленный видео-поток от ${publisherIdStr} (${displayName})`);
        
        // Проверяем наличие видео-треков
        const videoTracks = stream.getVideoTracks();
        if (videoTracks.length === 0) {
            console.warn(`⚠️ Нет видео-треков в потоке от ${publisherIdStr}`);
            return;
        }
        
        // Проверяем состояние треков
        videoTracks.forEach(track => {
            console.log(`🔍 Видео-трек ${track.id}: enabled=${track.enabled}, muted=${track.muted}, readyState=${track.readyState}`);
        });
        
        // Проверяем, есть ли уже видео для этого publisher
        if (this.remoteVideoStreams.has(publisherIdStr)) {
            console.log(`⚠️ Видео-поток для ${publisherIdStr} уже существует, обновляем...`);
            this.removeRemoteVideoStream(publisherId);
        }
        
        // Создаем video элемент
        const videoElement = document.createElement('video');
        videoElement.autoplay = true;
        videoElement.playsInline = true;
        videoElement.muted = true; // Видео без звука (аудио идет отдельно)
        videoElement.srcObject = stream;
        
        // Явно запускаем воспроизведение
        videoElement.play().catch(error => {
            console.error(`❌ Ошибка воспроизведения видео от ${publisherIdStr}:`, error);
        });
        
        // Обработка событий трека
        videoTracks.forEach(track => {
            track.addEventListener('ended', () => {
                console.log(`🔴 Видео-трек ${track.id} от ${publisherIdStr} завершен`);
                this.removeRemoteVideoStream(publisherId);
            });
            
            track.addEventListener('mute', () => {
                console.warn(`⚠️ Видео-трек ${track.id} от ${publisherIdStr} стал muted`);
            });
            
            track.addEventListener('unmute', () => {
                console.log(`✅ Видео-трек ${track.id} от ${publisherIdStr} стал unmuted`);
            });
        });
        
        // Сохраняем данные
        this.remoteVideoStreams.set(publisherIdStr, {
            stream: stream,
            videoElement: videoElement,
            display: displayName
        });
        
        // Уведомляем UI о новом видео-потоке
        if (window.onVideoStreamAdded) {
            window.onVideoStreamAdded(publisherId, stream, displayName, videoElement);
        }
        
        console.log(`✅ Видео-поток от ${publisherIdStr} обработан`);
    },
    
    // Удалить удаленный видео-поток
    removeRemoteVideoStream(publisherId) {
        const publisherIdStr = String(publisherId);
        console.log(`🔴 Удаляем видео-поток от ${publisherIdStr}`);
        
        const videoData = this.remoteVideoStreams.get(publisherIdStr);
        if (videoData) {
            try {
                // Останавливаем видео элемент
                if (videoData.videoElement) {
                    videoData.videoElement.pause();
                    videoData.videoElement.srcObject = null;
                }
                
                // Останавливаем треки
                if (videoData.stream) {
                    videoData.stream.getTracks().forEach(track => track.stop());
                }
                
                // Уведомляем UI об удалении видео
                if (window.onVideoStreamRemoved) {
                    window.onVideoStreamRemoved(publisherId);
                }
            } catch (e) {
                console.warn(`Ошибка при удалении видео-потока ${publisherIdStr}:`, e);
            }
            
            this.remoteVideoStreams.delete(publisherIdStr);
        }
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
                
                // Запрашиваем активные видео-стримы через SignalR
                if (window.Chat && this.channelId) {
                    await Chat.getActiveVideoStreams(this.channelId);
                }
            }
            
            // Новые publishers
            if (event.publishers) {
                console.log('📋 Новые publishers:', event.publishers.length);
                
                // Сохраняем pending publishers для UI (они ещё не в streamVolumes)
                event.publishers.forEach(publisher => {
                    // Пропускаем себя
                    if (publisher.id !== this.participantId) {
                        // Добавляем в pending list для UI
                        this.pendingPublishers.set(String(publisher.id), {
                            id: publisher.id,
                            display: publisher.display || `Publisher ${publisher.id}`
                        });
                        this.subscribeToPublisher(publisher);
                    }
                });
                
                // Обновляем UI - используем комбинированный список (себя + streamVolumes + pending)
                this.notifyParticipantsUpdate();
            }
            
            // Удаленные publishers
            if (event.unpublished) {
                console.log('🔴 Publisher отключился:', event.unpublished);
                this.removePublisher(event.unpublished);
            }
            
            // Ошибки
            if (event.error_code) {
                console.error('❌ Ошибка от Janus:', event.error_code, event.error);
                
                // Ошибка 426 - комната не существует (после перезагрузки Janus)
                // Автоматически создаем комнату и повторяем подключение
                if (event.error_code === 426) {
                    console.log('🔄 Комната не существует, создаем автоматически...');
                    this.createRoomAndRejoin();
                    return; // Не показываем ошибку пользователю
                }
                
                if (window.onAudioError) {
                    window.onAudioError(event.error || `Ошибка ${event.error_code}`);
                }
            }
        }
    },
    
    // Создать комнату и повторить подключение
    async createRoomAndRejoin() {
        if (!this.publisherHandle) {
            console.error('❌ publisherHandle не найден для создания комнаты');
            return;
        }
        
        console.log(`📦 Создаем комнату ${this.roomId}...`);
        
        // Создаем комнату через Janus API
        this.publisherHandle.send({
            message: {
                request: 'create',
                room: this.roomId,
                description: `Audio channel ${this.channelId}`,
                publishers: 50, // Максимальное количество publishers
                bitrate: 128000,
                audiocodec: 'opus',
                permanent: false // Не сохранять после перезагрузки Janus
            },
            success: (result) => {
                console.log('✅ Комната создана:', result);
                
                // Повторяем подключение к комнате
                this.publisherHandle.send({
                    message: {
                        request: 'join',
                        room: this.roomId,
                        ptype: 'publisher',
                        display: this.displayName
                    },
                    success: (joinResult) => {
                        console.log('✅ Присоединились к созданной комнате:', joinResult);
                        
                        // Публикуем поток
                        const hasAudio = this.localStream && this.localStream.getAudioTracks().length > 0;
                        if (hasAudio) {
                            this.publisherHandle.createOffer({
                                media: { 
                                    audioRecv: false, 
                                    videoRecv: false, 
                                    audioSend: true, 
                                    videoSend: false
                                },
                                stream: this.localStream,
                                success: (jsep) => {
                                    this.publisherHandle.send({
                                        message: {
                                            request: 'publish',
                                            audio: true,
                                            video: false
                                        },
                                        jsep: jsep
                                    });
                                },
                                error: (error) => {
                                    console.error('❌ Create offer error after room creation:', error);
                                }
                            });
                        }
                        
                        // Запрашиваем список publishers
                        this.requestPublishersList();
                    },
                    error: (error) => {
                        console.error('❌ Join error after room creation:', error);
                        if (window.onAudioError) {
                            window.onAudioError(error);
                        }
                    }
                });
            },
            error: (error) => {
                // Ошибка 427 - комната уже существует (race condition)
                if (error && error.error_code === 427) {
                    console.log('⚠️ Комната уже существует, пытаемся присоединиться...');
                    // Повторяем присоединение
                    this.publisherHandle.send({
                        message: {
                            request: 'join',
                            room: this.roomId,
                            ptype: 'publisher',
                            display: this.displayName
                        }
                    });
                } else {
                    console.error('❌ Ошибка создания комнаты:', error);
                    if (window.onAudioError) {
                        window.onAudioError(error.error || 'Ошибка создания комнаты');
                    }
                }
            }
        });
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
        
        // Приводим publisherId к строке для консистентности
        const publisherIdStr = String(publisherId);
        
        // Создаем отдельный handle для каждого subscriber
        this.janus.attach({
            plugin: 'janus.plugin.videoroom',
            opaqueId: `subscriber-${publisherIdStr}`,
            success: (handle) => {
                this.subscriberHandles.set(publisherIdStr, handle);
                
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
                        console.error(`❌ Ошибка подписки на publisher ${publisherIdStr}:`, error);
                        this.subscriberHandles.delete(publisherIdStr);
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
                                videoRecv: true, // Включаем прием видео
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
                    
                    // Когда поток начался (как в инструкции) - ВАЖНО: используем это как основной способ
                    if (msg.plugindata && msg.plugindata.data && msg.plugindata.data.started === 'ok') {
                        console.log(`✅ Поток от publisher ${publisherIdStr} начался (started=ok)`);
                        // Получаем поток из RTCPeerConnection (как в инструкции)
                        setTimeout(() => {
                            const pc = handle.webrtcStuff.pc;
                            if (pc) {
                                // Проверяем статистику соединения
                                pc.getStats().then(stats => {
                                    stats.forEach(report => {
                                        if (report.type === 'inbound-rtp' && report.kind === 'audio') {
                                            console.log(`📊 [started] Статистика аудио для ${publisherIdStr}:`, {
                                                bytesReceived: report.bytesReceived,
                                                packetsReceived: report.packetsReceived,
                                                packetsLost: report.packetsLost,
                                                jitter: report.jitter,
                                                audioLevel: report.audioLevel
                                            });
                                            
                                            if (report.bytesReceived === 0) {
                                                console.warn(`⚠️ Нет полученных байт для ${publisherIdStr}!`);
                } else {
                                                console.log(`✅ [started] Получено ${report.bytesReceived} байт для ${publisherIdStr}`);
                                            }
                                        }
                                    });
                                });
                                
                                const receivers = pc.getReceivers();
                                const remoteStream = new MediaStream();
                                
                                const audioStream = new MediaStream();
                                const videoStream = new MediaStream();
                                
                                receivers.forEach(receiver => {
                                    if (receiver.track) {
                                        if (receiver.track.kind === 'audio') {
                                            console.log(`🔍 [started] Receiver трек ${receiver.track.id}: enabled=${receiver.track.enabled}, muted=${receiver.track.muted}, readyState=${receiver.track.readyState}`);
                                            audioStream.addTrack(receiver.track);
                                        } else if (receiver.track.kind === 'video') {
                                            console.log(`🔍 [started] Receiver видео-трек ${receiver.track.id}: enabled=${receiver.track.enabled}, muted=${receiver.track.muted}, readyState=${receiver.track.readyState}`);
                                            videoStream.addTrack(receiver.track);
                                        }
                                    }
                                });
                                
                                // Обрабатываем аудио-поток
                                if (audioStream.getAudioTracks().length > 0) {
                                    console.log(`✅ [started] Создан аудио-поток из receivers для ${publisherIdStr}, треков: ${audioStream.getAudioTracks().length}`);
                                    // ВАЖНО: Сохраняем поток в handle для использования в processAudioForMixing
                                    handle.remoteStream = audioStream;
                                    console.log(`✅ [started] Сохранен remoteStream в handle для ${publisherIdStr}`);
                                    // Обрабатываем поток
                                    this.handleRemoteStream(audioStream, publisherId, displayName);
                                } else {
                                    console.warn(`⚠️ Нет аудио треков в receivers для ${publisherIdStr}`);
                                }
                                
                                // Обрабатываем видео-поток
                                if (videoStream.getVideoTracks().length > 0) {
                                    console.log(`✅ [started] Создан видео-поток из receivers для ${publisherIdStr}, треков: ${videoStream.getVideoTracks().length}`);
                                    this.handleRemoteVideoStream(videoStream, publisherId, displayName);
                                }
                            }
                        }, 500);
                    }
                };
                
                // Обработка удаленного трека (новый API Janus.js)
                handle.onremotetrack = (track, mid, on) => {
                    console.log(`🔊 onremotetrack вызван: publisherId=${publisherId}, track.kind=${track.kind}, on=${on}, mid=${mid}, muted=${track.muted}`);
                    
                    // ВАЖНО: Сохраняем трек в handle для последующего использования
                    if (track.kind === 'audio' && on) {
                        handle.remoteAudioTrack = track;
                        console.log(`✅ Сохранен remoteAudioTrack в handle: ${track.id}`);
                    }
                    
                    // Обрабатываем видео-треки
                    if (track.kind === 'video' && on) {
                        handle.remoteVideoTrack = track;
                        console.log(`✅ Получен видео-трек от publisher ${publisherId}: ${track.id}, readyState=${track.readyState}, enabled=${track.enabled}, muted=${track.muted}`);
                        
                        // Если трек muted - ждем unmute
                        if (track.muted) {
                            console.log(`⏳ Видео-трек ${track.id} muted, ждем unmute для ${publisherId}...`);
                            const unmuteHandler = () => {
                                console.log(`🔊 Видео-трек ${track.id} unmuted для ${publisherId}`);
                                track.removeEventListener('unmute', unmuteHandler);
                                setTimeout(() => {
                                    if (!track.muted && track.readyState === 'live') {
                                        const videoStream = new MediaStream([track]);
                                        this.handleRemoteVideoStream(videoStream, publisherId, displayName);
                                    } else {
                                        console.warn(`⚠️ Видео-трек ${track.id} все еще не активен после unmute`);
                                    }
                                }, 100);
                            };
                            track.addEventListener('unmute', unmuteHandler);
                            
                            // Проверка через таймаут на случай если событие уже произошло
                            setTimeout(() => {
                                if (!track.muted && track.readyState === 'live') {
                                    console.log(`🔊 Видео-трек ${track.id} уже unmuted (таймаут) для ${publisherId}`);
                                    track.removeEventListener('unmute', unmuteHandler);
                                    const videoStream = new MediaStream([track]);
                                    this.handleRemoteVideoStream(videoStream, publisherId, displayName);
                                }
                            }, 500);
                        } else if (track.readyState === 'live') {
                            // Трек уже активен, создаем поток сразу
                            const videoStream = new MediaStream([track]);
                            this.handleRemoteVideoStream(videoStream, publisherId, displayName);
                        } else {
                            // Ждем пока трек станет live
                            console.log(`⏳ Видео-трек ${track.id} еще не live (readyState=${track.readyState}), ждем...`);
                            const liveHandler = () => {
                                console.log(`✅ Видео-трек ${track.id} стал live для ${publisherId}`);
                                track.removeEventListener('live', liveHandler);
                                const videoStream = new MediaStream([track]);
                                this.handleRemoteVideoStream(videoStream, publisherId, displayName);
                            };
                            track.addEventListener('live', liveHandler);
                        }
                    } else if (track.kind === 'video' && !on) {
                        // Видео-трек остановлен
                        console.log(`🔴 Видео-трек от publisher ${publisherId} остановлен`);
                        this.removeRemoteVideoStream(publisherId);
                    }
                    
                    // Проверяем статистику WebRTC соединения
                    if (handle.webrtcStuff && handle.webrtcStuff.pc) {
                        const pc = handle.webrtcStuff.pc;
                                setTimeout(() => {
                            pc.getStats().then(stats => {
                                console.log(`📊 Статистика WebRTC для ${publisherId}:`);
                                let hasInboundRtp = false;
                                stats.forEach(report => {
                                    if (report.type === 'inbound-rtp' && report.kind === 'audio') {
                                        hasInboundRtp = true;
                                        console.log(`📊 inbound-rtp (audio):`, {
                                            bytesReceived: report.bytesReceived,
                                            packetsReceived: report.packetsReceived,
                                            packetsLost: report.packetsLost,
                                            jitter: report.jitter,
                                            audioLevel: report.audioLevel,
                                            totalAudioEnergy: report.totalAudioEnergy,
                                            framesDecoded: report.framesDecoded
                                        });
                                        
                                        if (report.bytesReceived === 0) {
                                            console.error(`❌ КРИТИЧНО: Нет полученных байт для ${publisherId}! Отправитель не отправляет данные или соединение не установлено!`);
                                        } else {
                                            console.log(`✅ Получено ${report.bytesReceived} байт от ${publisherId}`);
                                        }
                                    }
                                    if (report.type === 'transport') {
                                        console.log(`📊 transport:`, {
                                            bytesReceived: report.bytesReceived,
                                            bytesSent: report.bytesSent,
                                            dtlsState: report.dtlsState,
                                            iceConnectionState: report.iceConnectionState
                                        });
                                    }
                                });
                                
                                if (!hasInboundRtp) {
                                    console.error(`❌ КРИТИЧНО: Нет inbound-rtp статистики для ${publisherId}! WebRTC соединение не установлено или не настроено правильно!`);
                                }
                            }).catch(e => {
                                console.error(`❌ Ошибка получения статистики для ${publisherId}:`, e);
                            });
                                }, 1000);
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
                                        // Используем трек напрямую из handle
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
                        handle.remoteAudioTrack = null;
                    }
                };
                
                // Альтернативный способ получения потока (старый API) - ПРИОРИТЕТНЫЙ
                handle.onremotestream = (stream) => {
                    console.log(`🔊 [onremotestream] Получен удаленный поток от publisher ${publisherId}, треков: ${stream.getAudioTracks().length}`);
                    
                    // Проверяем статистику WebRTC
                    if (handle.webrtcStuff && handle.webrtcStuff.pc) {
                        const pc = handle.webrtcStuff.pc;
                        setTimeout(() => {
                            pc.getStats().then(stats => {
                                console.log(`📊 [onremotestream] Статистика WebRTC для ${publisherId}:`);
                                let hasInboundRtp = false;
                                stats.forEach(report => {
                                    if (report.type === 'inbound-rtp' && report.kind === 'audio') {
                                        hasInboundRtp = true;
                                        console.log(`📊 inbound-rtp (audio):`, {
                                            bytesReceived: report.bytesReceived,
                                            packetsReceived: report.packetsReceived,
                                            packetsLost: report.packetsLost,
                                            jitter: report.jitter,
                                            audioLevel: report.audioLevel,
                                            totalAudioEnergy: report.totalAudioEnergy
                                        });
                                        
                                        if (report.bytesReceived === 0) {
                                            console.error(`❌ КРИТИЧНО: Нет полученных байт для ${publisherId}! Отправитель не отправляет данные!`);
                                        } else {
                                            console.log(`✅ Получено ${report.bytesReceived} байт от ${publisherId}`);
                                        }
                                    }
                                    if (report.type === 'transport') {
                                        console.log(`📊 transport:`, {
                                            bytesReceived: report.bytesReceived,
                                            bytesSent: report.bytesSent,
                                            dtlsState: report.dtlsState,
                                            iceConnectionState: report.iceConnectionState
                                        });
                                    }
                                });
                                
                                if (!hasInboundRtp) {
                                    console.error(`❌ КРИТИЧНО: Нет inbound-rtp статистики для ${publisherId}!`);
                                }
                            }).catch(e => {
                                console.error(`❌ Ошибка получения статистики:`, e);
                            });
                        }, 2000);
                    }
                    
                    // Используем onremotestream как основной способ (более надежный)
                    stream.getAudioTracks().forEach(track => {
                        console.log(`🔍 [onremotestream] Трек ${track.id}: enabled=${track.enabled}, muted=${track.muted}, readyState=${track.readyState}`);
                    });
                    
                    this.handleRemoteStream(stream, publisherId, displayName);
                };
                
                handle.ontrack = (event) => {
                    console.log(`🔊 [ontrack] Вызван для publisher ${publisherIdStr}, streams.length=${event.streams ? event.streams.length : 0}`);
                    console.log(`🔍 [ontrack] event.track:`, event.track ? {
                        id: event.track.id,
                        kind: event.track.kind,
                        enabled: event.track.enabled,
                        muted: event.track.muted,
                        readyState: event.track.readyState
                    } : 'null');
                    
                    if (event.streams && event.streams.length > 0) {
                        const stream = event.streams[0];
                        console.log(`✅ [ontrack] Получен поток от publisher ${publisherIdStr}, id=${stream.id}`);
                        console.log(`🔍 [ontrack] Треков в потоке: ${stream.getAudioTracks().length}`);
                        
                        stream.getAudioTracks().forEach(track => {
                            console.log(`🔍 [ontrack] Трек ${track.id}: enabled=${track.enabled}, muted=${track.muted}, readyState=${track.readyState}`);
                        });
                        
                        // ВАЖНО: Сохраняем поток из ontrack - он уже связан с receiver
                        handle.ontrackStream = stream;
                        console.log(`✅ [ontrack] Сохранен ontrackStream в handle для ${publisherIdStr}`);
                        
                        // Обрабатываем поток
                        this.handleRemoteStream(stream, publisherId, displayName);
                    } else if (event.track) {
                        // Если нет streams, но есть track - создаем поток из трека
                        console.log(`⚠️ [ontrack] Нет streams, но есть track, создаем поток из трека`);
                        const stream = new MediaStream([event.track]);
                        handle.ontrackStream = stream;
                        console.log(`✅ [ontrack] Создан поток из track для ${publisherIdStr}`);
                        this.handleRemoteStream(stream, publisherId, displayName);
                    }
                };
                
                // Проверяем статистику после установки WebRTC соединения
                handle.webrtcState = (on) => {
                    console.log(`🔍 [webrtcState] Вызван для subscriber ${publisherIdStr}, on=${on}`);
                    if (on) {
                        console.log(`✅ WebRTC соединение установлено для subscriber ${publisherIdStr}`);
                        
                        // ВАЖНО: Получаем поток из receivers после установки соединения
                        setTimeout(() => {
                            console.log(`🔍 [webrtcState] Проверяем handle.webrtcStuff для ${publisherIdStr}...`);
                            if (handle.webrtcStuff && handle.webrtcStuff.pc) {
                                const pc = handle.webrtcStuff.pc;
                                console.log(`✅ [webrtcState] PC найден для ${publisherIdStr}, получаем receivers...`);
                                
                                // Получаем поток из receivers
                                const receivers = pc.getReceivers();
                                console.log(`🔍 [webrtcState] Найдено ${receivers.length} receivers для ${publisherIdStr}`);
                                
                                const remoteStream = new MediaStream();
                                
                                receivers.forEach((receiver, index) => {
                                    console.log(`🔍 [webrtcState] Receiver ${index}:`, {
                                        track: receiver.track ? {
                                            id: receiver.track.id,
                                            kind: receiver.track.kind,
                                            enabled: receiver.track.enabled,
                                            muted: receiver.track.muted,
                                            readyState: receiver.track.readyState
                                        } : 'null'
                                    });
                                    
                                    if (receiver.track && receiver.track.kind === 'audio') {
                                        console.log(`✅ [webrtcState] Добавляем трек ${receiver.track.id} в поток для ${publisherIdStr}`);
                                        remoteStream.addTrack(receiver.track);
                                    }
                                });
                                
                                console.log(`🔍 [webrtcState] Создан поток с ${remoteStream.getAudioTracks().length} треками для ${publisherIdStr}`);
                                
                                if (remoteStream.getAudioTracks().length > 0) {
                                    console.log(`✅ [webrtcState] Создан поток из receivers для ${publisherIdStr}, треков: ${remoteStream.getAudioTracks().length}`);
                                    // ВАЖНО: Сохраняем поток в handle для использования в processAudioForMixing
                                    handle.remoteStream = remoteStream;
                                    console.log(`✅ [webrtcState] Сохранен remoteStream в handle для ${publisherIdStr}`);
                                    
                                    // Проверяем треки в сохраненном потоке
                                    remoteStream.getAudioTracks().forEach(track => {
                                        console.log(`🔍 [webrtcState] Трек в remoteStream: id=${track.id}, enabled=${track.enabled}, muted=${track.muted}, readyState=${track.readyState}`);
                                    });
                                    
                                    // Обрабатываем поток
                                    console.log(`🔍 [webrtcState] Вызываем handleRemoteStream для ${publisherIdStr}...`);
                                    this.handleRemoteStream(remoteStream, publisherId, displayName);
                                } else {
                                    console.error(`❌ [webrtcState] Нет аудио треков в receivers для ${publisherIdStr}!`);
                                }
                                
                                // Проверяем статистику через 2 секунды после установки соединения
                                setTimeout(() => {
                                    pc.getStats().then(stats => {
                                        console.log(`📊 [webrtcState] Статистика WebRTC для subscriber ${publisherIdStr}:`);
                                        let hasInboundRtp = false;
                                        stats.forEach(report => {
                                            if (report.type === 'inbound-rtp' && report.kind === 'audio') {
                                                hasInboundRtp = true;
                                                console.log(`📊 inbound-rtp (audio):`, {
                                                    bytesReceived: report.bytesReceived,
                                                    packetsReceived: report.packetsReceived,
                                                    packetsLost: report.packetsLost,
                                                    jitter: report.jitter,
                                                    audioLevel: report.audioLevel,
                                                    totalAudioEnergy: report.totalAudioEnergy
                                                });
                                                
                                                if (report.bytesReceived === 0) {
                                                    console.error(`❌ КРИТИЧНО: Нет полученных байт для subscriber ${publisherIdStr}! Отправитель не отправляет данные!`);
                                                } else {
                                                    console.log(`✅ Получено ${report.bytesReceived} байт для subscriber ${publisherIdStr}`);
                                                }
                                            }
                                            if (report.type === 'transport') {
                                                console.log(`📊 transport:`, {
                                                    bytesReceived: report.bytesReceived,
                                                    bytesSent: report.bytesSent,
                                                    dtlsState: report.dtlsState,
                                                    iceConnectionState: report.iceConnectionState
                                                });
                                            }
                                        });
                                        
                                        if (!hasInboundRtp) {
                                            console.error(`❌ КРИТИЧНО: Нет inbound-rtp статистики для subscriber ${publisherIdStr}!`);
                                        }
                                    }).catch(e => {
                                        console.error(`❌ Ошибка получения статистики для subscriber ${publisherIdStr}:`, e);
                                    });
                                }, 2000);
                            } else {
                                console.error(`❌ [webrtcState] handle.webrtcStuff или PC не найдены для ${publisherIdStr}!`);
                                console.error(`🔍 [webrtcState] handle.webrtcStuff:`, handle.webrtcStuff);
                            }
                        }, 500);
                    } else {
                        console.log(`⚠️ [webrtcState] WebRTC соединение закрыто для subscriber ${publisherIdStr}`);
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
        if (existingData) {
            // Если audioElement уже существует и воспроизводится - не пересоздаем
            if (existingData.audioElement && !existingData.audioElement.paused) {
                console.log(`✅ Поток ${publisherIdStr} уже воспроизводится через audioElement, пропускаем пересоздание`);
                return;
            }
            
            console.log(`⚠️ Поток ${publisherIdStr} уже обработан, но не воспроизводится. Пересоздаем...`);
            
            // Очищаем старые ресурсы
            try {
                if (existingData.source) {
                    existingData.source.disconnect();
                }
                if (existingData.gainNode) {
                    existingData.gainNode.disconnect();
                }
                // Удаляем старый audioElement
                if (existingData.audioElement) {
                    existingData.audioElement.pause();
                    existingData.audioElement.srcObject = null;
                    if (existingData.audioElement.parentNode) {
                        existingData.audioElement.parentNode.removeChild(existingData.audioElement);
                    }
                }
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
            
            // ВАЖНО: Используем поток из handle.remoteStream (создан из receivers после started)
            // Это более надежный способ получения потока
            let activeStream = null;
            const subscriberHandle = this.subscriberHandles.get(publisherIdStr);
            
            console.log(`🔍 [processAudioForMixing] Проверяем handle для ${publisherIdStr}...`);
            console.log(`🔍 [processAudioForMixing] subscriberHandle:`, subscriberHandle ? 'найден' : 'НЕ НАЙДЕН');
            
            // ПРИОРИТЕТ 1: Используем поток из ontrack - он уже связан с receiver
            if (subscriberHandle && subscriberHandle.ontrackStream) {
                activeStream = subscriberHandle.ontrackStream;
                console.log(`✅ [processAudioForMixing] Используем поток из handle.ontrackStream для ${publisherIdStr}`);
                console.log(`🔍 [processAudioForMixing] Треков в handle.ontrackStream: ${activeStream.getAudioTracks().length}`);
                activeStream.getAudioTracks().forEach(track => {
                    console.log(`🔍 [processAudioForMixing] Трек в handle.ontrackStream: id=${track.id}, enabled=${track.enabled}, muted=${track.muted}, readyState=${track.readyState}`);
                });
            } else if (subscriberHandle && subscriberHandle.remoteStream) {
                activeStream = subscriberHandle.remoteStream;
                console.log(`✅ [processAudioForMixing] Используем поток из handle.remoteStream (webrtcState) для ${publisherIdStr}`);
                console.log(`🔍 [processAudioForMixing] Треков в handle.remoteStream: ${activeStream.getAudioTracks().length}`);
                activeStream.getAudioTracks().forEach(track => {
                    console.log(`🔍 [processAudioForMixing] Трек в handle.remoteStream: id=${track.id}, enabled=${track.enabled}, muted=${track.muted}, readyState=${track.readyState}`);
                });
                    } else {
                console.log(`⚠️ [processAudioForMixing] handle.remoteStream не найден для ${publisherIdStr}`);
                if (subscriberHandle) {
                    console.log(`🔍 [processAudioForMixing] handle.webrtcStuff:`, subscriberHandle.webrtcStuff ? 'есть' : 'НЕТ');
                    console.log(`🔍 [processAudioForMixing] handle.remoteAudioTrack:`, subscriberHandle.remoteAudioTrack ? subscriberHandle.remoteAudioTrack.id : 'НЕТ');
                }
                
                // Если потока нет в handle, пытаемся получить из receivers напрямую
                if (subscriberHandle && subscriberHandle.webrtcStuff && subscriberHandle.webrtcStuff.pc) {
                    const pc = subscriberHandle.webrtcStuff.pc;
                    console.log(`🔍 [processAudioForMixing] Получаем поток из receivers напрямую для ${publisherIdStr}...`);
                    const receivers = pc.getReceivers();
                    console.log(`🔍 [processAudioForMixing] Найдено ${receivers.length} receivers`);
                    
                    const receiverStream = new MediaStream();
                    
                    receivers.forEach((receiver, index) => {
                        console.log(`🔍 [processAudioForMixing] Receiver ${index}:`, {
                            track: receiver.track ? {
                                id: receiver.track.id,
                                kind: receiver.track.kind,
                                enabled: receiver.track.enabled,
                                muted: receiver.track.muted,
                                readyState: receiver.track.readyState
                            } : 'null'
                        });
                        
                        if (receiver.track && receiver.track.kind === 'audio' && !receiver.track.muted && receiver.track.readyState === 'live') {
                            console.log(`✅ [processAudioForMixing] Используем трек из receiver напрямую: ${receiver.track.id}`);
                            receiverStream.addTrack(receiver.track);
                        }
                    });
                    
                    if (receiverStream.getAudioTracks().length > 0) {
                        activeStream = receiverStream;
                        console.log(`✅ [processAudioForMixing] Создан поток из receivers напрямую для ${publisherIdStr}, треков: ${receiverStream.getAudioTracks().length}`);
                    } else {
                        activeStream = stream;
                        console.log(`⚠️ [processAudioForMixing] Используем переданный поток для ${publisherIdStr} (receivers пусты)`);
                    }
                } else {
                    activeStream = stream;
                    console.log(`⚠️ [processAudioForMixing] Используем переданный поток для ${publisherIdStr} (handle не найден или PC нет)`);
                }
            }
            
            console.log(`🔍 [processAudioForMixing] Финальный activeStream для ${publisherIdStr}:`, {
                id: activeStream.id,
                active: activeStream.active,
                tracksCount: activeStream.getAudioTracks().length
            });
            
            // Получаем треки из активного потока
            const activeTracks = activeStream.getAudioTracks();
            if (activeTracks.length === 0) {
                console.error(`❌ Нет аудио треков в активном потоке для ${publisherIdStr}!`);
                return;
            }
            
            // Ищем активный трек
            let activeTrack = activeTracks.find(track => !track.muted && track.readyState === 'live' && track.enabled);
            
            // Если не нашли активный трек, пытаемся получить из receiver
            if (!activeTrack && subscriberHandle && subscriberHandle.webrtcStuff && subscriberHandle.webrtcStuff.pc) {
                const pc = subscriberHandle.webrtcStuff.pc;
                const receivers = pc.getReceivers();
                console.log(`🔍 Проверяем ${receivers.length} receivers для ${publisherIdStr}`);
                for (const receiver of receivers) {
                    if (receiver.track && receiver.track.kind === 'audio') {
                        console.log(`🔍 Receiver трек ${receiver.track.id}: muted=${receiver.track.muted}, readyState=${receiver.track.readyState}, enabled=${receiver.track.enabled}`);
                        if (!receiver.track.muted && receiver.track.readyState === 'live' && receiver.track.enabled) {
                            activeTrack = receiver.track;
                            console.log(`✅ Найден активный трек в receiver: ${activeTrack.id}`);
                            break;
                        }
                    }
                }
            }
            
            if (!activeTrack) {
                console.error(`❌ Не найден активный трек для ${publisherIdStr}!`);
                console.error(`🔍 Доступные треки в потоке:`, activeTracks.map(t => ({
                    id: t.id,
                    muted: t.muted,
                    enabled: t.enabled,
                    readyState: t.readyState
                })));
                return;
            }
            
            // ВАЖНО: Используем HTMLAudioElement для воспроизведения WebRTC аудио
            // Это стандартный и надежный способ - MediaStreamAudioSourceNode часто не работает с WebRTC
            console.log(`🎧 Создаем HTMLAudioElement для воспроизведения потока ${publisherIdStr}...`);
            
            // Создаем аудио элемент для воспроизведения
            // ВАЖНО: autoplay=false, чтобы звук не начал воспроизводиться до подключения к Web Audio API
            const audioElement = document.createElement('audio');
            audioElement.id = `remote-audio-${publisherIdStr}`;
            audioElement.autoplay = false; // НЕ autoplay - сначала подключим к Web Audio API
            audioElement.playsInline = true;
            audioElement.muted = false; // НЕ muted - нам нужен звук!
            
            // Используем activeStream напрямую (он уже содержит нужный трек)
            audioElement.srcObject = activeStream;
            console.log(`✅ srcObject установлен для ${publisherIdStr}, поток id: ${activeStream.id}`);
            
            // Добавляем элемент на страницу (скрытый)
            audioElement.style.display = 'none';
            document.body.appendChild(audioElement);
            console.log(`✅ Audio элемент добавлен на страницу для ${publisherIdStr}`);
            
            // Обработчики событий для отладки
            audioElement.onplay = () => console.log(`▶️ Audio ${publisherIdStr} playing`);
            audioElement.onpause = () => console.warn(`⏸️ Audio ${publisherIdStr} paused`);
            audioElement.onerror = (e) => console.error(`❌ Audio ${publisherIdStr} error:`, e);
            audioElement.onended = () => console.warn(`⏹️ Audio ${publisherIdStr} ended`);
            audioElement.onloadeddata = () => console.log(`📦 Audio ${publisherIdStr} data loaded`);
            audioElement.oncanplay = () => console.log(`✅ Audio ${publisherIdStr} can play`);
            
            // ВАЖНО: Создаем MediaElementAudioSourceNode ПЕРЕД вызовом play()!
            // Это перенаправит звук из audioElement в Web Audio API
            // После этого звук будет идти ТОЛЬКО через Web Audio API (source -> gainNode -> destination)
            let source;
            try {
                source = this.audioContext.createMediaElementSource(audioElement);
                console.log(`✅ MediaElementAudioSourceNode создан для ${publisherIdStr}`);
            } catch (e) {
                console.error(`❌ Ошибка создания MediaElementAudioSourceNode:`, e);
                // Если не удалось создать source, используем только audioElement
                // Громкость будем регулировать через audioElement.volume
                console.log(`⚠️ Используем только HTMLAudioElement для ${publisherIdStr} (без Web Audio API)`);
                
                // Запускаем воспроизведение напрямую
                audioElement.autoplay = true;
                audioElement.play().catch(e => console.error(`❌ Ошибка воспроизведения:`, e));
                
                this.streamVolumes.set(publisherIdStr, {
                    audioElement: audioElement,
                    volume: 1.0,
                    display: displayName
                });
                
                // Удаляем из pending (поток получен)
                this.pendingPublishers.delete(publisherIdStr);
                
                // ВАЖНО: Обновляем UI после добавления нового участника
                this.notifyParticipantsUpdate();
                return;
            }
            
            // Создаем GainNode для управления громкостью
            const gainNode = this.audioContext.createGain();
            gainNode.gain.value = 1.0; // Начальная громкость 100%
            console.log(`✅ GainNode создан для ${publisherIdStr}, gain=${gainNode.gain.value}`);
            
            // Подключаем: source -> gainNode -> destination (напрямую!)
            // ВАЖНО: Подключаем напрямую к destination, а не к audioMixer
            // Это гарантирует, что GainNode контролирует громкость
            source.connect(gainNode);
            console.log(`✅ source подключен к gainNode для ${publisherIdStr}`);
            
            gainNode.connect(this.audioContext.destination);
            console.log(`✅ gainNode подключен к destination для ${publisherIdStr}`);
            
            // Теперь запускаем воспроизведение - звук пойдет через Web Audio API
            const playPromise = audioElement.play();
            if (playPromise !== undefined) {
                playPromise
                    .then(() => {
                        console.log(`✅ Воспроизведение запущено для ${publisherIdStr}`);
                        console.log(`🔍 audioElement.paused=${audioElement.paused}, volume=${audioElement.volume}, muted=${audioElement.muted}`);
                    })
                    .catch(err => {
                        console.error(`❌ Ошибка запуска воспроизведения для ${publisherIdStr}:`, err);
                        // Autoplay был заблокирован браузером
                        console.log(`⚠️ Autoplay заблокирован. Ожидаем взаимодействия пользователя...`);
                        
                        // Добавляем обработчик клика для запуска воспроизведения
                        const resumePlayback = () => {
                            audioElement.play()
                                .then(() => {
                                    console.log(`✅ Воспроизведение запущено после взаимодействия для ${publisherIdStr}`);
                                    document.removeEventListener('click', resumePlayback);
                                    document.removeEventListener('touchstart', resumePlayback);
                                })
                                .catch(e => console.error(`❌ Повторная попытка воспроизведения не удалась:`, e));
                        };
                        document.addEventListener('click', resumePlayback, { once: true });
                        document.addEventListener('touchstart', resumePlayback, { once: true });
                    });
            }
            
            console.log(`🔗 Подключено: source (${source.numberOfOutputs} outputs) -> gainNode (${gainNode.numberOfInputs} inputs, ${gainNode.numberOfOutputs} outputs) -> destination`);
            
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
            
            // Сохраняем для управления (включая audioElement)
            this.streamVolumes.set(publisherIdStr, {
                gainNode: gainNode,
                source: source,
                audioElement: audioElement,
                volume: 1.0,
                display: displayName
            });
            
            // Удаляем из pending (поток получен)
            this.pendingPublishers.delete(publisherIdStr);
            
            console.log(`✅ Аудио поток ${publisherIdStr} (${displayName}) подключен к Web Audio API`);
            
            // ВАЖНО: Обновляем UI после добавления нового участника
            this.notifyParticipantsUpdate();
            console.log(`🔍 AudioContext состояние: ${this.audioContext.state}`);
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
        const publisherIdStr = String(publisherId);
        
        // Отключаем поток от микшера
        const streamData = this.streamVolumes.get(publisherIdStr);
        if (streamData) {
            try {
                if (streamData.source) streamData.source.disconnect();
                if (streamData.gainNode) streamData.gainNode.disconnect();
            } catch (e) {
                console.warn(`Ошибка при отключении потока ${publisherId}:`, e);
            }
            this.streamVolumes.delete(publisherIdStr);
        }
        
        // Удаляем из pending (если ещё был там)
        this.pendingPublishers.delete(publisherIdStr);
        
        // Удаляем stream
        this.remoteStreams.delete(publisherIdStr);
        
        // Удаляем видео-поток
        this.removeRemoteVideoStream(publisherId);
        
        // Закрываем subscriber handle
        const handle = this.subscriberHandles.get(publisherIdStr);
        if (handle) {
            try {
                handle.detach();
            } catch (e) {
                console.warn(`Ошибка при закрытии subscriber handle для ${publisherId}:`, e);
            }
            this.subscriberHandles.delete(publisherIdStr);
        }
        
        // Обновляем UI после удаления участника
        this.notifyParticipantsUpdate();
    },
    
    // Получить полный список участников, ВКЛЮЧАЯ себя
    getFullParticipantsList() {
        const participants = [];
        const addedIds = new Set(); // Для избежания дубликатов
        
        // Добавляем себя первым, если мы подключены
        if (this.participantId && this.displayName) {
            participants.push({
                id: this.participantId,
                display: this.displayName,
                isMe: true
            });
            addedIds.add(String(this.participantId));
        }
        
        // Добавляем участников из streamVolumes (уже подключенные потоки)
        this.streamVolumes.forEach((streamData, publisherId) => {
            const idStr = String(publisherId);
            if (!addedIds.has(idStr)) {
                participants.push({
                    id: publisherId,
                    display: streamData.display || 'Пользователь'
                });
                addedIds.add(idStr);
            }
        });
        
        // Добавляем pending publishers (подписались, но поток ещё не получен)
        this.pendingPublishers.forEach((publisherData, publisherId) => {
            const idStr = String(publisherId);
            if (!addedIds.has(idStr)) {
                participants.push({
                    id: publisherData.id,
                    display: publisherData.display || 'Пользователь'
                });
                addedIds.add(idStr);
            }
        });
        
        console.log('📋 Полный список участников:', participants.length, '(streamVolumes:', this.streamVolumes.size, ', pending:', this.pendingPublishers.size, ')');
        return participants;
    },
    
    // Уведомить UI об изменении списка участников
    notifyParticipantsUpdate() {
        if (window.onParticipantsUpdate) {
            const fullList = this.getFullParticipantsList();
            console.log('🔄 Уведомляем UI об изменении участников:', fullList.length, 'участников');
            window.onParticipantsUpdate(fullList, this.participantId);
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

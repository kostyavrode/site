// ============================================
// Проверка микрофона и звука, индикация речи, режим рации и горячие клавиши
// ============================================
// Подключается после audio.js и дополняет AudioModule.

(function () {
    const MIC_CHECK_MS = 5000;
    const SPEAKING_TICK_MS = 150;
    const SPEAKING_HOLD_MS = 350; // имя не мигает в паузах между словами
    const SPEAKING_LEVEL = 0.015; // порог громкости, 0..1
    const PTT_RELEASE_MS = 120; // не обрезаем конец слова при отпускании клавиши
    const SELF_ID = 'me';

    // Очень тихие короткие сигналы, слышит только сам пользователь: в эфир они не идут
    const UI_SOUNDS = {
        mute: [660, 494],
        unmute: [494, 660],
        pttOn: [587],
        pttOff: [440]
    };

    // Левая и правая клавиши-модификаторы в браузере и в приложении дают один код
    const isTextField = (el) => {
        if (!el) return false;
        if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
        return el.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button'].includes(el.type);
    };

    Object.assign(AudioModule, {
        pttHeld: false,
        nativeHotkeys: false,
        hotkeysPaused: false, // в настройках назначают клавишу
        _pttReleaseTimer: null,
        _speakingTimer: null,
        _speakingBusy: false,
        _speakingSince: new Map(), // id -> когда последний раз звучал голос
        _speakingNow: new Set(),
        _sourceStamps: new Map(), // id -> метка времени последнего пакета
        _micCheck: null,

        // ---------- Сигналы ----------

        playUiSound(kind) {
            const ctx = this.audioContext;
            const notes = UI_SOUNDS[kind];
            if (!ctx || ctx.state !== 'running' || !notes) return;
            notes.forEach((frequency, index) => this._playNote(frequency, ctx.currentTime + index * 0.055, 0.09, 0.035));
        },

        _playNote(frequency, startAt, duration, peak) {
            const ctx = this.audioContext;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = frequency;
            gain.gain.setValueAtTime(0, startAt);
            gain.gain.linearRampToValueAtTime(peak, startAt + 0.01);
            gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(startAt);
            osc.stop(startAt + duration + 0.02);
        },

        /** Мьют от пользователя: кнопка или клавиша. */
        toggleMuteWithSound() {
            const muted = this.toggleMute();
            this.playUiSound(muted ? 'mute' : 'unmute');
            window.dispatchEvent(new CustomEvent('micmutechange', { detail: { muted } }));
            return muted;
        },

        // ---------- Горячие клавиши ----------

        /** @param {'ptt'|'mute'} action */
        handleHotkey(action, pressed) {
            if (!this.channelId || this.hotkeysPaused) return;
            // В приложении клавиши глобальные: набор текста в чате не должен их нажимать
            if (pressed && document.hasFocus() && isTextField(document.activeElement)) return;

            if (action === 'mute') {
                if (pressed) this.toggleMuteWithSound();
                return;
            }
            if (!this.audioSettings.pushToTalk || pressed === this.pttHeld) return;

            clearTimeout(this._pttReleaseTimer);
            this.pttHeld = pressed;
            if (pressed) {
                this.applyMicState();
            } else {
                this._pttReleaseTimer = setTimeout(() => this.applyMicState(), PTT_RELEASE_MS);
            }
            if (!this.manualMuted) {
                this.playUiSound(pressed ? 'pttOn' : 'pttOff');
            }
        },

        /** Передаёт клавиши приложению; в браузере работают обычные события страницы. */
        async syncHotkeys() {
            const app = window.AppPages;
            if (!app || !app.setHotkeys) return;
            const { pttKey, muteKey, pushToTalk } = this.audioSettings;
            try {
                this.nativeHotkeys = await app.setHotkeys(pushToTalk && pttKey ? pttKey.vk : 0, muteKey ? muteKey.vk : 0);
            } catch (error) {
                console.warn('Горячие клавиши приложения:', error);
                this.nativeHotkeys = false;
            }
        },

        _onKeyEvent(event, pressed) {
            if (this.nativeHotkeys || event.repeat) return;
            const { pttKey, muteKey } = this.audioSettings;
            if (pttKey && event.code === pttKey.code) this.handleHotkey('ptt', pressed);
            if (muteKey && event.code === muteKey.code) this.handleHotkey('mute', pressed);
        },

        // ---------- Кто говорит ----------

        startSpeakingMonitor() {
            if (this._speakingTimer) return;
            this._speakingTimer = setInterval(() => this._speakingTick(), SPEAKING_TICK_MS);
        },

        stopSpeakingMonitor() {
            clearInterval(this._speakingTimer);
            this._speakingTimer = null;
            this._speakingSince.clear();
            this._sourceStamps.clear();
            [...this._speakingNow].forEach((id) => this._setSpeaking(id, false));
        },

        _setSpeaking(id, speaking) {
            if (speaking === this._speakingNow.has(id)) return;
            if (speaking) {
                this._speakingNow.add(id);
            } else {
                this._speakingNow.delete(id);
            }
            if (window.onAudioSpeaking) window.onAudioSpeaking(id, speaking);
        },

        /** Лёгкий путь - уровень из RTP без дополнительной обработки звука, getStats только как запасной. */
        async _remoteLevel(id, handle) {
            const pc = handle.webrtcStuff && handle.webrtcStuff.pc;
            const receiver = pc && pc.getReceivers().find((r) => r.track && r.track.kind === 'audio');
            if (!receiver) return 0;

            const source = receiver.getSynchronizationSources && receiver.getSynchronizationSources()[0];
            if (source && source.audioLevel !== undefined) {
                // Пока человек молчит, пакеты не идут, а запись с прошлым уровнем остаётся
                const fresh = this._sourceStamps.get(id) !== source.timestamp;
                this._sourceStamps.set(id, source.timestamp);
                return fresh ? source.audioLevel : 0;
            }

            const stats = await receiver.getStats();
            let level = 0;
            stats.forEach((report) => {
                if (report.type === 'inbound-rtp' && report.audioLevel !== undefined) level = report.audioLevel;
            });
            return level;
        },

        _localLevel() {
            if (this.isMuted || !this.micGainNode) return 0;
            if (this._speakingTap !== this.micGainNode) {
                this._speakingAnalyser = this.audioContext.createAnalyser();
                this._speakingAnalyser.fftSize = 1024;
                this.micGainNode.connect(this._speakingAnalyser);
                this._speakingTap = this.micGainNode;
                this._speakingSamples = new Float32Array(this._speakingAnalyser.fftSize);
            }
            this._speakingAnalyser.getFloatTimeDomainData(this._speakingSamples);
            return this._rms(this._speakingSamples);
        },

        _rms(samples) {
            let sum = 0;
            for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
            return Math.sqrt(sum / samples.length);
        },

        async _speakingTick() {
            if (!this.channelId) {
                this.stopSpeakingMonitor();
                return;
            }
            if (this._speakingBusy) return;
            this._speakingBusy = true;
            try {
                const levels = new Map([[SELF_ID, this._localLevel()]]);
                await Promise.all([...this.subscriberHandles].map(async ([id, handle]) => {
                    levels.set(String(id), await this._remoteLevel(id, handle));
                }));

                const now = performance.now();
                levels.forEach((level, id) => {
                    if (level >= SPEAKING_LEVEL) this._speakingSince.set(id, now);
                });
                new Set([...levels.keys(), ...this._speakingNow]).forEach((id) => {
                    const last = this._speakingSince.get(id);
                    this._setSpeaking(id, last !== undefined && now - last < SPEAKING_HOLD_MS);
                });
            } catch (error) {
                console.warn('Индикация речи:', error);
            } finally {
                this._speakingBusy = false;
            }
        },

        // ---------- Проверка звука и микрофона ----------

        /** Короткая мелодия: слышно ли вообще и с какой громкостью. */
        async playSoundCheck() {
            this.initializeAudioContext();
            await this.audioContext.resume();
            const start = this.audioContext.currentTime + 0.03;
            [523, 659, 784].forEach((frequency, index) => this._playNote(frequency, start + index * 0.16, 0.45, 0.16));
        },

        /**
         * Записывает голос через те же фильтры, что и в канале, и проигрывает его:
         * человек слышит себя так, как услышат другие.
         * @param {(level: number) => void} onLevel уровень 0..1
         * @param {(phase: 'record'|'play') => void} onPhase
         */
        async runMicCheck(onLevel, onPhase) {
            this.cancelMicCheck();
            this.initializeAudioContext();
            const ctx = this.audioContext;
            await ctx.resume();

            const ownStream = !this.micRawStream;
            const stream = this.micRawStream || await navigator.mediaDevices.getUserMedia(this.getAudioConstraints());
            const denoiser = await this.createPublishDenoiser();

            const source = ctx.createMediaStreamSource(stream);
            const highpass = ctx.createBiquadFilter();
            highpass.type = 'highpass';
            highpass.frequency.value = 80;
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 1024;
            const destination = ctx.createMediaStreamDestination();
            const nodes = [source, highpass, ...(denoiser ? [denoiser.node] : []), analyser, destination];
            nodes.reduce((from, to) => {
                from.connect(to);
                return to;
            });

            const check = { cancelled: false, audio: null, url: null, stop: null, levelTimer: null };
            this._micCheck = check;
            const samples = new Float32Array(analyser.fftSize);
            check.levelTimer = setInterval(() => {
                analyser.getFloatTimeDomainData(samples);
                onLevel(Math.min(1, this._rms(samples) * 6));
            }, 60);

            const release = () => {
                clearInterval(check.levelTimer);
                onLevel(0);
                nodes.forEach((node) => {
                    try {
                        node.disconnect();
                    } catch (e) {
                        /* ignore */
                    }
                });
                if (denoiser && denoiser.node.port) denoiser.node.port.onmessage = null;
                if (ownStream) stream.getTracks().forEach((track) => track.stop());
            };

            try {
                onPhase('record');
                const blob = await new Promise((resolve, reject) => {
                    const chunks = [];
                    const recorder = new MediaRecorder(destination.stream);
                    recorder.ondataavailable = (event) => chunks.push(event.data);
                    recorder.onerror = (event) => reject(event.error);
                    recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType }));
                    recorder.start();
                    const timer = setTimeout(() => recorder.stop(), MIC_CHECK_MS);
                    check.stop = () => {
                        clearTimeout(timer);
                        if (recorder.state !== 'inactive') recorder.stop();
                    };
                });
                release();
                if (check.cancelled) return;

                onPhase('play');
                check.url = URL.createObjectURL(blob);
                check.audio = new Audio(check.url);
                await new Promise((resolve, reject) => {
                    check.audio.onended = resolve;
                    check.audio.onerror = () => reject(new Error('Не удалось воспроизвести запись'));
                    check.stop = resolve;
                    check.audio.play().catch(reject);
                });
            } catch (error) {
                release();
                throw error;
            } finally {
                if (check.audio) check.audio.pause();
                if (check.url) URL.revokeObjectURL(check.url);
                if (this._micCheck === check) this._micCheck = null;
            }
        },

        cancelMicCheck() {
            const check = this._micCheck;
            if (!check) return;
            check.cancelled = true;
            if (check.stop) check.stop();
        }
    });

    window.__onGlobalHotkey = (action, pressed) => AudioModule.handleHotkey(action, pressed);
    window.addEventListener('keydown', (event) => AudioModule._onKeyEvent(event, true), true);
    window.addEventListener('keyup', (event) => AudioModule._onKeyEvent(event, false), true);
    // Клавишу могли отпустить уже в другом окне, и микрофон остался бы открыт
    window.addEventListener('blur', () => {
        if (!AudioModule.nativeHotkeys) AudioModule.handleHotkey('ptt', false);
    });
})();

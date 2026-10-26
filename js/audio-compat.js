// ============================================
// Совместимость звука с разными браузерами
// ============================================
//
// Подключается после audio.js и ничего в нём не переписывает: только оборачивает
// создание AudioContext и следит за тем, чтобы звук не "засыпал". В Chrome, Edge и
// Firefox всё здесь - пустые проверки; убрать тег <script> - и поведение прежнее.
//
// Что решает:
// 1. Safari и все браузеры на iPhone/iPad (там любой браузер - это движок Safari).
//    audio.js пропускает чужой звук через Web Audio (createMediaElementSource).
//    Движки ведут себя здесь по-разному: в Firefox звук идёт через Web Audio,
//    в Chrome <audio> продолжает играть сам. Для WebKit надёжно работает только
//    обычный <audio> с потоком WebRTC, поэтому там Web Audio для чужого звука
//    отключается - и audio.js сам переходит на свою запасную ветку
//    "используем только HTMLAudioElement".
// 2. Браузер приостановил звук: вкладка в фоне, блокировка экрана, входящий звонок
//    (в Safari у AudioContext для этого есть состояние 'interrupted', которого нет
//    в Chrome). Через AudioContext идёт и микрофон в эфир, поэтому без возобновления
//    человек и сам не слышит, и его не слышно.

(function () {
    if (typeof AudioModule === 'undefined' || !AudioModule) {
        return;
    }

    const ua = navigator.userAgent || '';
    // В Chrome/Edge/Opera тоже есть слово AppleWebKit, но там есть и Chrome/Edg/OPR.
    // У Chrome и Firefox на iOS (CriOS, FxiOS) слова Chrome нет - они сюда попадают, как и нужно.
    const isWebKit = /AppleWebKit/i.test(ua) && !/Chrome|Chromium|Edg\/|OPR\/|Android/i.test(ua);

    const state = {
        webkitDirectPlayback: false, // чужой звук играет через <audio> напрямую
        contextResumes: 0,           // сколько раз пришлось будить AudioContext
        elementResumes: 0            // сколько раз пришлось снова запускать <audio>
    };

    function ignore() { /* повторим при следующем событии */ }

    function safePromise(result) {
        if (result && typeof result.catch === 'function') {
            result.catch(ignore);
        }
    }

    // Разбудить всё, что браузер приостановил. Вызывать можно сколько угодно раз:
    // если звук идёт, функция ничего не делает.
    function wakeAudio() {
        const ctx = AudioModule.audioContext;
        // AudioContext существует только пока пользователь в канале (audio.js закрывает его
        // при отключении) и сам никогда не приостанавливается - значит, это сделал браузер
        if (ctx && ctx.state !== 'running' && ctx.state !== 'closed') {
            state.contextResumes++;
            try {
                safePromise(ctx.resume());
            } catch (e) {
                ignore();
            }
        }

        if (AudioModule.streamVolumes) {
            AudioModule.streamVolumes.forEach(function (data) {
                const element = data && data.audioElement;
                // audio.js ставит <audio> на паузу только при удалении участника (и сразу убирает
                // запись из streamVolumes), так что пауза здесь - тоже дело рук браузера
                if (element && element.paused && element.srcObject) {
                    state.elementResumes++;
                    try {
                        safePromise(element.play());
                    } catch (e) {
                        ignore();
                    }
                }
            });
        }
    }

    function prepareContext(ctx) {
        if (!ctx || ctx.__audioCompatReady) {
            return;
        }
        ctx.__audioCompatReady = true;

        // Конец звонка или возврат из фона: Safari оставляет контекст в 'interrupted' / 'suspended'
        if (typeof ctx.addEventListener === 'function') {
            ctx.addEventListener('statechange', function () {
                if (ctx.state !== 'running' && ctx.state !== 'closed' && document.visibilityState === 'visible') {
                    setTimeout(wakeAudio, 300);
                }
            });
        }

        if (isWebKit) {
            state.webkitDirectPlayback = true;
            ctx.createMediaElementSource = function () {
                throw new Error('WebKit: звук WebRTC воспроизводится напрямую через <audio>');
            };
        }
    }

    const initializeAudioContext = AudioModule.initializeAudioContext;
    AudioModule.initializeAudioContext = function () {
        const result = initializeAudioContext.apply(this, arguments);
        prepareContext(this.audioContext);
        return result;
    };

    // Возврат на вкладку, разблокировка экрана, восстановление страницы из кэша
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') {
            wakeAudio();
        }
    });
    window.addEventListener('pageshow', wakeAudio);
    window.addEventListener('focus', wakeAudio);

    // Любое действие пользователя: некоторые браузеры разрешают запускать звук только из него
    ['pointerdown', 'touchend', 'keydown'].forEach(function (type) {
        document.addEventListener(type, wakeAudio, { capture: true, passive: true });
    });

    // Страховка на случай, когда приостановка закончилась без единого события
    // (например, завершился звонок, пока страница была на экране)
    setInterval(function () {
        if (document.visibilityState === 'visible') {
            wakeAudio();
        }
    }, 3000);

    // Для отладки из консоли: AudioCompat.getState()
    window.AudioCompat = {
        isWebKit: isWebKit,
        wakeAudio: wakeAudio,
        getState: function () {
            const ctx = AudioModule.audioContext;
            return {
                isWebKit: isWebKit,
                webkitDirectPlayback: state.webkitDirectPlayback,
                contextState: ctx ? ctx.state : null,
                contextResumes: state.contextResumes,
                elementResumes: state.elementResumes
            };
        }
    };
})();

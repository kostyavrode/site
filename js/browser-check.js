// ============================================
// Проверка браузера
// ============================================
//
// Подключается первым скриптом страницы. Если браузер не может работать с сайтом,
// показывает понятное сообщение вместо молчащей страницы.
//
// ВАЖНО: файл написан на старом JavaScript (ES5) - без let/const, стрелочных функций,
// шаблонных строк и т.п. Он обязан выполниться именно в тех браузерах, в которых
// остальные скрипты сайта даже не разбираются.

(function () {
    var DOWNLOAD_URL = 'downloads/AudioChat-Setup.exe';

    // Голосовые каналы есть только на странице группы
    var needsAudio = /group\.html/i.test(window.location.pathname);

    function supportsModernSyntax() {
        try {
            // То, чем пользуются скрипты сайта: async/await, ?. и ??
            new Function('var a = null; var f = async function () {}; return a?.b ?? f;')();
            return true;
        } catch (e) {
            return false;
        }
    }

    function detectProblem() {
        if (!supportsModernSyntax() || !window.Promise || !window.fetch) {
            return { fatal: true, kind: 'old' };
        }
        if (!needsAudio) {
            return null;
        }
        if (!window.WebSocket) {
            return { fatal: true, kind: 'old' };
        }
        // Микрофон браузеры дают только страницам, открытым по HTTPS (или с localhost)
        if (window.isSecureContext === false) {
            return { fatal: false, kind: 'insecure' };
        }
        if (!window.RTCPeerConnection ||
            !window.RTCPeerConnection.prototype ||
            typeof window.RTCPeerConnection.prototype.getTransceivers !== 'function' ||
            !(window.AudioContext || window.webkitAudioContext)) {
            return { fatal: false, kind: 'no-webrtc' };
        }
        if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
            return { fatal: false, kind: 'no-microphone-api' };
        }
        return null;
    }

    function link(href, text) {
        var a = document.createElement('a');
        a.href = href;
        a.appendChild(document.createTextNode(text));
        a.style.color = '#1e1e1e';
        a.style.textDecoration = 'underline';
        a.style.fontWeight = 'bold';
        return a;
    }

    function buildMessage(problem, box) {
        var text = function (value) { box.appendChild(document.createTextNode(value)); };

        if (problem.kind === 'old') {
            text('Ваш браузер устарел, и сайт в нём не работает. Обновите браузер (подойдут свежие Chrome, Firefox, Edge, Safari) или установите ');
            box.appendChild(link(DOWNLOAD_URL, 'приложение для Windows'));
            text('.');
        } else if (problem.kind === 'insecure') {
            text('Страница открыта без HTTPS, поэтому браузер не даст доступ к микрофону и голосовые каналы работать не будут. ');
            box.appendChild(link('https://' + window.location.host + window.location.pathname + window.location.search, 'Открыть по HTTPS'));
            text('.');
        } else if (problem.kind === 'no-microphone-api') {
            text('Этот браузер не даёт сайтам доступ к микрофону - так бывает во встроенных браузерах Telegram, VK, Instagram и других приложений. Чат работает, но для голосовых каналов откройте сайт в обычном браузере: Chrome, Safari, Firefox или Edge.');
        } else {
            text('Этот браузер не поддерживает голосовую связь. Чат работает, но для голосовых каналов обновите браузер (подойдут свежие Chrome, Firefox, Edge, Safari) или установите ');
            box.appendChild(link(DOWNLOAD_URL, 'приложение для Windows'));
            text('.');
        }
    }

    function showBanner(problem) {
        if (document.getElementById('browserCheckBanner')) {
            return;
        }

        var banner = document.createElement('div');
        banner.id = 'browserCheckBanner';
        banner.setAttribute('role', 'alert');
        banner.style.cssText = 'position:relative;z-index:2000;padding:12px 44px 12px 16px;' +
            'background:#dcdcaa;color:#1e1e1e;border-bottom:1px solid #3e3e42;' +
            'font-family:Consolas,Monaco,"Courier New",monospace;font-size:14px;line-height:1.5;text-align:center;';

        var message = document.createElement('span');
        buildMessage(problem, message);
        banner.appendChild(message);

        // Сообщение о нерабочем сайте закрывать незачем, предупреждение про голос - можно
        if (!problem.fatal) {
            var close = document.createElement('button');
            close.type = 'button';
            close.setAttribute('aria-label', 'Закрыть');
            close.appendChild(document.createTextNode('✕'));
            close.style.cssText = 'position:absolute;top:8px;right:12px;border:0;background:transparent;' +
                'color:#1e1e1e;font-size:16px;cursor:pointer;';
            close.onclick = function () {
                if (banner.parentNode) {
                    banner.parentNode.removeChild(banner);
                }
            };
            banner.appendChild(close);
        }

        document.body.insertBefore(banner, document.body.firstChild);
    }

    var problem = detectProblem();
    if (!problem) {
        return;
    }

    if (document.body) {
        showBanner(problem);
    } else if (document.addEventListener) {
        document.addEventListener('DOMContentLoaded', function () { showBanner(problem); });
    } else {
        window.onload = function () { showBanner(problem); };
    }
})();

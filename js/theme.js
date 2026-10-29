// ============================================
// Тема: светлая / тёмная
// ============================================
// Подключается в <head> до стилей: тема ставится до первой отрисовки, без белой вспышки.
// По умолчанию - как в системе; выбор пользователя запоминается (localStorage 'theme').

(function () {
    const KEY = 'theme';
    const root = document.documentElement;
    const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

    function saved() {
        try {
            const value = localStorage.getItem(KEY);
            return value === 'dark' || value === 'light' ? value : null;
        } catch (e) {
            return null;
        }
    }

    function effective() {
        return saved() || (media && media.matches ? 'dark' : 'light');
    }

    function apply() {
        const theme = effective();
        root.setAttribute('data-theme', theme);
        const button = document.getElementById('themeToggle');
        if (button) {
            const label = theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему';
            button.setAttribute('aria-label', label);
            button.title = label;
        }
    }

    apply();

    // Система сменила тему, а пользователь сам не выбирал - следуем за системой
    if (media) {
        const onChange = () => {
            if (!saved()) apply();
        };
        if (media.addEventListener) media.addEventListener('change', onChange);
        else if (media.addListener) media.addListener(onChange);
    }

    window.Theme = {
        get: effective,
        toggle() {
            const next = effective() === 'dark' ? 'light' : 'dark';
            try {
                localStorage.setItem(KEY, next);
            } catch (e) {
                // без localStorage тема просто не запомнится
            }
            apply();
        },
        // Кнопка в шапке; в приложении страницы рисуются позже - вызывается повторно
        bind() {
            const button = document.getElementById('themeToggle');
            if (button && !button.__themeBound) {
                button.__themeBound = true;
                button.addEventListener('click', () => window.Theme.toggle());
            }
            apply();
        }
    };

    document.addEventListener('DOMContentLoaded', () => window.Theme.bind());
})();

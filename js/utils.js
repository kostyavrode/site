// ============================================
// Утилиты
// ============================================

const Utils = {
    // Форматирование даты
    formatDate(date) {
        if (!date) return '';
        const d = new Date(date);
        return d.toLocaleString('ru-RU', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });
    },

    // Форматирование относительного времени
    formatRelativeTime(date) {
        if (!date) return '';
        const now = new Date();
        const d = new Date(date);
        const diff = now - d;
        const seconds = Math.floor(diff / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (seconds < 60) return 'только что';
        if (minutes < 60) return `${minutes} мин. назад`;
        if (hours < 24) return `${hours} ч. назад`;
        if (days < 7) return `${days} дн. назад`;
        return this.formatDate(date);
    },

    // Экранирование HTML
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    },

    // Показать сообщение об ошибке
    showError(message, container = document.body) {
        const alert = document.createElement('div');
        alert.className = 'alert alert-error';
        alert.textContent = message;
        container.insertBefore(alert, container.firstChild);
        setTimeout(() => alert.remove(), 5000);
    },

    // Показать сообщение об успехе
    showSuccess(message, container = document.body) {
        const alert = document.createElement('div');
        alert.className = 'alert alert-success';
        alert.textContent = message;
        container.insertBefore(alert, container.firstChild);
        setTimeout(() => alert.remove(), 5000);
    },

    // Показать сообщение
    showInfo(message, container = document.body) {
        const alert = document.createElement('div');
        alert.className = 'alert alert-info';
        alert.textContent = message;
        container.insertBefore(alert, container.firstChild);
        setTimeout(() => alert.remove(), 5000);
    },

    // Загрузка данных с индикатором
    async withLoading(fn, loadingElement) {
        if (loadingElement) {
            loadingElement.style.display = 'block';
        }
        try {
            return await fn();
        } finally {
            if (loadingElement) {
                loadingElement.style.display = 'none';
            }
        }
    }
};

# Инструкция по загрузке janus.js

Библиотека Janus не загружается с CDN. Нужно скачать её локально.

## Способ 1: Через браузер (РЕКОМЕНДУЕТСЯ)

1. Откройте в браузере один из этих URL:
   - https://cdn.jsdelivr.net/gh/meetecho/janus-gateway@v1.1.4/html/janus.js
   - https://janus.conf.meetecho.com/janus.js
   - https://github.com/meetecho/janus-gateway/raw/v1.1.4/html/janus.js

2. Нажмите **Ctrl+S** (Сохранить страницу)
3. Сохраните файл как `janus.js` в папку `site/js/`
   - Полный путь: `E:\audio-kostya\site\js\janus.js`

## Способ 2: Через PowerShell

Откройте PowerShell в папке проекта (`E:\audio-kostya`) и выполните:

```powershell
$url = "https://cdn.jsdelivr.net/gh/meetecho/janus-gateway@v1.1.4/html/janus.js"
Invoke-WebRequest -Uri $url -OutFile "site\js\janus.js"
```

## Проверка

После загрузки:
- Файл должен быть в `site/js/janus.js`
- Размер файла: примерно 200-300 КБ
- Обновите страницу в браузере (Ctrl+F5)

## Если не получается

Можно использовать любой другой CDN или скачать с официального сайта:
https://janus.conf.meetecho.com/janus.js

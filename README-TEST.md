# Тестовая среда

## Запуск тестовой среды

### 1. Запуск бэкенда (audio-project)

```powershell
cd audio-project
.\start-test-env.ps1
```

Это запустит:
- PostgreSQL на порту **5433** (тестовая БД)
- RabbitMQ на порту **5673** (тестовый виртуальный хост `/test`)
- Janus Gateway на порту **8089**
- Все сервисы на портах **6001-6005**

### 2. Запуск фронтенда (site)

```powershell
cd site
.\start-test-server.ps1
```

Или вручную:
```powershell
python -m http.server 8001
```

Сайт будет доступен по адресу: **http://localhost:8001**

### 3. Определение тестовой среды

Тестовая среда определяется автоматически по:
- Порт **8001** (тестовый сайт)
- URL параметр `?test=true`
- Hostname содержащий "test"

При использовании тестовой среды, фронтенд автоматически подключается к тестовым сервисам на портах 6001-6005.

## Остановка тестовой среды

### Остановка бэкенда:
```powershell
cd audio-project
.\stop-test-env.ps1
```

### Остановка фронтенда:
Нажмите `Ctrl+C` в терминале, где запущен сервер.

## Изоляция от продакшена

Тестовая среда полностью изолирована:
- ✅ Отдельные базы данных (с суффиксом `_test`)
- ✅ Отдельные порты для всех сервисов
- ✅ Отдельный виртуальный хост RabbitMQ (`/test`)
- ✅ Отдельные Docker контейнеры
- ✅ Отдельные Docker volumes

## Полезные команды

### Просмотр логов тестовых сервисов:
```powershell
docker-compose -f docker-compose.test.yml logs -f
```

### Просмотр статуса:
```powershell
docker-compose -f docker-compose.test.yml ps
```

### Пересоздание тестовой среды:
```powershell
docker-compose -f docker-compose.test.yml down -v
.\start-test-env.ps1
```

## Порты

### Продакшен:
- Auth: 5001
- Groups: 5002
- Chat: 5003
- Audio: 5004
- Notification: 5005
- Frontend: 8000

### Тест:
- Auth: 6001
- Groups: 6002
- Chat: 6003
- Audio: 6004
- Notification: 6005
- Frontend: 8001

# TeamSpeak 6 -> Telegram bot

Бот подключается к TeamSpeak 6 ServerQuery и отправляет сообщение в Telegram, когда клиент заходит на сервер или выходит с него.

## Что нужно

- Node.js 20+
- доступ к TeamSpeak 6 ServerQuery
- Telegram bot token
- Telegram chat id

## Настройка

При первом запуске программа сама спросит:

- адрес и порт TeamSpeak
- ID виртуального сервера
- тип query (`ssh` или `tcp`)
- логин и пароль ServerQuery
- токен Telegram-бота
- chat ID для Telegram

После этого настройки сохраняются в `data/config.json`.

При следующем запуске бот предложит использовать сохраненную конфигурацию.

При необходимости можно по-прежнему передать все настройки через переменные окружения. Тогда интерактивное меню не используется.

## Запуск

```bash
npm install
npm run build
node dist/index.js
```

## Сборка в EXE

Сборка под Windows делается через `pkg`.

```bash
npm install
npm run package:win
```

Готовый файл будет здесь:

```bash
dist/ts6-bot.exe
```

Запуск:

```bash
dist/ts6-bot.exe
```

При первом запуске `.exe` попросит ввести настройки и сохранит их в `data/config.json`.

## Как это работает

- бот подключается к TeamSpeak через `teamspeak.js`
- выбирает виртуальный сервер
- подписывается на уведомления ServerQuery
- при событиях `ClientEnterView` и `ClientLeaveView` отправляет сообщение в Telegram

## Замечание

Для получения событий у query-аккаунта должно быть право `b_virtualserver_notify_register`.

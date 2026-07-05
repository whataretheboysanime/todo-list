# Todo List

Приватный список дел с категориями, похожий по логике на Google Tasks: несколько списков, быстрые задачи, сроки, избранное, выполненные задачи и адаптация под телефон.

## Возможности

- Вход по логину и паролю.
- Категории/списки задач с цветами.
- Создание, редактирование, удаление задач.
- Срок выполнения, заметки и пометка звездой.
- Фильтры: все задачи, помеченные, сегодня.
- Выполненные задачи сворачиваются внутри списка.
- Mobile-first поведение: нижняя навигация, выезжающее меню списков, карточки в одну колонку.
- SQLite хранится в `data/todo.db`.

## Локальный запуск

```bash
npm install
npm start
```

По умолчанию сервис откроется на `http://localhost:3000`.

Стандартные данные входа для разработки:

```text
login: admin
password: admin
```

Для продакшена обязательно задайте переменные окружения:

```bash
ADMIN_USER=admin
ADMIN_PASSWORD=strong-password
SESSION_SECRET=long-random-secret
APP_TIMEZONE=Europe/Moscow
VAPID_SUBJECT=mailto:you@example.com
PORT=3000
```

Для браузерных push-уведомлений на VPS нужен HTTPS. VAPID-ключи создаются автоматически и сохраняются в SQLite, но можно задать свои через `VAPID_PUBLIC_KEY` и `VAPID_PRIVATE_KEY`.

## Docker

```bash
docker compose up -d --build
```

Данные SQLite будут сохраняться в локальной папке `data`.

## GitHub

```bash
git init
git add .
git commit -m "Initial todo list service"
gh repo create todo-list --private --source=. --remote=origin --push
```

Если нужен публичный репозиторий, замените `--private` на `--public`.

## VPS

Пример ручного деплоя по аналогии с `shopping-list-mvp`:

```bash
ssh user@server
git clone git@github.com:YOUR_USER/todo-list.git
cd todo-list
cp docker-compose.yml docker-compose.prod.yml
```

В `docker-compose.prod.yml` поменяйте `ADMIN_PASSWORD`, `SESSION_SECRET` и при необходимости порт. Затем:

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

Для обновления:

```bash
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

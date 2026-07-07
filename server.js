const path = require('path');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const crypto = require('crypto');
const webpush = require('web-push');

const app = express();
app.set('trust proxy', 1);

const dbFile = path.join(__dirname, 'data', 'todo.db');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
const db = new sqlite3.Database(dbFile);
db.run('PRAGMA foreign_keys = ON');

const PORT = Number(process.env.PORT || 3000);
const AUTH_COOKIE = 'todo_list_session';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const APP_TIMEZONE = process.env.APP_TIMEZONE || 'Europe/Moscow';
const SESSION_SECRET = crypto
  .createHash('sha256')
  .update(process.env.SESSION_SECRET || `${ADMIN_USER}:${ADMIN_PASSWORD}:todo-list-session-v1`)
  .digest();
const SESSION_MAX_AGE = 1000 * 60 * 60 * 24 * 365 * 10;
let vapidKeys = null;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookies(req) {
  return String(req.headers.cookie || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separatorIndex = part.indexOf('=');
      if (separatorIndex === -1) return cookies;
      cookies[part.slice(0, separatorIndex)] = decodeURIComponent(part.slice(separatorIndex + 1));
      return cookies;
    }, {});
}

function signPayload(payload) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
}

function createSessionToken() {
  const payload = Buffer.from(JSON.stringify({ user: ADMIN_USER })).toString('base64url');
  return `${payload}.${signPayload(payload)}`;
}

function verifySessionToken(token) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature || !safeEqual(signature, signPayload(payload))) return false;

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return parsed.user === ADMIN_USER;
  } catch (error) {
    return false;
  }
}

function setSessionCookie(req, res) {
  res.cookie(AUTH_COOKIE, createSessionToken(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: SESSION_MAX_AGE
  });
}

function clearSessionCookie(res) {
  res.clearCookie(AUTH_COOKIE, { httpOnly: true, sameSite: 'lax' });
}

function isAuthenticated(req) {
  return verifySessionToken(parseCookies(req)[AUTH_COOKIE]);
}

function requireAuth(req, res, next) {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Требуется вход' });
  next();
}

function sendError(res, error) {
  console.error(error);
  res.status(500).json({ error: 'Произошла ошибка на сервере' });
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function asInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeDate(value) {
  const text = normalizeText(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function normalizeTime(value) {
  const text = normalizeText(value);
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : null;
}

function normalizeRecurrence(value) {
  const text = normalizeText(value);
  return ['none', 'daily', 'weekly', 'monthly', 'yearly'].includes(text) ? text : 'none';
}

function daysInUtcMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function clampedUtcDate(year, monthIndex, day) {
  const safeDay = Math.min(day, daysInUtcMonth(year, monthIndex));
  return new Date(Date.UTC(year, monthIndex, safeDay));
}

function nextDueDate(dueDate, recurrence) {
  if (!dueDate || recurrence === 'none') return null;
  const date = new Date(`${dueDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;

  if (recurrence === 'daily') date.setUTCDate(date.getUTCDate() + 1);
  if (recurrence === 'weekly') date.setUTCDate(date.getUTCDate() + 7);
  if (recurrence === 'monthly') {
    const targetMonth = date.getUTCMonth() + 1;
    const targetYear = date.getUTCFullYear() + Math.floor(targetMonth / 12);
    return clampedUtcDate(targetYear, targetMonth % 12, date.getUTCDate()).toISOString().slice(0, 10);
  }
  if (recurrence === 'yearly') {
    return clampedUtcDate(date.getUTCFullYear() + 1, date.getUTCMonth(), date.getUTCDate()).toISOString().slice(0, 10);
  }

  return date.toISOString().slice(0, 10);
}

function localNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date()).reduce((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});

  const hour = parts.hour === '24' ? '00' : parts.hour;

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${hour}:${parts.minute}`
  };
}

async function getSetting(key) {
  const row = await get('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : null;
}

async function setSetting(key, value) {
  await run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value]
  );
}

async function ensureVapidKeys() {
  const envPublicKey = normalizeText(process.env.VAPID_PUBLIC_KEY);
  const envPrivateKey = normalizeText(process.env.VAPID_PRIVATE_KEY);

  if (envPublicKey && envPrivateKey) {
    vapidKeys = { publicKey: envPublicKey, privateKey: envPrivateKey };
  } else {
    let publicKey = await getSetting('vapid_public_key');
    let privateKey = await getSetting('vapid_private_key');

    if (!publicKey || !privateKey) {
      const generated = webpush.generateVAPIDKeys();
      publicKey = generated.publicKey;
      privateKey = generated.privateKey;
      await setSetting('vapid_public_key', publicKey);
      await setSetting('vapid_private_key', privateKey);
    }

    vapidKeys = { publicKey, privateKey };
  }

  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    vapidKeys.publicKey,
    vapidKeys.privateKey
  );
}

async function initDb() {
  await run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);

  await run(`CREATE TABLE IF NOT EXISTS lists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#4f7cff',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    list_id INTEGER NOT NULL,
    parent_id INTEGER,
    title TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    due_date TEXT,
    reminder_time TEXT,
    recurrence TEXT NOT NULL DEFAULT 'none',
    notification_sent_for TEXT,
    completed INTEGER NOT NULL DEFAULT 0,
    important INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (list_id) REFERENCES lists(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_id) REFERENCES tasks(id) ON DELETE CASCADE
  )`);

  const taskColumns = await all('PRAGMA table_info(tasks)');
  if (!taskColumns.some((column) => column.name === 'recurrence')) {
    await run("ALTER TABLE tasks ADD COLUMN recurrence TEXT NOT NULL DEFAULT 'none'");
  }
  if (!taskColumns.some((column) => column.name === 'reminder_time')) {
    await run('ALTER TABLE tasks ADD COLUMN reminder_time TEXT');
  }
  if (!taskColumns.some((column) => column.name === 'notification_sent_for')) {
    await run('ALTER TABLE tasks ADD COLUMN notification_sent_for TEXT');
  }

  await run(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT NOT NULL UNIQUE,
    subscription TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  await ensureVapidKeys();

  const existingLists = await get('SELECT COUNT(*) AS count FROM lists');
  if (!existingLists.count) {
    const defaults = [
      ['Личные', '#4f7cff'],
      ['Документы', '#22a06b'],
      ['Врачи', '#d9487d'],
      ['Домашние', '#e0a32e'],
      ['Машина', '#7c5cff']
    ];

    for (const [index, item] of defaults.entries()) {
      await run('INSERT INTO lists (name, color, sort_order) VALUES (?, ?, ?)', [item[0], item[1], index]);
    }
  }
}

app.get('/api/session', (req, res) => {
  const authenticated = isAuthenticated(req);
  res.json({ authenticated, user: authenticated ? ADMIN_USER : null });
});

app.post('/api/login', (req, res) => {
  const login = normalizeText(req.body.login);
  const password = String(req.body.password || '');

  if (login !== ADMIN_USER || !safeEqual(password, ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }

  setSessionCookie(req, res);
  res.json({ authenticated: true, user: ADMIN_USER });
});

app.post('/api/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ authenticated: false });
});

app.use('/api', requireAuth);

app.get('/api/state', async (req, res) => {
  try {
    const lists = await all('SELECT id, name, color, sort_order FROM lists ORDER BY sort_order ASC, id ASC');
    const tasks = await all(`SELECT id, list_id, parent_id, title, notes, due_date, reminder_time, recurrence, completed, important, sort_order, created_at, updated_at
      FROM tasks ORDER BY completed ASC, sort_order ASC, id DESC`);
    res.json({ lists, tasks });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/lists', async (req, res) => {
  try {
    const name = normalizeText(req.body.name);
    const color = normalizeText(req.body.color) || '#4f7cff';
    if (!name) return res.status(400).json({ error: 'Название списка не может быть пустым' });

    const orderRow = await get('SELECT COALESCE(MAX(sort_order), -1) + 1 AS nextOrder FROM lists');
    const result = await run('INSERT INTO lists (name, color, sort_order) VALUES (?, ?, ?)', [name, color, orderRow.nextOrder]);
    res.json({ id: result.lastID, name, color, sort_order: orderRow.nextOrder });
  } catch (error) {
    sendError(res, error);
  }
});

app.put('/api/lists/:id', async (req, res) => {
  try {
    const listId = asInt(req.params.id);
    const name = normalizeText(req.body.name);
    const color = normalizeText(req.body.color) || '#4f7cff';
    if (!listId) return res.status(400).json({ error: 'Некорректный список' });
    if (!name) return res.status(400).json({ error: 'Название списка не может быть пустым' });

    const result = await run('UPDATE lists SET name = ?, color = ? WHERE id = ?', [name, color, listId]);
    if (!result.changes) return res.status(404).json({ error: 'Список не найден' });
    res.json({ id: listId, name, color });
  } catch (error) {
    sendError(res, error);
  }
});

app.delete('/api/lists/:id', async (req, res) => {
  try {
    const listId = asInt(req.params.id);
    if (!listId) return res.status(400).json({ error: 'Некорректный список' });

    const listCount = await get('SELECT COUNT(*) AS count FROM lists');
    if (listCount.count <= 1) return res.status(400).json({ error: 'Нужен хотя бы один список' });

    const result = await run('DELETE FROM lists WHERE id = ?', [listId]);
    if (!result.changes) return res.status(404).json({ error: 'Список не найден' });
    res.json({ success: true });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/tasks', async (req, res) => {
  try {
    const listId = asInt(req.body.list_id);
    const parentId = req.body.parent_id ? asInt(req.body.parent_id) : null;
    const title = normalizeText(req.body.title);
    const notes = normalizeText(req.body.notes);
    const dueDate = normalizeDate(req.body.due_date);
    const reminderTime = normalizeTime(req.body.reminder_time);
    const recurrence = normalizeRecurrence(req.body.recurrence);
    if (!listId) return res.status(400).json({ error: 'Выберите список' });
    if (!title) return res.status(400).json({ error: 'Название задачи не может быть пустым' });

    const orderRow = await get(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS nextOrder FROM tasks WHERE list_id = ? AND ((? IS NULL AND parent_id IS NULL) OR parent_id = ?)',
      [listId, parentId, parentId]
    );
    const result = await run(
      'INSERT INTO tasks (list_id, parent_id, title, notes, due_date, reminder_time, recurrence, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [listId, parentId, title, notes, dueDate, reminderTime, recurrence, orderRow.nextOrder]
    );
    const task = await get('SELECT * FROM tasks WHERE id = ?', [result.lastID]);
    res.json(task);
  } catch (error) {
    sendError(res, error);
  }
});

app.put('/api/tasks/:id', async (req, res) => {
  try {
    const taskId = asInt(req.params.id);
    if (!taskId) return res.status(400).json({ error: 'Некорректная задача' });

    const current = await get('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (!current) return res.status(404).json({ error: 'Задача не найдена' });

    const next = {
      list_id: req.body.list_id ? asInt(req.body.list_id) : current.list_id,
      title: req.body.title === undefined ? current.title : normalizeText(req.body.title),
      notes: req.body.notes === undefined ? current.notes : normalizeText(req.body.notes),
      due_date: req.body.due_date === undefined ? current.due_date : normalizeDate(req.body.due_date),
      reminder_time: req.body.reminder_time === undefined ? current.reminder_time : normalizeTime(req.body.reminder_time),
      recurrence: req.body.recurrence === undefined ? current.recurrence : normalizeRecurrence(req.body.recurrence),
      completed: req.body.completed === undefined ? current.completed : Number(Boolean(req.body.completed)),
      important: req.body.important === undefined ? current.important : Number(Boolean(req.body.important))
    };

    if (!next.list_id) return res.status(400).json({ error: 'Выберите список' });
    if (!next.title) return res.status(400).json({ error: 'Название задачи не может быть пустым' });

    const nextOccurrence = !current.completed && next.completed && next.recurrence !== 'none'
      ? nextDueDate(current.due_date, next.recurrence)
      : null;

    if (nextOccurrence) {
      next.due_date = nextOccurrence;
      next.completed = 0;
    }

    const reminderChanged = next.due_date !== current.due_date || next.reminder_time !== current.reminder_time || nextOccurrence;
    const notificationSentFor = reminderChanged ? null : current.notification_sent_for;

    await run(
      `UPDATE tasks
       SET list_id = ?, title = ?, notes = ?, due_date = ?, reminder_time = ?, recurrence = ?, completed = ?, important = ?, notification_sent_for = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [next.list_id, next.title, next.notes, next.due_date, next.reminder_time, next.recurrence, next.completed, next.important, notificationSentFor, taskId]
    );

    if (next.completed) {
      await run('UPDATE tasks SET completed = 1, updated_at = CURRENT_TIMESTAMP WHERE parent_id = ?', [taskId]);
    }

    const task = await get('SELECT * FROM tasks WHERE id = ?', [taskId]);
    res.json(task);
  } catch (error) {
    sendError(res, error);
  }
});

app.delete('/api/tasks/:id', async (req, res) => {
  try {
    const taskId = asInt(req.params.id);
    if (!taskId) return res.status(400).json({ error: 'Некорректная задача' });

    const result = await run('DELETE FROM tasks WHERE id = ?', [taskId]);
    if (!result.changes) return res.status(404).json({ error: 'Задача не найдена' });
    res.json({ success: true });
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/push/public-key', (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

app.post('/api/push/subscribe', async (req, res) => {
  try {
    const subscription = req.body.subscription;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'Некорректная push-подписка' });
    }

    await run(
      `INSERT INTO push_subscriptions (endpoint, subscription, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(endpoint) DO UPDATE SET subscription = excluded.subscription, updated_at = CURRENT_TIMESTAMP`,
      [subscription.endpoint, JSON.stringify(subscription)]
    );

    res.json({ subscribed: true });
  } catch (error) {
    sendError(res, error);
  }
});

app.delete('/api/push/subscribe', async (req, res) => {
  try {
    const endpoint = normalizeText(req.body.endpoint);
    if (endpoint) await run('DELETE FROM push_subscriptions WHERE endpoint = ?', [endpoint]);
    res.json({ subscribed: false });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/push/test', async (req, res) => {
  try {
    const subscriptions = await all('SELECT id, subscription FROM push_subscriptions ORDER BY id DESC');
    await sendNotificationToSubscriptions(subscriptions, {
      title: 'Задачи',
      body: 'Push-уведомления включены',
      url: '/'
    });
    res.json({ sent: subscriptions.length });
  } catch (error) {
    sendError(res, error);
  }
});

async function sendNotificationToSubscriptions(subscriptions, payload) {
  for (const row of subscriptions) {
    try {
      await webpush.sendNotification(JSON.parse(row.subscription), JSON.stringify(payload));
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) {
        await run('DELETE FROM push_subscriptions WHERE id = ?', [row.id]);
      } else {
        console.error(error);
      }
    }
  }
}

async function sendDueTaskNotifications() {
  const now = localNow();
  const subscriptions = await all('SELECT id, subscription FROM push_subscriptions ORDER BY id ASC');
  if (!subscriptions.length) return;

  const tasks = await all(
    `SELECT id, title, due_date, reminder_time
     FROM tasks
     WHERE parent_id IS NULL
       AND completed = 0
       AND due_date = ?
       AND reminder_time IS NOT NULL
       AND reminder_time <= ?
       AND (notification_sent_for IS NULL OR notification_sent_for != due_date)
     ORDER BY reminder_time ASC, id ASC`,
    [now.date, now.time]
  );

  for (const task of tasks) {
    await sendNotificationToSubscriptions(subscriptions, {
      title: 'Напоминание',
      body: task.title,
      url: '/',
      taskId: task.id
    });
    await run('UPDATE tasks SET notification_sent_for = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [task.due_date, task.id]);
  }
}

function startNotificationScheduler() {
  setInterval(() => {
    sendDueTaskNotifications().catch((error) => console.error(error));
  }, 60 * 1000);

  sendDueTaskNotifications().catch((error) => console.error(error));
}

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Todo list is running on port ${PORT}`);
      startNotificationScheduler();
    });
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

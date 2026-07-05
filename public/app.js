const state = {
  session: null,
  lists: [],
  tasks: [],
  filter: 'all',
  selectedListId: null,
  completedOpen: new Set(),
  sidebarOpen: false
};

const els = {
  authView: document.querySelector('[data-view="auth"]'),
  tasksView: document.querySelector('[data-view="tasks"]'),
  loginForm: document.querySelector('#loginForm'),
  loginError: document.querySelector('[data-login-error]'),
  listNav: document.querySelector('[data-list-nav]'),
  board: document.querySelector('[data-board]'),
  stats: document.querySelector('[data-stats]'),
  activeFilter: document.querySelector('[data-active-filter]'),
  boardTitle: document.querySelector('[data-board-title]'),
  sidebar: document.querySelector('[data-sidebar]'),
  taskModal: document.querySelector('#taskModal'),
  taskForm: document.querySelector('#taskForm'),
  taskError: document.querySelector('[data-task-error]'),
  taskModalTitle: document.querySelector('[data-task-modal-title]'),
  listModal: document.querySelector('#listModal'),
  listForm: document.querySelector('#listForm'),
  listError: document.querySelector('[data-list-error]'),
  listModalTitle: document.querySelector('[data-list-modal-title]'),
  notifyButton: document.querySelector('[data-action="enable-push"]')
};

const api = {
  async request(url, options = {}) {
    const response = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...options
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Ошибка запроса');
    return data;
  },
  get(url) {
    return this.request(url);
  },
  post(url, body) {
    return this.request(url, { method: 'POST', body: JSON.stringify(body) });
  },
  put(url, body) {
    return this.request(url, { method: 'PUT', body: JSON.stringify(body) });
  },
  delete(url) {
    return this.request(url, { method: 'DELETE' });
  }
};

function showView(view) {
  els.authView.hidden = view !== 'auth';
  els.tasksView.hidden = view !== 'tasks';
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function formatDate(iso) {
  if (!iso) return '';
  const date = new Date(`${iso}T00:00:00`);
  return new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short' }).format(date);
}

function recurrenceLabel(value) {
  return {
    daily: 'каждый день',
    weekly: 'каждую неделю',
    monthly: 'каждый месяц',
    yearly: 'каждый год'
  }[value] || '';
}

function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

async function updatePushButton() {
  if (!els.notifyButton) return;
  if (!pushSupported()) {
    els.notifyButton.hidden = true;
    return;
  }

  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = registration ? await registration.pushManager.getSubscription() : null;
  const enabled = Notification.permission === 'granted' && Boolean(subscription);
  els.notifyButton.classList.toggle('is-on', enabled);
  els.notifyButton.title = enabled ? 'Уведомления включены' : 'Включить уведомления';
}

async function enablePushNotifications() {
  if (!pushSupported()) throw new Error('Этот браузер не поддерживает push-уведомления');

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Разрешение на уведомления не выдано');

  const registration = await navigator.serviceWorker.register('/sw.js');
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing || await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array((await api.get('/api/push/public-key')).publicKey)
  });

  await api.post('/api/push/subscribe', { subscription });
  await api.post('/api/push/test', {});
  await updatePushButton();
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function listById(id) {
  return state.lists.find((list) => list.id === Number(id));
}

function taskById(id) {
  return state.tasks.find((task) => task.id === Number(id));
}

function rootTasks() {
  return state.tasks.filter((task) => !task.parent_id);
}

function subtasksFor(taskId) {
  return state.tasks.filter((task) => task.parent_id === Number(taskId));
}

function activeTasksForList(listId) {
  return rootTasks().filter((task) => task.list_id === listId && !task.completed && matchesFilter(task));
}

function completedTasksForList(listId) {
  return rootTasks().filter((task) => task.list_id === listId && task.completed && matchesFilter(task, true));
}

function matchesFilter(task, allowDone = false) {
  if (state.selectedListId && task.list_id !== state.selectedListId) return false;
  if (state.filter === 'important' && !task.important) return false;
  if (state.filter === 'today' && task.due_date !== todayIso()) return false;
  if (!allowDone && state.filter === 'today' && task.completed) return false;
  return true;
}

function filterLabel() {
  if (state.selectedListId) return listById(state.selectedListId)?.name || 'Список';
  if (state.filter === 'important') return 'Помеченные';
  if (state.filter === 'today') return 'Сегодня';
  return 'Все задачи';
}

function setFilter(filter, selectedListId = null) {
  state.filter = filter;
  state.selectedListId = selectedListId;
  state.sidebarOpen = false;
  render();
}

async function loadState() {
  const data = await api.get('/api/state');
  state.lists = data.lists || [];
  state.tasks = data.tasks || [];
  if (state.selectedListId && !listById(state.selectedListId)) state.selectedListId = null;
  render();
}

async function boot() {
  try {
    state.session = await api.get('/api/session');
    if (state.session.authenticated) {
      showView('tasks');
      await loadState();
      await updatePushButton();
    } else {
      showView('auth');
    }
  } catch (error) {
    showView('auth');
  }
}

function render() {
  renderNav();
  renderStats();
  renderBoard();
  renderTaskSelect();
  renderControls();
}

function renderControls() {
  els.sidebar.classList.toggle('is-open', state.sidebarOpen);
  document.querySelectorAll('[data-filter]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.filter === state.filter && !state.selectedListId);
  });
  els.activeFilter.textContent = filterLabel();
  els.boardTitle.textContent = state.selectedListId ? 'Задачи списка' : 'Мои списки';
}

function renderStats() {
  const roots = rootTasks();
  const visible = roots.filter((task) => matchesFilter(task, true));
  const open = visible.filter((task) => !task.completed).length;
  const completed = visible.filter((task) => task.completed).length;
  const important = visible.filter((task) => task.important && !task.completed).length;
  els.stats.innerHTML = `
    <span class="stat-chip">${open} активных</span>
    <span class="stat-chip">${completed} выполнено</span>
    <span class="stat-chip">${important} важных</span>
  `;
}

function renderNav() {
  els.listNav.innerHTML = state.lists
    .map((list) => {
      const count = rootTasks().filter((task) => task.list_id === list.id && !task.completed).length;
      return `
        <button class="list-button ${state.selectedListId === list.id ? 'is-active' : ''}" type="button" data-list-id="${list.id}">
          <span class="color-dot" style="background:${escapeHtml(list.color)}"></span>
          <span>${escapeHtml(list.name)}</span>
          <span class="list-count">${count}</span>
        </button>
      `;
    })
    .join('');
}

function renderTaskSelect() {
  const options = state.lists
    .map((list) => `<option value="${list.id}">${escapeHtml(list.name)}</option>`)
    .join('');
  els.taskForm.elements.list_id.innerHTML = options;
}

function renderBoard() {
  const lists = state.selectedListId ? state.lists.filter((list) => list.id === state.selectedListId) : state.lists;
  els.board.innerHTML = lists.map(renderListCard).join('');
}

function renderListCard(list) {
  const activeTasks = activeTasksForList(list.id);
  const completedTasks = completedTasksForList(list.id);
  const completedOpen = state.completedOpen.has(list.id);
  const selectedClass = state.selectedListId === list.id ? 'is-selected' : '';
  const body = activeTasks.length
    ? activeTasks.map(renderTask).join('')
    : renderEmptyState(completedTasks.length ? 'Все задачи выполнены' : 'Задач пока нет');

  return `
    <article class="list-card ${selectedClass}" data-list-card="${list.id}">
      <header class="list-card-head">
        <div class="list-title">
          <span class="color-dot" style="background:${escapeHtml(list.color)}"></span>
          <h3>${escapeHtml(list.name)}</h3>
        </div>
        <div class="list-tools">
          <button class="icon-button small" type="button" data-action="edit-list" data-id="${list.id}" title="Настроить список">⋮</button>
        </div>
      </header>
      <div class="task-list">
        <button class="add-inline" type="button" data-action="open-task-modal" data-list-id="${list.id}">
          <span>◎</span>
          Добавить задачу
        </button>
        ${body}
        ${renderCompletedArea(list.id, completedTasks, completedOpen)}
      </div>
    </article>
  `;
}

function renderEmptyState(text) {
  return `
    <div class="empty-state">
      <div>
        <div class="empty-illustration">✓</div>
        <strong>${escapeHtml(text)}</strong>
        <p>Ура!</p>
      </div>
    </div>
  `;
}

function renderCompletedArea(listId, tasks, isOpen) {
  if (!tasks.length) return '';
  return `
    <div class="completed-area">
      <button class="completed-toggle" type="button" data-action="toggle-completed" data-list-id="${listId}">
        <span>${isOpen ? '▾' : '▸'}</span>
        ${tasks.length} ${plural(tasks.length, 'задача выполнена', 'задачи выполнено', 'задач выполнено')}
      </button>
      ${isOpen ? tasks.map(renderTask).join('') : ''}
    </div>
  `;
}

function plural(count, one, few, many) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function renderTask(task) {
  const children = subtasksFor(task.id);
  const dueClass = task.due_date === todayIso() ? 'is-today' : '';
  const due = task.due_date
    ? `<span class="meta-pill ${dueClass}">◷ ${escapeHtml(formatDate(task.due_date))}</span>`
    : '';
  const reminder = task.reminder_time
    ? `<span class="meta-pill reminder-pill">🔔 ${escapeHtml(task.reminder_time)}</span>`
    : '';
  const repeat = task.recurrence && task.recurrence !== 'none'
    ? `<span class="meta-pill repeat-pill">↻ ${escapeHtml(recurrenceLabel(task.recurrence))}</span>`
    : '';
  const notes = task.notes ? '<span class="meta-pill">заметка</span>' : '';
  const subtasks = children.length
    ? `<div class="subtasks">${children.map(renderSubtask).join('')}</div>`
    : '';

  return `
    <div class="task-row ${task.completed ? 'is-done' : ''}" data-task-id="${task.id}">
      <button class="task-check ${task.completed ? 'is-done' : ''}" type="button" data-action="toggle-task" data-id="${task.id}" aria-label="Готово">${task.completed ? '✓' : ''}</button>
      <div class="task-main" role="button" tabindex="0" data-action="edit-task" data-id="${task.id}">
        <p class="task-title">${escapeHtml(task.title)}</p>
        <div class="task-meta">${due}${reminder}${repeat}${notes}</div>
      </div>
      <button class="star-button ${task.important ? 'is-on' : ''}" type="button" data-action="toggle-important" data-id="${task.id}" aria-label="Пометить">${task.important ? '★' : '☆'}</button>
      <button class="subtask-add" type="button" data-action="open-subtask-modal" data-id="${task.id}">+ подзадача</button>
      ${subtasks}
    </div>
  `;
}

function renderSubtask(task) {
  return `
    <div class="subtask ${task.completed ? 'is-done' : ''}">
      <button class="task-check ${task.completed ? 'is-done' : ''}" type="button" data-action="toggle-task" data-id="${task.id}" aria-label="Готово">${task.completed ? '✓' : ''}</button>
      <span>${escapeHtml(task.title)}</span>
    </div>
  `;
}

function openTaskModal(task = null, listId = null) {
  const isEditing = Boolean(task?.id);
  els.taskError.textContent = '';
  els.taskForm.reset();
  els.taskForm.elements.id.value = task?.id || '';
  els.taskForm.elements.parent_id.value = task?.parent_id || '';
  els.taskForm.elements.title.value = task?.title || '';
  els.taskForm.elements.list_id.value = task?.list_id || listId || state.selectedListId || state.lists[0]?.id || '';
  els.taskForm.elements.due_date.value = task?.due_date || '';
  els.taskForm.elements.reminder_time.value = task?.reminder_time || '';
  els.taskForm.elements.recurrence.value = task?.recurrence || 'none';
  els.taskForm.elements.notes.value = task?.notes || '';
  els.taskForm.elements.important.checked = Boolean(task?.important);
  els.taskModalTitle.textContent = isEditing ? 'Редактировать задачу' : task?.parent_id ? 'Новая подзадача' : 'Новая задача';
  document.querySelector('[data-action="delete-task"]').hidden = !isEditing;
  els.taskModal.showModal();
  els.taskForm.elements.title.focus();
}

function openListModal(list = null) {
  els.listError.textContent = '';
  els.listForm.reset();
  els.listForm.elements.id.value = list?.id || '';
  els.listForm.elements.name.value = list?.name || '';
  els.listForm.elements.color.value = list?.color || '#4f7cff';
  els.listModalTitle.textContent = list ? 'Редактировать список' : 'Новый список';
  document.querySelector('[data-action="delete-list"]').hidden = !list;
  els.listModal.showModal();
  els.listForm.elements.name.focus();
}

async function saveTask(event) {
  event.preventDefault();
  els.taskError.textContent = '';
  const form = new FormData(els.taskForm);
  const id = form.get('id');
  const body = {
    title: form.get('title'),
    list_id: Number(form.get('list_id')),
    parent_id: form.get('parent_id') ? Number(form.get('parent_id')) : null,
    due_date: form.get('due_date') || null,
    reminder_time: form.get('reminder_time') || null,
    recurrence: form.get('recurrence') || 'none',
    notes: form.get('notes'),
    important: els.taskForm.elements.important.checked
  };

  try {
    if (id) await api.put(`/api/tasks/${id}`, body);
    else await api.post('/api/tasks', body);
    els.taskModal.close();
    await loadState();
  } catch (error) {
    els.taskError.textContent = error.message;
  }
}

async function saveList(event) {
  event.preventDefault();
  els.listError.textContent = '';
  const form = new FormData(els.listForm);
  const id = form.get('id');
  const body = {
    name: form.get('name'),
    color: form.get('color')
  };

  try {
    if (id) await api.put(`/api/lists/${id}`, body);
    else await api.post('/api/lists', body);
    els.listModal.close();
    await loadState();
  } catch (error) {
    els.listError.textContent = error.message;
  }
}

async function deleteCurrentTask() {
  const id = els.taskForm.elements.id.value;
  if (!id) return;
  await api.delete(`/api/tasks/${id}`);
  els.taskModal.close();
  await loadState();
}

async function deleteCurrentList() {
  const id = els.listForm.elements.id.value;
  if (!id) return;
  await api.delete(`/api/lists/${id}`);
  if (state.selectedListId === Number(id)) state.selectedListId = null;
  els.listModal.close();
  await loadState();
}

function resetPointerCursor() {
  document.documentElement.style.cursor = '';
  document.body.style.cursor = '';
}

function resetPointerCursorSoon() {
  window.setTimeout(resetPointerCursor, 0);
}

async function handleAction(target) {
  const action = target.dataset.action;
  if (!action) return;

  if (action === 'toggle-sidebar') {
    state.sidebarOpen = !state.sidebarOpen;
    renderControls();
  }

  if (action === 'sync') await loadState();
  if (action === 'enable-push') await enablePushNotifications();
  if (action === 'logout') {
    await api.post('/api/logout', {});
    showView('auth');
  }
  if (action === 'open-task-modal') openTaskModal(null, Number(target.dataset.listId) || null);
  if (action === 'open-subtask-modal') {
    const parent = taskById(target.dataset.id);
    openTaskModal({ parent_id: parent.id, list_id: parent.list_id, important: parent.important }, parent.list_id);
  }
  if (action === 'close-task-modal') els.taskModal.close();
  if (action === 'open-list-modal') openListModal();
  if (action === 'close-list-modal') els.listModal.close();
  if (action === 'edit-list') openListModal(listById(target.dataset.id));
  if (action === 'edit-task') openTaskModal(taskById(target.dataset.id));
  if (action === 'delete-task') await deleteCurrentTask();
  if (action === 'delete-list') await deleteCurrentList();
  if (action === 'toggle-completed') {
    const listId = Number(target.dataset.listId);
    if (state.completedOpen.has(listId)) state.completedOpen.delete(listId);
    else state.completedOpen.add(listId);
    renderBoard();
  }
  if (action === 'toggle-task') {
    const task = taskById(target.dataset.id);
    await api.put(`/api/tasks/${task.id}`, { completed: !task.completed });
    await loadState();
  }
  if (action === 'toggle-important') {
    const task = taskById(target.dataset.id);
    await api.put(`/api/tasks/${task.id}`, { important: !task.important });
    await loadState();
  }
}

els.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  els.loginError.textContent = '';
  const form = new FormData(els.loginForm);
  try {
    await api.post('/api/login', {
      login: form.get('login'),
      password: form.get('password')
    });
    showView('tasks');
    await loadState();
  } catch (error) {
    els.loginError.textContent = error.message;
  }
});

els.taskForm.addEventListener('submit', saveTask);
els.listForm.addEventListener('submit', saveList);

els.listForm.elements.color.addEventListener('focus', () => {
  window.addEventListener('focus', resetPointerCursorSoon, { once: true });
  window.addEventListener('pointermove', resetPointerCursorSoon, { once: true });
});

els.listForm.elements.color.addEventListener('input', () => {
  resetPointerCursorSoon();
});

els.listForm.elements.color.addEventListener('change', () => {
  els.listForm.elements.color.blur();
  resetPointerCursorSoon();
});

els.listForm.elements.color.addEventListener('blur', () => {
  resetPointerCursorSoon();
});

document.addEventListener('click', async (event) => {
  const filterButton = event.target.closest('[data-filter]');
  if (filterButton) {
    setFilter(filterButton.dataset.filter);
    return;
  }

  const listButton = event.target.closest('[data-list-id]');
  if (listButton && listButton.classList.contains('list-button')) {
    setFilter('all', Number(listButton.dataset.listId));
    return;
  }

  const actionTarget = event.target.closest('[data-action]');
  if (actionTarget) {
    try {
      await handleAction(actionTarget);
    } catch (error) {
      console.error(error);
    }
  }
});

document.addEventListener('keydown', (event) => {
  const target = event.target.closest('[data-action="edit-task"]');
  if (!target) return;
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openTaskModal(taskById(target.dataset.id));
  }
});

boot();

if (pushSupported()) {
  navigator.serviceWorker.ready.then(updatePushButton).catch(() => {});
}

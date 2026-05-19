const API = '/api';

function showToast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show ' + type;
  setTimeout(() => el.classList.remove('show'), 3000);
}

// Модальное окно подтверждения
function showConfirm(title, message, type = 'warning') {
  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.className = 'confirm-modal';
    modal.innerHTML = `
      <div class="confirm-modal-content">
        <div class="confirm-modal-header">
          <h3><i class="fas fa-exclamation-triangle"></i> ${title}</h3>
        </div>
        <div class="confirm-modal-body">
          <p>${message}</p>
        </div>
        <div class="confirm-modal-footer">
          <button class="btn btn-secondary btn-confirm-cancel">Нет</button>
          <button class="btn btn-primary btn-confirm-ok">Да</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    const okBtn = modal.querySelector('.btn-confirm-ok');
    const cancelBtn = modal.querySelector('.btn-confirm-cancel');

    if (type === 'danger') {
      okBtn.className = 'btn btn-danger btn-confirm-ok';
    }

    okBtn.addEventListener('click', () => {
      document.body.removeChild(modal);
      resolve(true);
    });

    cancelBtn.addEventListener('click', () => {
      document.body.removeChild(modal);
      resolve(false);
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        document.body.removeChild(modal);
        resolve(false);
      }
    });
  });
}

async function get(url) {
  const r = await fetch(API + url);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

async function post(url, body) {
  const r = await fetch(API + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('ru', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatLogLine(text) {
  if (!text) return '';

  let formatted = escapeHtml(text);
  const originalText = formatted.toLowerCase();

  // Заголовки с разделителями (=== ... === или _____________________ ... ________________)
  const headerMatch = formatted.match(/^(={3,}|_{5,})\s*(.+?)\s*\1$/);
  if (headerMatch) {
    const title = headerMatch[2].trim();
    const dashes = String.fromCharCode(9472).repeat(Math.max(20, Math.floor((80 - title.length) / 2)));
    return `<div class="log-header">${dashes} ${title} ${dashes}</div>`;
  }

  // Заголовки с подчеркиванием
  const underlineMatch = formatted.match(/^(.+?)\n([=_\-]{3,})$/);
  if (underlineMatch) {
    const title = underlineMatch[1].trim();
    const dashes = String.fromCharCode(9472).repeat(Math.max(20, Math.floor((80 - title.length) / 2)));
    return `<div class="log-header">${dashes} ${title} ${dashes}</div>`;
  }

  // Определяем тип сообщения по логике (порядок важен!)

  // 1. Ошибки и неуспех (приоритет выше успеха)
  if (/error|ошибка|не удалось|не найдено|не найден|failed|exception|traceback|превышен|таймаут/i.test(originalText)) {
    const parts = formatted.split(/(\[.*?\])/);
    let result = '';
    parts.forEach(part => {
      if (part.startsWith('[') && part.endsWith(']')) {
        result += `<span class="log-time">${part}</span>`;
      } else {
        result += `<span class="log-error">${part}</span>`;
      }
    });
    result = result.replace(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g,
      '<span class="log-ip">$1</span>');
    result = result.replace(/\b([a-z0-9]{12,})\b/g,
      (match) => match.length > 10 ? `<span class="log-vm-id">${match}</span>` : match);
    return result;
  }

  // 2. Предупреждения
  if (/warning|внимание|предупреждение/i.test(originalText)) {
    const parts = formatted.split(/(\[.*?\])/);
    let result = '';
    parts.forEach(part => {
      if (part.startsWith('[') && part.endsWith(']')) {
        result += `<span class="log-time">${part}</span>`;
      } else {
        result += `<span class="log-warning">${part}</span>`;
      }
    });
    result = result.replace(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g,
      '<span class="log-ip">$1</span>');
    result = result.replace(/\b([a-z0-9]{12,})\b/g,
      (match) => match.length > 10 ? `<span class="log-vm-id">${match}</span>` : match);
    return result;
  }

  // 3. Успех (только если нет "не" перед ключевыми словами)
  if (/ok|успешно|создан|найден|сохранен|готов|завершён|запущен|удален|удалён/i.test(originalText) &&
      !/не (найден|создан|сохранен|готов|завершён|запущен|удален|удалён)/i.test(originalText)) {
    const parts = formatted.split(/(\[.*?\])/);
    let result = '';
    parts.forEach(part => {
      if (part.startsWith('[') && part.endsWith(']')) {
        result += `<span class="log-time">${part}</span>`;
      } else {
        result += `<span class="log-success">${part}</span>`;
      }
    });
    result = result.replace(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g,
      '<span class="log-ip">$1</span>');
    result = result.replace(/\b([a-z0-9]{12,})\b/g,
      (match) => match.length > 10 ? `<span class="log-vm-id">${match}</span>` : match);
    return result;
  }

  // 4. INFO теги - голубой
  if (/\[info\]/i.test(formatted)) {
    formatted = formatted.replace(/\[info\]/gi, '<span class="log-info">[INFO]</span>');
  }

  // 5. IP адреса и VM ID (всегда выделяем)
  formatted = formatted.replace(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g,
    '<span class="log-ip">$1</span>');
  formatted = formatted.replace(/\b([a-z0-9]{12,})\b/g,
    (match) => match.length > 10 ? `<span class="log-vm-id">${match}</span>` : match);

  return formatted;
}

const logContent = document.getElementById('logContent');
const MAX_LINES = 3000;

// --- Log tabs ---
let activeLogTab = 'all';
const logStore = { all: [] };

const logTabsEl = document.getElementById('logTabs');
function highlightAccountForTab(tab) {
  document.querySelectorAll('.account-item').forEach(el => el.classList.remove('acc-log-active'));
  if (!tab || tab === 'all') return;

  const tabName = accountNames[tab];
  if (tabName) {
    for (const el of document.querySelectorAll('.account-item .acc-name')) {
      if (el.textContent.trim() === tabName) {
        el.closest('.account-item')?.classList.add('acc-log-active');
        return;
      }
    }
  }

  const accMatch = tab.match(/^acc#(\d+)$/);
  if (accMatch) {
    const card = document.getElementById(`acc-item-${accMatch[1]}`);
    if (card) card.classList.add('acc-log-active');
  }
}

logTabsEl.addEventListener('click', e => {
  const btn = e.target.closest('.log-tab');
  if (!btn) return;
  logTabsEl.querySelectorAll('.log-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  activeLogTab = btn.dataset.tab;
  rebuildLogView();
  highlightAccountForTab(activeLogTab);
});

const accountNames = {};

function ensureTabExists(source) {
  if (!source || source === 'all') return;
  const existing = logTabsEl.querySelector(`[data-tab="${source}"]`);
  if (!logStore[source]) logStore[source] = [];
  const accMatch = source.match(/^acc#(\d+)$/);
  const label = accountNames[source] || (accMatch ? `Акк #${accMatch[1]}` : source);
  if (existing) {
    existing.textContent = label;
    return;
  }
  const btn = document.createElement('button');
  btn.className = 'log-tab';
  btn.dataset.tab = source;
  btn.textContent = label;
  logTabsEl.appendChild(btn);
}

function getLogPre() {
  let pre = logContent.querySelector('pre.log-stream');
  if (!pre) {
    logContent.innerHTML = '';
    pre = document.createElement('pre');
    pre.className = 'log-stream';
    logContent.appendChild(pre);
  }
  return pre;
}

function rebuildLogView() {
  logContent.innerHTML = '';
  const pre = document.createElement('pre');
  pre.className = 'log-stream';
  logContent.appendChild(pre);

  const entries = activeLogTab === 'all' ? logStore.all : (logStore[activeLogTab] || []);
  const fragment = document.createDocumentFragment();
  for (const e of entries) {
    appendEntryToFragment(e, fragment);
  }
  pre.appendChild(fragment);
  logContent.scrollTop = logContent.scrollHeight;
}

function appendEntryToFragment(entry, fragment) {
  if (entry.type === 'raw') {
    const lines = entry.text.split('\n');
    lines.forEach((line, idx) => {
      if (!line.trim() && idx > 0 && idx < lines.length - 1) return;
      const formatted = formatLogLine(line);
      if (formatted.startsWith('<div')) {
        const div = document.createElement('div');
        div.innerHTML = formatted;
        if (div.firstElementChild) fragment.appendChild(div.firstElementChild);
      } else if (formatted.trim()) {
        const span = document.createElement('span');
        span.innerHTML = formatted;
        fragment.appendChild(span);
        if (idx < lines.length - 1 && lines[idx + 1] && lines[idx + 1].trim()) {
          fragment.appendChild(document.createTextNode('\n'));
        }
      }
    });
  } else {
    const time = entry.ts ? formatTime(entry.ts) : '';
    const line = entry.line || '';
    if (!line.trim()) return;
    const formatted = formatLogLine(line);
    const span = document.createElement('span');
    span.innerHTML = `<span class="log-time">[${time}]</span> <span class="log-muted">|</span> ${formatted}`;
    fragment.appendChild(span);
    fragment.appendChild(document.createTextNode('\n'));
  }
}

function storeEntry(entry) {
  const source = entry.source || 'parser';
  ensureTabExists(source);
  logStore.all.push(entry);
  if (!logStore[source]) logStore[source] = [];
  logStore[source].push(entry);
  if (logStore.all.length > MAX_LINES * 5) logStore.all.splice(0, 1000);
  if (logStore[source].length > MAX_LINES) logStore[source].splice(0, 500);
}

function appendLog(entry) {
  storeEntry(entry);
  const source = entry.source || 'parser';
  if (activeLogTab !== 'all' && activeLogTab !== source) return;

  const pre = getLogPre();
  const fragment = document.createDocumentFragment();
  appendEntryToFragment(entry, fragment);
  pre.appendChild(fragment);
  while (pre.children.length > MAX_LINES) pre.removeChild(pre.firstChild);
  logContent.scrollTop = logContent.scrollHeight;
}

function clearLogs() {
  Object.keys(logStore).forEach(k => { logStore[k] = []; });
  logTabsEl.querySelectorAll('.log-tab:not([data-tab="all"])').forEach(b => b.remove());
  logContent.innerHTML = '<div class="log-empty">Логи очищены. Запусти парсер для вывода.</div>';
}

function loadLogBuffer() {
  fetch(API + '/logs/buffer')
    .then(r => r.json())
    .then(buf => {
      if (!buf.length) {
        logContent.innerHTML = '<div class="log-empty">Ожидание логов...</div>';
        return;
      }
      buf.forEach(e => storeEntry(e));
      rebuildLogView();
    })
    .catch(() => {
      logContent.innerHTML = '<div class="log-empty">Ожидание логов...</div>';
    });
}

// --- Server Found звук и бейдж ---
const foundAccounts = new Set();

function playFoundSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    let time = ctx.currentTime;
    for (let i = 0; i < 6; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(i % 2 === 0 ? 880 : 660, time);
      gain.gain.setValueAtTime(0.4, time);
      gain.gain.exponentialRampToValueAtTime(0.001, time + 0.25);
      osc.start(time);
      osc.stop(time + 0.25);
      time += 0.3;
    }
  } catch (_) {}
}

function markAccountFound(accountId) {
  foundAccounts.add(accountId);
  const item = document.getElementById(`acc-item-${accountId}`);
  if (!item) return;
  if (item.querySelector('.acc-found-badge')) return;
  const info = item.querySelector('.account-item-info');
  if (info) {
    const badge = document.createElement('span');
    badge.className = 'acc-info-tag acc-found-tag acc-found-badge';
    badge.innerHTML = '<i class="fas fa-check-circle"></i> найден сервер!';
    info.appendChild(badge);
  }
}

function markAccountFoundByName(name) {
  document.querySelectorAll('.account-item').forEach(item => {
    const nameEl = item.querySelector('.acc-name');
    if (nameEl && nameEl.textContent.trim() === name) {
      if (item.querySelector('.acc-found-badge')) return;
      const info = item.querySelector('.account-item-info');
      if (info) {
        const badge = document.createElement('span');
        badge.className = 'acc-info-tag acc-found-tag acc-found-badge';
        badge.innerHTML = '<i class="fas fa-check-circle"></i> найден сервер!';
        info.appendChild(badge);
      }
    }
  });
}

function connectSSE() {
  const es = new EventSource(API + '/logs/stream');
  es.onmessage = (e) => {
    try {
      const entry = JSON.parse(e.data);
      if (entry.type === 'account_meta') {
        accountNames[entry.source] = entry.accountName;
        ensureTabExists(entry.source);
        return;
      }
      if (entry.type === 'server_found') {
        playFoundSound();
        const name = entry.accountName || accountNames[entry.source] || `#${entry.accountId}`;
        markAccountFoundByName(name);
        if (entry.accountId >= 0) markAccountFound(entry.accountId);
        showToast(`Сервер найден! ${name}`, 'success');
        return;
      }
      appendLog(entry);
    } catch (_) {}
  };
  es.onerror = () => {
    es.close();
    setTimeout(connectSSE, 3000);
  };
}

async function loadConfig() {
  if (!await showConfirm('Загрузить конфигурацию?', 'Текущие несохраненные изменения будут потеряны. Продолжить?')) {
    return;
  }
  try {
    const c = await get('/config');
    document.getElementById('target_ip_prefix').value = c.target_ip_prefix || '185.39';
    document.getElementById('batch_size').value = c.batch_size ?? 5;
    document.getElementById('os_id').value = c.os_id ?? 79;
    document.getElementById('preset_id').value = c.preset_id ?? 4795;
    document.getElementById('zone').value = c.zone || 'ru-1';
    document.getElementById('telegram_bot_token').value = c.telegram_bot_token || '';
    document.getElementById('telegram_chat_id').value = c.telegram_chat_id || '';
    showToast('Конфиг загружен', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

async function saveConfig() {
  if (!await showConfirm('Сохранить конфигурацию?', 'Вы уверены, что хотите сохранить текущие настройки?')) {
    return;
  }
  try {
    const c = await get('/config');
    c.target_ip_prefix = document.getElementById('target_ip_prefix').value.trim() || '185.39';
    c.batch_size = Number(document.getElementById('batch_size').value) || 5;
    c.os_id = Number(document.getElementById('os_id').value) || 79;
    c.preset_id = Number(document.getElementById('preset_id').value) || 4795;
    c.zone = document.getElementById('zone').value || 'ru-1';
    c.telegram_bot_token = document.getElementById('telegram_bot_token').value.trim() || null;
    c.telegram_chat_id = document.getElementById('telegram_chat_id').value.trim() || null;
    await post('/config', c);
    showToast('Конфиг сохранен', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
}


async function startParser() {
  if (!await showConfirm('Запустить парсер?', 'Парсер начнет создавать VM и искать нужный IP. Продолжить?')) {
    return;
  }
  try {
    await post('/parser/start');
    showToast('Парсер запущен', 'success');
    document.getElementById('btnStart').disabled = true;
    document.getElementById('btnStop').disabled = false;
    document.getElementById('statusText').textContent = 'Парсер запущен';
    document.getElementById('status').classList.add('running');
    pollStatus();
  } catch (e) {
    showToast(e.message, 'error');
  }
}

async function stopParser() {
  if (!await showConfirm('Остановить парсер?', 'Парсер будет остановлен. Продолжить?')) {
    return;
  }
  try {
    await post('/parser/stop');
    showToast('Парсер остановлен', 'success');
    document.getElementById('btnStart').disabled = false;
    document.getElementById('btnStop').disabled = true;
    document.getElementById('statusText').textContent = 'Парсер остановлен';
    document.getElementById('status').classList.remove('running');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

function pollStatus() {
  const check = async () => {
    try {
      const { running } = await get('/parser/status');
      if (!running) {
        document.getElementById('btnStart').disabled = false;
        document.getElementById('btnStop').disabled = true;
        document.getElementById('statusText').textContent = 'Парсер остановлен';
        document.getElementById('status').classList.remove('running');
      } else {
        setTimeout(check, 2000);
      }
    } catch (_) {}
  };
  setTimeout(check, 2000);
}

async function clearTraces() {
  if (!await showConfirm('Очистить следы?', 'Будут удалены логи, found_vm_*.json файлы и история запусков. Это действие нельзя отменить. Продолжить?', 'danger')) {
    return;
  }
  try {
    const { cleared } = await post('/clear-traces');
    showToast(`Очищено: ${cleared.length} элементов`, 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

async function clearLogsApi() {
  const r = await fetch(API + '/logs/clear', { method: 'POST' }).catch(() => null);
  clearLogs();
}

document.getElementById('btnLoad').addEventListener('click', loadConfig);
document.getElementById('btnSave').addEventListener('click', saveConfig);
document.getElementById('btnStart').addEventListener('click', startParser);
document.getElementById('btnStop').addEventListener('click', stopParser);
document.getElementById('btnClear').addEventListener('click', clearTraces);


// Переключение видимости пароля
document.querySelectorAll('.btn-toggle-password').forEach(btn => {
  btn.addEventListener('click', () => {
    const targetId = btn.getAttribute('data-target');
    const input = document.getElementById(targetId);
    const icon = btn.querySelector('i');

    if (input.type === 'password') {
      input.type = 'text';
      icon.classList.remove('fa-eye');
      icon.classList.add('fa-eye-slash');
    } else {
      input.type = 'password';
      icon.classList.remove('fa-eye-slash');
      icon.classList.add('fa-eye');
    }
  });
});

const btnClearLogs = document.getElementById('btnClearLogs');
if (btnClearLogs) {
  btnClearLogs.addEventListener('click', async () => {
    if (!await showConfirm('Очистить логи?', 'Все логи будут удалены. Продолжить?')) {
      return;
    }
    try {
      await fetch(API + '/logs/clear', { method: 'POST' });
    } catch (_) {}
    clearLogs();
  });
}

loadConfig();
loadLogBuffer();
connectSSE();
initStatus();
loadAccounts();
pollAccountStatuses();

// Инициализация VM менеджера будет в vm-manager.js

async function initStatus() {
  try {
    const { running, count } = await get('/parser/status');
    document.getElementById('btnStart').disabled = running;
    document.getElementById('btnStop').disabled = !running;
    document.getElementById('statusText').textContent = running
      ? (count > 1 ? `Парсеров запущено: ${count}` : 'Парсер запущен')
      : 'Парсер остановлен';
    if (running) document.getElementById('status').classList.add('running');
  } catch (_) {}
}

// --- Accounts ---
let editingAccountId = null;

function updateAccountRunStatus(idx, running) {
  const item = document.getElementById(`acc-item-${idx}`);
  if (!item) return;
  const startBtn = item.querySelector('.acc-start-btn');
  const stopBtn = item.querySelector('.acc-stop-btn');
  const dot = item.querySelector(`.acc-status-dot-${idx}`);
  if (startBtn) startBtn.style.display = running ? 'none' : '';
  if (stopBtn) stopBtn.style.display = running ? '' : 'none';
  if (dot) {
    dot.style.background = running ? '#4ade80' : 'transparent';
    dot.style.border = running ? 'none' : '1.5px solid #555';
  }
}

async function pollAccountStatuses() {
  try {
    const { processes } = await get('/parser/status');
    const runningIdxs = new Set((processes || []).map(p => p.id));
    document.querySelectorAll('.account-item[data-id]').forEach(item => {
      const idx = parseInt(item.dataset.id);
      updateAccountRunStatus(idx, runningIdxs.has(idx));
    });
  } catch (_) {}
  setTimeout(pollAccountStatuses, 2500);
}

async function loadAccounts() {
  try {
    const accounts = await get('/accounts');
    renderAccounts(accounts);
    try {
      const { processes } = await get('/parser/status');
      const runningIdxs = new Set((processes || []).map(p => p.id));
      accounts.forEach(acc => updateAccountRunStatus(acc.id, runningIdxs.has(acc.id)));
    } catch (_) {}
    try {
      const found = await get('/server-found');
      found.forEach(f => markAccountFoundByName(f.name));
    } catch (_) {}
  } catch (_) {}
}

function renderAccounts(accounts) {
  const list = document.getElementById('accountsList');
  if (!accounts.length) {
    list.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:8px 0">Нет аккаунтов -- добавьте аккаунт с API токеном Timeweb</div>';
    return;
  }
  list.innerHTML = accounts.map((acc) => `
    <div class="account-item" data-id="${acc.id}" id="acc-item-${acc.id}">
      <div class="account-item-top">
        <label class="account-toggle">
          <input type="checkbox" class="acc-active" data-id="${acc.id}" ${acc.active !== false ? 'checked' : ''}>
          <span class="acc-name">${acc.name || `Аккаунт #${acc.id}`}</span>
        </label>
        <div class="account-item-actions">
          <button class="btn btn-small btn-start acc-start-btn" data-id="${acc.id}" title="Запустить парсер">
            <i class="fas fa-play"></i>
          </button>
          <button class="btn btn-small btn-stop acc-stop-btn" data-id="${acc.id}" title="Остановить парсер" style="display:none">
            <i class="fas fa-stop"></i>
          </button>
          <button class="btn btn-small btn-secondary acc-edit-btn" data-id="${acc.id}" title="Редактировать">
            <i class="fas fa-edit"></i>
          </button>
          <button class="btn btn-small btn-danger acc-delete-btn" data-id="${acc.id}" title="Удалить">
            <i class="fas fa-trash"></i>
          </button>
        </div>
      </div>
      <div class="account-item-info">
        <span class="acc-status-dot acc-status-dot-${acc.id}"></span>
        ${acc.api_token ? '<span class="acc-info-tag acc-ok-tag"><i class="fas fa-check"></i> API Token</span>' : '<span class="acc-info-tag acc-warn-tag"><i class="fas fa-exclamation-triangle"></i> нет токена</span>'}
        ${acc.proxy ? `<span class="acc-info-tag acc-proxy-tag"><i class="fas fa-shield-alt"></i> ${acc.proxy.split('@').pop()}</span>` : '<span class="acc-info-tag acc-noproxy-tag">без прокси</span>'}
      </div>
    </div>
  `).join('');

  // Bind events
  list.querySelectorAll('.acc-start-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.id);
      try {
        await post(`/parser/start/${idx}`);
        showToast(`Аккаунт #${idx} запущен`, 'success');
        updateAccountRunStatus(idx, true);
        const tabBtn = logTabsEl.querySelector(`[data-tab="acc#${idx}"]`);
        if (tabBtn) tabBtn.click();
      } catch (e) {
        showToast(e.message, 'error');
      }
    });
  });

  list.querySelectorAll('.acc-stop-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.id);
      try {
        await fetch(`/api/parser/stop/${idx}`, { method: 'POST' });
        showToast(`Аккаунт #${idx} остановлен`, 'success');
        updateAccountRunStatus(idx, false);
      } catch (e) {
        showToast(e.message, 'error');
      }
    });
  });

  list.querySelectorAll('.acc-active').forEach(cb => {
    cb.addEventListener('change', async () => {
      const idx = parseInt(cb.dataset.id);
      await fetch(`/api/accounts/${idx}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: cb.checked })
      });
    });
  });

  list.querySelectorAll('.acc-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.id);
      const accName = btn.closest('.account-item')?.querySelector('.acc-name')?.textContent?.trim();
      if (!await showConfirm('Удалить аккаунт?', 'Аккаунт будет удален из конфига. Продолжить?', 'danger')) return;
      await fetch(`/api/accounts/${idx}`, { method: 'DELETE' });

      const tabKey = `acc#${idx}`;
      const tabBtn = logTabsEl.querySelector(`[data-tab="${tabKey}"]`);
      if (tabBtn) tabBtn.remove();
      delete logStore[tabKey];
      delete accountNames[tabKey];
      foundAccounts.delete(idx);

      if (accName) {
        logTabsEl.querySelectorAll('.log-tab').forEach(b => {
          if (b.textContent.trim() === accName) {
            const key = b.dataset.tab;
            b.remove();
            delete logStore[key];
            delete accountNames[key];
          }
        });
      }

      if (activeLogTab === tabKey) {
        activeLogTab = 'all';
        logTabsEl.querySelector('[data-tab="all"]')?.classList.add('active');
        rebuildLogView();
      }
      showToast('Аккаунт удален', 'success');
      loadAccounts();
    });
  });

  list.querySelectorAll('.acc-edit-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = parseInt(btn.dataset.id);
      const accounts = await get('/accounts');
      const acc = accounts.find(a => a.id === id);
      if (!acc) return;
      editingAccountId = id;
      document.getElementById('acc_name').value = acc.name || '';
      document.getElementById('acc_api_token').value = acc.api_token || '';
      document.getElementById('acc_proxy').value = acc.proxy || '';
      document.getElementById('accountForm').style.display = 'block';
    });
  });

  // Клик по карточке -> переключить на лог аккаунта
  list.querySelectorAll('.account-item').forEach(item => {
    item.addEventListener('click', e => {
      if (e.target.closest('.account-item-actions') || e.target.closest('input[type=checkbox]')) return;
      const idx = parseInt(item.dataset.id);
      const accName = item.querySelector('.acc-name')?.textContent?.trim();

      let tabBtn = null;
      if (accName) {
        logTabsEl.querySelectorAll('.log-tab').forEach(b => {
          if (b.textContent.trim() === accName) tabBtn = b;
        });
      }
      if (!tabBtn) {
        tabBtn = logTabsEl.querySelector(`[data-tab="acc#${idx}"]`);
      }

      if (tabBtn) {
        logTabsEl.querySelectorAll('.log-tab').forEach(b => b.classList.remove('active'));
        tabBtn.classList.add('active');
        activeLogTab = tabBtn.dataset.tab;
        rebuildLogView();
        highlightAccountForTab(activeLogTab);
      }
    });
  });
}

// --- Добавление/редактирование аккаунта ---
document.getElementById('btnAddAccount').addEventListener('click', () => {
  editingAccountId = null;
  document.getElementById('acc_name').value = '';
  document.getElementById('acc_api_token').value = '';
  document.getElementById('acc_proxy').value = '';
  document.getElementById('accountForm').style.display = 'block';
});

document.getElementById('btnCancelAccount').addEventListener('click', () => {
  document.getElementById('accountForm').style.display = 'none';
  editingAccountId = null;
});

document.getElementById('btnSaveAccount').addEventListener('click', async () => {
  const name = document.getElementById('acc_name').value.trim();
  const api_token = document.getElementById('acc_api_token').value.trim();
  const proxy = document.getElementById('acc_proxy').value.trim();

  if (!api_token) { showToast('Укажите API Token', 'error'); return; }

  const payload = { name, api_token, proxy: proxy || null, active: true };

  try {
    if (editingAccountId !== null) {
      await fetch(`/api/accounts/${editingAccountId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      showToast('Аккаунт обновлен', 'success');
    } else {
      await post('/accounts', payload);
      showToast('Аккаунт добавлен', 'success');
    }

    document.getElementById('accountForm').style.display = 'none';
    editingAccountId = null;
    loadAccounts();
  } catch (e) {
    showToast(e.message, 'error');
  }
});

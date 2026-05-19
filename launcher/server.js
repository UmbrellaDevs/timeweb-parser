/**
 * Лаунчер для Timeweb Cloud VM парсера
 * Node.js + Express + SQLite (better-sqlite3)
 */
const express = require('express');
const cors = require('cors');
const path = require('path');
const { exec } = require('child_process');
const fs = require('fs').promises;
const { spawn } = require('child_process');
const axios = require('axios');
const { SocksProxyAgent } = require('socks-proxy-agent');
const Database = require('better-sqlite3');
const http = require('http');
const WebSocket = require('ws');

// --- Загрузка .env ---
try {
  const envPath = path.join(__dirname, '.env');
  const envContent = require('fs').readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (val && !val.startsWith('СЮДА')) process.env[key] = val;
    }
  }
} catch (e) {}

const app = express();
const PORT = 3847;
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(__dirname, 'data', 'launcher.db');

// --- SQLite ---
let sqliteDb;

function initDb() {
  const dbDir = path.dirname(DB_PATH);
  require('fs').mkdirSync(dbDir, { recursive: true });

  sqliteDb = new Database(DB_PATH);
  sqliteDb.pragma('journal_mode = WAL');
  sqliteDb.pragma('foreign_keys = ON');
  sqliteDb.pragma('busy_timeout = 5000');

  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT,
      active          INTEGER NOT NULL DEFAULT 1,
      api_token       TEXT,
      proxy           TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS runs (
      id         INTEGER PRIMARY KEY,
      account    INTEGER,
      started    TEXT NOT NULL,
      exit_code  INTEGER,
      signal     TEXT,
      output     TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS found_servers (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      account_id    INTEGER,
      ts            TEXT NOT NULL,
      line          TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(name)
    );

    CREATE TABLE IF NOT EXISTS found_vms (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id       TEXT,
      ip                TEXT,
      zone              TEXT,
      username          TEXT,
      account_name      TEXT,
      account_folder_id TEXT,
      account_proxy     TEXT,
      private_key_path  TEXT,
      public_key_path   TEXT,
      root_login        TEXT,
      root_password     TEXT,
      ssh_port          INTEGER DEFAULT 22,
      telegram_sent     INTEGER NOT NULL DEFAULT 0,
      found_at          TEXT NOT NULL DEFAULT (datetime('now')),
      source_file       TEXT
    );

    CREATE TABLE IF NOT EXISTS accounts_archive (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      account_data TEXT NOT NULL,
      action      TEXT NOT NULL,
      archived_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Миграция: telegram_sent если нет
  try {
    sqliteDb.prepare("SELECT telegram_sent FROM found_vms LIMIT 1").get();
  } catch {
    sqliteDb.exec("ALTER TABLE found_vms ADD COLUMN telegram_sent INTEGER NOT NULL DEFAULT 0");
    console.log('[МИГРАЦИЯ] Добавлено поле telegram_sent в found_vms');
  }

  // Миграция: api_token если нет (обновление со старой схемы)
  try {
    sqliteDb.prepare("SELECT api_token FROM accounts LIMIT 1").get();
  } catch {
    try {
      sqliteDb.exec("ALTER TABLE accounts ADD COLUMN api_token TEXT");
      console.log('[МИГРАЦИЯ] Добавлено поле api_token в accounts');
    } catch { }
  }
}

// --- Хелперы для работы с БД ---

function getConfig() {
  const rows = sqliteDb.prepare('SELECT key, value FROM config').all();
  const config = {};
  for (const row of rows) {
    const val = row.value;
    if (val && (val[0] === '{' || val[0] === '[')) {
      try { config[row.key] = JSON.parse(val); } catch { config[row.key] = val; }
    } else if (/^\d+$/.test(val)) {
      config[row.key] = parseInt(val, 10);
    } else {
      config[row.key] = val;
    }
  }
  return config;
}

function setConfig(key, value) {
  const val = typeof value === 'object' ? JSON.stringify(value) : String(value);
  sqliteDb.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, val);
}

function getAccounts() {
  const rows = sqliteDb.prepare('SELECT * FROM accounts ORDER BY id').all();
  return rows.map(row => ({
    ...row,
    active: row.active === 1
  }));
}

function getAccountById(id) {
  const row = sqliteDb.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  if (!row) return null;
  return {
    ...row,
    active: row.active === 1
  };
}

function archiveAccount(account, action) {
  const data = { ...account };
  delete data.id;
  delete data.created_at;
  delete data.updated_at;
  sqliteDb.prepare('INSERT INTO accounts_archive (account_data, action) VALUES (?, ?)')
    .run(JSON.stringify(data), action);
}

// Надежное убийство процесса (Windows + Unix)
function killProcess(proc) {
  try {
    if (process.platform === 'win32') {
      exec(`taskkill /F /T /PID ${proc.pid}`, () => {});
    } else {
      proc.kill('SIGTERM');
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch (_) {}
      }, 5000);
    }
  } catch (_) {}
}

// Формирует полный конфиг
function getFullConfig() {
  const config = getConfig();
  const accounts = getAccounts();
  config.accounts = accounts.map(({ created_at, updated_at, ...rest }) => rest);
  return config;
}

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Мультиаккаунт: Map<accountId, childProcess>
const parserProcesses = new Map();
const logBuffer = [];
const sseClients = [];

// Создает axios-инстанс с SOCKS5 прокси (формат: user:pass@host:port)
function makeAxios(proxy) {
  if (!proxy) return axios;
  const proxyUrl = proxy.includes('://') ? proxy : `socks5h://${proxy}`;
  const agent = new SocksProxyAgent(proxyUrl);
  return axios.create({ httpAgent: agent, httpsAgent: agent });
}

function logPush(obj) {
  const entry = { ts: new Date().toISOString(), ...obj };
  logBuffer.push(entry);
  if (logBuffer.length > 10000) logBuffer.splice(0, logBuffer.length - 5000);
  const msg = `data: ${JSON.stringify(entry)}\n\n`;
  sseClients.forEach(res => {
    try {
      res.write(msg);
      if (res.flush) res.flush();
    } catch (_) {}
  });
}

function logPushRaw(text, source) {
  if (!text) return;
  const msg = `data: ${JSON.stringify({ type: 'raw', text, source: source || 'parser' })}\n\n`;
  sseClients.forEach(res => {
    try {
      res.write(msg);
      if (res.flush) res.flush();
    } catch (_) {}
  });
}

// --- Config ---
app.get('/api/config', (req, res) => {
  try {
    res.json(getFullConfig());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/config', (req, res) => {
  try {
    const body = req.body;
    const configKeys = ['target_ip_prefix', 'batch_size', 'os_id', 'preset_id',
      'zone', 'telegram_bot_token', 'telegram_chat_id'];

    const updateConfig = sqliteDb.transaction(() => {
      for (const key of configKeys) {
        if (body[key] !== undefined) {
          setConfig(key, body[key]);
        }
      }

      // Если переданы аккаунты целиком -- синхронизируем
      if (body.accounts !== undefined) {
        syncAccounts(body.accounts);
      }
    });
    updateConfig();

    logPush({ source: 'system', type: 'info', line: 'Конфиг сохранен' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Синхронизация массива аккаунтов (полная замена)
function syncAccounts(accounts) {
  for (const [accId, proc] of parserProcesses) {
    killProcess(proc);
  }
  parserProcesses.clear();

  sqliteDb.prepare('DELETE FROM accounts').run();
  const insertAcc = sqliteDb.prepare(`
    INSERT INTO accounts (name, active, api_token, proxy)
    VALUES (?, ?, ?, ?)
  `);
  for (const acc of accounts) {
    insertAcc.run(
      acc.name || null,
      acc.active !== false ? 1 : 0,
      acc.api_token || null,
      acc.proxy || null
    );
  }
}

// --- SSE logs stream ---
app.get('/api/logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.push(res);
  logBuffer.forEach(entry => {
    try { res.write(`data: ${JSON.stringify(entry)}\n\n`); } catch (_) {}
  });
  req.on('close', () => {
    const i = sseClients.indexOf(res);
    if (i >= 0) sseClients.splice(i, 1);
  });
});

app.get('/api/logs/buffer', (req, res) => {
  res.json(logBuffer);
});

app.post('/api/logs/clear', (req, res) => {
  logBuffer.length = 0;
  res.json({ ok: true });
});

// --- Accounts CRUD ---
app.get('/api/accounts', (req, res) => {
  try {
    const accounts = getAccounts().map(({ created_at, updated_at, ...rest }) => rest);
    res.json(accounts);
  } catch (e) {
    res.json([]);
  }
});

app.post('/api/accounts', (req, res) => {
  try {
    const account = { name: '', active: true, ...req.body };
    const result = sqliteDb.prepare(`
      INSERT INTO accounts (name, active, api_token, proxy)
      VALUES (?, ?, ?, ?)
    `).run(
      account.name || null,
      account.active !== false ? 1 : 0,
      account.api_token || null,
      account.proxy || null
    );
    archiveAccount(account, 'added');
    logPush({ source: 'system', type: 'info', line: `Аккаунт добавлен: ${account.name || 'без имени'}` });
    res.json({ ok: true, id: Number(result.lastInsertRowid) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/accounts/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const found = getAccountById(id);
    if (!found) return res.status(404).json({ error: 'Аккаунт не найден' });

    const updates = req.body;
    const fields = [];
    const values = [];

    const allowedFields = ['name', 'active', 'api_token', 'proxy'];

    for (const key of allowedFields) {
      if (updates[key] !== undefined) {
        if (key === 'active') {
          fields.push(`${key} = ?`);
          values.push(updates[key] !== false ? 1 : 0);
        } else {
          fields.push(`${key} = ?`);
          values.push(updates[key]);
        }
      }
    }

    if (fields.length > 0) {
      fields.push("updated_at = datetime('now')");
      values.push(id);
      sqliteDb.prepare(`UPDATE accounts SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    }

    const updatedAcc = getAccountById(id);
    if (updatedAcc) archiveAccount(updatedAcc, 'updated');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/accounts/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const found = getAccountById(id);
    if (!found) return res.status(404).json({ error: 'Аккаунт не найден' });

    // Убиваем парсер если запущен
    const proc = parserProcesses.get(id);
    if (proc) {
      killProcess(proc);
      parserProcesses.delete(id);
    }

    // Очищаем found_servers для этого аккаунта
    if (found.name) {
      sqliteDb.prepare('DELETE FROM found_servers WHERE name = ?').run(found.name);
    }

    archiveAccount(found, 'deleted');
    sqliteDb.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    logPush({ source: 'system', type: 'info', line: `Аккаунт удален: ${found.name || '#' + id}` });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Accounts archive ---
app.get('/api/accounts/archive', (req, res) => {
  try {
    const rows = sqliteDb.prepare('SELECT * FROM accounts_archive ORDER BY id DESC').all();
    res.json(rows.map(r => {
      const data = JSON.parse(r.account_data);
      return { ...data, _archived_at: r.archived_at, _action: r.action };
    }));
  } catch (_) {
    res.json([]);
  }
});

// --- Server found (persistent) ---
app.get('/api/server-found', (req, res) => {
  const rows = sqliteDb.prepare('SELECT * FROM found_servers ORDER BY id DESC').all();
  res.json(rows.map(r => ({ name: r.name, accountId: r.account_id, ts: r.ts, line: r.line })));
});

app.delete('/api/server-found/:name', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  sqliteDb.prepare('DELETE FROM found_servers WHERE name = ?').run(name);
  res.json({ ok: true });
});

// --- ProxySoxy: авто-закупка прокси ---
const PROXYSOXY_API_KEY = process.env.PROXYSOXY_API_KEY || '';
const PROXYSOXY_RUSSIA_SOCKS5_ITEM = 2;

async function buyProxyAuto() {
  // 1. Авторизация
  logPush({ source: 'proxy-buy', type: 'info', line: 'Авторизация в ProxySoxy...' });
  const authRes = await axios.post('https://proxysoxy.com/api/api-auth', {
    authToken: PROXYSOXY_API_KEY
  }, { timeout: 15000 });
  const token = authRes.data?.token;
  if (!token) throw new Error('ProxySoxy: не удалось авторизоваться');

  // 2. Покупка 1 шт Россия SOCKS5
  logPush({ source: 'proxy-buy', type: 'info', line: 'Покупаем SOCKS5 прокси (Россия)...' });
  const buyRes = await axios.post('https://proxysoxy.com/api/order/create', {
    paymentSystem: 'balance',
    count: 1,
    itemId: PROXYSOXY_RUSSIA_SOCKS5_ITEM
  }, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 15000
  });

  if (buyRes.data?.status !== 200) {
    throw new Error(`ProxySoxy: ${buyRes.data?.message || 'ошибка покупки'}`);
  }
  const orderId = buyRes.data?.order?.id;
  if (!orderId) throw new Error('ProxySoxy: не получен order ID');

  // 3. Скачиваем прокси (формат login:password@ip:port)
  logPush({ source: 'proxy-buy', type: 'info', line: `Скачиваем прокси (order #${orderId})...` });

  // Ждем 2 секунды -- прокси не всегда готов сразу
  await new Promise(r => setTimeout(r, 2000));

  const dlRes = await axios.get(
    `https://proxysoxy.com/api/order/${orderId}/download/login:password@ip:port`,
    { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
  );
  const downloadUrl = dlRes.data?.url;
  if (!downloadUrl) throw new Error('ProxySoxy: не получена ссылка на скачивание');

  const proxyRes = await axios.get(downloadUrl, { timeout: 15000 });
  const proxyLine = (proxyRes.data || '').toString().trim().split('\n')[0].trim();
  if (!proxyLine) throw new Error('ProxySoxy: пустой ответ при скачивании прокси');

  logPush({ source: 'proxy-buy', type: 'info', line: `Прокси куплен: ${proxyLine}` });
  return proxyLine;
}

// Эндпоинт: купить прокси
app.post('/api/proxy/buy', async (req, res) => {
  try {
    const proxy = await buyProxyAuto();
    res.json({ ok: true, proxy });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Parser Start/Stop ---
function spawnParser(accountId, extraEnv, accountName) {
  const pythonPath = process.platform === 'win32' ? 'python' : 'python3';
  const scriptPath = path.join(PROJECT_ROOT, 'timeweb_cloud_vm_parser.py');
  const label = accountId >= 0 ? `acc#${accountId}` : 'parser';
  if (accountName) {
    logPush({ type: 'account_meta', source: label, accountId, accountName });
  }

  // Лог-файл
  const logsDir = path.join(PROJECT_ROOT, 'logs');
  require('fs').mkdirSync(logsDir, { recursive: true });
  const safeLabel = (accountName || label).replace(/[^a-zA-Z0-9@._-]/g, '_');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const logFile = path.join(logsDir, `${safeLabel}_${ts}.log`);
  const fileStream = require('fs').createWriteStream(logFile, { flags: 'a', encoding: 'utf8' });
  fileStream.write(`=== Запуск: ${new Date().toISOString()} | ${accountName || label} ===\n`);

  const proc = spawn(pythonPath, [scriptPath], {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      TW_NON_INTERACTIVE: '1',
      PYTHONUNBUFFERED: '1',
      TW_DB_PATH: DB_PATH,
      ...extraEnv
    }
  });

  const chunks = [];
  let lineBuf = '';
  const pushOut = (d) => {
    const s = d.toString();
    chunks.push(s);
    fileStream.write(s);
    logPushRaw(s, label);
    lineBuf += s;
    const lines = lineBuf.split('\n');
    lineBuf = lines.pop() || '';
    for (const line of lines) {
      if (line.includes('НАЙДЕН IP С ПРЕФИКСОМ') && line.includes('✓✓✓')) {
        const accName = accountName || `acc#${accountId}`;
        logPush({ type: 'server_found', source: label, accountId, accountName: accName, line: line.trim() });
        // Persist found server
        try {
          const existing = sqliteDb.prepare('SELECT id FROM found_servers WHERE name = ?').get(accName);
          if (!existing) {
            sqliteDb.prepare('INSERT INTO found_servers (name, account_id, ts, line) VALUES (?, ?, ?, ?)')
              .run(accName, accountId, new Date().toISOString(), line.trim());
          }
        } catch (_) {}
      }
    }
  };
  proc.stdout?.on('data', d => pushOut(d));
  proc.stderr?.on('data', d => pushOut(d));
  proc.on('exit', (code, signal) => {
    if (lineBuf.trim()) logPush({ source: label, type: 'stdout', line: lineBuf.trim() });
    const output = chunks.join('');
    logPush({ source: label, type: 'info', line: `=== ${label} завершен (exit ${code}) ===` });
    fileStream.write(`\n=== Завершен (exit ${code}) | ${new Date().toISOString()} ===\n`);
    fileStream.end();
    try {
      sqliteDb.prepare('INSERT INTO runs (id, account, started, exit_code, signal, output) VALUES (?, ?, ?, ?, ?, ?)')
        .run(Date.now(), accountId, new Date().toISOString(), code, signal, output.slice(-5000));
    } catch (_) {}
    if (parserProcesses.get(accountId) === proc) {
      parserProcesses.delete(accountId);
    }
  });

  logPush({ source: 'system', type: 'info', line: `Лог: logs/${path.basename(logFile)}` });
  return proc;
}

app.post('/api/parser/start', (req, res) => {
  const accounts = getAccounts();
  const activeAccounts = accounts.filter(a => a.active);
  const config = getConfig();

  if (activeAccounts.length === 0) {
    // Legacy: одиночный режим
    if (parserProcesses.has(-1)) {
      return res.status(400).json({ error: 'Парсер уже запущен' });
    }
    logPush({ source: 'parser', type: 'info', line: '=== Парсер запущен ===' });
    const proxyEnv = {};
    if (config.proxy) {
      const p = `socks5h://${config.proxy}`;
      proxyEnv.SOCKS5_PROXY = config.proxy;
      proxyEnv.ALL_PROXY = p;
      proxyEnv.HTTP_PROXY = p;
      proxyEnv.HTTPS_PROXY = p;
    }
    const proc = spawnParser(-1, proxyEnv);
    parserProcesses.set(-1, proc);
    return res.json({ ok: true, started: 1, pids: [proc.pid] });
  }

  // Мультиаккаунт
  const started = [];
  const skipped = [];
  let startDelay = 0;
  for (const acc of accounts) {
    if (!acc.active) continue;
    if (parserProcesses.has(acc.id)) { skipped.push(acc.id); continue; }

    if (!acc.api_token) {
      logPush({ source: `acc#${acc.id}`, type: 'error', line: `Аккаунт #${acc.id} пропущен -- нет API токена!` });
      skipped.push(acc.id);
      continue;
    }

    const proxy = acc.proxy || config.proxy || null;
    const proxyEnv = {};
    if (proxy) {
      const p = `socks5h://${proxy}`;
      proxyEnv.SOCKS5_PROXY = proxy;
      proxyEnv.ALL_PROXY = p;
      proxyEnv.HTTP_PROXY = p;
      proxyEnv.HTTPS_PROXY = p;
    }

    const accName = acc.name || `Аккаунт #${acc.id}`;
    const delay = startDelay;
    startDelay += 15000 + Math.floor(Math.random() * 15000);

    setTimeout(() => {
      if (parserProcesses.has(acc.id)) return;
      logPush({ source: `acc#${acc.id}`, type: 'info', line: `=== Запуск аккаунта #${acc.id}: ${accName} ===` });
      const proc = spawnParser(acc.id, {
        ...proxyEnv,
        TW_API_TOKEN: acc.api_token,
        TW_ACCOUNT_ID: String(acc.id),
        TW_TARGET_IP_PREFIX: String(config.target_ip_prefix || '185.39'),
        TW_BATCH_SIZE: String(config.batch_size || 5),
        TW_OS_ID: String(config.os_id || 79),
        TW_PRESET_ID: String(config.preset_id || 4795),
        TW_ZONE: String(config.zone || 'ru-1'),
      }, accName);
      parserProcesses.set(acc.id, proc);
    }, delay);

    started.push({ id: acc.id, name: accName, delay: Math.round(delay / 1000) });
  }

  res.json({ ok: true, started: started.length, accounts: started, skipped });
});

app.post('/api/parser/start/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (parserProcesses.has(id)) {
    return res.status(400).json({ error: `Аккаунт #${id} уже запущен` });
  }
  const acc = getAccountById(id);
  if (!acc) {
    return res.status(404).json({ error: 'Аккаунт не найден' });
  }
  if (!acc.api_token) {
    return res.status(400).json({ error: 'Нет API токена -- запуск невозможен' });
  }
  const config = getConfig();
  const proxy = acc.proxy || config.proxy || null;
  const proxyEnv = {};
  if (proxy) {
    const p = `socks5h://${proxy}`;
    proxyEnv.SOCKS5_PROXY = proxy;
    proxyEnv.ALL_PROXY = p;
    proxyEnv.HTTP_PROXY = p;
    proxyEnv.HTTPS_PROXY = p;
  }
  const accName = acc.name || `Аккаунт #${id}`;
  logPush({ source: `acc#${id}`, type: 'info', line: `=== Запуск аккаунта #${id}: ${accName} ===` });
  const proc = spawnParser(id, {
    ...proxyEnv,
    TW_API_TOKEN: acc.api_token,
    TW_ACCOUNT_ID: String(id),
    TW_TARGET_IP_PREFIX: String(config.target_ip_prefix || '185.39'),
    TW_BATCH_SIZE: String(config.batch_size || 5),
    TW_OS_ID: String(config.os_id || 79),
    TW_PRESET_ID: String(config.preset_id || 4795),
    TW_ZONE: String(config.zone || 'ru-1'),
  }, accName);
  parserProcesses.set(id, proc);
  res.json({ ok: true, pid: proc.pid });
});

app.post('/api/parser/stop/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const proc = parserProcesses.get(id);
  if (proc) {
    logPush({ source: `acc#${id}`, type: 'info', line: `=== Аккаунт #${id} остановлен ===` });
    killProcess(proc);
    parserProcesses.delete(id);
  }
  res.json({ ok: true });
});

app.post('/api/parser/stop', (req, res) => {
  const { accountId } = req.body || {};

  if (accountId !== undefined && accountId !== null) {
    const aid = parseInt(accountId);
    const proc = parserProcesses.get(aid);
    if (proc) {
      logPush({ source: `acc#${aid}`, type: 'info', line: `=== Аккаунт #${aid} остановлен ===` });
      killProcess(proc);
      parserProcesses.delete(aid);
    }
    return res.json({ ok: true });
  }

  if (parserProcesses.size === 0) {
    return res.json({ ok: true, message: 'Парсеры не запущены' });
  }
  logPush({ source: 'parser', type: 'info', line: '=== Все парсеры остановлены ===' });
  for (const [key, proc] of parserProcesses) {
    killProcess(proc);
  }
  parserProcesses.clear();
  res.json({ ok: true });
});

app.get('/api/parser/status', (req, res) => {
  const running = parserProcesses.size > 0;
  const processes = [];
  for (const [accId, proc] of parserProcesses) {
    processes.push({ id: accId, pid: proc.pid });
  }
  res.json({ running, count: parserProcesses.size, processes });
});

// --- Clear traces ---
app.post('/api/clear-traces', async (req, res) => {
  const cleared = [];
  const logsDir = path.join(PROJECT_ROOT, 'logs');
  try {
    const logFiles = await fs.readdir(logsDir).catch(() => []);
    for (const f of logFiles) {
      await fs.unlink(path.join(logsDir, f)).catch(() => {});
      cleared.push(`logs/${f}`);
    }
  } catch (_) {}
  try {
    const files = await fs.readdir(PROJECT_ROOT);
    for (const f of files) {
      if (f.startsWith('found_vm_') && f.endsWith('.json')) {
        await fs.unlink(path.join(PROJECT_ROOT, f)).catch(() => {});
        cleared.push(f);
      }
    }
  } catch (_) {}
  // Очищаем runs и found_vms в БД
  sqliteDb.prepare('DELETE FROM runs').run();
  sqliteDb.prepare('DELETE FROM found_vms').run();
  logPush({ source: 'system', type: 'info', line: `Очищено: ${cleared.join(', ')}` });
  res.json({ ok: true, cleared });
});

// --- Run history ---
app.get('/api/runs', (req, res) => {
  const rows = sqliteDb.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 50').all();
  res.json(rows.map(r => ({
    id: r.id, account: r.account, started: r.started,
    exitCode: r.exit_code, signal: r.signal, output: r.output
  })));
});

app.delete('/api/runs', (req, res) => {
  sqliteDb.prepare('DELETE FROM runs').run();
  res.json({ ok: true });
});

// --- VM Management ---
app.get('/api/vm/list', (req, res) => {
  try {
    const dbVms = sqliteDb.prepare('SELECT * FROM found_vms ORDER BY id DESC').all();
    const vms = dbVms.map(v => ({
      instance_id: v.instance_id, ip: v.ip, zone: v.zone,
      username: v.username, account_name: v.account_name,
      account_folder_id: v.account_folder_id, account_proxy: v.account_proxy,
      private_key_path: v.private_key_path, public_key_path: v.public_key_path,
      root_login: v.root_login, root_password: v.root_password, ssh_port: v.ssh_port
    }));

    // Дополнительно: файлы found_vm_*.json
    try {
      const files = require('fs').readdirSync(PROJECT_ROOT);
      const vmFiles = files.filter(f => f.startsWith('found_vm_') && f.endsWith('.json'));
      for (const file of vmFiles) {
        try {
          const data = require('fs').readFileSync(path.join(PROJECT_ROOT, file), 'utf8');
          const vm = JSON.parse(data);
          if (!vms.find(v => v.ip === vm.ip && v.instance_id === vm.instance_id)) {
            vms.push(vm);
          }
        } catch (_) {}
      }
    } catch (_) {}

    res.json(vms);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Main page ---
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- WebSocket для SSH ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const match = req.url.match(/^\/api\/vm\/ssh\/(.+)$/);
  if (!match) {
    ws.close();
    return;
  }

  const ip = match[1];

  // Ищем VM в БД
  let vm = sqliteDb.prepare('SELECT * FROM found_vms WHERE ip = ? ORDER BY id DESC LIMIT 1').get(ip);

  // Fallback: ищем в found_vm_*.json
  if (!vm) {
    const vmFiles = require('fs').readdirSync(PROJECT_ROOT).filter(f => f.startsWith('found_vm_') && f.endsWith('.json'));
    for (const file of vmFiles) {
      try {
        const data = require('fs').readFileSync(path.join(PROJECT_ROOT, file), 'utf8');
        const parsed = JSON.parse(data);
        if (parsed.ip === ip) {
          vm = parsed;
          break;
        }
      } catch (_) {}
    }
  }

  if (!vm) {
    ws.send('VM not found\r\n');
    ws.close();
    return;
  }

  let sshProcess;
  const username = vm.root_login || vm.username || 'root';
  const port = vm.ssh_port || 22;

  if (vm.root_password) {
    if (process.platform === 'win32') {
      const { execSync } = require('child_process');
      let useSSH = false;

      try {
        execSync('ssh -V', { timeout: 2000, stdio: 'ignore' });
        useSSH = true;
      } catch (_) {}

      if (useSSH) {
        sshProcess = spawn('ssh', [
          '-t', '-t',
          '-o', 'StrictHostKeyChecking=accept-new',
          '-p', String(port),
          `${username}@${ip}`
        ], {
          stdio: ['pipe', 'pipe', 'pipe']
        });

        let passwordSent = false;
        let outputBuffer = '';

        const checkAndSendPassword = (data) => {
          outputBuffer += data.toString();
          const passwordPrompts = [
            /password:/i,
            /password\s*:/i,
            /enter\s+password/i,
            /\(.*\)\s*password:/i,
            /password\s+for/i
          ];

          for (const prompt of passwordPrompts) {
            if (prompt.test(outputBuffer) && !passwordSent) {
              setTimeout(() => {
                if (sshProcess.stdin && sshProcess.stdin.writable && !passwordSent) {
                  sshProcess.stdin.write(vm.root_password + '\r\n');
                  passwordSent = true;
                }
              }, 200);
              break;
            }
          }
        };

        sshProcess.stdout.on('data', checkAndSendPassword);
        sshProcess.stderr.on('data', checkAndSendPassword);
      } else {
        const plinkPaths = [
          'C:\\Program Files\\PuTTY\\plink.exe',
          'C:\\Program Files (x86)\\PuTTY\\plink.exe',
          'plink'
        ];
        let plinkCmd = null;
        for (const p of plinkPaths) {
          if (p === 'plink') {
            plinkCmd = p;
            break;
          }
          try {
            if (require('fs').existsSync(p)) {
              plinkCmd = p;
              break;
            }
          } catch (_) {}
        }
        if (!plinkCmd) {
          ws.send('Neither ssh nor plink found. Install OpenSSH or PuTTY.\r\n');
          ws.close();
          return;
        }

        sshProcess = spawn(plinkCmd, [
          '-ssh', '-P', String(port),
          '-l', username, '-pw', vm.root_password,
          ip
        ], { stdio: ['pipe', 'pipe', 'pipe'] });
      }
    } else {
      const { execSync } = require('child_process');
      let sshCmd = 'ssh';
      let sshArgs = ['-t', '-t', '-p', String(port), `${username}@${ip}`];

      try {
        execSync('which sshpass', { timeout: 1000, stdio: 'ignore' });
        sshCmd = 'sshpass';
        sshArgs = ['-p', vm.root_password, 'ssh', '-t', '-t', '-p', String(port), `${username}@${ip}`];
      } catch (_) {}

      sshProcess = spawn(sshCmd, sshArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    }
  } else if (vm.private_key_path) {
    sshProcess = spawn('ssh', [
      '-t', '-t',
      '-i', vm.private_key_path,
      '-p', String(port),
      `${username}@${ip}`
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
  } else {
    ws.send('No password or key found for VM\r\n');
    ws.close();
    return;
  }

  sshProcess.stdout.on('data', (data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  });

  sshProcess.stderr.on('data', (data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  });

  sshProcess.on('exit', () => {
    if (ws.readyState === WebSocket.OPEN) ws.close();
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'resize') { /* not supported */ }
    } catch (_) {
      if (sshProcess.stdin && sshProcess.stdin.writable) {
        sshProcess.stdin.write(data);
      }
    }
  });

  ws.on('close', () => {
    if (sshProcess) killProcess(sshProcess);
  });
});

// --- Telegram Bot (polling) ---
let tgBotOffset = 0;
let tgBotRunning = false;

async function tgSend(botToken, chatId, text, proxy) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const payload = { chat_id: chatId, text, parse_mode: 'Markdown' };

  // Стратегия: прокси -> без прокси -> другие прокси
  const proxies = [];
  if (proxy) proxies.push(proxy);
  proxies.push(null); // без прокси

  // Добавляем прокси других аккаунтов
  try {
    const accounts = getAccounts();
    for (const acc of accounts) {
      if (acc.proxy && acc.proxy !== proxy && !proxies.includes(acc.proxy)) {
        proxies.push(acc.proxy);
      }
    }
  } catch (_) {}

  for (const p of proxies) {
    try {
      const axiosInst = p ? makeAxios(p) : axios;
      const res = await axiosInst.post(url, payload, { timeout: 15000 });
      if (res.status === 200) return true;
    } catch (_) {}
  }
  return false;
}

function buildVmMessage(vm) {
  let msg = '';
  if (vm.account_name) {
    let accLabel = '';
    try {
      const accounts = getAccounts();
      const acc = accounts.find(a => a.name === vm.account_name);
      if (acc) accLabel = `#${acc.id} `;
    } catch (_) {}
    msg += `*Аккаунт:* ${accLabel}\`${vm.account_name}\`\n`;
  }
  if (vm.account_proxy) msg += `*Прокси:* \`${vm.account_proxy}\`\n`;
  if (msg) msg += '\n';
  msg += `*IP:* \`${vm.ip}\`\n`;
  msg += `*Порт:* \`${vm.ssh_port || 22}\`\n\n`;
  if (vm.root_login && vm.root_password) {
    msg += `*Вход по паролю:*\n`;
    msg += `  Хост: \`${vm.ip}\`\n`;
    msg += `  Логин: \`${vm.root_login}\`\n`;
    msg += `  Пароль: \`${vm.root_password}\`\n\n`;
    msg += `Подключение: \`ssh ${vm.root_login}@${vm.ip}\``;
  }
  return msg;
}

async function handleTgCommand(botToken, chatId, text, proxy) {
  const cmd = text.trim().toLowerCase();

  if (cmd === '/check') {
    const unsent = sqliteDb.prepare('SELECT * FROM found_vms WHERE telegram_sent = 0 ORDER BY id DESC').all();
    if (unsent.length === 0) {
      await tgSend(botToken, chatId, 'Все уведомления отправлены, неотправленных VM нет.', proxy);
      return;
    }

    await tgSend(botToken, chatId, `Найдено ${unsent.length} неотправленных VM. Отправляю...`, proxy);

    let sent = 0;
    for (const vm of unsent) {
      const msg = '*Переотправка:*\n\n' + buildVmMessage(vm);
      const ok = await tgSend(botToken, chatId, msg, vm.account_proxy || proxy);
      if (ok) {
        sqliteDb.prepare('UPDATE found_vms SET telegram_sent = 1 WHERE id = ?').run(vm.id);
        sent++;
      }
    }

    await tgSend(botToken, chatId, `Переотправлено: ${sent}/${unsent.length}`, proxy);
    logPush({ source: 'telegram', type: 'info', line: `/check: переотправлено ${sent}/${unsent.length} VM` });

  } else if (cmd === '/status') {
    const running = parserProcesses.size;
    const accounts = getAccounts();
    const active = accounts.filter(a => a.active).length;
    const totalVms = sqliteDb.prepare('SELECT COUNT(*) as c FROM found_vms').get().c;
    const unsentVms = sqliteDb.prepare('SELECT COUNT(*) as c FROM found_vms WHERE telegram_sent = 0').get().c;

    let msg = `*Статус лаунчера (Timeweb)*\n\n`;
    msg += `Аккаунтов: ${accounts.length} (активных: ${active})\n`;
    msg += `Парсеров запущено: ${running}\n`;
    msg += `Найдено VM: ${totalVms}\n`;
    if (unsentVms > 0) msg += `Неотправленных: ${unsentVms}\n`;

    if (running > 0) {
      msg += '\n*Работающие:*\n';
      for (const [accId, proc] of parserProcesses) {
        const acc = accounts.find(a => a.id === accId);
        msg += `  #${accId} ${acc?.name || '?'} (pid ${proc.pid})\n`;
      }
    }

    await tgSend(botToken, chatId, msg, proxy);

  } else if (cmd === '/vms') {
    const vms = sqliteDb.prepare('SELECT * FROM found_vms ORDER BY id DESC LIMIT 10').all();
    if (vms.length === 0) {
      await tgSend(botToken, chatId, 'Найденных VM нет.', proxy);
      return;
    }
    let msg = `*Последние VM (${vms.length}):*\n\n`;
    for (const vm of vms) {
      const tgStatus = vm.telegram_sent ? 'ok' : '!';
      msg += `[${tgStatus}] \`${vm.ip}\` | ${vm.zone || '?'} | ${vm.account_name || '?'}\n`;
    }
    await tgSend(botToken, chatId, msg, proxy);

  } else if (cmd === '/help' || cmd === '/start') {
    const msg = `*BOBIK CLOUD Bot (Timeweb)*\n\n` +
      `Команды:\n` +
      `/check -- переотправить неотправленные уведомления\n` +
      `/status -- статус лаунчера и парсеров\n` +
      `/vms -- последние найденные VM\n` +
      `/help -- эта справка`;
    await tgSend(botToken, chatId, msg, proxy);
  }
}

async function pollTelegram() {
  const config = getConfig();
  const botToken = config.telegram_bot_token;
  const chatId = config.telegram_chat_id;
  if (!botToken || !chatId) return;

  const proxy = config.proxy || null;

  try {
    const url = `https://api.telegram.org/bot${botToken}/getUpdates?offset=${tgBotOffset}&timeout=30`;
    const axiosInst = proxy ? makeAxios(proxy) : axios;
    const res = await axiosInst.get(url, { timeout: 35000 });

    if (res.data?.ok && res.data.result?.length > 0) {
      for (const update of res.data.result) {
        tgBotOffset = update.update_id + 1;
        const text = update.message?.text;
        const msgChatId = update.message?.chat?.id;
        if (text && msgChatId && String(msgChatId) === String(chatId)) {
          await handleTgCommand(botToken, chatId, text, proxy);
        }
      }
    }
  } catch (_) {
    // Ошибка polling -- молча пропускаем
  }
}

function startTelegramBot() {
  const config = getConfig();
  if (!config.telegram_bot_token) {
    console.log('  Telegram бот: токен не настроен, пропускаем\n');
    return;
  }
  tgBotRunning = true;
  console.log('  Telegram бот: запущен (polling)\n');

  async function loop() {
    while (tgBotRunning) {
      await pollTelegram();
    }
  }
  loop().catch(() => {});
}

// --- Start ---
const SERVER_URL = `http://localhost:${PORT}`;
function openBrowser() {
  const cmd = process.platform === 'win32' ? `start "" "${SERVER_URL}"` :
    process.platform === 'darwin' ? `open "${SERVER_URL}"` : `xdg-open "${SERVER_URL}"`;
  exec(cmd, () => {});
}

initDb();
server.listen(PORT, () => {
  console.log(`\n  Лаунчер Timeweb Cloud: ${SERVER_URL}\n`);
  console.log(`  БД: ${DB_PATH}\n`);
  startTelegramBot();
  openBrowser();
});

// Корректное закрытие БД
process.on('SIGINT', () => {
  sqliteDb?.close();
  process.exit(0);
});
process.on('SIGTERM', () => {
  sqliteDb?.close();
  process.exit(0);
});

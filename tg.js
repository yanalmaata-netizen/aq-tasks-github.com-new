const crypto = require('crypto');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const API = process.env.TELEGRAM_API || 'https://api.telegram.org';
const APP_URL = process.env.APP_URL || 'https://web-production-8f1b89.up.railway.app';
const phones = (v, d) => String(v || d).split(',').map(s => s.replace(/\D/g, '')).filter(Boolean);
const SUMMARY_PHONES = phones(process.env.SUMMARY_PHONES, '77058032098'); // сводка по всем задачам
const OVERDUE_PHONES = phones(process.env.OVERDUE_PHONES, '77775400144'); // просрочка в 12:00
const MORNING_HOUR = Number(process.env.MORNING_HOUR || 9);
const NOON_HOUR = Number(process.env.NOON_HOUR || 12);
const TZ_OFFSET_H = 5; // Алматы, UTC+5

let pool = null, botName = '', offset = 0;

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const DAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const MONTHS_FULL = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

function almaty(now) { return new Date((now || Date.now()) + TZ_OFFSET_H * 3600e3); }
function dayStr(d) { return d.toISOString().slice(0, 10); }
function todayStr(now) { return dayStr(almaty(now)); }
function tomorrowStr(now) { return dayStr(new Date(almaty(now).getTime() + 86400e3)); }
function shortDate(s) { const p = s.split('-'); return Number(p[2]) + ' ' + MONTHS[Number(p[1]) - 1]; }
function longToday(now) { const d = almaty(now); return DAYS[d.getUTCDay()] + ', ' + d.getUTCDate() + ' ' + MONTHS_FULL[d.getUTCMonth()]; }

async function tg(method, params, timeoutMs) {
  const r = await fetch(API + '/bot' + TOKEN + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params || {}),
    signal: AbortSignal.timeout(timeoutMs || 40000)
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) { const e = new Error(j.description || ('tg ' + r.status)); e.code = j.error_code; throw e; }
  return j.result;
}

async function send(chatId, text, userId) {
  const parts = [];
  let rest = String(text);
  while (rest.length > 3900) {
    let cut = rest.lastIndexOf('\n', 3900); if (cut < 500) cut = 3900;
    parts.push(rest.slice(0, cut)); rest = rest.slice(cut).replace(/^\n/, '');
  }
  parts.push(rest);
  try {
    for (const p of parts) await tg('sendMessage', { chat_id: chatId, text: p, disable_web_page_preview: true });
    return true;
  } catch (e) {
    console.error('tg send failed', userId || '', e.message);
    if ((e.code === 403 || e.code === 400) && userId) await pool.query('UPDATE users SET tg_chat_id = NULL WHERE id = $1 AND tg_chat_id = $2', [userId, chatId]).catch(() => {});
    return false;
  }
}

/* ---------- сборка текстов ---------- */
async function openTasks() {
  const r = await pool.query(`SELECT t.id, t.date, t.text, t.user_id AS "userId", COALESCE(u.name, t.resp) AS resp, p.name AS project
    FROM tasks t LEFT JOIN users u ON u.id = t.user_id LEFT JOIN projects p ON p.id = t.project_id
    WHERE NOT t.done ORDER BY t.date, t.id`);
  return r.rows;
}
function split(tasks, now) {
  const today = todayStr(now), tomorrow = tomorrowStr(now);
  return {
    late: tasks.filter(t => t.date < today),
    now: tasks.filter(t => t.date === today),
    next: tasks.filter(t => t.date === tomorrow)
  };
}
function line(t, opts) {
  let s = '– ' + t.text;
  if (opts.who) s += ' · ' + t.resp;
  if (t.project) s += ' · ' + t.project;
  if (opts.late) s += ' · срок был ' + shortDate(t.date);
  return s;
}
function section(title, list, opts) {
  if (!list.length) return '';
  return '\n' + title + ': ' + list.length + '\n' + list.map(t => line(t, opts)).join('\n') + '\n';
}
function summaryText(tasks, now) {
  const g = split(tasks, now);
  if (!g.late.length && !g.now.length && !g.next.length) return null;
  return 'Сводка на день. ' + cap(longToday(now)) + '\n'
    + section('Просрочено', g.late, { who: true, late: true })
    + section('Сегодня', g.now, { who: true })
    + section('Завтра', g.next, { who: true })
    + '\n' + APP_URL;
}
function personalText(tasks, userId, now) {
  const g = split(tasks.filter(t => t.userId === userId), now);
  if (!g.late.length && !g.now.length && !g.next.length) return null;
  return 'Ваши задачи. ' + cap(longToday(now)) + '\n'
    + section('Просрочено', g.late, { late: true })
    + section('Срок сегодня', g.now, {})
    + section('Срок завтра', g.next, {})
    + '\n' + APP_URL;
}
function overdueText(tasks, now) {
  const g = split(tasks, now);
  if (!g.late.length) return null;
  return 'Просроченные задачи. ' + cap(longToday(now)) + '\n'
    + section('Всего', g.late, { who: true, late: true })
    + '\n' + APP_URL;
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

/* ---------- расписание ---------- */
async function claim(key, day) {
  const r = await pool.query('INSERT INTO tg_runs(key, day) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING key', [key, day]);
  return r.rowCount === 1;
}
async function usersByPhones(list) {
  if (!list.length) return [];
  const r = await pool.query('SELECT id, name, tg_chat_id FROM users WHERE phone = ANY($1) AND tg_chat_id IS NOT NULL', [list]);
  return r.rows;
}
async function runMorning(now) {
  const tasks = await openTasks();
  const sumUsers = await usersByPhones(SUMMARY_PHONES);
  const sumIds = new Set(sumUsers.map(u => u.id));
  const st = summaryText(tasks, now);
  if (st) for (const u of sumUsers) await send(u.tg_chat_id, st, u.id);
  const all = await pool.query('SELECT id, name, tg_chat_id FROM users WHERE tg_chat_id IS NOT NULL');
  for (const u of all.rows) {
    if (sumIds.has(u.id)) continue;
    const pt = personalText(tasks, u.id, now);
    if (pt) await send(u.tg_chat_id, pt, u.id);
  }
}
async function runNoon(now) {
  const tasks = await openTasks();
  const t = overdueText(tasks, now);
  if (!t) return;
  for (const u of await usersByPhones(OVERDUE_PHONES)) await send(u.tg_chat_id, t, u.id);
}
async function tick() {
  try {
    const now = Date.now(), d = almaty(now), h = d.getUTCHours(), day = dayStr(d);
    if (h === MORNING_HOUR && await claim('morning', day)) await runMorning(now);
    if (h === NOON_HOUR && await claim('noon', day)) await runNoon(now);
  } catch (e) { console.error('tg tick', e.message); }
}

/* ---------- входящие ---------- */
async function onMessage(m) {
  if (!m || !m.chat || m.chat.type !== 'private') return;
  const chatId = m.chat.id, text = String(m.text || '').trim();
  if (!text.startsWith('/start')) {
    return send(chatId, 'Я присылаю уведомления по задачам AQ miniSUITES. Чтобы подключиться, откройте приложение, нажмите на свое имя вверху и выберите «Подключить Telegram».\n' + APP_URL);
  }
  const payload = text.split(/\s+/)[1] || '';
  if (payload) {
    const r = await pool.query(`DELETE FROM tg_links WHERE token = $1 AND created_at > now() - interval '1 day' RETURNING user_id`, [payload]);
    if (r.rows[0]) {
      const uid = r.rows[0].user_id;
      await pool.query('UPDATE users SET tg_chat_id = $1 WHERE id = $2', [chatId, uid]);
      const u = await pool.query('SELECT name FROM users WHERE id = $1', [uid]);
      return send(chatId, 'Готово, ' + (u.rows[0] ? u.rows[0].name : '') + '. Telegram подключен. Утром придут ваши задачи со сроком сегодня и завтра, а также просроченные.');
    }
  }
  const ex = await pool.query('SELECT name FROM users WHERE tg_chat_id = $1 LIMIT 1', [chatId]);
  if (ex.rows[0]) return send(chatId, 'Telegram уже подключен: ' + ex.rows[0].name + '.');
  return send(chatId, 'Ссылка устарела. Откройте приложение, нажмите на свое имя вверху и выберите «Подключить Telegram» еще раз.\n' + APP_URL);
}
async function poll() {
  for (;;) {
    try {
      const ups = await tg('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, 40000);
      for (const u of ups) { offset = u.update_id + 1; try { await onMessage(u.message); } catch (e) { console.error('tg msg', e.message); } }
    } catch (e) {
      console.error('tg poll', e.message);
      await new Promise(r => setTimeout(r, e.code === 409 ? 8000 : 4000));
    }
  }
}

/* ---------- для сервера ---------- */
async function start(p) {
  pool = p;
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS tg_chat_id BIGINT');
  await pool.query(`CREATE TABLE IF NOT EXISTS tg_links (token TEXT PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS tg_runs (key TEXT NOT NULL, day TEXT NOT NULL, PRIMARY KEY (key, day))`);
  if (!TOKEN) { console.log('Telegram: токен не задан, бот выключен'); return; }
  try {
    const me = await tg('getMe', {}, 15000);
    botName = me.username || '';
    await tg('deleteWebhook', {}, 15000).catch(() => {});
    console.log('Telegram бот: @' + botName);
  } catch (e) { console.error('Telegram: не удалось запустить бота:', e.message); return; }
  poll();
  setInterval(tick, 30000);
  tick();
}
async function status(userId) {
  const r = await pool.query('SELECT tg_chat_id FROM users WHERE id = $1', [userId]);
  return { enabled: !!botName, bot: botName, linked: !!(r.rows[0] && r.rows[0].tg_chat_id) };
}
async function link(userId) {
  if (!botName) return null;
  const token = crypto.randomBytes(12).toString('hex');
  await pool.query('DELETE FROM tg_links WHERE user_id = $1', [userId]);
  await pool.query('INSERT INTO tg_links(token, user_id) VALUES($1,$2)', [token, userId]);
  return 'https://t.me/' + botName + '?start=' + token;
}
async function test(userId) {
  const r = await pool.query('SELECT tg_chat_id FROM users WHERE id = $1', [userId]);
  const chat = r.rows[0] && r.rows[0].tg_chat_id;
  if (!chat) return false;
  const now = Date.now();
  const tasks = await openTasks();
  const text = personalText(tasks, userId, now) || 'Тест. Telegram подключен. Задач на сегодня, завтра и просроченных у вас нет.';
  return send(chat, text, userId);
}

module.exports = { start, status, link, test, _t: { summaryText, personalText, overdueText, runMorning, runNoon, tick } };

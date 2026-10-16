const fs = require('fs');
const webpush = require('web-push');

const APP_URL = process.env.APP_URL || 'https://web-production-8f1b89.up.railway.app';
let pool = null, publicKey = '';

async function start(p) {
  pool = p;
  await pool.query(`CREATE TABLE IF NOT EXISTS app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS push_subs (
    endpoint TEXT PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  let pub = (await pool.query("SELECT value FROM app_kv WHERE key='vapid_public'")).rows[0];
  let priv = (await pool.query("SELECT value FROM app_kv WHERE key='vapid_private'")).rows[0];
  if (!pub || !priv) {
    const k = webpush.generateVAPIDKeys();
    await pool.query("INSERT INTO app_kv(key,value) VALUES('vapid_public',$1),('vapid_private',$2) ON CONFLICT (key) DO NOTHING", [k.publicKey, k.privateKey]);
    pub = (await pool.query("SELECT value FROM app_kv WHERE key='vapid_public'")).rows[0];
    priv = (await pool.query("SELECT value FROM app_kv WHERE key='vapid_private'")).rows[0];
  }
  publicKey = pub.value;
  webpush.setVapidDetails(APP_URL, pub.value, priv.value);
}

const getKey = () => publicKey;

async function subscribe(userId, sub) {
  if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || sub.endpoint.length > 1000) return false;
  const k = sub.keys || {};
  if (typeof k.p256dh !== 'string' || typeof k.auth !== 'string') return false;
  await pool.query(`INSERT INTO push_subs(endpoint, user_id, p256dh, auth) VALUES($1,$2,$3,$4)
    ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
    [sub.endpoint, userId, k.p256dh, k.auth]);
  return true;
}
async function unsubscribe(userId, endpoint) {
  await pool.query('DELETE FROM push_subs WHERE endpoint = $1 AND user_id = $2', [String(endpoint || ''), userId]);
}
async function count(userId) {
  const r = await pool.query('SELECT count(*)::int AS n FROM push_subs WHERE user_id = $1', [userId]);
  return r.rows[0].n;
}

// payload: { title, body, url?, tag? }
async function notify(userId, payload) {
  if (!pool || !publicKey) return 0;
  const data = JSON.stringify(Object.assign({ url: '/' }, payload));
  const subs = (await pool.query('SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id = $1', [userId])).rows;
  let sent = 0;
  for (const s of subs) {
    if (process.env.PUSH_LOG) { fs.appendFileSync(process.env.PUSH_LOG, JSON.stringify({ userId, data: JSON.parse(data) }) + '\n'); sent++; continue; }
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, data, { TTL: 6 * 3600, urgency: 'high' });
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) await pool.query('DELETE FROM push_subs WHERE endpoint = $1', [s.endpoint]).catch(() => {});
      else console.error('push failed', e.statusCode || e.message);
    }
  }
  return sent;
}

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
async function notifyAssigned(userId, by, text, date, project) {
  const p = String(date).split('-');
  const d = Number(p[2]) + ' ' + MONTHS[Number(p[1]) - 1];
  return notify(userId, {
    title: 'Вам поставили задачу',
    body: text + '\nСрок: ' + d + (project ? ' · ' + project : '') + ' · от ' + by,
    tag: 'assigned'
  });
}

module.exports = { start, getKey, subscribe, unsubscribe, count, notify, notifyAssigned };

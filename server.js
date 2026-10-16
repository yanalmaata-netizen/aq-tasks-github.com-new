const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const tg = require('./tg');

const PORT = process.env.PORT || 3000;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !/railway\.internal|localhost/.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : false
});

async function init() {
  await pool.query(`CREATE TABLE IF NOT EXISTS tasks (
    id SERIAL PRIMARY KEY,
    date TEXT NOT NULL,
    text TEXT NOT NULL,
    resp TEXT NOT NULL,
    done BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS user_id INT');
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE,
    code_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'staff',
    photo BYTEA,
    photo_v BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS projects (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS project_id INT');
  await pool.query(`CREATE TABLE IF NOT EXISTS comments (
    id SERIAL PRIMARY KEY,
    task_id INT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id INT,
    author TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const pc = await pool.query('SELECT count(*)::int AS n FROM projects');
  if (pc.rows[0].n === 0) await pool.query("INSERT INTO projects(name) VALUES('AQ miniSUITES')");
  await pool.query('UPDATE tasks SET project_id = (SELECT min(id) FROM projects) WHERE project_id IS NULL');
  for (const nm of String(process.env.PROJECTS_SEED || '').split('|').map(x => x.trim()).filter(Boolean)) {
    await pool.query('INSERT INTO projects(name) SELECT $1::text WHERE NOT EXISTS (SELECT 1 FROM projects WHERE name = $1::text)', [nm]);
  }
  await pool.query(`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

function send(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let d = '', big = false;
    req.on('data', c => { d += c; if (d.length > (limit || 1e5)) { big = true; req.destroy(); } });
    req.on('end', () => { if (big) return reject(new Error('big')); try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const okDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const clean = s => String(s || '').trim().slice(0, 500);

function normPhone(s) {
  let d = String(s || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  if (d.length === 10) d = '7' + d;
  return d.length >= 11 && d.length <= 15 ? d : '';
}
function hashCode(code) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(String(code), salt, 32).toString('hex');
}
function checkCode(code, stored) {
  const [salt, h] = String(stored).split(':');
  if (!salt || !h) return false;
  const a = crypto.scryptSync(String(code), salt, 32), b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function genCode() { return String(crypto.randomInt(10000, 100000)); }
const DEFAULT_CODE = '1111';
const cleanLong = s => String(s || '').trim().slice(0, 2000);

const attempts = new Map();
function tooMany(key) {
  const now = Date.now();
  const arr = (attempts.get(key) || []).filter(t => now - t < 10 * 60 * 1000);
  attempts.set(key, arr);
  return arr.length >= 10;
}
function noteAttempt(key) { const arr = attempts.get(key) || []; arr.push(Date.now()); attempts.set(key, arr); }

async function newSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query('INSERT INTO sessions(token, user_id) VALUES($1,$2)', [token, userId]);
  return token;
}
async function authUser(req) {
  const t = req.headers['x-token'];
  if (!t || typeof t !== 'string') return null;
  const r = await pool.query(
    `SELECT u.id, u.name, u.phone, u.role, u.photo_v FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = $1 AND s.created_at > now() - interval '90 days'`, [t]);
  return r.rows[0] || null;
}
const pub = (u, admin) => ({ id: u.id, name: u.name, role: u.role, photoV: Number(u.photo_v) || 0, phone: admin ? u.phone : undefined });

async function api(req, res, url) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  try {
    if (url === '/api/state' && req.method === 'GET') {
      const r = await pool.query('SELECT count(*)::int AS n FROM users');
      return send(res, 200, { needsSetup: r.rows[0].n === 0 });
    }
    if (url === '/api/setup' && req.method === 'POST') {
      const r0 = await pool.query('SELECT count(*)::int AS n FROM users');
      if (r0.rows[0].n > 0) return send(res, 403, { error: 'already' });
      const b = await readBody(req);
      const phone = normPhone(b.phone), name = clean(b.name), code = String(b.code || '').trim();
      if (!name || !phone || code.length < 4) return send(res, 400, { error: 'bad' });
      const r = await pool.query('INSERT INTO users(name, phone, code_hash, role) VALUES($1,$2,$3,$4) RETURNING id', [name, phone, hashCode(code), 'admin']);
      return send(res, 200, { token: await newSession(r.rows[0].id) });
    }
    if (url === '/api/login' && req.method === 'POST') {
      const b = await readBody(req);
      const phone = normPhone(b.phone), code = String(b.code || '').trim();
      const key = ip + '|' + phone;
      if (tooMany(key)) return send(res, 429, { error: 'many' });
      const r = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
      const u = r.rows[0];
      if (!u || !checkCode(code, u.code_hash)) { noteAttempt(key); return send(res, 401, { error: 'bad' }); }
      return send(res, 200, { token: await newSession(u.id) });
    }

    const me = await authUser(req);
    if (!me) return send(res, 401, { error: 'auth' });
    const admin = me.role === 'admin';

    if (url === '/api/logout' && req.method === 'POST') {
      await pool.query('DELETE FROM sessions WHERE token = $1', [req.headers['x-token']]);
      return send(res, 200, { ok: true });
    }
    if (url === '/api/me' && req.method === 'GET') return send(res, 200, pub(me, true));

    // ---- telegram ----
    if (url === '/api/tg/status' && req.method === 'GET') return send(res, 200, await tg.status(me.id));
    if (url === '/api/tg/link' && req.method === 'POST') {
      const u = await tg.link(me.id);
      return u ? send(res, 200, { url: u }) : send(res, 503, { error: 'off' });
    }
    if (url === '/api/tg/test' && req.method === 'POST') return send(res, 200, { ok: await tg.test(me.id) });

    // ---- пользователи ----
    if (url === '/api/users' && req.method === 'GET') {
      const r = await pool.query('SELECT id, name, phone, role, photo_v FROM users ORDER BY role, name');
      return send(res, 200, r.rows.map(u => pub(u, admin)));
    }
    if (url === '/api/users' && req.method === 'POST') {
      if (!admin) return send(res, 403, { error: 'admin' });
      const b = await readBody(req);
      const name = clean(b.name), phone = normPhone(b.phone);
      const code = String(b.code || '').trim() || DEFAULT_CODE;
      const role = b.role === 'admin' ? 'admin' : 'staff';
      if (!name || !phone || code.length < 4) return send(res, 400, { error: 'bad' });
      try {
        const r = await pool.query('INSERT INTO users(name, phone, code_hash, role) VALUES($1,$2,$3,$4) RETURNING id', [name, phone, hashCode(code), role]);
        return send(res, 200, { id: r.rows[0].id, code });
      } catch (e) {
        if (e.code === '23505') return send(res, 409, { error: 'phone' });
        throw e;
      }
    }
    if (url === '/api/users/bulk' && req.method === 'POST') {
      if (!admin) return send(res, 403, { error: 'admin' });
      const b = await readBody(req);
      const lines = String(b.lines || '').split('\n').map(s => s.trim()).filter(Boolean).slice(0, 100);
      const out = [];
      for (const line of lines) {
        const m = line.match(/^(.*?)[,;\t]+\s*([+\d][\d\s()+-]{8,}?)\s*(?:[,;\t]+\s*(\d{4,}))?$/) || line.match(/^(.*?)\s+([+\d][\d\s()+-]{9,})$/);
        if (!m) { out.push({ line, status: 'не разобрал строку' }); continue; }
        const name = clean(m[1]), phone = normPhone(m[2]), code = m[3] || DEFAULT_CODE;
        if (!name || !phone) { out.push({ line, status: 'нет имени или телефона' }); continue; }
        try {
          await pool.query('INSERT INTO users(name, phone, code_hash, role) VALUES($1,$2,$3,$4)', [name, phone, hashCode(code), 'staff']);
          out.push({ name, phone, code, status: 'ok' });
        } catch (e) {
          out.push({ name, phone, status: e.code === '23505' ? 'телефон уже есть' : 'ошибка' });
        }
      }
      return send(res, 200, out);
    }
    let m = url.match(/^\/api\/users\/(\d+)(?:\/(photo))?$/);
    if (m) {
      const id = Number(m[1]);
      if (m[2] === 'photo') {
        if (req.method === 'GET') {
          const r = await pool.query('SELECT photo FROM users WHERE id = $1', [id]);
          if (!r.rows[0] || !r.rows[0].photo) return send(res, 404, { error: 'none' });
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' });
          return res.end(r.rows[0].photo);
        }
        if (req.method === 'PUT') {
          if (!admin && me.id !== id) return send(res, 403, { error: 'forbidden' });
          const b = await readBody(req, 400000);
          const buf = Buffer.from(String(b.data || ''), 'base64');
          if (buf.length < 100 || buf.length > 250000 || buf[0] !== 0xff || buf[1] !== 0xd8) return send(res, 400, { error: 'bad' });
          await pool.query('UPDATE users SET photo = $1, photo_v = $2 WHERE id = $3', [buf, Date.now(), id]);
          return send(res, 200, { ok: true });
        }
        if (req.method === 'DELETE') {
          if (!admin && me.id !== id) return send(res, 403, { error: 'forbidden' });
          await pool.query('UPDATE users SET photo = NULL, photo_v = 0 WHERE id = $1', [id]);
          return send(res, 200, { ok: true });
        }
        return send(res, 405, { error: 'method' });
      }
      if (req.method === 'PATCH') {
        if (!admin) return send(res, 403, { error: 'admin' });
        const b = await readBody(req);
        const sets = [], vals = [];
        let newCode = null;
        if (b.name !== undefined) { if (!clean(b.name)) return send(res, 400, { error: 'bad' }); vals.push(clean(b.name)); sets.push('name=$' + vals.length); }
        if (b.phone !== undefined) { const p = normPhone(b.phone); if (!p) return send(res, 400, { error: 'bad' }); vals.push(p); sets.push('phone=$' + vals.length); }
        if (b.role !== undefined) {
          if (id === me.id && b.role !== 'admin') return send(res, 400, { error: 'self' });
          vals.push(b.role === 'admin' ? 'admin' : 'staff'); sets.push('role=$' + vals.length);
        }
        if (b.resetCode) { newCode = String(b.code || '').trim() || genCode(); if (newCode.length < 4) return send(res, 400, { error: 'bad' }); vals.push(hashCode(newCode)); sets.push('code_hash=$' + vals.length); }
        if (!sets.length) return send(res, 400, { error: 'bad' });
        vals.push(id);
        try { await pool.query('UPDATE users SET ' + sets.join(',') + ' WHERE id=$' + vals.length, vals); }
        catch (e) { if (e.code === '23505') return send(res, 409, { error: 'phone' }); throw e; }
        if (newCode) await pool.query('DELETE FROM sessions WHERE user_id = $1 AND token <> $2', [id, req.headers['x-token']]);
        return send(res, 200, { ok: true, code: newCode || undefined });
      }
      if (req.method === 'DELETE') {
        if (!admin) return send(res, 403, { error: 'admin' });
        if (id === me.id) return send(res, 400, { error: 'self' });
        await pool.query('UPDATE tasks SET user_id = NULL WHERE user_id = $1', [id]);
        await pool.query('DELETE FROM users WHERE id = $1', [id]);
        return send(res, 200, { ok: true });
      }
      return send(res, 405, { error: 'method' });
    }

    // ---- проекты ----
    if (url === '/api/projects' && req.method === 'GET') {
      const r = await pool.query(`SELECT p.id, p.name,
        count(t.id) FILTER (WHERE NOT t.done)::int AS open,
        count(t.id) FILTER (WHERE t.done)::int AS done
        FROM projects p LEFT JOIN tasks t ON t.project_id = p.id GROUP BY p.id ORDER BY p.id`);
      return send(res, 200, r.rows);
    }
    if (url === '/api/projects' && req.method === 'POST') {
      if (!admin) return send(res, 403, { error: 'admin' });
      const b = await readBody(req);
      const nm = clean(b.name).slice(0, 120);
      if (!nm) return send(res, 400, { error: 'bad' });
      const r = await pool.query('INSERT INTO projects(name) VALUES($1) RETURNING id', [nm]);
      return send(res, 200, { id: r.rows[0].id });
    }
    let pm = url.match(/^\/api\/projects\/(\d+)$/);
    if (pm) {
      if (!admin) return send(res, 403, { error: 'admin' });
      const pid = Number(pm[1]);
      if (req.method === 'PATCH') {
        const b = await readBody(req);
        const nm = clean(b.name).slice(0, 120);
        if (!nm) return send(res, 400, { error: 'bad' });
        await pool.query('UPDATE projects SET name=$1 WHERE id=$2', [nm, pid]);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') {
        const c = await pool.query('SELECT count(*)::int AS n FROM projects');
        if (c.rows[0].n <= 1) return send(res, 400, { error: 'last' });
        await pool.query('DELETE FROM tasks WHERE project_id = $1', [pid]);
        await pool.query('DELETE FROM projects WHERE id = $1', [pid]);
        return send(res, 200, { ok: true });
      }
      return send(res, 405, { error: 'method' });
    }

    // ---- комментарии ----
    let cm = url.match(/^\/api\/tasks\/(\d+)\/comments$/);
    if (cm) {
      const tid = Number(cm[1]);
      if (req.method === 'GET') {
        const r = await pool.query('SELECT id, user_id AS "userId", author, text, created_at AS "at" FROM comments WHERE task_id = $1 ORDER BY id', [tid]);
        return send(res, 200, r.rows);
      }
      if (req.method === 'POST') {
        const b = await readBody(req);
        const tx = cleanLong(b.text);
        if (!tx) return send(res, 400, { error: 'bad' });
        const t = await pool.query('SELECT id FROM tasks WHERE id = $1', [tid]);
        if (!t.rows[0]) return send(res, 404, { error: 'not_found' });
        const r = await pool.query('INSERT INTO comments(task_id, user_id, author, text) VALUES($1,$2,$3,$4) RETURNING id', [tid, me.id, me.name, tx]);
        return send(res, 200, { id: r.rows[0].id });
      }
      return send(res, 405, { error: 'method' });
    }
    cm = url.match(/^\/api\/comments\/(\d+)$/);
    if (cm && req.method === 'DELETE') {
      const r = await pool.query('SELECT user_id FROM comments WHERE id = $1', [Number(cm[1])]);
      if (!r.rows[0]) return send(res, 404, { error: 'not_found' });
      if (!admin && r.rows[0].user_id !== me.id) return send(res, 403, { error: 'forbidden' });
      await pool.query('DELETE FROM comments WHERE id = $1', [Number(cm[1])]);
      return send(res, 200, { ok: true });
    }

    // ---- задачи ----
    m = url.match(/^\/api\/tasks(?:\/(\d+))?$/);
    if (!m) return send(res, 404, { error: 'not_found' });
    const id = m[1] ? Number(m[1]) : null;
    if (req.method === 'GET' && !id) {
      const r = await pool.query(`SELECT t.id, t.date, t.text, t.done, t.user_id AS "userId", t.project_id AS "projectId", COALESCE(u.name, t.resp) AS resp,
        (SELECT count(*)::int FROM comments c WHERE c.task_id = t.id) AS cc
        FROM tasks t LEFT JOIN users u ON u.id = t.user_id ORDER BY t.date, t.id`);
      return send(res, 200, r.rows);
    }
    const userName = async uid => { const r = await pool.query('SELECT name FROM users WHERE id=$1', [uid]); return r.rows[0] ? r.rows[0].name : null; };
    const projectOk = async pid => { const r = await pool.query('SELECT id FROM projects WHERE id=$1', [pid]); return !!r.rows[0]; };
    if (req.method === 'POST' && !id) {
      const b = await readBody(req);
      const uid = Number(b.userId), nm = await userName(uid), pid = Number(b.projectId);
      if (!okDate(b.date) || !clean(b.text) || !nm || !(await projectOk(pid))) return send(res, 400, { error: 'bad' });
      const r = await pool.query('INSERT INTO tasks(date, text, resp, user_id, project_id) VALUES($1,$2,$3,$4,$5) RETURNING id', [b.date, clean(b.text), nm, uid, pid]);
      return send(res, 200, { id: r.rows[0].id });
    }
    if (req.method === 'PATCH' && id) {
      const b = await readBody(req);
      const sets = [], vals = [];
      if (b.date !== undefined) { if (!okDate(b.date)) return send(res, 400, { error: 'bad' }); vals.push(b.date); sets.push('date=$' + vals.length); }
      if (b.text !== undefined) { if (!clean(b.text)) return send(res, 400, { error: 'bad' }); vals.push(clean(b.text)); sets.push('text=$' + vals.length); }
      if (b.userId !== undefined) {
        const nm = await userName(Number(b.userId)); if (!nm) return send(res, 400, { error: 'bad' });
        vals.push(Number(b.userId)); sets.push('user_id=$' + vals.length);
        vals.push(nm); sets.push('resp=$' + vals.length);
      }
      if (b.projectId !== undefined) { if (!(await projectOk(Number(b.projectId)))) return send(res, 400, { error: 'bad' }); vals.push(Number(b.projectId)); sets.push('project_id=$' + vals.length); }
      if (b.done !== undefined) { vals.push(!!b.done); sets.push('done=$' + vals.length); }
      if (!sets.length) return send(res, 400, { error: 'bad' });
      vals.push(id);
      await pool.query('UPDATE tasks SET ' + sets.join(',') + ' WHERE id=$' + vals.length, vals);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'DELETE' && id) {
      await pool.query('DELETE FROM tasks WHERE id=$1', [id]);
      return send(res, 200, { ok: true });
    }
    return send(res, 405, { error: 'method' });
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: 'server' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/health') return send(res, 200, 'ok', 'text/plain');
  if (url.startsWith('/api/')) return api(req, res, url);
  const file = url === '/' ? '/index.html' : url;
  const full = path.join(__dirname, 'public', path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(path.join(__dirname, 'public'))) return send(res, 403, 'no', 'text/plain');
  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, 'not found', 'text/plain');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

init().then(() => server.listen(PORT, () => { console.log('AQ tasks on ' + PORT); tg.start(pool).catch(e => console.error('tg start', e.message)); }))
  .catch(e => { console.error('DB init failed', e); process.exit(1); });

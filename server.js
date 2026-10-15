const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const CODE = process.env.APP_CODE || '';
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
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

function send(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
  });
}
const okDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const clean = s => String(s || '').trim().slice(0, 500);

async function api(req, res, url) {
  if (CODE && req.headers['x-code'] !== CODE) return send(res, 401, { error: 'code' });
  if (url === '/api/check') return send(res, 200, { ok: true });
  const m = url.match(/^\/api\/tasks(?:\/(\d+))?$/);
  if (!m) return send(res, 404, { error: 'not_found' });
  const id = m[1] ? Number(m[1]) : null;
  try {
    if (req.method === 'GET' && !id) {
      const r = await pool.query('SELECT id, date, text, resp, done FROM tasks ORDER BY date, id');
      return send(res, 200, r.rows);
    }
    if (req.method === 'POST' && !id) {
      const b = await readBody(req);
      if (!okDate(b.date) || !clean(b.text) || !clean(b.resp)) return send(res, 400, { error: 'bad' });
      const r = await pool.query('INSERT INTO tasks(date, text, resp) VALUES($1,$2,$3) RETURNING id', [b.date, clean(b.text), clean(b.resp)]);
      return send(res, 200, { id: r.rows[0].id });
    }
    if (req.method === 'PATCH' && id) {
      const b = await readBody(req);
      const sets = [], vals = [];
      if (b.date !== undefined) { if (!okDate(b.date)) return send(res, 400, { error: 'bad' }); vals.push(b.date); sets.push('date=$' + vals.length); }
      if (b.text !== undefined) { if (!clean(b.text)) return send(res, 400, { error: 'bad' }); vals.push(clean(b.text)); sets.push('text=$' + vals.length); }
      if (b.resp !== undefined) { if (!clean(b.resp)) return send(res, 400, { error: 'bad' }); vals.push(clean(b.resp)); sets.push('resp=$' + vals.length); }
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
  let file = url === '/' ? '/index.html' : url;
  const full = path.join(__dirname, 'public', path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(path.join(__dirname, 'public'))) return send(res, 403, 'no', 'text/plain');
  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, 'not found', 'text/plain');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

init().then(() => server.listen(PORT, () => console.log('AQ tasks on ' + PORT)))
  .catch(e => { console.error('DB init failed', e); process.exit(1); });

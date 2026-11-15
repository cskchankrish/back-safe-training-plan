/* Local dev server, no dependencies: node tools/dev-server.js [port]   (default 8765)
 * - Serves the repo root statically (index.html at /, never cached).
 * - Mounts api/sync.js at /api/sync with a minimal Vercel-like req/res shim.
 * - If no Upstash env vars are set, runs an in-memory fake Upstash REST endpoint at /__fake_upstash/pipeline
 *   (only the commands sync.js uses). Data is lost when the server stops.
 * Listens on 127.0.0.1 and ::1, so http://localhost:PORT and http://127.0.0.1:PORT both work; they are
 * different origins with separate localStorage, handy for testing two "devices". */
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');

const PORT = +process.argv[2] || 8765, ROOT = path.resolve(__dirname, '..');
const FAKE = !(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL);
const FAKE_TOKEN = 'dev-fake-token';
if (FAKE) { process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${PORT}/__fake_upstash`; process.env.UPSTASH_REDIS_REST_TOKEN = FAKE_TOKEN; }
const sync = require(path.join(ROOT, 'api', 'sync.js'));

/* ---------- fake Upstash (strings and hashes in a Map) ---------- */
const db = new Map(); // key -> { t: 'str'|'hash', v, exp }
const live = k => { const e = db.get(k); if (e && e.exp && e.exp < Date.now()) { db.delete(k); return null; } return e || null; };
const hash = k => { const e = live(k); if (e && e.t !== 'hash') throw new Error('WRONGTYPE'); if (e) return e.v; const n = { t: 'hash', v: new Map() }; db.set(k, n); return n.v; };
function run([cmd, ...a]) {
  a = a.map(String);
  switch (String(cmd).toUpperCase()) {
    case 'GET': { const e = live(a[0]); if (e && e.t !== 'str') throw new Error('WRONGTYPE'); return e ? e.v : null; }
    case 'INCR': { const e = live(a[0]); if (e && e.t !== 'str') throw new Error('WRONGTYPE'); const n = (e ? parseInt(e.v, 10) : 0) + 1; db.set(a[0], { t: 'str', v: String(n), exp: e && e.exp }); return n; }
    case 'EXPIRE': { const e = live(a[0]); if (!e) return 0; e.exp = Date.now() + +a[1] * 1000; return 1; }
    case 'DEL': return a.reduce((n, k) => n + (live(k) && db.delete(k) ? 1 : 0), 0);
    case 'HGET': { const e = live(a[0]); if (e && e.t !== 'hash') throw new Error('WRONGTYPE'); return e && e.v.has(a[1]) ? e.v.get(a[1]) : null; }
    case 'HMGET': { const e = live(a[0]); if (e && e.t !== 'hash') throw new Error('WRONGTYPE'); return a.slice(1).map(f => e && e.v.has(f) ? e.v.get(f) : null); }
    case 'HGETALL': { const e = live(a[0]); if (e && e.t !== 'hash') throw new Error('WRONGTYPE'); return e ? [...e.v].flat() : []; }
    case 'HSET': { const h = hash(a[0]); let n = 0; for (let i = 1; i + 1 < a.length; i += 2) { if (!h.has(a[i])) n++; h.set(a[i], a[i + 1]); } return n; }
    default: throw new Error('ERR unknown command ' + cmd);
  }
}
function fakeUpstash(req, res, body) {
  if (req.headers.authorization !== 'Bearer ' + FAKE_TOKEN) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"error":"Unauthorized"}'); }
  let cmds; try { cmds = JSON.parse(body); } catch (e) { res.writeHead(400); return res.end('{"error":"bad json"}'); }
  const out = cmds.map(c => { try { return { result: run(c) }; } catch (e) { return { error: e.message }; } });
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out));
}

/* ---------- static files ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname); if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(ROOT, '.' + rel);
  if (!file.startsWith(ROOT + path.sep) || rel.split('/').some(p => p.startsWith('.'))) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

/* ---------- request router ---------- */
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost'), p = url.pathname;
  try {
    if (FAKE && p === '/__fake_upstash/pipeline' && req.method === 'POST') {
      const chunks = []; for await (const c of req) chunks.push(c);
      return fakeUpstash(req, res, Buffer.concat(chunks).toString('utf8'));
    }
    if (p === '/api/sync') {
      req.query = Object.fromEntries(url.searchParams); // body stream left unread; sync.js reads it
      res.status = c => { res.statusCode = c; return res; };
      res.json = o => { if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(o)); return res; };
      return await sync(req, res);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, p);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) { res.writeHead(500); res.end('Server error'); }
  }
}

const server = http.createServer(handle);
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Dev server: http://localhost:${PORT}  and  http://127.0.0.1:${PORT}`);
  console.log(FAKE ? 'Sync store: in-memory fake Upstash (data is lost on exit)' : 'Sync store: Upstash from environment variables');
});
// Also listen on IPv6 loopback, since "localhost" may resolve to ::1. Ignore if IPv6 is unavailable.
const server6 = http.createServer(handle);
server6.on('error', () => {});
server6.listen(PORT, '::1');

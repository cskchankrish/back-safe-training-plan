/* Cross-device sync by "sync code" (no login). Vercel Node serverless function, CommonJS, no dependencies.
 *
 * Identity: the client sends its sync code in the `x-sync-code` header. A valid code is 20 chars from
 * ABCDEFGHJKMNPQRSTVWXYZ23456789 (case, dashes and spaces ignored). id = sha256(code) hex; the raw code
 * is never stored or logged.
 *
 * Data model in Upstash Redis (REST /pipeline), all keys under sync:{id}:
 *   v            integer version, INCR on every write that changed something
 *   prof         hash  mode -> JSON profile (has numeric `u`, ms of last change)
 *   days:{mode}  hash  'YYYY-MM-DD' -> JSON day record (has `u`)
 *   reset        hash  mode -> ms timestamp of the last "Reset this plan"
 * Modes: back, strength, neck. Merge rule (same as the client): newer `u` wins per day record and per
 * profile. A day whose `u` is not newer than the mode's reset timestamp is ignored, so a device that
 * has not seen a reset yet cannot push deleted days back.
 *
 * GET  /api/sync?v=n  -> { exists:false, v:0 } | { v, unchanged:true } | { exists:true, v, modes, reset }
 * POST /api/sync      body { modes?: { [mode]: { profile?, days?: { [date]: rec } } }, reset?: { [mode]: ts } }
 *                     -> { v, written }
 * Rate limit: 120 requests per minute per IP (hashed). Responses are never cached. Same-origin only. */
const crypto = require('node:crypto');

const ALPHA = 'ABCDEFGHJKMNPQRSTVWXYZ23456789', MODES = ['back', 'strength', 'neck'];
const MAX_BODY = 512 * 1024, MAX_REC = 16 * 1024, MAX_DAYS = 400, RL_MAX = 120, DAY = 864e5;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const isObj = o => !!o && typeof o === 'object' && !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype;
const uOf = s => { try { const o = s == null ? null : JSON.parse(s); return o && typeof o.u === 'number' ? o.u : 0; } catch (e) { return 0; } };
const parse = s => { try { return s == null ? null : JSON.parse(s); } catch (e) { return null; } };
const hashToObj = (arr, json) => { const o = {}; for (let i = 0; arr && i < arr.length; i += 2) o[arr[i]] = json ? parse(arr[i + 1]) : arr[i + 1]; return o; };
class HttpErr extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

async function redis(cfg, cmds) {
  const r = await fetch(cfg.url.replace(/\/+$/, '') + '/pipeline', {
    method: 'POST', headers: { Authorization: 'Bearer ' + cfg.token, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new HttpErr(502, 'store_unavailable');
  const out = await r.json();
  if (!Array.isArray(out)) throw new HttpErr(502, 'store_unavailable');
  for (const o of out) if (!o || o.error) throw new HttpErr(502, 'store_error');
  return out.map(o => o.result);
}

function codeId(req) {
  const raw = String(req.headers['x-sync-code'] || '').toUpperCase().replace(/[-\s]/g, '');
  if (raw.length !== 20 || [...raw].some(c => !ALPHA.includes(c))) throw new HttpErr(400, 'invalid_code');
  return sha(raw);
}

// Vercel may pre-parse the body (object), hand over a string/Buffer, or leave the stream unread.
async function readBody(req) {
  let b;
  try { b = req.body; } catch (e) { throw new HttpErr(400, 'bad_json'); } // Vercel's lazy parser throws on bad JSON
  if (b !== undefined && b !== null && b !== '') {
    if (Buffer.isBuffer(b)) b = b.toString('utf8');
    if (typeof b === 'string') { if (Buffer.byteLength(b) > MAX_BODY) throw new HttpErr(413, 'too_large'); return parseJson(b); }
    if (Buffer.byteLength(JSON.stringify(b)) > MAX_BODY) throw new HttpErr(413, 'too_large');
    return b;
  }
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > MAX_BODY) throw new HttpErr(413, 'too_large'); chunks.push(c); }
  return parseJson(Buffer.concat(chunks).toString('utf8'));
}
function parseJson(s) { try { return JSON.parse(s || '{}'); } catch (e) { throw new HttpErr(400, 'bad_json'); } }

// Validate and serialize the POST body. Returns [{ mode, profile?: json, days: [[date, json, u]], reset? }].
function validate(b) {
  if (!isObj(b)) throw new HttpErr(400, 'bad_body');
  const out = {}, get = m => out[m] || (out[m] = { mode: m, days: [] });
  const bad = () => { throw new HttpErr(400, 'bad_body'); };
  const ser = o => { if (!isObj(o) || typeof o.u !== 'number' || !isFinite(o.u)) bad(); const s = JSON.stringify(o); if (Buffer.byteLength(s) > MAX_REC) throw new HttpErr(413, 'record_too_large'); return s; };
  let count = 0;
  if (b.modes !== undefined) {
    if (!isObj(b.modes)) bad();
    for (const m in b.modes) {
      const M = b.modes[m];
      if (!MODES.includes(m) || !isObj(M)) bad();
      const e = get(m);
      if (M.profile !== undefined && M.profile !== null) e.profile = ser(M.profile);
      if (M.days !== undefined) {
        if (!isObj(M.days)) bad();
        for (const d in M.days) {
          if (!DATE_RE.test(d)) bad();
          if (++count > MAX_DAYS) throw new HttpErr(413, 'too_many_records');
          e.days.push([d, ser(M.days[d]), M.days[d].u]);
        }
      }
    }
  }
  if (b.reset !== undefined) {
    if (!isObj(b.reset)) bad();
    const now = Date.now();
    for (const m in b.reset) {
      const ts = b.reset[m];
      if (!MODES.includes(m) || typeof ts !== 'number' || !isFinite(ts) || Math.abs(now - ts) > DAY) bad();
      get(m).reset = ts;
    }
  }
  return Object.values(out);
}

module.exports = async (req, res) => {
  const cfg = { url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN };
  try {
    if (req.method !== 'GET' && req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return send(res, 405, { error: 'method_not_allowed' }); }
    if (!cfg.url || !cfg.token) return send(res, 503, { error: 'sync_not_configured' });
    const id = codeId(req), K = 'sync:' + id + ':';

    // Rate limit per hashed IP per minute.
    const ip = String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '').split(',')[0].trim();
    const rl = 'rl:' + sha(ip) + ':' + Math.floor(Date.now() / 60000);
    const [hits] = await redis(cfg, [['INCR', rl], ['EXPIRE', rl, 120]]);
    if (hits > RL_MAX) return send(res, 429, { error: 'rate_limited' });

    if (req.method === 'GET') {
      const q = req.query && req.query.v != null ? req.query.v : new URL(req.url || '/', 'http://x').searchParams.get('v');
      const [vRaw] = await redis(cfg, [['GET', K + 'v']]);
      if (vRaw == null) return send(res, 200, { exists: false, v: 0 });
      const v = +vRaw;
      if (String(q) === String(v)) return send(res, 200, { v, unchanged: true });
      const r = await redis(cfg, [['GET', K + 'v'], ['HGETALL', K + 'prof'], ...MODES.map(m => ['HGETALL', K + 'days:' + m]), ['HGETALL', K + 'reset']]);
      const prof = hashToObj(r[1], true), resetRaw = hashToObj(r[2 + MODES.length], false), modes = {}, reset = {};
      MODES.forEach((m, i) => { modes[m] = { profile: prof[m] || null, days: hashToObj(r[2 + i], true) }; });
      for (const m in resetRaw) reset[m] = +resetRaw[m];
      return send(res, 200, { exists: true, v: +r[0], modes, reset });
    }

    // POST: fetch exactly the stored values we need, then write only what is newer.
    const items = validate(await readBody(req));
    const reads = [];
    items.forEach(e => {
      e.ri = reads.length; reads.push(['HGET', K + 'reset', e.mode]);
      if (e.profile) { e.rp = reads.length; reads.push(['HGET', K + 'prof', e.mode]); }
      if (e.days.length) { e.rd = reads.length; reads.push(['HMGET', K + 'days:' + e.mode, ...e.days.map(x => x[0])]); }
    });
    const got = reads.length ? await redis(cfg, reads) : [];
    const writes = []; let written = 0;
    items.forEach(e => {
      let resetTs = +got[e.ri] || 0, wiped = false;
      if (e.reset != null && e.reset > resetTs) {
        writes.push(['DEL', K + 'days:' + e.mode], ['HSET', K + 'reset', e.mode, String(e.reset)]);
        resetTs = e.reset; wiped = true; written++;
      }
      if (e.profile && uOf(e.profile) > uOf(got[e.rp])) { writes.push(['HSET', K + 'prof', e.mode, e.profile]); written++; }
      const hs = [];
      e.days.forEach(([d, s, u], i) => { const old = wiped ? 0 : uOf(got[e.rd][i]); if (u > resetTs && u > old) hs.push(d, s); });
      if (hs.length) { writes.push(['HSET', K + 'days:' + e.mode, ...hs]); written += hs.length / 2; }
    });
    let v;
    if (writes.length) { const r = await redis(cfg, [...writes, ['INCR', K + 'v']]); v = r[r.length - 1]; }
    else { const [vr] = await redis(cfg, [['GET', K + 'v']]); v = +vr || 0; }
    return send(res, 200, { v, written });
  } catch (e) {
    if (e instanceof HttpErr) return send(res, e.status, { error: e.code });
    console.error('sync: ' + (e && e.name));
    return send(res, 500, { error: 'server_error' });
  }
};

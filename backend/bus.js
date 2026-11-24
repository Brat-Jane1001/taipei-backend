/**
 * bus.js - 公車路線與即時位置（台北市＋新北市）
 *
 * 設計重點：
 * - TDX 金鑰只放在後端環境變數（TDX_CLIENT_ID / TDX_CLIENT_SECRET），手機端拿不到
 * - 路線清單快取 12 小時；失敗時沿用舊資料
 * - 即時位置「有人問才抓」：同一條路線 15 秒內不管多少人要，只打 TDX 一次；
 *   同時間的重複請求共用同一個進行中的請求
 * - 每個 IP 每分鐘最多 60 次，避免被拿來洗你的 TDX 額度
 */

const TDX_BASE  = 'https://tdx.transportdata.tw/api/basic';
const TDX_TOKEN = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';

const CITIES = ['Taipei', 'NewTaipei'];

const ROUTES_TTL_MS = 12 * 3600 * 1000;
const LIVE_TTL_MS   = 15 * 1000;
const LIVE_STALE_MS = 90 * 1000;    // TDX 失敗時，最多沿用這麼舊的位置
const MAX_LIVE_KEYS = 200;
const MAX_BUSES     = 120;

const ROUTE_NAME_RE = /^[0-9A-Za-z\u4e00-\u9fff()（）\-]{1,24}$/;

// ───────── TDX 存取 ─────────
let token = { value: null, exp: 0 };
let tokenInflight = null;

async function getToken(force = false) {
  if (!force && token.value && Date.now() < token.exp) return token.value;
  if (tokenInflight) return tokenInflight;

  const id = process.env.TDX_CLIENT_ID;
  const secret = process.env.TDX_CLIENT_SECRET;
  if (!id || !secret) throw Object.assign(new Error('TDX credentials are not configured'), { code: 'no_credentials' });

  tokenInflight = (async () => {
    const res = await fetch(TDX_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
    });
    if (!res.ok) throw Object.assign(new Error(`TDX token failed (${res.status})`), { code: 'token' });
    const j = await res.json();
    token = { value: j.access_token, exp: Date.now() + Math.max((j.expires_in || 600) - 120, 60) * 1000 };
    return token.value;
  })().finally(() => { tokenInflight = null; });

  return tokenInflight;
}

async function tdx(path, retry = true) {
  const t = await getToken();
  const res = await fetch(`${TDX_BASE}${path}`, { headers: { Authorization: `Bearer ${t}`, Accept: 'application/json' } });
  if (res.status === 401 && retry) { await getToken(true); return tdx(path, false); }
  if (res.status === 429) throw Object.assign(new Error('TDX rate limited'), { code: 'rate' });
  if (!res.ok) throw Object.assign(new Error(`TDX ${res.status}`), { code: 'upstream' });
  const j = await res.json();
  return Array.isArray(j) ? j : (j?.value ?? []);
}

// ───────── 路線清單 ─────────
let routesCache = { data: null, at: 0 };
let routesInflight = null;

async function loadRoutes() {
  const lists = await Promise.all(CITIES.map(async (city) => {
    const rows = await tdx(
      `/v2/Bus/Route/City/${city}?$select=RouteUID,RouteName,DepartureStopNameZh,DestinationStopNameZh&$format=JSON`
    );
    return rows.map(r => ({
      n: r?.RouteName?.Zh_tw || '',
      c: city,
      f: r?.DepartureStopNameZh || '',
      t: r?.DestinationStopNameZh || '',
    }));
  }));

  const seen = new Set();
  const out = [];
  for (const r of lists.flat()) {
    if (!r.n || !ROUTE_NAME_RE.test(r.n)) continue;
    const key = `${r.c}:${r.n}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

async function getRoutes() {
  const fresh = routesCache.data && Date.now() - routesCache.at < ROUTES_TTL_MS;
  if (fresh) return routesCache;
  if (!routesInflight) {
    routesInflight = loadRoutes()
      .then(data => { routesCache = { data, at: Date.now() }; return routesCache; })
      .finally(() => { routesInflight = null; });
  }
  try {
    return await routesInflight;
  } catch (e) {
    if (routesCache.data) return routesCache;     // 失敗就沿用舊的
    throw e;
  }
}

// ───────── 即時位置 ─────────
const live = new Map();     // key -> { data, at, inflight }

function normalizeBuses(rows) {
  const out = [];
  for (const b of rows) {
    const lat = b?.BusPosition?.PositionLat;
    const lng = b?.BusPosition?.PositionLon;
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    if (b.DutyStatus === 2) continue;                       // 2 = 已下班
    out.push({
      id: String(b.PlateNumb || ''),
      d:  b.Direction === 1 ? 1 : 0,                         // 0 去程 / 1 返程
      lat, lng,
      h:  Math.round(b.Azimuth ?? b.Bearing ?? 0),           // 方位角
      v:  Math.round(b.Speed ?? 0),                          // km/h
      t:  b.GPSTime || b.SrcUpdateTime || null,
    });
    if (out.length >= MAX_BUSES) break;
  }
  return out;
}

async function getLive(city, route) {
  const key = `${city}:${route}`;
  let e = live.get(key);
  const now = Date.now();

  if (e?.data && now - e.at < LIVE_TTL_MS) return { buses: e.data, fetchedAt: e.at };

  if (!e) {
    if (live.size >= MAX_LIVE_KEYS) {
      const oldest = [...live.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) live.delete(oldest[0]);
    }
    e = { data: null, at: 0, inflight: null };
    live.set(key, e);
  }

  if (!e.inflight) {
    e.inflight = tdx(`/v2/Bus/RealTimeByFrequency/City/${city}/${encodeURIComponent(route)}?$format=JSON`)
      .then(rows => { e.data = normalizeBuses(rows); e.at = Date.now(); })
      .finally(() => { e.inflight = null; });
  }

  try {
    await e.inflight;
  } catch (err) {
    if (e.data && Date.now() - e.at < LIVE_STALE_MS) return { buses: e.data, fetchedAt: e.at, stale: true };
    throw err;
  }
  return { buses: e.data, fetchedAt: e.at };
}

// ───────── 簡易限流（每 IP 每分鐘）─────────
const hits = new Map();
function rateLimit(limit = 60) {
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || 'unknown';
    const h = hits.get(key);
    if (!h || now - h.start > 60_000) { hits.set(key, { start: now, n: 1 }); return next(); }
    if (++h.n > limit) {
      res.set('Retry-After', '30');
      return res.status(429).json({ success: false, message: 'Too many requests, slow down' });
    }
    next();
  };
}
setInterval(() => {
  const cutoff = Date.now() - 120_000;
  for (const [k, v] of hits) if (v.start < cutoff) hits.delete(k);
  for (const [k, v] of live) if (Date.now() - v.at > 5 * 60_000 && !v.inflight) live.delete(k);
}, 60_000).unref();

// ───────── Express 路由 ─────────
function mountBus(app, { fail }) {
  const upstreamError = (res, e) => {
    console.error('[bus]', e.message);
    if (e.code === 'no_credentials') return fail(res, 503, 'Bus data is not configured on the server');
    if (e.code === 'rate')           return fail(res, 503, 'Bus data is busy, try again in a moment');
    return fail(res, 502, 'Bus data is temporarily unavailable');
  };

  // GET /api/bus/routes → [{ n: 路線名, c: 縣市, f: 起站, t: 迄站 }]
  app.get('/api/bus/routes', rateLimit(30), async (req, res) => {
    try {
      const { data, at } = await getRoutes();
      res.set('Cache-Control', 'public, max-age=3600');
      res.json({ success: true, data, updated_at: new Date(at).toISOString() });
    } catch (e) { upstreamError(res, e); }
  });

  // GET /api/bus/live?city=Taipei&route=905
  app.get('/api/bus/live', rateLimit(60), async (req, res) => {
    const city  = String(req.query.city || '');
    const route = String(req.query.route || '');
    if (!CITIES.includes(city))      return fail(res, 400, 'city must be Taipei or NewTaipei');
    if (!ROUTE_NAME_RE.test(route))  return fail(res, 400, 'Invalid route name');
    try {
      const { buses, fetchedAt, stale } = await getLive(city, route);
      res.json({
        success: true,
        data: { buses, fetched_at: new Date(fetchedAt).toISOString(), ttl: LIVE_TTL_MS / 1000, stale: !!stale },
      });
    } catch (e) { upstreamError(res, e); }
  });
}

module.exports = mountBus;
module.exports._internals = { normalizeBuses, getLive, getRoutes, ROUTE_NAME_RE };

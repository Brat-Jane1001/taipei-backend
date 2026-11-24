/**
 * trips.js - 行程分享
 *
 * - POST   /api/trips/share   上傳行程快照，拿到短代碼（帶 code 且是自己的 = 更新同一個連結）
 * - GET    /api/trips/:code   取回行程（App 內開啟用）
 * - DELETE /api/trips/:code   停止分享（只有分享者本人）
 * - GET    /t/:code           唯讀網頁（沒裝 App 的人點連結看到的頁面）
 *
 * 行程內容在寫入前一律重新整理過（長度、數量、座標範圍），網頁輸出一律跳脫。
 */
const crypto = require('crypto');

const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_RE = /^[2-9A-HJKMNP-Z]{8}$/;

const LIMITS = { days: 14, stopsPerDay: 30, stopsTotal: 100 };

function makeCode() {
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return s;
}

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** 把使用者送來的行程整理成安全、固定格式的資料；不合格回傳 { error } */
function sanitizeTrip(body) {
  const title = text(body?.title, 80);
  if (!title) return { error: 'Trip title is required' };

  if (!Array.isArray(body?.days) || body.days.length === 0) return { error: 'A trip needs at least one day' };
  if (body.days.length > LIMITS.days) return { error: `A trip can have at most ${LIMITS.days} days` };

  let total = 0;
  const days = [];
  for (const d of body.days) {
    const stopsIn = Array.isArray(d?.stops) ? d.stops : [];
    if (stopsIn.length > LIMITS.stopsPerDay) return { error: `A day can have at most ${LIMITS.stopsPerDay} stops` };

    const stops = [];
    for (const s of stopsIn) {
      const lat = Number(s?.lat), lng = Number(s?.lng);
      const name = text(s?.name, 80);
      if (!name || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        return { error: 'Every stop needs a name and a valid location' };
      }
      const time = typeof s?.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s.time) ? s.time : '';
      stops.push({
        name,
        lat: Math.round(lat * 1e6) / 1e6,
        lng: Math.round(lng * 1e6) / 1e6,
        note: text(s?.note, 200),
        time,
      });
      total++;
    }
    days.push({ label: text(d?.label, 30), stops });
  }
  if (total > LIMITS.stopsTotal) return { error: `A trip can have at most ${LIMITS.stopsTotal} stops` };
  if (total === 0) return { error: 'Add at least one stop before sharing' };

  return { title, data: { days } };
}

const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 唯讀網頁：沒有任何 script，所有使用者輸入都跳脫 */
function renderTripPage({ code, title, data }) {
  const days = data.days.map((d, i) => {
    const stops = d.stops.map((s, j) => `
      <li>
        <span class="n">${j + 1}</span>
        <div class="b">
          <div class="nm">${s.time ? `<span class="tm">${esc(s.time)}</span>` : ''}${esc(s.name)}</div>
          ${s.note ? `<div class="nt">${esc(s.note)}</div>` : ''}
          <a href="https://www.google.com/maps/search/?api=1&amp;query=${Number(s.lat)},${Number(s.lng)}" rel="noopener">Open in Google Maps</a>
        </div>
      </li>`).join('');
    return `<section><h2>${esc(d.label || `Day ${i + 1}`)}</h2>${stops ? `<ol>${stops}</ol>` : '<p class="nt">No stops yet.</p>'}</section>`;
  }).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Taipei Digital Twin</title>
<style>
:root{color-scheme:light dark;--bg:#f4f6fb;--card:#fff;--tx:#15192b;--mut:#5b6478;--ac:#2f6df6;--ln:#e3e7f0}
@media(prefers-color-scheme:dark){:root{--bg:#12162a;--card:#1b2140;--tx:#eef1fb;--mut:#9aa4c0;--ac:#6b9bff;--ln:#2a3258}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans TC",sans-serif}
main{max-width:640px;margin:0 auto;padding:24px 16px 56px}
h1{font-size:28px;margin:8px 0 4px}h2{font-size:18px;margin:28px 0 10px}
.sub{color:var(--mut);margin:0 0 18px}
.open{display:inline-block;background:var(--ac);color:#fff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:24px}
ol{list-style:none;margin:0;padding:0}
li{display:flex;gap:12px;background:var(--card);border:1px solid var(--ln);border-radius:14px;padding:14px;margin-bottom:10px}
.n{flex:none;width:28px;height:28px;border-radius:50%;background:var(--ac);color:#fff;font-weight:700;display:flex;align-items:center;justify-content:center;font-size:14px}
.nm{font-weight:600}.tm{color:var(--ac);margin-right:8px;font-variant-numeric:tabular-nums}
.nt{color:var(--mut);font-size:14px}li a{font-size:14px;color:var(--ac)}
footer{margin-top:32px;color:var(--mut);font-size:13px}
</style></head><body><main>
<h1>${esc(title)}</h1>
<p class="sub">A trip shared from the Taipei Digital Twin app.</p>
<a class="open" href="taipeidt://trip/${esc(code)}">Open in the app</a>
${days}
<footer>Don't have the app? You can still follow this plan from the links above. Trip code: ${esc(code)}</footer>
</main></body></html>`;
}

function mountTrips(app, { supabase, fail, requireDevice, getDeviceId }) {
  const baseUrl = (req) => (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

  // POST /api/trips/share
  app.post('/api/trips/share', requireDevice, async (req, res) => {
    try {
      const clean = sanitizeTrip(req.body);
      if (clean.error) return fail(res, 400, clean.error);

      const wanted = String(req.body?.code || '').toUpperCase();
      if (wanted) {
        if (!CODE_RE.test(wanted)) return fail(res, 400, 'Invalid trip code');
        const { data, error } = await supabase.from('trips')
          .update({ title: clean.title, data: clean.data, updated_at: new Date().toISOString() })
          .eq('code', wanted).eq('owner_id', req.deviceId)
          .select('code').maybeSingle();
        if (error) throw error;
        if (data) return res.json({ success: true, data: { code: data.code, url: `${baseUrl(req)}/t/${data.code}` } });
        // 找不到（可能已被停止分享）就當作新的分享
      }

      for (let attempt = 0; attempt < 5; attempt++) {
        const code = makeCode();
        const { data, error } = await supabase.from('trips')
          .insert([{ code, owner_id: req.deviceId, title: clean.title, data: clean.data }])
          .select('code').single();
        if (!error) return res.status(201).json({ success: true, data: { code: data.code, url: `${baseUrl(req)}/t/${data.code}` } });
        if (error.code !== '23505') throw error;      // 23505 = 代碼重複，換一組再試
      }
      return fail(res, 500, 'Could not create a share link, try again');
    } catch (e) {
      console.error('[trips/share]', e);
      fail(res, 500, 'Server error');
    }
  });

  // GET /api/trips/:code
  app.get('/api/trips/:code', async (req, res) => {
    try {
      const code = req.params.code.toUpperCase();
      if (!CODE_RE.test(code)) return fail(res, 404, 'Trip not found');
      const { data, error } = await supabase.from('trips')
        .select('code, owner_id, title, data, updated_at').eq('code', code).maybeSingle();
      if (error) throw error;
      if (!data) return fail(res, 404, 'Trip not found');

      const dev = getDeviceId(req);
      res.json({
        success: true,
        data: { code: data.code, title: data.title, days: data.data.days, updated_at: data.updated_at, is_owner: !!dev && dev === data.owner_id },
      });
    } catch (e) {
      console.error('[trips/get]', e);
      fail(res, 500, 'Server error');
    }
  });

  // DELETE /api/trips/:code
  app.delete('/api/trips/:code', requireDevice, async (req, res) => {
    try {
      const code = req.params.code.toUpperCase();
      if (!CODE_RE.test(code)) return fail(res, 404, 'Trip not found');
      const { data, error } = await supabase.from('trips')
        .delete().eq('code', code).eq('owner_id', req.deviceId).select('code').maybeSingle();
      if (error) throw error;
      if (!data) return fail(res, 404, 'Trip not found');
      res.json({ success: true });
    } catch (e) {
      console.error('[trips/delete]', e);
      fail(res, 500, 'Server error');
    }
  });

  // GET /t/:code  唯讀網頁
  app.get('/t/:code', async (req, res) => {
    res.set({
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    try {
      const code = req.params.code.toUpperCase();
      const { data } = CODE_RE.test(code)
        ? await supabase.from('trips').select('code, title, data').eq('code', code).maybeSingle()
        : { data: null };
      if (!data) return res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Trip not found</title><body style="font-family:sans-serif;padding:32px"><h1>Trip not found</h1><p>This link may have been removed by its owner.</p>');
      res.type('html').send(renderTripPage(data));
    } catch (e) {
      console.error('[trips/page]', e);
      res.status(500).type('html').send('<!doctype html><meta charset="utf-8"><title>Error</title><body style="font-family:sans-serif;padding:32px"><h1>Something went wrong</h1><p>Please try again in a moment.</p>');
    }
  });
}

module.exports = mountTrips;
module.exports._internals = { sanitizeTrip, renderTripPage, makeCode, CODE_RE };

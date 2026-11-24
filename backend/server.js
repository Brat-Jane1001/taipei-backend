/**
 * Taipei Digital Twin - Backend API
 * Express + Supabase (PostgreSQL)
 * 部署到 Render.com
 *
 * 環境變數：
 *   SUPABASE_URL   專案網址
 *   SUPABASE_KEY   Supabase「secret key」(sb_secret_...)，不要用 publishable key
 *   ADMIN_KEY      後台管理密碼（自己訂一組長一點的）
 *   TDX_CLIENT_ID / TDX_CLIENT_SECRET   TDX 金鑰（公車用，只放在這裡）
 *   PUBLIC_URL     （選填）分享連結的網址，例如 https://tpdgt.onrender.com
 *   PORT           Render 會自動給
 */
require('dotenv').config();
const crypto  = require('crypto');
const express = require('express');
const cors    = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app  = express();
const PORT = process.env.PORT || 3000;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.set('trust proxy', 1);   // Render 在 proxy 後面，限流才抓得到真實 IP
app.use(cors());
app.use(express.json({ limit: '100kb' }));

// ============================================================
// 共用工具
// ============================================================
const UUID_RE   = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEVICE_RE = /^[A-Za-z0-9_-]{16,64}$/;

const fail = (res, status, message) => res.status(status).json({ success: false, message });

function serverError(res, e, where) {
  console.error(`[${where}]`, e);
  return fail(res, 500, 'Server error');
}

// 管理員驗證：標頭帶 x-admin-key
function requireAdmin(req, res, next) {
  const want = process.env.ADMIN_KEY || '';
  if (!want) return fail(res, 503, 'ADMIN_KEY is not configured on the server');
  const given = Buffer.from(req.get('x-admin-key') || '');
  const wantB = Buffer.from(want);
  if (given.length !== wantB.length || !crypto.timingSafeEqual(given, wantB)) {
    return fail(res, 401, 'Invalid admin key');
  }
  next();
}

// 使用者識別：App 第一次開啟時產生的 device id，標頭帶 x-device-id
function getDeviceId(req) {
  const v = (req.get('x-device-id') || '').trim();
  return DEVICE_RE.test(v) ? v : null;
}

function requireDevice(req, res, next) {
  const id = getDeviceId(req);
  if (!id) return fail(res, 400, 'Missing or invalid x-device-id');
  req.deviceId = id;
  next();
}

const cleanText = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// ============================================================
// 健康檢查（UptimeRobot 會 ping 這個）
// ============================================================
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Taipei Digital Twin API', time: new Date().toISOString() });
});

// ============================================================
// 活動 Events（讀取公開；新增 / 修改 / 刪除需要管理員）
// ============================================================

// GET /api/events
app.get('/api/events', async (req, res) => {
  try {
    let query = supabase.from('events').select('*').order('created_at', { ascending: false });

    if (req.query.active !== undefined) {
      query = query.eq('active', req.query.active === 'true');
    }
    if (req.query.tag) {
      query = query.contains('tags', [req.query.tag]);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({ success: true, data, total: data.length });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// GET /api/events/:id
app.get('/api/events/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('events').select('*').eq('id', req.params.id).single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (e) {
    res.status(404).json({ success: false, message: 'Event not found' });
  }
});

// POST /api/events
app.post('/api/events', requireAdmin, async (req, res) => {
  try {
    const { title, description, location, lat, lng, time, tags, image } = req.body;
    if (!title || !lat || !lng) {
      return res.status(400).json({ success: false, message: 'title, lat, lng are required' });
    }

    const { data, error } = await supabase.from('events').insert([{
      title,
      description: description || '',
      location:    location    || '',
      lat:         parseFloat(lat),
      lng:         parseFloat(lng),
      time:        time        || '',
      tags:        Array.isArray(tags) ? tags : (tags ? tags.split(',').map(t => t.trim()) : []),
      image:       image       || '',
      active:      true,
    }]).select().single();

    if (error) throw error;
    res.status(201).json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// PUT /api/events/:id
app.put('/api/events/:id', requireAdmin, async (req, res) => {
  try {
    const updates = { ...req.body, updated_at: new Date().toISOString() };
    if (updates.lat) updates.lat = parseFloat(updates.lat);
    if (updates.lng) updates.lng = parseFloat(updates.lng);
    if (updates.tags && !Array.isArray(updates.tags)) {
      updates.tags = updates.tags.split(',').map(t => t.trim());
    }
    delete updates.id;

    const { data, error } = await supabase
      .from('events').update(updates).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// PATCH /api/events/:id/toggle
app.patch('/api/events/:id/toggle', requireAdmin, async (req, res) => {
  try {
    const { data: current, error: fetchErr } = await supabase
      .from('events').select('active').eq('id', req.params.id).single();
    if (fetchErr) throw fetchErr;

    const { data, error } = await supabase
      .from('events')
      .update({ active: !current.active, updated_at: new Date().toISOString() })
      .eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// DELETE /api/events/:id
app.delete('/api/events/:id', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('events').delete().eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ============================================================
// 組隊 Meetups（使用者發起 → 管理員審核 → 大家 +1）
// ============================================================

const MEETUP_SELECT = '*, meetup_members(count)';

// 把資料列轉成給 App 的格式（不回傳 host_id）
function toPublicMeetup(row, deviceId, joinedIds) {
  const { host_id, meetup_members, ...rest } = row;
  return {
    ...rest,
    member_count: meetup_members?.[0]?.count ?? 0,
    is_host: !!deviceId && host_id === deviceId,
    joined:  joinedIds.has(row.id),
  };
}

async function getJoinedIds(deviceId, meetupIds) {
  if (!deviceId || meetupIds.length === 0) return new Set();
  const { data, error } = await supabase
    .from('meetup_members').select('meetup_id')
    .eq('user_id', deviceId).in('meetup_id', meetupIds);
  if (error) throw error;
  return new Set((data || []).map(r => r.meetup_id));
}

// GET /api/meetups  已核准且還沒開始的組隊
app.get('/api/meetups', async (req, res) => {
  try {
    const deviceId = getDeviceId(req);
    const { data, error } = await supabase
      .from('meetups').select(MEETUP_SELECT)
      .eq('status', 'approved')
      .gte('starts_at', new Date().toISOString())
      .order('starts_at', { ascending: true })
      .limit(100);
    if (error) throw error;

    const joined = await getJoinedIds(deviceId, data.map(r => r.id));
    res.json({ success: true, data: data.map(r => toPublicMeetup(r, deviceId, joined)) });
  } catch (e) { serverError(res, e, 'GET /api/meetups'); }
});

// GET /api/meetups/mine  我發起的（含審核中、被拒絕）+ 我加入的
app.get('/api/meetups/mine', requireDevice, async (req, res) => {
  try {
    const deviceId = req.deviceId;
    const { data: mem, error: memErr } = await supabase
      .from('meetup_members').select('meetup_id').eq('user_id', deviceId);
    if (memErr) throw memErr;

    const ids = (mem || []).map(r => r.meetup_id).filter(id => UUID_RE.test(id));
    const filter = ids.length
      ? `host_id.eq.${deviceId},id.in.(${ids.join(',')})`
      : `host_id.eq.${deviceId}`;

    const { data, error } = await supabase
      .from('meetups').select(MEETUP_SELECT)
      .or(filter)
      .order('starts_at', { ascending: false })
      .limit(100);
    if (error) throw error;

    const joined = new Set(ids);
    res.json({ success: true, data: data.map(r => toPublicMeetup(r, deviceId, joined)) });
  } catch (e) { serverError(res, e, 'GET /api/meetups/mine'); }
});

// GET /api/meetups/:id  詳情 + 參加者名單
app.get('/api/meetups/:id', async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) return fail(res, 404, 'Meetup not found');
    const deviceId = getDeviceId(req);

    const { data: row, error } = await supabase
      .from('meetups').select(MEETUP_SELECT).eq('id', req.params.id).maybeSingle();
    if (error) throw error;

    const isHost = !!row && !!deviceId && row.host_id === deviceId;
    if (!row || (row.status !== 'approved' && !isHost)) return fail(res, 404, 'Meetup not found');

    const { data: members, error: mErr } = await supabase
      .from('meetup_members').select('display_name, joined_at')
      .eq('meetup_id', row.id).order('joined_at', { ascending: true });
    if (mErr) throw mErr;

    const joined = await getJoinedIds(deviceId, [row.id]);
    res.json({
      success: true,
      data: { ...toPublicMeetup(row, deviceId, joined), members: members || [] },
    });
  } catch (e) { serverError(res, e, 'GET /api/meetups/:id'); }
});

// POST /api/meetups  發起組隊（送出後狀態 = pending，等管理員核准）
app.post('/api/meetups', requireDevice, async (req, res) => {
  try {
    const b = req.body || {};

    const title       = cleanText(b.title, 80);
    const description = cleanText(b.description, 1000);
    const location    = cleanText(b.location, 120);
    const hostName    = cleanText(b.host_name, 30);
    const lat         = Number(b.lat);
    const lng         = Number(b.lng);
    const maxPeople   = parseInt(b.max_people, 10);
    const startsAt    = new Date(b.starts_at);

    if (title.length < 3)        return fail(res, 400, 'Title must be at least 3 characters');
    if (!hostName)               return fail(res, 400, 'Your name is required');
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return fail(res, 400, 'A valid location is required');
    }
    if (!Number.isInteger(maxPeople) || maxPeople < 2 || maxPeople > 50) {
      return fail(res, 400, 'Group size must be between 2 and 50');
    }
    if (Number.isNaN(startsAt.getTime())) return fail(res, 400, 'A valid start time is required');
    const now = Date.now();
    if (startsAt.getTime() < now + 30 * 60 * 1000) {
      return fail(res, 400, 'Start time must be at least 30 minutes from now');
    }
    if (startsAt.getTime() > now + 90 * 24 * 3600 * 1000) {
      return fail(res, 400, 'Start time must be within 90 days');
    }

    const tags = (Array.isArray(b.tags) ? b.tags : [])
      .filter(t => typeof t === 'string')
      .map(t => t.trim().toLowerCase().slice(0, 20))
      .filter(Boolean)
      .slice(0, 5);

    // 防洗版：同一支手機最多同時 3 筆待審核
    const { count, error: cErr } = await supabase
      .from('meetups').select('id', { count: 'exact', head: true })
      .eq('host_id', req.deviceId).eq('status', 'pending');
    if (cErr) throw cErr;
    if ((count || 0) >= 3) {
      return fail(res, 429, 'You already have 3 meetups waiting for review');
    }

    const { data, error } = await supabase.from('meetups').insert([{
      host_id: req.deviceId,
      host_name: hostName,
      title, description, location, lat, lng,
      starts_at: startsAt.toISOString(),
      max_people: maxPeople,
      tags,
      status: 'pending',
    }]).select(MEETUP_SELECT).single();
    if (error) throw error;

    res.status(201).json({ success: true, data: toPublicMeetup(data, req.deviceId, new Set([data.id])) });
  } catch (e) { serverError(res, e, 'POST /api/meetups'); }
});

// POST /api/meetups/:id/join  +1
app.post('/api/meetups/:id/join', requireDevice, async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) return fail(res, 404, 'Meetup not found');
    const name = cleanText(req.body?.display_name, 30);
    if (!name) return fail(res, 400, 'Your name is required');

    const { data, error } = await supabase.rpc('join_meetup', {
      p_meetup: req.params.id, p_user: req.deviceId, p_name: name,
    });
    if (error) throw error;

    if (!data.ok) {
      const map = {
        not_found: [404, 'Meetup not found'],
        not_open:  [409, 'This meetup is not open for joining'],
        ended:     [409, 'This meetup has already started'],
        full:      [409, 'This meetup is full'],
      };
      const [status, message] = map[data.code] || [400, 'Could not join'];
      return fail(res, status, message);
    }
    res.json({ success: true, data: { member_count: data.member_count, joined: true } });
  } catch (e) { serverError(res, e, 'POST /api/meetups/:id/join'); }
});

// POST /api/meetups/:id/leave
app.post('/api/meetups/:id/leave', requireDevice, async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) return fail(res, 404, 'Meetup not found');

    const { data: row, error } = await supabase
      .from('meetups').select('host_id').eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!row) return fail(res, 404, 'Meetup not found');
    if (row.host_id === req.deviceId) {
      return fail(res, 400, 'Hosts cannot leave. Cancel the meetup instead.');
    }

    const { error: dErr } = await supabase
      .from('meetup_members').delete()
      .eq('meetup_id', req.params.id).eq('user_id', req.deviceId);
    if (dErr) throw dErr;

    res.json({ success: true });
  } catch (e) { serverError(res, e, 'POST /api/meetups/:id/leave'); }
});

// POST /api/meetups/:id/cancel  發起者取消
app.post('/api/meetups/:id/cancel', requireDevice, async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) return fail(res, 404, 'Meetup not found');

    const { data, error } = await supabase
      .from('meetups').update({ status: 'cancelled' })
      .eq('id', req.params.id).eq('host_id', req.deviceId)
      .in('status', ['pending', 'approved'])
      .select('id').maybeSingle();
    if (error) throw error;
    if (!data) return fail(res, 404, 'Meetup not found or already closed');

    res.json({ success: true });
  } catch (e) { serverError(res, e, 'POST /api/meetups/:id/cancel'); }
});

// ============================================================
// 組隊審核（管理員）
// ============================================================

// GET /api/admin/meetups?status=pending|approved|rejected|cancelled|all
app.get('/api/admin/meetups', requireAdmin, async (req, res) => {
  try {
    const status = req.query.status || 'pending';
    let query = supabase.from('meetups').select(MEETUP_SELECT)
      .order('created_at', { ascending: false }).limit(200);
    if (status !== 'all') query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw error;

    res.json({
      success: true,
      data: data.map(r => {
        const { host_id, meetup_members, ...rest } = r;
        return { ...rest, member_count: meetup_members?.[0]?.count ?? 0 };
      }),
    });
  } catch (e) { serverError(res, e, 'GET /api/admin/meetups'); }
});

// 審核動作共用：只允許從指定狀態轉換
async function reviewMeetup(req, res, { from, to, reason }) {
  try {
    if (!UUID_RE.test(req.params.id)) return fail(res, 404, 'Meetup not found');
    const { data, error } = await supabase
      .from('meetups')
      .update({ status: to, reject_reason: reason ?? null, reviewed_at: new Date().toISOString() })
      .eq('id', req.params.id).in('status', from)
      .select('id, status').maybeSingle();
    if (error) throw error;
    if (!data) return fail(res, 409, `Meetup is not in a state that can become "${to}"`);
    res.json({ success: true, data });
  } catch (e) { serverError(res, e, `admin ${to}`); }
}

// PATCH /api/admin/meetups/:id/approve
app.patch('/api/admin/meetups/:id/approve', requireAdmin, (req, res) =>
  reviewMeetup(req, res, { from: ['pending', 'rejected'], to: 'approved' }));

// PATCH /api/admin/meetups/:id/reject   body: { reason }
app.patch('/api/admin/meetups/:id/reject', requireAdmin, (req, res) =>
  reviewMeetup(req, res, {
    from: ['pending', 'approved'], to: 'rejected',
    reason: cleanText(req.body?.reason, 200) || null,
  }));

// PATCH /api/admin/meetups/:id/cancel   下架已核准的組隊
app.patch('/api/admin/meetups/:id/cancel', requireAdmin, (req, res) =>
  reviewMeetup(req, res, { from: ['approved'], to: 'cancelled' }));

// ============================================================
// 公車（TDX，後端統一輪詢快取）與行程分享
// ============================================================
require('./bus')(app, { fail });
require('./trips')(app, { supabase, fail, requireDevice, getDeviceId });
require('./recommend')(app, { supabase, fail });

app.listen(PORT, () => {
  console.log(`✅ API running on port ${PORT}`);
  if (!process.env.ADMIN_KEY) console.warn('⚠️  ADMIN_KEY is not set: admin routes will return 503');
});

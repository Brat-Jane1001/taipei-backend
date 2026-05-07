/**
 * Taipei Digital Twin - Backend API
 * Express + Supabase
 * 部署到 Render.com
 */

const express   = require('express');
const cors      = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app  = express();
const PORT = process.env.PORT || 3000;

// ===== Supabase 連線（用環境變數，不要 hardcode）=====
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

app.use(cors());
app.use(express.json());

// ===== 健康檢查（UptimeRobot 會 ping 這個）=====
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Taipei Digital Twin API', time: new Date().toISOString() });
});

// ===== GET /api/events =====
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

// ===== GET /api/events/:id =====
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

// ===== POST /api/events =====
app.post('/api/events', async (req, res) => {
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

// ===== PUT /api/events/:id =====
app.put('/api/events/:id', async (req, res) => {
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

// ===== PATCH /api/events/:id/toggle =====
app.patch('/api/events/:id/toggle', async (req, res) => {
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

// ===== DELETE /api/events/:id =====
app.delete('/api/events/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('events').delete().eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ API running on port ${PORT}`);
});
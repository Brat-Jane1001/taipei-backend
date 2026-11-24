/**
 * recommend.js - 情境感知推薦引擎 (Weather + Transit + Weighted KNN)
 * 環境變數需新增：CWA_API_KEY（中央氣象署開放資料授權碼）
 */

const CWA_URL = 'https://opendata.cwa.gov.tw/api/v1/rest/datastore/F-C0032-001';
let weatherCache = { data: null, at: 0 };
const WEATHER_TTL_MS = 15 * 60 * 1000;

// 1. 取得台北市即時天氣與降雨機率（快取 15 分鐘）
async function getTaipeiWeather() {
  if (weatherCache.data && Date.now() - weatherCache.at < WEATHER_TTL_MS) {
    return weatherCache.data;
  }
  const apiKey = process.env.CWA_API_KEY;
  if (!apiKey) {
    // 若尚未設定金鑰，回傳預設晴天狀態確保 API 不會崩潰
    return { wx: '晴時多雲', pop: 10, isRaining: false };
  }

  const res = await fetch(`${CWA_URL}?Authorization=${apiKey}&locationName=${encodeURIComponent('臺北市')}`);
  if (!res.ok) throw new Error(`CWA API error: ${res.status}`);
  const json = await res.json();

  const elements = json?.records?.location?.[0]?.weatherElement || [];
  const wx  = elements.find(e => e.elementName === 'Wx')?.time?.[0]?.parameter?.parameterName || '';
  const pop = Number(elements.find(e => e.elementName === 'PoP')?.time?.[0]?.parameter?.parameterName || 0);
  const isRaining = pop >= 50 || wx.includes('雨');

  weatherCache = { data: { wx, pop, isRaining }, at: Date.now() };
  return weatherCache.data;
}

// 2. Haversine 距離計算（公里）
function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (v) => (v * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// 3. 建立活動特徵向量並計算 Weighted KNN 距離
function scoreEventsKNN(events, { userLat, userLng, preferredTags, weather }) {
  const INDOOR_TAGS  = new Set(['indoor', 'underground', 'mall', 'museum', 'cafe', '室內', '地下街']);
  const TRANSIT_TAGS = new Set(['mrt', 'station', 'hub', '捷運', '車站']);

  // 動態權重：下雨時大幅提高「室內」與「捷運直達」的權重
  const weights = {
    indoor:   weather.isRaining ? 3.5 : 0.4,
    transit:  weather.isRaining ? 2.0 : 0.8,
    distance: 1.5,
    interest: 1.8,
  };

  // 使用者當下理想目標向量 U
  const target = {
    indoor:   weather.isRaining ? 1.0 : 0.3,
    transit:  1.0,
    distance: 1.0,
    interest: 1.0,
  };

  const scored = events.map((ev) => {
    const tags = (ev.tags || []).map(t => t.toLowerCase());
    const isIndoor  = tags.some(t => INDOOR_TAGS.has(t)) ? 1.0 : 0.0;
    const isTransit = tags.some(t => TRANSIT_TAGS.has(t)) ? 1.0 : 0.3;

    const distKm = (Number.isFinite(userLat) && Number.isFinite(userLng))
      ? haversineKm(userLat, userLng, ev.lat, ev.lng)
      : 3.0; // 若前端未給定位，預設 3 公里
    const distScore = Math.max(0, 1 - distKm / 15);

    const interestScore = preferredTags.length > 0
      ? tags.filter(t => preferredTags.includes(t)).length / preferredTags.length
      : 0.5;

    // 計算加權歐氏距離
    const sqDist =
      weights.indoor   * (target.indoor   - isIndoor) ** 2 +
      weights.transit  * (target.transit  - isTransit) ** 2 +
      weights.distance * (target.distance - distScore) ** 2 +
      weights.interest * (target.interest - interestScore) ** 2;

    const knnDistance = Math.sqrt(sqDist);

    // 產生可解釋的推薦標籤（給 App UI 顯示）
    const reasons = [];
    if (weather.isRaining && isIndoor === 1.0) reasons.push('🌧️ 雨天室內首選');
    if (isTransit === 1.0) reasons.push('🚇 捷運/交通樞紐直達');
    if (distKm <= 2.0) reasons.push(`📍 距離僅 ${distKm.toFixed(1)} km`);

    return {
      ...ev,
      _knn_distance: Number(knnDistance.toFixed(4)),
      distance_km: Number(distKm.toFixed(2)),
      reasons,
    };
  });

  // 依特徵距離由小到大排序（Nearest Neighbors）
  return scored.sort((a, b) => a._knn_distance - b._knn_distance);
}

// 4. 掛載 Express 路由
function mountRecommend(app, { supabase, fail }) {
  // GET /api/recommendations?lat=25.0478&lng=121.5170&tags=food,culture&k=5
  app.get('/api/recommendations', async (req, res) => {
    try {
      const userLat = parseFloat(req.query.lat);
      const userLng = parseFloat(req.query.lng);
      const k = Math.min(Math.max(parseInt(req.query.k, 10) || 5, 1), 20);
      const preferredTags = req.query.tags
        ? String(req.query.tags).split(',').map(t => t.trim().toLowerCase()).filter(Boolean)
        : [];

      const [weather, { data: events, error }] = await Promise.all([
        getTaipeiWeather(),
        supabase.from('events').select('*').eq('active', true),
      ]);
      if (error) throw error;

      const ranked = scoreEventsKNN(events || [], { userLat, userLng, preferredTags, weather });
      const topK = ranked.slice(0, k);

      res.json({
        success: true,
        context: {
          weather,
          tip: weather.isRaining
            ? `台北目前${weather.wx}（降雨機率 ${weather.pop}%），已為您優先篩選室內與捷運直達地點`
            : `台北目前${weather.wx}，適合安排戶外與街區探索`,
        },
        data: topK,
      });
    } catch (e) {
      console.error('[GET /api/recommendations]', e);
      fail(res, 500, 'Failed to generate recommendations');
    }
  });
}

module.exports = mountRecommend;
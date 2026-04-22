const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const { runReport: runGoogleReport } = require('./lib/google-ad-manager');

const app = express();
const PORT = 3000;

const ADFIT_API_URL = 'https://adfit-external-api.kakao.com/publisher/v2/report';
const API_KEY = '1707c6fa620d72cf9d391a26db10a71dcbc62692';
const GOOGLE_NETWORK_CODE = process.env.GOOGLE_NETWORK_CODE || '113951510';

// ─────────────────────────────────────────────────────────────
// 메모리 캐시 (TTL 5분) - 같은 기간 재조회 시 즉시 응답
// ─────────────────────────────────────────────────────────────
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();      // key → { value, expiresAt }
const inflight = new Map();   // key → Promise (동시 요청 dedup)

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) { cache.delete(key); return null; }
  return hit.value;
}
function cacheSet(key, value) {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  // 캐시 크기 제한 (최근 50개만 유지)
  if (cache.size > 50) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
}

app.use(express.static(path.join(__dirname, 'public')));

// 날짜 파라미터 포맷 검증
function isValidDate(str, type) {
  if (type === 'D') return /^\d{8}$/.test(str);
  if (type === 'M') return /^\d{6}$/.test(str);
  return false;
}

app.get('/api/report', async (req, res) => {
  const { periodType, startDate, endDate } = req.query;

  if (!periodType || !startDate || !endDate) {
    return res.status(400).json({ error: 'periodType, startDate, endDate 파라미터가 필요합니다.' });
  }

  if (!['D', 'M'].includes(periodType)) {
    return res.status(400).json({ error: 'periodType은 D 또는 M이어야 합니다.' });
  }

  if (!isValidDate(startDate, periodType) || !isValidDate(endDate, periodType)) {
    return res.status(400).json({ error: '날짜 형식이 올바르지 않습니다.' });
  }

  const cacheKey = `kakao:${periodType}:${startDate}:${endDate}`;
  const cached = cacheGet(cacheKey);
  if (cached) { res.set('X-Cache', 'HIT'); return res.json(cached); }

  // 동시 요청 dedup
  if (inflight.has(cacheKey)) {
    try {
      const data = await inflight.get(cacheKey);
      res.set('X-Cache', 'COALESCED');
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  const params = new URLSearchParams({ apikey: API_KEY, periodType, startDate, endDate });
  const url = `${ADFIT_API_URL}?${params.toString()}`;

  const promise = (async () => {
    const response = await fetch(url);
    if (!response.ok) {
      const text = await response.text();
      const e = new Error(`API 오류: ${response.status} ${text}`);
      e.status = response.status;
      throw e;
    }
    return response.json();
  })();
  inflight.set(cacheKey, promise);

  try {
    const data = await promise;
    cacheSet(cacheKey, data);
    res.set('X-Cache', 'MISS');
    res.json(data);
  } catch (err) {
    console.error('API 호출 오류:', err);
    res.status(err.status || 500).json({ error: err.message || '서버 오류' });
  } finally {
    inflight.delete(cacheKey);
  }
});

// -------------------------------------------------------------
// Google Ad Manager 보고서
//   GET /api/google/report?startDate=YYYYMMDD&endDate=YYYYMMDD
// -------------------------------------------------------------
app.get('/api/google/report', async (req, res) => {
  const { startDate, endDate } = req.query;
  if (!/^\d{8}$/.test(startDate) || !/^\d{8}$/.test(endDate)) {
    return res.status(400).json({ error: 'startDate, endDate(YYYYMMDD)가 필요합니다.' });
  }
  const fmt = s => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

  const cacheKey = `google:${startDate}:${endDate}`;
  const cached = cacheGet(cacheKey);
  if (cached) { res.set('X-Cache', 'HIT'); return res.json(cached); }

  if (inflight.has(cacheKey)) {
    try {
      const data = await inflight.get(cacheKey);
      res.set('X-Cache', 'COALESCED');
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  const promise = runGoogleReport({
    networkCode: GOOGLE_NETWORK_CODE,
    dimensions: ['DATE', 'AD_UNIT_NAME'],
    // TOTAL_LINE_ITEM_LEVEL_* 만 요청 (Ad Server + Ad Exchange 합산)
    // 컬럼 수를 줄여 리포트 생성 속도 향상 (9 → 3)
    columns: [
      'TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS',
      'TOTAL_LINE_ITEM_LEVEL_CLICKS',
      'TOTAL_LINE_ITEM_LEVEL_CPM_AND_CPC_REVENUE',
    ],
    startDate: fmt(startDate),
    endDate:   fmt(endDate),
  });
  inflight.set(cacheKey, promise);

  try {
    const result = await promise;
    cacheSet(cacheKey, result);
    res.set('X-Cache', 'MISS');
    res.json(result);
  } catch (err) {
    console.error('Google API 오류:', err);
    res.status(500).json({ error: err.message });
  } finally {
    inflight.delete(cacheKey);
  }
});

app.listen(PORT, () => {
  console.log(`카페 애드핏 대시보드 실행 중: http://localhost:${PORT}`);
});

const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const { runReport: runGoogleReport } = require('./lib/google-ad-manager');

// .env.local 자동 로드 (Node 20+ 에서도 --env-file 플래그 없이 동작하도록)
(function loadEnvLocal() {
  try {
    const envPath = path.join(__dirname, '.env.local');
    if (!fs.existsSync(envPath)) return;
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let [, k, v] = m;
      if (!process.env[k]) {
        v = v.replace(/^['"]|['"]$/g, '');  // 앞뒤 따옴표 제거
        process.env[k] = v;
      }
    }
  } catch (_) {}
})();

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
    // TOTAL_LINE_ITEM_LEVEL_* (Ad Server + Ad Exchange 합산) + TOTAL_AD_REQUESTS(총요청)
    columns: [
      'TOTAL_AD_REQUESTS',
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

// -------------------------------------------------------------
// 네이버 CSV 공유 저장소 (Vercel Blob — private store) — 로컬 개발용 프록시
//   api/naver-csv.js 와 동일한 동작을 Express 에서 제공
// -------------------------------------------------------------
const CSV_KEY  = 'naver/latest.csv';
const META_KEY = 'naver/latest.meta.json';
const MAX_CSV_BYTES = 10 * 1024 * 1024;
const BLOB_ACCESS = 'private';

// CSV body parser (raw text)
app.use('/api/naver-csv', express.text({ type: '*/*', limit: '12mb' }));

async function loadBlobSdk() {
  try { return await import('@vercel/blob'); }
  catch { return null; }
}

// private blob 을 읽어 문자열로 반환. 없으면 null.
async function readBlobText(blob, pathname) {
  try {
    const result = await blob.get(pathname, { access: BLOB_ACCESS });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    return await new Response(result.stream).text();
  } catch (err) {
    if (err?.name === 'BlobNotFoundError') return null;
    console.error(`readBlobText(${pathname}) failed:`, err);
    return null;
  }
}

app.post('/api/naver-csv', async (req, res) => {
  const blob = await loadBlobSdk();
  if (!blob) return res.status(500).json({ error: '@vercel/blob 미설치' });
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(500).json({ error: 'BLOB_READ_WRITE_TOKEN 미설정 (.env.local 확인)' });
  }
  const csv = typeof req.body === 'string' ? req.body : '';
  if (!csv || csv.length < 10) return res.status(400).json({ error: 'empty CSV body' });
  if (csv.length > MAX_CSV_BYTES) return res.status(413).json({ error: 'file too large' });
  const fileName = String(req.query.fileName || 'naver.csv').slice(0, 200);
  const uploader = String(req.query.uploader || '').slice(0, 80);
  const uploadedAt = Date.now();
  try {
    await blob.put(CSV_KEY, csv, {
      access: BLOB_ACCESS,
      contentType: 'text/csv; charset=utf-8',
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 0,
    });
    const metaPayload = { fileName, uploader, uploadedAt, bytes: csv.length };
    await blob.put(META_KEY, JSON.stringify(metaPayload), {
      access: BLOB_ACCESS,
      contentType: 'application/json; charset=utf-8',
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 0,
    });
    res.json({ ok: true, ...metaPayload });
  } catch (err) {
    console.error('Blob upload failed:', err);
    res.status(500).json({ error: err.message || 'upload failed' });
  }
});

app.get('/api/naver-csv', async (req, res) => {
  const blob = await loadBlobSdk();
  if (!blob) return res.status(500).json({ error: '@vercel/blob 미설치' });
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(500).json({ error: 'BLOB_READ_WRITE_TOKEN 미설정 (.env.local 확인)' });
  }
  try {
    const [csvText, metaText] = await Promise.all([
      readBlobText(blob, CSV_KEY),
      readBlobText(blob, META_KEY),
    ]);
    if (!csvText) return res.json({ exists: false });
    let meta = null;
    if (metaText) { try { meta = JSON.parse(metaText); } catch {} }
    res.json({
      exists: true,
      fileName:   meta?.fileName   || 'naver.csv',
      uploader:   meta?.uploader   || '',
      uploadedAt: meta?.uploadedAt || null,
      bytes: csvText.length,
      csv: csvText,
    });
  } catch (err) {
    console.error('Blob fetch failed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/naver-csv', async (req, res) => {
  const blob = await loadBlobSdk();
  if (!blob) return res.status(500).json({ error: '@vercel/blob 미설치' });
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(500).json({ error: 'BLOB_READ_WRITE_TOKEN 미설정' });
  }
  try {
    const results = await Promise.allSettled([
      blob.del(CSV_KEY),
      blob.del(META_KEY),
    ]);
    res.json({ ok: true, results: results.map(r => r.status) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 통합 비교 메모 (Vercel Blob private store) — 로컬 개발용 프록시
// -------------------------------------------------------------
const MEMOS_KEY = 'cmp/memos.json';
const MAX_AUTHOR = 40;
const MAX_CONTENT = 2000;
const MAX_MEMOS = 500;

app.use('/api/cmp-memos', express.json({ limit: '256kb' }));

async function readMemosBlob(blob) {
  try {
    const result = await blob.get(MEMOS_KEY, { access: 'private' });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    const text = await new Response(result.stream).text();
    if (!text) return null;
    return JSON.parse(text);
  } catch (err) {
    if (err?.name === 'BlobNotFoundError') return null;
    return null;
  }
}
async function writeMemosBlob(blob, data) {
  await blob.put(MEMOS_KEY, JSON.stringify(data), {
    access: 'private',
    contentType: 'application/json; charset=utf-8',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 0,
  });
}
function sanitizeMemo(body) {
  const author  = String(body?.author  || '').trim().slice(0, MAX_AUTHOR);
  const content = String(body?.content || '').trim().slice(0, MAX_CONTENT);
  const rawDate = String(body?.appliedDate || '').trim();
  const appliedDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : null;
  return { author, content, appliedDate };
}
function newMemoId() {
  return `memo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

app.get('/api/cmp-memos', async (req, res) => {
  const blob = await loadBlobSdk();
  if (!blob) return res.status(500).json({ error: '@vercel/blob 미설치' });
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(500).json({ error: 'BLOB_READ_WRITE_TOKEN 미설정' });
  }
  const memos = (await readMemosBlob(blob)) || [];
  res.json({ memos: Array.isArray(memos) ? memos : [] });
});

app.post('/api/cmp-memos', async (req, res) => {
  const blob = await loadBlobSdk();
  if (!blob) return res.status(500).json({ error: '@vercel/blob 미설치' });
  const { author, content, appliedDate } = sanitizeMemo(req.body);
  if (!author) return res.status(400).json({ error: '작성자가 필요합니다.' });
  if (!content) return res.status(400).json({ error: '내용이 필요합니다.' });
  const list = (await readMemosBlob(blob)) || [];
  const arr = Array.isArray(list) ? list : [];
  const now = Date.now();
  const memo = { id: newMemoId(), author, content, appliedDate,
                 createdAt: now, updatedAt: now, edited: false };
  arr.unshift(memo);
  if (arr.length > MAX_MEMOS) arr.length = MAX_MEMOS;
  await writeMemosBlob(blob, arr);
  res.json({ ok: true, memo });
});

app.put('/api/cmp-memos', async (req, res) => {
  const blob = await loadBlobSdk();
  if (!blob) return res.status(500).json({ error: '@vercel/blob 미설치' });
  const id = String(req.query?.id || '');
  if (!id) return res.status(400).json({ error: 'id 가 필요합니다.' });
  const { author, content, appliedDate } = sanitizeMemo(req.body);
  if (!author) return res.status(400).json({ error: '작성자가 필요합니다.' });
  if (!content) return res.status(400).json({ error: '내용이 필요합니다.' });
  const list = (await readMemosBlob(blob)) || [];
  const arr = Array.isArray(list) ? list : [];
  const idx = arr.findIndex(m => m.id === id);
  if (idx < 0) return res.status(404).json({ error: '메모를 찾을 수 없습니다.' });
  arr[idx] = { ...arr[idx], author, content, appliedDate, updatedAt: Date.now(), edited: true };
  await writeMemosBlob(blob, arr);
  res.json({ ok: true, memo: arr[idx] });
});

app.delete('/api/cmp-memos', async (req, res) => {
  const blob = await loadBlobSdk();
  if (!blob) return res.status(500).json({ error: '@vercel/blob 미설치' });
  const id = String(req.query?.id || '');
  if (!id) {
    try { await blob.del(MEMOS_KEY); } catch {}
    return res.json({ ok: true, cleared: true });
  }
  const list = (await readMemosBlob(blob)) || [];
  const arr = Array.isArray(list) ? list : [];
  const next = arr.filter(m => m.id !== id);
  await writeMemosBlob(blob, next);
  res.json({ ok: true, removed: arr.length - next.length });
});

app.listen(PORT, () => {
  console.log(`카페 애드핏 대시보드 실행 중: http://localhost:${PORT}`);
});

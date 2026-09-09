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

// 카카오 애드핏 리포트 API.
//   v2 는 2026-09 종료(410 GONE)되어 v3 로 이전했다.
//   v3 스펙: GET ?apikey&fromDate&toDate&periodType(DAY|MONTH)
//     날짜 형식 yyyyMMdd | yyyy-MM-dd (MONTH 는 yyyyMM)
//     기간 제한 일 90일 / 월 12개월
//   응답 필드명이 v2 와 달라서(adRequestCount/winCount/impressionCount/…)
//   서버에서 v2 형식으로 정규화해 내려준다 → 프론트 수정 최소화.
const ADFIT_API_URL = 'https://adfit-external-api.kakao.com/publisher/v3/report';
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
// v3 응답을 v2 형식으로 정규화. (프론트가 기대하는 필드명 유지 + 신규 필드 추가)
//   reportDate '2026-09-08' → day '20260908'
//   adRequestCount → request / winCount → response
//   impressionCount → impression / clickCount → click
function normalizeAdfitV3(data) {
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  return {
    ...data,
    rows: rows.map(r => ({
      day:        String(r.reportDate || '').replace(/-/g, ''),
      adunitId:   r.adunitId,
      adunitName: r.adunitName,
      mediaId:    r.mediaId,
      mediaName:  r.mediaName,
      mediaUrl:   r.mediaUrl,
      request:    Number(r.adRequestCount) || 0,
      response:   Number(r.winCount) || 0,
      impression: Number(r.impressionCount) || 0,
      click:      Number(r.clickCount) || 0,
      profit:     Number(r.profit) || 0,
      // v3 신규 — 뷰어블 노출 및 애드핏이 계산해 주는 지표들
      viewableImpression: Number(r.viewableImpressionCount) || 0,
      fillRate:    Number(r.fillRate) || 0,
      winFillRate: Number(r.winFillRate) || 0,
      vr:          Number(r.vr) || 0,
      ctr:         Number(r.ctr) || 0,
      ecpm:        Number(r.ecpm) || 0,
    })),
  };
}

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

  const params = new URLSearchParams({
    apikey: API_KEY,
    periodType: periodType === 'M' ? 'MONTH' : 'DAY',
    fromDate: startDate,
    toDate: endDate,
  });
  const url = `${ADFIT_API_URL}?${params.toString()}`;

  const promise = (async () => {
    const response = await fetch(url);
    if (!response.ok) {
      const text = await response.text();
      const e = new Error(`API 오류: ${response.status} ${text}`);
      e.status = response.status;
      throw e;
    }
    return normalizeAdfitV3(await response.json());
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

// private blob 을 읽어 문자열로 반환.
//   - 진짜 파일이 없으면 null
//   - 503/5xx/429 같은 일시적 오류는 재시도하고, 끝까지 실패하면 throw
//
// 이전에는 일시적 오류도 null 로 뭉개서 API 가 {exists:false} 를 반환했다.
// 그래서 업로드는 정상인데 화면에 '업로드 없음' 으로 뜨는 문제가 있었다.
// (Vercel Blob 이 간헐적으로 503 을 낸다)
// ── 저장소 장애 대비 로컬 폴백 캐시 ────────────────────────────
//   Vercel Blob 의 private 다운로드 엔드포인트가 간헐적으로 503 을 낸다.
//   (list/head 는 되는데 get 만 실패하는 케이스 확인됨)
//   마지막으로 성공한 CSV/메타를 디스크에 저장해두고, 조회 실패 시 그걸 내려준다.
const FALLBACK_DIR = path.join(__dirname, '.cache');
const fallbackPath = key => path.join(FALLBACK_DIR, key.replace(/[\/]/g, '_'));
function saveFallback(key, text) {
  try {
    fs.mkdirSync(FALLBACK_DIR, { recursive: true });
    fs.writeFileSync(fallbackPath(key), text, 'utf8');
  } catch (e) { console.warn('fallback 저장 실패:', e.message); }
}
function readFallback(key) {
  try {
    const f = fallbackPath(key);
    if (!fs.existsSync(f)) return null;
    return { text: fs.readFileSync(f, 'utf8'), at: fs.statSync(f).mtimeMs };
  } catch { return null; }
}

const BLOB_RETRIES = 3;
function isTransientBlobError(err) {
  const m = String(err?.message || '');
  return /50\d|429|408|ECONN|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|aborted|timeout/i.test(m);
}
async function readBlobText(blob, pathname) {
  let lastErr = null;
  for (let i = 0; i < BLOB_RETRIES; i++) {
    try {
      const result = await blob.get(pathname, { access: BLOB_ACCESS });
      if (!result || result.statusCode !== 200 || !result.stream) return null;
      const text = await new Response(result.stream).text();
      saveFallback(pathname, text);   // 성공본 보관
      return text;
    } catch (err) {
      if (err?.name === 'BlobNotFoundError') return null;   // 진짜 없음
      lastErr = err;
      if (!isTransientBlobError(err) || i === BLOB_RETRIES - 1) break;
      const backoff = 300 * 2 ** i + Math.floor(Math.random() * 200);
      console.warn(`[blob][retry] ${pathname} ${i + 1}/${BLOB_RETRIES} (${err.message}) → ${backoff}ms 후 재시도`);
      await new Promise(r => setTimeout(r, backoff));
    }
  }
  console.error(`readBlobText(${pathname}) failed:`, lastErr);
  throw lastErr;   // 호출부가 '없음' 과 '실패' 를 구분할 수 있게
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
    saveFallback(CSV_KEY, csv);   // 업로드 직후 조회가 실패해도 버티도록
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
  // CSV 는 업로드하면 즉시 반영되어야 한다.
  //   Express 가 자동으로 붙이는 ETag 때문에 조건부 요청이 304 로 떨어지면
  //   브라우저/프록시가 옛 CSV 를 그대로 쓰게 된다. (Vercel 쪽 api/naver-csv.js 와 동일하게 맞춤)
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  req.app.set('etag', false);
  const blob = await loadBlobSdk();
  if (!blob) return res.status(500).json({ error: '@vercel/blob 미설치' });
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(500).json({ error: 'BLOB_READ_WRITE_TOKEN 미설정 (.env.local 확인)' });
  }
  try {
    // CSV 는 필수, meta 는 없어도 동작 → meta 실패는 무시한다.
    const [csvText, metaText] = await Promise.all([
      readBlobText(blob, CSV_KEY),
      readBlobText(blob, META_KEY).catch(() => null),
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
    // 여기로 오면 CSV 읽기가 재시도까지 실패한 것.
    // 마지막 성공본이 디스크에 있으면 그걸 내려준다 (stale 표시).
    console.error('Blob fetch failed:', err);
    const fb = readFallback(CSV_KEY);
    if (fb?.text) {
      let meta = null;
      const fbMeta = readFallback(META_KEY);
      if (fbMeta?.text) { try { meta = JSON.parse(fbMeta.text); } catch {} }
      console.warn(`[naver-csv] 저장소 실패 → 로컬 폴백본 사용 (${new Date(fb.at).toLocaleString('ko-KR')})`);
      return res.json({
        exists: true,
        stale: true,
        staleReason: `저장소 조회 실패(${err?.message || 'unknown'}) — 마지막 성공본으로 응답`,
        cachedAt: fb.at,
        fileName:   meta?.fileName   || 'naver.csv',
        uploader:   meta?.uploader   || '',
        uploadedAt: meta?.uploadedAt || null,
        bytes: fb.text.length,
        csv: fb.text,
      });
    }
    // {exists:false} 로 내리면 '업로드 없음' 으로 오해하니 명확히 에러로 알린다.
    res.status(503).json({ error: `저장소 조회 실패: ${err?.message || 'unknown'}`, transient: true });
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

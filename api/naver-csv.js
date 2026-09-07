/**
 * 네이버 CSV 공유 저장소 API (Vercel Node.js Serverless)
 *
 *   POST   /api/naver-csv?fileName=... &uploader=...
 *     body: CSV 텍스트 (Content-Type: text/csv)
 *     → Vercel Blob 에 저장 (고정 경로 `naver/latest.csv`)
 *     → 메타데이터(파일명·업로더·시각) 은 별도 JSON 으로 저장
 *
 *   GET    /api/naver-csv
 *     → { exists, fileName, uploadedAt, uploader, bytes, csv } 반환
 *
 *   DELETE /api/naver-csv
 *     → Blob + 메타 삭제
 *
 * ※ 이 프로젝트의 Blob 스토어는 **private access** 로 설정되어 있다.
 *    - put/get 에 `access: 'private'` 필수
 *    - 읽기는 서버리스 함수에서만 가능 (BLOB_READ_WRITE_TOKEN 필요)
 *    - 클라이언트는 이 API 를 프록시로 경유해서 접근
 *
 * ※ @vercel/blob 은 undici / node:stream 등 Node 전용 모듈을 사용하므로
 *    Edge Runtime 이 아닌 Node.js 서버리스 런타임(기본값) 에서 동작한다.
 */
import { put, get, del } from '@vercel/blob';

const CSV_KEY  = 'naver/latest.csv';
const META_KEY = 'naver/latest.meta.json';
const MAX_BYTES = 10 * 1024 * 1024; // 10MB
const ACCESS = 'private';

// Vercel Node 런타임은 Content-Type 에 따라 req.body 를 자동 파싱하지만,
// text/csv 는 Buffer/String/undefined 중 무엇이 올지 보장되지 않는다.
// → req.body 우선, 없으면 스트림에서 직접 읽는다.
async function readBodyAsString(req, maxBytes) {
  const b = req.body;
  if (typeof b === 'string') return b;
  if (Buffer.isBuffer(b)) return b.toString('utf8');
  if (b && typeof b === 'object') {
    try { return JSON.stringify(b); } catch { /* noop */ }
  }
  return await new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(Object.assign(new Error('file too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(Buffer.concat(chunks).toString('utf8')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// private blob 을 서버에서 읽어 문자열로 반환.
//   - 파일이 진짜 없으면 null
//   - 503/5xx/429 등 일시적 오류는 재시도하고, 끝까지 실패하면 throw
//
// 이전에는 일시적 오류도 null 로 처리해서 API 가 {exists:false} 를 반환했다.
// 그 결과 업로드는 됐는데 화면에는 '업로드 없음' 으로 뜨는 문제가 있었다.
const BLOB_RETRIES = 3;
function isTransientBlobError(err) {
  const m = String(err?.message || '');
  return /50\d|429|408|ECONN|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|aborted|timeout/i.test(m);
}
async function readBlobText(pathname) {
  let lastErr = null;
  for (let i = 0; i < BLOB_RETRIES; i++) {
    try {
      const result = await get(pathname, { access: ACCESS });
      if (!result || result.statusCode !== 200 || !result.stream) return null;
      return await new Response(result.stream).text();
    } catch (err) {
      if (err?.name === 'BlobNotFoundError') return null;   // 진짜 없음
      lastErr = err;
      if (!isTransientBlobError(err) || i === BLOB_RETRIES - 1) break;
      const backoff = 300 * 2 ** i + Math.floor(Math.random() * 200);
      console.warn(`[blob][retry] ${pathname} ${i + 1}/${BLOB_RETRIES} (${err.message})`);
      await new Promise(r => setTimeout(r, backoff));
    }
  }
  console.error(`readBlobText(${pathname}) failed:`, lastErr);
  throw lastErr;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.method === 'POST') {
      const fileName = String(req.query?.fileName || 'naver.csv').slice(0, 200);
      const uploader = String(req.query?.uploader || '').slice(0, 80);

      let csv;
      try {
        csv = await readBodyAsString(req, MAX_BYTES);
      } catch (e) {
        return res.status(e.status || 400).json({ error: e.message || 'invalid body' });
      }
      if (!csv || csv.length < 10) {
        return res.status(400).json({ error: 'empty or invalid CSV body' });
      }
      if (csv.length > MAX_BYTES) {
        return res.status(413).json({ error: `file too large (max ${MAX_BYTES} bytes)` });
      }

      const uploadedAt = Date.now();

      // CSV 본문 저장 (private 스토어)
      await put(CSV_KEY, csv, {
        access: ACCESS,
        contentType: 'text/csv; charset=utf-8',
        addRandomSuffix: false,
        allowOverwrite: true,
        cacheControlMaxAge: 0,
      });

      // 메타데이터 JSON 저장 (private 스토어)
      const metaPayload = { fileName, uploader, uploadedAt, bytes: csv.length };
      await put(META_KEY, JSON.stringify(metaPayload), {
        access: ACCESS,
        contentType: 'application/json; charset=utf-8',
        addRandomSuffix: false,
        allowOverwrite: true,
        cacheControlMaxAge: 0,
      });

      return res.status(200).json({ ok: true, ...metaPayload });
    }

    if (req.method === 'GET') {
      // CSV 는 필수, meta 는 없어도 동작 → meta 실패는 무시
      const [csvText, metaText] = await Promise.all([
        readBlobText(CSV_KEY),
        readBlobText(META_KEY).catch(() => null),
      ]);

      if (!csvText) return res.status(200).json({ exists: false });

      let meta = null;
      if (metaText) { try { meta = JSON.parse(metaText); } catch {} }

      return res.status(200).json({
        exists: true,
        fileName:   meta?.fileName   || 'naver.csv',
        uploader:   meta?.uploader   || '',
        uploadedAt: meta?.uploadedAt || null,
        bytes:      csvText.length,
        csv:        csvText,
      });
    }

    if (req.method === 'DELETE') {
      // del() 은 pathname 또는 URL 을 받음 — private 에서는 pathname 직접 전달
      const results = await Promise.allSettled([
        del(CSV_KEY),
        del(META_KEY),
      ]);
      return res.status(200).json({ ok: true, results: results.map(r => r.status) });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    console.error('naver-csv handler error:', err);
    // 저장소 일시 장애는 503 으로 명확히 구분해서 알린다.
    //   {exists:false} 로 내리면 클라이언트가 '업로드 없음' 으로 오해한다.
    if (isTransientBlobError(err)) {
      return res.status(503).json({ error: `저장소 조회 실패: ${err?.message || 'unknown'}`, transient: true });
    }
    return res.status(500).json({ error: err?.message || 'server error' });
  }
}

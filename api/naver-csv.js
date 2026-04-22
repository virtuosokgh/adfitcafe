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
 * ※ @vercel/blob 은 undici / node:stream 등 Node 전용 모듈을 사용하므로
 *    Edge Runtime 이 아닌 Node.js 서버리스 런타임(기본값) 에서 동작한다.
 *    ※ Vercel 은 config.runtime 에 "edge" | "experimental-edge" | "nodejs" 만 허용.
 *       버전 표기("nodejs20.x") 는 거부하므로 package.json engines 로 제어한다.
 */
import { put, head, del } from '@vercel/blob';

const CSV_KEY  = 'naver/latest.csv';
const META_KEY = 'naver/latest.meta.json';
const MAX_BYTES = 10 * 1024 * 1024; // 10MB

// head 는 존재하지 않으면 throw → 안전하게 null 로 변환
async function safeHead(pathname) {
  try { return await head(pathname); }
  catch { return null; }
}

// Vercel Node 런타임은 Content-Type 에 따라 req.body 를 자동 파싱하지만,
// text/csv 는 타입에 따라 Buffer/String/undefined 중 무엇이 올지 보장되지 않는다.
// → req.body 우선, 없으면 스트림에서 직접 읽는다.
async function readBodyAsString(req, maxBytes) {
  // 1) 이미 파싱된 body 가 있는 경우
  const b = req.body;
  if (typeof b === 'string') return b;
  if (Buffer.isBuffer(b)) return b.toString('utf8');
  if (b && typeof b === 'object') {
    // 의외의 JSON 파싱 결과 — 그대로 문자열화
    try { return JSON.stringify(b); } catch { /* noop */ }
  }
  // 2) 스트림에서 직접 읽기
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

      // CSV 본문 저장 (기존 파일 덮어쓰기)
      const csvBlob = await put(CSV_KEY, csv, {
        access: 'public',
        contentType: 'text/csv; charset=utf-8',
        addRandomSuffix: false,
        allowOverwrite: true,
        cacheControlMaxAge: 0,
      });

      // 메타데이터 JSON 저장
      const metaPayload = {
        fileName, uploader, uploadedAt, bytes: csv.length, csvUrl: csvBlob.url,
      };
      await put(META_KEY, JSON.stringify(metaPayload), {
        access: 'public',
        contentType: 'application/json; charset=utf-8',
        addRandomSuffix: false,
        allowOverwrite: true,
        cacheControlMaxAge: 0,
      });

      return res.status(200).json({ ok: true, ...metaPayload });
    }

    if (req.method === 'GET') {
      const metaHead = await safeHead(META_KEY);
      if (!metaHead) return res.status(200).json({ exists: false });

      let meta = null;
      try {
        const r = await fetch(metaHead.url, { cache: 'no-store' });
        if (r.ok) meta = await r.json();
      } catch {}

      const csvHead = await safeHead(CSV_KEY);
      if (!csvHead) return res.status(200).json({ exists: false });

      let csv = '';
      try {
        const r = await fetch(meta?.csvUrl || csvHead.url, { cache: 'no-store' });
        if (r.ok) csv = await r.text();
      } catch {}

      if (!csv) return res.status(200).json({ exists: false });

      return res.status(200).json({
        exists: true,
        fileName:   meta?.fileName   || 'naver.csv',
        uploader:   meta?.uploader   || '',
        uploadedAt: meta?.uploadedAt || null,
        bytes:      csv.length,
        csv,
      });
    }

    if (req.method === 'DELETE') {
      const results = await Promise.allSettled([
        (async () => { const h = await safeHead(CSV_KEY);  if (h?.url) await del(h.url); })(),
        (async () => { const h = await safeHead(META_KEY); if (h?.url) await del(h.url); })(),
      ]);
      return res.status(200).json({ ok: true, results: results.map(r => r.status) });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    console.error('naver-csv handler error:', err);
    return res.status(500).json({ error: err?.message || 'server error' });
  }
}

/**
 * 네이버 CSV 공유 저장소 API
 *
 *   POST   /api/naver-csv?fileName=... &uploader=...
 *     body: CSV 텍스트
 *     → Vercel Blob 에 저장 (고정 경로 `naver/latest.csv`)
 *     → 메타데이터(파일명·업로더·시각) 은 별도 JSON 으로 저장
 *
 *   GET    /api/naver-csv
 *     → { exists, fileName, uploadedAt, uploader, bytes, csv } 반환
 *
 *   DELETE /api/naver-csv
 *     → Blob + 메타 삭제
 *
 * 서버리스 함수가 꺼졌다 켜져도 Blob 은 영속 저장소(AWS S3 기반)라 모든 유저가 공유합니다.
 */
import { put, head, del } from '@vercel/blob';

export const config = { runtime: 'edge' };

const CSV_KEY  = 'naver/latest.csv';
const META_KEY = 'naver/latest.meta.json';

const MAX_BYTES = 10 * 1024 * 1024; // 10MB

function jsonResp(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

// head 는 존재하지 않으면 throw → 안전하게 null 로 변환
async function safeHead(pathname) {
  try { return await head(pathname); }
  catch { return null; }
}

export default async function handler(req) {
  try {
    if (req.method === 'POST') {
      const { searchParams } = new URL(req.url);
      const fileName = (searchParams.get('fileName') || 'naver.csv').slice(0, 200);
      const uploader = (searchParams.get('uploader') || '').slice(0, 80);

      const csv = await req.text();
      if (!csv || csv.length < 10) {
        return jsonResp({ error: 'empty or invalid CSV body' }, 400);
      }
      if (csv.length > MAX_BYTES) {
        return jsonResp({ error: `file too large (max ${MAX_BYTES} bytes)` }, 413);
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

      return jsonResp({ ok: true, ...metaPayload });
    }

    if (req.method === 'GET') {
      const metaHead = await safeHead(META_KEY);
      if (!metaHead) return jsonResp({ exists: false });

      let meta = null;
      try {
        const res = await fetch(metaHead.url, { cache: 'no-store' });
        if (res.ok) meta = await res.json();
      } catch {}

      // 메타가 깨졌거나 없으면 CSV 만이라도 가져오기
      const csvHead = await safeHead(CSV_KEY);
      if (!csvHead) return jsonResp({ exists: false });

      let csv = '';
      try {
        const res = await fetch(meta?.csvUrl || csvHead.url, { cache: 'no-store' });
        if (res.ok) csv = await res.text();
      } catch {}

      if (!csv) return jsonResp({ exists: false });

      return jsonResp({
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
      return jsonResp({ ok: true, results: results.map(r => r.status) });
    }

    return jsonResp({ error: 'method not allowed' }, 405, { Allow: 'GET, POST, DELETE' });
  } catch (err) {
    return jsonResp({ error: err?.message || 'server error' }, 500);
  }
}

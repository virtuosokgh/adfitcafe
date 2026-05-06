/**
 * 통합 비교 메모 API (Vercel Node.js Serverless, private Blob)
 *
 *   GET    /api/cmp-memos           → { memos: [...] }
 *   POST   /api/cmp-memos           body: { author, content }      → 새 메모 추가
 *   PUT    /api/cmp-memos?id=...    body: { author, content }      → 메모 수정 (edited=true)
 *   DELETE /api/cmp-memos?id=...                                   → 메모 삭제
 *
 * 저장 형식 (단일 JSON 파일 cmp/memos.json):
 *   [
 *     { id, author, content, createdAt, updatedAt, edited },
 *     ...
 *   ]
 *
 * - access: 'private' (스토어가 private 으로 생성되어 있음)
 * - 단순 array 라 동시쓰기 race condition 가능 — 운영 규모상 문제없는 수준
 */
import { put, get, del } from '@vercel/blob';

const MEMOS_KEY = 'cmp/memos.json';
const ACCESS = 'private';
const MAX_AUTHOR = 40;
const MAX_CONTENT = 2000;
const MAX_MEMOS = 500;

async function readJsonBlob(pathname) {
  try {
    const result = await get(pathname, { access: ACCESS });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    const text = await new Response(result.stream).text();
    if (!text) return null;
    return JSON.parse(text);
  } catch (err) {
    if (err?.name === 'BlobNotFoundError') return null;
    console.error(`readJsonBlob(${pathname}) failed:`, err);
    return null;
  }
}

async function writeJsonBlob(pathname, data) {
  await put(pathname, JSON.stringify(data), {
    access: ACCESS,
    contentType: 'application/json; charset=utf-8',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 0,
  });
}

async function readBodyJson(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  // stream 직접 읽기
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function sanitizeMemoFields(body) {
  const author = String(body?.author || '').trim().slice(0, MAX_AUTHOR);
  const content = String(body?.content || '').trim().slice(0, MAX_CONTENT);
  return { author, content };
}

function newId() {
  return `memo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.method === 'GET') {
      const memos = (await readJsonBlob(MEMOS_KEY)) || [];
      return res.status(200).json({ memos: Array.isArray(memos) ? memos : [] });
    }

    if (req.method === 'POST') {
      const body = await readBodyJson(req);
      const { author, content } = sanitizeMemoFields(body);
      if (!author) return res.status(400).json({ error: '작성자가 필요합니다.' });
      if (!content) return res.status(400).json({ error: '내용이 필요합니다.' });

      const list = (await readJsonBlob(MEMOS_KEY)) || [];
      const arr = Array.isArray(list) ? list : [];
      const now = Date.now();
      const memo = { id: newId(), author, content, createdAt: now, updatedAt: now, edited: false };
      arr.unshift(memo);                              // 최신이 위로
      if (arr.length > MAX_MEMOS) arr.length = MAX_MEMOS;
      await writeJsonBlob(MEMOS_KEY, arr);
      return res.status(200).json({ ok: true, memo });
    }

    if (req.method === 'PUT') {
      const id = String(req.query?.id || '');
      if (!id) return res.status(400).json({ error: 'id 가 필요합니다.' });
      const body = await readBodyJson(req);
      const { author, content } = sanitizeMemoFields(body);
      if (!author) return res.status(400).json({ error: '작성자가 필요합니다.' });
      if (!content) return res.status(400).json({ error: '내용이 필요합니다.' });

      const list = (await readJsonBlob(MEMOS_KEY)) || [];
      const arr = Array.isArray(list) ? list : [];
      const idx = arr.findIndex(m => m.id === id);
      if (idx < 0) return res.status(404).json({ error: '메모를 찾을 수 없습니다.' });
      const updated = { ...arr[idx], author, content, updatedAt: Date.now(), edited: true };
      arr[idx] = updated;
      await writeJsonBlob(MEMOS_KEY, arr);
      return res.status(200).json({ ok: true, memo: updated });
    }

    if (req.method === 'DELETE') {
      const id = String(req.query?.id || '');
      if (!id) {
        // id 없으면 전체 삭제 (운영 편의 — body 없는 단순 DELETE)
        try { await del(MEMOS_KEY); } catch {}
        return res.status(200).json({ ok: true, cleared: true });
      }
      const list = (await readJsonBlob(MEMOS_KEY)) || [];
      const arr = Array.isArray(list) ? list : [];
      const next = arr.filter(m => m.id !== id);
      await writeJsonBlob(MEMOS_KEY, next);
      return res.status(200).json({ ok: true, removed: arr.length - next.length });
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    console.error('cmp-memos handler error:', err);
    return res.status(500).json({ error: err?.message || 'server error' });
  }
}

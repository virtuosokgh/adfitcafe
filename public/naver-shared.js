/**
 * 네이버 CSV 공유 저장소 클라이언트 헬퍼
 *
 *   window.naverShared.fetchLatest()         → 서버 최신본 (없으면 null)
 *   window.naverShared.upload(file, csv)      → 서버에 업로드
 *   window.naverShared.remove()               → 서버에서 삭제
 *   window.naverShared.formatUploadedAt(ts)   → 업로드 시각 포맷
 *
 *  compare.js / naver.js 양쪽에서 공통 사용 — 업로드는 한 번만,
 *  다른 사용자도 동일 CSV 를 공유하도록 동작.
 */
(function () {
  'use strict';

  const API = '/api/naver-csv';

  // 최신 CSV 조회.
  //   반환: 정상 → { fileName, uploader, uploadedAt, bytes, csv }
  //         파일 없음 → null
  //         조회 실패 → { __error: true, status, message }
  //
  // Vercel Blob 이 간헐적으로 503 을 내므로 5xx/네트워크 오류는 재시도한다.
  // (재시도 없이 실패하면 화면에 '업로드 없음' 으로 떠서 업로드가 안 된 것처럼 보였음)
  async function fetchLatest() {
    const RETRIES = 3;
    let lastMsg = '', lastStatus = 0;
    for (let i = 0; i < RETRIES; i++) {
      try {
        const res = await fetch(API, { cache: 'no-store' });
        if (res.ok) {
          const j = await res.json();
          if (!j.exists) return null;         // 진짜 업로드 없음
          return j;
        }
        lastStatus = res.status;
        try { lastMsg = (await res.json())?.error || `HTTP ${res.status}`; }
        catch { lastMsg = `HTTP ${res.status}`; }
        if (res.status < 500 && res.status !== 429) break;   // 재시도 의미 없는 오류
      } catch (e) {
        lastMsg = e?.message || 'network error';
      }
      if (i < RETRIES - 1) {
        const backoff = 400 * 2 ** i + Math.floor(Math.random() * 200);
        console.warn(`[naver-csv][retry] ${i + 1}/${RETRIES} (${lastMsg}) → ${backoff}ms`);
        await new Promise(r => setTimeout(r, backoff));
      }
    }
    console.error('naver CSV 조회 실패:', lastMsg);
    return { __error: true, status: lastStatus, message: lastMsg };
  }

  async function upload(file, csvText) {
    const fileName = file?.name || 'naver.csv';
    const uploader = localStorage.getItem('naver_uploader_name') || '';
    const qs = new URLSearchParams({ fileName, uploader });
    const res = await fetch(`${API}?${qs.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv; charset=utf-8' },
      body: csvText,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `서버 업로드 실패 (${res.status})`);
    }
    return await res.json();
  }

  async function remove() {
    try {
      const res = await fetch(API, { method: 'DELETE' });
      return res.ok;
    } catch {
      return false;
    }
  }

  function formatUploadedAt(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d)) return '';
    return d.toLocaleString('ko-KR', {
      month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  }

  window.naverShared = { fetchLatest, upload, remove, formatUploadedAt };
})();

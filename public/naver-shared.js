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

  async function fetchLatest() {
    try {
      const res = await fetch(API, { cache: 'no-store' });
      if (!res.ok) return null;
      const j = await res.json();
      if (!j.exists) return null;
      return j;    // { fileName, uploader, uploadedAt, bytes, csv }
    } catch {
      return null;
    }
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

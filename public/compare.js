/* ================================================================
 *  통합 비교 대시보드 (카카오/구글/네이버 카페 수익)
 *  - 기간 탭 (일/주/월)
 *  - 플랫폼별 유닛 필터 (MCS)
 *  - 네이버 CSV 업로드 (컴팩트)
 * ================================================================ */
(function () {
  'use strict';

  // 네이버 캐시 키는 naver.js와 통일 (한 곳에서 업로드하면 전역 유지)
  const CMP_NAVER_CACHE_KEY = 'naver_csv_cache';
  const KAKAO_RE  = /(카페|테이블|cafe)/i;
  const GOOGLE_RE = /카페|cafe/i;
  // 네이버 서브타입: 한글 '카페' → SA, 영문 'cafe' → DA
  const NAVER_SA_RE = /카페/;
  const NAVER_DA_RE = /cafe/i;

  // 상태
  let cmpPeriod = 'daily';
  let cmpRawRows = [];         // 서버 응답 원본을 합친 것 (platform/unit/date/impression/click/profit)
  let cmpSortState = { col: 'unit', dir: 'asc' };
  let cmpTrendChart = null;
  let cmpPieChart   = null;
  let cmpChartMetric = 'profit';   // profit | request | impression | reqEcpm | impEcpm
  let cmpCurrentRange = { start: '', end: '' };  // 일평균 계산용

  // 플랫폼 메타 (색상/라벨/mcs 그룹)
  const PLATFORMS = [
    { key: 'kakao',   label: '🟡 다음(카카오)', color: '#FBB034' },
    { key: 'google',  label: '🔵 구글',         color: '#1A73E8' },
    { key: 'naverSA', label: '🟢 네이버 SA',    color: '#03C75A' },   // 네이버 시그니처 그린
    { key: 'naverDA', label: '🟪 네이버 DA',    color: '#A855F7' },   // 퍼플 — SA 와 명확히 구분
  ];

  // 클라이언트 캐시 — localStorage 로 영구 저장 (TTL 없음, 명시적 조회 시에만 재조회)
  // v2: request 필드 추가됨 → v1 캐시는 자동 무시
  const PERSIST_CACHE_KEY = 'cmp_fetch_cache_v2';
  const CACHE_MAX_ENTRIES = 5;   // 기간별 최대 5개 유지 (오래된 것 퇴출)
  const clientCache = new Map(); // key(start-end) → { kRows, gRows, at }
  loadPersistCache();

  function loadPersistCache() {
    try {
      const raw = localStorage.getItem(PERSIST_CACHE_KEY);
      if (!raw) return;
      const obj = JSON.parse(raw);
      for (const [k, v] of Object.entries(obj || {})) {
        if (v && Array.isArray(v.kRows) && Array.isArray(v.gRows)) clientCache.set(k, v);
      }
    } catch { /* 손상된 캐시 무시 */ }
  }
  function savePersistCache() {
    try {
      // 최근 entry N개만 유지 (LRU-ish)
      const entries = Array.from(clientCache.entries())
        .sort(([, a], [, b]) => (b.at || 0) - (a.at || 0))
        .slice(0, CACHE_MAX_ENTRIES);
      clientCache.clear();
      entries.forEach(([k, v]) => clientCache.set(k, v));
      localStorage.setItem(PERSIST_CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch { /* quota 초과 시 무시 */ }
  }

  // MCS 인스턴스
  let mcsK, mcsG, mcsN;

  // flatpickr
  let fpStartD, fpEndD, fpStartW, fpEndW, fpStartM, fpEndM;

  // 유틸
  const krw = n => Math.round(Number(n) || 0).toLocaleString('ko-KR') + '원';
  const num = n => (Number(n) || 0).toLocaleString('ko-KR');
  const pct = n => (Number(n) || 0).toFixed(2) + '%';
  const today = () => new Date();

  // ──────────────────────────────────────────────
  // 초기화 (compare 탭 첫 진입 시에만)
  // ──────────────────────────────────────────────
  let inited = false;
  function initOnce() {
    if (inited) return;
    inited = true;

    const now = today();
    const weekAgo = new Date(); weekAgo.setDate(now.getDate() - 7);

    // 일별
    fpStartD = flatpickr('#cmp-start-d', {
      dateFormat: 'Y-m-d', locale: 'ko', defaultDate: weekAgo,
      onChange: d => { if (d[0]) { fpEndD.set('minDate', d[0]); fpEndD.open(); } },
    });
    fpEndD = flatpickr('#cmp-end-d', { dateFormat: 'Y-m-d', locale: 'ko', defaultDate: now });

    // 주별
    fpStartW = flatpickr('#cmp-start-w', {
      dateFormat: 'Y-m-d', locale: 'ko', defaultDate: weekAgo,
      onChange: d => { if (d[0]) { fpEndW.set('minDate', d[0]); fpEndW.open(); } },
    });
    fpEndW = flatpickr('#cmp-end-w', { dateFormat: 'Y-m-d', locale: 'ko', defaultDate: now });

    // 월별
    const monthDefault = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    fpStartM = flatpickr('#cmp-start-m', {
      dateFormat: 'Y-m', locale: 'ko', defaultDate: monthDefault,
      onChange: d => { if (d[0]) { fpEndM.set('minDate', d[0]); fpEndM.open(); } },
    });
    fpEndM = flatpickr('#cmp-end-m', { dateFormat: 'Y-m', locale: 'ko', defaultDate: now });

    // 기간 탭
    document.querySelectorAll('#cmp-period-tabs .tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        cmpPeriod = btn.dataset.cmpPeriod;
        document.querySelectorAll('#cmp-period-tabs .tab-btn').forEach(b =>
          b.classList.toggle('active', b === btn));
        ['daily', 'weekly', 'monthly'].forEach(p =>
          document.getElementById(`cmp-date-range-${p}`)
            ?.classList.toggle('hidden', p !== cmpPeriod));
      });
    });

    // MCS 초기화 (빈 상태)
    mcsK = new MultiCheckSelect(document.getElementById('cmp-mcs-kakao'),  '전체 카카오 유닛', () => renderAll());
    mcsG = new MultiCheckSelect(document.getElementById('cmp-mcs-google'), '전체 구글 유닛',   () => renderAll());
    mcsN = new MultiCheckSelect(document.getElementById('cmp-mcs-naver'),  '전체 네이버 유닛', () => renderAll());

    // 업로드 버튼
    const fileInput = document.getElementById('cmp-naver-csv');
    document.getElementById('cmp-naver-upload-btn').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', handleNaverUpload);
    document.getElementById('cmp-naver-reset-btn').addEventListener('click', async () => {
      const confirmMsg =
        '⚠️ 서버에 업로드된 공유 CSV를 삭제합니다.\n' +
        '모든 사용자에게 영향을 줍니다. 계속할까요?';
      if (!confirm(confirmMsg)) return;
      try { if (window.naverShared) await window.naverShared.remove(); } catch {}
      window.naverAllRows = [];
      try { localStorage.removeItem(CMP_NAVER_CACHE_KEY); } catch {}
      syncNaverStatus();
      if (cmpRawRows.length) renderAll();
      // 네이버 탭도 클리어 (해당 탭이 있을 때만)
      if (typeof window.naverReloadFromShared === 'function') {
        try { window.naverReloadFromShared(); } catch {}
      }
    });

    // 조회 버튼 — 항상 최신 데이터 재조회 (캐시 무시)
    document.getElementById('cmp-search-btn').addEventListener('click', () => fetchAndRender({ force: true }));

    // 테이블 헤더 정렬
    document.querySelectorAll('#cmp-table thead th').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.col;
        if (!col) return;
        if (cmpSortState.col === col) cmpSortState.dir = cmpSortState.dir === 'asc' ? 'desc' : 'asc';
        else { cmpSortState.col = col; cmpSortState.dir = 'desc'; }
        if (cmpRawRows.length) renderAll();
      });
    });

    // CSV 다운로드
    document.getElementById('cmp-csv-btn').addEventListener('click', downloadCsv);

    // 카드 — 일평균 토글 + 숫자 클릭 복사 (이벤트 위임)
    const summaryEl = document.getElementById('cmp-summary');
    if (summaryEl) {
      summaryEl.addEventListener('click', e => {
        // 일평균 토글
        const toggleBtn = e.target.closest('[data-avg-toggle]');
        if (toggleBtn) {
          const card = toggleBtn.closest('.cmp-card');
          if (card) {
            const on = card.dataset.avg === '1';
            card.dataset.avg = on ? '0' : '1';
            toggleBtn.classList.toggle('on', !on);
            if (cmpRawRows.length) renderSummary(applyUnitFilter(cmpRawRows));
          }
          return;
        }
        // 숫자 복사
        const copyEl = e.target.closest('.cmp-copy');
        if (copyEl) {
          copyCardValue(copyEl);
          return;
        }
      });
    }

    // 차트 지표 드롭다운
    const chartMetricSel = document.getElementById('cmp-chart-metric');
    if (chartMetricSel) {
      chartMetricSel.addEventListener('change', () => {
        cmpChartMetric = chartMetricSel.value;
        if (cmpRawRows.length) renderTrendChart(applyUnitFilter(cmpRawRows));
      });
    }

    // 네이버 CSV 복원 (서버 → 로컬 fallback, async)
    //   서버 로드가 끝나면 자동 조회 → MCS 채우기 (네이버 포함된 결과)
    (async () => {
      await loadNaverFromCache();
      // flatpickr 가 defaultDate 를 input 에 반영할 시간을 줌
      setTimeout(() => fetchAndRender(), 50);
    })();
  }

  // 카드 숫자만 추출해 클립보드에 복사 + 짧은 피드백
  function copyCardValue(el) {
    const raw = el.dataset.raw;
    const text = (raw !== undefined && raw !== '')
      ? String(raw)
      : String(el.textContent || '').replace(/[^\d.-]/g, '');
    if (!text || text === '-') return;
    const done = () => {
      el.classList.add('copied');
      setTimeout(() => el.classList.remove('copied'), 700);
    };
    try {
      navigator.clipboard?.writeText(text).then(done, done);
    } catch { done(); }
  }

  // 탭 클릭 시 초기화
  document.addEventListener('click', e => {
    const btn = e.target.closest('.pnav-btn[data-pnav="compare"]');
    if (btn) initOnce();
  });
  // 통합 비교가 디폴트(HTML에 active 클래스) 또는 localStorage 에 저장된 상태면 자동 초기화
  const compareBtn = document.querySelector('.pnav-btn[data-pnav="compare"]');
  const shouldAutoInit =
    (compareBtn && compareBtn.classList.contains('active')) ||
    localStorage.getItem('pnav_active') === 'compare';
  if (shouldAutoInit) {
    if (document.readyState === 'loading')
      document.addEventListener('DOMContentLoaded', initOnce);
    else
      initOnce();
  }

  // ──────────────────────────────────────────────
  // 네이버 CSV 업로드
  // ──────────────────────────────────────────────
  function handleNaverUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async ev => {
      try {
        const csv = ev.target.result;
        const rows = parseNaverCsv(csv);
        if (!rows.length) throw new Error('카페 매체 행이 없습니다.');

        // 업로드 상태 표시
        const statusEl = document.getElementById('cmp-naver-status');
        if (statusEl) statusEl.textContent = `📤 ${file.name} 공유 업로드 중...`;

        // 서버에 공유 업로드
        let uploadedAt = Date.now();
        try {
          if (window.naverShared) {
            const meta = await window.naverShared.upload(file, csv);
            if (meta?.uploadedAt) uploadedAt = meta.uploadedAt;
          }
        } catch (err) {
          alert('⚠️ 서버 공유 업로드 실패: ' + err.message + '\n(내 브라우저에는 저장되었지만 다른 사용자와 공유되지 않을 수 있음)');
        }

        window.naverAllRows = rows;
        try {
          localStorage.setItem(CMP_NAVER_CACHE_KEY, JSON.stringify({
            fileName: file.name, uploadedAt, rows, csv
          }));
        } catch {}
        syncNaverStatus(file.name, uploadedAt, 'server');

        // 이미 조회 결과가 있으면 리렌더
        if (cmpRawRows.length) renderAll();

        // 네이버 탭도 최신본으로 갱신
        if (typeof window.naverReloadFromShared === 'function') {
          try { window.naverReloadFromShared(); } catch {}
        }
      } catch (err) {
        alert('CSV 파싱 실패: ' + err.message);
        syncNaverStatus();
      }
    };
    reader.readAsText(file, 'utf-8');
    // 같은 파일 재선택 가능하도록
    e.target.value = '';
  }

  // 서버 Vercel Blob 에서 최신 CSV 가져오기 (모든 유저 공유)
  async function loadFromServer() {
    if (!window.naverShared) return false;
    const data = await window.naverShared.fetchLatest();
    if (!data || !data.csv) return false;
    const fresh = parseNaverCsv(data.csv);
    if (!fresh.length) return false;
    window.naverAllRows = fresh;
    // 로컬에도 싱크 (오프라인 fallback)
    try {
      localStorage.setItem(CMP_NAVER_CACHE_KEY, JSON.stringify({
        fileName: data.fileName,
        uploadedAt: data.uploadedAt,
        rows: fresh,
        csv: data.csv,
      }));
    } catch {}
    syncNaverStatus(data.fileName, data.uploadedAt, 'server');
    return true;
  }

  function loadFromLocalCache() {
    try {
      // 구버전 키에서 신버전 키로 1회 마이그레이션 (기존 업로드 유지)
      const LEGACY_KEY = 'naver_csv_cache_v1';
      if (!localStorage.getItem(CMP_NAVER_CACHE_KEY)) {
        const legacy = localStorage.getItem(LEGACY_KEY);
        if (legacy) {
          localStorage.setItem(CMP_NAVER_CACHE_KEY, legacy);
          localStorage.removeItem(LEGACY_KEY);
        }
      }
      const raw = localStorage.getItem(CMP_NAVER_CACHE_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.csv === 'string' && parsed.csv.length) {
        const fresh = parseNaverCsv(parsed.csv);
        if (fresh.length) {
          window.naverAllRows = fresh;
          try {
            localStorage.setItem(CMP_NAVER_CACHE_KEY, JSON.stringify({ ...parsed, rows: fresh }));
          } catch {}
          syncNaverStatus(parsed.fileName, parsed.uploadedAt, 'local');
          return true;
        }
      }
      const { rows } = parsed;
      if (Array.isArray(rows) && rows.length) {
        window.naverAllRows = rows;
        syncNaverStatus(parsed.fileName, parsed.uploadedAt, 'local');
        return true;
      }
    } catch {}
    return false;
  }

  async function loadNaverFromCache() {
    const ok = await loadFromServer();
    if (ok) return;
    if (loadFromLocalCache()) return;
    syncNaverStatus();
  }

  // naver.js 에서 업로드했을 때 compare 탭도 자동 갱신되도록 global 등록
  window.cmpReloadNaverFromShared = async () => {
    await loadFromServer();
    if (cmpRawRows.length) renderAll();
  };

  // 탭 활성화 시 서버 최신본 재조회
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    loadFromServer().then(ok => { if (ok && cmpRawRows.length) renderAll(); }).catch(() => {});
  });

  function syncNaverStatus(fileName, uploadedAt, source) {
    const rows = window.naverAllRows || [];
    const statusEl = document.getElementById('cmp-naver-status');
    const resetBtn = document.getElementById('cmp-naver-reset-btn');
    if (rows.length > 0) {
      const timeStr = window.naverShared?.formatUploadedAt(uploadedAt) || '';
      const tag = source === 'server' ? '🌐 공유' : '💾 로컬';
      statusEl.textContent = fileName
        ? `✅ ${fileName} (${rows.length}건) · ${tag}${timeStr ? ' ' + timeStr : ''}`
        : `✅ 네이버 데이터 ${rows.length}건 · ${tag}${timeStr ? ' ' + timeStr : ''}`;
      statusEl.classList.add('has-data');
      resetBtn.classList.remove('hidden');
    } else {
      statusEl.textContent = '업로드 없음 → 카카오+구글만 비교됩니다';
      statusEl.classList.remove('has-data');
      resetBtn.classList.add('hidden');
    }
  }

  function parseNaverCsv(csv) {
    const lines = csv.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return [];
    const headers = splitCsv(lines[0]);
    // 공백/대소문자 변형에 관대하게 — 정확히 일치 → 공백 제거 매칭 → 부분 포함 매칭 순
    const idx = (...cands) => {
      for (const name of cands) {
        const i = headers.indexOf(name);
        if (i >= 0) return i;
      }
      const normed = headers.map(h => (h || '').replace(/\s+/g, '').toLowerCase());
      for (const name of cands) {
        const t = name.replace(/\s+/g, '').toLowerCase();
        const i = normed.indexOf(t);
        if (i >= 0) return i;
      }
      for (const name of cands) {
        const t = name.replace(/\s+/g, '').toLowerCase();
        const i = normed.findIndex(h => h.includes(t));
        if (i >= 0) return i;
      }
      return -1;
    };
    const iDate  = idx('날짜', '일자');
    const iId    = idx('광고ID', '광고 ID', '광고아이디');
    const iMedia = idx('매체', '매체명', '미디어');
    const iReq   = idx('요청수', '요청');
    const iImp   = idx('노출수', '노출');
    const iClk   = idx('클릭수', '클릭');
    const iPrf   = idx('AXZ매출(원)', 'AXZ매출', '매출', '수익');
    const iCtr   = idx('CTR(%)', 'CTR');
    console.log('[parseNaverCsv] headers:', headers);
    console.log('[parseNaverCsv] col idx:', { iDate, iId, iMedia, iReq, iImp, iClk, iPrf });
    const pn = s => {
      const v = Number(String(s || '').replace(/[,\s]/g, ''));
      return isNaN(v) ? 0 : v;
    };
    const out = [];
    const skippedExamples = [];
    let totalScanned = 0, matched = 0;
    for (let i = 1; i < lines.length; i++) {
      const c = splitCsv(lines[i]);
      const media = (c[iMedia] || '').trim();
      const adId  = (c[iId]    || '').trim();
      totalScanned++;
      // 광고ID 또는 매체에 '카페' / 'cafe' 가 포함된 행 (대소문자 무관)
      if (!/카페|cafe/i.test(adId + ' ' + media)) {
        if (skippedExamples.length < 3 && (adId || media)) {
          skippedExamples.push({ adId, media });
        }
        continue;
      }
      matched++;
      let date = (c[iDate] || '').trim();
      const isMonthly = date.endsWith('-00');
      if (isMonthly) date = date.slice(0, 7);
      out.push({
        date, isMonthly, adId, media,
        request: pn(c[iReq]), impression: pn(c[iImp]),
        click: pn(c[iClk]), profit: pn(c[iPrf]), ctr: pn(c[iCtr]),
      });
    }
    console.log(`[parseNaverCsv] scanned=${totalScanned}, cafe/카페 matched=${matched}`);
    // cafe_* 광고ID 유니크 목록
    const cafeAdIds = [...new Set(out.map(r => r.adId).filter(id => /cafe/i.test(id)))];
    console.log('[parseNaverCsv] cafe_* 광고ID 유니크:', cafeAdIds);
    if (!matched && skippedExamples.length) {
      console.warn('[parseNaverCsv] 매칭 0건. 스킵 예시:', skippedExamples);
    }
    return out;
  }

  function splitCsv(line) {
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i+1] === '"') { cur += '"'; i++; }
        else if (ch === '"') q = false;
        else cur += ch;
      } else {
        if (ch === ',') { out.push(cur); cur = ''; }
        else if (ch === '"') q = true;
        else cur += ch;
      }
    }
    out.push(cur);
    return out;
  }

  // ──────────────────────────────────────────────
  // 기간 → YYYYMMDD 범위
  // ──────────────────────────────────────────────
  function getDateRange() {
    if (cmpPeriod === 'daily') {
      return { start: document.getElementById('cmp-start-d').value, end: document.getElementById('cmp-end-d').value };
    }
    if (cmpPeriod === 'weekly') {
      // 주 시작(월요일) ~ 주 끝(일요일)으로 보정
      const toMonday = s => {
        const d = new Date(s);
        const dow = d.getDay(); // 0=일, 1=월,...
        const diff = dow === 0 ? -6 : 1 - dow;
        d.setDate(d.getDate() + diff);
        return d.toISOString().slice(0,10);
      };
      const toSunday = s => {
        const d = new Date(toMonday(s));
        d.setDate(d.getDate() + 6);
        return d.toISOString().slice(0,10);
      };
      const s = document.getElementById('cmp-start-w').value;
      const e = document.getElementById('cmp-end-w').value;
      if (!s || !e) return { start: '', end: '' };
      return { start: toMonday(s), end: toSunday(e) };
    }
    // monthly
    const s = document.getElementById('cmp-start-m').value;
    const e = document.getElementById('cmp-end-m').value;
    if (!s || !e) return { start: '', end: '' };
    const [sy, sm] = s.split('-');
    const [ey, em] = e.split('-');
    const lastDay = new Date(Number(ey), Number(em), 0).getDate();
    return { start: `${sy}-${sm}-01`, end: `${ey}-${em}-${String(lastDay).padStart(2,'0')}` };
  }

  const toYYYYMMDD = s => (s || '').replace(/-/g, '');

  // ──────────────────────────────────────────────
  // 데이터 조회 (3개 플랫폼 병렬)
  // ──────────────────────────────────────────────
  // 카카오 응답 → 표준 행
  //   unit = adunitId (예: "DAN-0DM6xroBT6yPi5Xg") 로 식별
  //   adunitName은 부가정보로 유지
  function mapKakaoRows(j) {
    const out = [];
    for (const r of (j.rows || [])) {
      if (!KAKAO_RE.test(r.adunitName || '')) continue;
      const d = r.day || r.date || '';
      const dateIso = /^\d{8}$/.test(d)
        ? `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`
        : d;
      out.push({
        platform: 'kakao',
        unit: r.adunitId || r.adunitName,   // Unit ID 사용
        name: r.adunitName,                  // 원본 유닛명 (표시용)
        date: dateIso,
        request: Number(r.request || 0),
        impression: Number(r.impression || 0),
        click: Number(r.click || 0),
        profit: Number(r.profit || 0),
      });
    }
    return out;
  }

  // 구글 유닛명 정리:
  //   "다음카페 (23342086396) » 카페앱 안드로이드 (23342089273) » 카페 안드로이드 인기글 광고2 (23342432824)"
  //   → "카페앱 안드로이드 » 카페 안드로이드 인기글 광고2"
  function cleanGoogleUnit(name) {
    return String(name)
      .split('»')
      .map(s => s.replace(/\s*\(\d+\)\s*$/, '').trim())   // (ID) 제거
      .filter(Boolean)
      .filter(s => s !== '다음카페')                          // 최상위 "다음카페" prefix 제거
      .join(' » ');
  }

  // 구글 응답 → 표준 행
  function mapGoogleRows(j) {
    const out = [];
    const headers = j.headers || [];
    const cDate = headers.find(h => /DATE/i.test(h));
    const cName = headers.find(h => /AD_UNIT_NAME/i.test(h));
    const cReq  = headers.find(h => /TOTAL_AD_REQUESTS/i.test(h)) || headers.find(h => /AD_REQUESTS/i.test(h));
    const cImp  = headers.find(h => /TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS/i.test(h)) || headers.find(h => /IMPRESSIONS/i.test(h));
    const cClk  = headers.find(h => /TOTAL_LINE_ITEM_LEVEL_CLICKS/i.test(h)) || headers.find(h => /CLICKS/i.test(h));
    const cRev  = headers.find(h => /TOTAL_LINE_ITEM_LEVEL_CPM_AND_CPC_REVENUE/i.test(h)) || headers.find(h => /REVENUE/i.test(h));
    for (const r of (j.rows || [])) {
      const rawUnit = r[cName] || '';
      if (!GOOGLE_RE.test(rawUnit)) continue;
      // 최상위 "다음카페 (XXXXX)" 단독 유닛은 제외 (하위 경로 » 없는 것)
      if (!rawUnit.includes('»')) continue;
      const unit = cleanGoogleUnit(rawUnit);
      if (!unit) continue;
      let profit = Number(r[cRev] || 0);
      if (profit >= 1000) profit = profit / 1e6;  // micros → 원
      out.push({
        platform: 'google',
        unit,
        date: r[cDate] || '',
        request: cReq ? Number(r[cReq] || 0) : 0,
        impression: Number(r[cImp] || 0),
        click: Number(r[cClk] || 0),
        profit,
      });
    }
    return out;
  }

  function mapNaverRows(start, end) {
    const out = [];
    // 1차 분류 + 범위 체크 (월/일 구분)
    const classify = (adId, media) => {
      if (NAVER_DA_RE.test(adId))   return 'naverDA';
      if (NAVER_SA_RE.test(adId))   return 'naverSA';
      if (NAVER_DA_RE.test(media))  return 'naverDA';
      if (NAVER_SA_RE.test(media))  return 'naverSA';
      return null;
    };
    const inDaily = (r) => !r.isMonthly && r.date >= start && r.date <= end;
    const inMonth = (r) => {
      if (!r.isMonthly) return false;
      const sm = (start || '').slice(0, 7);
      const em = (end   || '').slice(0, 7);
      return r.date >= sm && r.date <= em;
    };
    // 월단위 이중합산 방지: 같은 (월, 광고ID) 조합에 일단위 행이 있으면 월단위 행은 버림.
    //   (네이버는 일단위 + 월집계 행을 동시에 내보내는 경우가 있음)
    const dailyKeys = new Set();
    for (const r of (window.naverAllRows || [])) {
      if (r.isMonthly) continue;
      if (!inDaily(r)) continue;
      dailyKeys.add((r.adId || r.media) + '|' + r.date.slice(0, 7));
    }
    const rangeIsWholeMonth = (() => {
      if (!start || !end) return false;
      const s = new Date(start), e = new Date(end);
      if (isNaN(s) || isNaN(e)) return false;
      if (s.getFullYear() !== e.getFullYear() || s.getMonth() !== e.getMonth()) return false;
      return s.getDate() === 1 && e.getDate() === new Date(e.getFullYear(), e.getMonth() + 1, 0).getDate();
    })();

    // 진단 집계
    const diag = new Map();
    const touch = (adId) => {
      const key = adId || '(no-adId)';
      let d = diag.get(key);
      if (!d) { d = { total: 0, pass: 0, skipPlatform: 0, skipDate: 0, skipDupMonth: 0, dates: new Set() }; diag.set(key, d); }
      return d;
    };
    let sumSA = 0, sumDA = 0;

    for (const r of (window.naverAllRows || [])) {
      const media = r.media || '';
      const adId  = r.adId  || '';
      const d = touch(adId);
      d.total++;
      d.dates.add(r.date + (r.isMonthly ? '(M)' : ''));
      const platform = classify(adId, media);
      if (!platform) { d.skipPlatform++; continue; }
      // 날짜 범위 체크
      if (r.isMonthly) {
        if (!inMonth(r)) { d.skipDate++; continue; }
        // 월단위 행은 "기간이 해당 월 전체를 정확히 덮고, 같은 달에 일단위 행이 없을 때"만 포함
        //   → 부분 범위(예: 단일 일자) 조회 시 월집계를 부분 합에 더해버리는 중복합산을 방지
        const monthKey = (adId || media) + '|' + r.date;
        if (dailyKeys.has(monthKey) || !rangeIsWholeMonth) { d.skipDupMonth++; continue; }
      } else {
        if (!inDaily(r)) { d.skipDate++; continue; }
      }
      d.pass++;
      const profit = Number(r.profit || 0);
      if (platform === 'naverSA') sumSA += profit;
      else sumDA += profit;
      const unit = adId || media;
      out.push({
        platform,
        unit,
        date: r.date,
        request:    Number(r.request    || 0),
        impression: Number(r.impression || 0),
        click:      Number(r.click      || 0),
        profit,
      });
    }
    // 진단 로그
    try {
      const table = [];
      for (const [adId, d] of diag.entries()) {
        if (!/카페|cafe/i.test(adId)) continue;
        table.push({
          adId,
          총행수: d.total,
          통과: d.pass,
          '스킵(플랫폼)': d.skipPlatform,
          '스킵(날짜)': d.skipDate,
          '스킵(월중복)': d.skipDupMonth,
          dates: [...d.dates].slice(0, 5).join(', ') + (d.dates.size > 5 ? ` …+${d.dates.size-5}` : ''),
        });
      }
      console.log(`[mapNaverRows] range=${start}~${end} | SA=${sumSA.toLocaleString()}원  DA=${sumDA.toLocaleString()}원  (월전체기간=${rangeIsWholeMonth})`);
      if (table.length) console.table(table);
    } catch {}
    return out;
  }

  // 귀여운 로딩 UI 상태 제어
  function setCuteState(platform, state, msg) {
    const el = document.querySelector(`.cute-char[data-plat="${platform}"]`);
    if (!el) return;
    el.dataset.state = state;
    const statusEl = el.querySelector('.cute-status');
    if (statusEl && msg !== undefined) statusEl.textContent = msg;
  }
  function resetCuteStates() {
    ['kakao', 'google', 'naver'].forEach(p => setCuteState(p, 'loading', '조회 중'));
  }
  function setCuteMsg(msg) {
    const el = document.getElementById('cmp-loading-msg');
    if (el) el.textContent = msg;
  }

  async function fetchAndRender(opts = {}) {
    const force = opts.force === true;
    const { start, end } = getDateRange();
    if (!start || !end) { alert('시작일/종료일을 선택하세요.'); return; }
    cmpCurrentRange = { start, end };   // 일평균 계산용

    const errorEl   = document.getElementById('cmp-error-msg');
    const loadingEl = document.getElementById('cmp-loading');
    errorEl.classList.add('hidden');
    loadingEl.classList.remove('hidden');
    resetCuteStates();
    setCuteMsg(force ? '최신 데이터 가져오는 중...' : '카카오와 구글한테 달려가는 중...');
    ['cmp-summary', 'cmp-charts', 'cmp-table-section'].forEach(id =>
      document.getElementById(id).style.display = 'none');

    const sYMD = toYYYYMMDD(start), eYMD = toYYYYMMDD(end);
    const cacheKey = `${sYMD}-${eYMD}`;
    const t0 = performance.now();

    // 캐시 HIT → 즉시 반환 (force=true 면 캐시 무시)
    const cHit = clientCache.get(cacheKey);
    if (!force && cHit) {
      const nRows = mapNaverRows(start, end);
      cmpRawRows = [...cHit.kRows, ...cHit.gRows, ...nRows];
      setCuteState('kakao',  'done', `${cHit.kRows.length}건`);
      setCuteState('google', 'done', `${cHit.gRows.length}건`);
      setCuteState('naver',  nRows.length ? 'done' : 'empty', nRows.length ? `${nRows.length}건` : '업로드 없음');
      const ageMin = Math.round((Date.now() - cHit.at) / 60000);
      setCuteMsg(`⚡ 저장된 데이터 (${ageMin < 1 ? '방금' : ageMin + '분 전'})! 최신 조회는 "통합 조회" 버튼을 눌러주세요`);
      finalizeAfterFetch(cacheKey);
      // 살짝 보여줬다가 숨기기
      setTimeout(() => loadingEl.classList.add('hidden'), 600);
      console.log(`[compare] cache hit, ${Math.round(performance.now()-t0)}ms`);
      return;
    }

    // 플랫폼별 독립적 fetch — 먼저 오는 데이터부터 렌더
    let kRows = [], gRows = [], nRows = [];
    let kakaoDone = false, googleDone = false;

    const renderPartial = () => {
      cmpRawRows = [...kRows, ...gRows, ...nRows];
      if (cmpRawRows.length) {
        finalizeAfterFetch(cacheKey);
      }
    };

    // 네이버는 업로드된 데이터라 즉시 (점진적으로 바로 반영)
    nRows = mapNaverRows(start, end);
    setCuteState('naver', nRows.length ? 'done' : 'empty',
      nRows.length ? `${nRows.length}건` : '업로드 없음');

    // 카카오 (빠름 ~0.5s)
    const kakaoPromise = (async () => {
      try {
        const res = await fetch(`/api/report?periodType=D&startDate=${sYMD}&endDate=${eYMD}`);
        if (!res.ok) throw new Error('카카오 API 실패');
        const j = await res.json();
        kRows = mapKakaoRows(j);
        setCuteState('kakao', 'done', `${kRows.length}건`);
        kakaoDone = true;
        if (!googleDone) setCuteMsg('카카오 완료! 구글 기다리는 중... 🏃‍♂️');
        renderPartial();  // 카카오 + 네이버 먼저 보여주기
      } catch (err) {
        setCuteState('kakao', 'error', '실패');
        kakaoDone = true;
        console.error('Kakao:', err);
      }
    })();

    // 구글 (느림 6~15s)
    let googleErrMsg = '';
    const googlePromise = (async () => {
      try {
        const res = await fetch(`/api/google/report?startDate=${sYMD}&endDate=${eYMD}`);
        if (!res.ok) {
          // 서버가 보낸 에러 메시지 파싱 시도
          let detail = `HTTP ${res.status}`;
          try {
            const e = await res.json();
            if (e && e.error) detail = e.error;
          } catch {}
          throw new Error(detail);
        }
        const j = await res.json();
        gRows = mapGoogleRows(j);
        setCuteState('google', 'done', `${gRows.length}건`);
        googleDone = true;
        renderPartial();
      } catch (err) {
        googleErrMsg = err.message || '구글 API 실패';
        setCuteState('google', 'error', '실패');
        googleDone = true;
        console.error('Google:', err);
      }
    })();

    // 구글이 늦으면 메시지 업데이트
    const msgTimer1 = setTimeout(() => {
      if (!googleDone) setCuteMsg('구글이 열심히 장부 뒤지는 중이에요... 📖');
    }, 3000);
    const msgTimer2 = setTimeout(() => {
      if (!googleDone) setCuteMsg('조금만 더요! 구글은 살짝 느려요 🐢');
    }, 10000);

    try {
      await Promise.allSettled([kakaoPromise, googlePromise]);
      clearTimeout(msgTimer1); clearTimeout(msgTimer2);

      clientCache.set(cacheKey, { kRows, gRows, at: Date.now() });
      savePersistCache();
      cmpRawRows = [...kRows, ...gRows, ...nRows];
      console.log(`[compare] fetched k=${kRows.length} g=${gRows.length} n=${nRows.length}, ${Math.round(performance.now()-t0)}ms`);

      if (cmpRawRows.length === 0) {
        setCuteMsg('😿 데이터가 없어요...');
        setTimeout(() => {
          loadingEl.classList.add('hidden');
          errorEl.textContent = googleErrMsg
            ? `구글 API 오류: ${googleErrMsg}`
            : '해당 기간에 카페 수익 데이터가 없습니다.';
          errorEl.classList.remove('hidden');
        }, 800);
        return;
      }

      setCuteMsg(googleErrMsg
        ? `⚠️ 구글 실패 (${googleErrMsg}) — 카카오/네이버만 표시합니다`
        : '🎉 모두 도착! 결과를 정리할게요...');
      finalizeAfterFetch(cacheKey);
      // 에러 시 메시지 더 오래 표시
      setTimeout(() => loadingEl.classList.add('hidden'), googleErrMsg ? 2500 : 600);
    } catch (err) {
      clearTimeout(msgTimer1); clearTimeout(msgTimer2);
      loadingEl.classList.add('hidden');
      errorEl.textContent = `오류: ${err.message}`;
      errorEl.classList.remove('hidden');
      console.error(err);
    }
  }

  function finalizeAfterFetch() {
    const errorEl = document.getElementById('cmp-error-msg');
    if (cmpRawRows.length === 0) {
      errorEl.textContent = '해당 기간에 카페 수익 데이터가 없습니다.';
      errorEl.classList.remove('hidden');
      return;
    }
    // MCS 옵션 채우기
    const uniqUnits = pred =>
      [...new Set(cmpRawRows.filter(pred).map(r => r.unit))].sort();
    mcsK.refresh(uniqUnits(r => r.platform === 'kakao'));
    mcsG.refresh(uniqUnits(r => r.platform === 'google'));
    mcsN.refresh(uniqUnits(r => r.platform === 'naverSA' || r.platform === 'naverDA'));

    renderAll();
    ['cmp-summary', 'cmp-charts', 'cmp-table-section'].forEach(id =>
      document.getElementById(id).style.display = '');
  }

  // ──────────────────────────────────────────────
  // 필터 적용
  // ──────────────────────────────────────────────
  function applyUnitFilter(rows) {
    const selK = mcsK ? new Set(mcsK.getSelected()) : new Set();
    const selG = mcsG ? new Set(mcsG.getSelected()) : new Set();
    const selN = mcsN ? new Set(mcsN.getSelected()) : new Set();
    return rows.filter(r => {
      if (r.platform === 'kakao')   return selK.size === 0 || selK.has(r.unit);
      if (r.platform === 'google')  return selG.size === 0 || selG.has(r.unit);
      if (r.platform === 'naverSA' || r.platform === 'naverDA')
        return selN.size === 0 || selN.has(r.unit);
      return true;
    });
  }

  // ──────────────────────────────────────────────
  // 렌더링
  // ──────────────────────────────────────────────
  function renderAll() {
    const rows = applyUnitFilter(cmpRawRows);
    renderSummary(rows);
    renderTrendChart(rows);
    renderPieChart(rows);
    renderTable(rows);
  }

  // 플랫폼별 합계 계산 (profit / request / impression / click)
  function aggBy(rows, platform) {
    let profit = 0, request = 0, impression = 0, click = 0;
    for (const r of rows) {
      if (platform && r.platform !== platform) continue;
      profit     += Number(r.profit || 0);
      request    += Number(r.request || 0);
      impression += Number(r.impression || 0);
      click      += Number(r.click || 0);
    }
    return { profit, request, impression, click };
  }

  // eCPM 계산 (없으면 '-' 반환)
  function ecpm(profit, base) {
    if (!base || base <= 0) return '-';
    return krw(Math.round(profit / base * 1000));
  }

  // 선택 기간의 일수 (일평균 계산용). 일/주/월 모두 일 단위로 환산.
  function getDayCount() {
    const { start, end } = cmpCurrentRange;
    if (!start || !end) return 1;
    const s = new Date(start), e = new Date(end);
    if (isNaN(s) || isNaN(e)) return 1;
    return Math.max(1, Math.round((e - s) / 86400000) + 1);
  }

  function renderSummary(rows) {
    const aK  = aggBy(rows, 'kakao');
    const aG  = aggBy(rows, 'google');
    const aSA = aggBy(rows, 'naverSA');
    const aDA = aggBy(rows, 'naverDA');
    const aT = {
      profit:     aK.profit     + aG.profit     + aSA.profit     + aDA.profit,
      request:    aK.request    + aG.request    + aSA.request    + aDA.request,
      impression: aK.impression + aG.impression + aSA.impression + aDA.impression,
      click:      aK.click      + aG.click      + aSA.click      + aDA.click,
    };
    const totalProfit = aT.profit;
    const share = v => totalProfit > 0 ? pct(v / totalProfit * 100) : '-';
    const days = getDayCount();

    const setText = (id, val, rawNum) => {
      const el = document.getElementById(id); if (!el) return;
      el.textContent = val;
      if (rawNum !== undefined) el.dataset.raw = String(rawNum);
    };

    // 카드별 일평균 토글 상태 조회
    const isAvg = card => {
      const el = document.querySelector(`.cmp-card[data-card="${card}"]`);
      return el ? el.dataset.avg === '1' : false;
    };

    // 카드 하나 채우기 — daily-avg이면 profit/req/imp를 days로 나눔. eCPM은 비율이라 동일.
    function fill(prefix, a) {
      const avg = isAvg(prefix);
      const P = avg ? a.profit     / days : a.profit;
      const R = avg ? a.request    / days : a.request;
      const I = avg ? a.impression / days : a.impression;
      setText(`cmp-${prefix}-profit`,   krw(P),                      Math.round(P));
      setText(`cmp-${prefix}-req`,      R ? num(Math.round(R)) : '-', R ? Math.round(R) : 0);
      setText(`cmp-${prefix}-imp`,      I ? num(Math.round(I)) : '-', I ? Math.round(I) : 0);
      setText(`cmp-${prefix}-req-ecpm`, ecpm(a.profit, a.request),    ecpmRaw(a.profit, a.request));
      setText(`cmp-${prefix}-imp-ecpm`, ecpm(a.profit, a.impression), ecpmRaw(a.profit, a.impression));
    }
    fill('kakao',   aK);
    fill('google',  aG);
    fill('naverSA', aSA);
    fill('naverDA', aDA);
    fill('total',   aT);

    // 점유율 / 유닛 개수 — 일평균과 무관
    setText('cmp-kakao-share',   `점유율 ${share(aK.profit)}`);
    setText('cmp-google-share',  `점유율 ${share(aG.profit)}`);
    setText('cmp-naverSA-share', `점유율 ${share(aSA.profit)}`);
    setText('cmp-naverDA-share', `점유율 ${share(aDA.profit)}`);
    const uniqUnitsCount = new Set(rows.map(r => `${r.platform}:${r.unit}`)).size;
    setText('cmp-total-sub', `${uniqUnitsCount}개 유닛 · ${days}일`);
  }

  function ecpmRaw(profit, base) {
    if (!base || base <= 0) return 0;
    return Math.round(profit / base * 1000);
  }

  // 차트 지표 메타 (라벨/포맷/ecpm 여부)
  const CHART_METRIC_META = {
    profit:     { label: '수익',       short: '수익',       fmt: v => krw(v),                                isEcpm: false },
    request:    { label: '요청',       short: '요청',       fmt: v => num(Math.round(v)),                   isEcpm: false },
    impression: { label: '노출',       short: '노출',       fmt: v => num(Math.round(v)),                   isEcpm: false },
    reqEcpm:    { label: '요청 eCPM',  short: '요청 eCPM',  fmt: v => krw(Math.round(v)),                   isEcpm: true, base: 'request' },
    impEcpm:    { label: '노출 eCPM',  short: '노출 eCPM',  fmt: v => krw(Math.round(v)),                   isEcpm: true, base: 'impression' },
  };

  function renderTrendChart(rows) {
    // 기간별 그룹 키 (일/주/월)
    const toKey = date => {
      if (cmpPeriod === 'monthly') return date.slice(0, 7);
      if (cmpPeriod === 'weekly') {
        const d = new Date(date);
        const dow = d.getDay();
        const diff = dow === 0 ? -6 : 1 - dow;
        d.setDate(d.getDate() + diff);
        return d.toISOString().slice(0, 10);
      }
      return date;
    };

    // 플랫폼×버킷별 누적합 (profit/request/impression 모두)
    const buckets = {};
    PLATFORMS.forEach(p => { buckets[p.key] = {}; });
    for (const r of rows) {
      const k = toKey(r.date);
      const b = buckets[r.platform]; if (!b) continue;
      const g = b[k] || { profit: 0, request: 0, impression: 0 };
      g.profit     += r.profit     || 0;
      g.request    += r.request    || 0;
      g.impression += r.impression || 0;
      b[k] = g;
    }
    const allKeys = [...new Set(rows.map(r => toKey(r.date)))].sort();

    const meta = CHART_METRIC_META[cmpChartMetric] || CHART_METRIC_META.profit;
    const valueAt = (platformKey, k) => {
      const g = buckets[platformKey][k];
      if (!g) return 0;
      if (meta.isEcpm) {
        const base = g[meta.base];
        return base > 0 ? g.profit / base * 1000 : 0;
      }
      return g[cmpChartMetric] || 0;
    };

    const series = PLATFORMS.map(p => ({
      label: p.label,
      data: allKeys.map(k => valueAt(p.key, k)),
      borderColor: p.color,
      backgroundColor: p.color + '22',
      tension: 0.3, fill: false,
      pointRadius: 0, pointHoverRadius: 5,   // 평상시 점 숨김, hover 시만 표시
      pointBackgroundColor: p.color,
      borderWidth: 2,
    }));

    // 전체 합계 라인 — 지표에 따라 합산 or eCPM 재계산
    const totalData = allKeys.map(k => {
      if (meta.isEcpm) {
        let profit = 0, base = 0;
        PLATFORMS.forEach(p => {
          const g = buckets[p.key][k]; if (!g) return;
          profit += g.profit; base += g[meta.base];
        });
        return base > 0 ? profit / base * 1000 : 0;
      }
      return PLATFORMS.reduce((sum, p) => sum + valueAt(p.key, k), 0);
    });
    series.push({
      label: '전체 합계',
      data: totalData,
      borderColor: '#64748B',
      backgroundColor: 'transparent',
      tension: 0.35, fill: false,
      pointRadius: 0, pointHoverRadius: 5,
      pointBackgroundColor: '#64748B',
      borderWidth: 2, order: 0,
    });

    // 차트 제목 라벨 업데이트
    const labelEl = document.getElementById('cmp-chart-metric-label');
    if (labelEl) labelEl.textContent = meta.short;

    if (cmpTrendChart) cmpTrendChart.destroy();
    let hoveredIdx = null;
    cmpTrendChart = new Chart(document.getElementById('cmp-trend-chart'), {
      type: 'line',
      data: { labels: allKeys, datasets: series },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        onHover: (event, elements, chart) => {
          const newIdx = elements.length > 0 ? elements[0].index : null;
          if (newIdx !== hoveredIdx) { hoveredIdx = newIdx; chart.update('none'); }
        },
        plugins: {
          legend: { position: 'top' },
          tooltip: { callbacks: { label: c => `${c.dataset.label}: ${meta.fmt(c.parsed.y)}` } },
        },
        scales: {
          x: {
            ticks: {
              color: (ctx) => ctx.index === hoveredIdx ? '#DC2626' : '#6B7280',
              font: (ctx) => ctx.index === hoveredIdx
                ? { weight: 'bold', size: 13 }
                : { weight: 'normal', size: 12 },
            },
          },
          y: { beginAtZero: true, ticks: { callback: v => meta.fmt(v) } },
        },
      },
    });
  }

  function renderPieChart(rows) {
    const values = PLATFORMS.map(p => aggBy(rows, p.key).profit);
    const total = values.reduce((a, b) => a + b, 0);

    if (cmpPieChart) cmpPieChart.destroy();
    cmpPieChart = new Chart(document.getElementById('cmp-pie-chart'), {
      type: 'doughnut',
      data: {
        labels: PLATFORMS.map(p => p.label),
        datasets: [{
          data: values,
          backgroundColor: PLATFORMS.map(p => p.color),
          borderWidth: 2, borderColor: '#fff',
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom' },
          tooltip: { callbacks: {
            label: c => `${c.label}: ${krw(c.parsed)} (${total > 0 ? (c.parsed/total*100).toFixed(1) : 0}%)`
          } },
        },
      },
    });
  }

  function renderTable(rows) {
    // 유닛별 집계 (platform + unit)
    const map = new Map();
    for (const r of rows) {
      const key = `${r.platform}::${r.unit}`;
      const prev = map.get(key) || { platform: r.platform, unit: r.unit, impression: 0, click: 0, profit: 0 };
      prev.impression += r.impression;
      prev.click      += r.click;
      prev.profit     += r.profit;
      map.set(key, prev);
    }
    const arr = [...map.values()].map(r => ({
      ...r,
      ctr:  r.impression > 0 ? r.click / r.impression * 100 : 0,
      ecpm: r.impression > 0 ? r.profit / r.impression * 1000 : 0,
    }));
    const total = arr.reduce((a, r) => a + r.profit, 0);
    arr.forEach(r => r.share = total > 0 ? r.profit / total * 100 : 0);

    // 정렬: 플랫폼 우선(네이버SA → 네이버DA → 구글 → 카카오), 내부는 선택된 컬럼(기본: 유닛명)
    const PLATFORM_ORDER = { naverSA: 0, naverDA: 1, google: 2, kakao: 3 };
    const { col, dir } = cmpSortState;
    arr.sort((a, b) => {
      const po = (PLATFORM_ORDER[a.platform] ?? 99) - (PLATFORM_ORDER[b.platform] ?? 99);
      if (po !== 0) return po;
      // 같은 플랫폼 내: 현재 선택된 컬럼 기준, 디폴트는 유닛명 오름차순
      const useCol = col || 'unit';
      const va = a[useCol], vb = b[useCol];
      if (typeof va === 'string') return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
      return dir === 'asc' ? va - vb : vb - va;
    });

    const badge = p => ({
      kakao:   `<span class="cmp-badge cmp-badge-kakao">🟡 카카오</span>`,
      google:  `<span class="cmp-badge cmp-badge-google">🔵 구글</span>`,
      naverSA: `<span class="cmp-badge cmp-badge-naver-sa">🟢 네이버 SA</span>`,
      naverDA: `<span class="cmp-badge cmp-badge-naver-da">🟪 네이버 DA</span>`,
    }[p] || p);

    // 플랫폼 그룹 첫 행에 구분선 클래스 추가
    let prevPlatform = null;
    document.getElementById('cmp-table-body').innerHTML = arr.map(r => {
      const isGroupStart = r.platform !== prevPlatform;
      prevPlatform = r.platform;
      return `
      <tr class="cmp-row-${r.platform}${isGroupStart ? ' cmp-group-start' : ''}">
        <td class="cmp-cell-platform">${badge(r.platform)}</td>
        <td class="cmp-cell-unit" title="${r.unit}">${r.unit}</td>
        <td class="cmp-cell-profit"><strong>${krw(r.profit)}</strong></td>
        <td class="cmp-cell-num">${num(r.impression)}</td>
        <td class="cmp-cell-num">${num(r.click)}</td>
        <td class="cmp-cell-num">${pct(r.ctr)}</td>
        <td class="cmp-cell-num">${krw(r.ecpm)}</td>
        <td class="cmp-cell-num">${pct(r.share)}</td>
      </tr>`;
    }).join('');

    document.getElementById('cmp-row-count').textContent = `${arr.length}개 유닛`;
  }

  function downloadCsv() {
    const rows = applyUnitFilter(cmpRawRows);
    if (!rows.length) return;
    const platMap = { kakao: '카카오', google: '구글', naverSA: '네이버 SA', naverDA: '네이버 DA' };
    const header = ['플랫폼','유닛명','날짜','노출수','클릭수','수익(원)'];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push([platMap[r.platform], `"${r.unit}"`, r.date, r.impression, r.click, r.profit.toFixed(0)].join(','));
    }
    const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `cafe-compare-${Date.now()}.csv`;
    a.click();
  }

  // ── 진단 헬퍼
  // 사용법:
  //   __cmpDebug()                             → 전체 카페 광고ID별 집계
  //   __cmpDebug('2026-04-21')                 → 특정 일자 단일
  //   __cmpDebug('2026-04-01', '2026-04-21')   → 기간
  //   __cmpDebug({start:'2026-04-21', end:'2026-04-21', platform:'naverSA'})
  window.__cmpDebug = function (a, b) {
    let start = '', end = '', platformFilter = '';
    if (typeof a === 'string' && typeof b === 'string') { start = a; end = b; }
    else if (typeof a === 'string') { start = a; end = a; }
    else if (a && typeof a === 'object') { start = a.start || ''; end = a.end || start; platformFilter = a.platform || ''; }
    const inRange = (r) => {
      if (!start && !end) return true;
      if (r.isMonthly) {
        const rm = r.date;
        const sm = start.slice(0, 7), em = end.slice(0, 7);
        return rm >= sm && rm <= em;
      }
      return r.date >= start && r.date <= end;
    };
    // 분류: mapNaverRows와 동일한 우선순위 규칙
    const classify = (r) => {
      const adId = r.adId || '', media = r.media || '';
      if (/cafe/i.test(adId)) return 'naverDA';
      if (/카페/.test(adId))  return 'naverSA';
      if (/cafe/i.test(media)) return 'naverDA';
      if (/카페/.test(media))  return 'naverSA';
      return '(no-match)';
    };
    const rows = window.naverAllRows || [];
    const cafeRows = rows.filter(r => /카페|cafe/i.test((r.adId || '') + ' ' + (r.media || '')));
    const byId = new Map();
    let totalSA = 0, totalDA = 0, totalOther = 0, skippedDate = 0;
    for (const r of cafeRows) {
      const plat = classify(r);
      if (platformFilter && plat !== platformFilter) continue;
      if (!inRange(r)) { skippedDate++; continue; }
      const k = r.adId || '(no-adId)';
      let d = byId.get(k);
      if (!d) { d = { platform: plat, rows: 0, dates: new Set(), media: new Set(), profit: 0, monthly: 0, daily: 0 }; byId.set(k, d); }
      d.rows++;
      d.dates.add(r.date + (r.isMonthly ? '(M)' : ''));
      if (r.media) d.media.add(r.media);
      d.profit += Number(r.profit || 0);
      if (r.isMonthly) d.monthly++; else d.daily++;
      if (plat === 'naverSA') totalSA += Number(r.profit || 0);
      else if (plat === 'naverDA') totalDA += Number(r.profit || 0);
      else totalOther += Number(r.profit || 0);
    }
    const out = [];
    for (const [adId, d] of byId.entries()) {
      out.push({
        adId,
        platform: d.platform,
        '행수': d.rows,
        '일단위': d.daily,
        '월단위': d.monthly,
        '수익합': Math.round(d.profit),
        '날짜샘플': [...d.dates].slice(0, 5).join(', ') + (d.dates.size > 5 ? ` …+${d.dates.size-5}` : ''),
      });
    }
    out.sort((x, y) => y['수익합'] - x['수익합']);
    const rangeLabel = (start || end) ? `${start}~${end}` : '(전 기간)';
    console.log(`[__cmpDebug] 기간=${rangeLabel} 필터=${platformFilter || '(전체)'} | SA=${totalSA.toLocaleString()}원  DA=${totalDA.toLocaleString()}원  기타=${totalOther.toLocaleString()}원  범위밖=${skippedDate}건`);
    console.table(out);
    return { totalSA, totalDA, totalOther, rows: out };
  };

})();

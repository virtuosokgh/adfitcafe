/* ================================================================
 *  통합 비교 대시보드 (카카오/구글/네이버 카페 수익)
 *  - 기간 탭 (일/주/월)
 *  - 플랫폼별 유닛 필터 (MCS)
 *  - 네이버 CSV 업로드 (컴팩트)
 * ================================================================ */
(function () {
  'use strict';

  const CMP_NAVER_CACHE_KEY = 'naver_csv_cache_v1';
  const KAKAO_RE  = /(카페|테이블)/;
  const GOOGLE_RE = /카페/;
  const NAVER_RE  = /카페/;

  // 상태
  let cmpPeriod = 'daily';
  let cmpRawRows = [];         // 서버 응답 원본을 합친 것 (platform/unit/date/impression/click/profit)
  let cmpSortState = { col: 'profit', dir: 'desc' };
  let cmpTrendChart = null;
  let cmpPieChart   = null;

  // 클라이언트 캐시 (기간별, 3분 TTL)
  const CLIENT_CACHE_TTL = 3 * 60 * 1000;
  const clientCache = new Map();  // key(start-end) → { rows, at }

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
    document.getElementById('cmp-naver-reset-btn').addEventListener('click', () => {
      window.naverAllRows = [];
      try { localStorage.removeItem(CMP_NAVER_CACHE_KEY); } catch {}
      syncNaverStatus();
    });

    // 조회 버튼
    document.getElementById('cmp-search-btn').addEventListener('click', fetchAndRender);

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

    // 네이버 캐시에서 복원
    loadNaverFromCache();
    syncNaverStatus();

    // 탭 첫 진입 시 자동 조회 (기본 기간) → MCS 미리 채우기
    //   flatpickr 가 defaultDate 를 input 에 반영할 시간을 줌
    setTimeout(() => fetchAndRender(), 50);
  }

  // 탭 클릭 시 초기화
  document.addEventListener('click', e => {
    const btn = e.target.closest('.pnav-btn[data-pnav="compare"]');
    if (btn) initOnce();
  });
  // 처음부터 compare가 활성이었으면
  if (localStorage.getItem('pnav_active') === 'compare') {
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
    reader.onload = ev => {
      try {
        const rows = parseNaverCsv(ev.target.result);
        if (!rows.length) throw new Error('카페 매체 행이 없습니다.');
        window.naverAllRows = rows;
        try {
          localStorage.setItem(CMP_NAVER_CACHE_KEY, JSON.stringify({
            fileName: file.name, uploadedAt: Date.now(), rows
          }));
        } catch {}
        syncNaverStatus(file.name);
      } catch (err) {
        alert('CSV 파싱 실패: ' + err.message);
      }
    };
    reader.readAsText(file, 'utf-8');
    // 같은 파일 재선택 가능하도록
    e.target.value = '';
  }

  function loadNaverFromCache() {
    try {
      const raw = localStorage.getItem(CMP_NAVER_CACHE_KEY);
      if (!raw) return;
      const { rows } = JSON.parse(raw);
      if (Array.isArray(rows) && rows.length) window.naverAllRows = rows;
    } catch {}
  }

  function syncNaverStatus(fileName) {
    const rows = window.naverAllRows || [];
    const statusEl = document.getElementById('cmp-naver-status');
    const resetBtn = document.getElementById('cmp-naver-reset-btn');
    if (rows.length > 0) {
      statusEl.textContent = fileName
        ? `✅ ${fileName} (${rows.length}건 로드됨)`
        : `✅ 네이버 데이터 ${rows.length}건 로드됨 (캐시)`;
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
    const idx = name => headers.indexOf(name);
    const iDate = idx('날짜'), iId = idx('광고ID'), iMedia = idx('매체'),
          iReq = idx('요청수'), iImp = idx('노출수'), iClk = idx('클릭수'),
          iPrf = idx('AXZ매출(원)'), iCtr = idx('CTR(%)');
    const pn = s => {
      const v = Number(String(s || '').replace(/[,\s]/g, ''));
      return isNaN(v) ? 0 : v;
    };
    const out = [];
    for (let i = 1; i < lines.length; i++) {
      const c = splitCsv(lines[i]);
      const media = (c[iMedia] || '').trim();
      if (!media.includes('카페')) continue;
      let date = (c[iDate] || '').trim();
      const isMonthly = date.endsWith('-00');
      if (isMonthly) date = date.slice(0, 7);
      out.push({
        date, isMonthly, adId: (c[iId] || '').trim(), media,
        request: pn(c[iReq]), impression: pn(c[iImp]),
        click: pn(c[iClk]), profit: pn(c[iPrf]), ctr: pn(c[iCtr]),
      });
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
        unit: r.adunitName,
        date: dateIso,
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
        impression: Number(r[cImp] || 0),
        click: Number(r[cClk] || 0),
        profit,
      });
    }
    return out;
  }

  function mapNaverRows(start, end) {
    const out = [];
    for (const r of (window.naverAllRows || [])) {
      if (!NAVER_RE.test(r.media || '')) continue;
      if (r.date < start || r.date > end) continue;
      out.push({
        platform: 'naver',
        unit: r.media,
        date: r.date,
        impression: Number(r.impression || 0),
        click: Number(r.click || 0),
        profit: Number(r.profit || 0),
      });
    }
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

  async function fetchAndRender() {
    const { start, end } = getDateRange();
    if (!start || !end) { alert('시작일/종료일을 선택하세요.'); return; }

    const errorEl   = document.getElementById('cmp-error-msg');
    const loadingEl = document.getElementById('cmp-loading');
    errorEl.classList.add('hidden');
    loadingEl.classList.remove('hidden');
    resetCuteStates();
    setCuteMsg('카카오와 구글한테 달려가는 중...');
    ['cmp-summary', 'cmp-charts', 'cmp-table-section'].forEach(id =>
      document.getElementById(id).style.display = 'none');

    const sYMD = toYYYYMMDD(start), eYMD = toYYYYMMDD(end);
    const cacheKey = `${sYMD}-${eYMD}`;
    const t0 = performance.now();

    // 클라이언트 캐시 HIT → 즉시 반환 (캐시 애니메이션은 최소화)
    const cHit = clientCache.get(cacheKey);
    if (cHit && (Date.now() - cHit.at) < CLIENT_CACHE_TTL) {
      const nRows = mapNaverRows(start, end);
      cmpRawRows = [...cHit.kRows, ...cHit.gRows, ...nRows];
      setCuteState('kakao',  'done', `${cHit.kRows.length}건`);
      setCuteState('google', 'done', `${cHit.gRows.length}건`);
      setCuteState('naver',  nRows.length ? 'done' : 'empty', nRows.length ? `${nRows.length}건` : '업로드 없음');
      setCuteMsg('⚡ 캐시에서 즉시 불러왔어요!');
      finalizeAfterFetch(cacheKey);
      // 살짝 보여줬다가 숨기기
      setTimeout(() => loadingEl.classList.add('hidden'), 400);
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

    // 구글 (느림 10~18s)
    const googlePromise = (async () => {
      try {
        const res = await fetch(`/api/google/report?startDate=${sYMD}&endDate=${eYMD}`);
        if (!res.ok) throw new Error('구글 API 실패');
        const j = await res.json();
        gRows = mapGoogleRows(j);
        setCuteState('google', 'done', `${gRows.length}건`);
        googleDone = true;
        renderPartial();
      } catch (err) {
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
      cmpRawRows = [...kRows, ...gRows, ...nRows];
      console.log(`[compare] fetched k=${kRows.length} g=${gRows.length} n=${nRows.length}, ${Math.round(performance.now()-t0)}ms`);

      if (cmpRawRows.length === 0) {
        setCuteMsg('😿 데이터가 없어요...');
        setTimeout(() => {
          loadingEl.classList.add('hidden');
          errorEl.textContent = '해당 기간에 카페 수익 데이터가 없습니다.';
          errorEl.classList.remove('hidden');
        }, 800);
        return;
      }

      setCuteMsg('🎉 모두 도착! 결과를 정리할게요...');
      finalizeAfterFetch(cacheKey);
      // 완료 애니메이션 잠깐 보여주고 숨기기
      setTimeout(() => loadingEl.classList.add('hidden'), 600);
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
    const uniqUnits = platform =>
      [...new Set(cmpRawRows.filter(r => r.platform === platform).map(r => r.unit))].sort();
    mcsK.refresh(uniqUnits('kakao'));
    mcsG.refresh(uniqUnits('google'));
    mcsN.refresh(uniqUnits('naver'));

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
      if (r.platform === 'kakao')  return selK.size === 0 || selK.has(r.unit);
      if (r.platform === 'google') return selG.size === 0 || selG.has(r.unit);
      if (r.platform === 'naver')  return selN.size === 0 || selN.has(r.unit);
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

  function sumBy(rows, platform) {
    return rows.filter(r => r.platform === platform).reduce((a, r) => a + r.profit, 0);
  }

  function renderSummary(rows) {
    const k = sumBy(rows, 'kakao');
    const g = sumBy(rows, 'google');
    const n = sumBy(rows, 'naver');
    const total = k + g + n;
    const share = v => total > 0 ? pct(v / total * 100) : '-';

    document.getElementById('cmp-kakao-profit').textContent  = krw(k);
    document.getElementById('cmp-google-profit').textContent = krw(g);
    document.getElementById('cmp-naver-profit').textContent  = krw(n);
    document.getElementById('cmp-total-profit').textContent  = krw(total);
    document.getElementById('cmp-kakao-share').textContent   = `점유율 ${share(k)}`;
    document.getElementById('cmp-google-share').textContent  = `점유율 ${share(g)}`;
    document.getElementById('cmp-naver-share').textContent   = `점유율 ${share(n)}`;
    const uniqUnits = new Set(rows.map(r => `${r.platform}:${r.unit}`)).size;
    document.getElementById('cmp-total-sub').textContent     = `${uniqUnits}개 유닛`;
  }

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

    const buckets = { kakao: {}, google: {}, naver: {} };
    for (const r of rows) {
      const k = toKey(r.date);
      buckets[r.platform][k] = (buckets[r.platform][k] || 0) + r.profit;
    }
    const allKeys = [...new Set(rows.map(r => toKey(r.date)))].sort();

    const series = [
      { key: 'kakao',  label: '🟡 다음(카카오)', color: '#FBB034' },
      { key: 'google', label: '🔵 구글',         color: '#1A73E8' },
      { key: 'naver',  label: '🟢 네이버',       color: '#03C75A' },
    ].map(s => ({
      label: s.label,
      data: allKeys.map(k => buckets[s.key][k] || 0),
      borderColor: s.color,
      backgroundColor: s.color + '22',
      tension: 0.3, fill: false, pointRadius: 3, borderWidth: 2,
    }));

    // 전체 합계 라인 추가 (세 플랫폼 합)
    const totalData = allKeys.map(k =>
      (buckets.kakao[k] || 0) + (buckets.google[k] || 0) + (buckets.naver[k] || 0)
    );
    series.push({
      label: '⚫ 전체 합계',
      data: totalData,
      borderColor: '#111827',
      backgroundColor: '#11182733',
      borderDash: [6, 4],       // 점선으로 구분
      tension: 0.3,
      fill: false,
      pointRadius: 4,
      borderWidth: 3,
    });

    if (cmpTrendChart) cmpTrendChart.destroy();
    cmpTrendChart = new Chart(document.getElementById('cmp-trend-chart'), {
      type: 'line',
      data: { labels: allKeys, datasets: series },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'top' },
          tooltip: { callbacks: { label: c => `${c.dataset.label}: ${krw(c.parsed.y)}` } },
        },
        scales: { y: { beginAtZero: true, ticks: { callback: v => krw(v) } } },
      },
    });
  }

  function renderPieChart(rows) {
    const k = sumBy(rows, 'kakao');
    const g = sumBy(rows, 'google');
    const n = sumBy(rows, 'naver');
    const total = k + g + n;

    if (cmpPieChart) cmpPieChart.destroy();
    cmpPieChart = new Chart(document.getElementById('cmp-pie-chart'), {
      type: 'doughnut',
      data: {
        labels: ['🟡 카카오', '🔵 구글', '🟢 네이버'],
        datasets: [{
          data: [k, g, n],
          backgroundColor: ['#FBB034', '#1A73E8', '#03C75A'],
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

    // 정렬
    const { col, dir } = cmpSortState;
    arr.sort((a, b) => {
      const va = a[col], vb = b[col];
      if (typeof va === 'string') return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
      return dir === 'asc' ? va - vb : vb - va;
    });

    const badge = p => ({
      kakao:  `<span class="cmp-badge cmp-badge-kakao">🟡 카카오</span>`,
      google: `<span class="cmp-badge cmp-badge-google">🔵 구글</span>`,
      naver:  `<span class="cmp-badge cmp-badge-naver">🟢 네이버</span>`,
    }[p]);

    document.getElementById('cmp-table-body').innerHTML = arr.map(r => `
      <tr class="cmp-row-${r.platform}">
        <td>${badge(r.platform)}</td>
        <td>${r.unit}</td>
        <td>${num(r.impression)}</td>
        <td>${num(r.click)}</td>
        <td>${pct(r.ctr)}</td>
        <td>${krw(r.ecpm)}</td>
        <td><strong>${krw(r.profit)}</strong></td>
        <td>${pct(r.share)}</td>
      </tr>
    `).join('');

    document.getElementById('cmp-row-count').textContent = `${arr.length}개 유닛`;
  }

  function downloadCsv() {
    const rows = applyUnitFilter(cmpRawRows);
    if (!rows.length) return;
    const platMap = { kakao: '카카오', google: '구글', naver: '네이버' };
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

})();

/* =========================================
   카페 애드핏 대시보드 - app.js
   ========================================= */

// ── 상태 변수 ──────────────────────────────
let currentPeriod = 'daily'; // 'daily' | 'weekly' | 'monthly'
let allRows = [];             // 필터 전 원본(카페/테이블만)
let chartInstance = null;
const apiCache = new Map();   // API 응답 캐시 (같은 조건 재조회 시 즉시 반환)
let sortCol = null;           // 현재 정렬 컬럼 키
let sortDir = 1;              // 1=오름차순, -1=내림차순
let pendingAdunits   = [];    // 새로고침 복원용 광고단위명 배열 임시 저장
let pendingAdunitIds = [];   // 새로고침 복원용 광고단위 ID 배열 임시 저장
let pendingPlatforms = [];   // 새로고침 복원용 플랫폼 배열 임시 저장
let fpStart  = null;          // 일별 Flatpickr 시작일
let fpEnd    = null;          // 일별 Flatpickr 종료일
let fpStartW = null;          // 주별 Flatpickr 시작
let fpEndW   = null;          // 주별 Flatpickr 종료
let fpStartM = null;          // 월별 Flatpickr 시작
let fpEndM   = null;          // 월별 Flatpickr 종료
let mcsAdunit   = null;       // MultiCheckSelect 인스턴스 (광고단위명)
let mcsAdunitId = null;       // MultiCheckSelect 인스턴스 (광고단위 ID)
let mcsPlatform = null;       // MultiCheckSelect 인스턴스 (플랫폼)
let mcsCmpAdunit   = null;  // 비교 MultiCheckSelect (광고단위명)
let mcsCmpAdunitId = null;  // 비교 MultiCheckSelect (광고단위 ID)
let mcsCmpPlatform = null;  // 비교 MultiCheckSelect (플랫폼)
let allRowsB   = [];   // 비교 기간 데이터
let cmpFpStart = null; // 비교 기간 Flatpickr 시작
let cmpFpEnd   = null; // 비교 기간 Flatpickr 종료

// ── 키워드 필터 ───────────────────────────
const KEYWORDS = ['카페', '테이블'];

function isCafeUnit(name) {
  return KEYWORDS.some(kw => name && name.includes(kw));
}

// ── 플랫폼 매핑 ───────────────────────────
function guessPlatform(row) {
  const media = (row.mediaName || '').toLowerCase();
  if (media.includes('android')) return 'App Android';
  if (media.includes('ios'))     return 'App iOS';
  if (media.startsWith('mw') || media.includes('mw_')) return 'Mobile Web';
  if (media.startsWith('pw') || media.includes('pw_')) return 'PC Web';
  return row.mediaName || '기타';
}

// ── 날짜 유틸 ────────────────────────────
function today() {
  return new Date().toISOString().slice(0, 10);
}
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}
function monthsAgo(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 10);
}
// 날짜 문자열(YYYY-MM-DD)이 속한 달의 1일/말일 반환 (UTC 기반, timezone 안전)
function monthRange(dateStr) {
  const [year, month] = dateStr.slice(0, 7).split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate(); // 다음 달 day0 = 이번 달 말일
  const pad = n => String(n).padStart(2, '0');
  return { start: `${year}-${pad(month)}-01`, end: `${year}-${pad(month)}-${pad(lastDay)}` };
}
function toYYYYMMDD(dateStr) { return dateStr.replace(/-/g, ''); }
function formatDate(raw) {
  if (raw && raw.length === 8) return `${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,8)}`;
  if (raw && raw.length === 6) return `${raw.slice(0,4)}-${raw.slice(4,6)}`;
  return raw || '-';
}

// ── 숫자 포맷 ────────────────────────────
function comma(n) { return (n || 0).toLocaleString(); }
function won(n)   { return `${comma(n)}원`; }
function pct(a, b) {
  if (!b) return '0.00%';
  return ((a / b) * 100).toFixed(2) + '%';
}

// ── 주별 날짜 계산 (행의 day 값 → 해당 주 월~일) ─────
function getWeekRange(dateStr) {
  const d = new Date(dateStr);
  const day = d.getDay();
  const monday = new Date(d);
  monday.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return {
    start: monday.toISOString().slice(0, 10),
    end:   sunday.toISOString().slice(0, 10)
  };
}

// ── 구버전 "YYYY-Www" → 날짜 변환 (localStorage 하위 호환) ─────
function weekInputToRange(weekStr) {
  const [yearStr, weekPart] = weekStr.split('-W');
  const year = parseInt(yearStr);
  const week = parseInt(weekPart);
  const jan4 = new Date(year, 0, 4);
  const dayOfWeek = (jan4.getDay() + 6) % 7;
  const week1Monday = new Date(jan4);
  week1Monday.setDate(jan4.getDate() - dayOfWeek);
  const monday = new Date(week1Monday);
  monday.setDate(week1Monday.getDate() + (week - 1) * 7);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return {
    start: monday.toISOString().slice(0, 10),
    end:   sunday.toISOString().slice(0, 10)
  };
}

// ── DOM 참조 ──────────────────────────────
const tabBtns        = document.querySelectorAll('.tab-btn');
const dateRanges     = { daily: 'date-range-daily', weekly: 'date-range-weekly', monthly: 'date-range-monthly' };
const startDateD     = document.getElementById('start-date-d');
const endDateD       = document.getElementById('end-date-d');
const startDateW     = document.getElementById('start-date-w');
const endDateW       = document.getElementById('end-date-w');
const startDateM     = document.getElementById('start-date-m');
const endDateM       = document.getElementById('end-date-m');
const searchBtn      = document.getElementById('search-btn');
const loadingEl      = document.getElementById('loading');
const errorEl        = document.getElementById('error-msg');
const emptyEl        = document.getElementById('empty-msg');
const summaryCards   = document.getElementById('summary-cards');
const platformSection  = document.getElementById('platform-section');
const platformCardsEl  = document.getElementById('platform-cards');
const tableSection   = document.getElementById('table-section');
const resultBody     = document.getElementById('result-body');
const rowCountEl     = document.getElementById('row-count');
const csvBtn         = document.getElementById('csv-btn');
const cmpStartDateEl = document.getElementById('cmp-start-date');
const cmpEndDateEl   = document.getElementById('cmp-end-date');
const cmpDateClearBtn = document.getElementById('cmp-date-clear');
const chartSection   = document.getElementById('chart-section');
const totalProfit    = document.getElementById('total-profit');
const totalImpression = document.getElementById('total-impression');
const totalClick     = document.getElementById('total-click');
const totalCtr       = document.getElementById('total-ctr');

// ── 초기값 설정 ───────────────────────────
function initDates() {
  const t = today();

  // 일별: 최근 30일
  startDateD.value = daysAgo(30);
  endDateD.value   = t;

  // 주별: 최근 4주 (월~일 경계로 스냅)
  startDateW.value = getWeekRange(daysAgo(27)).start;
  endDateW.value   = getWeekRange(t).end;

  // 월별: 최근 3개월 (1일~말일 경계로 스냅)
  startDateM.value = monthRange(monthsAgo(2)).start;
  endDateM.value   = monthRange(t).end;
}

// ── 조건 저장 / 복원 (localStorage) ─────────
const STATE_KEY = 'adfit_state';

function saveState() {
  localStorage.setItem(STATE_KEY, JSON.stringify({
    period:    currentPeriod,
    startD:    startDateD.value,
    endD:      endDateD.value,
    startW:    startDateW.value,
    endW:      endDateW.value,
    startM:    startDateM.value,
    endM:      endDateM.value,
    adunits:   mcsAdunit   ? mcsAdunit.getSelected()   : [],
    adunitIds: mcsAdunitId ? mcsAdunitId.getSelected() : [],
    platforms: mcsPlatform ? mcsPlatform.getSelected() : [],
    sortCol:   sortCol,
    sortDir:   sortDir
  }));
}

function restoreState() {
  try {
    const s = JSON.parse(localStorage.getItem(STATE_KEY) || 'null');
    if (s) {
      if (s.startD) startDateD.value = s.startD;
      if (s.endD)   endDateD.value   = s.endD;

      // 주별: 구버전 "YYYY-Www" 포맷 하위 호환 + 월~일 경계 스냅
      if (s.startW) {
        const d = s.startW.includes('-W') ? weekInputToRange(s.startW).start : s.startW;
        startDateW.value = getWeekRange(d).start;
      }
      if (s.endW) {
        const d = s.endW.includes('-W') ? weekInputToRange(s.endW).end : s.endW;
        endDateW.value = getWeekRange(d).end;
      }

      // 월별: 구버전 "YYYY-MM" 포맷 하위 호환 + 말일 보정
      if (s.startM) {
        const d = s.startM.length === 7 ? s.startM + '-01' : s.startM;
        startDateM.value = monthRange(d).start;
      }
      if (s.endM) {
        const d = s.endM.length === 7 ? s.endM + '-01' : s.endM;
        endDateM.value = monthRange(d).end;
      }

      pendingAdunits   = Array.isArray(s.adunits)   ? s.adunits   : (s.adunit   ? [s.adunit]   : []);
      pendingAdunitIds = Array.isArray(s.adunitIds) ? s.adunitIds : (s.adunitId ? [s.adunitId] : []);
      pendingPlatforms = Array.isArray(s.platforms) ? s.platforms : (s.platform ? [s.platform] : []);
      if (s.sortCol)   { sortCol = s.sortCol; sortDir = s.sortDir || 1; }
      switchPeriod(s.period || 'daily');
      return true;
    } else {
      switchPeriod('daily');
      return false;
    }
  } catch {
    switchPeriod('daily');
    return false;
  }
}

// ── 탭 전환 ──────────────────────────────
function switchPeriod(period) {
  currentPeriod = period;
  tabBtns.forEach(b => b.classList.toggle('active', b.dataset.period === period));
  Object.entries(dateRanges).forEach(([p, id]) => {
    document.getElementById(id).classList.toggle('hidden', p !== period);
  });
}
tabBtns.forEach(btn => btn.addEventListener('click', () => {
  switchPeriod(btn.dataset.period);
  saveState();
}));

// ── 검색 파라미터 수집 ────────────────────
function getSearchParams() {
  if (currentPeriod === 'daily') {
    return { periodType: 'D', startDate: toYYYYMMDD(startDateD.value), endDate: toYYYYMMDD(endDateD.value) };
  }
  if (currentPeriod === 'weekly') {
    // startDateW.value는 Flatpickr가 YYYY-MM-DD 형식으로 저장
    const sr = getWeekRange(startDateW.value);
    const er = getWeekRange(endDateW.value);
    return { periodType: 'D', startDate: toYYYYMMDD(sr.start), endDate: toYYYYMMDD(er.end) };
  }
  // 월별: YYYY-MM-DD 에서 YYYYMM 추출
  const startMM = startDateM.value.slice(0, 7).replace('-', '');
  const endMM   = endDateM.value.slice(0, 7).replace('-', '');
  return { periodType: 'M', startDate: startMM, endDate: endMM };
}

// ── UI 상태 초기화 ────────────────────────
function clearUI() {
  loadingEl.classList.add('hidden');
  errorEl.classList.add('hidden');
  emptyEl.classList.add('hidden');
  summaryCards.style.display    = 'none';
  platformSection.style.display = 'none';
  tableSection.style.display    = 'none';
  chartSection.style.display    = 'none';
  resultBody.innerHTML          = '';
  platformCardsEl.innerHTML     = '';
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.remove('hidden');
}

// ── 광고단위명 필터 옵션 업데이트 ─────────
function updateAdunitFilter(rows) {
  const names = [...new Set(rows.map(r => r.adunitName).filter(Boolean))].sort();
  mcsAdunit.refresh(names);
  if (pendingAdunits.length) { mcsAdunit.setSelected(pendingAdunits); pendingAdunits = []; }
  if (mcsCmpAdunit) {
    const cmpNames = [...new Set([...rows, ...allRowsB].map(r => r.adunitName).filter(Boolean))].sort();
    mcsCmpAdunit.refresh(cmpNames);
  }
}

// ── 광고단위 ID 필터 옵션 업데이트 ─────────
function updateAdunitIdFilter(rows) {
  const ids = [...new Set(rows.map(r => r.adunitId).filter(Boolean))].sort();
  mcsAdunitId.refresh(ids);
  if (pendingAdunitIds.length) { mcsAdunitId.setSelected(pendingAdunitIds); pendingAdunitIds = []; }
  if (mcsCmpAdunitId) {
    const cmpIds = [...new Set([...rows, ...allRowsB].map(r => r.adunitId).filter(Boolean))].sort();
    mcsCmpAdunitId.refresh(cmpIds);
  }
}

// ── 필터 적용 ────────────────────────────
function applyFiltersA(rows) {
  let result = [...rows];
  const adunits   = mcsAdunit   ? mcsAdunit.getSelected()   : [];
  const adunitIds = mcsAdunitId ? mcsAdunitId.getSelected() : [];
  const platforms = mcsPlatform ? mcsPlatform.getSelected() : [];
  if (adunits.length)   result = result.filter(r => adunits.includes(r.adunitName));
  if (adunitIds.length) result = result.filter(r => adunitIds.includes(r.adunitId));
  if (platforms.length) {
    const expanded = new Set(platforms);
    if (expanded.has('App 전체')) { expanded.add('App iOS'); expanded.add('App Android'); }
    result = result.filter(r => expanded.has(r._platform));
  }
  return result;
}

function applyFiltersB() {
  const hasCmpDates = !!(cmpStartDateEl.value && cmpEndDateEl.value);
  const adunits   = mcsCmpAdunit   ? mcsCmpAdunit.getSelected()   : [];
  const adunitIds = mcsCmpAdunitId ? mcsCmpAdunitId.getSelected() : [];
  const platforms = mcsCmpPlatform ? mcsCmpPlatform.getSelected() : [];

  // 비교 기간이 없고 필터 선택도 없으면 비교 없음
  if (!hasCmpDates && !adunits.length && !adunitIds.length && !platforms.length) return [];

  // 비교 기간이 설정된 경우 allRowsB 사용, 아니면 allRows 공유
  const source = hasCmpDates ? allRowsB : allRows;
  if (!source.length) return [];

  let result = [...source];
  if (adunits.length)   result = result.filter(r => adunits.includes(r.adunitName));
  if (adunitIds.length) result = result.filter(r => adunitIds.includes(r.adunitId));
  if (platforms.length) {
    const expanded = new Set(platforms);
    if (expanded.has('App 전체')) { expanded.add('App iOS'); expanded.add('App Android'); }
    result = result.filter(r => expanded.has(r._platform));
  }
  return result;
}

// ── 주별 그룹핑 ───────────────────────────
function groupByWeek(rows) {
  const map = new Map();
  rows.forEach(r => {
    const dateStr = (r.day || r.month || '').slice(0, 8);
    if (!dateStr) return;
    const isoDate = `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}`;
    const wr  = getWeekRange(isoDate);
    const key = `${r.adunitId}__${r.mediaId}__${wr.start}`;
    if (!map.has(key)) {
      map.set(key, { ...r, _weekLabel: `${wr.start} ~ ${wr.end}`, request: 0, response: 0, impression: 0, click: 0, profit: 0 });
    }
    const g = map.get(key);
    g.request    += r.request    || 0;
    g.response   += r.response   || 0;
    g.impression += r.impression || 0;
    g.click      += r.click      || 0;
    g.profit     += r.profit     || 0;
  });
  return [...map.values()].sort((a, b) => a._weekLabel.localeCompare(b._weekLabel));
}

// ── 클립보드 복사 ────────────────────────
const COPY_SVG  = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const CHECK_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

function copyBtn(rawValue) {
  return `<button class="copy-btn" data-raw="${rawValue}" title="숫자 복사">${COPY_SVG}</button>`;
}
document.addEventListener('click', e => {
  const btn = e.target.closest('.copy-btn');
  if (!btn) return;
  navigator.clipboard.writeText(btn.dataset.raw).then(() => {
    btn.innerHTML = CHECK_SVG;
    btn.classList.add('copied');
    setTimeout(() => { btn.innerHTML = COPY_SVG; btn.classList.remove('copied'); }, 1500);
  });
});

// ── 요약 카드 렌더 ───────────────────────
function rpmFmt(n) {
  return Number(n).toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '원';
}

function renderSummary(rowsA, rowsB = []) {
  const hasCmp = rowsB.length > 0;

  function stats(rows) {
    const profit = rows.reduce((s, r) => s + (r.profit     || 0), 0);
    const imp    = rows.reduce((s, r) => s + (r.impression || 0), 0);
    const clk    = rows.reduce((s, r) => s + (r.click      || 0), 0);
    const req    = rows.reduce((s, r) => s + (r.request    || 0), 0);
    return { profit, imp, clk, req,
      ctr:     imp ? ((clk / imp) * 100).toFixed(2) : '0.00',
      impRpm:  imp ? (profit / imp) * 1000 : 0,
      reqRpm:  req ? (profit / req) * 1000 : 0,
      impRate: req ? ((imp / req) * 100).toFixed(2) : '0.00',
    };
  }

  const a = stats(rowsA);
  const b = hasCmp ? stats(rowsB) : null;

  function cell(val, raw, titleTxt, cls) {
    return `<span class="${cls}" title="${titleTxt}"><span>${val}</span>${copyBtn(raw)}</span>`;
  }
  function cellNoCopy(val, titleTxt, cls) {
    return `<span class="${cls}" title="${titleTxt}"><span>${val}</span></span>`;
  }

  function setEl(id, aVal, aRaw, bVal, bRaw, titleA, titleB) {
    const el = document.getElementById(id);
    if (!el) return;
    if (!hasCmp) {
      el.innerHTML = `<span>${aVal}</span>${copyBtn(aRaw)}`;
    } else {
      el.innerHTML = cell(aVal, aRaw, titleA, 'cv-primary') + cell(bVal, bRaw, titleB, 'cv-compare');
    }
  }
  function setElNoCopy(id, aVal, bVal, titleA, titleB) {
    const el = document.getElementById(id);
    if (!el) return;
    if (!hasCmp) {
      el.innerHTML = `<span>${aVal}</span>`;
    } else {
      el.innerHTML = cellNoCopy(aVal, titleA, 'cv-primary') + cellNoCopy(bVal, titleB, 'cv-compare');
    }
  }

  const tA = '기본 필터', tB = '비교 필터';

  setEl('total-profit',     won(a.profit),    a.profit,    hasCmp ? won(b.profit)    : '', hasCmp ? b.profit    : 0, tA, tB);
  setEl('total-impression', comma(a.imp),     a.imp,       hasCmp ? comma(b.imp)     : '', hasCmp ? b.imp       : 0, tA, tB);
  setEl('total-click',      comma(a.clk),     a.clk,       hasCmp ? comma(b.clk)     : '', hasCmp ? b.clk       : 0, tA, tB);
  setElNoCopy('total-ctr',  a.ctr + '%',      hasCmp ? b.ctr + '%' : '', tA, tB);
  setEl('total-imp-rpm',    rpmFmt(a.impRpm), a.impRpm,    hasCmp ? rpmFmt(b.impRpm) : '', hasCmp ? b.impRpm    : 0, tA, tB);
  setEl('total-req-rpm',    rpmFmt(a.reqRpm), a.reqRpm,    hasCmp ? rpmFmt(b.reqRpm) : '', hasCmp ? b.reqRpm    : 0, tA, tB);
  setElNoCopy('total-imp-rate', a.impRate + '%', hasCmp ? b.impRate + '%' : '', tA, tB);

  summaryCards.style.display = '';
}

// ── 플랫폼별 카드 렌더 ───────────────────
function renderPlatformCards(rows) {
  const map = new Map();
  rows.forEach(r => {
    const p = r._platform || '기타';
    if (!map.has(p)) map.set(p, { profit: 0, impression: 0, click: 0 });
    const g = map.get(p);
    g.profit     += r.profit     || 0;
    g.impression += r.impression || 0;
    g.click      += r.click      || 0;
  });
  const ORDER  = ['PC Web', 'Mobile Web', 'App iOS', 'App Android'];
  const sorted = [...map.entries()].sort((a, b) => {
    const ia = ORDER.indexOf(a[0]), ib = ORDER.indexOf(b[0]);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  platformCardsEl.innerHTML = sorted.map(([platform, data]) => `
    <div class="platform-card">
      <div class="p-name">${platform}</div>
      <div class="p-profit"><span>${won(data.profit)}</span>${copyBtn(data.profit)}</div>
      <div class="p-sub">노출 ${comma(data.impression)} / 클릭 ${comma(data.click)}</div>
    </div>
  `).join('');
  platformSection.style.display = '';
}

// ── 정렬 ─────────────────────────────────
function getSortValue(row, col) {
  switch (col) {
    case 'date':       return currentPeriod === 'weekly' ? (row._weekLabel || '') : (row.day || row.month || '');
    case 'adunitId':   return row.adunitId   || '';
    case 'adunit':     return row.adunitName || '';
    case 'request':    return row.request    || 0;
    case 'response':   return row.response   || 0;
    case 'impression': return row.impression || 0;
    case 'impRate':    return row.request    ? row.impression / row.request   : 0;
    case 'click':      return row.click      || 0;
    case 'ctr':        return row.impression ? row.click / row.impression    : 0;
    case 'profit':     return row.profit     || 0;
    case 'profitPct':  return row._profitPct || 0;
    default:           return '';
  }
}
function sortRows(rows) {
  if (!sortCol) return rows;
  return [...rows].sort((a, b) => {
    const va = getSortValue(a, sortCol);
    const vb = getSortValue(b, sortCol);
    if (typeof va === 'string') return va.localeCompare(vb) * sortDir;
    return (va - vb) * sortDir;
  });
}
function updateSortHeaders() {
  document.querySelectorAll('th[data-col]').forEach(th => {
    const active = th.dataset.col === sortCol;
    th.classList.toggle('sorted', active);
    const icon = th.querySelector('.sort-icon');
    if (icon) icon.textContent = active ? (sortDir === 1 ? '↑' : '↓') : '↕';
  });
}

// ── 테이블 렌더 ─────────────────────────
function renderTable(rowsA, rowsB = []) {
  const hasCmp = rowsB.length > 0;
  const combined = [
    ...rowsA.map(r => ({...r, _group: 'a'})),
    ...(hasCmp ? rowsB.map(r => ({...r, _group: 'b'})) : [])
  ];
  const totalP = combined.reduce((s, r) => s + (r.profit || 0), 0);
  combined.forEach(r => { r._profitPct = totalP > 0 ? (r.profit || 0) / totalP * 100 : 0; });

  const sorted = sortRows(combined);
  updateSortHeaders();
  rowCountEl.textContent = `총 ${sorted.length}건`;

  resultBody.innerHTML = sorted.map(r => {
    const dateLabel = currentPeriod === 'weekly'
      ? (r._weekLabel || '-')
      : formatDate(r.day || r.month);
    const distPct   = r._profitPct.toFixed(1) + '%';
    const groupCls  = hasCmp ? ` class="tr-group-${r._group}" title="${r._group === 'a' ? '기본 필터' : '비교 필터'}"` : '';
    return `<tr${groupCls}>
      <td>${dateLabel}</td>
      <td>${r.adunitId || '-'}</td>
      <td>${r.adunitName || '-'}</td>
      <td>${comma(r.request)}</td>
      <td>${comma(r.response)}</td>
      <td>${comma(r.impression)}</td>
      <td>${r.request ? ((r.impression / r.request) * 100).toFixed(2) + '%' : '0.00%'}</td>
      <td>${comma(r.click)}</td>
      <td>${pct(r.click, r.impression)}</td>
      <td class="profit-cell"><span class="profit-cell-inner"><span>${won(r.profit)}</span>${copyBtn(r.profit || 0)}</span></td>
      <td>${distPct}</td>
    </tr>`;
  }).join('');

  tableSection.style.display = '';
}

// ── CSV 다운로드 ──────────────────────────
function downloadCSV() {
  const displayRows = applyFiltersA(allRows);
  const totalP   = displayRows.reduce((s, r) => s + (r.profit     || 0), 0);
  const totalImp = displayRows.reduce((s, r) => s + (r.impression || 0), 0);
  const totalClk = displayRows.reduce((s, r) => s + (r.click      || 0), 0);
  const totalReq = displayRows.reduce((s, r) => s + (r.request    || 0), 0);
  const ctrVal    = totalImp ? ((totalClk / totalImp) * 100).toFixed(2) + '%' : '0.00%';
  const impRpmVal = totalImp ? ((totalP / totalImp) * 1000).toFixed(2) + '원' : '0.00원';
  const reqRpmVal = totalReq ? ((totalP / totalReq) * 1000).toFixed(2) + '원' : '0.00원';

  // 조회 기간 텍스트
  const { startDate, endDate } = getSearchParams();
  const periodLabel = `${formatDate(startDate)} ~ ${formatDate(endDate)}`;

  const esc = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const row = (...cols) => cols.map(esc).join(',');

  const lines = [
    row('조회 기간', periodLabel),
    row('총 수익 (적립금)', totalP),
    row('총 노출수', totalImp),
    row('총 클릭수', totalClk),
    row('클릭률 (CTR)', ctrVal),
    row('노출 RPM', impRpmVal),
    row('요청 RPM', reqRpmVal),
    '',
    row('날짜', '광고단위 ID', '광고단위명', '요청수', '응답수', '노출수', '노출율(%)', '클릭수', 'CTR', '수익 (적립금)', '분포'),
  ];

  displayRows.forEach(r => {
    r._profitPct = totalP > 0 ? (r.profit || 0) / totalP * 100 : 0;
  });
  sortRows(displayRows).forEach(r => {
    const dateLabel = currentPeriod === 'weekly'
      ? (r._weekLabel || '-') : formatDate(r.day || r.month);
    lines.push(row(
      dateLabel,
      r.adunitId   || '-',
      r.adunitName || '-',
      r.request    || 0,
      r.response   || 0,
      r.impression || 0,
      r.request ? ((r.impression / r.request) * 100).toFixed(2) + '%' : '0.00%',
      r.click      || 0,
      pct(r.click, r.impression),
      r.profit     || 0,
      r._profitPct.toFixed(1) + '%'
    ));
  });

  const csv  = lines.join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' }); // BOM for Excel
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `adfit_${startDate}_${endDate}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

csvBtn.addEventListener('click', downloadCSV);

// ── 차트 렌더 ────────────────────────────
function renderChart(rowsA, rowsB = []) {
  const hasCmp = rowsB.length > 0;

  function buildMap(rows) {
    const map = new Map();
    rows.forEach(r => {
      const label = currentPeriod === 'weekly' ? (r._weekLabel || '-') : formatDate(r.day || r.month);
      map.set(label, (map.get(label) || 0) + (r.profit || 0));
    });
    return map;
  }

  const mapA   = buildMap(rowsA);
  const mapB   = hasCmp ? buildMap(rowsB) : new Map();
  const labels = [...new Set([...mapA.keys(), ...mapB.keys()])].sort();
  const dataA  = labels.map(l => mapA.get(l) || 0);
  const dataB  = labels.map(l => mapB.get(l) || 0);

  const datasets = [
    { label: '기본 필터', data: dataA, backgroundColor: 'rgba(26,115,232,0.5)', borderColor: 'rgba(26,115,232,1)', borderWidth: 1.5, borderRadius: 4 },
    ...(hasCmp ? [{ label: '비교 필터', data: dataB, backgroundColor: 'rgba(234,67,53,0.45)', borderColor: 'rgba(234,67,53,1)', borderWidth: 1.5, borderRadius: 4 }] : [])
  ];

  chartSection.style.display = '';

  if (chartInstance) {
    chartInstance.data.labels   = labels;
    chartInstance.data.datasets = datasets;
    chartInstance.options.plugins.legend.display = hasCmp;
    chartInstance.update('active');
    return;
  }

  const ctx = document.getElementById('profit-chart').getContext('2d');
  chartInstance = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true,
      animation: { duration: 400 },
      plugins: {
        legend: { display: hasCmp },
        tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${won(ctx.parsed.y)}` } }
      },
      scales: { y: { ticks: { callback: v => won(v) } } }
    }
  });
}

// ── 메인 조회 ────────────────────────────
async function fetchAndRender() {
  clearUI();
  loadingEl.classList.remove('hidden');

  const params = getSearchParams();
  if (!params.startDate || !params.endDate) {
    loadingEl.classList.add('hidden');
    showError('날짜를 입력해주세요.');
    return;
  }

  try {
    const qs = new URLSearchParams(params).toString();

    let json;
    if (apiCache.has(qs)) {
      json = apiCache.get(qs);
    } else {
      const res = await fetch(`/api/report?${qs}`);
      json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      if (apiCache.size >= 20) apiCache.delete(apiCache.keys().next().value);
      apiCache.set(qs, json);
    }

    const rows = (json.rows || []).filter(r => isCafeUnit(r.adunitName));
    rows.forEach(r => { r._platform = guessPlatform(r); });
    allRows = rows;

    // 비교 기간 데이터 별도 fetch
    if (cmpStartDateEl.value && cmpEndDateEl.value) {
      try {
        const cmpParams = { periodType: 'D', startDate: toYYYYMMDD(cmpStartDateEl.value), endDate: toYYYYMMDD(cmpEndDateEl.value) };
        const cmpQs = new URLSearchParams(cmpParams).toString();
        const cmpCacheKey = 'cmp:' + cmpQs;
        let cmpJson;
        if (apiCache.has(cmpCacheKey)) {
          cmpJson = apiCache.get(cmpCacheKey);
        } else {
          const cmpRes = await fetch(`/api/report?${cmpQs}`);
          cmpJson = await cmpRes.json();
          if (cmpRes.ok) apiCache.set(cmpCacheKey, cmpJson);
        }
        allRowsB = (cmpJson.rows || []).filter(r => isCafeUnit(r.adunitName));
        allRowsB.forEach(r => { r._platform = guessPlatform(r); });
      } catch (_) { allRowsB = []; }
    } else {
      allRowsB = [];
    }

    loadingEl.classList.add('hidden');

    if (rows.length === 0) {
      emptyEl.classList.remove('hidden');
      return;
    }

    updateAdunitFilter(rows);
    updateAdunitIdFilter(rows);
    let rowsA = applyFiltersA(rows);
    let rowsB = applyFiltersB();
    if (currentPeriod === 'weekly') {
      rowsA = groupByWeek(rowsA);
      rowsB = rowsB.length ? groupByWeek(rowsB) : [];
    }

    renderSummary(rowsA, rowsB);
    renderPlatformCards(rowsA);

    requestAnimationFrame(() => {
      renderTable(rowsA, rowsB);
      requestAnimationFrame(() => renderChart(rowsA, rowsB));
    });

  } catch (err) {
    loadingEl.classList.add('hidden');
    showError(`데이터 조회 실패: ${err.message}`);
    console.error(err);
  }
}

// ── 필터 변경 시 재렌더 ──────────────────
function reRender() {
  if (allRows.length === 0) return;
  let rowsA = applyFiltersA(allRows);
  let rowsB = applyFiltersB();
  if (currentPeriod === 'weekly') {
    rowsA = groupByWeek(rowsA);
    rowsB = rowsB.length ? groupByWeek(rowsB) : [];
  }
  renderSummary(rowsA, rowsB);
  renderPlatformCards(rowsA);
  renderTable(rowsA, rowsB);
  renderChart(rowsA, rowsB);
}

searchBtn.addEventListener('click',  () => { saveState(); fetchAndRender(); });
document.addEventListener('keydown', e => { if (e.key === 'Enter') { saveState(); fetchAndRender(); } });

// ── 테이블 헤더 정렬 클릭 ─────────────────
document.querySelector('#result-table thead').addEventListener('click', e => {
  const th = e.target.closest('th[data-col]');
  if (!th || allRows.length === 0) return;
  const col = th.dataset.col;
  if (sortCol === col) {
    sortDir *= -1;
  } else {
    sortCol = col;
    sortDir = 1;
  }
  saveState();
  reRender();
});

// ── MultiCheckSelect (체크박스 복수선택 드롭다운) ──
class MultiCheckSelect {
  constructor(el, placeholder, onChange) {
    this.el          = el;
    this.placeholder = placeholder;
    this.onChange    = onChange;
    this.options     = [];
    this.selected    = new Set();
    this._build();
  }

  _build() {
    this.el.className = 'mcs-wrap';
    this.el.innerHTML = `
      <button type="button" class="mcs-trigger">
        <span class="mcs-label">${this.placeholder}</span>
        <span class="mcs-arrow">▾</span>
      </button>
      <div class="mcs-dropdown">
        <div class="mcs-tags-wrap"><div class="mcs-tags"></div></div>
        <input class="mcs-search" type="text" placeholder="검색...">
        <div class="mcs-actions">
          <button type="button" class="mcs-btn-all">모두 선택</button>
          <button type="button" class="mcs-btn-none">모두 지우기</button>
        </div>
        <div class="mcs-list"></div>
      </div>`;
    this._trigger  = this.el.querySelector('.mcs-trigger');
    this._dropdown = this.el.querySelector('.mcs-dropdown');
    this._search   = this.el.querySelector('.mcs-search');
    this._list     = this.el.querySelector('.mcs-list');
    this._label    = this.el.querySelector('.mcs-label');
    this._arrow    = this.el.querySelector('.mcs-arrow');

    this._trigger.addEventListener('click', e => {
      e.stopPropagation();
      const isOpen = this._dropdown.classList.contains('mcs-open');
      document.querySelectorAll('.mcs-dropdown.mcs-open').forEach(d => d.classList.remove('mcs-open'));
      document.querySelectorAll('.mcs-wrap .mcs-arrow').forEach(a => a.textContent = '▾');
      if (!isOpen) {
        this._dropdown.classList.add('mcs-open');
        this._arrow.textContent = '▴';
        setTimeout(() => this._search.focus(), 0);
      }
    });
    this.el.querySelector('.mcs-btn-all').addEventListener('click', e => {
      e.stopPropagation();
      this.options.forEach(o => this.selected.add(o.value));
      this._renderItems(); this._updateLabel(); this.onChange();
    });
    this.el.querySelector('.mcs-btn-none').addEventListener('click', e => {
      e.stopPropagation();
      this.selected.clear();
      this._renderItems(); this._updateLabel(); this.onChange();
    });
    this._search.addEventListener('input', () => this._renderItems());
    document.addEventListener('click', e => {
      if (!this.el.contains(e.target)) {
        this._dropdown.classList.remove('mcs-open');
        this._arrow.textContent = '▾';
      }
    });
  }

  _renderItems() {
    const q = this._search.value.toLowerCase();
    const visible = q ? this.options.filter(o => o.label.toLowerCase().includes(q)) : this.options;
    this._list.innerHTML = visible.map(o => `
      <label class="mcs-item">
        <input type="checkbox" value="${o.value}" ${this.selected.has(o.value) ? 'checked' : ''}>
        <span>${o.label}</span>
      </label>`).join('');
    this._list.querySelectorAll('input').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) this.selected.add(cb.value);
        else this.selected.delete(cb.value);
        this._updateLabel(); this.onChange();
      });
    });
  }

  _updateTags() {
    const wrap = this.el.querySelector('.mcs-tags-wrap');
    const tags = this.el.querySelector('.mcs-tags');
    if (!wrap || !tags) return;
    if (this.selected.size === 0) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    tags.innerHTML = [...this.selected].map(v =>
      `<span class="mcs-tag">${v}<button type="button" class="mcs-tag-x" data-val="${v.replace(/"/g,'&quot;')}">✕</button></span>`
    ).join('');
    tags.querySelectorAll('.mcs-tag-x').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        this.selected.delete(btn.dataset.val);
        this._renderItems(); this._updateLabel(); this.onChange();
      });
    });
  }

  _updateLabel() {
    const n = this.selected.size;
    this._label.textContent = n === 0 ? this.placeholder : `${n}개 선택됨`;
    this._updateTags();
  }

  refresh(options = []) {
    this.options = options.map(o => typeof o === 'string' ? { value: o, label: o } : o);
    const valid  = new Set(this.options.map(o => o.value));
    this.selected = new Set([...this.selected].filter(v => valid.has(v)));
    this._renderItems(); this._updateLabel();
  }

  setSelected(values) {
    this.selected = new Set(values.filter(v => this.options.some(o => o.value === v)));
    this._renderItems(); this._updateLabel();
  }

  getSelected() { return [...this.selected]; }
}

// ── MultiCheckSelect 초기화 ──────────────
function initMultiCheckSelects() {
  mcsAdunit   = new MultiCheckSelect(document.getElementById('mcs-adunit'),    '전체 광고단위명',  () => { saveState(); reRender(); });
  mcsAdunitId = new MultiCheckSelect(document.getElementById('mcs-adunit-id'), '전체 광고단위 ID', () => { saveState(); reRender(); });
  mcsPlatform = new MultiCheckSelect(document.getElementById('mcs-platform'),  '전체 플랫폼',     () => { saveState(); reRender(); });
  mcsPlatform.refresh([
    { value: 'PC Web',      label: 'PC Web'      },
    { value: 'Mobile Web',  label: 'Mobile Web'  },
    { value: 'App 전체',    label: 'App 전체'    },
    { value: 'App iOS',     label: 'App iOS'     },
    { value: 'App Android', label: 'App Android' },
  ]);
  if (pendingPlatforms.length) { mcsPlatform.setSelected(pendingPlatforms); pendingPlatforms = []; }
  mcsCmpAdunit   = new MultiCheckSelect(document.getElementById('mcs-cmp-adunit'),    '전체 광고단위명',  () => { reRender(); });
  mcsCmpAdunitId = new MultiCheckSelect(document.getElementById('mcs-cmp-adunit-id'), '전체 광고단위 ID', () => { reRender(); });
  mcsCmpPlatform = new MultiCheckSelect(document.getElementById('mcs-cmp-platform'),  '전체 플랫폼',     () => { reRender(); });
  mcsCmpPlatform.refresh([
    { value: 'PC Web',      label: 'PC Web'      },
    { value: 'Mobile Web',  label: 'Mobile Web'  },
    { value: 'App 전체',    label: 'App 전체'    },
    { value: 'App iOS',     label: 'App iOS'     },
    { value: 'App Android', label: 'App Android' },
  ]);
}

// ── Flatpickr 초기화 (캘린더 안 빠른 선택 버튼) ──
function initFlatpickr() {
  // fp      : 이 캘린더의 Flatpickr 인스턴스
  // isStart : 시작 캘린더면 true, 종료 캘린더면 false
  // shortcuts: [{ label, startDate, endDate }] 배열
  // 단일 피커용 퀵버튼 (일별)
  function addShortcuts(calendarContainer, fp, shortcuts) {
    const wrap = document.createElement('div');
    wrap.className = 'fp-quick-btns';
    shortcuts.forEach(({ label, getDate }) => {
      const btn = document.createElement('button');
      btn.type        = 'button';
      btn.className   = 'fp-quick-btn';
      btn.textContent = label;
      btn.addEventListener('mousedown', e => {
        e.preventDefault();
        fp.setDate(getDate(), true);
        fp.close();
        saveState();
      });
      wrap.appendChild(btn);
    });
    calendarContainer.appendChild(wrap);
  }

  // 양쪽 피커 동시 제어 퀵버튼 (주별·월별)
  function addPairedShortcuts(calendarContainer, shortcuts) {
    const wrap = document.createElement('div');
    wrap.className = 'fp-quick-btns';
    shortcuts.forEach(({ label, action }) => {
      const btn = document.createElement('button');
      btn.type        = 'button';
      btn.className   = 'fp-quick-btn';
      btn.textContent = label;
      btn.addEventListener('mousedown', e => {
        e.preventDefault();
        action();
      });
      wrap.appendChild(btn);
    });
    calendarContainer.appendChild(wrap);
  }

  const baseOpts = { locale: 'ko', dateFormat: 'Y-m-d', disableMobile: true };

  // ─── 일별 ──────────────────────────────
  fpStart = flatpickr(startDateD, {
    ...baseOpts,
    defaultDate: startDateD.value || daysAgo(30),
    onChange(selectedDates) {
      if (selectedDates[0] && fpEnd.selectedDates[0] && selectedDates[0] > fpEnd.selectedDates[0]) {
        fpEnd.setDate(selectedDates[0], false);
      }
      saveState();
      setTimeout(() => fpEnd.open(), 50);
    },
    onReady(_, __, fp) {
      addShortcuts(fp.calendarContainer, fp, [
        { label: '오늘',      getDate: () => today() },
        { label: '어제',      getDate: () => daysAgo(1) },
        { label: '그저께',    getDate: () => daysAgo(2) },
        { label: '최근 7일',  getDate: () => daysAgo(6) },
        { label: '최근 30일', getDate: () => daysAgo(29) },
      ]);
    }
  });

  fpEnd = flatpickr(endDateD, {
    ...baseOpts,
    defaultDate: endDateD.value || today(),
    onChange(selectedDates) {
      if (selectedDates[0] && fpStart.selectedDates[0] && selectedDates[0] < fpStart.selectedDates[0]) {
        fpStart.setDate(selectedDates[0], false);
      }
      saveState();
    },
    onReady(_, __, fp) {
      addShortcuts(fp.calendarContainer, fp, [
        { label: '오늘',      getDate: () => today() },
        { label: '어제',      getDate: () => daysAgo(1) },
        { label: '그저께',    getDate: () => daysAgo(2) },
        { label: '최근 7일',  getDate: () => today() },
        { label: '최근 30일', getDate: () => today() },
      ]);
    }
  });

  // ─── 주별 ──────────────────────────────
  // 날짜 선택 시 해당 주 월~일 전체 자동 세팅
  const weeklyShortcuts = [
    { label: '이번 주',  action() { const r = getWeekRange(today());    fpStartW.setDate(r.start, false); fpEndW.setDate(r.end, false); saveState(); } },
    { label: '지난 주',  action() { const r = getWeekRange(daysAgo(7)); fpStartW.setDate(r.start, false); fpEndW.setDate(r.end, false); saveState(); } },
    { label: '최근 4주', action() { fpStartW.setDate(getWeekRange(daysAgo(27)).start, false); fpEndW.setDate(getWeekRange(today()).end, false); saveState(); } },
  ];

  fpStartW = flatpickr(startDateW, {
    ...baseOpts,
    defaultDate: startDateW.value || getWeekRange(daysAgo(27)).start,
    onChange(selectedDates) {
      if (!selectedDates[0]) { saveState(); return; }
      const r = getWeekRange(selectedDates[0].toISOString().slice(0, 10));
      fpStartW.setDate(r.start, false);  // 시작일 → 해당 주 월요일
      fpEndW.setDate(r.end, false);      // 종료일 → 해당 주 일요일
      saveState();
    },
    onReady(_, __, fp) { addPairedShortcuts(fp.calendarContainer, weeklyShortcuts); }
  });

  fpEndW = flatpickr(endDateW, {
    ...baseOpts,
    defaultDate: endDateW.value || getWeekRange(today()).end,
    onChange(selectedDates) {
      if (!selectedDates[0]) { saveState(); return; }
      const r = getWeekRange(selectedDates[0].toISOString().slice(0, 10));
      fpEndW.setDate(r.end, false);      // 종료일 → 해당 주 일요일
      // 종료 주 일요일이 시작일보다 이전이면 시작도 해당 주로 이동
      if (fpStartW.selectedDates[0] && new Date(r.end) < fpStartW.selectedDates[0]) {
        fpStartW.setDate(r.start, false);
      }
      saveState();
    },
    onReady(_, __, fp) { addPairedShortcuts(fp.calendarContainer, weeklyShortcuts); }
  });

  // ─── 월별 ──────────────────────────────
  // 날짜 선택 시 해당 월의 1일~말일 전체 자동 세팅
  const monthlyShortcuts = [
    { label: '이번 달',    action() { const r = monthRange(today());       fpStartM.setDate(r.start, false); fpEndM.setDate(r.end, false); saveState(); } },
    { label: '지난 달',    action() { const r = monthRange(monthsAgo(1));  fpStartM.setDate(r.start, false); fpEndM.setDate(r.end, false); saveState(); } },
    { label: '최근 3개월', action() { fpStartM.setDate(monthRange(monthsAgo(2)).start, false); fpEndM.setDate(monthRange(today()).end, false); saveState(); } },
  ];

  fpStartM = flatpickr(startDateM, {
    ...baseOpts,
    defaultDate: startDateM.value || monthRange(monthsAgo(2)).start,
    onChange(selectedDates) {
      if (!selectedDates[0]) { saveState(); return; }
      const r = monthRange(selectedDates[0].toISOString().slice(0, 10));
      fpStartM.setDate(r.start, false);  // 시작일 → 해당 월 1일
      fpEndM.setDate(r.end, false);      // 종료일 → 해당 월 말일
      saveState();
    },
    onReady(_, __, fp) { addPairedShortcuts(fp.calendarContainer, monthlyShortcuts); }
  });

  fpEndM = flatpickr(endDateM, {
    ...baseOpts,
    defaultDate: endDateM.value || monthRange(today()).end,
    onChange(selectedDates) {
      if (!selectedDates[0]) { saveState(); return; }
      const r = monthRange(selectedDates[0].toISOString().slice(0, 10));
      fpEndM.setDate(r.end, false);      // 종료일 → 해당 월 말일
      // 종료 월 말일이 시작일보다 이전이면 시작도 해당 월로 이동
      if (fpStartM.selectedDates[0] && new Date(r.end) < fpStartM.selectedDates[0]) {
        fpStartM.setDate(r.start, false);
      }
      saveState();
    },
    onReady(_, __, fp) { addPairedShortcuts(fp.calendarContainer, monthlyShortcuts); }
  });
}

// ── 비교 기간 Flatpickr 초기화 ──────────────
function initCmpFlatpickr() {
  const baseOpts = { locale: 'ko', dateFormat: 'Y-m-d', disableMobile: true };

  cmpFpStart = flatpickr(cmpStartDateEl, {
    ...baseOpts,
    placeholder: '비교 시작일',
    onChange(selectedDates) {
      if (selectedDates[0] && cmpFpEnd.selectedDates[0] && selectedDates[0] > cmpFpEnd.selectedDates[0]) {
        cmpFpEnd.setDate(selectedDates[0], false);
      }
      setTimeout(() => cmpFpEnd.open(), 50);
    }
  });

  cmpFpEnd = flatpickr(cmpEndDateEl, {
    ...baseOpts,
    placeholder: '비교 종료일',
    onChange(selectedDates) {
      if (selectedDates[0] && cmpFpStart.selectedDates[0] && selectedDates[0] < cmpFpStart.selectedDates[0]) {
        cmpFpStart.setDate(selectedDates[0], false);
      }
    }
  });

  cmpDateClearBtn.addEventListener('click', () => {
    cmpFpStart.clear();
    cmpFpEnd.clear();
    allRowsB = [];
    reRender();
  });
}

// ── 초기화 ───────────────────────────────
initDates();                           // 기본값 먼저 세팅
const hadSavedState = restoreState();  // 저장된 조건으로 덮어씌우기
initMultiCheckSelects();
initFlatpickr();
initCmpFlatpickr();
if (hadSavedState) fetchAndRender();   // 저장 조건 있으면 자동 조회

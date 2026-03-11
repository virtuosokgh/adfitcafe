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
let pendingAdunit   = '';     // 새로고침 복원용 광고단위명 임시 저장
let pendingAdunitId = '';     // 새로고침 복원용 광고단위 ID 임시 저장
let fpStart  = null;          // 일별 Flatpickr 시작일
let fpEnd    = null;          // 일별 Flatpickr 종료일
let fpStartW = null;          // 주별 Flatpickr 시작
let fpEndW   = null;          // 주별 Flatpickr 종료
let fpStartM = null;          // 월별 Flatpickr 시작
let fpEndM   = null;          // 월별 Flatpickr 종료
let ssAdunit   = null;        // SearchableSelect 인스턴스 (광고단위명)
let ssAdunitId = null;        // SearchableSelect 인스턴스 (광고단위 ID)
let ssPlatform = null;        // SearchableSelect 인스턴스 (플랫폼)

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
const adunitFilter   = document.getElementById('adunit-filter');
const adunitIdFilter = document.getElementById('adunit-id-filter');
const platformFilter = document.getElementById('platform-filter');
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
    adunit:    adunitFilter.value,
    adunitId:  adunitIdFilter.value,
    platform:  platformFilter.value,
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

      if (s.platform)  platformFilter.value = s.platform;  // 정적 옵션이므로 바로 복원
      if (s.adunit)    pendingAdunit         = s.adunit;    // 동적 옵션: 조회 후 복원
      if (s.adunitId)  pendingAdunitId       = s.adunitId;  // 동적 옵션: 조회 후 복원
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
  const names   = [...new Set(rows.map(r => r.adunitName).filter(Boolean))].sort();
  const current = pendingAdunit || adunitFilter.value;
  pendingAdunit = '';
  adunitFilter.innerHTML = '<option value="">전체 광고단위명</option>';
  names.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    if (name === current) opt.selected = true;
    adunitFilter.appendChild(opt);
  });
  if (ssAdunit) ssAdunit.refresh(); // SearchableSelect UI 동기화
}

// ── 광고단위 ID 필터 옵션 업데이트 ─────────
function updateAdunitIdFilter(rows) {
  const ids     = [...new Set(rows.map(r => r.adunitId).filter(Boolean))].sort();
  const current = pendingAdunitId || adunitIdFilter.value;
  pendingAdunitId = '';
  adunitIdFilter.innerHTML = '<option value="">전체 광고단위 ID</option>';
  ids.forEach(id => {
    const opt = document.createElement('option');
    opt.value = id; opt.textContent = id;
    if (id === current) opt.selected = true;
    adunitIdFilter.appendChild(opt);
  });
  if (ssAdunitId) ssAdunitId.refresh(); // SearchableSelect UI 동기화
}

// ── 필터 적용 ────────────────────────────
function applyFilters(rows) {
  let result = [...rows];
  const adunit   = adunitFilter.value;
  const adunitId = adunitIdFilter.value;
  const platform = platformFilter.value;
  if (adunit)   result = result.filter(r => r.adunitName === adunit);
  if (adunitId) result = result.filter(r => r.adunitId   === adunitId);
  if (platform) result = result.filter(r => r._platform  === platform);
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

function renderSummary(rows) {
  const profit = rows.reduce((s, r) => s + (r.profit     || 0), 0);
  const imp    = rows.reduce((s, r) => s + (r.impression || 0), 0);
  const clk    = rows.reduce((s, r) => s + (r.click      || 0), 0);
  const req    = rows.reduce((s, r) => s + (r.request    || 0), 0);
  const ctrNum    = imp ? ((clk / imp) * 100).toFixed(2)   : '0.00';
  const impRpmNum = imp ? ((profit / imp) * 1000).toFixed(2) : '0.00';
  const reqRpmNum = req ? ((profit / req) * 1000).toFixed(2) : '0.00';

  totalProfit.innerHTML     = `<span>${won(profit)}</span>${copyBtn(profit)}`;
  totalImpression.innerHTML = `<span>${comma(imp)}</span>${copyBtn(imp)}`;
  totalClick.innerHTML      = `<span>${comma(clk)}</span>${copyBtn(clk)}`;
  totalCtr.innerHTML        = `<span>${ctrNum}%</span>${copyBtn(ctrNum)}`;
  document.getElementById('total-imp-rpm').innerHTML = `<span>${rpmFmt(impRpmNum)}</span>${copyBtn(impRpmNum)}`;
  document.getElementById('total-req-rpm').innerHTML = `<span>${rpmFmt(reqRpmNum)}</span>${copyBtn(reqRpmNum)}`;
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
    case 'click':      return row.click      || 0;
    case 'ctr':        return row.impression ? row.click / row.impression : 0;
    case 'profit':     return row.profit     || 0;
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
function renderTable(rows) {
  const sorted = sortRows(rows);
  updateSortHeaders();
  rowCountEl.textContent = `총 ${sorted.length}건`;

  resultBody.innerHTML = sorted.map(r => {
    const dateLabel = currentPeriod === 'weekly'
      ? (r._weekLabel || '-')
      : formatDate(r.day || r.month);
    return `<tr>
      <td>${dateLabel}</td>
      <td title="${r.adunitId || ''}">${r.adunitId || '-'}</td>
      <td title="${r.adunitName || ''}">${r.adunitName || '-'}</td>
      <td>${comma(r.request)}</td>
      <td>${comma(r.response)}</td>
      <td>${comma(r.impression)}</td>
      <td>${comma(r.click)}</td>
      <td>${pct(r.click, r.impression)}</td>
      <td class="profit-cell"><span class="profit-cell-inner"><span>${won(r.profit)}</span>${copyBtn(r.profit || 0)}</span></td>
    </tr>`;
  }).join('');

  tableSection.style.display = '';
}

// ── 차트 렌더 ────────────────────────────
function renderChart(rows) {
  const map = new Map();
  rows.forEach(r => {
    const label = currentPeriod === 'weekly'
      ? (r._weekLabel || '-')
      : formatDate(r.day || r.month);
    map.set(label, (map.get(label) || 0) + (r.profit || 0));
  });
  const labels = [...map.keys()].sort();
  const data   = labels.map(l => map.get(l));

  chartSection.style.display = '';

  if (chartInstance) {
    chartInstance.data.labels           = labels;
    chartInstance.data.datasets[0].data = data;
    chartInstance.update('active');
    return;
  }

  const ctx = document.getElementById('profit-chart').getContext('2d');
  chartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: '수익 (원)',
        data,
        backgroundColor: 'rgba(26,115,232,0.5)',
        borderColor: 'rgba(26,115,232,1)',
        borderWidth: 1.5,
        borderRadius: 4
      }]
    },
    options: {
      responsive: true,
      animation: { duration: 400 },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => won(ctx.parsed.y) } }
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

    loadingEl.classList.add('hidden');

    if (rows.length === 0) {
      emptyEl.classList.remove('hidden');
      return;
    }

    updateAdunitFilter(rows);
    updateAdunitIdFilter(rows);
    let displayRows = applyFilters(rows);
    if (currentPeriod === 'weekly') displayRows = groupByWeek(displayRows);

    renderSummary(displayRows);
    renderPlatformCards(displayRows);

    requestAnimationFrame(() => {
      renderTable(displayRows);
      requestAnimationFrame(() => renderChart(displayRows));
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
  let displayRows = applyFilters(allRows);
  if (currentPeriod === 'weekly') displayRows = groupByWeek(displayRows);
  renderSummary(displayRows);
  renderPlatformCards(displayRows);
  renderTable(displayRows);
  renderChart(displayRows);
}

adunitFilter.addEventListener('change',   () => { saveState(); reRender(); });
adunitIdFilter.addEventListener('change', () => { saveState(); reRender(); });
platformFilter.addEventListener('change', () => { saveState(); reRender(); });
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

// ── SearchableSelect (검색 가능한 드롭다운) ──
class SearchableSelect {
  constructor(selectEl) {
    this.el = selectEl;
    this._build();
    this._bind();
  }

  _build() {
    const wrap = document.createElement('div');
    wrap.className = 'ss-wrap';

    const display = document.createElement('input');
    display.type = 'text';
    display.className = 'ss-display';
    display.placeholder = this.el.options[0]?.text || '';
    display.autocomplete = 'off';
    display.readOnly = true;

    const panel = document.createElement('div');
    panel.className = 'ss-panel';

    const search = document.createElement('input');
    search.type = 'text';
    search.className = 'ss-search';
    search.placeholder = '검색...';

    const list = document.createElement('div');
    list.className = 'ss-list';

    panel.append(search, list);
    this.el.insertAdjacentElement('afterend', wrap);
    wrap.append(display, panel, this.el);

    this.wrap    = wrap;
    this.display = display;
    this.panel   = panel;
    this.search  = search;
    this.list    = list;

    this.refresh();
  }

  _bind() {
    // 디스플레이 클릭 → 드롭다운 토글
    this.display.addEventListener('click', () => this._toggle());

    // 검색 입력 → 리스트 필터
    this.search.addEventListener('input', () => this._renderList(this.search.value));

    // 옵션 선택
    this.list.addEventListener('mousedown', e => {
      const item = e.target.closest('.ss-option');
      if (!item) return;
      e.preventDefault();
      this._select(item.dataset.value);
    });

    // 외부 클릭 시 닫기
    document.addEventListener('click', e => {
      if (!this.wrap.contains(e.target)) this._close();
    });

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') this._close();
    });
  }

  _renderList(filter = '') {
    const q = filter.toLowerCase();
    const items = [...this.el.options].filter(o => !q || o.text.toLowerCase().includes(q));
    this.list.innerHTML = items.map(o =>
      `<div class="ss-option${o.value === this.el.value ? ' active' : ''}" data-value="${o.value}">${o.text}</div>`
    ).join('');
  }

  _open() {
    this.wrap.classList.add('ss-is-open');
    this.search.value = '';
    this._renderList('');
    setTimeout(() => this.search.focus(), 0);
  }

  _close() {
    this.wrap.classList.remove('ss-is-open');
    this.search.value = '';
  }

  _toggle() {
    this.wrap.classList.contains('ss-is-open') ? this._close() : this._open();
  }

  _select(val) {
    this.el.value = val;
    const opt = [...this.el.options].find(o => o.value === val);
    this.display.value = (opt && opt.value) ? opt.text : '';
    this._close();
    this._renderList('');
    this.el.dispatchEvent(new Event('change'));
  }

  // 원본 select 옵션/값 변경 후 UI 갱신 (updateAdunitFilter 등 호출 후 사용)
  refresh() {
    this._renderList(this.search?.value || '');
    const opt = [...this.el.options].find(o => o.value === this.el.value);
    this.display.value = (opt && opt.value) ? opt.text : '';
  }

  getValue() { return this.el.value; }
}

// ── SearchableSelect 초기화 ───────────────
function initSearchableSelects() {
  ssAdunit   = new SearchableSelect(adunitFilter);
  ssAdunitId = new SearchableSelect(adunitIdFilter);
  ssPlatform = new SearchableSelect(platformFilter);

  // SearchableSelect가 select를 숨기므로 플랫폼 복원값 반영
  if (ssPlatform) ssPlatform.refresh();
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

// ── 초기화 ───────────────────────────────
initDates();                           // 기본값 먼저 세팅
const hadSavedState = restoreState();  // 저장된 조건으로 덮어씌우기
initSearchableSelects();               // SearchableSelect 초기화 (select 상태 반영)
initFlatpickr();                       // Flatpickr 초기화 (복원값을 defaultDate로 사용)
if (hadSavedState) fetchAndRender();   // 저장 조건 있으면 자동 조회

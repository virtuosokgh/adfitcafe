/* =========================================
   카페 애드핏 대시보드 - app.js
   ========================================= */

// ── 상태 변수 ──────────────────────────────
let currentPeriod = 'daily'; // 'daily' | 'weekly' | 'monthly'
let allRows = [];             // 필터 전 원본(카페/테이블만)
let chartInstance = null;
const apiCache = new Map();   // API 응답 캐시 (같은 조건 재조회 시 즉시 반환)

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
function toYYYYMMDD(dateStr) { return dateStr.replace(/-/g, ''); }
function toYYYYMM(monthStr)  { return monthStr.replace(/-/g, ''); }
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

// ── ISO 주차 ↔ input[type=week] 변환 ────────────
function getISOWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
  const week1 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d - week1) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
}
function getISOWeekYear(date) {
  const d = new Date(date);
  d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
  return d.getFullYear();
}
/** 날짜 문자열 → "YYYY-Www" (input[type=week] 값 형식) */
function dateToWeekInput(dateStr) {
  const d = new Date(dateStr);
  const week = getISOWeek(d);
  const year = getISOWeekYear(d);
  return `${year}-W${String(week).padStart(2, '0')}`;
}
/** "YYYY-Www" → { start: 'YYYY-MM-DD'(월), end: 'YYYY-MM-DD'(일) } */
function weekInputToRange(weekStr) {
  const [yearStr, weekPart] = weekStr.split('-W');
  const year = parseInt(yearStr);
  const week = parseInt(weekPart);
  // ISO week 1의 월요일: Jan 4는 항상 1주차 안에 있음
  const jan4 = new Date(year, 0, 4);
  const dayOfWeek = (jan4.getDay() + 6) % 7; // 0=Mon…6=Sun
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

  // 주별: 최근 4주 (input[type=week] 형식)
  startDateW.value = dateToWeekInput(daysAgo(27));
  endDateW.value   = dateToWeekInput(t);

  // 월별: 최근 3개월
  const d3m = new Date();
  d3m.setMonth(d3m.getMonth() - 2);
  startDateM.value = d3m.toISOString().slice(0, 7);
  endDateM.value   = t.slice(0, 7);
}

// ── 탭 전환 ──────────────────────────────
function switchPeriod(period) {
  currentPeriod = period;
  tabBtns.forEach(b => b.classList.toggle('active', b.dataset.period === period));
  Object.entries(dateRanges).forEach(([p, id]) => {
    document.getElementById(id).classList.toggle('hidden', p !== period);
  });
}
tabBtns.forEach(btn => btn.addEventListener('click', () => switchPeriod(btn.dataset.period)));

// ── 검색 파라미터 수집 ────────────────────
function getSearchParams() {
  if (currentPeriod === 'daily') {
    return { periodType: 'D', startDate: toYYYYMMDD(startDateD.value), endDate: toYYYYMMDD(endDateD.value) };
  }
  if (currentPeriod === 'weekly') {
    const sr = weekInputToRange(startDateW.value);
    const er = weekInputToRange(endDateW.value);
    return { periodType: 'D', startDate: toYYYYMMDD(sr.start), endDate: toYYYYMMDD(er.end) };
  }
  return { periodType: 'M', startDate: toYYYYMM(startDateM.value), endDate: toYYYYMM(endDateM.value) };
}

// ── UI 상태 초기화 ────────────────────────
function clearUI() {
  loadingEl.classList.add('hidden');
  errorEl.classList.add('hidden');
  emptyEl.classList.add('hidden');
  summaryCards.style.display   = 'none';
  platformSection.style.display = 'none';
  tableSection.style.display   = 'none';
  chartSection.style.display   = 'none';
  resultBody.innerHTML         = '';
  platformCardsEl.innerHTML    = '';
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.remove('hidden');
}

// ── 광고단위 필터 옵션 업데이트 ────────────
function updateAdunitFilter(rows) {
  const names = [...new Set(rows.map(r => r.adunitName).filter(Boolean))].sort();
  const current = adunitFilter.value;
  adunitFilter.innerHTML = '<option value="">전체 광고단위</option>';
  names.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    if (name === current) opt.selected = true;
    adunitFilter.appendChild(opt);
  });
}

// ── 필터 적용 ────────────────────────────
function applyFilters(rows) {
  let result = [...rows];
  const adunit   = adunitFilter.value;
  const platform = platformFilter.value;
  if (adunit)   result = result.filter(r => r.adunitName === adunit);
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
function renderSummary(rows) {
  const profit = rows.reduce((s, r) => s + (r.profit     || 0), 0);
  const imp    = rows.reduce((s, r) => s + (r.impression || 0), 0);
  const clk    = rows.reduce((s, r) => s + (r.click      || 0), 0);
  const ctrNum = imp ? ((clk / imp) * 100).toFixed(2) : '0.00';
  totalProfit.innerHTML     = `<span>${won(profit)}</span>${copyBtn(profit)}`;
  totalImpression.innerHTML = `<span>${comma(imp)}</span>${copyBtn(imp)}`;
  totalClick.innerHTML      = `<span>${comma(clk)}</span>${copyBtn(clk)}`;
  totalCtr.innerHTML        = `<span>${ctrNum}%</span>${copyBtn(ctrNum)}`;
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
  platformCardsEl.innerHTML = '';
  sorted.forEach(([platform, data]) => {
    const div = document.createElement('div');
    div.className = 'platform-card';
    div.innerHTML = `
      <div class="p-name">${platform}</div>
      <div class="p-profit"><span>${won(data.profit)}</span>${copyBtn(data.profit)}</div>
      <div class="p-sub">노출 ${comma(data.impression)} / 클릭 ${comma(data.click)}</div>
    `;
    platformCardsEl.appendChild(div);
  });
  platformSection.style.display = '';
}

// ── 테이블 렌더 ─────────────────────────
function renderTable(rows) {
  resultBody.innerHTML = '';
  rowCountEl.textContent = `총 ${rows.length}건`;
  rows.forEach(r => {
    const dateLabel = currentPeriod === 'weekly'
      ? (r._weekLabel || '-')
      : formatDate(r.day || r.month);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${dateLabel}</td>
      <td>${r._platform || r.mediaName || '-'}</td>
      <td>${r.adunitName || '-'}</td>
      <td>${comma(r.request)}</td>
      <td>${comma(r.response)}</td>
      <td>${comma(r.impression)}</td>
      <td>${comma(r.click)}</td>
      <td>${pct(r.click, r.impression)}</td>
      <td class="profit-cell"><span class="profit-cell-inner"><span>${won(r.profit)}</span>${copyBtn(r.profit || 0)}</span></td>
    `;
    resultBody.appendChild(tr);
  });
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
  if (chartInstance) chartInstance.destroy();
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

    // ── 캐시 히트 시 즉시 반환 ──────────────
    let json;
    if (apiCache.has(qs)) {
      json = apiCache.get(qs);
    } else {
      const res = await fetch(`/api/report?${qs}`);
      json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      // 캐시 저장 (최대 20개 유지)
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
    let displayRows = applyFilters(rows);
    if (currentPeriod === 'weekly') displayRows = groupByWeek(displayRows);

    renderSummary(displayRows);
    renderPlatformCards(displayRows);
    renderTable(displayRows);
    renderChart(displayRows);

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

adunitFilter.addEventListener('change', reRender);
platformFilter.addEventListener('change', reRender);
searchBtn.addEventListener('click', fetchAndRender);
document.addEventListener('keydown', e => { if (e.key === 'Enter') fetchAndRender(); });

// ── 초기화 ───────────────────────────────
initDates();
switchPeriod('daily');

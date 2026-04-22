/* =========================================
   카페 네이버 수익 대시보드 - naver.js
   (app.js 이후 로드: won, comma, rpmFmt, COPY_SVG, getWeekRange, monthRange,
    daysAgo, monthsAgo, today, MultiCheckSelect 공유)
   ========================================= */

// ── 캐시 키 ──────────────────────────────────
const NAVER_CACHE_KEY = 'naver_csv_cache';

// ── 상태 변수 ──────────────────────────────
let naverAllRows       = [];
let naverChartInstance = null;
let naverHoveredIdx    = null;
let naverSortCol       = null;
let naverSortDir       = 1;
let naverCurrentPeriod = 'daily';
let naverMcsAdId       = null;
let naverMcsCmpAdId    = null; // 비교 광고ID MCS
let naverChartMetric   = 'profit'; // 차트 지표
let naverCmpFpStartD   = null; // 비교 시작일
let naverCmpFpEndD     = null; // 비교 종료일
let naverFpStartD = null, naverFpEndD = null;
let naverFpStartW = null, naverFpEndW = null;
let naverFpStartM = null, naverFpEndM = null;

// ── DOM 참조 ──────────────────────────────
const naverCmpStartDateEl = document.getElementById('naver-cmp-start-d');
const naverCmpEndDateEl   = document.getElementById('naver-cmp-end-d');
const naverCmpClearBtn    = document.getElementById('naver-cmp-date-clear');
const pnavBtns             = document.querySelectorAll('.pnav-btn');
const adfitSection         = document.getElementById('adfit-section');
const naverSection         = document.getElementById('naver-section');
const naverUploadZone      = document.getElementById('naver-upload-zone');
const naverCsvInput        = document.getElementById('naver-csv-input');
const naverFileInfo        = document.getElementById('naver-file-info');
const naverFileNameEl      = document.getElementById('naver-file-name');
const naverFileResetBtn    = document.getElementById('naver-file-reset');
const naverPeriodTabsEl    = document.getElementById('naver-period-tabs');
const naverControls        = document.getElementById('naver-controls');
const naverStartDateD      = document.getElementById('naver-start-d');
const naverEndDateD        = document.getElementById('naver-end-d');
const naverStartDateW      = document.getElementById('naver-start-w');
const naverEndDateW        = document.getElementById('naver-end-w');
const naverStartDateM      = document.getElementById('naver-start-m');
const naverEndDateM        = document.getElementById('naver-end-m');
const naverSummaryCards    = document.getElementById('naver-summary-cards');
const naverPlatformSection = document.getElementById('naver-platform-section');
const naverPlatformCards   = document.getElementById('naver-platform-cards');
const naverChartSection    = document.getElementById('naver-chart-section');
const naverTableSection    = document.getElementById('naver-table-section');
const naverResultBody      = document.getElementById('naver-result-body');
const naverRowCountEl      = document.getElementById('naver-row-count');
const naverCsvDlBtn        = document.getElementById('naver-csv-dl-btn');

// ── 플랫폼 네비게이션 ─────────────────────
const PNAV_KEY = 'pnav_active';

function switchPNav(target) {
  pnavBtns.forEach(b => b.classList.toggle('active', b.dataset.pnav === target));
  adfitSection.classList.toggle('hidden', target !== 'adfit');
  naverSection.classList.toggle('hidden', target !== 'naver');
  const googleSection = document.getElementById('google-section');
  if (googleSection) googleSection.classList.toggle('hidden', target !== 'google');
  const compareSection = document.getElementById('compare-section');
  if (compareSection) compareSection.classList.toggle('hidden', target !== 'compare');
  localStorage.setItem(PNAV_KEY, target);
}

pnavBtns.forEach(btn => btn.addEventListener('click', () => switchPNav(btn.dataset.pnav)));

(function () {
  const saved = localStorage.getItem(PNAV_KEY);
  if (['naver', 'google', 'compare'].includes(saved)) switchPNav(saved);
})();

// ── 기간 탭 전환 ──────────────────────────
function switchNaverPeriod(period) {
  naverCurrentPeriod = period;
  document.querySelectorAll('#naver-period-tabs .tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.naverPeriod === period)
  );
  ['daily', 'weekly', 'monthly'].forEach(p => {
    document.getElementById(`naver-date-range-${p}`)?.classList.toggle('hidden', p !== period);
  });
  if (naverAllRows.length > 0) naverReRender();
}

document.querySelectorAll('#naver-period-tabs .tab-btn').forEach(btn =>
  btn.addEventListener('click', () => switchNaverPeriod(btn.dataset.naverPeriod))
);

// ── CSV 파싱 ──────────────────────────────
function naverParseCSVLine(line) {
  const result = [];
  let current = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim()); current = '';
    } else { current += ch; }
  }
  result.push(current.trim());
  return result;
}

function naverParseNum(s) {
  return s ? parseFloat(String(s).replace(/,/g, '')) || 0 : 0;
}

function parseNaverCSV(text) {
  const clean = text.replace(/^\uFEFF/, '');
  const lines = clean.split(/\r?\n/).map(l => l.trim()).filter(l => l);
  if (lines.length < 2) return [];
  const headers = naverParseCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = naverParseCSVLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (cells[idx] || '').trim(); });
    // 매체에 '카페'가 포함된 행만 처리
    if (!obj['매체'] || !obj['매체'].includes('카페')) continue;
    let date = obj['날짜'] || '';
    const isMonthly = date.endsWith('-00');
    if (isMonthly) date = date.slice(0, 7);
    rows.push({
      date, isMonthly,
      adId:       obj['광고ID']        || '',
      media:      obj['매체']          || '',
      request:    naverParseNum(obj['요청수']),
      impression: naverParseNum(obj['노출수']),
      click:      naverParseNum(obj['클릭수']),
      profit:     naverParseNum(obj['AXZ매출(원)']),
      ctr:        naverParseNum(obj['CTR(%)']),
    });
  }
  return rows;
}

// ── 날짜 범위 수집 ────────────────────────
function naverGetRange() {
  if (naverCurrentPeriod === 'daily') {
    return { start: naverStartDateD.value, end: naverEndDateD.value };
  }
  if (naverCurrentPeriod === 'weekly') {
    const sr = getWeekRange(naverStartDateW.value || today());
    const er = getWeekRange(naverEndDateW.value   || today());
    return { start: sr.start, end: er.end };
  }
  return {
    start: naverStartDateM.value,
    end:   naverEndDateM.value
  };
}

// ── 날짜 필터 ─────────────────────────────
function applyNaverDateFilter(rows) {
  const { start, end } = naverGetRange();
  if (!start || !end) return rows;

  if (naverCurrentPeriod === 'monthly') {
    const sm = start.slice(0, 7), em = end.slice(0, 7);
    return rows.filter(r => {
      const m = r.date.slice(0, 7);
      return m >= sm && m <= em;
    });
  }
  return rows.filter(r => {
    const d = r.isMonthly ? r.date + '-01' : r.date;
    return d >= start && d <= end;
  });
}

// ── RPM 계산 헬퍼 ─────────────────────────
function calcImpRpm(profit, impression) {
  return impression ? (profit / impression) * 1000 : 0;
}
function calcReqRpm(profit, request) {
  return request ? (profit / request) * 1000 : 0;
}

// ── 주별 그룹핑 ───────────────────────────
function naverGroupByWeek(rows) {
  const map = new Map();
  rows.forEach(r => {
    const anchor = r.isMonthly ? r.date + '-01' : r.date;
    const wr     = getWeekRange(anchor);
    const key    = `${r.adId}__${r.media}__${wr.start}`;
    if (!map.has(key)) {
      map.set(key, {
        ...r,
        date: `${wr.start} ~ ${wr.end}`,
        impression: 0, click: 0, profit: 0, request: 0, ctr: 0, impRpm: 0, reqRpm: 0
      });
    }
    const g = map.get(key);
    g.impression += r.impression || 0;
    g.click      += r.click      || 0;
    g.profit     += r.profit     || 0;
    g.request    += r.request    || 0;
  });
  map.forEach(g => {
    g.ctr    = g.impression ? (g.click / g.impression) * 100 : 0;
    g.impRpm = calcImpRpm(g.profit, g.impression);
    g.reqRpm = calcReqRpm(g.profit, g.request);
  });
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// ── 월별 그룹핑 ───────────────────────────
function naverGroupByMonth(rows) {
  const map = new Map();
  rows.forEach(r => {
    const month = r.date.slice(0, 7);
    const key   = `${r.adId}__${r.media}__${month}`;
    if (!map.has(key)) {
      map.set(key, {
        ...r,
        date: month,
        impression: 0, click: 0, profit: 0, request: 0, ctr: 0, impRpm: 0, reqRpm: 0
      });
    }
    const g = map.get(key);
    g.impression += r.impression || 0;
    g.click      += r.click      || 0;
    g.profit     += r.profit     || 0;
    g.request    += r.request    || 0;
  });
  map.forEach(g => {
    g.ctr    = g.impression ? (g.click / g.impression) * 100 : 0;
    g.impRpm = calcImpRpm(g.profit, g.impression);
    g.reqRpm = calcReqRpm(g.profit, g.request);
  });
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// ── 차트 지표 헬퍼 (naver) ───────────────
function naverGetMetricValue(row, metric) {
  switch (metric) {
    case 'profit':     return row.profit     || 0;
    case 'impression': return row.impression || 0;
    case 'click':      return row.click      || 0;
    case 'ctr':        return row.impression ? (row.click / row.impression * 100) : 0;
    case 'impRpm':     return row.impression ? (row.profit / row.impression * 1000) : 0;
    case 'reqRpm':     return row.request    ? (row.profit / row.request * 1000) : 0;
    case 'impRate':    return row.request    ? (row.impression / row.request * 100) : 0;
    default: return 0;
  }
}
function naverGetMetricLabel(metric) {
  switch (metric) {
    case 'profit':     return '수익 (원)';
    case 'impression': return '노출수';
    case 'click':      return '클릭수';
    case 'ctr':        return 'CTR (%)';
    case 'impRpm':     return '노출 RPM';
    case 'reqRpm':     return '요청 RPM';
    case 'impRate':    return '노출율 (%)';
    default: return metric;
  }
}
function naverFormatMetricValue(v, metric) {
  switch (metric) {
    case 'profit':     return won(Math.round(v));
    case 'impression':
    case 'click':      return comma(Math.round(v));
    case 'ctr':
    case 'impRate':    return v.toFixed(2) + '%';
    case 'impRpm':
    case 'reqRpm':     return comma(Math.round(v)) + '원';
    default: return String(v);
  }
}

// ── 비교 기간 필터 적용 ──────────────────
function applyNaverFiltersB() {
  const hasCmpDates = !!(naverCmpStartDateEl.value && naverCmpEndDateEl.value);
  const adIds = naverMcsCmpAdId ? naverMcsCmpAdId.getSelected() : [];
  if (!hasCmpDates && !adIds.length) return [];
  let rows = [...naverAllRows];
  if (hasCmpDates) {
    const s = naverCmpStartDateEl.value, e = naverCmpEndDateEl.value;
    rows = rows.filter(r => {
      const d = r.isMonthly ? r.date + '-01' : r.date;
      return d >= s && d <= e;
    });
  }
  if (adIds.length) rows = rows.filter(r => adIds.includes(r.adId));
  return rows;
}

// ── 필터 옵션 업데이트 ─────────────────────
function updateNaverFilters(rows) {
  const adIds = [...new Set(rows.map(r => r.adId).filter(Boolean))].sort();
  if (naverMcsAdId) naverMcsAdId.refresh(adIds);
  if (naverMcsCmpAdId) naverMcsCmpAdId.refresh(adIds);
}

function applyNaverFilters(rows) {
  const adIds = naverMcsAdId ? naverMcsAdId.getSelected() : [];
  if (!adIds.length) return rows;
  return rows.filter(r => adIds.includes(r.adId));
}
// alias for symmetry
function applyNaverFiltersA(rows) { return applyNaverFilters(rows); }

// ── 복사 버튼 ────────────────────────────
function naverCopyBtn(rawValue) {
  return `<button class="copy-btn" data-raw="${rawValue}" title="숫자 복사">${COPY_SVG}</button>`;
}

// ── 요약 카드 ─────────────────────────────
function renderNaverSummary(rowsA, rowsB = []) {
  const hasCmp = rowsB.length > 0;
  function stats(rows) {
    const profit = rows.reduce((s, r) => s + (r.profit     || 0), 0);
    const imp    = rows.reduce((s, r) => s + (r.impression || 0), 0);
    const req    = rows.reduce((s, r) => s + (r.request    || 0), 0);
    const clk    = rows.reduce((s, r) => s + (r.click      || 0), 0);
    return { profit, imp, req, clk,
      ctr:     imp ? ((clk / imp) * 100).toFixed(2) : '0.00',
      impRpm:  Math.round(calcImpRpm(profit, imp)),
      reqRpm:  Math.round(calcReqRpm(profit, req)),
      impRate: req ? ((imp / req) * 100).toFixed(2) : '0.00',
    };
  }
  const a = stats(rowsA);
  const b = hasCmp ? stats(rowsB) : null;
  const tA = '기본 필터', tB = '비교 필터';

  function setEl(id, aVal, aRaw, bVal, bRaw) {
    const el = document.getElementById(id); if (!el) return;
    if (!hasCmp) { el.innerHTML = `<span>${aVal}</span>${naverCopyBtn(aRaw)}`; return; }
    el.innerHTML =
      `<span class="cv-primary" title="${tA}"><span>${aVal}</span>${naverCopyBtn(aRaw)}</span>` +
      `<span class="cv-compare" title="${tB}"><span>${bVal}</span>${naverCopyBtn(bRaw)}</span>`;
  }
  function setElNoCopy(id, aVal, bVal) {
    const el = document.getElementById(id); if (!el) return;
    if (!hasCmp) { el.innerHTML = `<span>${aVal}</span>`; return; }
    el.innerHTML =
      `<span class="cv-primary" title="${tA}"><span>${aVal}</span></span>` +
      `<span class="cv-compare" title="${tB}"><span>${bVal}</span></span>`;
  }

  setEl('naver-total-profit',     won(a.profit),    a.profit,    hasCmp ? won(b.profit)    : '', hasCmp ? b.profit    : 0);
  setEl('naver-total-impression', comma(a.imp),     a.imp,       hasCmp ? comma(b.imp)     : '', hasCmp ? b.imp       : 0);
  setEl('naver-total-click',      comma(a.clk),     a.clk,       hasCmp ? comma(b.clk)     : '', hasCmp ? b.clk       : 0);
  setElNoCopy('naver-total-ctr',  a.ctr + '%',      hasCmp ? b.ctr + '%' : '');
  setEl('naver-total-imp-rpm',    won(a.impRpm),    a.impRpm,    hasCmp ? won(b.impRpm)    : '', hasCmp ? b.impRpm    : 0);
  setEl('naver-total-req-rpm',    won(a.reqRpm),    a.reqRpm,    hasCmp ? won(b.reqRpm)    : '', hasCmp ? b.reqRpm    : 0);
  setElNoCopy('naver-total-imp-rate', a.impRate + '%', hasCmp ? b.impRate + '%' : '');
  naverSummaryCards.style.display = '';
}

// ── 매체별 카드 ───────────────────────────
function renderNaverPlatformCards(rows) {
  const map = new Map();
  rows.forEach(r => {
    const m = r.media || '기타';
    if (!map.has(m)) map.set(m, { profit: 0, impression: 0, click: 0 });
    const g = map.get(m);
    g.profit     += r.profit     || 0;
    g.impression += r.impression || 0;
    g.click      += r.click      || 0;
  });
  naverPlatformCards.innerHTML = [...map.entries()]
    .sort((a, b) => b[1].profit - a[1].profit)
    .map(([media, d]) => `
      <div class="platform-card">
        <div class="p-name">${media}</div>
        <div class="p-profit"><span>${won(d.profit)}</span>${naverCopyBtn(d.profit)}</div>
        <div class="p-sub">노출 ${comma(d.impression)} / 클릭 ${comma(d.click)}</div>
      </div>
    `).join('');
  naverPlatformSection.style.display = '';
}

// ── 정렬 ──────────────────────────────────
function getNaverSortValue(row, col) {
  switch (col) {
    case 'date':       return row.date       || '';
    case 'adId':       return row.adId       || '';
    case 'media':      return row.media      || '';
    case 'request':    return row.request    || 0;
    case 'impression': return row.impression || 0;
    case 'impRate':    return row.request    ? row.impression / row.request : 0;
    case 'click':      return row.click      || 0;
    case 'ctr':        return row.ctr        || 0;
    case 'impRpm':     return row.impRpm     || 0;
    case 'reqRpm':     return row.reqRpm     || 0;
    case 'profit':     return row.profit     || 0;
    case 'profitPct':  return row._profitPct || 0;
    default:           return '';
  }
}

function naverSortRows(rows) {
  if (!naverSortCol) return rows;
  return [...rows].sort((a, b) => {
    const va = getNaverSortValue(a, naverSortCol);
    const vb = getNaverSortValue(b, naverSortCol);
    if (typeof va === 'string') return va.localeCompare(vb) * naverSortDir;
    return (va - vb) * naverSortDir;
  });
}

function updateNaverSortHeaders() {
  document.querySelectorAll('#naver-result-table th[data-col]').forEach(th => {
    const active = th.dataset.col === naverSortCol;
    th.classList.toggle('sorted', active);
    const icon = th.querySelector('.sort-icon');
    if (icon) icon.textContent = active ? (naverSortDir === 1 ? '↑' : '↓') : '↕';
  });
}

// ── 테이블 렌더 ────────────────────────────
function renderNaverTable(rowsA, rowsB = []) {
  const hasCmp = rowsB.length > 0;
  const totalP = rowsA.reduce((s, r) => s + (r.profit || 0), 0);
  function prepRow(r) {
    r._profitPct = totalP > 0 ? (r.profit || 0) / totalP * 100 : 0;
    if (r.impRpm === undefined) r.impRpm = calcImpRpm(r.profit, r.impression);
    if (r.reqRpm === undefined) r.reqRpm = calcReqRpm(r.profit, r.request);
    return r;
  }
  const combined = [
    ...rowsA.map(r => ({ ...prepRow(r), _group: 'a' })),
    ...(hasCmp ? rowsB.map(r => ({ ...prepRow(r), _group: 'b' })) : [])
  ];
  const sorted = naverSortRows(combined);
  updateNaverSortHeaders();
  naverRowCountEl.textContent = `총 ${rowsA.length}건${hasCmp ? ` + 비교 ${rowsB.length}건` : ''}`;
  naverResultBody.innerHTML = sorted.map(r => `
    <tr class="${r._group === 'a' ? 'tr-group-a' : 'tr-group-b'}" title="${r._group === 'a' ? '기본 필터' : '비교 필터'}">
      <td>${r.date || '-'}</td>
      <td>${r.adId || '-'}</td>
      <td>${r.media || '-'}</td>
      <td>${comma(r.request)}</td>
      <td>${comma(r.impression)}</td>
      <td>${r.request ? ((r.impression / r.request) * 100).toFixed(2) + '%' : '0.00%'}</td>
      <td>${comma(r.click)}</td>
      <td>${r.ctr.toFixed(2)}%</td>
      <td>${won(Math.round(r.impRpm))}</td>
      <td>${won(Math.round(r.reqRpm))}</td>
      <td class="profit-cell"><span class="profit-cell-inner"><span>${won(r.profit)}</span>${naverCopyBtn(r.profit || 0)}</span></td>
      <td>${r._profitPct.toFixed(1)}%</td>
    </tr>
  `).join('');
  naverTableSection.style.display = '';
}

// ── 차트 렌더 ─────────────────────────────
function renderNaverChart(rowsA, rowsB = []) {
  const hasCmp = rowsB.length > 0;
  function buildMap(rows) {
    const raw = new Map();
    rows.forEach(r => {
      const label = r.date || '-';
      if (!raw.has(label)) raw.set(label, { profit: 0, impression: 0, click: 0, request: 0 });
      const g = raw.get(label);
      g.profit     += r.profit     || 0;
      g.impression += r.impression || 0;
      g.click      += r.click      || 0;
      g.request    += r.request    || 0;
    });
    const map = new Map();
    raw.forEach((g, label) => map.set(label, naverGetMetricValue(g, naverChartMetric)));
    return map;
  }
  const mapA   = buildMap(rowsA);
  const mapB   = hasCmp ? buildMap(rowsB) : new Map();
  const labels = [...new Set([...mapA.keys(), ...mapB.keys()])].sort();
  const dataA  = labels.map(l => mapA.get(l) || 0);
  const dataB  = labels.map(l => mapB.get(l) || 0);

  const chartTitle = naverGetMetricLabel(naverChartMetric);
  const h2 = document.getElementById('naver-chart-title-h2');
  if (h2) h2.textContent = `날짜별 ${chartTitle} 추이`;
  const tooltipFmt = (ctx) => `${ctx.dataset.label}: ${naverFormatMetricValue(ctx.parsed.y, naverChartMetric)}`;
  const yTickFmt   = (v)   => naverFormatMetricValue(v, naverChartMetric);

  const datasets = [
    { label: '기본 필터', data: dataA, backgroundColor: 'rgba(3,199,90,0.45)', borderColor: 'rgba(3,199,90,1)', borderWidth: 1.5, borderRadius: 4 },
    ...(hasCmp ? [{ label: '비교 필터', data: dataB, backgroundColor: 'rgba(234,67,53,0.45)', borderColor: 'rgba(234,67,53,1)', borderWidth: 1.5, borderRadius: 4 }] : [])
  ];

  naverChartSection.style.display = '';
  if (naverChartInstance) {
    naverChartInstance.data.labels   = labels;
    naverChartInstance.data.datasets = datasets;
    naverChartInstance.options.plugins.legend.display = hasCmp;
    naverChartInstance.options.plugins.title.text = chartTitle;
    naverChartInstance.options.plugins.tooltip.callbacks.label = tooltipFmt;
    naverChartInstance.options.scales.y.ticks.callback = yTickFmt;
    naverChartInstance.update('active');
    return;
  }
  const ctx = document.getElementById('naver-profit-chart').getContext('2d');
  naverChartInstance = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true, animation: { duration: 400 },
      interaction: { mode: 'index', intersect: false },
      onHover: (event, elements, chart) => {
        const newIdx = elements.length > 0 ? elements[0].index : null;
        if (newIdx !== naverHoveredIdx) {
          naverHoveredIdx = newIdx;
          chart.update('none');
        }
      },
      plugins: {
        legend: { display: hasCmp },
        title: { display: true, text: chartTitle, font: { size: 13, weight: '600' }, color: '#6B7280', padding: { bottom: 8 } },
        tooltip: { callbacks: { label: tooltipFmt } }
      },
      scales: {
        x: {
          ticks: {
            color: (c) => c.index === naverHoveredIdx ? '#DC2626' : '#6B7280',
            font: (c) => c.index === naverHoveredIdx ? { weight: 'bold', size: 13 } : { weight: 'normal', size: 12 },
          },
          grid: {
            color: (c) => c.index === naverHoveredIdx ? 'rgba(220, 38, 38, 0.25)' : 'rgba(0, 0, 0, 0.05)',
            lineWidth: (c) => c.index === naverHoveredIdx ? 2 : 1,
          },
        },
        y: { ticks: { callback: yTickFmt } },
      },
    }
  });
}

// ── 전체 재렌더 ────────────────────────────
function naverReRender() {
  if (naverAllRows.length === 0) return;
  let rowsA = applyNaverDateFilter(naverAllRows);
  rowsA = applyNaverFilters(rowsA);
  if (naverCurrentPeriod === 'weekly')  rowsA = naverGroupByWeek(rowsA);
  if (naverCurrentPeriod === 'monthly') rowsA = naverGroupByMonth(rowsA);

  let rowsB = applyNaverFiltersB();
  if (rowsB.length) {
    if (naverCurrentPeriod === 'weekly')  rowsB = naverGroupByWeek(rowsB);
    if (naverCurrentPeriod === 'monthly') rowsB = naverGroupByMonth(rowsB);
  }

  renderNaverSummary(rowsA, rowsB);
  renderNaverPlatformCards(rowsA);
  renderNaverTable(rowsA, rowsB);
  renderNaverChart(rowsA, rowsB);
}

// ── CSV 다운로드 ──────────────────────────
function downloadNaverCSV() {
  let rows = applyNaverDateFilter(naverAllRows);
  rows = applyNaverFilters(rows);
  if (naverCurrentPeriod === 'weekly')  rows = naverGroupByWeek(rows);
  if (naverCurrentPeriod === 'monthly') rows = naverGroupByMonth(rows);
  const totalP   = rows.reduce((s, r) => s + (r.profit     || 0), 0);
  const totalImp = rows.reduce((s, r) => s + (r.impression || 0), 0);
  const totalReq = rows.reduce((s, r) => s + (r.request    || 0), 0);
  const totalClk = rows.reduce((s, r) => s + (r.click      || 0), 0);
  const { start, end } = naverGetRange();
  const ctrVal    = totalImp ? ((totalClk / totalImp) * 100).toFixed(2) + '%' : '0.00%';
  const impRpmVal = won(Math.round(calcImpRpm(totalP, totalImp)));
  const reqRpmVal = won(Math.round(calcReqRpm(totalP, totalReq)));
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const row = (...cols) => cols.map(esc).join(',');
  const lines = [
    row('기간', `${start} ~ ${end}`),
    row('총 수익 (AXZ매출)', totalP),
    row('총 노출수', totalImp),
    row('총 클릭수', totalClk),
    row('클릭률 (CTR)', ctrVal),
    row('노출 RPM', impRpmVal),
    row('요청 RPM', reqRpmVal),
    '',
    row('날짜', '광고ID', '매체', '요청수', '노출수', '노출율(%)', '클릭수', 'CTR(%)', '노출RPM(원)', '요청RPM(원)', 'AXZ매출(원)', '분포'),
  ];
  rows.forEach(r => {
    r._profitPct = totalP > 0 ? (r.profit || 0) / totalP * 100 : 0;
    if (r.impRpm === undefined) r.impRpm = calcImpRpm(r.profit, r.impression);
    if (r.reqRpm === undefined) r.reqRpm = calcReqRpm(r.profit, r.request);
  });
  naverSortRows(rows).forEach(r => {
    lines.push(row(
      r.date || '-', r.adId || '-', r.media || '-',
      r.request || 0, r.impression || 0,
      r.request ? ((r.impression / r.request) * 100).toFixed(2) + '%' : '0.00%',
      r.click || 0,
      r.ctr.toFixed(2) + '%',
      Math.round(r.impRpm) || 0, Math.round(r.reqRpm) || 0,
      r.profit || 0, r._profitPct.toFixed(1) + '%'
    ));
  });
  const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href: url, download: `naver_cafe_${new Date().toISOString().slice(0, 10)}.csv`
  });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Flatpickr 초기화 ──────────────────────
function initNaverFlatpickr() {
  const baseOpts = { locale: 'ko', dateFormat: 'Y-m-d', disableMobile: true };

  function addShortcuts(container, fp, shortcuts) {
    const wrap = document.createElement('div');
    wrap.className = 'fp-quick-btns';
    shortcuts.forEach(({ label, getDate }) => {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'fp-quick-btn'; btn.textContent = label;
      btn.addEventListener('mousedown', e => {
        e.preventDefault(); fp.setDate(getDate(), true); fp.close();
      });
      wrap.appendChild(btn);
    });
    container.appendChild(wrap);
  }

  function addPairedShortcuts(container, shortcuts) {
    const wrap = document.createElement('div');
    wrap.className = 'fp-quick-btns';
    shortcuts.forEach(({ label, action }) => {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'fp-quick-btn'; btn.textContent = label;
      btn.addEventListener('mousedown', e => { e.preventDefault(); action(); });
      wrap.appendChild(btn);
    });
    container.appendChild(wrap);
  }

  // ─── 일별 ──────────────────────────────
  naverFpStartD = flatpickr(naverStartDateD, {
    ...baseOpts,
    defaultDate: naverStartDateD.value || daysAgo(30),
    onChange(selectedDates) {
      if (selectedDates[0] && naverFpEndD.selectedDates[0] && selectedDates[0] > naverFpEndD.selectedDates[0]) {
        naverFpEndD.setDate(selectedDates[0], false);
      }
      naverReRender();
      setTimeout(() => naverFpEndD.open(), 50);
    },
    onReady(_, __, fp) {
      addShortcuts(fp.calendarContainer, fp, [
        { label: '오늘',      getDate: () => today()     },
        { label: '어제',      getDate: () => daysAgo(1)  },
        { label: '최근 7일',  getDate: () => daysAgo(6)  },
        { label: '최근 30일', getDate: () => daysAgo(29) },
      ]);
    }
  });

  naverFpEndD = flatpickr(naverEndDateD, {
    ...baseOpts,
    defaultDate: naverEndDateD.value || today(),
    onChange(selectedDates) {
      if (selectedDates[0] && naverFpStartD.selectedDates[0] && selectedDates[0] < naverFpStartD.selectedDates[0]) {
        naverFpStartD.setDate(selectedDates[0], false);
      }
      naverReRender();
    },
    onReady(_, __, fp) {
      addShortcuts(fp.calendarContainer, fp, [
        { label: '오늘',      getDate: () => today()     },
        { label: '어제',      getDate: () => daysAgo(1)  },
        { label: '최근 7일',  getDate: () => today()     },
        { label: '최근 30일', getDate: () => today()     },
      ]);
    }
  });

  // ─── 주별 ──────────────────────────────
  const weeklyShortcuts = [
    {
      label: '이번 주', action() {
        const r = getWeekRange(today());
        naverFpStartW.setDate(r.start, false); naverFpEndW.setDate(r.end, false); naverReRender();
      }
    },
    {
      label: '지난 주', action() {
        const r = getWeekRange(daysAgo(7));
        naverFpStartW.setDate(r.start, false); naverFpEndW.setDate(r.end, false); naverReRender();
      }
    },
    {
      label: '최근 4주', action() {
        naverFpStartW.setDate(getWeekRange(daysAgo(27)).start, false);
        naverFpEndW.setDate(getWeekRange(today()).end, false);
        naverReRender();
      }
    },
  ];

  naverFpStartW = flatpickr(naverStartDateW, {
    ...baseOpts,
    defaultDate: naverStartDateW.value || getWeekRange(daysAgo(27)).start,
    onChange(selectedDates) {
      if (!selectedDates[0]) return;
      const r = getWeekRange(selectedDates[0].toISOString().slice(0, 10));
      naverFpStartW.setDate(r.start, false);
      naverFpEndW.setDate(r.end, false);
      naverReRender();
    },
    onReady(_, __, fp) { addPairedShortcuts(fp.calendarContainer, weeklyShortcuts); }
  });

  naverFpEndW = flatpickr(naverEndDateW, {
    ...baseOpts,
    defaultDate: naverEndDateW.value || getWeekRange(today()).end,
    onChange(selectedDates) {
      if (!selectedDates[0]) return;
      const r = getWeekRange(selectedDates[0].toISOString().slice(0, 10));
      naverFpEndW.setDate(r.end, false);
      if (naverFpStartW.selectedDates[0] && new Date(r.end) < naverFpStartW.selectedDates[0]) {
        naverFpStartW.setDate(r.start, false);
      }
      naverReRender();
    },
    onReady(_, __, fp) { addPairedShortcuts(fp.calendarContainer, weeklyShortcuts); }
  });

  // ─── 월별 ──────────────────────────────
  const monthlyShortcuts = [
    {
      label: '이번 달', action() {
        const r = monthRange(today());
        naverFpStartM.setDate(r.start, false); naverFpEndM.setDate(r.end, false); naverReRender();
      }
    },
    {
      label: '지난 달', action() {
        const r = monthRange(monthsAgo(1));
        naverFpStartM.setDate(r.start, false); naverFpEndM.setDate(r.end, false); naverReRender();
      }
    },
    {
      label: '최근 3개월', action() {
        naverFpStartM.setDate(monthRange(monthsAgo(2)).start, false);
        naverFpEndM.setDate(monthRange(today()).end, false);
        naverReRender();
      }
    },
  ];

  naverFpStartM = flatpickr(naverStartDateM, {
    ...baseOpts,
    defaultDate: naverStartDateM.value || monthRange(monthsAgo(2)).start,
    onChange(selectedDates) {
      if (!selectedDates[0]) return;
      const r = monthRange(selectedDates[0].toISOString().slice(0, 10));
      naverFpStartM.setDate(r.start, false);
      naverFpEndM.setDate(r.end, false);
      naverReRender();
    },
    onReady(_, __, fp) { addPairedShortcuts(fp.calendarContainer, monthlyShortcuts); }
  });

  naverFpEndM = flatpickr(naverEndDateM, {
    ...baseOpts,
    defaultDate: naverEndDateM.value || monthRange(today()).end,
    onChange(selectedDates) {
      if (!selectedDates[0]) return;
      const r = monthRange(selectedDates[0].toISOString().slice(0, 10));
      naverFpEndM.setDate(r.end, false);
      if (naverFpStartM.selectedDates[0] && new Date(r.end) < naverFpStartM.selectedDates[0]) {
        naverFpStartM.setDate(r.start, false);
      }
      naverReRender();
    },
    onReady(_, __, fp) { addPairedShortcuts(fp.calendarContainer, monthlyShortcuts); }
  });

  // ─── 비교 기간 ─────────────────────────
  naverCmpFpStartD = flatpickr(naverCmpStartDateEl, {
    ...baseOpts,
    placeholder: '날짜 선택',
    onChange(selectedDates) {
      if (selectedDates[0] && naverCmpFpEndD.selectedDates[0] && selectedDates[0] > naverCmpFpEndD.selectedDates[0]) {
        naverCmpFpEndD.setDate(selectedDates[0], false);
      }
      naverReRender();
      setTimeout(() => naverCmpFpEndD.open(), 50);
    }
  });
  naverCmpFpEndD = flatpickr(naverCmpEndDateEl, {
    ...baseOpts,
    placeholder: '날짜 선택',
    onChange(selectedDates) {
      if (selectedDates[0] && naverCmpFpStartD.selectedDates[0] && selectedDates[0] < naverCmpFpStartD.selectedDates[0]) {
        naverCmpFpStartD.setDate(selectedDates[0], false);
      }
      naverReRender();
    }
  });

  naverCmpClearBtn.addEventListener('click', () => {
    naverCmpFpStartD.clear(); naverCmpFpEndD.clear();
    if (naverMcsCmpAdId) naverMcsCmpAdId.setSelected([]);
    naverReRender();
  });
}

// ── CSV 데이터 기반 날짜 초기값 설정 ────────
function setNaverDatesFromData() {
  const validDates = naverAllRows
    .map(r => r.isMonthly ? r.date + '-01' : r.date)
    .filter(d => d && /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  const minDate = validDates[0]                    || daysAgo(30);
  const maxDate = validDates[validDates.length - 1] || today();

  naverFpStartD.setDate(minDate, false);
  naverFpEndD.setDate(maxDate, false);
  naverFpStartW.setDate(getWeekRange(minDate).start, false);
  naverFpEndW.setDate(getWeekRange(maxDate).end, false);
  naverFpStartM.setDate(monthRange(minDate).start, false);
  naverFpEndM.setDate(monthRange(maxDate).end, false);
}

// ── 파일 처리 ─────────────────────────────
function handleNaverFile(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.csv')) {
    alert('CSV 파일만 업로드 가능합니다.'); return;
  }
  const reader = new FileReader();
  reader.readAsArrayBuffer(file);
  reader.onload = function (e) {
    const buffer = e.target.result;
    let text = new TextDecoder('utf-8').decode(buffer);
    const testLine = text.replace(/^\uFEFF/, '').split('\n')[0];
    if (!testLine.includes('날짜') && !testLine.includes('AXZ')) {
      try { text = new TextDecoder('euc-kr').decode(buffer); } catch (_) {}
    }
    const rows = parseNaverCSV(text);
    if (rows.length === 0) {
      alert('카페 매체 데이터가 없거나 형식이 올바르지 않습니다.\n"매체", "AXZ매출(원)" 컬럼이 포함된 네이버 광고매출 리포트 파일을 올려주세요.');
      return;
    }
    naverAllRows = rows;
    window.naverAllRows = rows;  // compare.js에서 접근
    // 캐시 저장 (다음 접속 시 자동 복원용)
    try {
      localStorage.setItem(NAVER_CACHE_KEY, JSON.stringify({
        fileName: file.name, uploadedAt: new Date().toISOString(), rows
      }));
    } catch (_) { /* 용량 초과 시 무시 */ }
    const sizeKB = Math.round(file.size / 1024);
    naverFileNameEl.textContent = `📄 ${file.name}  (${rows.length}건 · ${sizeKB}KB)`;
    naverUploadZone.classList.add('hidden');
    naverFileInfo.classList.remove('hidden');
    naverPeriodTabsEl.style.display = '';
    naverControls.style.display     = '';
    if (!naverMcsAdId) {
      naverMcsAdId = new MultiCheckSelect(document.getElementById('mcs-naver-adid'), '전체 광고ID', naverReRender);
    }
    if (!naverMcsCmpAdId) {
      naverMcsCmpAdId = new MultiCheckSelect(document.getElementById('mcs-naver-cmp-adid'), '전체 광고ID', naverReRender);
    }
    updateNaverFilters(rows);
    setNaverDatesFromData();
    naverReRender();
  };
}

// ── 파일 입력 이벤트 ─────────────────────
naverCsvInput.addEventListener('change', e => {
  if (e.target.files[0]) handleNaverFile(e.target.files[0]);
  naverCsvInput.value = '';
});

// ── 드래그앤드롭 ─────────────────────────
naverUploadZone.addEventListener('dragover', e => {
  e.preventDefault(); naverUploadZone.classList.add('drag-over');
});
naverUploadZone.addEventListener('dragleave', () => naverUploadZone.classList.remove('drag-over'));
naverUploadZone.addEventListener('drop', e => {
  e.preventDefault(); naverUploadZone.classList.remove('drag-over');
  if (e.dataTransfer?.files[0]) handleNaverFile(e.dataTransfer.files[0]);
});

// ── 파일 리셋 ─────────────────────────────
naverFileResetBtn.addEventListener('click', () => {
  naverAllRows = [];
  naverChartMetric = 'profit';
  if (naverChartInstance) { naverChartInstance.destroy(); naverChartInstance = null; }
  naverSortCol = null; naverSortDir = 1;
  naverUploadZone.classList.remove('hidden');
  naverFileInfo.classList.add('hidden');
  naverPeriodTabsEl.style.display    = 'none';
  naverControls.style.display        = 'none';
  naverSummaryCards.style.display    = 'none';
  naverPlatformSection.style.display = 'none';
  naverChartSection.style.display    = 'none';
  naverTableSection.style.display    = 'none';
  naverResultBody.innerHTML    = '';
  naverPlatformCards.innerHTML = '';
  if (naverMcsAdId) naverMcsAdId.refresh([]);
  if (naverMcsCmpAdId) naverMcsCmpAdId.refresh([]);
  if (naverCmpFpStartD) naverCmpFpStartD.clear();
  if (naverCmpFpEndD) naverCmpFpEndD.clear();
  // naver-summary-cards chart-active 초기화
  document.querySelectorAll('#naver-summary-cards .card').forEach((c, i) => c.classList.toggle('chart-active', i === 0));
  localStorage.removeItem(NAVER_CACHE_KEY); // 캐시 삭제
  switchNaverPeriod('daily');
});

// ── 요약 카드 클릭 → 차트 지표 전환 ─────
document.getElementById('naver-summary-cards').addEventListener('click', e => {
  const card = e.target.closest('.card[data-metric]');
  if (!card || naverAllRows.length === 0) return;
  naverChartMetric = card.dataset.metric;
  document.querySelectorAll('#naver-summary-cards .card').forEach(c => c.classList.remove('chart-active'));
  card.classList.add('chart-active');
  naverReRender();
});

// ── 테이블 정렬 ───────────────────────────
document.querySelector('#naver-result-table thead').addEventListener('click', e => {
  const th = e.target.closest('th[data-col]');
  if (!th || naverAllRows.length === 0) return;
  const col = th.dataset.col;
  if (naverSortCol === col) naverSortDir *= -1;
  else { naverSortCol = col; naverSortDir = 1; }
  naverReRender();
});

// ── 조회 버튼 ─────────────────────────────
document.getElementById('naver-search-btn').addEventListener('click', naverReRender);

// ── CSV 다운로드 버튼 ─────────────────────
naverCsvDlBtn.addEventListener('click', downloadNaverCSV);

// ── 캐시 복원 ─────────────────────────────
function loadNaverFromCache() {
  try {
    const raw = localStorage.getItem(NAVER_CACHE_KEY);
    if (!raw) return;
    const { fileName, uploadedAt, rows } = JSON.parse(raw);
    if (!rows || rows.length === 0) return;
    naverAllRows = rows;
    window.naverAllRows = rows;  // compare.js에서 접근
    const dateStr = new Date(uploadedAt).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
    naverFileNameEl.textContent = `📄 ${fileName}  (${rows.length}건 · 저장됨 ${dateStr})`;
    naverUploadZone.classList.add('hidden');
    naverFileInfo.classList.remove('hidden');
    naverPeriodTabsEl.style.display = '';
    naverControls.style.display     = '';
    if (!naverMcsAdId) {
      naverMcsAdId = new MultiCheckSelect(document.getElementById('mcs-naver-adid'), '전체 광고ID', naverReRender);
    }
    if (!naverMcsCmpAdId) {
      naverMcsCmpAdId = new MultiCheckSelect(document.getElementById('mcs-naver-cmp-adid'), '전체 광고ID', naverReRender);
    }
    updateNaverFilters(rows);
    setNaverDatesFromData();
    naverReRender();
  } catch (_) {
    localStorage.removeItem(NAVER_CACHE_KEY); // 손상된 캐시 삭제
  }
}

// ── 초기화 ────────────────────────────────
initNaverFlatpickr();
loadNaverFromCache();

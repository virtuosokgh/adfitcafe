/* =========================================
   카페 네이버 수익 대시보드 - naver.js
   (app.js 이후 로드: won, comma, rpmFmt, COPY_SVG, getWeekRange, monthRange,
    daysAgo, monthsAgo, today, SearchableSelect 공유)
   ========================================= */

// ── 캐시 키 ──────────────────────────────────
const NAVER_CACHE_KEY = 'naver_csv_cache';

// ── 상태 변수 ──────────────────────────────
let naverAllRows       = [];
let naverChartInstance = null;
let naverSortCol       = null;
let naverSortDir       = 1;
let naverCurrentPeriod = 'daily';
let naverSsAdId        = null;
let naverFpStartD = null, naverFpEndD = null;
let naverFpStartW = null, naverFpEndW = null;
let naverFpStartM = null, naverFpEndM = null;

// ── DOM 참조 ──────────────────────────────
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
const naverAdIdFilter      = document.getElementById('naver-adid-filter');
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
  localStorage.setItem(PNAV_KEY, target);
}

pnavBtns.forEach(btn => btn.addEventListener('click', () => switchPNav(btn.dataset.pnav)));

(function () {
  if (localStorage.getItem(PNAV_KEY) === 'naver') switchPNav('naver');
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

// ── 필터 옵션 업데이트 ─────────────────────
function updateNaverFilters(rows) {
  const adIds   = [...new Set(rows.map(r => r.adId).filter(Boolean))].sort();
  const curAdId = naverAdIdFilter.value;
  naverAdIdFilter.innerHTML = '<option value="">전체 광고ID</option>';
  adIds.forEach(v => {
    const o = document.createElement('option');
    o.value = v; o.textContent = v;
    if (v === curAdId) o.selected = true;
    naverAdIdFilter.appendChild(o);
  });
  if (naverSsAdId) naverSsAdId.refresh();
}

function applyNaverFilters(rows) {
  const adId = naverAdIdFilter.value;
  return rows.filter(r => !adId || r.adId === adId);
}

// ── 복사 버튼 ────────────────────────────
function naverCopyBtn(rawValue) {
  return `<button class="copy-btn" data-raw="${rawValue}" title="숫자 복사">${COPY_SVG}</button>`;
}

// ── 요약 카드 ─────────────────────────────
function renderNaverSummary(rows) {
  const profit = rows.reduce((s, r) => s + (r.profit     || 0), 0);
  const imp    = rows.reduce((s, r) => s + (r.impression || 0), 0);
  const req    = rows.reduce((s, r) => s + (r.request    || 0), 0);
  const clk    = rows.reduce((s, r) => s + (r.click      || 0), 0);
  const ctrNum = imp ? ((clk / imp) * 100).toFixed(2) : '0.00';
  const impRpmVal  = Math.round(calcImpRpm(profit, imp));
  const reqRpmVal  = Math.round(calcReqRpm(profit, req));
  const impRateNum = req ? ((imp / req) * 100).toFixed(2) : '0.00';

  document.getElementById('naver-total-profit').innerHTML     = `<span>${won(profit)}</span>${naverCopyBtn(profit)}`;
  document.getElementById('naver-total-impression').innerHTML = `<span>${comma(imp)}</span>${naverCopyBtn(imp)}`;
  document.getElementById('naver-total-click').innerHTML      = `<span>${comma(clk)}</span>${naverCopyBtn(clk)}`;
  document.getElementById('naver-total-ctr').innerHTML        = `<span>${ctrNum}%</span>`;
  document.getElementById('naver-total-imp-rpm').innerHTML    = `<span>${won(impRpmVal)}</span>${naverCopyBtn(impRpmVal)}`;
  document.getElementById('naver-total-req-rpm').innerHTML    = `<span>${won(reqRpmVal)}</span>${naverCopyBtn(reqRpmVal)}`;
  document.getElementById('naver-total-imp-rate').innerHTML   = `<span>${impRateNum}%</span>`;
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
    case 'impRate':    return row.request ? row.impression / row.request : 0;
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
function renderNaverTable(rows) {
  const totalP = rows.reduce((s, r) => s + (r.profit || 0), 0);
  rows.forEach(r => {
    r._profitPct = totalP > 0 ? (r.profit || 0) / totalP * 100 : 0;
    // 일별 rows는 impRpm/reqRpm 계산 (그룹핑 후 rows는 이미 계산됨)
    if (r.impRpm === undefined) r.impRpm = calcImpRpm(r.profit, r.impression);
    if (r.reqRpm === undefined) r.reqRpm = calcReqRpm(r.profit, r.request);
  });
  const sorted = naverSortRows(rows);
  updateNaverSortHeaders();
  naverRowCountEl.textContent = `총 ${sorted.length}건`;
  naverResultBody.innerHTML = sorted.map(r => `
    <tr>
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
function renderNaverChart(rows) {
  const map = new Map();
  rows.forEach(r => { map.set(r.date || '-', (map.get(r.date || '-') || 0) + (r.profit || 0)); });
  const labels = [...map.keys()].sort();
  const data   = labels.map(l => map.get(l));
  naverChartSection.style.display = '';
  if (naverChartInstance) {
    naverChartInstance.data.labels           = labels;
    naverChartInstance.data.datasets[0].data = data;
    naverChartInstance.update('active');
    return;
  }
  const ctx = document.getElementById('naver-profit-chart').getContext('2d');
  naverChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'AXZ매출 (원)', data,
        backgroundColor: 'rgba(3,199,90,0.45)',
        borderColor: 'rgba(3,199,90,1)',
        borderWidth: 1.5, borderRadius: 4
      }]
    },
    options: {
      responsive: true, animation: { duration: 400 },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => won(ctx.parsed.y) } }
      },
      scales: { y: { ticks: { callback: v => won(v) } } }
    }
  });
}

// ── 전체 재렌더 ────────────────────────────
function naverReRender() {
  if (naverAllRows.length === 0) return;
  let rows = applyNaverDateFilter(naverAllRows);
  rows = applyNaverFilters(rows);
  if (naverCurrentPeriod === 'weekly')  rows = naverGroupByWeek(rows);
  if (naverCurrentPeriod === 'monthly') rows = naverGroupByMonth(rows);
  renderNaverSummary(rows);
  renderNaverPlatformCards(rows);
  renderNaverTable(rows);
  renderNaverChart(rows);
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
    updateNaverFilters(rows);
    if (!naverSsAdId) {
      naverSsAdId = new SearchableSelect(naverAdIdFilter);
    } else {
      naverSsAdId.refresh();
    }
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
  naverAdIdFilter.innerHTML    = '<option value="">전체 광고ID</option>';
  if (naverSsAdId) naverSsAdId.refresh();
  localStorage.removeItem(NAVER_CACHE_KEY); // 캐시 삭제
  switchNaverPeriod('daily');
});

// ── 필터 변경 ─────────────────────────────
naverAdIdFilter.addEventListener('change', naverReRender);

// ── 테이블 정렬 ───────────────────────────
document.querySelector('#naver-result-table thead').addEventListener('click', e => {
  const th = e.target.closest('th[data-col]');
  if (!th || naverAllRows.length === 0) return;
  const col = th.dataset.col;
  if (naverSortCol === col) naverSortDir *= -1;
  else { naverSortCol = col; naverSortDir = 1; }
  naverReRender();
});

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
    const dateStr = new Date(uploadedAt).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
    naverFileNameEl.textContent = `📄 ${fileName}  (${rows.length}건 · 저장됨 ${dateStr})`;
    naverUploadZone.classList.add('hidden');
    naverFileInfo.classList.remove('hidden');
    naverPeriodTabsEl.style.display = '';
    naverControls.style.display     = '';
    updateNaverFilters(rows);
    if (!naverSsAdId) {
      naverSsAdId = new SearchableSelect(naverAdIdFilter);
    } else {
      naverSsAdId.refresh();
    }
    setNaverDatesFromData();
    naverReRender();
  } catch (_) {
    localStorage.removeItem(NAVER_CACHE_KEY); // 손상된 캐시 삭제
  }
}

// ── 초기화 ────────────────────────────────
initNaverFlatpickr();
loadNaverFromCache();

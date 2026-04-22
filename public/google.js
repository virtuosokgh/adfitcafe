/* ===========================================================
 *  Google Ad Manager 대시보드 프론트엔드
 *  - naver.js / app.js 의 MultiCheckSelect / 스타일 재활용
 *  - 서버 엔드포인트: GET /api/google/report?startDate=&endDate=
 * =========================================================== */

let googleAllRows     = [];   // 기본 데이터
let googleAllRowsB    = [];   // 비교 데이터
let googleCurrentPeriod = 'daily';
let googleChartMetric   = 'profit';
let googleChart         = null;
let googleSortState     = { col: 'date', dir: 'desc' };

// MCS
let mcsGoogleAdUnit   = null;
let mcsGoogleCmpAdUnit = null;

// flatpickr
let gFpStartD, gFpEndD, gFpStartW, gFpEndW, gFpStartM, gFpEndM;
let gCmpFpStartD, gCmpFpEndD;

// ── 유틸 ────────────────────────────────────
const krw = n => (Number(n) || 0).toLocaleString('ko-KR') + '원';
const num = n => (Number(n) || 0).toLocaleString('ko-KR');
const gpct = n => (Number(n) || 0).toFixed(2) + '%';
const yyyymmdd = d => d.toISOString().slice(0,10).replace(/-/g,'');
const toDateStr = d => d.toISOString().slice(0,10);

function gFmtNum(v, metric) {
  if (metric === 'profit' || metric === 'ecpm') return krw(v);
  if (metric === 'ctr') return gpct(v);
  return num(v);
}

function gMetricLabel(m) {
  return { profit: '수익', impression: '노출수', click: '클릭수', ctr: 'CTR', ecpm: 'eCPM' }[m] || '수익';
}

// ── DOM ─────────────────────────────────────
const gStartD = document.getElementById('google-start-d');
const gEndD   = document.getElementById('google-end-d');
const gStartW = document.getElementById('google-start-w');
const gEndW   = document.getElementById('google-end-w');
const gStartM = document.getElementById('google-start-m');
const gEndM   = document.getElementById('google-end-m');
const gCmpStartD = document.getElementById('google-cmp-start-d');
const gCmpEndD   = document.getElementById('google-cmp-end-d');
const gSearchBtn = document.getElementById('google-search-btn');
const gLoading   = document.getElementById('google-loading');
const gErrorMsg  = document.getElementById('google-error-msg');
const gEmptyMsg  = document.getElementById('google-empty-msg');
const gSummary   = document.getElementById('google-summary-cards');
const gChartSec  = document.getElementById('google-chart-section');
const gTableSec  = document.getElementById('google-table-section');
const gTableBody = document.getElementById('google-result-body');
const gChartH2   = document.getElementById('google-chart-title-h2');

// ── 영구 캐시 (조회 결과를 reload 후에도 유지) ──────────
const GOOGLE_CACHE_KEY = 'google_last_result_v1';
function googleSaveCache(payload) {
  try { localStorage.setItem(GOOGLE_CACHE_KEY, JSON.stringify(payload)); }
  catch { /* quota 초과 — 무시 */ }
}
function googleLoadCache() {
  try {
    const raw = localStorage.getItem(GOOGLE_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

// ── flatpickr 초기화 (지연 실행: Google 탭 활성화 시) ──
let gInited = false;
function initGoogleOnce() {
  if (gInited) return;
  gInited = true;

  const today = new Date();
  const weekAgo = new Date(); weekAgo.setDate(today.getDate() - 7);

  gFpStartD = flatpickr(gStartD, { dateFormat: 'Y-m-d', locale: 'ko', defaultDate: weekAgo,
    onChange: (d) => { if (d[0]) { gFpEndD.set('minDate', d[0]); gFpEndD.open(); } }
  });
  gFpEndD = flatpickr(gEndD, { dateFormat: 'Y-m-d', locale: 'ko', defaultDate: today, minDate: weekAgo });

  gFpStartW = flatpickr(gStartW, { dateFormat: 'Y-m-d', locale: 'ko', defaultDate: weekAgo,
    onChange: d => { if (d[0]) { gFpEndW.set('minDate', d[0]); gFpEndW.open(); } } });
  gFpEndW   = flatpickr(gEndW,   { dateFormat: 'Y-m-d', locale: 'ko', defaultDate: today });

  gFpStartM = flatpickr(gStartM, { dateFormat: 'Y-m', locale: 'ko', plugins: [new monthSelectPluginIfExists()],
    defaultDate: new Date(today.getFullYear(), today.getMonth() - 1, 1),
    onChange: d => { if (d[0]) { gFpEndM.set('minDate', d[0]); gFpEndM.open(); } } });
  gFpEndM = flatpickr(gEndM, { dateFormat: 'Y-m', locale: 'ko', plugins: [new monthSelectPluginIfExists()],
    defaultDate: today });

  gCmpFpStartD = flatpickr(gCmpStartD, { dateFormat: 'Y-m-d', locale: 'ko',
    onChange: d => { if (d[0]) { gCmpFpEndD.set('minDate', d[0]); gCmpFpEndD.open(); } } });
  gCmpFpEndD   = flatpickr(gCmpEndD,   { dateFormat: 'Y-m-d', locale: 'ko' });

  document.getElementById('google-cmp-date-clear').addEventListener('click', () => {
    gCmpFpStartD.clear(); gCmpFpEndD.clear();
    if (mcsGoogleCmpAdUnit) mcsGoogleCmpAdUnit.setSelected(new Set());
    googleAllRowsB = [];
    googleReRender();
  });

  // MCS 초기화
  mcsGoogleAdUnit = new MultiCheckSelect(
    document.getElementById('mcs-google-adunit'), '광고단위명 선택',
    () => googleReRender()
  );
  mcsGoogleCmpAdUnit = new MultiCheckSelect(
    document.getElementById('mcs-google-cmp-adunit'), '광고단위명 비교 선택',
    () => googleReRender()
  );

  // 이전 조회 결과가 캐시에 있으면 복원 (조회 버튼 누를 필요 없이 바로 화면 표시)
  const cached = googleLoadCache();
  if (cached && Array.isArray(cached.rows) && cached.rows.length > 0) {
    googleAllRows  = cached.rows;
    googleAllRowsB = Array.isArray(cached.rowsB) ? cached.rowsB : [];
    // 날짜 input 도 캐시된 범위로 맞춤
    if (cached.startDate) gFpStartD.setDate(cached.startDate, false);
    if (cached.endDate)   gFpEndD.setDate(cached.endDate, false);
    if (cached.cmpStart)  gCmpFpStartD.setDate(cached.cmpStart, false);
    if (cached.cmpEnd)    gCmpFpEndD.setDate(cached.cmpEnd, false);
    const names = [...new Set(googleAllRows.map(r => r.adUnit).filter(Boolean))].sort();
    mcsGoogleAdUnit.refresh(names);
    mcsGoogleCmpAdUnit.refresh(names);
    googleReRender();
  }
}

// 통합 비교 탭(compare.js)에서 Google 유닛을 미리 채우기 위해서라도
// 페이지 로드 직후 한 번 초기화 (flatpickr 은 이미 있을 때만 동작)
// 실제 flatpickr 은 탭 진입 시점에 초기화되므로, 캐시 복원만 담당하는 경량 버전.
(function hydrateGoogleOnBoot() {
  const cached = googleLoadCache();
  if (!cached || !Array.isArray(cached.rows) || cached.rows.length === 0) return;
  googleAllRows  = cached.rows;
  googleAllRowsB = Array.isArray(cached.rowsB) ? cached.rowsB : [];
})();

// monthSelectPlugin 체크
function monthSelectPluginIfExists() {
  if (typeof flatpickr.plugins?.monthSelect === 'function') return flatpickr.plugins.monthSelect({ shorthand: false, dateFormat: 'Y-m', altFormat: 'Y년 F' });
  // fallback: 일반 달력
  return null;
}

// 기간 탭
document.querySelectorAll('#google-period-tabs .tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    googleCurrentPeriod = btn.dataset.googlePeriod;
    document.querySelectorAll('#google-period-tabs .tab-btn').forEach(b =>
      b.classList.toggle('active', b === btn));
    ['daily','weekly','monthly'].forEach(p =>
      document.getElementById(`google-date-range-${p}`)?.classList.toggle('hidden', p !== googleCurrentPeriod));
    if (googleAllRows.length) googleReRender();
  });
});

// 카드 클릭
document.getElementById('google-summary-cards').addEventListener('click', e => {
  const card = e.target.closest('.card[data-metric]');
  if (!card || googleAllRows.length === 0) return;
  googleChartMetric = card.dataset.metric;
  document.querySelectorAll('#google-summary-cards .card').forEach(c => c.classList.remove('chart-active'));
  card.classList.add('chart-active');
  googleReRender();
});

// 조회 버튼
gSearchBtn.addEventListener('click', googleFetchAndRender);

// ── 실제 API 호출 ───────────────────────────
async function googleFetchAndRender() {
  initGoogleOnce();

  let start, end;
  if (googleCurrentPeriod === 'daily') {
    if (!gStartD.value || !gEndD.value) return alert('시작일/종료일을 선택하세요.');
    start = gStartD.value.replace(/-/g,''); end = gEndD.value.replace(/-/g,'');
  } else if (googleCurrentPeriod === 'weekly') {
    if (!gStartW.value || !gEndW.value) return alert('시작 주/종료 주를 선택하세요.');
    start = gStartW.value.replace(/-/g,''); end = gEndW.value.replace(/-/g,'');
  } else {
    if (!gStartM.value || !gEndM.value) return alert('시작 월/종료 월을 선택하세요.');
    // YYYY-MM → YYYYMM01 / YYYYMMEOM
    const [sy, sm] = gStartM.value.split('-');
    const [ey, em] = gEndM.value.split('-');
    start = `${sy}${sm}01`;
    end   = `${ey}${em}${String(new Date(Number(ey), Number(em), 0).getDate()).padStart(2,'0')}`;
  }

  gErrorMsg.classList.add('hidden');
  gEmptyMsg.classList.add('hidden');
  gLoading.classList.remove('hidden');
  [gSummary, gChartSec, gTableSec].forEach(el => el.style.display = 'none');

  try {
    const res = await fetch(`/api/google/report?startDate=${start}&endDate=${end}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const { headers, rows } = await res.json();
    googleAllRows = mapGoogleRows(headers, rows);

    // 비교 기간도 선택되었으면 같이 조회
    googleAllRowsB = [];
    if (gCmpStartD.value && gCmpEndD.value) {
      const b0 = gCmpStartD.value.replace(/-/g,'');
      const b1 = gCmpEndD.value.replace(/-/g,'');
      const resB = await fetch(`/api/google/report?startDate=${b0}&endDate=${b1}`);
      if (resB.ok) {
        const { headers: hB, rows: rB } = await resB.json();
        googleAllRowsB = mapGoogleRows(hB, rB);
      }
    }

    gLoading.classList.add('hidden');
    if (googleAllRows.length === 0) {
      gEmptyMsg.classList.remove('hidden');
      return;
    }

    // MCS 옵션 채우기
    const names = [...new Set(googleAllRows.map(r => r.adUnit).filter(Boolean))].sort();
    mcsGoogleAdUnit.refresh(names);
    mcsGoogleCmpAdUnit.refresh(names);

    // 결과를 localStorage 에 저장 (다음 접속 시 자동 복원)
    googleSaveCache({
      rows: googleAllRows,
      rowsB: googleAllRowsB,
      startDate: gStartD.value,
      endDate:   gEndD.value,
      cmpStart:  gCmpStartD.value || '',
      cmpEnd:    gCmpEndD.value || '',
      savedAt:   Date.now(),
    });

    googleReRender();
  } catch (err) {
    gLoading.classList.add('hidden');
    gErrorMsg.textContent = `오류: ${err.message}`;
    gErrorMsg.classList.remove('hidden');
    console.error(err);
  }
}

// Ad Manager CSV → 내부 row 스키마
//  TOTAL_LINE_ITEM_LEVEL_* (전체 합산) 우선, 없으면 AD_SERVER_* 사용
function mapGoogleRows(headers, rows) {
  const pickCol = (primaryRe, fallbackRe) =>
    headers.find(h => primaryRe.test(h)) || headers.find(h => fallbackRe.test(h)) || null;

  const cDate = headers.find(h => /DATE/i.test(h));
  const cName = headers.find(h => /AD_UNIT_NAME/i.test(h));
  const cImp  = pickCol(/TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS/i, /IMPRESSIONS/i);
  const cClk  = pickCol(/TOTAL_LINE_ITEM_LEVEL_CLICKS/i,      /CLICKS/i);
  const cRev  = pickCol(/TOTAL_LINE_ITEM_LEVEL_CPM_AND_CPC_REVENUE/i, /REVENUE/i);

  return rows.map(r => {
    const impression = Number(r[cImp] || 0);
    const click      = Number(r[cClk] || 0);
    // Ad Manager 수익은 micros 단위 (1원 = 1,000,000)
    let profit = Number(r[cRev] || 0);
    if (profit >= 1000) profit = profit / 1e6;  // micros → 원
    const ctr  = impression > 0 ? (click / impression * 100) : 0;
    const ecpm = impression > 0 ? (profit / impression * 1000) : 0;
    return {
      date: r[cDate] || '',
      adUnit: r[cName] || '(미지정)',
      impression, click, ctr, ecpm, profit,
    };
  }).filter(r => r.date);
}

function applyGoogleFilter(rows, mcs) {
  if (!mcs) return rows;
  const sel = mcs.selected;
  if (sel.size === 0 || sel.size === mcs.options.length) return rows;
  return rows.filter(r => sel.has(r.adUnit));
}

function googleReRender() {
  let rowsA = applyGoogleFilter(googleAllRows, mcsGoogleAdUnit);
  let rowsB = googleAllRowsB.length
    ? applyGoogleFilter(googleAllRowsB, mcsGoogleCmpAdUnit)
    : [];

  if (googleCurrentPeriod === 'weekly') {
    rowsA = groupGoogleBy(rowsA, 'week');
    if (rowsB.length) rowsB = groupGoogleBy(rowsB, 'week');
  } else if (googleCurrentPeriod === 'monthly') {
    rowsA = groupGoogleBy(rowsA, 'month');
    if (rowsB.length) rowsB = groupGoogleBy(rowsB, 'month');
  }

  if (rowsA.length === 0) {
    gEmptyMsg.classList.remove('hidden');
    [gSummary, gChartSec, gTableSec].forEach(el => el.style.display = 'none');
    return;
  }
  gEmptyMsg.classList.add('hidden');

  renderGoogleSummary(rowsA, rowsB);
  renderGoogleChart(rowsA, rowsB);
  renderGoogleTable(rowsA, rowsB);

  gSummary.style.display = '';
  gChartSec.style.display = '';
  gTableSec.style.display = '';
}

function groupGoogleBy(rows, unit) {
  const map = new Map();
  for (const r of rows) {
    // YYYY-MM-DD → week/month key
    const d = new Date(r.date);
    let key;
    if (unit === 'week') {
      const wk = new Date(d); wk.setDate(d.getDate() - d.getDay());
      key = toDateStr(wk);
    } else {
      key = r.date.slice(0, 7);
    }
    const prev = map.get(key) || { date: key, adUnit: '합계', impression: 0, click: 0, profit: 0 };
    prev.impression += r.impression;
    prev.click      += r.click;
    prev.profit     += r.profit;
    map.set(key, prev);
  }
  return [...map.values()].map(r => ({
    ...r,
    ctr:  r.impression > 0 ? (r.click / r.impression * 100) : 0,
    ecpm: r.impression > 0 ? (r.profit / r.impression * 1000) : 0,
  })).sort((a, b) => a.date < b.date ? -1 : 1);
}

function sumMetric(rows, m) {
  if (m === 'profit' || m === 'impression' || m === 'click')
    return rows.reduce((a, r) => a + (r[m] || 0), 0);
  if (m === 'ctr') {
    const imp = rows.reduce((a, r) => a + r.impression, 0);
    const clk = rows.reduce((a, r) => a + r.click, 0);
    return imp > 0 ? (clk / imp * 100) : 0;
  }
  if (m === 'ecpm') {
    const imp = rows.reduce((a, r) => a + r.impression, 0);
    const prf = rows.reduce((a, r) => a + r.profit, 0);
    return imp > 0 ? (prf / imp * 1000) : 0;
  }
  return 0;
}

function renderGoogleSummary(rowsA, rowsB) {
  const A = {
    profit:     sumMetric(rowsA, 'profit'),
    impression: sumMetric(rowsA, 'impression'),
    click:      sumMetric(rowsA, 'click'),
    ctr:        sumMetric(rowsA, 'ctr'),
    ecpm:       sumMetric(rowsA, 'ecpm'),
  };
  const hasB = rowsB.length > 0;
  const B = hasB ? {
    profit:     sumMetric(rowsB, 'profit'),
    impression: sumMetric(rowsB, 'impression'),
    click:      sumMetric(rowsB, 'click'),
    ctr:        sumMetric(rowsB, 'ctr'),
    ecpm:       sumMetric(rowsB, 'ecpm'),
  } : null;

  const fmt = (v, m) => gFmtNum(v, m);
  const setCard = (id, m) => {
    const el = document.getElementById(id);
    if (!hasB) { el.innerHTML = fmt(A[m], m); return; }
    el.innerHTML =
      `<span class="cv-primary">${fmt(A[m], m)}</span>` +
      `<span class="cv-compare">vs ${fmt(B[m], m)}</span>`;
  };
  setCard('google-total-profit',     'profit');
  setCard('google-total-impression', 'impression');
  setCard('google-total-click',      'click');
  setCard('google-total-ctr',        'ctr');
  setCard('google-total-ecpm',       'ecpm');
}

function renderGoogleChart(rowsA, rowsB) {
  const ctx = document.getElementById('google-profit-chart');
  const m = googleChartMetric;
  gChartH2.textContent = `날짜별 ${gMetricLabel(m)} 추이`;

  const buildSeries = rows => {
    const map = new Map();
    for (const r of rows) {
      const v = r[m] ?? 0;
      if (m === 'ctr' || m === 'ecpm') {
        const prev = map.get(r.date) || { imp: 0, clk: 0, prf: 0 };
        prev.imp += r.impression; prev.clk += r.click; prev.prf += r.profit;
        map.set(r.date, prev);
      } else {
        map.set(r.date, (map.get(r.date) || 0) + v);
      }
    }
    const dates = [...map.keys()].sort();
    const values = dates.map(d => {
      const v = map.get(d);
      if (m === 'ctr')  return v.imp > 0 ? (v.clk / v.imp * 100) : 0;
      if (m === 'ecpm') return v.imp > 0 ? (v.prf / v.imp * 1000) : 0;
      return v;
    });
    return { dates, values };
  };
  const A = buildSeries(rowsA);
  const B = rowsB.length ? buildSeries(rowsB) : null;

  // 라벨 통합
  const allDates = [...new Set([...A.dates, ...(B?.dates || [])])].sort();
  const dataA = allDates.map(d => A.dates.includes(d) ? A.values[A.dates.indexOf(d)] : null);
  const dataB = B ? allDates.map(d => B.dates.includes(d) ? B.values[B.dates.indexOf(d)] : null) : null;

  const datasets = [{
    label: `기본 ${gMetricLabel(m)}`,
    data: dataA, borderColor: '#1A73E8', backgroundColor: 'rgba(26,115,232,.1)',
    tension: 0.3, fill: true, pointRadius: 3,
  }];
  if (dataB) datasets.push({
    label: `비교 ${gMetricLabel(m)}`,
    data: dataB, borderColor: '#F97316', backgroundColor: 'rgba(249,115,22,.1)',
    borderDash: [6, 4], tension: 0.3, fill: false, pointRadius: 3,
  });

  if (googleChart) googleChart.destroy();
  let gHoverIdx = null;
  googleChart = new Chart(ctx, {
    type: 'line',
    data: { labels: allDates, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      onHover: (event, elements, chart) => {
        const newIdx = elements.length > 0 ? elements[0].index : null;
        if (newIdx !== gHoverIdx) {
          gHoverIdx = newIdx;
          chart.update('none');
        }
      },
      plugins: {
        legend: { position: 'top' },
        tooltip: { callbacks: { label: c => `${c.dataset.label}: ${gFmtNum(c.parsed.y, m)}` } },
      },
      scales: {
        x: {
          ticks: {
            color: (c) => c.index === gHoverIdx ? '#DC2626' : '#6B7280',
            font: (c) => c.index === gHoverIdx
              ? { weight: 'bold', size: 13 }
              : { weight: 'normal', size: 12 },
          },
          grid: {
            color: (c) => c.index === gHoverIdx ? 'rgba(220, 38, 38, 0.25)' : 'rgba(0, 0, 0, 0.05)',
            lineWidth: (c) => c.index === gHoverIdx ? 2 : 1,
          },
        },
        y: { beginAtZero: true, ticks: { callback: v => gFmtNum(v, m) } },
      },
    },
  });
}

function renderGoogleTable(rowsA, rowsB) {
  const totalProfit = rowsA.reduce((a, r) => a + r.profit, 0);
  const tr = (r, cls = '') => `
    <tr class="${cls}">
      <td>${r.date}</td>
      <td>${r.adUnit}</td>
      <td>${num(r.impression)}</td>
      <td>${num(r.click)}</td>
      <td>${gpct(r.ctr)}</td>
      <td>${krw(r.ecpm)}</td>
      <td>${krw(r.profit)}</td>
      <td>${totalProfit > 0 ? gpct(r.profit / totalProfit * 100) : '-'}</td>
    </tr>`;

  // 정렬
  const sorted = sortGoogleRows(rowsA);
  gTableBody.innerHTML = sorted.map(r => tr(r, 'tr-group-a')).join('')
    + (rowsB.length ? rowsB.map(r => tr(r, 'tr-group-b')).join('') : '');

  document.getElementById('google-row-count').textContent = `${rowsA.length}행` + (rowsB.length ? ` (+비교 ${rowsB.length}행)` : '');
}

function sortGoogleRows(rows) {
  const { col, dir } = googleSortState;
  return [...rows].sort((a, b) => {
    const va = a[col] ?? 0, vb = b[col] ?? 0;
    if (typeof va === 'string') return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    return dir === 'asc' ? va - vb : vb - va;
  });
}

// 컬럼 헤더 정렬
document.querySelectorAll('#google-result-table thead th').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.dataset.col;
    if (!col) return;
    if (googleSortState.col === col)
      googleSortState.dir = googleSortState.dir === 'asc' ? 'desc' : 'asc';
    else { googleSortState.col = col; googleSortState.dir = 'desc'; }
    if (googleAllRows.length) googleReRender();
  });
});

// CSV 다운로드
document.getElementById('google-csv-btn').addEventListener('click', () => {
  const rowsA = applyGoogleFilter(googleAllRows, mcsGoogleAdUnit);
  if (!rowsA.length) return;
  const header = ['날짜','광고단위명','노출수','클릭수','CTR(%)','eCPM(원)','수익(원)'];
  const lines = [header.join(',')];
  for (const r of rowsA) {
    lines.push([r.date, `"${r.adUnit}"`, r.impression, r.click,
                r.ctr.toFixed(2), r.ecpm.toFixed(0), r.profit.toFixed(0)].join(','));
  }
  const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `google-admanager-${Date.now()}.csv`;
  a.click();
});

// Google 탭 최초 진입 시 flatpickr 초기화
document.querySelectorAll('.pnav-btn[data-pnav="google"]').forEach(btn =>
  btn.addEventListener('click', initGoogleOnce));
// 페이지 로드 시 이미 Google 탭이 활성이었다면 바로 초기화
if (localStorage.getItem('pnav_active') === 'google') initGoogleOnce();

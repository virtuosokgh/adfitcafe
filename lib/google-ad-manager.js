/**
 * Google Ad Manager SOAP 클라이언트
 *
 * ReportService 사용 흐름:
 *   1) runReportJob(reportJob) -> ReportJob(id)
 *   2) getReportJobStatus(id) -> 폴링 (COMPLETED 될 때까지)
 *   3) getReportDownloadURL(id, 'CSV_DUMP') -> signed URL
 *   4) GET signed URL -> gzip된 CSV
 *
 * 성능 개선:
 *   - `googleapis` 의존성 제거 (콜드스타트 단축): OAuth 토큰 리프레시를 직접 fetch로 호출
 *   - 액세스 토큰 모듈 캐시 (~55분 TTL)
 *   - 네트워크/5xx/429 자동 재시도 (지수 백오프)
 *   - fetch 타임아웃 (AbortSignal.timeout)
 *   - 진행 로그 (Vercel 함수 로그용)
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const fetch = require('node-fetch');

const API_VERSION = 'v202511';
const APP_NAME    = 'axz-dashboard';

const CRED_PATH  = path.join(__dirname, '..', 'credentials', 'google-oauth.json');
const TOKEN_PATH = path.join(__dirname, '..', 'credentials', 'google-token.json');

// -----------------------------------------------------------------------------
// OAuth: 직접 토큰 리프레시 (googleapis 미사용)
// -----------------------------------------------------------------------------
let _creds = null;
function loadCreds() {
  if (_creds) return _creds;
  if (fs.existsSync(CRED_PATH) && fs.existsSync(TOKEN_PATH)) {
    const raw = JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
    const cred = raw.installed || raw.web;
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    _creds = {
      client_id:     cred.client_id,
      client_secret: cred.client_secret,
      refresh_token: token.refresh_token,
    };
  } else if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_REFRESH_TOKEN) {
    _creds = {
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    };
  } else {
    throw new Error('구글 OAuth 자격증명 없음. scripts/get-google-token.js 를 먼저 실행하세요.');
  }
  return _creds;
}

// 모듈 단위 토큰 캐시 (Vercel 함수가 warm한 동안 재사용)
let _tokenCache = null; // { token, exp }

async function getAccessToken() {
  if (_tokenCache && Date.now() < _tokenCache.exp) {
    return _tokenCache.token;
  }
  const c = loadCreds();
  const params = new URLSearchParams({
    client_id:     c.client_id,
    client_secret: c.client_secret,
    refresh_token: c.refresh_token,
    grant_type:    'refresh_token',
  });

  // 토큰 리프레시는 재시도 (네트워크 순간 장애 대응)
  const res = await withRetry(
    () => fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      // node-fetch는 AbortController 사용해야 timeout 가능
      signal: timeoutSignal(10_000),
    }),
    { attempts: 3, label: 'oauth-refresh' }
  );
  const body = await res.text();
  if (!res.ok) throw new Error(`OAuth refresh 실패 ${res.status}: ${body.slice(0, 300)}`);
  const j = JSON.parse(body);
  if (!j.access_token) throw new Error('access_token 발급 실패: ' + body.slice(0, 200));

  // 만료 시간: expires_in(초) - 60초 여유
  const ttlMs = Math.max(60_000, ((j.expires_in || 3600) - 60) * 1000);
  _tokenCache = { token: j.access_token, exp: Date.now() + ttlMs };
  return j.access_token;
}

// -----------------------------------------------------------------------------
// 유틸: 타임아웃 + 재시도
// -----------------------------------------------------------------------------
function timeoutSignal(ms) {
  // Node 18+ 에 AbortSignal.timeout 있음. 구버전 호환.
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const ac = new AbortController();
  setTimeout(() => ac.abort(), ms);
  return ac.signal;
}

async function withRetry(fn, { attempts = 3, label = 'op' } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fn();
      // HTTP 재시도 판단
      if (res && typeof res.status === 'number') {
        if (res.status >= 500 || res.status === 429 || res.status === 408) {
          throw new Error(`HTTP ${res.status}`);
        }
      }
      return res;
    } catch (err) {
      lastErr = err;
      const retriable =
        /ECONN|ETIMEDOUT|ENETUNREACH|ENOTFOUND|EAI_AGAIN|socket hang up|HTTP (5\d\d|429|408)|aborted|timeout/i.test(
          String(err && err.message)
        );
      const isLast = i === attempts - 1;
      if (!retriable || isLast) break;
      const backoff = 500 * 2 ** i + Math.floor(Math.random() * 200); // 500/1000/2000ms + 지터
      console.warn(`[google][retry] ${label} attempt ${i + 1}/${attempts} failed (${err.message}); backoff ${backoff}ms`);
      await new Promise(r => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

// -----------------------------------------------------------------------------
// SOAP XML 빌더
// -----------------------------------------------------------------------------
function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, c =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c])
  );
}

function soapEnvelope(networkCode, operationBody) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
    xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
    xmlns="https://www.google.com/apis/ads/publisher/${API_VERSION}">
  <soapenv:Header>
    <ns1:RequestHeader
        soapenv:mustUnderstand="0"
        xmlns:ns1="https://www.google.com/apis/ads/publisher/${API_VERSION}">
      <ns1:networkCode>${escapeXml(networkCode)}</ns1:networkCode>
      <ns1:applicationName>${escapeXml(APP_NAME)}</ns1:applicationName>
    </ns1:RequestHeader>
  </soapenv:Header>
  <soapenv:Body>
    ${operationBody}
  </soapenv:Body>
</soapenv:Envelope>`;
}

async function callSoap(service, networkCode, operationBody, { label = service, timeoutMs = 30_000 } = {}) {
  const url = `https://ads.google.com/apis/ads/publisher/${API_VERSION}/${service}`;
  const body = soapEnvelope(networkCode, operationBody);

  const res = await withRetry(async () => {
    const accessToken = await getAccessToken();
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=UTF-8',
        'Authorization': `Bearer ${accessToken}`,
        'SOAPAction': '""',
      },
      body,
      signal: timeoutSignal(timeoutMs),
    });
    // 401이면 토큰 캐시 비우고 재시도 루프로
    if (r.status === 401) {
      _tokenCache = null;
      throw new Error('HTTP 401 (token invalidated)');
    }
    return r;
  }, { attempts: 3, label });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`SOAP ${res.status} (${label}): ${text.slice(0, 800)}`);
  }
  return text;
}

// XML 엔티티 디코딩 (&amp; &lt; &gt; &quot; &apos;)
function decodeXml(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// 단순 XML 파싱 (우리가 쓰는 필드만)
function pick(xml, tag) {
  const re = new RegExp(`<(?:\\w+:)?${tag}>([\\s\\S]*?)</(?:\\w+:)?${tag}>`);
  const m = xml.match(re);
  return m ? decodeXml(m[1]) : null;
}

// -----------------------------------------------------------------------------
// 보고서 실행
// -----------------------------------------------------------------------------
/**
 * @param {object} opts
 * @param {string} opts.networkCode
 * @param {string[]} opts.dimensions   예: ['DATE','AD_UNIT_NAME']
 * @param {string[]} opts.columns      예: ['AD_SERVER_IMPRESSIONS',...]
 * @param {string} opts.startDate      YYYY-MM-DD
 * @param {string} opts.endDate        YYYY-MM-DD
 * @param {string} [opts.adUnitView]   TOP_LEVEL | FLAT | HIERARCHICAL (default: FLAT)
 */
async function runReport({ networkCode, dimensions, columns, startDate, endDate, adUnitView = 'FLAT' }) {
  const t0 = Date.now();
  const [sY, sM, sD] = startDate.split('-');
  const [eY, eM, eD] = endDate.split('-');

  // ReportQuery 스키마 순서:
  //   dimensions → adUnitView → columns → ... → startDate → endDate → dateRangeType
  // 1) runReportJob
  const runBody = `
    <runReportJob xmlns="https://www.google.com/apis/ads/publisher/${API_VERSION}">
      <reportJob>
        <reportQuery>
          ${dimensions.map(d => `<dimensions>${d}</dimensions>`).join('')}
          <adUnitView>${adUnitView}</adUnitView>
          ${columns.map(c => `<columns>${c}</columns>`).join('')}
          <startDate>
            <year>${sY}</year><month>${Number(sM)}</month><day>${Number(sD)}</day>
          </startDate>
          <endDate>
            <year>${eY}</year><month>${Number(eM)}</month><day>${Number(eD)}</day>
          </endDate>
          <dateRangeType>CUSTOM_DATE</dateRangeType>
        </reportQuery>
      </reportJob>
    </runReportJob>`;

  const runXml = await callSoap('ReportService', networkCode, runBody, { label: 'runReportJob' });
  const jobId = pick(runXml, 'id');
  if (!jobId) throw new Error('reportJob id 파싱 실패: ' + runXml.slice(0, 500));
  console.log(`[google] runReportJob ok jobId=${jobId} (${Date.now() - t0}ms)`);

  // 2) 상태 폴링 (초기 대기 2초 → 점진적 백오프)
  //    대부분의 리포트는 2~5초에 완료됨. 첫 체크를 너무 빨리 하면 무의미한 호출만 증가.
  const deadline = Date.now() + 55_000; // 55초 내 완료. (Vercel maxDuration=60과 버퍼)
  const intervals = [2000, 1500, 1500, 2000, 2500, 3000];
  let attempt = 0;
  let status = 'IN_PROGRESS';
  while (Date.now() < deadline) {
    const wait = intervals[Math.min(attempt, intervals.length - 1)];
    await new Promise(r => setTimeout(r, wait));
    attempt++;
    const statusBody = `
      <getReportJobStatus xmlns="https://www.google.com/apis/ads/publisher/${API_VERSION}">
        <reportJobId>${jobId}</reportJobId>
      </getReportJobStatus>`;
    const statusXml = await callSoap('ReportService', networkCode, statusBody, {
      label: `getReportJobStatus#${attempt}`,
      timeoutMs: 15_000,
    });
    status = pick(statusXml, 'rval') || pick(statusXml, 'return') || '';
    if (status.includes('COMPLETED') || /COMPLETED/.test(statusXml)) { status = 'COMPLETED'; break; }
    if (/FAILED/.test(statusXml)) {
      throw new Error(`보고서 실패 (jobId=${jobId}): ` + statusXml.slice(0, 500));
    }
  }
  if (status !== 'COMPLETED') {
    throw new Error(`보고서 시간초과 (jobId=${jobId}, ${attempt}회 폴링, ${Date.now() - t0}ms)`);
  }
  console.log(`[google] report completed jobId=${jobId} polls=${attempt} (${Date.now() - t0}ms)`);

  // 3) 다운로드 URL
  const urlBody = `
    <getReportDownloadURL xmlns="https://www.google.com/apis/ads/publisher/${API_VERSION}">
      <reportJobId>${jobId}</reportJobId>
      <exportFormat>CSV_DUMP</exportFormat>
    </getReportDownloadURL>`;
  const urlXml = await callSoap('ReportService', networkCode, urlBody, { label: 'getReportDownloadURL' });
  const dlUrl = pick(urlXml, 'rval') || pick(urlXml, 'return');
  if (!dlUrl) throw new Error('다운로드 URL 파싱 실패');

  // 4) 다운로드 (gzip 여부 자동 감지: 1f 8b 매직바이트)
  const dlRes = await withRetry(
    () => fetch(dlUrl, { signal: timeoutSignal(20_000) }),
    { attempts: 3, label: 'download-csv' }
  );
  if (!dlRes.ok) throw new Error(`CSV 다운로드 실패 ${dlRes.status}`);
  const buf = await dlRes.buffer();
  const isGzip = buf[0] === 0x1f && buf[1] === 0x8b;
  const csv = isGzip ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
  const parsed = parseCsv(csv);
  console.log(`[google] runReport done rows=${parsed.rows.length} total=${Date.now() - t0}ms`);
  return parsed;
}

function parseCsv(csv) {
  const lines = csv.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = splitCsvLine(lines[0]);
  const rows = lines.slice(1).map(l => {
    const cells = splitCsvLine(l);
    const o = {};
    headers.forEach((h, i) => { o[h] = cells[i] ?? ''; });
    return o;
  });
  return { headers, rows };
}

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else {
      if (c === ',') { out.push(cur); cur = ''; }
      else if (c === '"') inQ = true;
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

module.exports = { runReport, getAccessToken };

/**
 * Google Ad Manager SOAP 클라이언트
 *
 * ReportService 사용 흐름:
 *   1) runReportJob(reportJob) -> ReportJob(id)
 *   2) getReportJobStatus(id) -> 폴링 (COMPLETED 될 때까지)
 *   3) getReportDownloadURL(id, 'CSV_DUMP') -> signed URL
 *   4) GET signed URL -> gzip된 CSV
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const fetch = require('node-fetch');
const { google } = require('googleapis');

const API_VERSION = 'v202511';
const APP_NAME    = 'axz-dashboard';

const CRED_PATH  = path.join(__dirname, '..', 'credentials', 'google-oauth.json');
const TOKEN_PATH = path.join(__dirname, '..', 'credentials', 'google-token.json');

let _oauthClient = null;
function getOAuth() {
  if (_oauthClient) return _oauthClient;

  // 1순위: 파일 / 2순위: 환경변수 (Vercel 배포용)
  let cred, token;
  if (fs.existsSync(CRED_PATH) && fs.existsSync(TOKEN_PATH)) {
    const raw = JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
    cred = raw.installed || raw.web;
    token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  } else if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_REFRESH_TOKEN) {
    cred = {
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
    };
    token = { refresh_token: process.env.GOOGLE_REFRESH_TOKEN };
  } else {
    throw new Error('구글 OAuth 자격증명 없음. scripts/get-google-token.js 를 먼저 실행하세요.');
  }

  const client = new google.auth.OAuth2(cred.client_id, cred.client_secret);
  client.setCredentials(token);
  _oauthClient = client;
  return client;
}

async function getAccessToken() {
  const client = getOAuth();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('access_token 발급 실패');
  return token;
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

async function callSoap(service, networkCode, operationBody) {
  const accessToken = await getAccessToken();
  const url = `https://ads.google.com/apis/ads/publisher/${API_VERSION}/${service}`;
  const body = soapEnvelope(networkCode, operationBody);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=UTF-8',
      'Authorization': `Bearer ${accessToken}`,
      'SOAPAction': '""',
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`SOAP ${res.status}: ${text.slice(0, 800)}`);
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

  const runXml = await callSoap('ReportService', networkCode, runBody);
  const jobId = pick(runXml, 'id');
  if (!jobId) throw new Error('reportJob id 파싱 실패: ' + runXml.slice(0, 500));

  // 2) 상태 폴링 (빠른 초기 체크 → 점진적 백오프)
  //    간격: 500ms, 750ms, 1000ms, 1500ms, 2000ms ... (최대 2.5초)
  const deadline = Date.now() + 120_000;
  const intervals = [500, 750, 1000, 1500, 2000];
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
    const statusXml = await callSoap('ReportService', networkCode, statusBody);
    status = pick(statusXml, 'rval') || pick(statusXml, 'return') || '';
    if (status.includes('COMPLETED') || /COMPLETED/.test(statusXml)) { status = 'COMPLETED'; break; }
    if (/FAILED/.test(statusXml)) throw new Error('보고서 실패: ' + statusXml.slice(0, 500));
  }
  if (status !== 'COMPLETED') throw new Error('보고서 시간초과');

  // 3) 다운로드 URL
  const urlBody = `
    <getReportDownloadURL xmlns="https://www.google.com/apis/ads/publisher/${API_VERSION}">
      <reportJobId>${jobId}</reportJobId>
      <exportFormat>CSV_DUMP</exportFormat>
    </getReportDownloadURL>`;
  const urlXml = await callSoap('ReportService', networkCode, urlBody);
  const dlUrl = pick(urlXml, 'rval') || pick(urlXml, 'return');
  if (!dlUrl) throw new Error('다운로드 URL 파싱 실패');

  // 4) 다운로드 (gzip 여부 자동 감지: 1f 8b 매직바이트)
  const dlRes = await fetch(dlUrl);
  const buf = await dlRes.buffer();
  const isGzip = buf[0] === 0x1f && buf[1] === 0x8b;
  const csv = isGzip ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
  return parseCsv(csv);
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

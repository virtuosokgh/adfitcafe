// Vercel Edge Function - API 프록시
// Edge Runtime: 콜드스타트 없음, 전 세계 엣지 노드에서 실행
export const config = { runtime: 'edge' };

const API_KEY  = '1707c6fa620d72cf9d391a26db10a71dcbc62692';
// v2 는 2026-09 종료(410 GONE) → v3 로 이전.
//   v3: ?apikey&fromDate&toDate&periodType(DAY|MONTH), 응답 필드명이 달라 정규화 필요.
const ADFIT_URL = 'https://adfit-external-api.kakao.com/publisher/v3/report';

// v3 응답을 v2 형식으로 정규화 (프론트 필드명 유지 + 신규 필드 추가)
function normalizeAdfitV3(data) {
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  return {
    ...data,
    rows: rows.map(r => ({
      day:        String(r.reportDate || '').replace(/-/g, ''),
      adunitId:   r.adunitId,
      adunitName: r.adunitName,
      mediaId:    r.mediaId,
      mediaName:  r.mediaName,
      mediaUrl:   r.mediaUrl,
      request:    Number(r.adRequestCount) || 0,
      response:   Number(r.winCount) || 0,
      impression: Number(r.impressionCount) || 0,
      click:      Number(r.clickCount) || 0,
      profit:     Number(r.profit) || 0,
      viewableImpression: Number(r.viewableImpressionCount) || 0,
      fillRate:    Number(r.fillRate) || 0,
      winFillRate: Number(r.winFillRate) || 0,
      vr:          Number(r.vr) || 0,
      ctr:         Number(r.ctr) || 0,
      ecpm:        Number(r.ecpm) || 0,
    })),
  };
}

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const periodType = searchParams.get('periodType');
  const startDate  = searchParams.get('startDate');
  const endDate    = searchParams.get('endDate');

  if (!periodType || !startDate || !endDate) {
    return new Response(
      JSON.stringify({ error: 'periodType, startDate, endDate 필요' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const params = new URLSearchParams({
    apikey: API_KEY,
    periodType: periodType === 'M' ? 'MONTH' : 'DAY',
    fromDate: startDate,
    toDate: endDate,
  });

  try {
    const response = await fetch(`${ADFIT_URL}?${params}`);
    const raw = await response.json();
    const data = response.ok ? normalizeAdfitV3(raw) : raw;

    // 과거 데이터(오늘 미포함): 24시간 CDN 캐시
    // 오늘 포함된 데이터: 5분 캐시 (stale-while-revalidate로 즉시 응답 후 백그라운드 갱신)
    const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const maxAge   = endDate < todayStr ? 86400 : 300;

    return new Response(JSON.stringify(data), {
      status: response.status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `s-maxage=${maxAge}, stale-while-revalidate=60`,
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: '서버 오류' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

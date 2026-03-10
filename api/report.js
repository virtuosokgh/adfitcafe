// Vercel Edge Function - API 프록시
// Edge Runtime: 콜드스타트 없음, 전 세계 엣지 노드에서 실행
export const config = { runtime: 'edge' };

const API_KEY  = '1707c6fa620d72cf9d391a26db10a71dcbc62692';
const ADFIT_URL = 'https://adfit-external-api.kakao.com/publisher/v2/report';

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

  const params = new URLSearchParams({ apikey: API_KEY, periodType, startDate, endDate });

  try {
    const response = await fetch(`${ADFIT_URL}?${params}`);
    const data = await response.json();

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

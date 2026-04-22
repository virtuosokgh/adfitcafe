// Vercel Serverless Function (Node runtime)
//   GET /api/google/report?startDate=YYYYMMDD&endDate=YYYYMMDD
// Google Ad Manager SOAP 리포트를 실행하고 JSON 반환.
// 자격증명은 환경변수 (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN) 사용.

const { runReport } = require('../../lib/google-ad-manager');

const GOOGLE_NETWORK_CODE = process.env.GOOGLE_NETWORK_CODE || '113951510';

module.exports = async (req, res) => {
  const { startDate, endDate } = req.query;
  if (!/^\d{8}$/.test(startDate || '') || !/^\d{8}$/.test(endDate || '')) {
    return res.status(400).json({ error: 'startDate, endDate(YYYYMMDD)가 필요합니다.' });
  }

  const fmt = s => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

  try {
    const result = await runReport({
      networkCode: GOOGLE_NETWORK_CODE,
      dimensions: ['DATE', 'AD_UNIT_NAME'],
      // TOTAL_LINE_ITEM_LEVEL_* 만 (Ad Server + Ad Exchange 합산) + AD_REQUESTS (요청수)
      columns: [
        'TOTAL_AD_REQUESTS',
        'TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS',
        'TOTAL_LINE_ITEM_LEVEL_CLICKS',
        'TOTAL_LINE_ITEM_LEVEL_CPM_AND_CPC_REVENUE',
      ],
      startDate: fmt(startDate),
      endDate:   fmt(endDate),
    });

    // 과거 데이터: 24시간 CDN 캐시 / 오늘 포함: 5분 캐시
    const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const maxAge   = endDate < todayStr ? 86400 : 300;
    res.setHeader('Cache-Control', `s-maxage=${maxAge}, stale-while-revalidate=60`);

    return res.status(200).json(result);
  } catch (err) {
    console.error('Google API 오류:', err);
    return res.status(500).json({ error: err.message || '서버 오류' });
  }
};

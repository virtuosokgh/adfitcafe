// Vercel Serverless Function - API 프록시
const API_KEY = '1707c6fa620d72cf9d391a26db10a71dcbc62692';
const ADFIT_URL = 'https://adfit-external-api.kakao.com/publisher/v2/report';

export default async function handler(req, res) {
  const { periodType, startDate, endDate } = req.query;

  if (!periodType || !startDate || !endDate) {
    return res.status(400).json({ error: 'periodType, startDate, endDate 필요' });
  }

  const params = new URLSearchParams({ apikey: API_KEY, periodType, startDate, endDate });

  try {
    const response = await fetch(`${ADFIT_URL}?${params}`);
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: '서버 오류' });
  }
}

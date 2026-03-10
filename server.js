const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = 3000;

const ADFIT_API_URL = 'https://adfit-external-api.kakao.com/publisher/v2/report';
const API_KEY = '1707c6fa620d72cf9d391a26db10a71dcbc62692';

app.use(express.static(path.join(__dirname, 'public')));

// 날짜 파라미터 포맷 검증
function isValidDate(str, type) {
  if (type === 'D') return /^\d{8}$/.test(str);
  if (type === 'M') return /^\d{6}$/.test(str);
  return false;
}

app.get('/api/report', async (req, res) => {
  const { periodType, startDate, endDate } = req.query;

  if (!periodType || !startDate || !endDate) {
    return res.status(400).json({ error: 'periodType, startDate, endDate 파라미터가 필요합니다.' });
  }

  if (!['D', 'M'].includes(periodType)) {
    return res.status(400).json({ error: 'periodType은 D 또는 M이어야 합니다.' });
  }

  if (!isValidDate(startDate, periodType) || !isValidDate(endDate, periodType)) {
    return res.status(400).json({ error: '날짜 형식이 올바르지 않습니다.' });
  }

  const params = new URLSearchParams({ apikey: API_KEY, periodType, startDate, endDate });
  const url = `${ADFIT_API_URL}?${params.toString()}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: `API 오류: ${response.status}`, detail: text });
    }
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('API 호출 오류:', err);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

app.listen(PORT, () => {
  console.log(`카페 애드핏 대시보드 실행 중: http://localhost:${PORT}`);
});

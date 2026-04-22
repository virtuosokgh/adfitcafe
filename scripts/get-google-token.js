/**
 * 구글 OAuth 1회성 인증 스크립트
 *
 * 실행:
 *   node scripts/get-google-token.js
 *
 * 동작:
 *   1) 로컬 포트 열고 OAuth URL 출력
 *   2) 브라우저에서 열어 계정 선택(vitus.smile@axzcorp.com) + 권한 동의
 *   3) 리다이렉트로 돌아온 code → refresh_token 교환
 *   4) credentials/google-token.json 에 저장
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const url = require('url');
const { google } = require('googleapis');

const CRED_PATH  = path.join(__dirname, '..', 'credentials', 'google-oauth.json');
const TOKEN_PATH = path.join(__dirname, '..', 'credentials', 'google-token.json');
const SCOPES = ['https://www.googleapis.com/auth/admanager'];
const LOOPBACK_PORT = 53682;

function makeClient() {
  const raw = JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
  const cfg = raw.installed || raw.web;
  return new google.auth.OAuth2(
    cfg.client_id,
    cfg.client_secret,
    `http://localhost:${LOOPBACK_PORT}`
  );
}

async function main() {
  const oauth2 = makeClient();

  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });

  console.log('\n================================================================');
  console.log(' 아래 URL을 브라우저에서 여세요 (vitus.smile@axzcorp.com 로그인):');
  console.log('================================================================\n');
  console.log(authUrl);
  console.log('\n권한 승인 후 자동으로 이 스크립트가 종료됩니다...\n');

  // 브라우저 자동 오픈 시도 (macOS)
  try { require('child_process').exec(`open "${authUrl}"`); } catch {}

  await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const parsed = url.parse(req.url, true);
        const code = parsed.query.code;
        if (!code) {
          res.writeHead(400);
          res.end('code 파라미터가 없습니다.');
          return;
        }
        const { tokens } = await oauth2.getToken(code);
        if (!tokens.refresh_token) {
          res.writeHead(500);
          res.end('refresh_token이 발급되지 않았습니다. Google 계정 > 보안 > 타사 액세스에서 기존 권한 해제 후 재시도하세요.');
          reject(new Error('No refresh_token'));
          return;
        }
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
        console.log('\n✅ 저장 완료:', TOKEN_PATH);
        console.log('   refresh_token 획득 성공\n');

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <html><body style="font-family:sans-serif;padding:40px;text-align:center">
            <h1 style="color:#16a34a">✅ 인증 완료</h1>
            <p>이 창을 닫고 터미널로 돌아가세요.</p>
          </body></html>
        `);
        server.close();
        resolve();
      } catch (err) {
        res.writeHead(500);
        res.end('오류: ' + err.message);
        reject(err);
      }
    });
    server.listen(LOOPBACK_PORT, 'localhost');
  });

  process.exit(0);
}

main().catch(err => {
  console.error('❌ 인증 실패:', err.message);
  process.exit(1);
});

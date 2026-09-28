const http = require('http');

function postLogin(cb) {
  const data = 'username=admin&password=admin123';
  const req = http.request({
    hostname: 'localhost',
    port: 3000,
    path: '/login',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(data),
    },
  }, (res) => {
    let body = '';
    const cookies = res.headers['set-cookie'];
    res.on('data', (c) => body += c);
    res.on('end', () => {
      console.log('LOGIN STATUS:', res.statusCode, 'REDIRECT:', res.headers.location || 'none');
      console.log('COOKIES SET:', cookies ? cookies.length + ' cookie(s)' : 'none');
      cb(cookies ? cookies[0].split(';')[0] : null);
    });
  });
  req.on('error', (e) => { console.error('LOGIN ERROR:', e.message); cb(null); });
  req.write(data);
  req.end();
}

function getPage(sessionCookie, path, name, cb) {
  const req = http.request({
    hostname: 'localhost',
    port: 3000,
    path: path,
    headers: { Cookie: sessionCookie },
  }, (res) => {
    let body = '';
    res.on('data', (c) => body += c);
    res.on('end', () => {
      console.log(name + ' => STATUS:', res.statusCode, 'LEN:', body.length, 'REDIRECT:', res.headers.location || 'none');
      if (res.statusCode === 200 && body.length > 500) {
        const title = (body.match(/<title>(.*?)<\/title>/i) || [])[1] || 'n/a';
        console.log('  HEAD <title>:', title);
        console.log('  Contains sidebar link Upload JSON Cases:', body.includes('Upload JSON Cases') ? 'YES' : 'NO');
        console.log('  Contains icon fa-file-code:', body.includes('fa-file-code') ? 'YES' : 'NO');
        if (path === '/upload-json-cases') {
          console.log('  Contains mapping card/regular info:', (body.includes('regular') || body.includes('Mapping')) ? 'YES' : 'NO');
          console.log('  Contains multiple file accept .json:', (body.includes('multiple') && body.includes('.json')) ? 'YES' : 'NO');
          console.log('  Contains submit button proses:', (body.includes('Proses') || body.includes('Upload &amp; Proses')) ? 'YES' : 'NO');
        }
      } else if (res.statusCode >= 400) {
        console.log('  ERROR BODY PREVIEW:', body.substring(0, 300));
      }
      cb(body);
    });
  });
  req.on('error', (e) => { console.error('GET ERROR:', e.message); cb(''); });
  req.end();
}

postLogin((sid) => {
  if (!sid) { console.log('LOGIN FAILED, no session'); process.exit(1); }
  getPage(sid, '/dashboard', 'GET /dashboard', () => {
    getPage(sid, '/upload-json-cases', 'GET /upload-json-cases', (uploadBody) => {
      // now do POST upload with 2 files: contoh-1 + contoh-4
      const fs = require('fs');
      const path = require('path');
      const boundary = '----TestBoundary' + Date.now();
      const file1Buf = fs.readFileSync(path.join(__dirname, 'file json', 'contoh-1-health-approve.json'));
      const file2Buf = fs.readFileSync(path.join(__dirname, 'file json', 'contoh-4-life-death-diterima.json'));
      const CRLF = '\r\n';
      const buildFile = (field, filename, buf, mime) => {
        return Buffer.concat([
          Buffer.from('--' + boundary + CRLF),
          Buffer.from('Content-Disposition: form-data; name="' + field + '"; filename="' + filename + '"' + CRLF),
          Buffer.from('Content-Type: ' + mime + CRLF + CRLF),
          buf,
          Buffer.from(CRLF),
        ]);
      };
      const bodyBuf = Buffer.concat([
        buildFile('json_files', 'contoh-1-health-approve.json', file1Buf, 'application/json'),
        buildFile('json_files', 'contoh-4-life-death-diterima.json', file2Buf, 'application/json'),
        Buffer.from('--' + boundary + '--' + CRLF),
      ]);
      const req = http.request({
        hostname: 'localhost', port: 3000, path: '/upload-json-cases', method: 'POST',
        headers: {
          'Content-Type': 'multipart/form-data; boundary=' + boundary,
          'Content-Length': bodyBuf.length,
          Cookie: sid,
        },
      }, (res) => {
        let body = '';
        res.on('data', (c) => body += c);
        res.on('end', () => {
          console.log('POST /upload-json-cases => STATUS:', res.statusCode, 'LEN:', body.length);
          if (res.statusCode === 200 && body.length > 500) {
            const title = (body.match(/<title>(.*?)<\/title>/i) || [])[1] || 'n/a';
            console.log('  <title>:', title);
            console.log('  Contains success message:', body.includes('berhasil') || body.includes('Berhasil Dibuat') ? 'YES' : 'NO');
            console.log('  Contains case type badges:', body.includes('kesehatan') && body.includes('non kesehatan') ? 'YES' : 'NO');
            console.log('  Contains table hasil upload:', body.includes('Case ID') || body.includes('Tipe Case') ? 'YES' : 'NO');
            console.log('  Contains detail file 1 & 2:', body.includes('contoh-1') && body.includes('contoh-4') ? 'YES' : 'NO');
            console.log('  Contains assessment card:', body.includes('Assessment') || body.includes('Hasil Assessment') ? 'YES' : 'NO');
            console.log('  Contains Raw JSON toggle:', body.includes('Raw JSON') || body.includes('toggleRawJson') ? 'YES' : 'NO');
            console.log('  Contains PDF button:', body.includes('/pdf') ? 'YES' : 'NO');
            console.log('  Contains Detail Case button:', body.includes('/case/') ? 'YES' : 'NO');
            if (!body.includes('kesehatan') || !body.includes('non kesehatan')) {
              console.log('\n--- WARNING - type mapping may have failed, checking rendered text ---');
            }
            console.log('\nE2E TESTS COMPLETED');
            process.exit(0);
          } else if (res.statusCode >= 400) {
            console.log('ERROR BODY PREVIEW:', body.substring(0, 800));
            process.exit(1);
          } else {
            console.log('RESPONSE BODY PREVIEW:', body.substring(0, 300));
            process.exit(0);
          }
        });
      });
      req.on('error', (e) => { console.error('POST ERROR:', e.message); process.exit(1); });
      req.write(bodyBuf);
      req.end();
    });
  });
});

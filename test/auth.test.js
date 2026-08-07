import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';

const PORT = 3001;

function startServer() {
  return new Promise((resolve, reject) => {
    const serverProcess = spawn('node', ['server.js'], {
      env: {
        ...process.env,
        PORT,
        GOOGLE_CLIENT_ID: 'test_yt_client',
        INSTAGRAM_CLIENT_ID: 'test_ig_client'
      },
    });

    serverProcess.stdout.on('data', (data) => {
      if (data.toString().includes(`[publisher] listening on :${PORT}`)) {
        resolve(serverProcess);
      }
    });

    serverProcess.stderr.on('data', (data) => {
      console.error(`Server error: ${data}`);
    });

    serverProcess.on('error', reject);

    // Timeout if server doesn't start
    setTimeout(() => {
      serverProcess.kill();
      reject(new Error('Server failed to start within timeout'));
    }, 5000);
  });
}

function makeRequest(urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${PORT}${urlPath}`, (res) => {
      resolve({
        statusCode: res.statusCode,
        headers: res.headers,
      });
    }).on('error', reject);
  });
}

test('OAuth endpoints set correct state cookies', async (t) => {
  const serverProcess = await startServer();

  try {
    await t.test('GET /auth/youtube sets yt_oauth_state cookie', async () => {
      const res = await makeRequest('/auth/youtube');
      assert.strictEqual(res.statusCode, 302, 'Expected a redirect status code');

      const setCookie = res.headers['set-cookie'];
      assert.ok(setCookie, 'Expected Set-Cookie header');
      assert.ok(setCookie.some(cookie => cookie.startsWith('yt_oauth_state=')), 'Expected yt_oauth_state cookie to be set');
    });

    await t.test('GET /auth/instagram sets ig_oauth_state cookie', async () => {
      const res = await makeRequest('/auth/instagram');
      assert.strictEqual(res.statusCode, 302, 'Expected a redirect status code');

      const setCookie = res.headers['set-cookie'];
      assert.ok(setCookie, 'Expected Set-Cookie header');
      assert.ok(setCookie.some(cookie => cookie.startsWith('ig_oauth_state=')), 'Expected ig_oauth_state cookie to be set');
    });

  } finally {
    serverProcess.kill();
  }
});

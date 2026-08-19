import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'test_google_client_id';
process.env.INSTAGRAM_CLIENT_ID = process.env.INSTAGRAM_CLIENT_ID || 'test_instagram_client_id';

import { app } from '../server.js';

let server;
let baseUrl;

before((_, done) => {
  server = http.createServer(app);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
    done();
  });
});

after((_, done) => {
  if (server) {
    server.close(() => {
      done();
      setTimeout(() => process.exit(0), 50);
    });
  } else {
    done();
    setTimeout(() => process.exit(0), 50);
  }
});

test('GET /health returns HTTP 200 and healthy status', async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
});

test('GET /api/auth-status returns disconnected state when no OAuth cookies present', async () => {
  const res = await fetch(`${baseUrl}/api/auth-status`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.youtubeConnected, false);
  assert.equal(data.instagramConnected, false);
});

test('GET /auth/youtube sets OAuth state cookie', async () => {
  const res = await fetch(`${baseUrl}/auth/youtube`, { redirect: 'manual' });
  const setCookie = res.headers.get('set-cookie');
  assert.ok(setCookie);
  assert.ok(setCookie.includes('oauth_state='));
});

test('GET /auth/instagram sets OAuth state cookie', async () => {
  const res = await fetch(`${baseUrl}/auth/instagram`, { redirect: 'manual' });
  const setCookie = res.headers.get('set-cookie');
  assert.ok(setCookie);
  assert.ok(setCookie.includes('oauth_state='));
});

test('POST /api/publish rejects request when no video file is attached', async () => {
  const res = await fetch(`${baseUrl}/api/publish`, {
    method: 'POST',
  });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.ok(data.error);
});

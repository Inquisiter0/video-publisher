import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
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
    server.close(done);
  } else {
    done();
  }
});

test('GET /health returns HTTP 200 and healthy status', async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, 'ok');
  assert.ok(data.timestamp);
});

test('GET /api/auth-status returns disconnected state when no OAuth cookies present', async () => {
  const res = await fetch(`${baseUrl}/api/auth-status`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.youtubeConnected, false);
  assert.equal(data.instagramConnected, false);
});

test('GET /auth/youtube sets yt_oauth_state cookie', async () => {
  const res = await fetch(`${baseUrl}/auth/youtube`, { redirect: 'manual' });
  const setCookie = res.headers.get('set-cookie');
  assert.ok(setCookie);
  assert.ok(setCookie.includes('yt_oauth_state='));
});

test('GET /auth/instagram sets ig_oauth_state cookie', async () => {
  const res = await fetch(`${baseUrl}/auth/instagram`, { redirect: 'manual' });
  const setCookie = res.headers.get('set-cookie');
  assert.ok(setCookie);
  assert.ok(setCookie.includes('ig_oauth_state='));
});

test('POST /api/publish rejects request when no video file is attached', async () => {
  const res = await fetch(`${baseUrl}/api/publish`, {
    method: 'POST',
  });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.ok(data.error);
});

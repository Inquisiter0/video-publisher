import express from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { transcodeForVertical } from './lib/ffmpeg.js';
import { publishToYouTube, refreshYoutubeToken } from './lib/youtube.js';
import { publishInstagramReel } from './lib/instagram.js';

// Stateless: everything lives under the OS temp dir and is unlinked in `finally`.
// Defaults to os.tmpdir() so this works on both POSIX (/tmp) and Windows.
const TMP_DIR = process.env.TMP_DIR || os.tmpdir();

const IS_PROD = process.env.NODE_ENV === 'production';
const SUCCESS_URL = process.env.OAUTH_SUCCESS_URL || '/';
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60 * 1000; // ~1 year, refreshed on use

// --- Encrypted-cookie helpers (AES-256-GCM, no extra deps) ---
function cookieKey() {
  const secret = process.env.COOKIE_SECRET || 'dev_cookie_secret_key_32_bytes_long!';
  return createHash('sha256').update(secret).digest();
}

function encryptCookie(value) {
  const key = cookieKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64url'), tag.toString('base64url'), enc.toString('base64url')].join('.');
}

function decryptCookie(value) {
  const [ivB64, tagB64, dataB64] = value.split('.');
  const decipher = createDecipheriv('aes-256-gcm', cookieKey(), Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]);
  return JSON.parse(dec.toString('utf8'));
}

const tokenCookieOpts = {
  httpOnly: true,
  sameSite: 'strict',
  secure: IS_PROD,
  maxAge: COOKIE_MAX_AGE,
};

function readYtCookie(req) {
  if (!req.cookies?.yt_token) return null;
  try {
    return decryptCookie(req.cookies.yt_token);
  } catch {
    return null;
  }
}

function readIgCookie(req) {
  if (!req.cookies?.ig_token) return null;
  try {
    return decryptCookie(req.cookies.ig_token);
  } catch {
    return null;
  }
}

const upload = multer({
  storage: multer.diskStorage({
    destination: TMP_DIR,
    filename: (_req, _file, cb) => cb(null, `raw_${randomUUID()}.mp4`),
  }),
  limits: {
    fileSize: 500 * 1024 * 1024, // 500 MB cap
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    const isMp4 = file.mimetype === 'video/mp4' || /\.mp4$/i.test(file.originalname);
    if (isMp4) return cb(null, true);
    cb(new Error('Only MP4 files are accepted'));
  },
});

const app = express();

app.use(cookieParser());
app.use(express.json());
app.use(express.static('public'));

app.get('/health', (_req, res) => res.json({ ok: true }));

function getRedirectUri(req, envVarName, defaultPath) {
  if (process.env[envVarName]) {
    return process.env[envVarName];
  }
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.get('host') || 'localhost:3000';
  return `${proto}://${host}${defaultPath}`;
}

// --- OAuth: YouTube ---
app.get('/auth/youtube', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = getRedirectUri(req, 'GOOGLE_REDIRECT_URI', '/auth/youtube/callback');

  if (!clientId) {
    return res.status(400).send(`
      <div style="font-family: system-ui, sans-serif; max-width: 500px; margin: 50px auto; padding: 24px; border: 1px solid #333; background: #111; color: #eee; border-radius: 12px;">
        <h2 style="color: #ff4d4d; margin-top: 0;">Missing Google OAuth Credentials</h2>
        <p>Your server needs a <code>GOOGLE_CLIENT_ID</code> to redirect to Google Login.</p>
        <p>Please create or update a <code>.env</code> file in your project root with:</p>
        <pre style="background: #222; padding: 12px; border-radius: 6px; color: #a6e22e;">GOOGLE_CLIENT_ID=your_google_client_id.apps.googleusercontent.com\nGOOGLE_CLIENT_SECRET=your_google_client_secret\nGOOGLE_REDIRECT_URI=http://localhost:3000/auth/youtube/callback</pre>
        <a href="/" style="color: #4da6ff;">&larr; Back to Dashboard</a>
      </div>
    `);
  }

  const state = randomUUID();
  res.cookie('oauth_state', state, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/youtube.upload',
    access_type: 'offline',
    prompt: 'consent',
    state,
  });

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/auth/youtube/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) throw new Error('Missing authorization code');
    if (state !== req.cookies.oauth_state) throw new Error('OAuth state mismatch');
    res.clearCookie('oauth_state');

    const redirectUri = getRedirectUri(req, 'GOOGLE_REDIRECT_URI', '/auth/youtube/callback');

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) {
      throw new Error(`Google token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
    }

    const tokens = await tokenRes.json();
    res.cookie(
      'yt_token',
      encryptCookie({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      }),
      tokenCookieOpts,
    );

    res.redirect(SUCCESS_URL);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- OAuth: Instagram ---
app.get('/auth/instagram', (req, res) => {
  const clientId = process.env.INSTAGRAM_CLIENT_ID;
  const redirectUri = getRedirectUri(req, 'INSTAGRAM_REDIRECT_URI', '/auth/instagram/callback');

  if (!clientId) {
    return res.status(400).send(`
      <div style="font-family: system-ui, sans-serif; max-width: 500px; margin: 50px auto; padding: 24px; border: 1px solid #333; background: #111; color: #eee; border-radius: 12px;">
        <h2 style="color: #ff4d4d; margin-top: 0;">Missing Instagram OAuth Credentials</h2>
        <p>Your server needs an <code>INSTAGRAM_CLIENT_ID</code> to redirect to Meta/Instagram Login.</p>
        <p>Please create or update a <code>.env</code> file in your project root with:</p>
        <pre style="background: #222; padding: 12px; border-radius: 6px; color: #a6e22e;">INSTAGRAM_CLIENT_ID=your_instagram_app_id\nINSTAGRAM_CLIENT_SECRET=your_instagram_app_secret\nINSTAGRAM_REDIRECT_URI=http://localhost:3000/auth/instagram/callback</pre>
        <a href="/" style="color: #4da6ff;">&larr; Back to Dashboard</a>
      </div>
    `);
  }

  const state = randomUUID();
  res.cookie('oauth_state', state, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement',
    state,
  });

  res.redirect(`https://www.facebook.com/v19.0/dialog/oauth?${params}`);
});

app.get('/auth/instagram/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) throw new Error('Missing authorization code');
    if (state !== req.cookies.oauth_state) throw new Error('OAuth state mismatch');
    res.clearCookie('oauth_state');

    const clientId = process.env.INSTAGRAM_CLIENT_ID;
    const clientSecret = process.env.INSTAGRAM_CLIENT_SECRET;
    const redirectUri = getRedirectUri(req, 'INSTAGRAM_REDIRECT_URI', '/auth/instagram/callback');

    // 1. Exchange the auth code for a short-lived user token.
    const tokenRes = await fetch(
      `https://graph.facebook.com/v19.0/oauth/access_token?${new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code,
      })}`,
    );
    if (!tokenRes.ok) {
      throw new Error(`IG token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
    }
    const { access_token: shortToken } = await tokenRes.json();

    // 2. Exchange the short-lived token for a ~60-day long-lived token.
    const longRes = await fetch(
      `https://graph.facebook.com/v19.0/oauth/access_token?${new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: clientId,
        client_secret: clientSecret,
        fb_exchange_token: shortToken,
      })}`,
    );
    if (!longRes.ok) {
      throw new Error(`IG long-lived token failed: ${longRes.status} ${await longRes.text()}`);
    }
    const { access_token: accessToken, expires_in } = await longRes.json();

    res.cookie(
      'ig_token',
      encryptCookie({
        access_token: accessToken,
        igUserId: await resolveIgUserId(accessToken),
        expires_at: Date.now() + (expires_in ?? 5184000) * 1000,
      }),
      tokenCookieOpts,
    );

    res.redirect(SUCCESS_URL);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

async function resolveIgUserId(accessToken) {
  try {
    const meRes = await fetch(`https://graph.facebook.com/v19.0/me?fields=id&access_token=${accessToken}`);
    if (!meRes.ok) return undefined;
    const { id } = await meRes.json();

    const accRes = await fetch(
      `https://graph.facebook.com/v19.0/${id}/accounts?fields=instagram_business_account&access_token=${accessToken}`,
    );
    if (!accRes.ok) return undefined;
    const { data } = await accRes.json();

    return data?.[0]?.instagram_business_account?.id || undefined;
  } catch {
    return undefined;
  }
}

// --- Connection status ---
app.get('/api/auth-status', (req, res) => {
  const yt = readYtCookie(req);
  const ig = readIgCookie(req);
  res.json({
    youtubeConnected: !!yt?.access_token && yt.expires_at > Date.now(),
    instagramConnected: !!ig?.access_token && ig.expires_at > Date.now(),
  });
});

// Invoke the Multer middleware manually so a failed parse can still unlink any
// partially-written file before bubbling to the central error handler.
app.post('/api/publish', (req, res, next) => {
  upload.single('video')(req, res, (err) => {
    if (err) {
      if (req.file?.path) fs.unlink(req.file.path).catch(() => {});
      return next(err);
    }
    publish(req, res).catch(next);
  });
});

async function youtubeAccessToken(req, res) {
  const yt = readYtCookie(req);
  if (yt?.access_token) {
    if (yt.expires_at > Date.now()) return yt.access_token;
    if (yt.refresh_token) {
      const fresh = await refreshYoutubeToken(yt.refresh_token);
      res.cookie(
        'yt_token',
        encryptCookie({
          ...yt,
          access_token: fresh.access_token,
          expires_at: fresh.expires_at,
        }),
        tokenCookieOpts,
      );
      return fresh.access_token;
    }
  }
  return process.env.YOUTUBE_ACCESS_TOKEN;
}

app.use('/temp', express.static(TMP_DIR));

async function publish(req, res) {
  const rawPath = req.file?.path;
  const processedPath = rawPath
    ? path.join(TMP_DIR, `processed_${path.basename(rawPath).replace(/^raw_/, '')}`)
    : null;

  try {
    if (!rawPath) {
      return res.status(400).json({ error: 'Missing multipart field "video"' });
    }

    const duration = Number(req.body.duration);
    if (Number.isFinite(duration) && duration > 900) {
      return res.status(400).json({
        error: 'Video exceeds 15 minutes (900s), which is the maximum limit for Instagram Reels.',
      });
    }

    // Determine target platforms (from checkboxes or default to connected accounts)
    const reqPlatforms = req.body.platforms ? req.body.platforms.split(',') : [];
    const ytToken = await youtubeAccessToken(req, res);
    const igCookie = readIgCookie(req) || {};
    const igAccessToken = igCookie.access_token || process.env.INSTAGRAM_ACCESS_TOKEN;
    const igUserId = igCookie.igUserId || process.env.INSTAGRAM_USER_ID;

    const wantYoutube = reqPlatforms.length > 0 ? reqPlatforms.includes('youtube') : (req.body.publishYoutube !== 'false');
    const wantInstagram = reqPlatforms.length > 0 ? reqPlatforms.includes('instagram') : (req.body.publishInstagram !== 'false');

    // 1. Transcode + center-crop to 1080x1920 (9:16).
    const processed = await transcodeForVertical(rawPath, processedPath);

    // Build automated public URL for Instagram if needed
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.get('host') || 'localhost:3000';
    const autoVideoUrl = req.body.videoUrl || `${proto}://${host}/temp/${path.basename(processed)}`;

    // 2. Prepare promises for requested & connected platforms
    const tasks = {};

    if (wantYoutube) {
      if (ytToken) {
        tasks.youtube = publishToYouTube(processed, { ...req.body, duration }, ytToken);
      } else {
        tasks.youtube = Promise.reject(new Error('YouTube account is not connected'));
      }
    } else {
      tasks.youtube = Promise.resolve({ skipped: true, reason: 'Not selected' });
    }

    if (wantInstagram) {
      if (igAccessToken && igUserId) {
        tasks.instagram = publishInstagramReel({
          videoUrl: autoVideoUrl,
          caption: req.body.caption ?? '',
          accessToken: igAccessToken,
          igUserId,
        });
      } else {
        tasks.instagram = Promise.reject(new Error('Instagram account is not connected'));
      }
    } else {
      tasks.instagram = Promise.resolve({ skipped: true, reason: 'Not selected' });
    }

    // 3. Fan out
    const youtubeRes = await Promise.resolve(tasks.youtube).then(
      (v) => (v?.skipped ? { skipped: true, reason: v.reason } : { videoId: v }),
      (err) => ({ error: err.message || String(err) }),
    );

    const instagramRes = await Promise.resolve(tasks.instagram).then(
      (v) => (v?.skipped ? { skipped: true, reason: v.reason } : { mediaId: v }),
      (err) => ({ error: err.message || String(err) }),
    );

    return res.status(200).json({
      youtube: youtubeRes,
      instagram: instagramRes,
    });
  } finally {
    // 4. Strict cleanup: BOTH /tmp files are always unlinked, success or error.
    const targets = [rawPath, processedPath].filter(Boolean);
    await Promise.all(
      targets.map((p) =>
        fs.unlink(p).catch(() => {
          /* best-effort; never let cleanup mask the real error */
        }),
      ),
    );
  }
}

// 5. Central error handler.
app.use((err, _req, res, _next) => {
  const status = err instanceof multer.MulterError ? 400 : 500;
  res.status(status).json({ error: err.message });
});

export { app };

if (process.env.NODE_ENV !== 'test') {
  app.listen(process.env.PORT || 3000, () => {
    console.log(`[publisher] listening on :${process.env.PORT || 3000} (tmp: ${TMP_DIR})`);
  });
}


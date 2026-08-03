import fs from 'node:fs/promises';

const YT_UPLOAD_API = 'https://www.googleapis.com/upload/youtube/v3/videos';
const CHUNK_SIZE = 256 * 1024 * 1024; // must be a multiple of 256 KiB

/**
 * Publish a processed file to YouTube Shorts via the resumable upload protocol.
 *
 * @param {string} filePath Absolute path to the processed MP4.
 * @param {object} metadata { title, description, tags, categoryId, privacyStatus, duration }
 *                          `duration` (seconds) drives Shorts metadata: videos <= 180s get the
 *                          #Shorts signal so YouTube routes them to the Shorts feed.
 * @param {string} [accessToken] Explicit token (e.g. from yt_token cookie).
 *                              Falls back to process.env.YOUTUBE_ACCESS_TOKEN.
 * @returns {Promise<string>} The new YouTube video id.
 */
export async function publishToYouTube(filePath, metadata = {}, accessToken) {
  accessToken = accessToken || process.env.YOUTUBE_ACCESS_TOKEN;
  if (!accessToken) throw new Error('No YouTube access token (yt_token cookie or YOUTUBE_ACCESS_TOKEN)');

  const fileSize = (await fs.stat(filePath)).size;

  // 1. Initiate the resumable session (metadata-only POST).
  const sessionUrl = await createResumableUploadSession(metadata, accessToken, fileSize);

  // 2. Upload the file bytes in chunks.
  const videoId = await uploadVideoBytes(filePath, sessionUrl, accessToken, fileSize);

  return videoId;
}

/**
 * POST metadata only. On 200 the server returns a `Location` header that is
 * the resumable upload URL for step 2.
 */
export async function createResumableUploadSession(metadata, accessToken, fileSize) {
  const duration = Number(metadata.duration);
  // The Data API has no explicit "Shorts" flag: YouTube classifies by 9:16 aspect
  // ratio + duration, but #Shorts is the reliable programmatic signal to the feed.
  const isShort = Number.isFinite(duration) && duration > 0 && duration <= 180;

  const description = isShort && !/\b#Shorts\b/i.test(metadata.description || '')
    ? [metadata.description, '#Shorts'].filter(Boolean).join('\n\n')
    : metadata.description || '';
  const tags = isShort
    ? [...new Set([...(metadata.tags || []), 'Shorts'])]
    : metadata.tags || [];

  const body = {
    snippet: {
      title: metadata.title || 'Untitled Short',
      description,
      tags,
      categoryId: metadata.categoryId || '22',
      defaultAudioLanguage: metadata.defaultAudioLanguage || 'en',
    },
    status: {
      privacyStatus: metadata.privacyStatus || 'private',
      selfDeclaredMadeForKids: false,
    },
  };

  const res = await fetch(`${YT_UPLOAD_API}?uploadType=resumable&part=snippet,status`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-Upload-Content-Type': 'video/mp4',
      'X-Upload-Content-Length': String(fileSize),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`YouTube session init failed: ${res.status} ${await res.text()}`);
  }

  const location = res.headers.get('location');
  if (!location) throw new Error('YouTube did not return a resumable upload URL');
  return location;
}

/**
 * Chunked PUT against the session URL. Non-final chunks are answered with
 * 308 + `Range` header; the final chunk returns 200 with the video resource.
 */
export async function uploadVideoBytes(filePath, sessionUrl, accessToken, fileSize) {
  const fd = await fs.open(filePath, 'r');

  try {
    let offset = 0;

    while (offset < fileSize) {
      const chunkSize = Math.min(CHUNK_SIZE, fileSize - offset);
      const buffer = Buffer.alloc(chunkSize);
      await fd.read(buffer, 0, chunkSize, offset);

      const rangeEnd = offset + chunkSize - 1;
      const isFinal = rangeEnd === fileSize - 1;

      const res = await fetch(sessionUrl, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'video/mp4',
          'Content-Length': String(chunkSize),
          'Content-Range': isFinal
            ? `bytes ${offset}-${rangeEnd}/${fileSize}`
            : `bytes ${offset}-${rangeEnd}/*`,
        },
        body: buffer,
      });

      if (res.status === 308) {
        // Resume from where the server last wrote.
        offset = parseReceivedRange(res.headers.get('range'));
        continue;
      }

      if (!res.ok) {
        throw new Error(`YouTube chunk upload failed: ${res.status} ${await res.text()}`);
      }

      const payload = await res.json();
      return payload.id;
    }

    throw new Error('YouTube upload finished without a video id');
  } finally {
    await fd.close();
  }
}

function parseReceivedRange(rangeHeader) {
  if (!rangeHeader) return 0;
  const match = rangeHeader.match(/bytes=(\d+)-/);
  return match ? Number(match[1]) + 1 : 0;
}

/**
 * Exchange a stored refresh_token for a fresh access token when the cached
 * access token has expired.
 *
 * @param {string} refreshToken
 * @returns {Promise<{ access_token: string, expires_at: number }>}
 */
export async function refreshYoutubeToken(refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    throw new Error(`YouTube token refresh failed: ${res.status} ${await res.text()}`);
  }

  const tokens = await res.json();
  return {
    access_token: tokens.access_token,
    expires_at: Date.now() + (tokens.expires_in ?? 3600) * 1000,
  };
}

const GRAPH_API_BASE = 'https://graph.facebook.com/v19.0';
const POLL_INTERVAL_MS = 5000;
const MAX_POLL_ATTEMPTS = 24;

/**
 * Publish a Reel via the Meta Graph API container flow.
 *
 * When no credentials are available (no ig_token cookie and no env vars) the
 * publisher runs in Mock/Dry-Run mode and always succeeds with a fake media id,
 * so local tests can pass without real Instagram access.
 *
 * @param {object} input { videoUrl, caption, accessToken, igUserId }
 * @returns {Promise<string>} The published Instagram media id (or a mock id).
 */
export async function publishInstagramReel({ videoUrl, caption = '', accessToken, igUserId }) {
  accessToken = accessToken || process.env.INSTAGRAM_ACCESS_TOKEN;
  igUserId = igUserId || process.env.INSTAGRAM_USER_ID;

  if (!accessToken || !igUserId) {
    throw new Error('Instagram account is not connected');
  }

  // 1. Create the container. The API fetches the video server-side, so it must
  //    be reachable at videoUrl for the duration of the publish flow.
  const containerId = await createReelContainer({ igUserId, accessToken, videoUrl, caption });

  // 2. Poll until the container is processed.
  await pollContainerStatus(containerId, accessToken);

  // 3. Publish the finished container.
  const mediaId = await publishContainer({ igUserId, accessToken, containerId });
  return mediaId;
}

export async function createReelContainer({ igUserId, accessToken, videoUrl, caption }) {
  const params = new URLSearchParams({
    media_type: 'REELS',
    video_url: videoUrl,
    caption,
    share_to_feed: 'true',
    access_token: accessToken,
  });

  const res = await fetch(`${GRAPH_API_BASE}/${igUserId}/media?${params}`);
  if (!res.ok) {
    throw new Error(`IG container creation failed: ${res.status} ${await res.text()}`);
  }

  const { id } = await res.json();
  return id;
}

export async function pollContainerStatus(containerId, accessToken) {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    const params = new URLSearchParams({ fields: 'status_code,status', access_token: accessToken });
    const res = await fetch(`${GRAPH_API_BASE}/${containerId}?${params}`);
    if (!res.ok) {
      throw new Error(`IG container status failed: ${res.status} ${await res.text()}`);
    }

    const { status_code, status } = await res.json();

    if (status_code === 'FINISHED') return status_code;
    if (status_code === 'ERROR' || status === 'error') {
      throw new Error('IG container processing failed');
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error('IG container did not finish within the poll window');
}

export async function publishContainer({ igUserId, accessToken, containerId }) {
  const params = new URLSearchParams({ creation_id: containerId, access_token: accessToken });
  const res = await fetch(`${GRAPH_API_BASE}/${igUserId}/media_publish?${params}`, {
    method: 'POST',
  });

  if (!res.ok) {
    throw new Error(`IG publish failed: ${res.status} ${await res.text()}`);
  }

  const { id } = await res.json();
  return id;
}

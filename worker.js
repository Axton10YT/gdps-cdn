/**
 * cdn.robtop.net Audio Proxy & R2 Upload Manager
 * 
 * Bindings required:
 *   KV:  SONG_HITS   (tracks request counts per song)
 *   R2:  SONG_CACHE  (stores cached MP3s)
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathSegments = url.pathname.split("/").filter(Boolean);

    // ── Route: POST /songUpload ──────────────────────────────────────────────
    if (url.pathname === "/songUpload" && request.method === "POST") {
      try {
        const body = await request.json();
        const songId = parseInt(body.songId, 10);

        if (!songId || isNaN(songId)) {
          return new Response(JSON.stringify({ error: "Invalid or missing songId" }), { status: 400 });
        }

        const r2Key = `musics/${songId}.mp3`;

        // Check if already stored in R2
        const existing = await env.SONG_CACHE.head(r2Key);
        if (existing) {
          return new Response(JSON.stringify({ success: true, message: "Already exists in R2", key: r2Key }), { status: 200 });
        }

        // Fetch song metadata and download URL from Newgrounds
        const ngInfo = await fetchNgMetadata(songId);
        const downloadUrl = ngInfo.streamUrl || `https://audio.ngfiles.com/${songId - (songId % 1000)}/${songId}.mp3`;

        // Trigger background fetch and upload to R2 using ctx.waitUntil
        ctx.waitUntil((async () => {
          const audioRes = await fetchAudio(downloadUrl, null);
          if (audioRes.ok) {
            await env.SONG_CACHE.put(r2Key, audioRes.body, {
              httpMetadata: { contentType: "audio/mpeg" },
              customMetadata: {
                songId: String(songId),
                title: body.title || ngInfo.title || "",
                artist: body.artist || ngInfo.artist || "",
                uploadedAt: new Date().toISOString()
              }
            });
          }
        })());

        return new Response(JSON.stringify({ success: true, message: "Upload queued", key: r2Key }), { status: 202 });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // ── Route: /info/{songId} ────────────────────────────────────────────────
    let isInfoRequest = false;
    let rawSongId = "";

    if (pathSegments.length === 1) {
      rawSongId = pathSegments[0];
    } else if (pathSegments.length === 2 && pathSegments[0].toLowerCase() === "info") {
      isInfoRequest = true;
      rawSongId = pathSegments[1];
    } else {
      return new Response("Invalid request.", { status: 400 });
    }

    if (!rawSongId || !/^\d+$/.test(rawSongId)) {
      return new Response("Pass a valid numeric song ID.", { status: 400 });
    }

    const id = parseInt(rawSongId, 10);
    const ngInfo = await fetchNgMetadata(id);

    if (isInfoRequest) {
      return new Response(JSON.stringify({
        id: id,
        title: ngInfo.title,
        artist: ngInfo.artist,
        duration: ngInfo.duration,
        streamUrl: ngInfo.streamUrl || `https://audio.ngfiles.com/${id - (id % 1000)}/${id}.mp3`,
        cdnUrl: `https://${url.host}/${id}`,
      }, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
      });
    }

    // ── Route: GET /{songId} (Audio Streaming) ───────────────────────────────
    // Check both new musics/ and legacy songs/ paths
    const newR2Key = `musics/${id}.mp3`;
    const oldR2Key = `songs/${id}.mp3`;

    const range = request.headers.get("Range");
    const r2Options = range ? { range: parseRangeHeader(range) } : {};

    let cached = await env.SONG_CACHE.get(newR2Key, r2Options);
    if (!cached) {
      cached = await env.SONG_CACHE.get(oldR2Key, r2Options);
    }

    if (cached) {
      const headers = new Headers();
      cached.writeHttpMetadata(headers);
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
      headers.set("X-Cache", "R2-HIT");

      const status = range && cached.range ? 206 : 200;
      return new Response(cached.body, { status, headers });
    }

    // Fallback direct proxy if missing in R2
    const downloadUrl = ngInfo.streamUrl || `https://audio.ngfiles.com/${id - (id % 1000)}/${id}.mp3`;
    const upstream = await fetchAudio(downloadUrl, range);

    const headers = new Headers(upstream.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Cache-Control", "public, max-age=86400");
    headers.set("Content-Type", "audio/mpeg");
    headers.set("X-Cache", "PROXY");

    return new Response(upstream.body, { status: upstream.status, headers });
  }
};

// ── Helpers ──────────────────────────────────────────────────────────────────

async function fetchNgMetadata(id) {
  try {
    const res = await fetch(`https://www.newgrounds.com/audio/load/${id}`, {
      headers: {
        "Accept": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": "https://www.newgrounds.com/",
        "User-Agent": "Mozilla/5.0 (compatible; robtopcdn-proxy/1.0)",
      },
    });

    if (res.ok) {
      const data = await res.json();
      let streamUrl = null;

      if (data?.sources) {
        const entries = Array.isArray(data.sources) ? data.sources : Object.values(data.sources);
        const src = entries[0]?.src || entries[0];
        if (src) streamUrl = src.startsWith("//") ? "https:" + src : src;
      }

      return {
        title: data?.name || data?.title || "Unknown",
        artist: data?.artist || data?.author || "Unknown",
        duration: data?.duration || 0,
        streamUrl: streamUrl || data?.stream || null
      };
    }
  } catch (_) {}

  return { title: "Unknown", artist: "Unknown", duration: 0, streamUrl: null };
}

function fetchAudio(url, range) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (compatible; robtopcdn-proxy/1.0)",
    "Referer": "https://www.newgrounds.com/",
  };
  if (range) headers["Range"] = range;
  return fetch(url, { headers });
}

function parseRangeHeader(range) {
  const match = range.match(/bytes=(\d+)-(\d*)/);
  if (!match) return {};
  const offset = parseInt(match[1], 10);
  const length = match[2] ? parseInt(match[2], 10) - offset + 1 : undefined;
  return { offset, length };
}

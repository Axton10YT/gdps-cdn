/**
 * cheesecdn.com Newgrounds Audio Proxy & Metadata Provider
 * 
 * Endpoints:
 *   GET /{songId}       -> Audio file (MP3 stream with metadata headers)
 *   GET /info/{songId}  -> Pure JSON metadata response
 * 
 * Bindings required:
 *   KV:  SONG_HITS   (tracks request counts per song, 24h TTL)
 *   R2:  SONG_CACHE  (stores cached MP3s)
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathSegments = url.pathname.split("/").filter(Boolean);

    // ── Route Parsing ────────────────────────────────────────────────────────
    let isInfoRequest = false;
    let rawSongId = "";

    if (pathSegments.length === 1) {
      // GET /12345
      rawSongId = pathSegments[0];
    } else if (pathSegments.length === 2 && pathSegments[0].toLowerCase() === "info") {
      // GET /info/12345
      isInfoRequest = true;
      rawSongId = pathSegments[1];
    } else {
      return new Response("Invalid endpoint. Use /{songId} for audio or /info/{songId} for JSON metadata.", { status: 400 });
    }

    if (!rawSongId || !/^\d+$/.test(rawSongId)) {
      return new Response("Pass a valid numeric Newgrounds song ID.", { status: 400 });
    }

    const id = parseInt(rawSongId, 10);

    // ── 1. Fetch Metadata from Newgrounds ─────────────────────────────────
    const ngInfo = await fetchNgMetadata(id);

    // ── 2. Handle /info/{songId} Endpoint ──────────────────────────────────
    if (isInfoRequest) {
      const jsonResponse = {
        id: id,
        title: ngInfo.title,
        artist: ngInfo.artist,
        duration: ngInfo.duration,
        icon: ngInfo.icon,
        streamUrl: ngInfo.streamUrl || `https://audio.ngfiles.com/${id - (id % 1000)}/${id}.mp3`,
        cdnUrl: `https://${url.host}/${id}`,
      };

      return new Response(JSON.stringify(jsonResponse, null, 2), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=86400, stale-while-revalidate=3600",
        },
      });
    }

    // ── 3. Audio Proxy Logic (/{songId}) ──────────────────────────────────
    const r2Key = `songs/${id}.mp3`;
    const metaHeaders = createMetadataHeaders(id, ngInfo);

    // Check R2 Cache
    const range = request.headers.get("Range");
    const r2Options = range ? { range: parseRangeHeader(range) } : {};
    const cached = await env.SONG_CACHE.get(r2Key, r2Options);

    if (cached) {
      const headers = new Headers();
      cached.writeHttpMetadata(headers);
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
      headers.set("X-Cache", "R2-HIT");

      applyMetadataHeaders(headers, metaHeaders);

      const status = range && cached.range ? 206 : 200;
      return new Response(cached.body, { status, headers });
    }

    // Upstream Resolution & Hit Tracking
    const downloadUrl = ngInfo.streamUrl || `https://audio.ngfiles.com/${id - (id % 1000)}/${id}.mp3`;
    const kvKey = `hits:${id}`;
    const existingHits = await env.SONG_HITS.get(kvKey);
    const hits = existingHits ? parseInt(existingHits, 10) + 1 : 1;

    ctx.waitUntil(
      env.SONG_HITS.put(kvKey, String(hits), { expirationTtl: 86400 })
    );

    // Second request onwards: Store in R2 asynchronously
    if (hits > 1) {
      const audioRes = await fetchAudio(downloadUrl, null);

      if (audioRes.ok) {
        const [r2Stream, clientStream] = audioRes.body.tee();

        ctx.waitUntil(
          env.SONG_CACHE.put(r2Key, r2Stream, {
            httpMetadata: { contentType: "audio/mpeg" },
            customMetadata: {
              songId: String(id),
              title: ngInfo.title || "",
              artist: ngInfo.artist || "",
              cachedAt: new Date().toISOString()
            }
          })
        );

        const responseHeaders = new Headers(audioRes.headers);
        responseHeaders.set("Access-Control-Allow-Origin", "*");
        responseHeaders.set("Cache-Control", "public, max-age=31536000, immutable");
        responseHeaders.set("X-Cache", "R2-MISS-STORING");
        applyMetadataHeaders(responseHeaders, metaHeaders);

        return new Response(clientStream, {
          status: audioRes.status,
          headers: responseHeaders
        });
      }
    }

    // Direct Upstream Proxy
    const upstream = await fetchAudio(downloadUrl, range);

    if (!upstream.ok && upstream.status !== 206) {
      return new Response(`Upstream returned status ${upstream.status} for song ${id}`, { status: upstream.status });
    }

    const headers = new Headers(upstream.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Cache-Control", "public, max-age=86400");
    headers.set("Content-Type", "audio/mpeg");
    headers.set("X-Cache", "PROXY");
    headers.set("X-Hits", String(hits));
    applyMetadataHeaders(headers, metaHeaders);

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
        "User-Agent": "Mozilla/5.0 (compatible; cheesecdn-proxy/1.0)",
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
        icon: data?.icon || "",
        streamUrl: streamUrl || data?.stream || null
      };
    }
  } catch (_) {}

  return { title: "Unknown", artist: "Unknown", duration: 0, icon: "", streamUrl: null };
}

function fetchAudio(url, range) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (compatible; cheesecdn-proxy/1.0)",
    "Referer": "https://www.newgrounds.com/",
  };
  if (range) headers["Range"] = range;
  return fetch(url, { headers });
}

function createMetadataHeaders(id, ngInfo) {
  return {
    "X-Song-ID": String(id),
    "X-Song-Title": encodeURIComponent(ngInfo.title),
    "X-Song-Artist": encodeURIComponent(ngInfo.artist),
    "X-Song-Duration": String(ngInfo.duration),
  };
}

function applyMetadataHeaders(targetHeaders, metaHeaders) {
  for (const [key, val] of Object.entries(metaHeaders)) {
    targetHeaders.set(key, val);
  }
}

function parseRangeHeader(range) {
  const match = range.match(/bytes=(\d+)-(\d*)/);
  if (!match) return {};
  const offset = parseInt(match[1], 10);
  const length = match[2] ? parseInt(match[2], 10) - offset + 1 : undefined;
  return { offset, length };
}

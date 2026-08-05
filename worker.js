/**
 * cheesecdn.com Newgrounds Audio Proxy & Metadata Provider
 * 
 * Bindings required:
 *   KV:  SONG_HITS   (tracks request counts per song, 24h TTL)
 *   R2:  SONG_CACHE  (stores cached MP3s)
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const songId = url.pathname.slice(1).replace(/\/+$/, "");

    if (!songId || !/^\d+$/.test(songId)) {
      return new Response("Pass a valid Newgrounds song ID: cheesecdn.com/12345678", { status: 400 });
    }

    const id = parseInt(songId, 10);
    const r2Key = `songs/${id}.mp3`;

    // ── 1. Fetch Metadata from Newgrounds ─────────────────────────────────
    const ngInfo = await fetchNgMetadata(id);
    const metaHeaders = createMetadataHeaders(id, ngInfo);

    // ── 2. Check R2 Cache — Stream directly if cached ────────────────────
    const range = request.headers.get("Range");
    const r2Options = range ? { range: parseRangeHeader(range) } : {};
    const cached = await env.SONG_CACHE.get(r2Key, r2Options);

    if (cached) {
      const headers = new Headers();
      cached.writeHttpMetadata(headers);
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
      headers.set("X-Cache", "R2-HIT");

      // Inject Newgrounds Metadata Headers
      applyMetadataHeaders(headers, metaHeaders);

      const status = range && cached.range ? 206 : 200;
      return new Response(cached.body, { status, headers });
    }

    // ── 3. Upstream URL Resolution ───────────────────────────────────────
    const downloadUrl = ngInfo.streamUrl || `https://audio.ngfiles.com/${id - (id % 1000)}/${id}.mp3`;

    // ── 4. Track Hits in KV (Asynchronous) ────────────────────────────────
    const kvKey = `hits:${id}`;
    const existingHits = await env.SONG_HITS.get(kvKey);
    const hits = existingHits ? parseInt(existingHits, 10) + 1 : 1;

    ctx.waitUntil(
      env.SONG_HITS.put(kvKey, String(hits), { expirationTtl: 86400 })
    );

    // ── 5. Serve & Cache Flow ─────────────────────────────────────────────
    if (hits > 1) {
      // Second request onwards: Fetch full audio, write to R2 in background, stream to client
      const audioRes = await fetchAudio(downloadUrl, null);

      if (audioRes.ok) {
        // Clone stream: One for R2 storage in background, one for active response
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

    // First request: Direct Upstream Proxy
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

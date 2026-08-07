var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

const CUSTOM_ID_MIN = 900000000;
const CUSTOM_ID_MAX = 999999999;

function looksLikeMp3(bytes) {
  if (bytes.length < 3) return false;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true;
  if (bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0) return true;
  return false;
}
__name(looksLikeMp3, "looksLikeMp3");

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

async function findFreeCustomId(env) {
  for (let i = 0; i < 20; i++) {
    const candidate = CUSTOM_ID_MIN + Math.floor(Math.random() * (CUSTOM_ID_MAX - CUSTOM_ID_MIN));
    const exists = await env.SONG_CACHE.head(`musics/${candidate}.mp3`);
    if (!exists) return candidate;
  }
  return null;
}
__name(findFreeCustomId, "findFreeCustomId");

function resultPage(title, message, ok) {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #0d1117; color: #e6edf3; max-width: 560px; margin: 60px auto; padding: 0 20px; text-align: center; }
  .box { padding: 20px; border-radius: 10px; border: 1px solid ${ok ? "#2ea043" : "#da3633"}; background: ${ok ? "#0d2818" : "#2d0f13"}; color: ${ok ? "#7ee787" : "#ffa198"}; white-space: pre-wrap; word-break: break-all; }
  a { display: inline-block; margin-top: 20px; color: #58a6ff; }
</style></head>
<body><div class="box">${message}</div><a href="/upload">&larr; Upload another</a></body></html>`;
}
__name(resultPage, "resultPage");

// Rebuilt with NO JavaScript in the critical path. This is a plain HTML
// <form>, submitted with a real browser POST - the same mechanism that's
// worked on every browser since forms existed. There is nothing here that
// can silently fail to attach or fire: no addEventListener, no onsubmit,
// no script timing to get wrong. The browser handles the whole submission
// natively and the server responds with a normal page.
const UPLOAD_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Upload a Custom Song - Cheese CDN</title>
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0d1117; color: #e6edf3; max-width: 560px; margin: 40px auto; padding: 0 20px;
  }
  h1 { font-size: 22px; margin-bottom: 4px; }
  p.sub { color: #8b949e; margin-top: 0; font-size: 14px; }
  fieldset { border: 1px solid #30363d; border-radius: 10px; padding: 16px; margin-bottom: 16px; }
  legend { padding: 0 6px; color: #8b949e; font-size: 13px; }
  label { display: block; font-size: 13px; color: #c9d1d9; margin: 12px 0 4px; }
  input[type=text], input[type=url], input[type=number] {
    width: 100%; padding: 9px 10px; border-radius: 7px; border: 1px solid #30363d;
    background: #0d1117; color: #e6edf3; font-size: 14px;
  }
  input[type=file] { width: 100%; padding: 8px 0; font-size: 13px; }
  .or { text-align: center; color: #6e7681; font-size: 12px; margin: 10px 0; }
  button {
    width: 100%; padding: 12px; border-radius: 7px; border: none; background: #238636;
    color: white; font-size: 16px; font-weight: 600;
  }
  .hint { color: #6e7681; font-size: 12px; margin-top: 4px; }
</style>
</head>
<body>
  <h1>Upload a Custom Song</h1>
  <p class="sub">Adds a track to the Cheese CDN music library. This is a public, open resource - no login needed.</p>

  <form action="/songUpload" method="POST" enctype="multipart/form-data">
    <fieldset>
      <legend>Source - pick one</legend>
      <label for="sourceFile">Choose an mp3 from your device</label>
      <input type="file" id="sourceFile" name="file">
      <div class="or">â€” or â€”</div>
      <label for="sourceUrl">Direct link to an mp3 file</label>
      <input type="url" id="sourceUrl" name="url" placeholder="https://example.com/song.mp3">
    </fieldset>

    <fieldset>
      <legend>Details</legend>
      <label for="title">Title</label>
      <input type="text" id="title" name="title" required maxlength="200" placeholder="Song title">
      <label for="artist">Artist</label>
      <input type="text" id="artist" name="artist" required maxlength="200" placeholder="Artist name">
      <label for="songId">Song ID (optional)</label>
      <input type="number" id="songId" name="songId" min="${CUSTOM_ID_MIN}" max="${CUSTOM_ID_MAX}" placeholder="Leave blank to auto-assign">
      <div class="hint">Custom songs use IDs ${CUSTOM_ID_MIN.toLocaleString()}-${CUSTOM_ID_MAX.toLocaleString()} so they never collide with real Newgrounds tracks.</div>
    </fieldset>

    <button type="submit">Upload</button>
  </form>
</body>
</html>`;

var worker_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathSegments = url.pathname.split("/").filter(Boolean);

    if (url.pathname === "/upload" && request.method === "GET") {
      return new Response(UPLOAD_PAGE_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    if (url.pathname === "/songUpload" && request.method === "POST") {
      // Browsers doing a real <form> submit send Accept: text/html (among
      // others) by default; API/programmatic callers explicitly ask for
      // JSON. This lets both work without needing two separate endpoints.
      const wantsHtml = (request.headers.get("accept") || "").includes("text/html");

      function respond(status, ok, payload) {
        if (wantsHtml) {
          const msg = ok
            ? `Uploaded!\n\nSong ID: ${payload.songId}\nCDN URL: ${payload.cdnUrl}`
            : `Failed: ${payload.error}`;
          return new Response(resultPage(ok ? "Uploaded" : "Upload failed", msg, ok),
            { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
        }
        return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
      }
      __name(respond, "respond");

      try {
        const contentType = request.headers.get("content-type") || "";
        let title = "", artist = "", requestedId = null, sourceUrl = null, uploadedFile = null;

        if (contentType.includes("multipart/form-data")) {
          const form = await request.formData();
          title = (form.get("title") || "").toString().trim();
          artist = (form.get("artist") || "").toString().trim();
          const idField = form.get("songId");
          if (idField) requestedId = parseInt(idField.toString(), 10);
          const urlField = form.get("url");
          if (urlField) sourceUrl = urlField.toString().trim();
          const fileField = form.get("file");
          if (fileField && typeof fileField === "object" && "arrayBuffer" in fileField && fileField.size > 0) {
            uploadedFile = fileField;
          }
        } else {
          const body = await request.json();
          title = (body.title || "").toString().trim();
          artist = (body.artist || "").toString().trim();
          if (body.songId) requestedId = parseInt(body.songId, 10);
          if (body.url) sourceUrl = body.url.toString().trim();
        }

        if (!title || !artist) {
          return respond(400, false, { error: "title and artist are required" });
        }
        if (!sourceUrl && !uploadedFile) {
          return respond(400, false, { error: "provide either a source url or a file" });
        }

        let songId;
        if (requestedId) {
          if (isNaN(requestedId) || requestedId < CUSTOM_ID_MIN || requestedId > CUSTOM_ID_MAX) {
            return respond(400, false, {
              error: `songId must be between ${CUSTOM_ID_MIN} and ${CUSTOM_ID_MAX} - this range is reserved so custom uploads never collide with real Newgrounds song IDs`
            });
          }
          songId = requestedId;
        } else {
          songId = await findFreeCustomId(env);
          if (!songId) return respond(500, false, { error: "couldn't find a free id, try again" });
        }

        const r2Key = `musics/${songId}.mp3`;
        const existing = await env.SONG_CACHE.head(r2Key);
        if (existing) {
          return respond(409, false, { error: `song id ${songId} is already in use`, songId });
        }

        let bytes;
        if (uploadedFile) {
          if (uploadedFile.size > MAX_UPLOAD_BYTES) {
            return respond(413, false, { error: `file too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)` });
          }
          bytes = new Uint8Array(await uploadedFile.arrayBuffer());
        } else {
          let fetchRes;
          try {
            fetchRes = await fetch(sourceUrl, { headers: { "User-Agent": "Mozilla/5.0 (compatible; robtopcdn-proxy/1.0)" } });
          } catch (e) {
            return respond(400, false, { error: `couldn't reach that url: ${e.message}` });
          }
          if (!fetchRes.ok) {
            return respond(400, false, { error: `source url returned HTTP ${fetchRes.status}` });
          }
          const contentLength = fetchRes.headers.get("content-length");
          if (contentLength && parseInt(contentLength, 10) > MAX_UPLOAD_BYTES) {
            return respond(413, false, { error: `file too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)` });
          }
          const buf = await fetchRes.arrayBuffer();
          if (buf.byteLength > MAX_UPLOAD_BYTES) {
            return respond(413, false, { error: `file too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)` });
          }
          bytes = new Uint8Array(buf);
        }

        if (!looksLikeMp3(bytes)) {
          return respond(400, false, { error: "that doesn't look like a valid mp3 file" });
        }

        await env.SONG_CACHE.put(r2Key, bytes, {
          httpMetadata: { contentType: "audio/mpeg" },
          customMetadata: { songId: String(songId), title, artist, uploadedAt: new Date().toISOString(), custom: "true" }
        });

        return respond(201, true, { success: true, songId, key: r2Key, cdnUrl: `https://${url.host}/${songId}` });

      } catch (err) {
        return respond(500, false, { error: err.message });
      }
    }

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
    const isCustomRange = id >= CUSTOM_ID_MIN && id <= CUSTOM_ID_MAX;
    const newR2Key = `musics/${id}.mp3`;
    const oldR2Key = `songs/${id}.mp3`;

    let ngInfo = { title: "Unknown", artist: "Unknown", duration: 0, streamUrl: null };
    let r2Head = null;
    if (isCustomRange) {
      r2Head = await env.SONG_CACHE.head(newR2Key);
      if (!r2Head) {
        return new Response(JSON.stringify({ error: "no custom song with that id" }),
          { status: 404, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
      }
    } else {
      ngInfo = await fetchNgMetadata(id);
    }
    const downloadUrl = ngInfo.streamUrl || `https://audio.ngfiles.com/${id - id % 1000}/${id}.mp3`;

    if (isInfoRequest) {
      if (!isCustomRange) {
        ctx.waitUntil((async () => {
          const hit = await env.SONG_CACHE.head(newR2Key);
          if (!hit) {
            await cacheFullSong(env, newR2Key, downloadUrl, { songId: String(id), title: ngInfo.title || "", artist: ngInfo.artist || "" });
          }
        })());
      }
      const meta = isCustomRange ? r2Head.customMetadata : {};
      return new Response(JSON.stringify({
        id,
        title: isCustomRange ? meta.title : ngInfo.title,
        artist: isCustomRange ? meta.artist : ngInfo.artist,
        duration: isCustomRange ? 0 : ngInfo.duration,
        streamUrl: isCustomRange ? `https://${url.host}/${id}` : downloadUrl,
        cdnUrl: `https://${url.host}/${id}`,
        custom: isCustomRange
      }, null, 2), { status: 200, headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" } });
    }

    const range = request.headers.get("Range");
    const r2Options = range ? { range: parseRangeHeader(range) } : {};

    let cached = await env.SONG_CACHE.get(newR2Key, r2Options);
    let cacheKeyUsed = newR2Key;
    if (!cached && !isCustomRange) {
      cached = await env.SONG_CACHE.get(oldR2Key, r2Options);
      cacheKeyUsed = oldR2Key;
    }

    if (cached) {
      const headers2 = new Headers();
      cached.writeHttpMetadata(headers2);
      headers2.set("Access-Control-Allow-Origin", "*");
      headers2.set("Cache-Control", "public, max-age=31536000, immutable");
      headers2.set("X-Cache", "R2-HIT");
      const status = range && cached.range ? 206 : 200;
      return new Response(cached.body, { status, headers: headers2 });
    }

    if (isCustomRange) {
      return new Response("Not found.", { status: 404 });
    }

    const upstream = await fetchAudio(downloadUrl, range);
    const headers = new Headers(upstream.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Cache-Control", "public, max-age=86400");
    headers.set("Content-Type", "audio/mpeg");
    headers.set("X-Cache", "PROXY");
    const cacheMeta = { songId: String(id), title: ngInfo.title || "", artist: ngInfo.artist || "" };

    if (!range && upstream.ok && upstream.body) {
      const [clientStream, cacheStream] = upstream.body.tee();
      ctx.waitUntil(
        env.SONG_CACHE.put(newR2Key, cacheStream, {
          httpMetadata: { contentType: "audio/mpeg" },
          customMetadata: { ...cacheMeta, uploadedAt: new Date().toISOString() }
        }).catch(() => {})
      );
      return new Response(clientStream, { status: upstream.status, headers });
    }

    if (range) {
      ctx.waitUntil((async () => {
        try {
          const existing = await env.SONG_CACHE.head(newR2Key);
          if (existing) return;
          await cacheFullSong(env, newR2Key, downloadUrl, cacheMeta);
        } catch (_) {}
      })());
    }

    return new Response(upstream.body, { status: upstream.status, headers });
  }
};

async function cacheFullSong(env, r2Key, downloadUrl, meta) {
  try {
    const audioRes = await fetchAudio(downloadUrl, null);
    if (audioRes.ok) {
      await env.SONG_CACHE.put(r2Key, audioRes.body, {
        httpMetadata: { contentType: "audio/mpeg" },
        customMetadata: { ...meta, uploadedAt: new Date().toISOString() }
      });
    }
  } catch (_) {}
}
__name(cacheFullSong, "cacheFullSong");

async function fetchNgMetadata(id) {
  try {
    const res = await fetch(`https://www.newgrounds.com/audio/load/${id}`, {
      headers: {
        "Accept": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": "https://www.newgrounds.com/",
        "User-Agent": "Mozilla/5.0 (compatible; robtopcdn-proxy/1.0)"
      }
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
__name(fetchNgMetadata, "fetchNgMetadata");

function fetchAudio(url, range) {
  const headers = { "User-Agent": "Mozilla/5.0 (compatible; robtopcdn-proxy/1.0)", "Referer": "https://www.newgrounds.com/" };
  if (range) headers["Range"] = range;
  return fetch(url, { headers });
}
__name(fetchAudio, "fetchAudio");

function parseRangeHeader(range) {
  const match = range.match(/bytes=(\d+)-(\d*)/);
  if (!match) return {};
  const offset = parseInt(match[1], 10);
  const length = match[2] ? parseInt(match[2], 10) - offset + 1 : void 0;
  return { offset, length };
}
__name(parseRangeHeader, "parseRangeHeader");

export { worker_default as default };
var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// â”€â”€ Custom (non-Newgrounds) upload ID range â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Real Newgrounds post IDs are currently in the low millions. Reserving
// everything from 900,000,000 up guarantees no collision with any real NG
// ID for the foreseeable future (NG would need ~900x its entire 20+ year
// content history to reach this range). Verified empty before reserving it.
const CUSTOM_ID_MIN = 900000000;
const CUSTOM_ID_MAX = 999999999;

// MP3 magic-byte check: either an ID3v2 tag ("ID3") or a raw MPEG frame
// sync (0xFF followed by a byte with its top 3 bits set). This is a real
// file-format check, not just trusting a claimed Content-Type - a URL or
// a renamed file can lie about its extension, the bytes can't.
function looksLikeMp3(bytes) {
  if (bytes.length < 3) return false;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true; // "ID3"
  if (bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0) return true; // MPEG frame sync
  return false;
}
__name(looksLikeMp3, "looksLikeMp3");

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // sane cap against abuse - no real GD song gets near this

async function findFreeCustomId(env) {
  for (let i = 0; i < 20; i++) {
    const candidate = CUSTOM_ID_MIN + Math.floor(Math.random() * (CUSTOM_ID_MAX - CUSTOM_ID_MIN));
    const exists = await env.SONG_CACHE.head(`musics/${candidate}.mp3`);
    if (!exists) return candidate;
  }
  return null;
}
__name(findFreeCustomId, "findFreeCustomId");

const UPLOAD_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Upload a Custom Song - Cheese CDN</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
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
  .tabs { display: flex; gap: 8px; margin-bottom: 14px; }
  .tab {
    flex: 1; text-align: center; padding: 8px; border-radius: 7px; cursor: pointer;
    background: #161b22; border: 1px solid #30363d; font-size: 13px; user-select: none;
  }
  .tab.active { background: #1f6feb; border-color: #1f6feb; }
  .mode-panel { display: none; }
  .mode-panel.active { display: block; }
  button {
    width: 100%; padding: 11px; border-radius: 7px; border: none; background: #238636;
    color: white; font-size: 15px; font-weight: 600; cursor: pointer; margin-top: 18px;
  }
  button:disabled { background: #30363d; cursor: not-allowed; }
  #result { margin-top: 16px; padding: 12px; border-radius: 7px; font-size: 13px; display: none; white-space: pre-wrap; word-break: break-all; }
  #result.ok { display: block; background: #0d2818; border: 1px solid #2ea043; color: #7ee787; }
  #result.err { display: block; background: #2d0f13; border: 1px solid #da3633; color: #ffa198; }
  .hint { color: #6e7681; font-size: 12px; margin-top: 4px; }
</style>
</head>
<body>
  <h1>Upload a Custom Song</h1>
  <p class="sub">Adds a track to the Cheese CDN music library. This is a public, open resource - no login needed.</p>

  <div class="tabs">
    <div class="tab active" id="tabUrl" onclick="setMode('url')">From URL</div>
    <div class="tab" id="tabFile" onclick="setMode('file')">From Device</div>
  </div>

  <form id="uploadForm">
    <fieldset>
      <legend>Source</legend>
      <div class="mode-panel active" id="panelUrl">
        <label for="sourceUrl">Direct link to an .mp3 file</label>
        <input type="url" id="sourceUrl" placeholder="https://example.com/song.mp3">
      </div>
      <div class="mode-panel" id="panelFile">
        <label for="sourceFile">Choose an .mp3 file</label>
        <input type="file" id="sourceFile" accept="audio/mpeg,.mp3">
      </div>
    </fieldset>

    <fieldset>
      <legend>Details</legend>
      <label for="title">Title</label>
      <input type="text" id="title" required maxlength="200" placeholder="Song title">
      <label for="artist">Artist</label>
      <input type="text" id="artist" required maxlength="200" placeholder="Artist name">
      <label for="songId">Song ID (optional)</label>
      <input type="number" id="songId" min="${CUSTOM_ID_MIN}" max="${CUSTOM_ID_MAX}" placeholder="Leave blank to auto-assign">
      <div class="hint">Custom songs use IDs ${CUSTOM_ID_MIN.toLocaleString()}-${CUSTOM_ID_MAX.toLocaleString()} so they never collide with real Newgrounds tracks.</div>
    </fieldset>

    <button type="submit" id="submitBtn">Upload</button>
  </form>

  <div id="result"></div>

<script>
function setMode(mode) {
  document.getElementById('tabUrl').classList.toggle('active', mode === 'url');
  document.getElementById('tabFile').classList.toggle('active', mode === 'file');
  document.getElementById('panelUrl').classList.toggle('active', mode === 'url');
  document.getElementById('panelFile').classList.toggle('active', mode === 'file');
}

document.getElementById('uploadForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('submitBtn');
  const result = document.getElementById('result');
  result.className = ''; result.style.display = 'none';

  const title = document.getElementById('title').value.trim();
  const artist = document.getElementById('artist').value.trim();
  const songId = document.getElementById('songId').value.trim();
  const url = document.getElementById('sourceUrl').value.trim();
  const fileInput = document.getElementById('sourceFile');
  const usingFile = document.getElementById('tabFile').classList.contains('active');

  if (usingFile && !fileInput.files[0]) {
    result.className = 'err'; result.textContent = 'Choose a file first.'; result.style.display = 'block';
    return;
  }
  if (!usingFile && !url) {
    result.className = 'err'; result.textContent = 'Enter a URL first.'; result.style.display = 'block';
    return;
  }

  btn.disabled = true; btn.textContent = 'Uploading...';

  try {
    const fd = new FormData();
    fd.append('title', title);
    fd.append('artist', artist);
    if (songId) fd.append('songId', songId);
    if (usingFile) {
      fd.append('file', fileInput.files[0]);
    } else {
      fd.append('url', url);
    }

    const res = await fetch('/songUpload', { method: 'POST', body: fd });
    const data = await res.json();

    if (res.ok) {
      result.className = 'ok';
      result.textContent = 'Uploaded! Song ID: ' + data.songId + '\\nCDN URL: ' + data.cdnUrl;
    } else {
      result.className = 'err';
      result.textContent = 'Failed: ' + (data.error || 'unknown error');
    }
    result.style.display = 'block';
  } catch (err) {
    result.className = 'err'; result.textContent = 'Request failed: ' + err.message; result.style.display = 'block';
  } finally {
    btn.disabled = false; btn.textContent = 'Upload';
  }
});
</script>
</body>
</html>`;

var worker_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathSegments = url.pathname.split("/").filter(Boolean);

    // â”€â”€ Route: GET /upload - the web form â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (url.pathname === "/upload" && request.method === "GET") {
      return new Response(UPLOAD_PAGE_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // â”€â”€ Route: POST /songUpload â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Supports two request shapes:
    //   multipart/form-data with a "file" field  -> direct device upload
    //   multipart/form-data or JSON with a "url"  -> fetch from any URL
    // Public, open, no auth - by design. The only real check is that the
    // actual bytes are genuinely an MP3, checked via magic bytes, not by
    // trusting whatever content-type or extension was claimed.
    if (url.pathname === "/songUpload" && request.method === "POST") {
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
          if (fileField && typeof fileField === "object" && "arrayBuffer" in fileField) {
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
          return new Response(JSON.stringify({ error: "title and artist are required" }), { status: 400 });
        }
        if (!sourceUrl && !uploadedFile) {
          return new Response(JSON.stringify({ error: "provide either a source url or a file" }), { status: 400 });
        }

        // â”€â”€ Resolve the song ID â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        let songId;
        if (requestedId) {
          if (isNaN(requestedId) || requestedId < CUSTOM_ID_MIN || requestedId > CUSTOM_ID_MAX) {
            return new Response(JSON.stringify({
              error: `songId must be between ${CUSTOM_ID_MIN} and ${CUSTOM_ID_MAX} - this range is reserved so custom uploads never collide with real Newgrounds song IDs`
            }), { status: 400 });
          }
          songId = requestedId;
        } else {
          songId = await findFreeCustomId(env);
          if (!songId) {
            return new Response(JSON.stringify({ error: "couldn't find a free id, try again" }), { status: 500 });
          }
        }

        const r2Key = `musics/${songId}.mp3`;
        const existing = await env.SONG_CACHE.head(r2Key);
        if (existing) {
          return new Response(JSON.stringify({
            error: `song id ${songId} is already in use`, songId
          }), { status: 409 });
        }

        // â”€â”€ Get the actual bytes, from whichever source was given â”€â”€â”€â”€â”€â”€â”€
        let bytes;
        if (uploadedFile) {
          if (uploadedFile.size > MAX_UPLOAD_BYTES) {
            return new Response(JSON.stringify({ error: `file too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)` }), { status: 413 });
          }
          bytes = new Uint8Array(await uploadedFile.arrayBuffer());
        } else {
          let fetchRes;
          try {
            fetchRes = await fetch(sourceUrl, {
              headers: { "User-Agent": "Mozilla/5.0 (compatible; robtopcdn-proxy/1.0)" }
            });
          } catch (e) {
            return new Response(JSON.stringify({ error: `couldn't reach that url: ${e.message}` }), { status: 400 });
          }
          if (!fetchRes.ok) {
            return new Response(JSON.stringify({ error: `source url returned HTTP ${fetchRes.status}` }), { status: 400 });
          }
          const contentLength = fetchRes.headers.get("content-length");
          if (contentLength && parseInt(contentLength, 10) > MAX_UPLOAD_BYTES) {
            return new Response(JSON.stringify({ error: `file too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)` }), { status: 413 });
          }
          const buf = await fetchRes.arrayBuffer();
          if (buf.byteLength > MAX_UPLOAD_BYTES) {
            return new Response(JSON.stringify({ error: `file too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)` }), { status: 413 });
          }
          bytes = new Uint8Array(buf);
        }

        // â”€â”€ The actual format check - real magic bytes, not a trusted label â”€
        if (!looksLikeMp3(bytes)) {
          return new Response(JSON.stringify({ error: "that doesn't look like a valid mp3 file" }), { status: 400 });
        }

        await env.SONG_CACHE.put(r2Key, bytes, {
          httpMetadata: { contentType: "audio/mpeg" },
          customMetadata: {
            songId: String(songId),
            title,
            artist,
            uploadedAt: new Date().toISOString(),
            custom: "true"
          }
        });

        return new Response(JSON.stringify({
          success: true, songId, key: r2Key,
          cdnUrl: `https://${url.host}/${songId}`
        }), { status: 201, headers: { "Content-Type": "application/json" } });

      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // â”€â”€ Route: /info/{songId} â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

    // Custom-range IDs never hit Newgrounds at all - they only ever exist
    // in R2, since there's no real NG post to look up for them.
    let ngInfo = { title: "Unknown", artist: "Unknown", duration: 0, streamUrl: null };
    let r2Head = null;
    if (isCustomRange) {
      r2Head = await env.SONG_CACHE.head(newR2Key);
      if (!r2Head) {
        return new Response(JSON.stringify({ error: "no custom song with that id" }), {
          status: 404, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
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
            await cacheFullSong(env, newR2Key, downloadUrl, {
              songId: String(id), title: ngInfo.title || "", artist: ngInfo.artist || ""
            });
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
      }, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
      });
    }

    // â”€â”€ Audio streaming â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
  const headers = {
    "User-Agent": "Mozilla/5.0 (compatible; robtopcdn-proxy/1.0)",
    "Referer": "https://www.newgrounds.com/"
  };
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
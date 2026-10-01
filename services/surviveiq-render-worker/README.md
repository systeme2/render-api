# surviveiq-render-worker

Dedicated FFmpeg probe/render worker for SURVIVEIQ. Fully independent of n8n —
n8n will call it over HTTP once it has been validated (not yet wired in phase 05B).

## Phase 05B scope

This phase ships `/health` and `/probe` only. It does **not** ship a render
endpoint, does not touch any AI video/TTS provider, and is not yet connected
from the n8n workflow (`4WETNjWNXjtjUQVz`, which stays `active=false`).

## Endpoints

### `GET /health` — public, no auth

Runs `ffmpeg -version` and `ffprobe -version` for real and reports:

```json
{
  "ok": true,
  "service": "surviveiq-render-worker",
  "ffmpeg_available": true,
  "ffprobe_available": true,
  "ffmpeg_version": "6.1.1",
  "ffprobe_version": "6.1.1"
}
```

### `POST /probe` — requires `Authorization: Bearer <RENDER_WORKER_TOKEN>`

```json
{ "url": "https://<allowed-host>/path/to/file.mp3?...signed-params" }
```

The worker:
1. Validates the URL (https only, hostname must exactly match `ALLOWED_MEDIA_HOSTS`,
   rejects localhost/loopback/private IPs/IP literals/non-https schemes).
2. Downloads it itself (manual redirect handling — every redirect hop is
   re-validated against the same allow-list, capped at 3 hops, capped at
   `MAX_PROBE_DOWNLOAD_BYTES`) to a private temp file. **ffmpeg/ffprobe never
   touch the network directly** — this is what lets us stop a redirect from
   ever landing on a forbidden host.
3. Runs `ffprobe` on the local temp file only, with a static argument list
   (no shell, no string interpolation into a command line).
4. Deletes the temp file in a `finally` block.

Response:

```json
{
  "success": true,
  "media": {
    "format_name": "mp3",
    "duration_ms": 12345,
    "size_bytes": 204800,
    "video": null,
    "audio": { "codec": "mp3", "sample_rate": 44100, "channels": 2 }
  }
}
```

Errors are normalized, e.g.:

```json
{ "success": false, "error": { "code": "HOSTNAME_NOT_ALLOWED", "message": "The provided URL is not allowed." } }
```

No stack trace, no system command, no secret ever appears in a response.

## Future (not built yet)

```
POST /render
```

Arrives in 05C/05D once the render strategy (clip duration gap handling,
music/SFX layers, subtitles) has been decided.

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `PORT` | no | Railway sets this automatically; `3000` local fallback |
| `NODE_ENV` | no | `production` on Railway |
| `RENDER_WORKER_TOKEN` | **yes** | Bearer token required on every route except `/health`. Generate with `openssl rand -hex 32`. Never commit it. |
| `ALLOWED_MEDIA_HOSTS` | **yes** | Comma-separated exact hostnames `/probe` may fetch from |
| `PROBE_TIMEOUT_MS` | no | Default `30000` |

## Local development

```bash
cp .env.example .env   # fill in RENDER_WORKER_TOKEN and ALLOWED_MEDIA_HOSTS
npm install
npm start
```

## Tests

```bash
npm test
```

`test/worker.test.js` uses only Node's built-in `node:test` — no extra
dependencies. It covers the SSRF allow-list (https-only, exact hostname
match, localhost/loopback/private-IP/IP-literal rejection, malformed URLs,
forbidden schemes), the constant-time token comparison, the ffprobe→JSON
mapping, and a real end-to-end probe of a locally generated silent WAV file
via the actual `ffmpeg`/`ffprobe` binaries.

## Docker

```bash
docker build -t surviveiq-render-worker .
docker run --rm -p 3000:3000 \
  -e RENDER_WORKER_TOKEN=dev-token \
  -e ALLOWED_MEDIA_HOSTS=br-super-thunder-b1x77bfo.storage.c-5.eu-central-1.aws.neon.tech \
  surviveiq-render-worker

curl http://localhost:3000/health
```

## Security notes

- No `shell: true`, no string-built shell commands anywhere — `execFile`/`spawn`
  equivalents with static argument arrays only.
- The bearer token is compared with `crypto.timingSafeEqual`, padded so a
  length mismatch doesn't short-circuit the timing.
- Logs include `request_id`, `route`, `status`, `duration_ms`. They never
  include the `Authorization` header, full signed-URL query strings, or
  credentials — URLs are logged as `hostname + pathname` only.
- The worker holds no Neon/S3 credentials. It only ever receives short-lived
  signed URLs generated elsewhere (n8n/Neon), and never persists them.

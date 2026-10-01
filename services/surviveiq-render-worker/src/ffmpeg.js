'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { assertSafeMediaUrl, ForbiddenUrlError } = require('./security');

function execFileWithTimeout(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, killSignal: 'SIGKILL' },
      (err, stdout, stderr) => {
        if (err) {
          if (err.killed || err.signal === 'SIGKILL') {
            const e = new Error(cmd + ' timed out after ' + timeoutMs + 'ms.');
            e.code = 'TIMEOUT';
            return reject(e);
          }
          err.stdout = stdout;
          err.stderr = stderr;
          return reject(err);
        }
        resolve({ stdout: stdout, stderr: stderr });
      }
    );
  });
}

async function getFfmpegVersion() {
  try {
    const { stdout } = await execFileWithTimeout('ffmpeg', ['-version'], 5000);
    const m = stdout.match(/ffmpeg version (\S+)/i);
    return { available: true, version: m ? m[1] : null };
  } catch (e) {
    return { available: false, version: null };
  }
}

async function getFfprobeVersion() {
  try {
    const { stdout } = await execFileWithTimeout('ffprobe', ['-version'], 5000);
    const m = stdout.match(/ffprobe version (\S+)/i);
    return { available: true, version: m ? m[1] : null };
  } catch (e) {
    return { available: false, version: null };
  }
}

/**
 * Downloads a remote media file to a local temp path, enforcing:
 * - the SSRF allow-list on the initial URL AND on every redirect hop
 * - a hard redirect cap
 * - a hard byte-size cap
 * - an overall timeout via AbortController
 * Never lets ffmpeg/ffprobe touch the network directly.
 */
async function downloadToTemp(rawUrl, opts) {
  const { allowedHosts, timeoutMs, maxBytes, maxRedirects } = opts;
  let current = assertSafeMediaUrl(rawUrl, allowedHosts);
  let redirectsLeft = maxRedirects;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    for (;;) {
      const res = await fetch(current, { redirect: 'manual', signal: controller.signal });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) {
          throw new ForbiddenUrlError('Redirect with no Location header.', 'REDIRECT_INVALID');
        }
        if (redirectsLeft <= 0) {
          throw new ForbiddenUrlError('Too many redirects.', 'TOO_MANY_REDIRECTS');
        }
        redirectsLeft -= 1;
        const nextUrl = new URL(location, current);
        current = assertSafeMediaUrl(nextUrl.toString(), allowedHosts);
        continue;
      }

      if (!res.ok) {
        const e = new Error('Upstream fetch failed with status ' + res.status);
        e.code = 'UPSTREAM_FETCH_FAILED';
        throw e;
      }

      const tmpPath = path.join(os.tmpdir(), 'surviveiq-probe-' + crypto.randomBytes(8).toString('hex'));
      const fileStream = fs.createWriteStream(tmpPath, { mode: 0o600 });
      let received = 0;

      try {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.length;
          if (received > maxBytes) {
            throw new Error('Media exceeds maximum allowed size (' + maxBytes + ' bytes).');
          }
          await new Promise((resolve, reject) => {
            fileStream.write(Buffer.from(value), (err) => (err ? reject(err) : resolve()));
          });
        }
      } finally {
        await new Promise((resolve) => fileStream.end(resolve));
      }

      return tmpPath;
    }
  } finally {
    clearTimeout(timer);
  }
}

function mapFfprobeOutput(parsed) {
  const format = parsed.format || {};
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const videoStream = streams.find((s) => s.codec_type === 'video') || null;
  const audioStream = streams.find((s) => s.codec_type === 'audio') || null;

  const durationSec = format.duration !== undefined ? Number(format.duration) : null;
  const duration_ms = Number.isFinite(durationSec) ? Math.round(durationSec * 1000) : null;
  const sizeBytes = format.size !== undefined ? Number(format.size) : null;

  let fps = null;
  if (videoStream && videoStream.r_frame_rate) {
    const parts = String(videoStream.r_frame_rate).split('/');
    if (parts.length === 2 && Number(parts[1]) !== 0) {
      fps = Number(parts[0]) / Number(parts[1]);
    }
  }

  return {
    format_name: format.format_name || null,
    duration_ms: duration_ms,
    size_bytes: Number.isFinite(sizeBytes) ? sizeBytes : null,
    video: videoStream
      ? {
          codec: videoStream.codec_name || null,
          width: videoStream.width || null,
          height: videoStream.height || null,
          fps: fps,
          pixel_format: videoStream.pix_fmt || null
        }
      : null,
    audio: audioStream
      ? {
          codec: audioStream.codec_name || null,
          sample_rate: audioStream.sample_rate ? Number(audioStream.sample_rate) : null,
          channels: audioStream.channels !== undefined ? audioStream.channels : null
        }
      : null
  };
}

async function probeLocalFile(localPath, timeoutMs) {
  const args = [
    '-v', 'error',
    '-show_entries',
    'format=format_name,duration,size:stream=codec_type,codec_name,width,height,r_frame_rate,pix_fmt,sample_rate,channels',
    '-of', 'json',
    localPath
  ];
  const { stdout } = await execFileWithTimeout('ffprobe', args, timeoutMs);
  return mapFfprobeOutput(JSON.parse(stdout));
}

async function probeMediaUrl(rawUrl, opts) {
  let tmpPath = null;
  try {
    tmpPath = await downloadToTemp(rawUrl, opts);
    return await probeLocalFile(tmpPath, opts.timeoutMs);
  } finally {
    if (tmpPath) {
      fs.promises.unlink(tmpPath).catch(() => {});
    }
  }
}

module.exports = {
  getFfmpegVersion,
  getFfprobeVersion,
  probeMediaUrl,
  probeLocalFile,
  mapFfprobeOutput,
  execFileWithTimeout
};

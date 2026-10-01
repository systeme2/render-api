'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { downloadToTemp, probeLocalFile, execFileWithTimeout } = require('./ffmpeg');

function makeError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function validateRenderInput(body, maxVideos) {
  if (!body || typeof body !== 'object') {
    throw makeError('Invalid request body.', 'INVALID_BODY');
  }

  const episodeId = String(body.episode_id || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(episodeId)) {
    throw makeError('Invalid episode_id.', 'INVALID_BODY');
  }

  const videoUrls = Array.isArray(body.video_urls) ? body.video_urls : [];
  if (videoUrls.length < 1 || videoUrls.length > maxVideos || videoUrls.some((u) => typeof u !== 'string' || !u)) {
    throw makeError('video_urls must contain between 1 and ' + maxVideos + ' URLs.', 'INVALID_BODY');
  }

  if (typeof body.audio_url !== 'string' || !body.audio_url) {
    throw makeError('audio_url is required.', 'INVALID_BODY');
  }

  const output = body.output || {};
  const width = Number(output.width || 1080);
  const height = Number(output.height || 1920);
  const fps = Number(output.fps || 30);

  // V1 deliberately supports one bounded output profile only.
  if (width !== 1080 || height !== 1920 || fps !== 30) {
    throw makeError('Unsupported output profile.', 'UNSUPPORTED_OUTPUT_PROFILE');
  }

  return {
    episodeId,
    videoUrls,
    audioUrl: body.audio_url,
    width,
    height,
    fps
  };
}

function concatLine(filePath) {
  return "file '" + String(filePath).replace(/'/g, "'\\''") + "'\n";
}

async function renderEpisode(body, config) {
  const input = validateRenderInput(body, config.maxRenderVideos);
  const downloaded = [];
  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'surviveiq-render-'));
  const started = Date.now();

  try {
    const normalizedPaths = [];

    for (let i = 0; i < input.videoUrls.length; i += 1) {
      const source = await downloadToTemp(input.videoUrls[i], {
        allowedHosts: config.allowedMediaHosts,
        timeoutMs: config.renderTimeoutMs,
        maxBytes: config.maxDownloadBytes,
        maxRedirects: config.maxRedirects
      });
      downloaded.push(source);

      const sourceProbe = await probeLocalFile(source, config.probeTimeoutMs);
      if (!sourceProbe.video) {
        throw makeError('A render input does not contain a video stream.', 'INVALID_VIDEO_INPUT');
      }

      const normalized = path.join(workDir, 'video-' + String(i).padStart(2, '0') + '.mp4');
      await execFileWithTimeout('ffmpeg', [
        '-y',
        '-v', 'error',
        '-i', source,
        '-an',
        '-vf',
        'scale=' + input.width + ':' + input.height + ':force_original_aspect_ratio=increase,' +
          'crop=' + input.width + ':' + input.height + ',fps=' + input.fps + ',format=yuv420p',
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '20',
        '-movflags', '+faststart',
        normalized
      ], config.renderTimeoutMs);

      normalizedPaths.push(normalized);
    }

    const concatList = path.join(workDir, 'concat.txt');
    await fs.promises.writeFile(concatList, normalizedPaths.map(concatLine).join(''), { mode: 0o600 });

    const concatenated = path.join(workDir, 'video-concat.mp4');
    await execFileWithTimeout('ffmpeg', [
      '-y',
      '-v', 'error',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatList,
      '-c', 'copy',
      '-movflags', '+faststart',
      concatenated
    ], config.renderTimeoutMs);

    const videoProbe = await probeLocalFile(concatenated, config.probeTimeoutMs);
    if (!videoProbe.video || !videoProbe.duration_ms || videoProbe.duration_ms <= 0) {
      throw makeError('Concatenated video is invalid.', 'INVALID_VIDEO_OUTPUT');
    }

    const audio = await downloadToTemp(input.audioUrl, {
      allowedHosts: config.allowedMediaHosts,
      timeoutMs: config.renderTimeoutMs,
      maxBytes: config.maxDownloadBytes,
      maxRedirects: config.maxRedirects
    });
    downloaded.push(audio);

    const audioProbe = await probeLocalFile(audio, config.probeTimeoutMs);
    if (!audioProbe.audio || !audioProbe.duration_ms || audioProbe.duration_ms <= 0) {
      throw makeError('Narration input is invalid.', 'INVALID_AUDIO_INPUT');
    }

    if (audioProbe.duration_ms - videoProbe.duration_ms > 1000) {
      throw makeError('Narration exceeds the video duration by more than 1000 ms.', 'DURATION_MISMATCH');
    }

    const videoSeconds = (videoProbe.duration_ms / 1000).toFixed(3);
    const outputPath = path.join(workDir, 'final-' + crypto.randomBytes(6).toString('hex') + '.mp4');

    await execFileWithTimeout('ffmpeg', [
      '-y',
      '-v', 'error',
      '-i', concatenated,
      '-i', audio,
      '-filter_complex', '[1:a]apad[a]',
      '-map', '0:v:0',
      '-map', '[a]',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-t', videoSeconds,
      '-movflags', '+faststart',
      outputPath
    ], config.renderTimeoutMs);

    const finalProbe = await probeLocalFile(outputPath, config.probeTimeoutMs);
    if (!finalProbe.video || !finalProbe.audio || !finalProbe.duration_ms || finalProbe.duration_ms <= 0) {
      throw makeError('Final render validation failed.', 'INVALID_FINAL_OUTPUT');
    }

    if (
      finalProbe.video.codec !== 'h264' ||
      finalProbe.video.width !== 1080 ||
      finalProbe.video.height !== 1920 ||
      Math.abs(Number(finalProbe.video.fps || 0) - 30) > 0.01 ||
      finalProbe.video.pixel_format !== 'yuv420p' ||
      finalProbe.audio.codec !== 'aac'
    ) {
      throw makeError('Final render output profile is invalid.', 'INVALID_FINAL_OUTPUT');
    }

    const stat = await fs.promises.stat(outputPath);
    if (stat.size <= 0 || stat.size > config.maxDownloadBytes) {
      throw makeError('Final render size is invalid.', 'INVALID_FINAL_OUTPUT');
    }

    const buffer = await fs.promises.readFile(outputPath);
    return {
      buffer,
      media: finalProbe,
      render_duration_ms: Date.now() - started,
      size_bytes: stat.size
    };
  } finally {
    await Promise.all(downloaded.map((p) => fs.promises.unlink(p).catch(() => {})));
    await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { renderEpisode, validateRenderInput };

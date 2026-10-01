'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { assertSafeMediaUrl, ForbiddenUrlError, timingSafeEqual } = require('../src/security');
const { probeLocalFile, mapFfprobeOutput, getFfmpegVersion, getFfprobeVersion } = require('../src/ffmpeg');

const execFileP = promisify(execFile);

const ALLOWED = ['br-super-thunder-b1x77bfo.storage.c-5.eu-central-1.aws.neon.tech'];

// --- SSRF / URL allow-list ---------------------------------------------

test('accepts an allowed https host', () => {
  const u = assertSafeMediaUrl(
    'https://' + ALLOWED[0] + '/surviveiq-audio/voice/x.mp3?sig=abc',
    ALLOWED
  );
  assert.equal(u.hostname, ALLOWED[0]);
});

test('rejects http scheme on the allowed host', () => {
  assert.throws(() => assertSafeMediaUrl('http://' + ALLOWED[0] + '/x.mp3', ALLOWED), ForbiddenUrlError);
});

test('rejects an unapproved host (example.com)', () => {
  assert.throws(() => assertSafeMediaUrl('https://example.com/file.mp3', ALLOWED), ForbiddenUrlError);
});

test('rejects localhost', () => {
  assert.throws(() => assertSafeMediaUrl('https://localhost/x.mp3', ALLOWED), ForbiddenUrlError);
});

test('rejects http://127.0.0.1', () => {
  assert.throws(() => assertSafeMediaUrl('http://127.0.0.1/x.mp3', ALLOWED), ForbiddenUrlError);
});

test('rejects https://127.0.0.1 (IP literal, still not allow-listed)', () => {
  assert.throws(() => assertSafeMediaUrl('https://127.0.0.1/x.mp3', ALLOWED), ForbiddenUrlError);
});

test('rejects ::1', () => {
  assert.throws(() => assertSafeMediaUrl('https://[::1]/x.mp3', ALLOWED), ForbiddenUrlError);
});

test('rejects private IPv4 ranges', () => {
  assert.throws(() => assertSafeMediaUrl('https://10.0.0.5/x.mp3', ALLOWED), ForbiddenUrlError);
  assert.throws(() => assertSafeMediaUrl('https://192.168.1.10/x.mp3', ALLOWED), ForbiddenUrlError);
  assert.throws(() => assertSafeMediaUrl('https://172.16.0.1/x.mp3', ALLOWED), ForbiddenUrlError);
});

test('rejects a public IP literal even though it is not private', () => {
  assert.throws(() => assertSafeMediaUrl('https://8.8.8.8/x.mp3', ALLOWED), ForbiddenUrlError);
});

test('rejects malformed URLs', () => {
  assert.throws(() => assertSafeMediaUrl('not a url', ALLOWED), ForbiddenUrlError);
  assert.throws(() => assertSafeMediaUrl('', ALLOWED), ForbiddenUrlError);
});

test('rejects file: and ftp: and data: schemes', () => {
  assert.throws(() => assertSafeMediaUrl('file:///etc/passwd', ALLOWED), ForbiddenUrlError);
  assert.throws(() => assertSafeMediaUrl('ftp://' + ALLOWED[0] + '/x.mp3', ALLOWED), ForbiddenUrlError);
  assert.throws(() => assertSafeMediaUrl('data:text/plain;base64,aGk=', ALLOWED), ForbiddenUrlError);
});

// --- Auth token comparison ----------------------------------------------

test('timingSafeEqual matches identical strings', () => {
  assert.equal(timingSafeEqual('Bearer abc123', 'Bearer abc123'), true);
});

test('timingSafeEqual rejects different strings of equal length', () => {
  assert.equal(timingSafeEqual('Bearer abc123', 'Bearer xyz987'), false);
});

test('timingSafeEqual rejects different-length strings without throwing', () => {
  assert.equal(timingSafeEqual('Bearer short', 'Bearer much-much-longer-token'), false);
});

// --- ffprobe output mapping ----------------------------------------------

test('mapFfprobeOutput maps a video+audio stream pair', () => {
  const mapped = mapFfprobeOutput({
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '12.345000', size: '204800' },
    streams: [
      { codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920, r_frame_rate: '30/1', pix_fmt: 'yuv420p' },
      { codec_type: 'audio', codec_name: 'aac', sample_rate: '44100', channels: 2 }
    ]
  });
  assert.equal(mapped.duration_ms, 12345);
  assert.equal(mapped.size_bytes, 204800);
  assert.equal(mapped.video.codec, 'h264');
  assert.equal(mapped.video.fps, 30);
  assert.equal(mapped.audio.codec, 'aac');
  assert.equal(mapped.audio.channels, 2);
});

test('mapFfprobeOutput handles audio-only media (video=null)', () => {
  const mapped = mapFfprobeOutput({
    format: { format_name: 'mp3', duration: '2.000000', size: '32000' },
    streams: [{ codec_type: 'audio', codec_name: 'mp3', sample_rate: '44100', channels: 1 }]
  });
  assert.equal(mapped.video, null);
  assert.equal(mapped.audio.codec, 'mp3');
});

// --- Real ffmpeg/ffprobe availability (this sandbox happens to have them) --

test('getFfmpegVersion reports availability', async () => {
  const r = await getFfmpegVersion();
  assert.equal(typeof r.available, 'boolean');
});

test('getFfprobeVersion reports availability', async () => {
  const r = await getFfprobeVersion();
  assert.equal(typeof r.available, 'boolean');
});

// --- Real end-to-end probe against a locally generated file (no network) --

test('probeLocalFile reads real ffprobe output for a generated silent WAV', async (t) => {
  const ffmpegCheck = await getFfmpegVersion();
  const ffprobeCheck = await getFfprobeVersion();
  if (!ffmpegCheck.available || !ffprobeCheck.available) {
    t.skip('ffmpeg/ffprobe not available in this environment');
    return;
  }

  const tmpFile = path.join(os.tmpdir(), 'surviveiq-test-' + Date.now() + '.wav');
  await execFileP('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
    '-t', '1.5', tmpFile
  ]);

  try {
    const media = await probeLocalFile(tmpFile, 10000);
    assert.equal(media.video, null);
    assert.ok(media.audio, 'expected an audio stream');
    assert.equal(media.audio.sample_rate, 44100);
    assert.ok(media.duration_ms >= 1400 && media.duration_ms <= 1600, 'duration_ms=' + media.duration_ms);
    assert.ok(media.size_bytes > 0);
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

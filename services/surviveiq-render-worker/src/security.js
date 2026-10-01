'use strict';

const net = require('net');
const crypto = require('crypto');

const FORBIDDEN_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

class ForbiddenUrlError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ForbiddenUrlError';
    this.code = code || 'FORBIDDEN_URL';
  }
}

function isPrivateIpv4(hostname) {
  const m = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isPrivateIpv6(hostname) {
  const h = hostname.toLowerCase();
  if (h === '::1' || h === '::') return true;
  if (h.startsWith('fc') || h.startsWith('fd')) return true; // unique local addresses
  if (h.startsWith('fe80')) return true; // link-local
  return false;
}

/**
 * Validates a media URL against the strict allow-list policy.
 * Throws ForbiddenUrlError on anything not explicitly permitted.
 * Returns the parsed URL object when the URL is safe to use.
 */
function assertSafeMediaUrl(rawUrl, allowedHosts) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch (e) {
    throw new ForbiddenUrlError('Malformed URL.', 'MALFORMED_URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new ForbiddenUrlError('Only https URLs are allowed.', 'PROTOCOL_NOT_ALLOWED');
  }

  const hostname = parsed.hostname.toLowerCase();

  if (FORBIDDEN_HOSTNAMES.has(hostname)) {
    throw new ForbiddenUrlError('Hostname is forbidden.', 'HOSTNAME_FORBIDDEN');
  }

  if (net.isIP(hostname)) {
    if (isPrivateIpv4(hostname) || isPrivateIpv6(hostname)) {
      throw new ForbiddenUrlError('Private IP addresses are forbidden.', 'PRIVATE_IP_FORBIDDEN');
    }
    // Even a public IP literal is rejected: only exact allow-listed hostnames pass.
    throw new ForbiddenUrlError('IP literal hosts are not allowed.', 'HOSTNAME_NOT_ALLOWED');
  }

  if (!Array.isArray(allowedHosts) || !allowedHosts.includes(hostname)) {
    throw new ForbiddenUrlError('Hostname is not in ALLOWED_MEDIA_HOSTS.', 'HOSTNAME_NOT_ALLOWED');
  }

  return parsed;
}

/**
 * Constant-time string comparison for bearer tokens.
 * Never short-circuits on length in a way that leaks timing beyond the
 * (non-sensitive) length check itself.
 */
function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // Burn equivalent time so callers can't distinguish "wrong length" from
    // "right length, wrong content" by timing.
    crypto.timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32));
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = {
  assertSafeMediaUrl,
  ForbiddenUrlError,
  timingSafeEqual,
  isPrivateIpv4,
  isPrivateIpv6
};

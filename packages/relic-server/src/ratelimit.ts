/**
 * Fixed-window per-IP limiting.
 *
 * The app server never emits 401 or 403 on any public endpoint
 * (`spec/service.md` 1.1). Claude Code marks a remote server as needing
 * authentication when it sees either, which would push publishers at an
 * authorization server that does not exist. Rate limiting therefore refuses
 * with 429 and nothing else.
 */

import type { RateLimitConfig } from './config.ts';

interface Window {
  count: number;
  resetAt: number;
}

export interface LimitVerdict {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

export interface RateLimiterOptions {
  readonly maxEntries?: number;
  readonly sweepInterval?: number;
}

/**
 * Normalizes an IP address for rate-limiting keys:
 * - IPv4 addresses are returned unchanged (in canonical dotted-decimal form).
 * - IPv4-mapped IPv6 addresses (::ffff:x.x.x.x or ::ffff:xxxx:xxxx) are normalized
 *   to canonical IPv4 dotted-decimal form, sharing budget with direct IPv4 callers.
 * - IPv6 addresses are truncated to their /64 prefix (the first four 16-bit words)
 *   in canonical lowercase hex form (w0:w1:w2:w3::/64), so callers rotating within
 *   a single /64 share a rate-limit budget.
 * - Leading/trailing brackets, scope IDs (%zone), and trailing ports are stripped.
 * - Unparseable inputs are returned trimmed.
 */
export function rateLimitIp(ip: string): string {
  let clean = ip.trim();
  if (clean.length === 0) return '127.0.0.1';

  const v4 = parseIpv4(clean);
  if (v4 !== null) return `${v4[0]}.${v4[1]}.${v4[2]}.${v4[3]}`;

  if (clean.startsWith('[') && clean.includes(']')) {
    clean = clean.slice(1, clean.indexOf(']'));
  } else if (clean.includes('%')) {
    clean = clean.slice(0, clean.indexOf('%'));
  }

  // Check if an embedded IPv4 address appears at the end of IPv6 (e.g. ::ffff:192.0.2.1)
  if (clean.includes('.')) {
    const lastColon = clean.lastIndexOf(':');
    if (lastColon === -1) return ip.trim();
    const v4Part = clean.slice(lastColon + 1);
    const v4Bytes = parseIpv4(v4Part);
    if (v4Bytes === null) return ip.trim();
    const w6 = (v4Bytes[0] << 8) | v4Bytes[1];
    const w7 = (v4Bytes[2] << 8) | v4Bytes[3];
    let prefix = clean.slice(0, lastColon);
    if (prefix === ':') prefix = '::';
    else if (!prefix.endsWith(':')) prefix = `${prefix}:`;
    clean = `${prefix}${w6.toString(16)}:${w7.toString(16)}`;
  }

  const words = parseIpv6Words(clean);
  if (words === null) return ip.trim();

  // IPv4-mapped IPv6: first 80 bits 0, next 16 bits 1 (RFC 4291)
  if (
    words[0] === 0 &&
    words[1] === 0 &&
    words[2] === 0 &&
    words[3] === 0 &&
    words[4] === 0 &&
    words[5] === 0xffff
  ) {
    const b0 = (words[6] >> 8) & 0xff;
    const b1 = words[6] & 0xff;
    const b2 = (words[7] >> 8) & 0xff;
    const b3 = words[7] & 0xff;
    return `${b0}.${b1}.${b2}.${b3}`;
  }

  // /64 prefix is the first 4 16-bit words (64 bits)
  const p0 = words[0].toString(16);
  const p1 = words[1].toString(16);
  const p2 = words[2].toString(16);
  const p3 = words[3].toString(16);
  return `${p0}:${p1}:${p2}:${p3}::/64`;
}

/**
 * Constructs a rate limit key from a scope and client IP address.
 * The client IP is normalized via rateLimitIp so IPv6 addresses in
 * the same /64 prefix share the same rate limit key.
 */
export function rateLimitKey(scope: string, ip: string): string {
  return `${scope} ${rateLimitIp(ip)}`;
}

function parseIpv4(s: string): [number, number, number, number] | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    if (part.length > 1 && part.startsWith('0')) return null;
    bytes.push(n);
  }
  return [bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!];
}

type Ipv6Words = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

function parseIpv6Words(clean: string): Ipv6Words | null {
  if (clean.startsWith(':') && !clean.startsWith('::')) return null;
  if (clean.endsWith(':') && !clean.endsWith('::')) return null;

  const doubleColonParts = clean.split('::');
  if (doubleColonParts.length > 2) return null;

  let leftGroups: string[] = [];
  let rightGroups: string[] = [];
  if (doubleColonParts.length === 2) {
    const [leftStr, rightStr] = doubleColonParts;
    leftGroups = leftStr ? leftStr.split(':') : [];
    rightGroups = rightStr ? rightStr.split(':') : [];
  } else {
    leftGroups = clean.split(':');
  }

  const totalGroups = leftGroups.length + rightGroups.length;
  if (doubleColonParts.length === 2) {
    if (totalGroups > 7) return null;
  } else {
    if (totalGroups !== 8) return null;
  }

  const hexRegex = /^[0-9a-fA-F]{1,4}$/;
  const leftWords: number[] = [];
  for (const g of leftGroups) {
    if (!hexRegex.test(g)) return null;
    leftWords.push(parseInt(g, 16));
  }
  const rightWords: number[] = [];
  for (const g of rightGroups) {
    if (!hexRegex.test(g)) return null;
    rightWords.push(parseInt(g, 16));
  }

  const missingZeros = 8 - totalGroups;
  const zeroWords = Array(missingZeros).fill(0);
  const words = [...leftWords, ...zeroWords, ...rightWords];
  if (words.length !== 8) return null;
  return words as unknown as Ipv6Words;
}

/**
 * RateLimiter maintains in-memory fixed-window counters keyed by string.
 *
 * Eviction strategy:
 * 1. Inline expiry: When peek() or check() hits an expired window, it is
 *    deleted or reset immediately.
 * 2. Periodic sweep: Every sweepInterval calls to check(), the limiter sweeps
 *    all windows and deletes any where now >= resetAt.
 * 3. Capacity ceiling: If the number of windows reaches maxEntries, an immediate
 *    sweep runs. If the map remains at capacity after pruning expired windows,
 *    oldest entries are evicted in FIFO order to strictly bound memory usage.
 */
export class RateLimiter {
  private readonly windows = new Map<string, Window>();
  private readonly maxEntries: number;
  private readonly sweepInterval: number;
  private callsSinceSweep = 0;

  constructor(options: RateLimiterOptions = {}) {
    this.maxEntries = options.maxEntries ?? 100_000;
    this.sweepInterval = options.sweepInterval ?? 100;
  }

  get size(): number {
    return this.windows.size;
  }

  peek(key: string, config: RateLimitConfig, now: number): LimitVerdict {
    const window = this.windows.get(key);
    if (window === undefined || now >= window.resetAt) {
      if (window !== undefined) {
        this.windows.delete(key);
      }
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (window.count >= config.limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((window.resetAt - now) / 1000)
        ),
      };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  check(key: string, config: RateLimitConfig, now: number): LimitVerdict {
    this.callsSinceSweep += 1;
    if (
      this.callsSinceSweep >= this.sweepInterval ||
      this.windows.size >= this.maxEntries
    ) {
      this.sweep(now);
    }

    const window = this.windows.get(key);

    if (window === undefined || now >= window.resetAt) {
      if (this.windows.size >= this.maxEntries && !this.windows.has(key)) {
        const oldest = this.windows.keys().next().value;
        if (oldest !== undefined) {
          this.windows.delete(oldest);
        }
      }
      this.windows.set(key, {
        count: 1,
        resetAt: now + config.windowSeconds * 1000,
      });
      return { allowed: true, retryAfterSeconds: 0 };
    }

    if (window.count >= config.limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((window.resetAt - now) / 1000)
        ),
      };
    }

    window.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /**
   * Sweeps expired windows and enforces maxEntries bounds.
   * Returns the count of evicted keys.
   */
  sweep(now: number): number {
    this.callsSinceSweep = 0;
    let evicted = 0;
    for (const [k, win] of this.windows) {
      if (now >= win.resetAt) {
        this.windows.delete(k);
        evicted += 1;
      }
    }
    while (this.windows.size >= this.maxEntries) {
      const oldest = this.windows.keys().next().value;
      if (oldest === undefined) break;
      this.windows.delete(oldest);
      evicted += 1;
    }
    return evicted;
  }
}

import { describe, expect, test } from 'bun:test';
import { RateLimiter, rateLimitIp, rateLimitKey } from '../src/ratelimit.ts';

describe('rateLimitIp', () => {
  test('leaves IPv4 addresses unchanged', () => {
    expect(rateLimitIp('192.0.2.1')).toBe('192.0.2.1');
    expect(rateLimitIp('127.0.0.1')).toBe('127.0.0.1');
    expect(rateLimitIp('10.100.200.5')).toBe('10.100.200.5');
    expect(rateLimitIp('255.255.255.255')).toBe('255.255.255.255');
  });

  test('normalizes IPv4-mapped IPv6 to canonical IPv4', () => {
    expect(rateLimitIp('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(rateLimitIp('::FFFF:192.0.2.1')).toBe('192.0.2.1');
    expect(rateLimitIp('0:0:0:0:0:ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(rateLimitIp('0000:0000:0000:0000:0000:ffff:192.0.2.1')).toBe(
      '192.0.2.1'
    );
    expect(rateLimitIp('::ffff:c000:0201')).toBe('192.0.2.1');
  });

  test('truncates IPv6 to its canonical /64 prefix', () => {
    expect(rateLimitIp('2001:db8:abcd:0012::1')).toBe('2001:db8:abcd:12::/64');
    expect(rateLimitIp('2001:db8:abcd:12:ffff:eeee:dddd:cccc')).toBe(
      '2001:db8:abcd:12::/64'
    );
    expect(rateLimitIp('2001:db8:abcd:13::1')).toBe('2001:db8:abcd:13::/64');
  });

  test('normalizes compressed and expanded IPv6 forms identically', () => {
    const compressed = '2001:db8::1';
    const expanded = '2001:0db8:0000:0000:0000:0000:0000:0001';
    expect(rateLimitIp(compressed)).toBe('2001:db8:0:0::/64');
    expect(rateLimitIp(expanded)).toBe('2001:db8:0:0::/64');
  });

  test('handles localhost and unspecified IPv6 addresses', () => {
    expect(rateLimitIp('::1')).toBe('0:0:0:0::/64');
    expect(rateLimitIp('::')).toBe('0:0:0:0::/64');
  });

  test('strips brackets, ports, and scope IDs', () => {
    expect(rateLimitIp('[2001:db8:abcd:12::1]')).toBe('2001:db8:abcd:12::/64');
    expect(rateLimitIp('[2001:db8:abcd:12::1]:8080')).toBe(
      '2001:db8:abcd:12::/64'
    );
    expect(rateLimitIp('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });

  test('returns fallback on empty or unparseable input', () => {
    expect(rateLimitIp('')).toBe('127.0.0.1');
    expect(rateLimitIp('   ')).toBe('127.0.0.1');
    expect(rateLimitIp('not-an-ip')).toBe('not-an-ip');
  });
});

describe('rateLimitKey', () => {
  test('prefixes normalized IP with scope name', () => {
    expect(rateLimitKey('auth', '192.0.2.1')).toBe('auth 192.0.2.1');
    expect(rateLimitKey('publish', '2001:db8:abcd:12::1')).toBe(
      'publish 2001:db8:abcd:12::/64'
    );
  });
});

describe('RateLimiter behavioral tests', () => {
  const config = { limit: 2, windowSeconds: 60 };

  test('two addresses in the same IPv6 /64 share a rate limit budget', () => {
    const limiter = new RateLimiter();
    const now = 1_000_000;

    const key1 = rateLimitKey('auth', '2001:db8:abcd:12::1');
    const key2 = rateLimitKey('auth', '2001:db8:abcd:12:dead:beef::99');

    expect(key1).toBe(key2);

    const first = limiter.check(key1, config, now);
    expect(first.allowed).toBe(true);

    const second = limiter.check(key2, config, now + 100);
    expect(second.allowed).toBe(true);

    const third = limiter.check(key1, config, now + 200);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterSeconds).toBeGreaterThan(0);
  });

  test('addresses in different IPv6 /64s do not share a budget', () => {
    const limiter = new RateLimiter();
    const now = 1_000_000;

    const key1 = rateLimitKey('auth', '2001:db8:abcd:12::1');
    const key2 = rateLimitKey('auth', '2001:db8:abcd:13::1');

    expect(key1).not.toBe(key2);

    expect(limiter.check(key1, config, now).allowed).toBe(true);
    expect(limiter.check(key1, config, now).allowed).toBe(true);
    expect(limiter.check(key1, config, now).allowed).toBe(false);

    expect(limiter.check(key2, config, now).allowed).toBe(true);
    expect(limiter.check(key2, config, now).allowed).toBe(true);
  });

  test('distinct IPv4 addresses do not share a budget', () => {
    const limiter = new RateLimiter();
    const now = 1_000_000;

    const key1 = rateLimitKey('auth', '198.51.100.1');
    const key2 = rateLimitKey('auth', '198.51.100.2');

    expect(limiter.check(key1, config, now).allowed).toBe(true);
    expect(limiter.check(key1, config, now).allowed).toBe(true);
    expect(limiter.check(key1, config, now).allowed).toBe(false);

    expect(limiter.check(key2, config, now).allowed).toBe(true);
  });

  test('IPv4-mapped IPv6 shares budget with direct IPv4', () => {
    const limiter = new RateLimiter();
    const now = 1_000_000;

    const keyV4 = rateLimitKey('auth', '192.0.2.1');
    const keyMapped = rateLimitKey('auth', '::ffff:192.0.2.1');

    expect(keyV4).toBe(keyMapped);

    expect(limiter.check(keyV4, config, now).allowed).toBe(true);
    expect(limiter.check(keyMapped, config, now).allowed).toBe(true);
    expect(limiter.check(keyV4, config, now).allowed).toBe(false);
  });

  test('expired windows are evicted on routine sweep', () => {
    const limiter = new RateLimiter({ sweepInterval: 3, maxEntries: 100 });
    const now = 1_000_000;

    limiter.check('key-a', config, now);
    limiter.check('key-b', config, now);
    expect(limiter.size).toBe(2);

    const future = now + 70 * 1000;
    // Third check triggers periodic sweep at sweepInterval = 3
    limiter.check('key-c', config, future);

    expect(limiter.size).toBe(1);
    expect(limiter.peek('key-a', config, future).allowed).toBe(true);
  });

  test('peek removes expired windows inline', () => {
    const limiter = new RateLimiter();
    const now = 1_000_000;

    limiter.check('k1', config, now);
    expect(limiter.size).toBe(1);

    const verdict = limiter.peek('k1', config, now + 70 * 1000);
    expect(verdict.allowed).toBe(true);
    expect(limiter.size).toBe(0);
  });

  test('capacity cap strictly bounds map size under rotated keys', () => {
    const limiter = new RateLimiter({ maxEntries: 5, sweepInterval: 1000 });
    const now = 1_000_000;

    for (let i = 0; i < 20; i++) {
      limiter.check(`key-${i}`, config, now);
      expect(limiter.size).toBeLessThanOrEqual(5);
    }

    expect(limiter.size).toBe(5);
    // Oldest unexpired keys should have been evicted to maintain bound
    expect(limiter.peek('key-0', config, now).allowed).toBe(true);
    expect(limiter.peek('key-19', config, now).allowed).toBe(true);
  });
});

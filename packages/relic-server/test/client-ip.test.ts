import { describe, expect, test } from 'bun:test';
import { clientIp } from '../src/app.ts';
import {
  assertConfig,
  DEFAULT_CONFIG,
  type RelicConfig,
} from '../src/config.ts';

describe('clientIp extraction', () => {
  const lbConfig: RelicConfig = {
    ...DEFAULT_CONFIG,
    trustedProxyHops: 2,
  };

  const cloudRunConfig: RelicConfig = {
    ...DEFAULT_CONFIG,
    trustedProxyHops: 1,
  };

  const localDevConfig: RelicConfig = {
    ...DEFAULT_CONFIG,
    trustedProxyHops: 0,
  };

  describe('external load balancer topology (2 hops from right)', () => {
    test('extracts client IP when exact 2 hops are present', () => {
      const request = new Request('https://relic.example/api/challenge', {
        headers: {
          'x-forwarded-for': '198.51.100.10, 130.211.0.1',
        },
      });
      expect(clientIp(request, lbConfig)).toBe('198.51.100.10');
    });

    test('ignores spoofed leading entries and extracts trusted hop', () => {
      const request = new Request('https://relic.example/api/challenge', {
        headers: {
          'x-forwarded-for':
            '203.0.113.195, 10.0.0.1, 198.51.100.10, 130.211.0.1',
        },
      });
      expect(clientIp(request, lbConfig)).toBe('198.51.100.10');
    });

    test('trims whitespace around entries', () => {
      const request = new Request('https://relic.example/api/challenge', {
        headers: {
          'x-forwarded-for':
            '  203.0.113.195 ,   198.51.100.10   ,  130.211.0.1  ',
        },
      });
      expect(clientIp(request, lbConfig)).toBe('198.51.100.10');
    });

    test('falls back when fewer hops than trusted count are present', () => {
      const request = new Request('https://relic.example/api/challenge', {
        headers: {
          'x-forwarded-for': '203.0.113.195',
        },
      });
      expect(clientIp(request, lbConfig)).toBe('127.0.0.1');
    });

    test('falls back to x-real-ip when fewer hops than trusted count are present', () => {
      const request = new Request('https://relic.example/api/challenge', {
        headers: {
          'x-forwarded-for': '203.0.113.195',
          'x-real-ip': '192.0.2.1',
        },
      });
      expect(clientIp(request, lbConfig)).toBe('192.0.2.1');
    });

    test('falls back to 127.0.0.1 when no proxy headers exist', () => {
      const request = new Request('https://relic.example/api/challenge');
      expect(clientIp(request, lbConfig)).toBe('127.0.0.1');
    });

    test('falls back to x-real-ip when x-forwarded-for is missing', () => {
      const request = new Request('https://relic.example/api/challenge', {
        headers: {
          'x-real-ip': '192.0.2.55',
        },
      });
      expect(clientIp(request, lbConfig)).toBe('192.0.2.55');
    });

    test('extracts full IPv6 address from proxy headers without truncating', () => {
      const ipv6 = '2001:db8:abcd:12:dead:beef:1234:5678';
      const request = new Request('https://relic.example/api/challenge', {
        headers: {
          'x-forwarded-for': `${ipv6}, 130.211.0.1`,
        },
      });
      expect(clientIp(request, lbConfig)).toBe(ipv6);
    });
  });

  describe('direct Cloud Run topology (1 hop from right)', () => {
    test('extracts client IP when exact 1 hop is present', () => {
      const request = new Request('https://relic.example/api/challenge', {
        headers: {
          'x-forwarded-for': '198.51.100.10',
        },
      });
      expect(clientIp(request, cloudRunConfig)).toBe('198.51.100.10');
    });

    test('ignores spoofed leading entries and extracts rightmost hop', () => {
      const request = new Request('https://relic.example/api/challenge', {
        headers: {
          'x-forwarded-for': '203.0.113.195, 198.51.100.10',
        },
      });
      expect(clientIp(request, cloudRunConfig)).toBe('198.51.100.10');
    });
  });

  describe('local/dev topology (0 trusted proxy hops)', () => {
    test('falls back to 127.0.0.1 without proxy headers', () => {
      const request = new Request('https://relic.example/api/challenge');
      expect(clientIp(request, localDevConfig)).toBe('127.0.0.1');
    });

    test('uses x-real-ip when available', () => {
      const request = new Request('https://relic.example/api/challenge', {
        headers: {
          'x-real-ip': '192.0.2.99',
        },
      });
      expect(clientIp(request, localDevConfig)).toBe('192.0.2.99');
    });

    test('ignores caller-supplied x-forwarded-for when no proxy is trusted', () => {
      const request = new Request('https://relic.example/api/challenge', {
        headers: {
          'x-forwarded-for': '203.0.113.195, 198.51.100.10',
        },
      });
      expect(clientIp(request, localDevConfig)).toBe('127.0.0.1');
    });
  });

  describe('assertConfig validation', () => {
    test('rejects negative trustedProxyHops', () => {
      expect(() =>
        assertConfig({
          ...DEFAULT_CONFIG,
          trustedProxyHops: -1,
        })
      ).toThrow('trustedProxyHops must be a non-negative integer');
    });

    test('rejects non-integer trustedProxyHops', () => {
      expect(() =>
        assertConfig({
          ...DEFAULT_CONFIG,
          trustedProxyHops: 1.5,
        })
      ).toThrow('trustedProxyHops must be a non-negative integer');
    });

    test('rejects non-positive or non-integer limiterMaxEntries', () => {
      expect(() =>
        assertConfig({
          ...DEFAULT_CONFIG,
          limiterMaxEntries: 0,
        })
      ).toThrow('limiterMaxEntries must be a positive integer');

      expect(() =>
        assertConfig({
          ...DEFAULT_CONFIG,
          limiterMaxEntries: -10,
        })
      ).toThrow('limiterMaxEntries must be a positive integer');

      expect(() =>
        assertConfig({
          ...DEFAULT_CONFIG,
          limiterMaxEntries: 10.5,
        })
      ).toThrow('limiterMaxEntries must be a positive integer');
    });

    test('rejects non-positive or non-integer limiterSweepInterval', () => {
      expect(() =>
        assertConfig({
          ...DEFAULT_CONFIG,
          limiterSweepInterval: 0,
        })
      ).toThrow('limiterSweepInterval must be a positive integer');

      expect(() =>
        assertConfig({
          ...DEFAULT_CONFIG,
          limiterSweepInterval: -5,
        })
      ).toThrow('limiterSweepInterval must be a positive integer');

      expect(() =>
        assertConfig({
          ...DEFAULT_CONFIG,
          limiterSweepInterval: 5.5,
        })
      ).toThrow('limiterSweepInterval must be a positive integer');
    });
  });
});

import { describe, expect, test } from 'bun:test';
import {
  describeLinkRequest,
  LINK_COOLDOWN_MS,
  LINK_READ_DELAY_MS,
  LINK_TIMEOUT_MS,
  type LinkDestination,
  LinkConfirmGate,
} from '../src/open-link-confirm.ts';

describe('describeLinkRequest', () => {
  test('shows an https, http or mailto destination as the address that opens', () => {
    expect(describeLinkRequest('https://example.com/report?x=1#top')).toEqual({
      href: 'https://example.com/report?x=1#top',
      scheme: 'https:',
      host: 'example.com',
      rest: '/report?x=1#top',
    });
    expect(describeLinkRequest('http://example.com:8080/')?.host).toBe(
      'example.com:8080'
    );
    expect(
      describeLinkRequest('mailto:press@example.com?subject=Relic%20question')
    ).toEqual({
      href: 'mailto:press@example.com?subject=Relic%20question',
      scheme: 'mailto:',
      host: 'press@example.com',
      rest: '?subject=Relic%20question',
    });
  });

  test('shows an internationalised host in punycode, as the browser opens it', () => {
    expect(describeLinkRequest('https://bücher.example/katalog')?.host).toBe(
      'xn--bcher-kva.example'
    );
  });

  test('refuses every scheme the frame boundary does not allow', () => {
    for (const href of [
      'javascript:alert(1)',
      'data:text/html,hi',
      'file:///etc/passwd',
      'blob:https://example.com/x',
      'ftp://example.com/',
      '/relative/path',
      '#fragment',
      '',
    ]) {
      expect(describeLinkRequest(href)).toBeUndefined();
    }
  });

  test('refuses a URL with credentials, so the host shown is the host that opens', () => {
    expect(
      describeLinkRequest('https://bank.example@evil.example/login')
    ).toBeUndefined();
    expect(describeLinkRequest('https://user:pw@example.com/')).toBeUndefined();
  });

  test('refuses anything over the length cap, and anything that is not a string', () => {
    expect(
      describeLinkRequest(`https://example.com/${'a'.repeat(8 * 1024)}`)
    ).toBeUndefined();
    expect(describeLinkRequest(42)).toBeUndefined();
    expect(describeLinkRequest(undefined)).toBeUndefined();
  });

  test('keeps markup in an address as text', () => {
    const destination = describeLinkRequest(
      'https://docs.example.com/<img src=x onerror=alert(1)>'
    );
    expect(destination?.href).toBe(
      'https://docs.example.com/%3Cimg%20src=x%20onerror=alert(1)%3E'
    );
    expect(destination?.rest).not.toContain('<');
  });
});

describe('LinkConfirmGate', () => {
  const first: LinkDestination = {
    href: 'https://example.com/a',
    scheme: 'https:',
    host: 'example.com',
    rest: '/a',
  };
  const second: LinkDestination = {
    href: 'https://example.org/b',
    scheme: 'https:',
    host: 'example.org',
    rest: '/b',
  };

  const clock = () => {
    let now = 1_000_000;
    return {
      now: () => now,
      advance: (ms: number) => {
        now += ms;
      },
    };
  };

  test('holds Open link until the read delay has passed, then confirms once', () => {
    const time = clock();
    const gate = new LinkConfirmGate(time.now);
    expect(gate.request(first)).toEqual({ kind: 'shown', destination: first });
    expect(gate.canOpen()).toBe(false);
    expect(gate.confirm()).toBeUndefined();
    time.advance(LINK_READ_DELAY_MS);
    expect(gate.canOpen()).toBe(true);
    expect(gate.confirm()).toEqual(first);
    expect(gate.pending).toBeUndefined();
    expect(gate.confirm()).toBeUndefined();
  });

  test('drops and counts requests while one is pending', () => {
    const time = clock();
    const gate = new LinkConfirmGate(time.now);
    gate.request(first);
    expect(gate.request(second)).toEqual({ kind: 'dropped', dropped: 1 });
    expect(gate.request(second)).toEqual({ kind: 'dropped', dropped: 2 });
    expect(gate.pending).toEqual(first);
    expect(gate.dropped).toBe(2);
  });

  test('after the bar closes, the frame cannot raise another one during the cooldown', () => {
    const time = clock();
    const gate = new LinkConfirmGate(time.now);
    gate.request(first);
    gate.dismiss();
    expect(gate.request(second)).toEqual({ kind: 'dropped', dropped: 1 });
    time.advance(LINK_COOLDOWN_MS - 1);
    expect(gate.request(second)).toEqual({ kind: 'dropped', dropped: 2 });
    time.advance(1);
    expect(gate.request(second)).toEqual({
      kind: 'shown',
      destination: second,
    });
  });

  test('a bar nobody answers closes after the timeout, and closing resets the drop count', () => {
    const time = clock();
    const gate = new LinkConfirmGate(time.now);
    gate.request(first);
    gate.request(second);
    time.advance(LINK_TIMEOUT_MS - 1);
    expect(gate.expire()).toBe(false);
    time.advance(1);
    expect(gate.expire()).toBe(true);
    expect(gate.pending).toBeUndefined();
    expect(gate.dropped).toBe(0);
  });

  test('a dismissed bar confirms nothing, even after the read delay', () => {
    const time = clock();
    const gate = new LinkConfirmGate(time.now);
    gate.request(first);
    time.advance(LINK_READ_DELAY_MS);
    gate.dismiss();
    expect(gate.confirm()).toBeUndefined();
  });
});

import { describe, expect, test } from 'bun:test';
import {
  accessGrantedMail,
  accessRequestedMail,
  identityReplacedMail,
  privateActivityMail,
} from '../src/mail.ts';

const SERVICE = 'https://relic.example';

describe('private-share mail (plan 4.14, verbatim)', () => {
  test('the request mail names the requester, gives their fingerprint, and links to the request', () => {
    const requestUrl = `${SERVICE}/gdk6rpv49hftg5216ev7dejesc?access=requests&grant=0123456789abcdef0123456789abcdef`;
    const mail = accessRequestedMail({
      requesterAddress: 'reader@example.com',
      fingerprint: 'ABCD EFGH JKMN PQRS TVWX YZ01 2345 6789',
      requestUrl,
    });
    expect(mail.subject).toBe('reader@example.com asked for access to a relic');
    expect(mail.text).toBe(
      [
        'reader@example.com asked for access to a relic you own on Relic.',
        'Their fingerprint: ABCD EFGH JKMN PQRS TVWX YZ01 2345 6789',
        `Review and grant: ${requestUrl}`,
        'Open the link, check the fingerprint on the page matches the one above, and tap your passkey to grant access.',
      ].join('\n\n')
    );
    expect(mail.html).toContain(
      `<a href="${requestUrl.replace(/&/g, '&amp;')}">`
    );
  });

  // This was `carries no title and no requester address`: the request notice is the one private mail that now
  // names the requester (owner decision, 2026-11-24). It still carries no title.
  test('the request mail carries no title', () => {
    const mail = accessRequestedMail({
      requesterAddress: 'reader@example.com',
      fingerprint: 'ABCD EFGH JKMN PQRS TVWX YZ01 2345 6789',
      requestUrl: `${SERVICE}/gdk6rpv49hftg5216ev7dejesc?access=requests`,
    });
    for (const body of [mail.subject, mail.text, mail.html]) {
      expect(body.toLowerCase()).not.toContain('title');
    }
  });

  test('the request mail escapes an address that carries markup', () => {
    const mail = accessRequestedMail({
      requesterAddress: 'a"<b>@example.com',
      fingerprint: 'ABCD EFGH JKMN PQRS TVWX YZ01 2345 6789',
      requestUrl: `${SERVICE}/gdk6rpv49hftg5216ev7dejesc?access=requests`,
    });
    expect(mail.html).not.toContain('<b>');
    expect(mail.html).toContain('&lt;b&gt;');
  });

  test('the grant mail tells the reader to confirm with a passkey', () => {
    const mail = accessGrantedMail({
      relicUrl: `${SERVICE}/gdk6rpv49hftg5216ev7dejesc`,
    });
    expect(mail.subject).toBe('You have access to a relic');
    expect(mail.text).toBe(
      [
        'You can now open a relic on Relic.',
        `Open it: ${SERVICE}/gdk6rpv49hftg5216ev7dejesc`,
        "You'll confirm with your passkey.",
      ].join('\n\n')
    );
  });

  test('the activity mail is generic and carries the one-click stop link', () => {
    const stopUrl = `${SERVICE}/unsubscribe/abc`;
    const mail = privateActivityMail({
      relicUrl: `${SERVICE}/gdk6rpv49hftg5216ev7dejesc`,
      stopUrl,
    });
    expect(mail.subject).toBe('Activity on a relic');
    expect(mail.text).toContain(
      "There's new activity on a relic you follow on Relic."
    );
    expect(mail.text).toContain(`Stop these emails: ${stopUrl}`);
    expect(mail.headers?.['List-Unsubscribe']).toBe(`<${stopUrl}>`);
    expect(mail.headers?.['List-Unsubscribe-Post']).toBe(
      'List-Unsubscribe=One-Click'
    );
  });

  test('the replacement notice names the address and a UTC time, and nothing else', () => {
    const at = Date.UTC(2026, 10, 11, 9, 5);
    const mail = identityReplacedMail({ address: 'reader@example.com', at });
    expect(mail.subject).toBe('Your Relic private-share key was replaced');
    expect(mail.text.split('\n')[0]).toBe(
      'A new private-share key was set up for reader@example.com on Relic at 11 Nov 2026 at 09:05 UTC.'
    );
    expect(mail.text).toContain(
      "Relics shared with your old key can't be opened with the new one until each owner shares them again."
    );
    expect(mail.text.match(/@/g)?.length).toBe(1);
  });

  test('the HTML body escapes the link and mirrors the text', () => {
    const mail = privateActivityMail({
      relicUrl: `${SERVICE}/abc?x=<script>`,
      stopUrl: `${SERVICE}/stop`,
    });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
  });
});

describe('private-share mail: nothing is sent for a private relic that names a title', () => {
  test('a private activity mail is built without any title parameter', () => {
    const mail = privateActivityMail({
      relicUrl: `${SERVICE}/gdk6rpv49hftg5216ev7dejesc`,
      stopUrl: `${SERVICE}/stop`,
    });
    expect(mail.text).not.toMatch(/"[^"]+"/);
  });
});

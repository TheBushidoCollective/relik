import { describe, expect, test } from 'bun:test';
import {
  changeNoticeMail,
  commentNoticeMail,
  commentNotificationMail,
  MailRefusedError,
  mailerFromEnv,
  passkeyAddedMail,
  quotaWarning,
  replyNotificationMail,
  resendMailer,
  signInMail,
} from '../src/mail.ts';

const LINK = 'https://relik.link/api/auth/callback?token=abc123&next=%2Fx';

/** Captures one outbound request without a network. */
function recorder(response: Response): {
  readonly calls: { url: string; init: RequestInit }[];
  readonly fetch: typeof globalThis.fetch;
} {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return response;
    }) as typeof globalThis.fetch,
  };
}

function accepted(): Response {
  return new Response(JSON.stringify({ id: 'e1' }), { status: 200 });
}

describe('the quota Resend reports on an accepted send', () => {
  // Found live: a probe returned 200 with an id and a daily quota of 0. The
  // free tier pauses sending at the wall instead of refusing, so this is the
  // difference between a link that is late and a link that never comes.
  const headers = (values: Record<string, string>): Pick<Headers, 'get'> => ({
    get: (name: string) => values[name.toLowerCase()] ?? null,
  });

  test('a spent daily quota says the link will not arrive', () => {
    const said = quotaWarning(headers({ 'x-resend-daily-quota': '0' }));
    expect(said).toContain('spent');
    expect(said).toContain('will not arrive');
  });

  test('a nearly spent quota warns before the wall, not at it', () => {
    const said = quotaWarning(headers({ 'x-resend-daily-quota': '3' }));
    expect(said).toContain('nearly spent');
    expect(said).toContain('daily 3');
  });

  test('headroom says nothing at all', () => {
    expect(
      quotaWarning(
        headers({
          'x-resend-daily-quota': '90',
          'x-resend-monthly-quota': '2900',
        })
      )
    ).toBeUndefined();
  });

  test('a monthly wall counts even with daily headroom', () => {
    const said = quotaWarning(
      headers({ 'x-resend-daily-quota': '90', 'x-resend-monthly-quota': '0' })
    );
    expect(said).toContain('spent');
    expect(said).toContain('monthly 0');
    expect(said).not.toContain('daily');
  });

  test('absent or unparseable headers are not a warning', () => {
    expect(quotaWarning(headers({}))).toBeUndefined();
    expect(
      quotaWarning(headers({ 'x-resend-daily-quota': 'unknown' }))
    ).toBeUndefined();
  });

  test('an accepted send at the wall logs, and still succeeds', async () => {
    const said: string[] = [];
    const wire = recorder(
      new Response(JSON.stringify({ id: 'e1' }), {
        status: 200,
        headers: { 'x-resend-daily-quota': '0' },
      })
    );
    await resendMailer({
      apiKey: 're_test_key',
      from: 'no-reply@relik.link',
      fetch: wire.fetch,
      log: (message) => said.push(message),
    }).send('ada@example.com', LINK, '482913');

    // Not an error: Resend took it. The reader still gets nothing, and that
    // is what the line has to say.
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('quota is spent');
  });
});

describe('the sign-in mail', () => {
  test('the code and the link are the message, in both parts', () => {
    const mail = signInMail(LINK, '482913');
    expect(mail.subject).toBe('482913 is your Relic sign-in code');
    expect(mail.text).toContain('482913');
    expect(mail.html).toContain('482913');
    expect(mail.text).toContain(LINK);
    // Single use and expiring is the part a recipient needs, and the part that
    // makes an unexpected message safe to ignore.
    expect(mail.text).toContain('single use');
    expect(mail.text).toContain('did not ask');
  });

  test('the link is escaped into the markup, not pasted into it', () => {
    // A token is service-generated, and it is still interpolated into markup
    // that a mail client renders.
    const mail = signInMail(
      'https://relik.link/cb?a=1&b="><script>x</script>',
      '482913'
    );
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&amp;');
    expect(mail.html).toContain('&quot;');
  });

  test('the Resend mailer refuses a sign-in send that has no code, rather than inventing one', async () => {
    const requests: unknown[] = [];
    const mailer = resendMailer({
      apiKey: 'key',
      from: 'Relic <relic@example.com>',
      fetch: (async (_url, init) => {
        requests.push(init);
        return new Response('{}', { status: 200 });
      }) as typeof globalThis.fetch,
    });
    await expect(mailer.send('a@example.com', LINK)).rejects.toThrow(
      'needs the code'
    );
    expect(requests).toHaveLength(0);
  });
});
describe('the comment notification mail', () => {
  test('names the title and commenter when title is present', () => {
    const mail = commentNotificationMail(
      'Q3 Strategy Brief',
      'ada@example.com'
    );
    expect(mail.subject).toBe('New comment on "Q3 Strategy Brief"');
    expect(mail.text).toContain(
      'ada@example.com left a comment on "Q3 Strategy Brief".'
    );
    expect(mail.text).toContain(
      'Open the link you hold for this relic to read and answer the comment.'
    );
    expect(mail.text).toContain('Relic does not store the decryption key');
    expect(mail.html).toContain('ada@example.com');
    expect(mail.html).toContain('<strong>Q3 Strategy Brief</strong>');
    expect(mail.html).toContain('Relic does not store the decryption key');
  });

  test('uses fallback phrasing when title is absent', () => {
    const mail = commentNotificationMail(undefined, 'ada@example.com');
    expect(mail.subject).toBe('New comment on your relic');
    expect(mail.text).toContain(
      'ada@example.com left a comment on your relic.'
    );
    expect(mail.html).toContain('your relic');
  });

  test('escapes HTML in title and commenter', () => {
    const mail = commentNotificationMail(
      '<script>alert("xss")</script>',
      'b"o&b<x>@example.com'
    );
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.html).toContain('&amp;');
    expect(mail.html).toContain('&quot;');
  });

  test('carries no comment body, no fragment, and no key', () => {
    const mail = commentNotificationMail('Notes', 'ada@example.com');
    expect(mail.text).not.toContain('#');
    expect(mail.html).not.toContain('#');
    expect(mail.text).not.toContain('comment_id');
    expect(mail.html).not.toContain('comment_id');
    expect(mail.html).not.toContain('comment_id');
  });

  test('carries relic link, stop link, and List-Unsubscribe headers when provided', () => {
    const stopUrl =
      'https://relic.example/api/relics/r1/unsubscribe?addr=h&token=t';
    const mail = commentNotificationMail({
      title: 'Notes',
      commenter: 'ada@example.com',
      relicUrl: 'https://relic.example/r1',
      stopUrl,
    });
    expect(mail.text).toContain('https://relic.example/r1');
    expect(mail.text).toContain(stopUrl);
    expect(mail.html).toContain('https://relic.example/r1');
    expect(mail.html).toContain(stopUrl.replace('&', '&amp;'));
    expect(mail.headers).toEqual({
      'List-Unsubscribe': `<${stopUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });
});

describe('the reply notification mail', () => {
  test('names the title and replier when title is present', () => {
    const mail = replyNotificationMail('Q3 Strategy Brief', 'publisher');
    expect(mail.subject).toBe(
      'Your comment on "Q3 Strategy Brief" was answered'
    );
    expect(mail.text).toContain(
      'publisher answered your comment on "Q3 Strategy Brief".'
    );
    expect(mail.text).toContain(
      'Open the link you hold for this relic to read the reply.'
    );
    expect(mail.html).toContain('publisher');
    expect(mail.html).toContain('<strong>Q3 Strategy Brief</strong>');
  });

  test('uses fallback phrasing when title is absent', () => {
    const mail = replyNotificationMail(undefined, 'bob@example.com');
    expect(mail.subject).toBe('Your comment on a relic was answered');
    expect(mail.text).toContain(
      'bob@example.com answered your comment on a relic.'
    );
    expect(mail.html).toContain('a relic');
  });

  test('escapes HTML in title and replier', () => {
    const mail = replyNotificationMail(
      '<img src=x onerror=1>',
      'bob<script>@example.com'
    );
    expect(mail.html).not.toContain('<img');
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;img');
  });

  test('carries no comment body, no fragment, and no key', () => {
    const mail = replyNotificationMail('Notes', 'bob@example.com');
    expect(mail.text).not.toContain('#');
    expect(mail.html).not.toContain('#');
    expect(mail.text).not.toContain('comment_id');
    expect(mail.html).not.toContain('comment_id');
    expect(mail.html).not.toContain('comment_id');
  });

  test('carries relic link, stop link, and List-Unsubscribe headers when provided', () => {
    const stopUrl =
      'https://relic.example/api/relics/r1/unsubscribe?addr=h&token=t';
    const mail = replyNotificationMail({
      title: 'Notes',
      replier: 'The publisher',
      relicUrl: 'https://relic.example/r1',
      stopUrl,
    });
    expect(mail.text).toContain('The publisher answered your comment');
    expect(mail.text).toContain('https://relic.example/r1');
    expect(mail.text).toContain(stopUrl);
    expect(mail.headers).toEqual({
      'List-Unsubscribe': `<${stopUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });
});

describe('the comment notice mail', () => {
  test('copy with and without a title, for each reason and commenter', () => {
    const withTitleCommented = commentNoticeMail({
      title: 'Quarterly Plan',
      commenter: 'alice@example.com',
      relicUrl: 'https://relic.example/r1',
      stopUrl: 'https://relic.example/stop1',
      reason: 'commented',
    });
    expect(withTitleCommented.subject).toBe('New comment on "Quarterly Plan"');
    expect(withTitleCommented.text).toContain(
      'alice@example.com left a comment on "Quarterly Plan".'
    );
    expect(withTitleCommented.text).toContain(
      'You are getting this because you commented on this relic.'
    );
    expect(withTitleCommented.html).toContain(
      '<p>alice@example.com left a comment on "Quarterly Plan".</p>'
    );
    expect(withTitleCommented.html).toContain(
      '<a href="https://relic.example/r1">https://relic.example/r1</a>'
    );
    expect(withTitleCommented.headers).toEqual({
      'List-Unsubscribe': '<https://relic.example/stop1>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });

    const untitledPublisher = commentNoticeMail({
      title: undefined,
      commenter: 'The publisher',
      relicUrl: 'https://relic.example/r2',
      stopUrl: 'https://relic.example/stop2',
      reason: 'shared',
      sharedBy: 'publisher',
    });
    expect(untitledPublisher.subject).toBe('New comment on a relic');
    expect(untitledPublisher.text).toContain(
      'The publisher left a comment on a relic.'
    );
    expect(untitledPublisher.text).toContain(
      'the person who published this relic shared it with you'
    );

    const sharedReader = commentNoticeMail({
      title: 'Project',
      commenter: 'bob@example.com',
      relicUrl: 'https://relic.example/r3',
      stopUrl: 'https://relic.example/stop3',
      reason: 'shared',
      sharedBy: 'reader',
    });
    expect(sharedReader.text).toContain(
      "someone with this relic's link shared it with you"
    );

    const ownerReason = commentNoticeMail({
      title: 'Project',
      commenter: 'carol@example.com',
      relicUrl: 'https://relic.example/r4',
      stopUrl: 'https://relic.example/stop4',
      reason: 'owner',
    });
    expect(ownerReason.text).toContain('you are its owner');
  });

  test('carries no comment body, no fragment, and no key', () => {
    const mail = commentNoticeMail({
      title: 'Secret Spec',
      commenter: 'alice@example.com',
      relicUrl: 'https://relic.example/r1',
      stopUrl: 'https://relic.example/stop',
      reason: 'commented',
    });
    expect(mail.text).not.toContain('#');
    expect(mail.html).not.toContain('#');
    expect(mail.text).not.toContain('comment_id');
    expect(mail.html).not.toContain('comment_id');
  });

  test('escapes HTML in title and commenter', () => {
    const mail = commentNoticeMail({
      title: '<script>alert("x")</script>',
      commenter: 'user"name<x>@example.com',
      relicUrl: 'https://relic.example/r1',
      stopUrl: 'https://relic.example/stop',
      reason: 'commented',
    });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.html).toContain('&quot;');
  });
});

describe('the change notice mail', () => {
  test('copy with and without a title, for both reasons', () => {
    const withTitleCommented = changeNoticeMail({
      title: 'Quarterly Numbers',
      version: 2,
      relicUrl: 'https://relic.example/r1',
      stopUrl: 'https://relic.example/api/relics/r1/unsubscribe?addr=a&token=t',
      reason: 'commented',
    });
    expect(withTitleCommented.subject).toBe(
      'New version of "Quarterly Numbers"'
    );
    expect(withTitleCommented.text).toContain(
      '"Quarterly Numbers" has a new version: version 2.'
    );
    expect(withTitleCommented.text).toContain(
      'You are getting this because you commented on this relic.'
    );
    expect(withTitleCommented.html).toContain(
      '<p>"Quarterly Numbers" has a new version: version 2.</p>'
    );
    expect(withTitleCommented.html).toContain(
      '<a href="https://relic.example/r1">https://relic.example/r1</a>'
    );

    const untitledCommented = changeNoticeMail({
      title: undefined,
      version: 3,
      relicUrl: 'https://relic.example/r2',
      stopUrl: 'https://relic.example/api/relics/r2/unsubscribe?addr=b&token=u',
      reason: 'commented',
    });
    expect(untitledCommented.subject).toBe('New version of a relic');
    expect(untitledCommented.text).toContain(
      'A relic has a new version: version 3.'
    );
    expect(untitledCommented.text).toContain(
      'You are getting this because you commented on this relic.'
    );
    expect(untitledCommented.html).toContain(
      '<p>A relic has a new version: version 3.</p>'
    );

    const withTitleSharedPublisher = changeNoticeMail({
      title: 'Quarterly Numbers',
      version: 2,
      relicUrl: 'https://relic.example/r1',
      stopUrl: 'https://relic.example/api/relics/r1/unsubscribe?addr=a&token=t',
      reason: 'shared',
      sharedBy: 'publisher',
    });
    expect(withTitleSharedPublisher.text).toContain(
      'You are getting this because the person who published this relic shared it with you.'
    );
    expect(withTitleSharedPublisher.html).toContain(
      'You are getting this because the person who published this relic shared it with you.'
    );

    const withTitleSharedReader = changeNoticeMail({
      title: 'Quarterly Numbers',
      version: 2,
      relicUrl: 'https://relic.example/r1',
      stopUrl: 'https://relic.example/api/relics/r1/unsubscribe?addr=a&token=t',
      reason: 'shared',
      sharedBy: 'reader',
    });
    expect(withTitleSharedReader.text).toContain(
      "You are getting this because someone with this relic's link shared it with you."
    );
    expect(withTitleSharedReader.html).toContain(
      "You are getting this because someone with this relic's link shared it with you."
    );
    const withTitleOwner = changeNoticeMail({
      title: 'Quarterly Numbers',
      version: 2,
      relicUrl: 'https://relic.example/r1',
      stopUrl: 'https://relic.example/api/relics/r1/unsubscribe?addr=a&token=t',
      reason: 'owner',
    });
    expect(withTitleOwner.text).toContain(
      'You are getting this because you are its owner.'
    );
    expect(withTitleOwner.html).toContain(
      'You are getting this because you are its owner.'
    );
  });

  test('the title is HTML-escaped', () => {
    const mail = changeNoticeMail({
      title: '<script>alert("xss")</script>',
      version: 2,
      relicUrl: 'https://relic.example/r1',
      stopUrl: 'https://relic.example/api/relics/r1/unsubscribe?addr=a&token=t',
      reason: 'commented',
    });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
  });

  test('no U+2014 or U+2013 in the output', () => {
    const mail = changeNoticeMail({
      title: 'Document',
      version: 2,
      relicUrl: 'https://relic.example/r1',
      stopUrl: 'https://relic.example/api/relics/r1/unsubscribe?addr=a&token=t',
      reason: 'shared',
      sharedBy: 'reader',
    });
    expect(mail.subject).not.toMatch(/[\u2013\u2014]/);
    expect(mail.text).not.toMatch(/[\u2013\u2014]/);
    expect(mail.html).not.toMatch(/[\u2013\u2014]/);
  });

  test('the headers are present', () => {
    const stopUrl =
      'https://relic.example/api/relics/r1/unsubscribe?addr=a&token=t';
    const mail = changeNoticeMail({
      title: 'Document',
      version: 2,
      relicUrl: 'https://relic.example/r1',
      stopUrl,
      reason: 'commented',
    });
    expect(mail.headers).toEqual({
      'List-Unsubscribe': `<${stopUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });
});

describe('the passkey-added mail', () => {
  const timestamp = Date.parse('2026-10-25T14:03:07Z');

  test('exact subject, text and HTML for both variants, at 2026-10-25T14:03:07Z', () => {
    const firstMail = passkeyAddedMail({
      address: 'ada@example.com',
      at: timestamp,
      first: true,
      passkeys: 1,
    });
    expect(firstMail.subject).toBe(
      'A passkey was added for your address on Relic'
    );
    expect(firstMail.text).toBe(
      'A passkey was added for ada@example.com on 25 Oct 2026 at 14:03 UTC.\n\n' +
        'It signs in to Relic as this address without a link, and it confirms decisions. This address has 1 passkey.\n\n' +
        'If you added it, you can ignore this message.\n\n' +
        'If you did not, whoever added it can read this mailbox, or used a browser that had just signed in with a link or code sent here. Relic has no way to remove a passkey.'
    );
    expect(firstMail.html).toBe(
      '<p>A passkey was added for ada@example.com on 25 Oct 2026 at 14:03 UTC.</p>' +
        '<p>It signs in to Relic as this address without a link, and it confirms decisions. This address has 1 passkey.</p>' +
        '<p>If you added it, you can ignore this message.</p>' +
        '<p>If you did not, whoever added it can read this mailbox, or used a browser that had just signed in with a link or code sent here. Relic has no way to remove a passkey.</p>'
    );

    const secondMail = passkeyAddedMail({
      address: 'ada@example.com',
      at: timestamp,
      first: false,
      passkeys: 2,
    });
    expect(secondMail.subject).toBe(
      'A passkey was added for your address on Relic'
    );
    expect(secondMail.text).toBe(
      'A passkey was added for ada@example.com on 25 Oct 2026 at 14:03 UTC.\n\n' +
        'It signs in to Relic as this address without a link, and it confirms decisions. A passkey this address already had confirmed it. This address has 2 passkeys.\n\n' +
        'If you added it, you can ignore this message.\n\n' +
        'If you did not, whoever added it could use a passkey this address already had. Relic has no way to remove a passkey.'
    );
    expect(secondMail.html).toBe(
      '<p>A passkey was added for ada@example.com on 25 Oct 2026 at 14:03 UTC.</p>' +
        '<p>It signs in to Relic as this address without a link, and it confirms decisions. A passkey this address already had confirmed it. This address has 2 passkeys.</p>' +
        '<p>If you added it, you can ignore this message.</p>' +
        '<p>If you did not, whoever added it could use a passkey this address already had. Relic has no way to remove a passkey.</p>'
    );
  });

  test('singular and plural passkey counts', () => {
    const oneMail = passkeyAddedMail({
      address: 'bob@example.com',
      at: timestamp,
      first: false,
      passkeys: 1,
    });
    expect(oneMail.text).toContain('This address has 1 passkey.');
    expect(oneMail.html).toContain('This address has 1 passkey.');

    const threeMail = passkeyAddedMail({
      address: 'bob@example.com',
      at: timestamp,
      first: false,
      passkeys: 3,
    });
    expect(threeMail.text).toContain('This address has 3 passkeys.');
    expect(threeMail.html).toContain('This address has 3 passkeys.');
  });

  test('an address containing < is escaped in HTML', () => {
    const mail = passkeyAddedMail({
      address: 'reader<script>@example.com',
      at: timestamp,
      first: true,
      passkeys: 1,
    });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('reader&lt;script&gt;@example.com');
    expect(mail.text).toContain('reader<script>@example.com');
  });

  test('headers is undefined', () => {
    const mail = passkeyAddedMail({
      address: 'ada@example.com',
      at: timestamp,
      first: true,
      passkeys: 1,
    });
    expect(mail.headers).toBeUndefined();
  });

  test('no U+2014 or U+2013 in the output', () => {
    for (const first of [true, false]) {
      const mail = passkeyAddedMail({
        address: 'ada@example.com',
        at: timestamp,
        first,
        passkeys: 2,
      });
      expect(mail.subject).not.toMatch(/[\u2013\u2014]/);
      expect(mail.text).not.toMatch(/[\u2013\u2014]/);
      expect(mail.html).not.toMatch(/[\u2013\u2014]/);
    }
  });
});

describe('sending through Resend', () => {
  test('the request is the documented one', async () => {
    const wire = recorder(accepted());
    await resendMailer({
      apiKey: 're_test_key',
      from: 'Relic <no-reply@relik.link>',
      fetch: wire.fetch,
    }).send('ada@example.com', LINK, '482913');

    const call = wire.calls[0];
    if (call === undefined) throw new Error('nothing was sent');
    expect(call.url).toBe('https://api.resend.com/emails');
    expect(call.init.method).toBe('POST');

    const headers = call.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer re_test_key');
    // Resend answers 403 to a request with no user agent, which reads exactly
    // like a bad key. Omitting it costs an afternoon.
    expect(headers['user-agent']).toContain('relic/');
    expect(headers['content-type']).toBe('application/json');

    const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
    expect(body['from']).toBe('Relic <no-reply@relik.link>');
    expect(body['to']).toBe('ada@example.com');
    expect(body['subject']).toBe('482913 is your Relic sign-in code');
    expect(String(body['text'])).toContain(LINK);
    expect(String(body['html'])).toContain('href=');
  });

  test('the key is never in the body it sends', async () => {
    const wire = recorder(accepted());
    await resendMailer({
      apiKey: 're_secret_value',
      from: 'no-reply@relik.link',
      fetch: wire.fetch,
    }).send('ada@example.com', LINK, '482913');
    expect(String(wire.calls[0]?.init.body)).not.toContain('re_secret_value');
  });

  test('an unverified domain is reported as itself', async () => {
    // The refusal that will actually happen first, before DNS propagates.
    const wire = recorder(
      new Response(
        JSON.stringify({
          statusCode: 403,
          name: 'validation_error',
          message: 'The relik.link domain is not verified.',
        }),
        { status: 403 }
      )
    );
    const send = resendMailer({
      apiKey: 're_test_key',
      from: 'no-reply@relik.link',
      fetch: wire.fetch,
    }).send('ada@example.com', LINK, '482913');

    await expect(send).rejects.toBeInstanceOf(MailRefusedError);
    await send.catch((error: MailRefusedError) => {
      expect(error.status).toBe(403);
      expect(error.code).toBe('validation_error');
      // The operator has to be able to tell this from a bad key without
      // guessing, so the provider's own sentence rides along.
      expect(error.message).toContain('not verified');
    });
  });

  test('a refusal with an unreadable body is still a refusal', async () => {
    const wire = recorder(
      new Response('<html>gateway</html>', { status: 502 })
    );
    const send = resendMailer({
      apiKey: 're_test_key',
      from: 'no-reply@relik.link',
      fetch: wire.fetch,
    }).send('ada@example.com', LINK, '482913');
    await expect(send).rejects.toBeInstanceOf(MailRefusedError);
    await send.catch((error: MailRefusedError) => {
      expect(error.status).toBe(502);
      expect(error.code).toBe('unknown');
    });
  });
  test('sendMail sends custom outbound mail through the wire', async () => {
    const wire = recorder(accepted());
    const mailer = resendMailer({
      apiKey: 're_test_key',
      from: 'Relic <no-reply@relik.link>',
      fetch: wire.fetch,
    });
    const notification = commentNotificationMail('Report', 'ada@example.com');
    await mailer.sendMail?.('creator@example.com', notification);

    const call = wire.calls[0];
    if (call === undefined) throw new Error('nothing was sent');
    expect(call.url).toBe('https://api.resend.com/emails');
    const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
    expect(body['to']).toBe('creator@example.com');
    expect(body['subject']).toBe('New comment on "Report"');
    expect(String(body['text'])).toContain('ada@example.com left a comment');
  });
  test('resendMailer sends headers when given and leaves the key out otherwise', async () => {
    const wireWithHeaders = recorder(accepted());
    const mailerWithHeaders = resendMailer({
      apiKey: 're_test_key',
      from: 'Relic <no-reply@relik.link>',
      fetch: wireWithHeaders.fetch,
    });
    const notice = changeNoticeMail({
      title: 'Doc',
      version: 2,
      relicUrl: 'https://relic.example/r1',
      stopUrl: 'https://relic.example/stop',
      reason: 'commented',
    });
    await mailerWithHeaders.sendMail?.('user@example.com', notice);
    const bodyWithHeaders = JSON.parse(
      String(wireWithHeaders.calls[0]?.init.body)
    ) as Record<string, unknown>;
    expect(bodyWithHeaders['headers']).toEqual({
      'List-Unsubscribe': '<https://relic.example/stop>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });

    const wireWithoutHeaders = recorder(accepted());
    const mailerWithoutHeaders = resendMailer({
      apiKey: 're_test_key',
      from: 'Relic <no-reply@relik.link>',
      fetch: wireWithoutHeaders.fetch,
    });
    await mailerWithoutHeaders.send('user@example.com', LINK, '482913');
    const bodyWithoutHeaders = JSON.parse(
      String(wireWithoutHeaders.calls[0]?.init.body)
    ) as Record<string, unknown>;
    expect('headers' in bodyWithoutHeaders).toBe(false);
  });

  test('sendBatch posts up to 100 items to Resend batch endpoint with custom headers', async () => {
    const wire = recorder(accepted());
    const mailer = resendMailer({
      apiKey: 're_test_key',
      from: 'Relic <no-reply@relik.link>',
      fetch: wire.fetch,
    });
    const mail1 = commentNotificationMail({
      title: 'Doc 1',
      commenter: 'ada@example.com',
      relicUrl: 'https://relic.example/r1',
      stopUrl: 'https://relic.example/stop1',
    });
    const mail2 = replyNotificationMail({
      title: 'Doc 2',
      replier: 'The publisher',
      relicUrl: 'https://relic.example/r2',
      stopUrl: 'https://relic.example/stop2',
    });
    await mailer.sendBatch?.([
      { email: 'user1@example.com', mail: mail1 },
      { email: 'user2@example.com', mail: mail2 },
    ]);

    expect(wire.calls).toHaveLength(1);
    const call = wire.calls[0];
    if (call === undefined) throw new Error('nothing sent');
    expect(call.url).toBe('https://api.resend.com/emails/batch');
    const payload = JSON.parse(String(call.init.body)) as Array<
      Record<string, unknown>
    >;
    expect(payload).toHaveLength(2);
    expect(payload[0]?.['from']).toBe('Relic <no-reply@relik.link>');
    expect(payload[0]?.['to']).toEqual(['user1@example.com']);
    expect(payload[0]?.['subject']).toBe('New comment on "Doc 1"');
    expect(payload[0]?.['headers']).toEqual({
      'List-Unsubscribe': '<https://relic.example/stop1>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
    expect(payload[1]?.['to']).toEqual(['user2@example.com']);
    expect(payload[1]?.['subject']).toBe(
      'Your comment on "Doc 2" was answered'
    );
  });

  test('sendBatch handles batch API refusal', async () => {
    const wire = recorder(
      new Response(
        JSON.stringify({
          name: 'validation_error',
          message: 'The domain is not verified',
        }),
        { status: 403, headers: { 'content-type': 'application/json' } }
      )
    );
    const mailer = resendMailer({
      apiKey: 're_test_key',
      from: 'Relic <no-reply@relik.link>',
      fetch: wire.fetch,
    });
    const mail = commentNotificationMail('Doc', 'ada@example.com');
    const send = mailer.sendBatch?.([{ email: 'user@example.com', mail }]);
    await expect(send).rejects.toBeInstanceOf(MailRefusedError);
    await send?.catch((error: MailRefusedError) => {
      expect(error.status).toBe(403);
      expect(error.code).toBe('validation_error');
      expect(error.message).toContain('not verified');
    });
  });
});

describe('what the deployment gets', () => {
  test('both halves present builds a real mailer', () => {
    const said: string[] = [];
    const mailer = mailerFromEnv(
      {
        RELIC_RESEND_API_KEY: 're_test_key',
        RELIC_MAIL_FROM: 'no-reply@relik.link',
      },
      (message) => said.push(message)
    );
    expect(mailer).not.toBeUndefined();
    expect(said).toEqual([]);
  });

  test('a missing key is said out loud, and names what it costs', () => {
    // The defect this replaces: an unconfigured deployment was indistinguishable
    // from a working one, because the endpoint answers 202 either way.
    const said: string[] = [];
    const mailer = mailerFromEnv(
      { RELIC_MAIL_FROM: 'no-reply@relik.link' },
      (message) => said.push(message)
    );
    expect(mailer).toBeUndefined();
    expect(said[0]).toContain('RELIC_RESEND_API_KEY');
    expect(said[0]).toContain('202');
  });

  test('a missing from address is not papered over with a default', () => {
    // Guessing a from address means guessing a verified domain, and a wrong
    // guess is a 403 on every send.
    const said: string[] = [];
    expect(
      mailerFromEnv({ RELIC_RESEND_API_KEY: 're_test_key' }, (message) =>
        said.push(message)
      )
    ).toBeUndefined();
    expect(said[0]).toContain('RELIC_MAIL_FROM');
  });

  test('an empty string is unset, not configured', () => {
    // Terraform passes "" for an unset variable, which is the shape this will
    // actually arrive in before the flag is flipped.
    const said: string[] = [];
    expect(
      mailerFromEnv(
        { RELIC_RESEND_API_KEY: '', RELIC_MAIL_FROM: '' },
        (message) => said.push(message)
      )
    ).toBeUndefined();
    expect(said[0]).toContain('RELIC_RESEND_API_KEY');
    expect(said[0]).toContain('RELIC_MAIL_FROM');
  });
});

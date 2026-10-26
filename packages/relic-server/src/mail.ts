/**
 * Outbound mail, over Resend's HTTP API.
 *
 * One call, no SDK. The service had exactly one dependency before this and
 * still does: a `fetch` against a documented endpoint is smaller than a
 * package, and the whole surface here is a single POST.
 *
 * What this file will not do is decide that a failure is unimportant. The
 * mailer it returns throws, loudly and with the provider's own reason
 * attached, and the caller decides what a failed send costs the response.
 */
import type { BatchMailItem, Mailer } from './app.ts';

const ENDPOINT = 'https://api.resend.com/emails';
const BATCH_ENDPOINT = 'https://api.resend.com/emails/batch';
/**
 * Resend refuses a request with no `User-Agent` outright, with a 403 rather
 * than a validation error, which reads exactly like a bad key. Stated in their
 * API reference, and cheap to satisfy.
 */
const USER_AGENT = 'relic/1.0 (+https://relik.link)';

/** What Resend said when it refused, so a log line names the actual cause. */
export class MailRefusedError extends Error {
  constructor(
    readonly status: number,
    /** Resend's own error name, when the body carried one. */
    readonly code: string,
    detail: string
  ) {
    super(`resend refused with ${status} ${code}: ${detail}`);
  }
}

export interface ResendMailerOptions {
  readonly apiKey: string;
  /** `Name <address@domain>` or a bare address, on the verified domain. */
  readonly from: string;
  /** Injected so a test asserts the request without a network. */
  readonly fetch?: typeof globalThis.fetch;
  /** Injected so a test reads the warning instead of the console. */
  readonly log?: (message: string) => void;
}

export interface OutboundMail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

/**
 * The body of the sign-in mail.
 *
 * Plain text as well as HTML, deliberately. Resend will synthesize a text part
 * from the HTML if one is missing, and a synthesized part is a worse version of
 * the one sentence this message actually contains.
 *
 * The link is the whole message. No branding, no marketing, nothing that reads
 * like a newsletter, because a message that looks like an announcement is a
 * message a spam filter treats like one.
 */
export function signInMail(link: string): OutboundMail {
  const subject = 'Your Relic sign-in link';
  const text = [
    'Open this link to sign in on the relic you were reading, so you can comment on it or share it:',
    '',
    link,
    '',
    'The link is single use and expires shortly. If you did not ask to sign',
    'in, nothing has happened and you can ignore this message.',
  ].join('\n');
  // Escaping matters even here: the link carries a token this service
  // generated, but it is still interpolated into markup, and a mail client is
  // a renderer like any other.
  const href = escapeHtml(link);
  const html = [
    '<p>Open this link to sign in on the relic you were reading, so you can comment on it or share it:</p>',
    `<p><a href="${href}">${href}</a></p>`,
    '<p>The link is single use and expires shortly. If you did not ask to ',
    'sign in, nothing has happened and you can ignore this message.</p>',
  ].join('');
  return { subject, text, html };
}

/**
 * Notification sent to a relic creator when a comment arrives.
 *
 * The service holds ciphertext it cannot read and never holds the key, so this
 * message names the relic title and who commented, but cannot quote the comment
 * or provide a direct decryption link.
 */
export interface CommentNotificationMailOptions {
  readonly title: string | undefined;
  readonly commenter: string;
  readonly relicUrl?: string | undefined;
  readonly stopUrl?: string | undefined;
}

export function commentNotificationMail(
  titleOrOptions: string | undefined | CommentNotificationMailOptions,
  rawCommenter?: string,
  rawRelicUrl?: string,
  rawStopUrl?: string
): OutboundMail {
  let title: string | undefined;
  let commenter: string;
  let relicUrl: string | undefined;
  let stopUrl: string | undefined;

  if (typeof titleOrOptions === 'object' && titleOrOptions !== null) {
    title = titleOrOptions.title;
    commenter = titleOrOptions.commenter;
    relicUrl = titleOrOptions.relicUrl;
    stopUrl = titleOrOptions.stopUrl;
  } else {
    title = titleOrOptions;
    commenter = rawCommenter ?? '';
    relicUrl = rawRelicUrl;
    stopUrl = rawStopUrl;
  }

  const subject = title
    ? `New comment on "${title}"`
    : 'New comment on your relic';

  const text = [
    title
      ? `${commenter} left a comment on "${title}".`
      : `${commenter} left a comment on your relic.`,
    '',
    ...(relicUrl !== undefined
      ? [
          'Open the link you hold for this relic to read and answer the comment. If you have opened the relic in this browser before, this link works too:',
          relicUrl,
        ]
      : [
          'Open the link you hold for this relic to read and answer the comment.',
        ]),
    '',
    'Relic does not store the decryption key on its servers, so comments cannot be read from this email.',
    ...(stopUrl !== undefined
      ? ['', 'To stop emails about this relic, open:', stopUrl]
      : []),
  ].join('\n');

  const safeCommenter = escapeHtml(commenter);
  const safeTitle = title ? escapeHtml(title) : undefined;
  const safeRelicUrl = relicUrl ? escapeHtml(relicUrl) : undefined;
  const safeStopUrl = stopUrl ? escapeHtml(stopUrl) : undefined;

  const html = [
    `<p>${safeCommenter} left a comment on ${safeTitle ? `<strong>${safeTitle}</strong>` : 'your relic'}.</p>`,
    relicUrl !== undefined
      ? `<p>Open the link you hold for this relic to read and answer the comment. If you have opened the relic in this browser before, this link works too:</p><p><a href="${safeRelicUrl}">${safeRelicUrl}</a></p>`
      : '<p>Open the link you hold for this relic to read and answer the comment.</p>',
    '<p>Relic does not store the decryption key on its servers, so comments cannot be read from this email.</p>',
    stopUrl !== undefined
      ? `<p>To stop emails about this relic, open:</p><p><a href="${safeStopUrl}">${safeStopUrl}</a></p>`
      : '',
  ].join('');

  return {
    subject,
    text,
    html,
    headers:
      stopUrl !== undefined
        ? {
            'List-Unsubscribe': `<${stopUrl}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          }
        : undefined,
  };
}

/**
 * Notification sent to a commenter when their comment is answered.
 */
export interface ReplyNotificationMailOptions {
  readonly title: string | undefined;
  readonly replier: string;
  readonly relicUrl?: string | undefined;
  readonly stopUrl?: string | undefined;
}

export function replyNotificationMail(
  titleOrOptions: string | undefined | ReplyNotificationMailOptions,
  rawReplier?: string,
  rawRelicUrl?: string,
  rawStopUrl?: string
): OutboundMail {
  let title: string | undefined;
  let replier: string;
  let relicUrl: string | undefined;
  let stopUrl: string | undefined;

  if (typeof titleOrOptions === 'object' && titleOrOptions !== null) {
    title = titleOrOptions.title;
    replier = titleOrOptions.replier;
    relicUrl = titleOrOptions.relicUrl;
    stopUrl = titleOrOptions.stopUrl;
  } else {
    title = titleOrOptions;
    replier = rawReplier ?? '';
    relicUrl = rawRelicUrl;
    stopUrl = rawStopUrl;
  }

  const subject = title
    ? `Your comment on "${title}" was answered`
    : 'Your comment on a relic was answered';

  const text = [
    title
      ? `${replier} answered your comment on "${title}".`
      : `${replier} answered your comment on a relic.`,
    '',
    ...(relicUrl !== undefined
      ? [
          'Open the link you hold for this relic to read the reply. If you have opened the relic in this browser before, this link works too:',
          relicUrl,
        ]
      : ['Open the link you hold for this relic to read the reply.']),
    '',
    'Relic does not store the decryption key on its servers, so comments cannot be read from this email.',
    ...(stopUrl !== undefined
      ? ['', 'To stop emails about this relic, open:', stopUrl]
      : []),
  ].join('\n');

  const safeReplier = escapeHtml(replier);
  const safeTitle = title ? escapeHtml(title) : undefined;
  const safeRelicUrl = relicUrl ? escapeHtml(relicUrl) : undefined;
  const safeStopUrl = stopUrl ? escapeHtml(stopUrl) : undefined;

  const html = [
    `<p>${safeReplier} answered your comment on ${safeTitle ? `<strong>${safeTitle}</strong>` : 'a relic'}.</p>`,
    relicUrl !== undefined
      ? `<p>Open the link you hold for this relic to read the reply. If you have opened the relic in this browser before, this link works too:</p><p><a href="${safeRelicUrl}">${safeRelicUrl}</a></p>`
      : '<p>Open the link you hold for this relic to read the reply.</p>',
    '<p>Relic does not store the decryption key on its servers, so comments cannot be read from this email.</p>',
    stopUrl !== undefined
      ? `<p>To stop emails about this relic, open:</p><p><a href="${safeStopUrl}">${safeStopUrl}</a></p>`
      : '',
  ].join('');

  return {
    subject,
    text,
    html,
    headers:
      stopUrl !== undefined
        ? {
            'List-Unsubscribe': `<${stopUrl}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          }
        : undefined,
  };
}

/**
 * Notification sent to followers of a relic when someone leaves a comment.
 */
export interface CommentNoticeMailParams {
  readonly title: string | undefined;
  readonly commenter: string;
  readonly relicUrl: string;
  readonly stopUrl: string;
  readonly reason: 'commented' | 'shared' | 'owner';
  readonly sharedBy?: 'publisher' | 'reader' | undefined;
}

export function commentNoticeMail(p: CommentNoticeMailParams): OutboundMail {
  const subject = p.title
    ? `New comment on "${p.title}"`
    : 'New comment on a relic';

  let reasonText: string;
  if (p.reason === 'commented') {
    reasonText = 'you commented on this relic';
  } else if (p.reason === 'owner') {
    reasonText = 'you are its owner';
  } else if (p.sharedBy === 'reader') {
    reasonText = "someone with this relic's link shared it with you";
  } else {
    reasonText = 'the person who published this relic shared it with you';
  }

  const titleText = p.title ? `"${p.title}"` : 'a relic';
  const text = [
    `${p.commenter} left a comment on ${titleText}.`,
    '',
    'Open the link you were given for this relic to read the thread. If you have opened the relic in this browser before, this link works too:',
    p.relicUrl,
    '',
    'Relic never has the key that decrypts it, so this email cannot include it. If you no longer have your link, ask the person who shared it.',
    '',
    `You are getting this because ${reasonText}. To stop emails about this relic, open:`,
    p.stopUrl,
  ].join('\n');

  const safeCommenter = escapeHtml(p.commenter);
  const safeTitle = p.title ? `"${escapeHtml(p.title)}"` : 'a relic';
  const safeRelicUrl = escapeHtml(p.relicUrl);
  const safeStopUrl = escapeHtml(p.stopUrl);
  const html = [
    `<p>${safeCommenter} left a comment on ${safeTitle}.</p>`,
    '<p>Open the link you were given for this relic to read the thread. If you have opened the relic in this browser before, this link works too:</p>',
    `<p><a href="${safeRelicUrl}">${safeRelicUrl}</a></p>`,
    '<p>Relic never has the key that decrypts it, so this email cannot include it. If you no longer have your link, ask the person who shared it.</p>',
    `<p>You are getting this because ${escapeHtml(reasonText)}. To stop emails about this relic, open:</p>`,
    `<p><a href="${safeStopUrl}">${safeStopUrl}</a></p>`,
  ].join('');

  return {
    subject,
    text,
    html,
    headers: {
      'List-Unsubscribe': `<${p.stopUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

/**
 * Notification sent to followers of a relic when a new version is published.
 */
export function changeNoticeMail(p: {
  readonly title: string | undefined;
  readonly version: number;
  readonly relicUrl: string;
  readonly stopUrl: string;
  readonly reason:
    | 'commented'
    | 'shared'
    | 'shared_by_publisher'
    | 'shared_by_reader'
    | 'owner';
  readonly sharedBy?: 'publisher' | 'reader' | undefined;
}): OutboundMail {
  const subject = p.title
    ? `New version of "${p.title}"`
    : 'New version of a relic';

  let reasonText: string;
  if (p.reason === 'commented') {
    reasonText = 'you commented on this relic';
  } else if (p.reason === 'owner') {
    reasonText = 'you are its owner';
  } else if (p.sharedBy === 'reader' || p.reason === 'shared_by_reader') {
    reasonText = "someone with this relic's link shared it with you";
  } else {
    reasonText = 'the person who published this relic shared it with you';
  }

  const titleText = p.title ? `"${p.title}"` : 'A relic';
  const text = [
    `${titleText} has a new version: version ${p.version}.`,
    '',
    'Open the link you were given for this relic to read it. If you have opened the relic in this browser before, this link works too:',
    p.relicUrl,
    '',
    'Relic never has the key that decrypts it, so this email cannot include it. If you no longer have your link, ask the person who shared it.',
    '',
    `You are getting this because ${reasonText}. To stop emails about this relic, open:`,
    p.stopUrl,
  ].join('\n');

  const safeTitle = p.title ? `"${escapeHtml(p.title)}"` : 'A relic';
  const safeRelicUrl = escapeHtml(p.relicUrl);
  const safeStopUrl = escapeHtml(p.stopUrl);
  const html = [
    `<p>${safeTitle} has a new version: version ${p.version}.</p>`,
    '<p>Open the link you were given for this relic to read it. If you have opened the relic in this browser before, this link works too:</p>',
    `<p><a href="${safeRelicUrl}">${safeRelicUrl}</a></p>`,
    '<p>Relic never has the key that decrypts it, so this email cannot include it. If you no longer have your link, ask the person who shared it.</p>',
    `<p>You are getting this because ${escapeHtml(reasonText)}. To stop emails about this relic, open:</p>`,
    `<p><a href="${safeStopUrl}">${safeStopUrl}</a></p>`,
  ].join('');

  return {
    subject,
    text,
    html,
    headers: {
      'List-Unsubscribe': `<${p.stopUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

export function passkeyAddedMail(p: {
  readonly address: string;
  readonly at: number;
  readonly first: boolean;
  readonly passkeys: number;
}): OutboundMail {
  const d = new Date(p.at);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const when = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} at ${hh}:${mm} UTC`;

  const subject = 'A passkey was added for your address on Relic';

  const countText =
    p.passkeys === 1
      ? 'This address has 1 passkey.'
      : `This address has ${p.passkeys} passkeys.`;

  const paragraphs: string[] = p.first
    ? [
        `A passkey was added for ${p.address} on ${when}.`,
        `It signs in to Relic as this address without a link, and it confirms decisions. ${countText}`,
        'If you added it, you can ignore this message.',
        'If you did not, whoever added it can read this mailbox, or used a browser that had just signed in with a link sent here. Relic has no way to remove a passkey.',
      ]
    : [
        `A passkey was added for ${p.address} on ${when}.`,
        `It signs in to Relic as this address without a link, and it confirms decisions. A passkey this address already had confirmed it. ${countText}`,
        'If you added it, you can ignore this message.',
        'If you did not, whoever added it could use a passkey this address already had. Relic has no way to remove a passkey.',
      ];

  const text = paragraphs.join('\n\n');
  const html = paragraphs.map((para) => `<p>${escapeHtml(para)}</p>`).join('');

  return {
    subject,
    text,
    html,
    headers: undefined,
  };
}
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The quota Resend reports on every accepted send.
 *
 * This exists because of a failure found live: a probe send returned 200 with
 * an id and `x-resend-daily-quota: 0`. On the free tier the daily allowance is
 * a hard stop that PAUSES sending rather than refusing it, so at zero a
 * sign-in link is accepted, never delivered, and nothing in the response says
 * so. A 200 is a 200. These headers are the only warning there is.
 */
export const QUOTA_WARN_AT = 10;

/** What the headers said, and whether it is worth saying out loud. */
export function quotaWarning(
  headers: Pick<Headers, 'get'>
): string | undefined {
  const read = (name: string): number | undefined => {
    const raw = headers.get(name);
    if (raw === null) return undefined;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) ? value : undefined;
  };

  const daily = read('x-resend-daily-quota');
  const monthly = read('x-resend-monthly-quota');
  const left = [
    ...(daily !== undefined && daily <= QUOTA_WARN_AT
      ? [`daily ${daily}`]
      : []),
    ...(monthly !== undefined && monthly <= QUOTA_WARN_AT
      ? [`monthly ${monthly}`]
      : []),
  ];
  if (left.length === 0) return undefined;

  return daily === 0 || monthly === 0
    ? `relic: Resend quota is spent (${left.join(', ')} remaining). Sends ` +
        'are accepted and paused, so sign-in links will not arrive until it ' +
        'resets.'
    : `relic: Resend quota is nearly spent (${left.join(', ')} remaining). ` +
        'At zero, sends are accepted and paused rather than refused.';
}

/**
 * A mailer that actually sends.
 *
 * Resend answering 200 means Resend accepted the message, not that it arrived.
 * That distinction is real and this code cannot close it: what it can do is
 * refuse to report an acceptance it did not get.
 */
export function resendMailer(options: ResendMailerOptions): Mailer {
  const call = options.fetch ?? globalThis.fetch;

  async function post(to: string, mail: OutboundMail): Promise<void> {
    const response = await call(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.apiKey}`,
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify({
        from: options.from,
        to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        ...(mail.headers !== undefined ? { headers: mail.headers } : {}),
      }),
    });

    if (response.ok) {
      // An accepted send is not a delivered one, and this is the only place
      // the difference is visible before a reader reports it.
      const warning = quotaWarning(response.headers);
      if (warning !== undefined) (options.log ?? console.error)(warning);
      return;
    }

    // The body is the only place the reason lives. A status alone cannot
    // tell an unverified domain from a suspended key, and those are
    // different jobs for whoever reads the log.
    let code = 'unknown';
    let detail = '';
    try {
      const body = (await response.json()) as Record<string, unknown>;
      if (typeof body['name'] === 'string') code = body['name'];
      else if (typeof body['code'] === 'string') code = body['code'];
      if (typeof body['message'] === 'string') detail = body['message'];
    } catch {
      // A refusal with an unreadable body is still a refusal, and the status
      // is worth more than nothing.
    }
    throw new MailRefusedError(response.status, code, detail);
  }

  // Resend batch endpoint: https://resend.com/docs/api-reference/emails/send-batch-emails
  // Up to 100 emails per call, supporting per-email custom headers (List-Unsubscribe).
  async function postBatch(items: readonly BatchMailItem[]): Promise<void> {
    if (items.length === 0) return;
    const MAX_BATCH = 100;
    for (let i = 0; i < items.length; i += MAX_BATCH) {
      const slice = items.slice(i, i + MAX_BATCH);
      const payload = slice.map((item) => ({
        from: options.from,
        to: [item.email],
        subject: item.mail.subject,
        text: item.mail.text,
        html: item.mail.html,
        ...(item.mail.headers !== undefined
          ? { headers: item.mail.headers }
          : {}),
      }));

      const response = await call(BATCH_ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.apiKey}`,
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        const warning = quotaWarning(response.headers);
        if (warning !== undefined) (options.log ?? console.error)(warning);
        continue;
      }

      let code = 'unknown';
      let detail = '';
      try {
        const body = (await response.json()) as Record<string, unknown>;
        if (typeof body['name'] === 'string') code = body['name'];
        else if (typeof body['code'] === 'string') code = body['code'];
        if (typeof body['message'] === 'string') detail = body['message'];
      } catch {
        // A refusal with an unreadable body is still a refusal.
      }
      throw new MailRefusedError(response.status, code, detail);
    }
  }

  return {
    async send(email: string, link: string): Promise<void> {
      return post(email, signInMail(link));
    },
    async sendMail(email: string, mail: OutboundMail): Promise<void> {
      return post(email, mail);
    },
    async sendBatch(items: readonly BatchMailItem[]): Promise<void> {
      return postBatch(items);
    },
  };
}

/**
 * The mailer the deployment gets, or nothing, said out loud.
 *
 * `NULL_MAILER` exists so a deployment without mail cannot leak addresses to a
 * half-built integration. Its comment claimed the resulting failure was loud.
 * It was not: the sign-in endpoint answers 202 whether or not anything was
 * sent, on purpose, so an unconfigured deployment looks exactly like a working
 * one from the outside. This is the line that makes it loud, on the inside.
 */
export function mailerFromEnv(
  env: Record<string, string | undefined>,
  log: (message: string) => void = console.error
): Mailer | undefined {
  const apiKey = env['RELIC_RESEND_API_KEY'];
  const from = env['RELIC_MAIL_FROM'];
  if (
    apiKey !== undefined &&
    apiKey.length > 0 &&
    from !== undefined &&
    from.length > 0
  ) {
    return resendMailer({ apiKey, from });
  }

  const missing = [
    ...(apiKey === undefined || apiKey.length === 0
      ? ['RELIC_RESEND_API_KEY']
      : []),
    ...(from === undefined || from.length === 0 ? ['RELIC_MAIL_FROM'] : []),
  ];
  log(
    `relic: mail is not configured (${missing.join(', ')} unset). ` +
      'Sign-in links will not be sent, and the request endpoint will still ' +
      'answer 202, so nobody can complete a comment.'
  );
  return undefined;
}

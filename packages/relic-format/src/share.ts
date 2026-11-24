/**
 * The share proof (`spec/format.md` 3.14).
 *
 * A reader can enroll addresses in a relic's change notices from the viewer,
 * and only a holder of the key may do that. The service never sees the key,
 * so it cannot check possession directly. What it can check is a value only a
 * key holder can compute: the publisher's client registers the SHA-256 of a
 * key-derived proof when it publishes or republishes, and a reader presents
 * the proof itself when sharing. The service compares hashes and learns the
 * proof, which decrypts nothing.
 *
 * Another HKDF label off the same 16 bytes the fragment carries, for the same
 * reason the comment key is one (`comments.ts`): the fragment has no room for
 * a second secret, and a distinct label yields a value independent of the
 * content key, the nonce, and the comment key by construction.
 *
 * This package owns it because the publishing client derives the verifier and
 * the viewer derives the proof, and two definitions of either would drift into
 * a share button that is always refused.
 */

const SHARE_PROOF_INFO = new TextEncoder().encode('relic/share-proof/v1');

/** Bytes in a share proof. */
export const SHARE_PROOF_BYTES = 32;

function toBufferSource(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

/**
 * Derive a relic's share proof from the key the fragment carries.
 *
 * HKDF-SHA256, zero-length salt, `relic/share-proof/v1`, expanded to 256 bits.
 */
export async function deriveShareProof(
  keyBytes: Uint8Array
): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey(
    'raw',
    toBufferSource(keyBytes),
    'HKDF',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: SHARE_PROOF_INFO,
    },
    material,
    SHARE_PROOF_BYTES * 8
  );
  return new Uint8Array(bits);
}

/**
 * The value a publisher registers: lowercase hex SHA-256 of the proof.
 *
 * Registered rather than the proof itself so the service holds nothing a
 * sharer could replay until a sharer actually presents it.
 */
export async function shareVerifierFor(proof: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toBufferSource(proof));
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');
}

/** Who is sending a share email, which changes one sentence in it. */
export type ShareSender = 'publisher' | 'reader';

/** A share email, composed on the sharer's side and sent from their mail. */
export interface ShareEmail {
  readonly to: readonly string[];
  readonly subject: string;
  readonly text: string;
}

/**
 * Compose the email a sharer sends from their own mailbox.
 *
 * Composed here rather than by the service because it carries the whole link,
 * key included, and the service must never hold the key. One definition for
 * the publishing client and the viewer, so both say the same thing about what
 * Relic does with the recipient's address.
 */
export function composeShareEmail(p: {
  readonly url: string;
  readonly title: string | null;
  readonly to: readonly string[];
  readonly sender: ShareSender;
}): ShareEmail {
  const thing = p.title === null ? 'a file' : `"${p.title}"`;
  const subject =
    p.title === null
      ? 'A file shared with you on Relik'
      : `Shared with you: ${p.title}`;
  const next =
    p.sender === 'publisher'
      ? 'When someone comments or I publish a new version'
      : 'When someone comments or a new version is published';
  const text = [
    `I've shared ${thing} with you on Relik. Open it here:`,
    '',
    p.url,
    '',
    'Anyone with this whole link can read it, including the part after the #, which is the key that decrypts it. Relik never receives that part.',
    '',
    `${next}, Relik will email you. That email never contains the key, and it has a link to stop those emails. Relik keeps your address for that.`,
  ].join('\n');
  return { to: [...p.to], subject, text };
}

/**
 * A `mailto:` URL that opens the share email as a draft in the sharer's mail
 * app. CRLF line endings, as RFC 6068 requires in a body, and `@` left
 * readable in the recipient list.
 */
export function shareMailtoUrl(email: ShareEmail): string {
  const to = email.to
    .map((address) => encodeURIComponent(address).replace(/%40/g, '@'))
    .join(',');
  const body = encodeURIComponent(email.text.replace(/\r?\n/g, '\r\n'));
  return `mailto:${to}?subject=${encodeURIComponent(email.subject)}&body=${body}`;
}

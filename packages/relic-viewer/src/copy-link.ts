/**
 * Pure URL and key phrase helpers for the Copy link panel.
 *
 * The panel separates the full share link into a keyless link (for channels
 * where the key should not travel with the URL) and the 12-word mnemonic
 * phrase that can be shared over a second channel.
 */

import { parseFragment } from '@relic/format';

export const COPY_PANEL_TITLE = 'Link and key phrase';
export const LINK_LABEL = 'Link';
export const LINK_NOTE = 'Everything after the # is the key.';
export const COPY_LINK_LABEL = 'Copy link';
export const COPY_KEYLESS_LABEL = 'Copy without the key';
export const PHRASE_LABEL = 'Key phrase';
export const PHRASE_NOTE =
  'The same key in 12 words. Anyone who hears or reads it can open this relic.';
export const COPY_PHRASE_LABEL = 'Copy phrase';
export const SPLIT_NOTE =
  'To keep the key out of a message, send the link without the key and say the phrase. They type it in where the page asks for the key.';
export const PHRASE_LOADING_NOTE = 'Loading the key phrase.';
export const PHRASE_FAILED_NOTE =
  'The key phrase could not be loaded. The link above still works.';
export const LINK_COPIED_NOTE = 'Link copied. It contains the decryption key.';
export const KEYLESS_COPIED_NOTE =
  'Link copied without the key. Say the key phrase separately.';
export const PHRASE_COPIED_NOTE =
  'Key phrase copied. It is the decryption key.';
export const KEY_ENTRY_PROMPT =
  'If you have the key phrase or the full link for this relic, enter it here.';
export const KEY_ENTRY_LABEL = 'Key phrase or link';
export const KEY_ENTRY_PLACEHOLDER = 'The 12 words, or the whole link';

/** The same origin and path with the fragment removed, and no trailing '#'. */
export function keylessLink(shareUrl: string): string {
  const url = new URL(shareUrl);
  url.hash = '';
  const result = url.toString();
  return result.endsWith('#') ? result.slice(0, -1) : result;
}

/** The 12 words for the key in the share URL's fragment. Lazily imports the wordlist. */
export async function keyPhraseWords(
  shareUrl: string
): Promise<readonly string[]> {
  const parsed = parseFragment(new URL(shareUrl).hash);
  // Dynamic import keeps the 2048-word mnemonic wordlist out of the eager shell bundle,
  // as verified by shell-budget.test.ts. Static import would fail the shell budget test.
  const { keyToMnemonic } = await import('@relic/format/mnemonic');
  return keyToMnemonic(parsed.key);
}

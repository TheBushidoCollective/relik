/**
 * Spoken word form for a 16-byte relic key.
 *
 * Encodes a 128-bit key as 12 words from the 2048-word BIP-39 English vocabulary.
 * 128 bits of key entropy plus a 4-bit checksum (the first 4 bits of SHA-256)
 * gives 132 bits, divided into 12 words of 11 bits each (12 * 11 = 132).
 *
 * The 4-bit checksum detects approximately 15 out of 16 mistyped or corrupt
 * phrases. Decryption is the authoritative validation: the checksum catches
 * typos early, but only successfully decrypting the relic container proves
 * the key is the right one.
 */

import { InvalidMnemonicError } from './errors.ts';
import { sha256Hex } from './sha256.ts';
import { WORDLIST_SIZE, wordlist } from './wordlist.ts';

export const MNEMONIC_WORDS = 12;
export { WORDLIST_SIZE, wordlist };

const KEY_BYTES = 16;

/**
 * Lazy index mapping each unique 4-character prefix (or 3-letter word)
 * to its corresponding index in the wordlist.
 */
let prefixMap: Map<string, number> | undefined;

function getPrefixMap(): Map<string, number> {
  if (prefixMap === undefined) {
    const map = new Map<string, number>();
    const list = wordlist();
    for (let i = 0; i < list.length; i++) {
      const word = list[i];
      if (word === undefined) continue;
      const prefix = word.length >= 4 ? word.slice(0, 4) : word;
      map.set(prefix, i);
    }
    prefixMap = map;
  }
  return prefixMap;
}

/**
 * Cheap shape check answering whether text looks like 12 whitespace-separated
 * alphabetic tokens without loading or parsing the wordlist.
 */
export function isMnemonicLike(text: string): boolean {
  if (typeof text !== 'string') return false;
  const tokens = text
    .trim()
    .split(/[\s,\n\r]+/)
    .filter((t) => t.length > 0);
  if (tokens.length !== MNEMONIC_WORDS) return false;

  for (const token of tokens) {
    const match = token.match(/^[^a-zA-Z0-9]*([a-zA-Z]+)[^a-zA-Z0-9]*$/);
    if (!match) return false;
    const word = match[1];
    if (word === undefined || word.length < 3 || word.length > 16) return false;
  }

  return true;
}

/**
 * Convert a 16-byte relic key into a 12-word BIP-39 mnemonic phrase.
 *
 * Appends a 4-bit checksum (the first 4 bits of SHA-256 of the key) to the
 * 128-bit key, yielding 132 bits. The 132 bits are split into 12 11-bit
 * indices into the 2048-word vocabulary, most significant bits first.
 */
export function keyToMnemonic(key: Uint8Array): string[] {
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) {
    throw new InvalidMnemonicError(
      'range',
      undefined,
      `key must be ${KEY_BYTES} bytes, got ${key?.length}`
    );
  }

  const checksum = Number.parseInt(sha256Hex(key)[0]!, 16);

  let bits = 0n;
  for (let i = 0; i < KEY_BYTES; i++) {
    const byte = key[i];
    if (byte === undefined) {
      throw new InvalidMnemonicError('range', undefined, 'invalid key bytes');
    }
    bits = (bits << 8n) | BigInt(byte);
  }
  bits = (bits << 4n) | BigInt(checksum);

  const list = wordlist();
  const words = new Array<string>(MNEMONIC_WORDS);

  for (let i = MNEMONIC_WORDS - 1; i >= 0; i--) {
    const index = Number(bits & 0x7ffn);
    bits >>= 11n;
    const word = list[index];
    if (word === undefined) {
      throw new Error(`wordlist missing entry at index ${index}`);
    }
    words[i] = word;
  }

  return words;
}

/**
 * Decode a 12-word BIP-39 mnemonic phrase back into a 16-byte relic key.
 *
 * Accepts either an array of words or a single string with words separated by
 * whitespace, commas, or newlines. Words are resolved by unique 4-character
 * prefix (or full word for 3-letter entries) with case folding and tolerance
 * for surrounding punctuation.
 *
 * Validates the embedded 4-bit SHA-256 checksum. Decryption remains the
 * authoritative validation: the checksum catches typos, but only opening the
 * relic proves the key is the right one.
 */
export function mnemonicToKey(words: readonly string[] | string): Uint8Array {
  let tokens: string[];

  if (typeof words === 'string') {
    tokens = words
      .trim()
      .split(/[\s,\n\r]+/)
      .filter((t) => t.length > 0);
  } else if (Array.isArray(words)) {
    tokens = [];
    for (const item of words) {
      if (typeof item !== 'string') continue;
      const parts = item
        .trim()
        .split(/[\s,\n\r]+/)
        .filter((t) => t.length > 0);
      tokens.push(...parts);
    }
  } else {
    throw new InvalidMnemonicError('count', 0, 'invalid mnemonic input');
  }

  if (tokens.length !== MNEMONIC_WORDS) {
    throw new InvalidMnemonicError(
      'count',
      tokens.length,
      `mnemonic must contain exactly ${MNEMONIC_WORDS} words, got ${tokens.length}`
    );
  }

  const map = getPrefixMap();
  let bits = 0n;

  for (let i = 0; i < MNEMONIC_WORDS; i++) {
    const raw = tokens[i];
    if (raw === undefined) {
      throw new InvalidMnemonicError(
        'count',
        i,
        `missing mnemonic token at index ${i}`
      );
    }
    const cleaned = raw.toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, '');
    const prefix = cleaned.length >= 4 ? cleaned.slice(0, 4) : cleaned;
    const index = map.get(prefix);

    if (index === undefined) {
      throw new InvalidMnemonicError(
        'unknown_word',
        i,
        `unknown mnemonic word at index ${i}: ${JSON.stringify(raw)}`
      );
    }

    bits = (bits << 11n) | BigInt(index);
  }

  const storedChecksum = Number(bits & 0x0fn);
  bits >>= 4n;

  const key = new Uint8Array(KEY_BYTES);
  for (let i = KEY_BYTES - 1; i >= 0; i--) {
    key[i] = Number(bits & 0xffn);
    bits >>= 8n;
  }

  // Verify the 4-bit checksum against SHA-256 of the recovered key.
  // The checksum catches typos; only opening the relic proves the key is the right one.
  const actualChecksum = Number.parseInt(sha256Hex(key)[0]!, 16);

  if (storedChecksum !== actualChecksum) {
    throw new InvalidMnemonicError(
      'checksum',
      undefined,
      'invalid mnemonic checksum'
    );
  }

  return key;
}

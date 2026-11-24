import { describe, expect, test } from 'bun:test';
import { MalformedFragmentError, UnknownVersionError } from '../src/errors.ts';
import {
  decodeKey,
  encodeFragment,
  encodeKey,
  GFM_TRAILING_PUNCTUATION,
  generateKey,
  KEY_BYTES,
  KEY_CHARS,
  parseFragment,
  relicUrl,
  terminalCharset,
  VERSION_MARKER,
} from '../src/fragment.ts';
import { generateRelicId } from '../src/id.ts';

describe('key encoding', () => {
  test('a 16-byte key is 22 unpadded base64url characters', () => {
    expect(KEY_BYTES).toBe(16);
    expect(encodeKey(generateKey())).toHaveLength(KEY_CHARS);
  });

  test('round trips', () => {
    for (let i = 0; i < 200; i++) {
      const key = generateKey();
      expect([...decodeKey(encodeKey(key))]).toEqual([...key]);
    }
  });

  test('emits no padding', () => {
    expect(encodeKey(generateKey())).not.toContain('=');
  });
});

// The `fragment-terminal-charset` check `spec/format.md` 2.3 requires, in
// both halves.
describe('fragment-terminal-charset', () => {
  test('static: a 16-byte key can only end in A, Q, g, or w', () => {
    expect(terminalCharset(16).sort()).toEqual(['A', 'Q', 'g', 'w']);
  });

  test('static: that set does not intersect GFM trailing punctuation', () => {
    for (const ch of terminalCharset(16)) {
      expect(GFM_TRAILING_PUNCTUATION).not.toContain(ch);
    }
  });

  test('static: a 24-byte key would break the rule, which is why AES-192 is out', () => {
    // 24 is a multiple of three, so the final character carries a full 6
    // bits and `_` becomes reachable.
    expect(terminalCharset(24)).toContain('_');
    expect(GFM_TRAILING_PUNCTUATION).toContain('_');
  });

  test('static: a 32-byte key would also have been safe', () => {
    for (const ch of terminalCharset(32)) {
      expect(GFM_TRAILING_PUNCTUATION).not.toContain(ch);
    }
  });

  test('dynamic: real fragments survive GFM autolink trailing-punctuation trimming', () => {
    // GFM's documented rule as the oracle: trailing `?`, `!`, `.`, `,`, `:`,
    // `*`, `_`, and `~` are not considered part of an autolink.
    const trimTrailingPunctuation = (url: string): string => {
      let end = url.length;
      while (
        end > 0 &&
        GFM_TRAILING_PUNCTUATION.includes(url[end - 1] as string)
      ) {
        end--;
      }
      return url.slice(0, end);
    };

    for (let i = 0; i < 1000; i++) {
      const url = relicUrl(
        'https://relics.example',
        generateRelicId(),
        generateKey()
      );
      expect(trimTrailingPunctuation(url)).toBe(url);
    }
  });
});

describe('fragment shape', () => {
  test('is the marker followed immediately by the key, no separator', () => {
    const key = generateKey();
    const fragment = encodeFragment(key);
    expect(fragment.startsWith(VERSION_MARKER)).toBe(true);
    expect(fragment).toHaveLength(VERSION_MARKER.length + KEY_CHARS);
  });

  test('round trips through parse', () => {
    const key = generateKey();
    const parsed = parseFragment(encodeFragment(key));
    expect([...parsed.key]).toEqual([...key]);
    expect(parsed.version).toBe(1);
  });

  test('accepts a leading hash', () => {
    const key = generateKey();
    expect([...parseFragment(`#${encodeFragment(key)}`).key]).toEqual([...key]);
  });

  test('refuses an unknown version before anything is fetched', () => {
    const body = encodeFragment(generateKey()).slice(VERSION_MARKER.length);
    expect(() => parseFragment(`r9${body}`)).toThrow(UnknownVersionError);
  });

  test('reports an unknown version even when its key length differs', () => {
    // Key length is a property of a specific version, so the marker has to be
    // checked first. Checking length first would report a future version as a
    // malformed fragment and send the recipient to ask for a resend of a link
    // that was never broken.
    expect(() => parseFragment('r9AAAAAAAAAAAAAAAAAAAA')).toThrow(
      UnknownVersionError
    );
    expect(() => parseFragment('r9AAAA')).toThrow(UnknownVersionError);
    expect(() => parseFragment(`r9${'A'.repeat(60)}`)).toThrow(
      UnknownVersionError
    );
  });

  test('a wrong-length fragment on a known version is malformed, not unknown', () => {
    const body = encodeFragment(generateKey()).slice(VERSION_MARKER.length);
    expect(() =>
      parseFragment(`${VERSION_MARKER}${body.slice(0, -1)}`)
    ).toThrow(MalformedFragmentError);
  });

  test('refuses an empty fragment', () => {
    expect(() => parseFragment('#')).toThrow(MalformedFragmentError);
  });

  test('refuses a truncated fragment, which is what a mangled paste looks like', () => {
    const fragment = encodeFragment(generateKey());
    expect(() => parseFragment(fragment.slice(0, -1))).toThrow(
      MalformedFragmentError
    );
  });

  test('refuses a character outside base64url', () => {
    const fragment = `${encodeFragment(generateKey()).slice(0, -1)}!`;
    expect(() => parseFragment(fragment)).toThrow(MalformedFragmentError);
  });
});

describe('relik url', () => {
  test('puts the id in the path and the key in the fragment', () => {
    const id = generateRelicId();
    const url = new URL(relicUrl('https://relics.example', id, generateKey()));
    expect(url.pathname).toBe(`/${id}`);
    expect(url.hash.slice(1)).toHaveLength(VERSION_MARKER.length + KEY_CHARS);
  });

  test('tolerates a trailing slash on the origin', () => {
    const id = generateRelicId();
    const key = generateKey();
    expect(relicUrl('https://relics.example/', id, key)).toBe(
      relicUrl('https://relics.example', id, key)
    );
  });
});

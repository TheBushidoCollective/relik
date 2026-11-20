import { describe, expect, test } from 'bun:test';
import { scrubFrameHtml } from '../src/frame-html-scrub.ts';

const OLD =
  /<\s*\/?\s*(?:iframe|frame|object|embed|portal|fencedframe)\b(?:"[^"]*"|'[^']*'|[^'">])*(?:>|$)/gi;
const START = /<\s*\/?\s*(?:iframe|frame|object|embed|portal|fencedframe)\b/i;
const names = ['iframe', 'FRAME', 'ObjECt', 'embed', 'PORTAL', 'fencedFrame'];
let seed = 0x512cab;
function pick<T>(items: readonly T[]): T {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return items[seed % items.length]!;
}

// Find the first tag whose attribute quote reaches EOF. Earlier tags are
// skipped as complete units, just as the old replace would have consumed them.
function unclosedStart(input: string): number | undefined {
  let pos = 0;
  while (pos < input.length) {
    const match = START.exec(input.slice(pos));
    if (!match) return undefined;
    const start = pos + match.index;
    let i = start + match[0].length;
    let quote = '';
    for (; i < input.length; i++) {
      const c = input[i]!;
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    if (quote) return start;
    pos = i + 1;
  }
  return undefined;
}

describe('frame HTML scrubber', () => {
  test('agrees with the old expression except for unterminated quotes', () => {
    const atoms = [
      '<',
      '/',
      '>',
      '"',
      "'",
      ' ',
      '\t',
      '\n',
      'x',
      '_',
      '9',
      ...names,
    ];
    let equal = 0;
    let tails = 0;
    for (let n = 0; n < 20000; n++) {
      let input = '';
      const length = 4 + (n % 30);
      for (let i = 0; i < length; i++) input += pick(atoms);
      // Inject candidate tags often enough to cover both quoted outcomes.
      if (n % 3 === 0)
        input += `<${pick(names)} ${pick(['x', '"', "'", '"ok"', "'ok'"])}${pick(['>', ''])}`;
      const start = unclosedStart(input);
      const result = scrubFrameHtml(input);
      if (start === undefined) {
        expect(result).toBe(input.replace(OLD, ''));
        equal++;
      } else {
        // Remove the unmatched tag and everything after it; preceding complete
        // matches retain the old expression's behavior.
        expect(result).toBe(input.slice(0, start).replace(OLD, ''));
        tails++;
      }
    }
    expect(equal).toBeGreaterThan(1000);
    expect(tails).toBeGreaterThan(100);
    console.log(
      `differential: ${equal} equivalent, ${tails} unterminated tails`
    );
  });

  test('unterminated quotes remove the frame start and all following markup', () => {
    for (const name of names) {
      for (const quote of ['"', "'"]) {
        const input = `ordinary text<${name} attr=${quote}><iframe src=x>`;
        const old = input.replace(OLD, '');
        const result = scrubFrameHtml(input);
        expect(old.startsWith('ordinary text')).toBe(true);
        expect(result).toBe('ordinary text');
        expect(START.test(result)).toBe(false);
      }
    }
    expect(scrubFrameHtml('<i<iframe>frame')).toBe('<iframe');
    expect(scrubFrameHtml('<iframe_name>')).toBe('<iframe_name>');
    expect(scrubFrameHtml('<iframe\u00a0x="unterminated')).toBe('');
  });

  test('bounded hostile and 16 MiB inputs scale linearly', () => {
    const measure = (label: string, input: string): number => {
      const start = performance.now();
      scrubFrameHtml(input);
      const ms = performance.now() - start;
      console.log(`${label}: ${input.length} chars ${ms.toFixed(2)} ms`);
      return ms;
    };
    scrubFrameHtml('<object a"');
    for (const n of [16000, 1000000]) {
      expect(
        measure(`object quote n=${n}`, '<object a'.repeat(n) + '"')
      ).toBeLessThan(100);
    }
    const size = 16 * 1024 * 1024;
    const samples: [string, string][] = [
      ['iframe', '<iframe'],
      ['object single quote', "<object a='"],
      ['less-than', '<'],
      ['less-than space', '< '],
      ['whitespace after less-than', '<' + ' '.repeat(size - 1)],
      ['benign XML', '<node attr="value">text</node>'],
      ['greater-than', '>'],
    ];
    for (const [label, pattern] of samples) {
      const input =
        pattern.length >= size
          ? pattern
          : pattern.repeat(Math.ceil(size / pattern.length)).slice(0, size);
      const half = input.slice(0, size / 2);
      // Minimum of repeated timings limits scheduling and JIT noise in the ratio.
      const a = Math.min(
        measure(`${label} 8MiB`, half),
        measure(`${label} 8MiB repeat`, half)
      );
      const b = Math.min(
        measure(`${label} 16MiB`, input),
        measure(`${label} 16MiB repeat`, input)
      );
      expect(b).toBeLessThan(1000);
      expect(b).toBeLessThan(a * 3.5 + 10);
    }
  }, 30000);
});

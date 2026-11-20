// ECMAScript's \s includes these whitespace and line terminator code points.
function isSpace(c: number): boolean {
  return (
    (c >= 9 && c <= 13) ||
    c === 32 ||
    c === 160 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

function isWord(c: number): boolean {
  return (
    (c >= 48 && c <= 57) ||
    (c >= 65 && c <= 90) ||
    (c >= 97 && c <= 122) ||
    c === 95
  );
}

const FRAME_NAMES = [
  'iframe',
  'frame',
  'object',
  'embed',
  'portal',
  'fencedframe',
];

/** Delete frame-tag spans once; this is a backstop, not an HTML parser. */
export function scrubFrameHtml(input: string): string {
  const length = input.length;
  let i = 0;
  let keptFrom = 0;
  let chunks: string[] | undefined;
  while (i < length) {
    if (input.charCodeAt(i) !== 60) {
      i++;
      continue;
    }
    const start = i++;
    while (isSpace(input.charCodeAt(i))) i++;
    if (input.charCodeAt(i) === 47) {
      i++;
      while (isSpace(input.charCodeAt(i))) i++;
    }
    const first = input.charCodeAt(i) | 32;
    if (
      first !== 105 &&
      first !== 102 &&
      first !== 111 &&
      first !== 101 &&
      first !== 112
    )
      continue;
    let tagLength = 0;
    for (const name of FRAME_NAMES) {
      let j = 0;
      while (
        j < name.length &&
        (input.charCodeAt(i + j) | 32) === name.charCodeAt(j)
      )
        j++;
      if (j === name.length && !isWord(input.charCodeAt(i + j))) {
        tagLength = j;
        break;
      }
    }
    if (!tagLength) continue;
    i += tagLength;
    let quote = 0;
    while (i < length) {
      const c = input.charCodeAt(i++);
      if (quote) {
        if (c === quote) quote = 0;
      } else if (c === 34 || c === 39) {
        quote = c;
      } else if (c === 62) {
        break;
      }
    }
    if (!chunks) chunks = [];
    chunks.push(input.slice(keptFrom, start));
    keptFrom = i;
  }
  if (!chunks) return input;
  chunks.push(input.slice(keptFrom));
  return chunks.join('');
}

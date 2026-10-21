/**
 * The renderer class: the coarse, eight-value taxonomy the frame concedes to
 * the operator so the success metric is computable at all.
 *
 * Two rules travel with it and neither is negotiable:
 *
 * 1. **It is derived by the client that holds the plaintext**, never accepted
 *    as a tool input (`spec/publish.md` 1.2). Exposing it as a parameter
 *    makes the taxonomy model-attested, and the metric's second clause would
 *    have an unreliable narrator reporting its only input.
 * 2. **It never reaches the viewer and never routes rendering**
 *    (`spec/format.md` 3.6). A publisher declaring `image` on an HTML payload
 *    would win inline rendering on the origin holding the fragment secret.
 *    Routing comes from sniffing after decryption, and it can only ever move
 *    content to a less privileged path.
 *
 * The eighth value arrived with JSX rendering. Component source was
 * previously `code`, but `code` is escaped text and a component's whole
 * point is to execute, so it needed its own value on the renderable side
 * carrying the same top privilege as `html`.
 */

import { isOtioz, isRawOtio } from './otio-zip.ts';

/** The ten values. Stored server-side against the relic ID, nowhere else. */
export type RendererClass =
  | 'markdown'
  | 'code'
  | 'html'
  | 'jsx'
  | 'image'
  | 'pdf'
  | 'media'
  | 'otio'
  | 'archive'
  | 'binary';

export const RENDERER_CLASSES: readonly RendererClass[] = [
  'markdown',
  'code',
  'html',
  'jsx',
  'image',
  'pdf',
  'media',
  'otio',
  'archive',
  'binary',
];

/**
 * The side of the taxonomy the success metric counts as rendered.
 *
 * **This is telemetry vocabulary, not a description of the viewer.** The
 * wedge it cuts is the metric's second clause, and `media` sits outside it
 * even though the viewer gives a media relic a player. Reading it as "what
 * happens when a recipient opens this" has already produced one wrong
 * recipient-facing claim: the unfurl card told the reader of a video relic
 * that it downloads to their device, because this predicate was the nearest
 * thing to hand. Copy that describes the viewer reads `CLASS_BEHAVIOUR`.
 */
export const RENDERABLE_CLASSES: readonly RendererClass[] = [
  'markdown',
  'code',
  'html',
  'jsx',
  'image',
  'pdf',
];

/**
 * What a recipient actually gets when they open a relic of each class.
 *
 * Three outcomes, because the viewer has three: content on the page, a
 * player, or a file on the device. `html` and `jsx` render inside a frame
 * with no network reach, which is still content on the page from where the
 * reader sits, so the distinction this table draws is the one a recipient
 * experiences rather than the one the renderer stack is built from.
 *
 * It lives here rather than in either end because two consumers must agree
 * on it and neither owns it: the viewer routes content, and the server
 * writes copy telling a recipient what the route will be. A viewer test
 * asserts `routeForClass` agrees with this table for every class, so a
 * route that moves fails a test instead of turning a card into a false
 * statement. Nothing routes off this value; routing inputs come from inside
 * the AEAD (`spec/format.md` 3.6).
 */
export type ClassBehaviour = 'renders' | 'plays' | 'downloads';

export const CLASS_BEHAVIOUR: Record<RendererClass, ClassBehaviour> = {
  markdown: 'renders',
  code: 'renders',
  html: 'renders',
  jsx: 'renders',
  image: 'renders',
  pdf: 'renders',
  media: 'plays',
  otio: 'plays',
  archive: 'downloads',
  binary: 'downloads',
};

export function isRendererClass(value: string): value is RendererClass {
  return (RENDERER_CLASSES as readonly string[]).includes(value);
}

export function isRenderable(value: RendererClass): boolean {
  return (RENDERABLE_CLASSES as readonly RendererClass[]).includes(value);
}

interface MagicSignature {
  readonly bytes: readonly number[];
  readonly offset: number;
  readonly cls: RendererClass;
}

/** Checked before any extension is consulted. */
const MAGIC: readonly MagicSignature[] = [
  { bytes: [0x89, 0x50, 0x4e, 0x47], offset: 0, cls: 'image' }, // PNG
  { bytes: [0xff, 0xd8, 0xff], offset: 0, cls: 'image' }, // JPEG
  { bytes: [0x47, 0x49, 0x46, 0x38], offset: 0, cls: 'image' }, // GIF
  { bytes: [0x42, 0x4d], offset: 0, cls: 'image' }, // BMP
  { bytes: [0x50, 0x4b, 0x03, 0x04], offset: 0, cls: 'archive' }, // ZIP
  { bytes: [0x50, 0x4b, 0x05, 0x06], offset: 0, cls: 'archive' }, // empty ZIP
  { bytes: [0x1f, 0x8b], offset: 0, cls: 'archive' }, // gzip
  { bytes: [0x42, 0x5a, 0x68], offset: 0, cls: 'archive' }, // bzip2
  { bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a], offset: 0, cls: 'archive' }, // xz
  { bytes: [0x28, 0xb5, 0x2f, 0xfd], offset: 0, cls: 'archive' }, // zstd
  { bytes: [0x75, 0x73, 0x74, 0x61, 0x72], offset: 257, cls: 'archive' }, // tar
  { bytes: [0x25, 0x50, 0x44, 0x46], offset: 0, cls: 'pdf' }, // PDF
  { bytes: [0x49, 0x44, 0x33], offset: 0, cls: 'media' }, // MP3 with ID3
  { bytes: [0x4f, 0x67, 0x67, 0x53], offset: 0, cls: 'media' }, // Ogg
  { bytes: [0x66, 0x74, 0x79, 0x70], offset: 4, cls: 'media' }, // MP4 family
];

const EXTENSIONS: Readonly<Record<string, RendererClass>> = {
  md: 'markdown',
  markdown: 'markdown',
  mdown: 'markdown',
  mkd: 'markdown',

  html: 'html',
  htm: 'html',
  xhtml: 'html',

  otio: 'otio',
  otioz: 'otio',
  svg: 'image',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  bmp: 'image',
  ico: 'image',

  mp4: 'media',
  webm: 'media',
  mov: 'media',
  mkv: 'media',
  mp3: 'media',
  wav: 'media',
  ogg: 'media',
  flac: 'media',
  m4a: 'media',

  zip: 'archive',
  tar: 'archive',
  gz: 'archive',
  tgz: 'archive',
  bz2: 'archive',
  xz: 'archive',
  zst: 'archive',
  '7z': 'archive',
  rar: 'archive',

  ts: 'code',
  js: 'code',
  // Component source is its own class rather than `code`, because the jsx
  // route executes it instead of escaping it. The dialect only picks the
  // transpile transform; the privilege is identical either way.
  jsx: 'jsx',
  tsx: 'jsx',
  mjs: 'code',
  cjs: 'code',
  json: 'code',
  jsonc: 'code',
  yaml: 'code',
  yml: 'code',
  toml: 'code',
  ini: 'code',
  xml: 'code',
  py: 'code',
  rb: 'code',
  go: 'code',
  rs: 'code',
  java: 'code',
  kt: 'code',
  swift: 'code',
  c: 'code',
  h: 'code',
  cc: 'code',
  cpp: 'code',
  hpp: 'code',
  cs: 'code',
  php: 'code',
  ex: 'code',
  exs: 'code',
  erl: 'code',
  scala: 'code',
  clj: 'code',
  hs: 'code',
  lua: 'code',
  pl: 'code',
  r: 'code',
  sql: 'code',
  sh: 'code',
  bash: 'code',
  zsh: 'code',
  fish: 'code',
  ps1: 'code',
  dockerfile: 'code',
  tf: 'code',
  hcl: 'code',
  proto: 'code',
  graphql: 'code',
  gql: 'code',
  css: 'code',
  scss: 'code',
  sass: 'code',
  less: 'code',
  diff: 'code',
  patch: 'code',
  csv: 'code',
  tsv: 'code',
  txt: 'code',
  log: 'code',
  text: 'code',
  pdf: 'pdf',
};

function extensionOf(filename: string): string | undefined {
  const base = filename.slice(filename.lastIndexOf('/') + 1).toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return undefined;
  return base.slice(dot + 1);
}

function matchesMagic(content: Uint8Array, signature: MagicSignature): boolean {
  const end = signature.offset + signature.bytes.length;
  if (content.length < end) return false;
  for (let index = 0; index < signature.bytes.length; index++) {
    if (content[signature.offset + index] !== signature.bytes[index]) {
      return false;
    }
  }
  return true;
}

/** Cheap UTF-8 text check over a prefix: no NUL bytes, few control bytes. */
function looksTextual(content: Uint8Array): boolean {
  const limit = Math.min(content.length, 8192);
  if (limit === 0) return false;

  let suspicious = 0;
  for (let index = 0; index < limit; index++) {
    const byte = content[index] as number;
    if (byte === 0) return false;
    const isPlainControl =
      byte < 0x09 || (byte > 0x0d && byte < 0x20) || byte === 0x7f;
    if (isPlainControl) suspicious++;
  }
  return suspicious / limit < 0.01;
}

/**
 * What a real HTML document or fragment opens with.
 *
 * This list started as doctype/html/comment/svg only, and that failed in the
 * field: a page starting with `<head>`, `<div>`, or `<meta>` sniffed as code,
 * the declared-versus-sniffed rule then showed genuine HTML as escaped text,
 * and the publisher got a broken product with an honest-sounding excuse. So
 * the list covers the elements a document or fragment can start with, and
 * `<!doctype` is not pinned to `html` because legacy doctypes exist.
 *
 * Two guards keep it from swallowing plain text. Every prefix is tag-shaped,
 * and prose does not open with `<head>` or `<meta`; where a short tag is
 * ambiguous with a word (`<p>` versus `<password:`) the closing bracket is
 * part of the prefix. And widening this can only make a file that already
 * declares itself HTML render as HTML; a `.txt` starting with `<div>` still
 * downgrades, because the disagreement rule takes the least privileged tier
 * and the frame is where executing markup belongs either way.
 */
const HTML_PREFIXES = [
  '<!doctype',
  '<?xml', // XHTML prologue
  '<html',
  '<head',
  '<body',
  '<meta',
  '<title',
  '<link',
  '<style',
  '<script',
  '<svg',
  '<div',
  '<main',
  '<section',
  '<article',
  '<header',
  '<footer',
  '<nav',
  '<aside',
  '<table',
  '<form',
  '<ul',
  '<ol',
  '<dl',
  '<h1',
  '<h2',
  '<h3',
  '<h4',
  '<h5',
  '<h6',
  '<p>',
  '<!--',
];

/**
 * Derive the class from the bytes the publishing client holds.
 *
 * Order: the unconditional zero-byte rule, then magic bytes, then the
 * extension, then a textual-content fallback, then `binary`.
 */
/**
 * Classify from bytes alone, ignoring the filename entirely.
 *
 * This is the input the viewer's declared-versus-sniffed rule needs. Using
 * `deriveRendererClass` there would be a bug with a security consequence: its
 * extension fallback means an HTML payload named `innocent.png` sniffs as
 * `image`, so the comparison would be measuring the filename against itself
 * and would agree in exactly the case the rule exists to catch.
 *
 * It cannot tell Markdown from other plain text, and it does not try. Both
 * are escaped text at render time, so they carry the same privilege, and
 * `privilegeTier` is what the comparison actually runs on.
 */
export function sniffContentClass(content: Uint8Array): RendererClass {
  if (content.length === 0) return 'binary';

  for (const signature of MAGIC) {
    if (matchesMagic(content, signature)) {
      if (signature.cls === 'archive') {
        if (isOtioz(content)) return 'otio';
      }
      return signature.cls;
    }
  }

  if (looksTextual(content)) {
    if (isRawOtio(content)) return 'otio';
    const head = new TextDecoder('utf-8', { fatal: false })
      .decode(content.slice(0, 256))
      .trimStart()
      .toLowerCase();
    if (HTML_PREFIXES.some((prefix) => head.startsWith(prefix))) return 'html';
    return 'code';
  }

  return 'binary';
}

/**
 * How much the viewer has to trust content to render it this way.
 *
 * 3 executes script (an HTML page or a JSX component), 2 goes through an
 * image decoder, 1 is escaped text, and 0 is never rendered at all. The
 * declared-versus-sniffed rule compares
 * tiers rather than classes, because `markdown` and `code` differ only in how
 * escaped text is decorated and a spurious disagreement between them would
 * downgrade every Markdown relic ever published.
 */
export function privilegeTier(cls: RendererClass): 0 | 1 | 2 | 3 {
  switch (cls) {
    case 'html':
    case 'jsx':
      return 3;
    case 'image':
    case 'pdf':
      return 2;
    case 'markdown':
    case 'code':
      return 1;
    default:
      return 0;
  }
}

export function deriveRendererClass(
  content: Uint8Array,
  filename: string
): RendererClass {
  // `spec/format.md` 3.9, unconditional: a zero-byte relic is `binary`
  // regardless of filename, extension, or sniffed type. It renders as
  // nothing, and calling it `code` because its name ends in `.py` would
  // inflate the renderable share the metric's second clause measures.
  if (content.length === 0) return 'binary';

  for (const signature of MAGIC) {
    if (matchesMagic(content, signature)) {
      if (signature.cls === 'archive') {
        if (isOtioz(content)) return 'otio';
      }
      return signature.cls;
    }
  }

  const extension = extensionOf(filename);
  if (extension !== undefined) {
    const fromExtension = EXTENSIONS[extension];
    if (fromExtension !== undefined) {
      if (fromExtension === 'otio') {
        if (isOtioz(content) || isRawOtio(content)) return 'otio';
        return sniffContentClass(content);
      }
      return fromExtension;
    }
  }

  if (looksTextual(content)) {
    if (isRawOtio(content)) return 'otio';
    const head = new TextDecoder('utf-8', { fatal: false })
      .decode(content.slice(0, 256))
      .trimStart()
      .toLowerCase();
    if (HTML_PREFIXES.some((prefix) => head.startsWith(prefix))) return 'html';
    return 'code';
  }

  return 'binary';
}
/**
 * The declared-versus-sniffed disagreement rule (`spec/format.md` 3.6).
 *
 * Runs in the viewer against the envelope header's declared mimetype and
 * filename, which sit inside the AEAD and are therefore tamper-evident. When
 * the two disagree, route to the least privileged path either type would
 * allow and tell the recipient you did so.
 */
export function leastPrivileged(
  first: RendererClass,
  second: RendererClass
): RendererClass {
  // Ordered most privileged to least. `html` and `jsx` are the two most
  // dangerous things the viewer will render, and they carry identical
  // privilege: both execute in the frame. A disagreement involving either
  // always loses.
  const ranking: readonly RendererClass[] = [
    'html',
    'jsx',
    'image',
    'pdf',
    'markdown',
    'code',
    'media',
    'otio',
    'archive',
    'binary',
  ];
  const firstRank = ranking.indexOf(first);
  const secondRank = ranking.indexOf(second);
  return (ranking[Math.max(firstRank, secondRank)] ??
    'binary') as RendererClass;
}

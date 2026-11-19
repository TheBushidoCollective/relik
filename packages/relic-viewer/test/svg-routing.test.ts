import { describe, expect, test } from 'bun:test';
import { contentFromBytes } from '../src/content.ts';
import { routeContent, routeFor } from '../src/viewer.ts';

// What a published SVG actually does, one case per test. The publisher's
// declared type for a `.svg` is image/svg+xml (publish.ts MIMETYPES); the
// other declarations below are what an envelope from another client, or a
// hostile one, can carry. viewer.md 1.5 states the outcome for each.

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const SVG_TEXT =
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">' +
  '<rect width="20" height="20" fill="#e53935"/></svg>';
const SVG_WITH_SCRIPT =
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">' +
  '<script>fetch("https://collector.invalid/x")</script>' +
  '<rect width="20" height="20"/></svg>';
const HTML_TEXT = '<!doctype html><p>not an image</p>';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('a published SVG, declared image/svg+xml', () => {
  test('renders in the sandboxed frame with no notice', async () => {
    const decision = await routeFor(
      'drawing.svg',
      'image/svg+xml',
      utf8(SVG_TEXT)
    );
    expect(decision.route).toBe('sandboxed-html');
    expect(decision.notice).toBeUndefined();
  });

  test('a script inside it does not change the route', async () => {
    const decision = await routeFor(
      'drawing.svg',
      'image/svg+xml',
      utf8(SVG_WITH_SCRIPT)
    );
    expect(decision.route).toBe('sandboxed-html');
    expect(decision.notice).toBeUndefined();
  });

  test('the frame receives the file markup verbatim', async () => {
    const decision = await routeContent(
      'drawing.svg',
      'image/svg+xml',
      contentFromBytes(utf8(SVG_WITH_SCRIPT))
    );
    expect(decision.route).toBe('sandboxed-html');
    const bytes = decision.document?.bytes;
    expect(bytes === undefined ? undefined : decode(bytes)).toBe(
      SVG_WITH_SCRIPT
    );
  });
});

describe('the same SVG under the other declarations it can carry', () => {
  test('.svg declared application/octet-stream renders in the frame', async () => {
    const decision = await routeFor(
      'drawing.svg',
      'application/octet-stream',
      utf8(SVG_TEXT)
    );
    expect(decision.route).toBe('sandboxed-html');
    expect(decision.notice).toBeUndefined();
  });

  test('.svg with no declared type is downloaded, never rendered', async () => {
    const decision = await routeFor('drawing.svg', '', utf8(SVG_TEXT));
    expect(decision.route).toBe('download');
    expect(decision.notice).toBeDefined();
  });

  test('SVG bytes named .txt are shown as source text', async () => {
    const decision = await routeFor(
      'drawing.txt',
      'text/plain',
      utf8(SVG_TEXT)
    );
    expect(decision.route).toBe('code');
    expect(decision.notice).toBeDefined();
  });

  test('octet-stream and image/svg+xml agree for every SVG-named payload', async () => {
    const payloads = [
      utf8(SVG_TEXT),
      utf8(SVG_WITH_SCRIPT),
      utf8(HTML_TEXT),
      utf8('just some words'),
      PNG,
    ];
    for (const payload of payloads) {
      const declared = await routeFor('x.svg', 'image/svg+xml', payload);
      const generic = await routeFor(
        'x.svg',
        'application/octet-stream',
        payload
      );
      expect(generic.route).toBe(declared.route);
    }
  });
});

describe('a mismatched .svg, the disagreement rule (viewer.md 1.3)', () => {
  // A disagreement resolves to the less privileged class with the mismatch
  // notice, which viewer.md 1.3 states; these tests pin that outcome.
  test('PNG bytes named .svg are shown as the image they are, with a notice', async () => {
    const decision = await routeFor('drawing.svg', 'image/svg+xml', PNG);
    expect(decision.route).toBe('image');
    expect(decision.notice).toContain('safer way');
  });

  test('HTML bytes named .png never reach the frame', async () => {
    const decision = await routeFor(
      'drawing.png',
      'image/png',
      utf8(HTML_TEXT)
    );
    expect(decision.route).not.toBe('sandboxed-html');
    expect(decision.notice).toBeDefined();
  });

  test('HTML bytes named .svg reach the frame, because the levels agree', async () => {
    const decision = await routeFor(
      'drawing.svg',
      'image/svg+xml',
      utf8(HTML_TEXT)
    );
    expect(decision.route).toBe('sandboxed-html');
    expect(decision.notice).toBeUndefined();
  });

  test('prose named .svg is shown as source text', async () => {
    const decision = await routeFor(
      'drawing.svg',
      'image/svg+xml',
      utf8('just some words')
    );
    expect(decision.route).toBe('code');
    expect(decision.notice).toBeDefined();
  });
});

describe('a declared media type carrying SVG', () => {
  test('video/svg+xml with SVG bytes goes to the player', async () => {
    // Its blob type is pinned in media-blob-type.test.ts: the player blob is
    // typed from the bytes, so the declared type never reaches it.
    const decision = await routeFor(
      'clip.mp4',
      'video/svg+xml',
      utf8(SVG_TEXT)
    );
    expect(decision.route).toBe('media');
  });
});

describe('the frame and the media blob, read from source', () => {
  // Static guards. The browser proof (test/svg-path.ts) checks the behavior;
  // these fail fast if a loosening lands in the source.
  test('the render frame carries allow-scripts and no grant to the parent origin', async () => {
    const source = await Bun.file(
      new URL('../src/main.ts', import.meta.url)
    ).text();
    expect(source).toContain("setAttribute('sandbox', 'allow-scripts')");
    expect(source).not.toMatch(
      /['"][^'"\n]*allow-(same-origin|top-navigation|popups)/
    );
  });

  test('the media player blob is typed from the bytes, never the declaration', async () => {
    const source = await Bun.file(
      new URL('../src/main.ts', import.meta.url)
    ).text();
    expect(source).not.toContain('blob(view.declaredMimetype)');
    expect(source).toContain('blob(sniffMediaType(view.content.head))');
  });
});

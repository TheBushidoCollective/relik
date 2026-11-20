import { describe, expect, test } from 'bun:test';
import { contentFromBytes, type RelicContent } from '../src/content.ts';
import {
  NOTEBOOK_RENDER_LIMIT_BYTES,
  NOTEBOOK_TOO_LARGE_NOTICE,
} from '../src/structured-view-bridge.ts';
import { routeContent, routeFor, routeForClass } from '../src/viewer.ts';

// Routing for the formats the structured views open: which route each
// declared type and name takes, and the notice a mismatch shows. Covers the
// declarations old and new clients send, and every size rule.

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const NOTEBOOK = JSON.stringify({
  cells: [],
  metadata: {},
  nbformat: 4,
  nbformat_minor: 5,
});
const IPYNB = 'application/x-ipynb+json';

describe('a notebook is routed by its bytes and its name', () => {
  test('a valid nbformat 4 notebook declared as ipynb is a notebook', async () => {
    const decision = await routeFor('report.ipynb', IPYNB, utf8(NOTEBOOK));
    expect(decision.route).toBe('notebook');
    expect(decision.notice).toBeUndefined();
  });

  test('a notebook an older client declared as text/plain is still a notebook', async () => {
    const decision = await routeFor(
      'report.ipynb',
      'text/plain',
      utf8(NOTEBOOK)
    );
    expect(decision.route).toBe('notebook');
    expect(decision.notice).toBeUndefined();
  });

  test('a notebook declared as application/json under an ipynb name is a notebook', async () => {
    const decision = await routeFor(
      'report.ipynb',
      'application/json',
      utf8(NOTEBOOK)
    );
    expect(decision.route).toBe('notebook');
  });

  test('a notebook-shaped file named .json stays code, with no notice', async () => {
    const decision = await routeFor(
      'report.json',
      'application/json',
      utf8(NOTEBOOK)
    );
    expect(decision.route).toBe('code');
    expect(decision.notice).toBeUndefined();
  });

  test('an .ipynb whose bytes are not a notebook gets the mismatch notice and shows as code', async () => {
    const decision = await routeFor('report.ipynb', IPYNB, utf8('just words'));
    expect(decision.route).toBe('code');
    expect(decision.notice).toContain('a Jupyter notebook');
    expect(decision.notice).toContain('the safer way');
  });

  test('an nbformat 3 file is not a notebook under the nbformat 4 rule', async () => {
    const v3 = JSON.stringify({ cells: [], nbformat: 3 });
    const decision = await routeFor('old.ipynb', IPYNB, utf8(v3));
    expect(decision.route).toBe('code');
  });

  test('the sample form takes the notebook decision from the caller, not from the bytes', async () => {
    const yes = await routeFor('report.ipynb', IPYNB, {
      sniffed: 'code',
      model: undefined,
      component: false,
      notebook: true,
    });
    expect(yes.route).toBe('notebook');
    const no = await routeFor('report.ipynb', IPYNB, {
      sniffed: 'code',
      model: undefined,
      component: false,
      notebook: false,
    });
    expect(no.route).toBe('code');
    expect(no.notice).toContain('a Jupyter notebook');
  });

  test('routeContent hands the notebook its whole text on the notebook route', async () => {
    const decision = await routeContent(
      'report.ipynb',
      IPYNB,
      contentFromBytes(utf8(NOTEBOOK))
    );
    expect(decision.route).toBe('notebook');
    const bytes = decision.document?.bytes;
    expect(bytes === undefined ? undefined : decode(bytes)).toBe(NOTEBOOK);
  });

  test('a notebook over the size limit is never read whole at that limit and shows as text', async () => {
    const wholeLimits: number[] = [];
    const oversized: RelicContent = {
      size: NOTEBOOK_RENDER_LIMIT_BYTES + 1,
      head: utf8(NOTEBOOK),
      tail: new Uint8Array(0),
      blob: () => new Blob([]),
      async read(start, end) {
        return new Uint8Array(end - start).fill(0x20);
      },
      async readWhole(limit) {
        wholeLimits.push(limit);
        return undefined;
      },
    };
    const decision = await routeContent('report.ipynb', IPYNB, oversized);
    expect(decision.route).toBe('code');
    expect(decision.notice).toBe(NOTEBOOK_TOO_LARGE_NOTICE);
    // Only the document limit is ever used for the text, so the notebook
    // limit's whole read never happens for an oversized notebook.
    expect(wholeLimits).not.toContain(NOTEBOOK_RENDER_LIMIT_BYTES);
  });

  test('the notebook class maps to the notebook route', () => {
    expect(routeForClass('notebook')).toBe('notebook');
  });
});

describe('the formats the structured views open route as code, with no notice', () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ['data.csv', 'text/csv', 'a,b\n1,2\n'],
    ['data.tsv', 'text/tab-separated-values', 'a\tb\n1\t2\n'],
    ['data.json', 'application/json', '{"a": [1, 2]}'],
    [
      'cues.srt',
      'application/x-subrip',
      '1\n00:00:00,000 --> 00:00:01,000\nHi\n',
    ],
    ['captions.vtt', 'text/vtt', 'WEBVTT\n\n00:00.000 --> 00:01.000\nHi\n'],
  ];

  for (const [filename, mimetype, text] of cases) {
    test(`${filename} declared ${mimetype} routes as code`, async () => {
      const decision = await routeFor(filename, mimetype, utf8(text));
      expect(decision.route).toBe('code');
      expect(decision.notice).toBeUndefined();
    });
  }

  test('a subtitle declared application/x-subrip no longer warns as a mismatch', async () => {
    // Before this class mapping, that type read as binary and warned.
    const decision = await routeFor(
      'cues.srt',
      'application/x-subrip',
      utf8('1\n00:00:00,000 --> 00:00:01,000\nHi\n')
    );
    expect(decision.notice).toBeUndefined();
  });
});

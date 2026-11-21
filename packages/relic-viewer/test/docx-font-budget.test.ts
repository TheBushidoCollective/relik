import { afterEach, beforeEach, expect, test } from 'bun:test';
import { parseAsync, renderDocument, type HElement } from 'docx-preview';
import JSZip from 'jszip';

const originalParser = Object.getOwnPropertyDescriptor(globalThis, 'DOMParser');
const originalReader = Object.getOwnPropertyDescriptor(
  globalThis,
  'FileReader'
);
let reads = 0;

class EmptyXmlParser {
  parseFromString() {
    return {
      firstElementChild: { childNodes: { length: 0 } },
      getElementsByTagName: () => [],
    };
  }
}

class DataUrlReader {
  result: string | null = null;
  onloadend: (() => void) | null = null;
  onerror: (() => void) | null = null;

  readAsDataURL(blob: Blob) {
    reads++;
    blob.arrayBuffer().then(
      (buffer) => {
        this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buffer).toString('base64')}`;
        this.onloadend?.();
      },
      () => this.onerror?.()
    );
  }
}

beforeEach(() => {
  reads = 0;
  Object.defineProperty(globalThis, 'DOMParser', {
    configurable: true,
    value: EmptyXmlParser,
  });
  Object.defineProperty(globalThis, 'FileReader', {
    configurable: true,
    value: DataUrlReader,
  });
});

afterEach(() => {
  if (originalParser)
    Object.defineProperty(globalThis, 'DOMParser', originalParser);
  else Reflect.deleteProperty(globalThis, 'DOMParser');
  if (originalReader)
    Object.defineProperty(globalThis, 'FileReader', originalReader);
  else Reflect.deleteProperty(globalThis, 'FileReader');
});

const key = '{00112233-4455-6677-8899-AABBCCDDEEFF}';
const otherKey = '{FFEEDDCC-BBAA-9988-7766-554433221100}';
const path = 'word/fonts/fixture.odttf';

async function documentWithFont(bytes: Uint8Array) {
  const zip = new JSZip();
  zip.file('_rels/.rels', '<Relationships/>');
  const doc = await parseAsync(
    await zip.generateAsync({ type: 'uint8array' }),
    {
      useBase64URL: true,
    }
  );
  let loads = 0;
  doc._package = {
    _zip: { files: { [path]: {} } },
    load: async () => {
      loads++;
      return bytes;
    },
  };
  doc.contentTypes = [{ partName: `/${path}`, contentType: 'font/ttf' }];
  doc.fontTablePart = {
    path: 'word/fontTable.xml',
    rels: [
      { id: 'first', target: 'fonts/fixture.odttf' },
      { id: 'alias', target: 'fonts/./fixture.odttf' },
    ],
  };
  return { doc, loads: () => loads };
}

function rendererDocument(
  references: number,
  loadFont: () => Promise<string | null>
) {
  return {
    documentPart: { body: { children: [], props: {}, cssStyle: {} } },
    fontTablePart: {
      fonts: [
        {
          name: 'Fixture Font',
          embedFontRefs: Array.from({ length: references }, () => ({
            id: 'first',
            key,
            type: 'regular',
          })),
        },
      ],
    },
    loadFont,
  };
}

const factory = (_element: HElement | Node | string): Node =>
  ({ appendChild() {} }) as unknown as Node;

test('reuses in-flight font conversions without mutating source bytes', async () => {
  const bytes = Buffer.alloc(64, 0x56);
  const original = Buffer.from(bytes);
  const { doc, loads } = await documentWithFont(bytes);
  const values = await Promise.all([
    doc.loadFont('first', key),
    doc.loadFont('alias', key),
  ]);
  expect(values[0]).toMatch(/^data:font\/ttf;base64,/);
  expect(values[1]).toBe(values[0]);
  expect(loads()).toBe(1);
  expect(reads).toBe(1);
  expect(bytes.equals(original)).toBe(true);

  const other = await doc.loadFont('first', otherKey);
  expect(other).not.toBe(values[0]);
  expect(loads()).toBe(2);
  expect(reads).toBe(2);
  expect(bytes.equals(original)).toBe(true);
  expect(await doc.loadFont('missing', key)).toBeNull();
});

test('rejects a raw font above 4 MiB before encoding', async () => {
  const { doc } = await documentWithFont(new Uint8Array(4 * 1024 * 1024 + 1));
  await expect(doc.loadFont('first', key)).rejects.toMatchObject({
    code: 'RELIC_DOCX_TOO_LARGE',
  });
  expect(reads).toBe(0);
});

test('accepts a 4 MiB font and charges every repeated data URL use', async () => {
  const boundary = await documentWithFont(new Uint8Array(4 * 1024 * 1024));
  expect(await boundary.doc.loadFont('first', key)).toMatch(
    /^data:font\/ttf;base64,/
  );

  const headerBytes = 'data:font/ttf;base64,'.length;
  const rawBytes =
    3 * Math.floor((Math.floor((16 * 1024 * 1024) / 12) - headerBytes) / 4);
  const repeated = await documentWithFont(new Uint8Array(rawBytes));
  for (let i = 0; i < 12; i++) await repeated.doc.loadFont('first', key);
  await expect(repeated.doc.loadFont('first', key)).rejects.toMatchObject({
    code: 'RELIC_DOCX_TOO_LARGE',
  });
  expect(repeated.loads()).toBe(1);
  expect(reads).toBe(2);
});

test('counts missing references and stops after 128 attempts', async () => {
  let attempts = 0;
  const missing = async () => {
    attempts++;
    return null;
  };
  await renderDocument(rendererDocument(128, missing), { h: factory });
  expect(attempts).toBe(128);
  attempts = 0;
  await expect(
    renderDocument(rendererDocument(129, missing), { h: factory })
  ).rejects.toMatchObject({ code: 'RELIC_DOCX_TOO_LARGE' });
  expect(attempts).toBe(128);
});

test('propagates font-budget and DOM-factory errors while skipping ordinary font errors', async () => {
  const limit = Object.assign(new Error('font limit'), {
    code: 'RELIC_DOCX_TOO_LARGE',
  });
  await expect(
    renderDocument(
      rendererDocument(1, async () => {
        throw limit;
      }),
      { h: factory }
    )
  ).rejects.toBe(limit);

  const factoryLimit = new Error('DOM factory limit');
  const boundedFactory = (element: HElement | Node | string): Node => {
    if (
      typeof element === 'object' &&
      element !== null &&
      'tagName' in element &&
      element.tagName === '#comment' &&
      'children' in element &&
      Array.isArray(element.children) &&
      element.children[0] === 'docxjs Fixture Font font'
    )
      throw factoryLimit;
    return factory(element);
  };
  await expect(
    renderDocument(
      rendererDocument(1, async () => null),
      { h: boundedFactory }
    )
  ).rejects.toBe(factoryLimit);

  await renderDocument(
    rendererDocument(1, async () => {
      throw new Error('font unavailable');
    }),
    { h: factory }
  );
});

test('omits metafile numbering image URLs and preserves ordinary numbering images', async () => {
  async function renderNumbering(url: string) {
    const doc = {
      ...rendererDocument(0, async () => null),
      numberingPart: {
        domNumberings: [
          { id: 1, level: 0, bullet: { src: 'rId1', style: {} } },
        ],
      },
      relicOmittedMetafile: false,
      loadNumberingImage: async () => url,
    };
    let css = '';
    const collect = (element: HElement | Node | string): Node => {
      if (
        typeof element === 'object' &&
        element !== null &&
        'tagName' in element &&
        element.tagName === 'style' &&
        'children' in element &&
        Array.isArray(element.children)
      ) {
        css += element.children
          .filter((child): child is string => typeof child === 'string')
          .join('');
      }
      return factory(element);
    };
    await renderDocument(doc, { h: collect });
    return { css, omitted: doc.relicOmittedMetafile };
  }

  for (const type of ['emf', 'wmf']) {
    const { css, omitted } = await renderNumbering(
      `data:image/x-${type};base64,`
    );
    expect(omitted).toBe(true);
    expect(css).toContain('var(--docx-rid1)');
    expect(css).not.toContain('url(');
  }
  const ordinary = await renderNumbering('blob:ordinary-numbering-image');
  expect(ordinary.omitted).toBe(false);
  expect(ordinary.css).toContain('url(blob:ordinary-numbering-image)');
});

function recordStyles() {
  let css = '';
  let documentStylesCreated = false;
  const h = (element: HElement | Node | string): Node => {
    if (
      typeof element === 'object' &&
      element !== null &&
      'tagName' in element &&
      'children' in element &&
      Array.isArray(element.children)
    ) {
      if (
        element.tagName === '#comment' &&
        element.children[0] === 'docxjs document styles'
      )
        documentStylesCreated = true;
      if (element.tagName === 'style')
        css += element.children
          .filter((child): child is string => typeof child === 'string')
          .join('');
    }
    return factory(element);
  };
  return {
    h,
    css: () => css,
    documentStylesCreated: () => documentStylesCreated,
  };
}

function documentWithStyles() {
  return {
    ...rendererDocument(0, async () => null),
    stylesPart: {
      styles: [
        {
          id: 'base',
          target: 'p',
          paragraphProps: {},
          runProps: {},
          styles: [
            {
              target: 'p',
              values: { color: 'red', 'font-weight': 'bold' },
            },
          ],
        },
        {
          id: 'derived',
          target: 'p',
          basedOn: 'base',
          linked: 'linked',
          paragraphProps: {},
          runProps: {},
          styles: [{ target: 'p', values: { color: 'blue' } }],
        },
        {
          id: 'linked',
          target: 'span',
          paragraphProps: {},
          runProps: {},
          styles: [{ target: 'span', values: { 'font-style': 'italic' } }],
        },
      ],
    },
  };
}

test('bounds generated styles without changing inherited or linked CSS', async () => {
  const baseline = recordStyles();
  await renderDocument(documentWithStyles(), { h: baseline.h });
  expect(baseline.css()).toContain(
    'p.docx_derived {\r\n  color: blue;\r\n  font-weight: bold;\r\n}\r\n'
  );
  expect(baseline.css()).toContain(
    'p.docx_derived span {\r\n  font-style: italic;\r\n}\r\n'
  );

  // The inherited declaration is charged before its copy, as well as when
  // emitted. Empty paragraph and run properties add no inheritance charge.
  const inheritedCharge = 'font-weight'.length + 'bold'.length + 16;
  const exactLimit = baseline.css().length + inheritedCharge;
  const exact = recordStyles();
  const exactOptions = { h: exact.h, relicCssLimit: exactLimit };
  await renderDocument(documentWithStyles(), exactOptions);
  expect(exact.css()).toBe(baseline.css());

  const below = recordStyles();
  const belowOptions = { h: below.h, relicCssLimit: exactLimit - 1 };
  await expect(
    renderDocument(documentWithStyles(), belowOptions)
  ).rejects.toMatchObject({
    code: 'RELIC_DOCX_TOO_LARGE',
  });
  expect(below.documentStylesCreated()).toBe(false);
});

test('rejects tiny CSS budgets and bounds inheritance before building a stylesheet', async () => {
  for (const limit of [0, 1]) {
    const recorder = recordStyles();
    const options = { h: recorder.h, relicCssLimit: limit };
    await expect(
      renderDocument(documentWithStyles(), options)
    ).rejects.toMatchObject({
      code: 'RELIC_DOCX_TOO_LARGE',
    });
    expect(recorder.css()).toBe('');
    expect(recorder.documentStylesCreated()).toBe(false);
  }

  const defaultStyles = recordStyles();
  await renderDocument(
    rendererDocument(0, async () => null),
    {
      h: defaultStyles.h,
    }
  );
  const inheritedCharge = 'font-weight'.length + 'bold'.length + 16;
  const recorder = recordStyles();
  const options = {
    h: recorder.h,
    relicCssLimit: defaultStyles.css().length + inheritedCharge - 1,
  };
  await expect(
    renderDocument(documentWithStyles(), options)
  ).rejects.toMatchObject({
    code: 'RELIC_DOCX_TOO_LARGE',
  });
  expect(recorder.css()).toBe(defaultStyles.css());
  expect(recorder.documentStylesCreated()).toBe(false);
});

function documentWithNumberingImage(url: string, style: string | object) {
  return {
    ...rendererDocument(0, async () => null),
    numberingPart: {
      domNumberings: [{ id: 1, level: 0, bullet: { src: 'rId1', style } }],
    },
    loadNumberingImage: async () => url,
  };
}

test('counts numbering CSS at its exact boundary, including raw bullet styles', async () => {
  for (const style of ['width:12px;', {}]) {
    const baseline = recordStyles();
    await renderDocument(
      documentWithNumberingImage('blob:numbering-image', style),
      { h: baseline.h }
    );
    expect(baseline.css()).toContain('url(blob:numbering-image)');
    if (typeof style === 'object')
      expect(baseline.css()).toContain('[object Object]');

    const exact = recordStyles();
    const exactOptions = {
      h: exact.h,
      relicCssLimit: baseline.css().length,
    };
    await renderDocument(
      documentWithNumberingImage('blob:numbering-image', style),
      exactOptions
    );
    expect(exact.css()).toBe(baseline.css());

    const below = recordStyles();
    const belowOptions = {
      h: below.h,
      relicCssLimit: baseline.css().length - 1,
    };
    await expect(
      renderDocument(
        documentWithNumberingImage('blob:numbering-image', style),
        belowOptions
      )
    ).rejects.toMatchObject({ code: 'RELIC_DOCX_TOO_LARGE' });
  }
});

test('propagates a numbering image CSS budget error instead of skipping it', async () => {
  const url = `blob:${'x'.repeat(512)}`;
  const baseline = recordStyles();
  await renderDocument(documentWithNumberingImage(url, ''), { h: baseline.h });
  const rule = `.docx-wrapper { --docx-rid1: url(${url}) }`;
  const ruleStart = baseline.css().indexOf(rule);
  expect(ruleStart).toBeGreaterThanOrEqual(0);
  const recorder = recordStyles();
  const options = {
    h: recorder.h,
    relicCssLimit: ruleStart + rule.length - 1,
  };
  await expect(
    renderDocument(documentWithNumberingImage(url, ''), options)
  ).rejects.toMatchObject({ code: 'RELIC_DOCX_TOO_LARGE' });
  expect(recorder.css()).not.toContain('url(');
});

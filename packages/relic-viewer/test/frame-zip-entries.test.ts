import { expect, test } from 'bun:test';
import { XmlReadBudget } from '../src/document-xml-budget.ts';
import EntryArchive, { ImageBudget } from '../src/frame-zip-entries.ts';

const pixel =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const encode = (text: string) => new TextEncoder().encode(text);

const illustratedSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2" data-名前="東京">
  <title>Résumé 🌍</title>
  <style><![CDATA[rect { fill: url("${pixel}"); }]]></style>
  <image href="${pixel}" width="1" height="1"/>
  <image href="${pixel}" width="1" height="1"/>
  <rect width="2" height="2" style="opacity: .75">
    <animate attributeName="opacity" values=".5;1" dur="1s"/>
  </rect>
</svg>`;

test('counts one repeated embedded raster and preserves the complete SVG bytes', async () => {
  const bytes = encode(illustratedSvg);
  const budget = new ImageBudget(4, 5);
  const archive = await EntryArchive.loadAsync({
    entries: new Map([['illustrated.svg', bytes]]),
    budget,
  });
  const entry = archive.files['illustrated.svg']!;
  const blob = (await entry.async('blob')) as Blob;
  expect(blob).toBeInstanceOf(Blob);
  expect(blob.type).toBe('image/svg+xml');
  expect(await blob.text()).toBe(illustratedSvg);
  expect(await entry.async('blob')).toBe(blob);
  expect(budget.reason).toBeUndefined();

  const limited = new ImageBudget(4, 4);
  expect(limited.admit('illustrated.svg', bytes)).toBe(false);
  expect(limited.reason).toBe('too-large');
});

test('admits a namespace-prefixed SVG and accounts for its embedded image', async () => {
  const svg = `<s:svg xmlns:s="http://www.w3.org/2000/svg" width="2" height="2"><s:image href="${pixel}"/></s:svg>`;
  const bytes = encode(svg);
  const budget = new ImageBudget(4, 5);
  const archive = await EntryArchive.loadAsync({
    entries: new Map([['namespaced.svg', bytes]]),
    budget,
  });
  const blob = (await archive.files['namespaced.svg']!.async('blob')) as Blob;
  expect(blob).toBeInstanceOf(Blob);
  expect(blob.type).toBe('image/svg+xml');
  expect(await blob.text()).toBe(svg);
  const limited = new ImageBudget(4, 4);
  expect(limited.admit('namespaced.svg', bytes)).toBe(false);
  expect(limited.reason).toBe('too-large');

  const nested = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  const outer = encode(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><image href="${nested}"/></svg>`
  );
  expect(new ImageBudget(4, 6).admit('outer.svg', outer)).toBe(true);
  expect(new ImageBudget(4, 5).admit('outer.svg', outer)).toBe(false);
});

test('shares embedded raster charges across SVG entries and the document budget', () => {
  const first = encode(
    `<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><image href="${pixel}"/></svg>`
  );
  const second = encode(
    `<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><image href="${pixel}"/></svg>`
  );
  const exact = new ImageBudget(4, 9);
  expect(exact.admit('first.svg', first)).toBe(true);
  expect(exact.admit('second.svg', second)).toBe(true);
  expect(exact.reason).toBeUndefined();

  const limited = new ImageBudget(4, 8);
  expect(limited.admit('first.svg', first)).toBe(true);
  expect(limited.admit('second.svg', second)).toBe(false);
  expect(limited.reason).toBe('too-large');
});

test('accounts for raster images inside a nested SVG data URL', () => {
  const inner = `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><image href="${pixel}"/></svg>`;
  const nested = `data:image/svg+xml;base64,${Buffer.from(inner).toString('base64')}`;
  const outer = encode(
    `<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><image href="${nested}"/><image href="${nested}"/></svg>`
  );
  expect(new ImageBudget(4, 6).admit('nested.svg', outer)).toBe(true);
  const limited = new ImageBudget(4, 5);
  expect(limited.admit('nested.svg', outer)).toBe(false);
  expect(limited.reason).toBe('too-large');
});

test('charges nested animation against both the per-image and document caps', () => {
  const animation =
    'data:image/gif;base64,R0lGODlhAgACAPAAAP8AAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAgACAAACAoRRACH5BAAKAAAALAAAAAACAAIAgAAA/wAAAAIChFEAOw==';
  const bytes = encode(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><image href="${animation}"/></svg>`
  );
  expect(new ImageBudget(8, 9).admit('animated.svg', bytes)).toBe(true);
  const perImage = new ImageBudget(7, 100);
  expect(perImage.admit('animated.svg', bytes)).toBe(false);
  expect(perImage.reason).toBe('too-large');
  const total = new ImageBudget(8, 8);
  expect(total.admit('animated.svg', bytes)).toBe(false);
  expect(total.reason).toBe('too-large');
});

test('counts stylesheet image references while ignoring labels and CSS content strings', () => {
  const cssImage = encode(
    `<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><style>rect { fill: url('${pixel}') }</style><rect/></svg>`
  );
  expect(new ImageBudget(4, 5).admit('css.svg', cssImage)).toBe(true);
  expect(new ImageBudget(4, 4).admit('css.svg', cssImage)).toBe(false);

  const labels = encode(
    `<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><title>url(${pixel})</title><text aria-label="url(${pixel})">url(${pixel})</text><style>text:after { content: 'url(${pixel})' }</style></svg>`
  );
  expect(new ImageBudget(4, 4).admit('labels.svg', labels)).toBe(true);
});

test('charges the existing XML byte and structure limits before creating an SVG blob', async () => {
  const svg = encode(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><g><rect/><circle/></g></svg>'
  );
  for (const xmlBudget of [
    new XmlReadBudget(svg.length - 1, 4096, 100),
    new XmlReadBudget(4096, 4096, 6),
  ]) {
    const budget = new ImageBudget();
    const archive = await EntryArchive.loadAsync({
      entries: new Map([['drawing.svg', svg]]),
      budget,
      xmlBudget,
    });
    expect(await archive.files['drawing.svg']!.async('blob')).toBeNull();
    expect(budget.reason).toBe('too-large');
  }
});

test('shares the XML byte budget with ordinary document parts', async () => {
  const document = encode('<document><p>One</p></document>');
  const svg = encode(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect/></svg>'
  );
  const budget = new ImageBudget();
  const archive = await EntryArchive.loadAsync({
    entries: new Map([
      ['document.xml', document],
      ['drawing.svg', svg],
    ]),
    budget,
    xmlBudget: new XmlReadBudget(4096, document.length + svg.length - 1, 100),
  });
  expect(await archive.files['document.xml']!.async('string')).toContain('One');
  expect(await archive.files['drawing.svg']!.async('blob')).toBeNull();
  expect(budget.reason).toBe('too-large');
});

test('keeps measurable SVGs with embedded representations the image detector cannot identify', () => {
  const svg = encode(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><image href="data:image/unknown;base64,AQID"/></svg>'
  );
  expect(new ImageBudget(1, 1).admit('unknown.svg', svg)).toBe(true);
});

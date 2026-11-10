import { describe, expect, test } from 'bun:test';
import { COVER_INPUT_PART_BYTES, type CoverSource } from '@relic/format/cover';
import { planCover, TEXT_PREFIX_BYTES } from '../src/cover/inputs.ts';

describe('cover-inputs', () => {
  test('routes markdown to markdown kind with text prefix', async () => {
    const content = new TextEncoder().encode('# Heading\nParagraph text\n');
    const source: CoverSource = {
      filename: 'readme.md',
      mimetype: 'text/markdown',
      rendererClass: 'markdown',
      bytes: content,
    };

    const plan = await planCover(source);
    expect(plan.kind).toBe('render');
    if (plan.kind === 'render') {
      expect(plan.request.kind).toBe('markdown');
      expect(plan.request.input?.mimetype).toBe('text/markdown');
      expect(plan.request.input?.parts).toBe(1);
      expect(plan.inputBytes).toEqual(content);
    }
  });

  test('skips empty or whitespace-only markdown with empty_content', async () => {
    const emptySource: CoverSource = {
      filename: 'empty.md',
      mimetype: 'text/markdown',
      rendererClass: 'markdown',
      bytes: new Uint8Array(0),
    };
    const emptyPlan = await planCover(emptySource);
    expect(emptyPlan.kind).toBe('skip');
    if (emptyPlan.kind === 'skip') {
      expect(emptyPlan.outcome.status).toBe('skipped');
      if (emptyPlan.outcome.status === 'skipped') {
        expect(emptyPlan.outcome.reason).toBe('empty_content');
      }
    }

    const wsSource: CoverSource = {
      filename: 'spaces.md',
      mimetype: 'text/markdown',
      rendererClass: 'markdown',
      bytes: new TextEncoder().encode('   \n  \t  \n  '),
    };
    const wsPlan = await planCover(wsSource);
    expect(wsPlan.kind).toBe('skip');
    if (wsPlan.kind === 'skip') {
      expect(wsPlan.outcome.status).toBe('skipped');
      if (wsPlan.outcome.status === 'skipped') {
        expect(wsPlan.outcome.reason).toBe('empty_content');
      }
    }
  });

  test('cuts markdown larger than 1 MiB at last newline within prefix', async () => {
    const line = 'line of content\n';
    const lineBytes = new TextEncoder().encode(line);
    const repetitions = Math.ceil(
      (TEXT_PREFIX_BYTES + 5000) / lineBytes.length
    );
    const bigText = line.repeat(repetitions);
    const bigBytes = new TextEncoder().encode(bigText);

    const source: CoverSource = {
      filename: 'big.md',
      mimetype: 'text/markdown',
      rendererClass: 'markdown',
      bytes: bigBytes,
    };

    const plan = await planCover(source);
    expect(plan.kind).toBe('render');
    if (plan.kind === 'render') {
      expect(plan.request.kind).toBe('markdown');
      expect(plan.inputBytes).toBeDefined();
      expect(plan.inputBytes?.length).toBeLessThanOrEqual(TEXT_PREFIX_BYTES);
      // Ends with newline
      expect(plan.inputBytes?.[plan.inputBytes?.length - 1]).toBe(0x0a);
    }
  });

  test('routes code to code kind and skips empty code', async () => {
    const code = new TextEncoder().encode('const x = 42;\nconsole.log(x);\n');
    const source: CoverSource = {
      filename: 'script.js',
      mimetype: 'text/javascript',
      rendererClass: 'code',
      bytes: code,
    };

    const plan = await planCover(source);
    expect(plan.kind).toBe('render');
    if (plan.kind === 'render') {
      expect(plan.request.kind).toBe('code');
      expect(plan.request.input?.mimetype).toBe('text/plain');
    }

    const emptyCode: CoverSource = {
      filename: 'empty.py',
      mimetype: 'text/x-python',
      rendererClass: 'code',
      bytes: new TextEncoder().encode('   \n'),
    };
    const emptyPlan = await planCover(emptyCode);
    expect(emptyPlan.kind).toBe('skip');
    if (emptyPlan.kind === 'skip') {
      expect(emptyPlan.outcome.status).toBe('skipped');
      if (emptyPlan.outcome.status === 'skipped') {
        expect(emptyPlan.outcome.reason).toBe('empty_content');
      }
    }
  });

  test('routes html and svg to html kind', async () => {
    const htmlBytes = new TextEncoder().encode('<!doctype html><p>Hello</p>');
    const htmlSource: CoverSource = {
      filename: 'page.html',
      mimetype: 'text/html',
      rendererClass: 'html',
      bytes: htmlBytes,
    };
    const htmlPlan = await planCover(htmlSource);
    expect(htmlPlan.kind).toBe('render');
    if (htmlPlan.kind === 'render') {
      expect(htmlPlan.request.kind).toBe('html');
      expect(htmlPlan.request.input?.mimetype).toBe('text/html');
    }

    const svgBytes = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'
    );
    const svgSource: CoverSource = {
      filename: 'drawing.svg',
      mimetype: 'image/svg+xml',
      rendererClass: 'image',
      bytes: svgBytes,
    };
    const svgPlan = await planCover(svgSource);
    expect(svgPlan.kind).toBe('render');
    if (svgPlan.kind === 'render') {
      // SVG lands on sandboxed-html route, so kind is html
      expect(svgPlan.request.kind).toBe('html');
    }
  });

  test('routes jsx and tsx with proper dialects', async () => {
    const jsxBytes = new TextEncoder().encode(
      'export default function App() { return <div>App</div>; }'
    );
    const jsxSource: CoverSource = {
      filename: 'App.jsx',
      mimetype: 'text/jsx',
      rendererClass: 'jsx',
      bytes: jsxBytes,
    };
    const jsxPlan = await planCover(jsxSource);
    expect(jsxPlan.kind).toBe('render');
    if (jsxPlan.kind === 'render') {
      expect(jsxPlan.request.kind).toBe('jsx');
      expect(jsxPlan.request.dialect).toBe('jsx');
    }

    const tsxSource: CoverSource = {
      filename: 'Widget.tsx',
      mimetype: 'text/tsx',
      rendererClass: 'jsx',
      bytes: jsxBytes,
    };
    const tsxPlan = await planCover(tsxSource);
    expect(tsxPlan.kind).toBe('render');
    if (tsxPlan.kind === 'render') {
      expect(tsxPlan.request.kind).toBe('jsx');
      expect(tsxPlan.request.dialect).toBe('tsx');
      expect(tsxPlan.request.input?.mimetype).toBe('text/tsx');
    }
  });

  test('routes image and pdf to their respective kinds', async () => {
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const imageSource: CoverSource = {
      filename: 'photo.png',
      mimetype: 'image/png',
      rendererClass: 'image',
      bytes: pngBytes,
    };
    const imagePlan = await planCover(imageSource);
    expect(imagePlan.kind).toBe('render');
    if (imagePlan.kind === 'render') {
      expect(imagePlan.request.kind).toBe('image');
      expect(imagePlan.request.input?.mimetype).toBe('image/png');
    }

    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
    const pdfSource: CoverSource = {
      filename: 'doc.pdf',
      mimetype: 'application/pdf',
      rendererClass: 'pdf',
      bytes: pdfBytes,
    };
    const pdfPlan = await planCover(pdfSource);
    expect(pdfPlan.kind).toBe('render');
    if (pdfPlan.kind === 'render') {
      expect(pdfPlan.request.kind).toBe('pdf');
      expect(pdfPlan.request.input?.mimetype).toBe('application/pdf');
    }
  });

  test('never sends declared or byte-recognized models to a cover renderer', async () => {
    const encode = (value: string) => new TextEncoder().encode(value);
    const asciiStl = encode(
      'solid PRIVATE_STL\nfacet normal 0 0 1\nouter loop\n' +
        'vertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\n' +
        'endloop\nendfacet\nendsolid PRIVATE_STL\n'
    );
    const obj = encode('# PRIVATE_OBJ\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
    const binaryStl = new Uint8Array(134);
    // A binary STL header can resemble a different file type.
    binaryStl.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    new DataView(binaryStl.buffer).setUint32(80, 1, true);
    const utf8BoundaryObj = new Uint8Array(262145);
    utf8BoundaryObj.fill(0x20);
    utf8BoundaryObj.set(obj);
    utf8BoundaryObj[obj.length] = 0x23;
    // A valid character straddles the model sniffer's bounded prefix.
    utf8BoundaryObj[262143] = 0xc3;
    utf8BoundaryObj[262144] = 0xa9;
    const objVertices = encode('# PRIVATE_OBJ\nv 0 0 0\nv 1 0 0\nv 0 1 0\n');
    const vertexLine = encode('v 0 0 0\n');
    const lateFace = encode('f 1 2 3\n');
    const vertexCount = Math.ceil(
      (262144 - objVertices.length) / vertexLine.length
    );
    const faceOffset = objVertices.length + vertexCount * vertexLine.length;
    const lateFaceObj = new Uint8Array(faceOffset + lateFace.length);
    lateFaceObj.set(objVertices);
    for (
      let offset = objVertices.length;
      offset < faceOffset;
      offset += vertexLine.length
    ) {
      lateFaceObj.set(vertexLine, offset);
    }
    lateFaceObj.set(lateFace, faceOffset);

    const cases: CoverSource[] = [
      {
        filename: 'unknown',
        mimetype: 'application/octet-stream',
        rendererClass: 'model',
        bytes: encode('unrecognized'),
      },
      {
        filename: 'EMPTY.STL',
        mimetype: 'text/plain',
        rendererClass: 'code',
        bytes: new Uint8Array(),
      },
      {
        filename: 'mesh.Obj',
        mimetype: 'image/png',
        rendererClass: 'image',
        bytes: encode('not a mesh'),
      },
      {
        filename: 'document.txt',
        mimetype: 'MODEL/STL; charset=utf-8',
        rendererClass: 'code',
        bytes: encode('sensitive source'),
      },
      {
        filename: 'document.txt',
        mimetype: 'model/obj',
        rendererClass: 'code',
        bytes: encode('sensitive source'),
      },
      {
        filename: 'document.md',
        mimetype: 'text/markdown',
        rendererClass: 'markdown',
        bytes: asciiStl,
      },
      {
        filename: 'document.html',
        mimetype: 'text/html',
        rendererClass: 'html',
        bytes: obj,
      },
      {
        filename: 'document.txt',
        mimetype: 'text/plain',
        rendererClass: 'code',
        bytes: utf8BoundaryObj,
      },
      {
        filename: 'document.txt',
        mimetype: 'text/plain',
        rendererClass: 'code',
        bytes: lateFaceObj,
      },
      {
        filename: 'unknown',
        mimetype: 'text/plain',
        rendererClass: 'code',
        bytes: encode('v 0 0 0\rv 1 0 0\rv 0 1 0\rf 1 2 3\r'),
      },
      {
        filename: 'document.txt',
        mimetype: 'text/plain',
        rendererClass: 'code',
        bytes: encode(
          'solid test\nfacet\nnormal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid test\n'
        ),
      },
      {
        filename: 'picture.png',
        mimetype: 'image/png',
        rendererClass: 'image',
        bytes: binaryStl,
      },
    ];

    for (const source of cases) {
      expect(await planCover(source)).toEqual({
        kind: 'skip',
        outcome: {
          status: 'skipped',
          reason: 'no_cover_for_class',
          detail:
            'Generic cover used for 3D model (public title and format label only)',
        },
      });
    }
  });

  test('routes binary, WebP, and ICO to no_cover_for_class', async () => {
    // Binary
    const binSource: CoverSource = {
      filename: 'program.bin',
      mimetype: 'application/octet-stream',
      rendererClass: 'binary',
      bytes: new Uint8Array([0x00, 0x01, 0x02, 0x03]),
    };
    const binPlan = await planCover(binSource);
    expect(binPlan.kind).toBe('skip');
    if (binPlan.kind === 'skip') {
      expect(binPlan.outcome.status).toBe('skipped');
      if (binPlan.outcome.status === 'skipped') {
        expect(binPlan.outcome.reason).toBe('no_cover_for_class');
      }
    }

    // WebP (viewer routes to download)
    const webpBytes = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
    ]); // RIFF....WEBP
    const webpSource: CoverSource = {
      filename: 'graphic.webp',
      mimetype: 'image/webp',
      rendererClass: 'image',
      bytes: webpBytes,
    };
    const webpPlan = await planCover(webpSource);
    expect(webpPlan.kind).toBe('skip');
    if (webpPlan.kind === 'skip') {
      expect(webpPlan.outcome.status).toBe('skipped');
      if (webpPlan.outcome.status === 'skipped') {
        expect(webpPlan.outcome.reason).toBe('no_cover_for_class');
      }
    }

    // ICO
    const icoBytes = new Uint8Array([0x00, 0x00, 0x01, 0x00, 0x01, 0x00]);
    const icoSource: CoverSource = {
      filename: 'icon.ico',
      mimetype: 'image/x-icon',
      rendererClass: 'image',
      bytes: icoBytes,
    };
    const icoPlan = await planCover(icoSource);
    expect(icoPlan.kind).toBe('skip');
    if (icoPlan.kind === 'skip') {
      expect(icoPlan.outcome.status).toBe('skipped');
      if (icoPlan.outcome.status === 'skipped') {
        expect(icoPlan.outcome.reason).toBe('no_cover_for_class');
      }
    }
  });

  test('calculates 16 MiB parts for large inputs', async () => {
    // 33 MiB input
    const bigSize = 33 * 1024 * 1024;
    const dummyBig = new Uint8Array(bigSize);
    dummyBig.fill(0x20, 0, 8192);
    dummyBig.set(
      new TextEncoder().encode('<!doctype html><html><body>Large</body></html>')
    );
    const source: CoverSource = {
      filename: 'large.html',
      mimetype: 'text/html',
      rendererClass: 'html',
      bytes: dummyBig,
    };
    const plan = await planCover(source);
    expect(plan.kind).toBe('render');
    if (plan.kind === 'render') {
      expect(plan.request.input?.parts).toBe(
        Math.ceil(bigSize / COVER_INPUT_PART_BYTES)
      );
      expect(plan.request.input?.parts).toBe(3);
    }
  });
});

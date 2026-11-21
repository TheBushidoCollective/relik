import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test.skipIf(!process.env['RELIC_CHROME_PATH'])(
  'sanitizes hostile XHTML, SVG and MathML in a browser',
  async () => {
    const chrome = process.env['RELIC_CHROME_PATH'];
    if (!chrome) throw new Error('RELIC_CHROME_PATH is required');
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, '../src/epub-sanitize.ts')],
      target: 'browser',
      minify: false,
    });
    if (!build.success) throw new Error(build.logs.join('\n'));
    const js = await build.outputs[0]!.text();
    const input = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>hidden metadata</title></head><body id="chapter-start"><p id="x">hello&nbsp;world</p><script>evil()</script><img src="https://evil.invalid/x" onerror="evil()"/><a href="javascript:evil()">bad</a><iframe src="https://evil.invalid"></iframe><object><p>fallback</p></object><svg xmlns="http://www.w3.org/2000/svg"><foreignObject><p>bad</p></foreignObject><use href="https://evil.invalid/x"/><animate attributeName="href" values="https://evil.invalid"/></svg><math xmlns="http://www.w3.org/1998/Math/MathML"><mi href="https://evil.invalid">x</mi><maction><mi>first</mi><mi>second</mi></maction></math></body></html>`;
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="1600" viewBox="0 0 1200 1600"><defs><linearGradient id="gradient"><stop offset="0%" stop-color="#f00"/><stop offset="1" stop-color="blue" stop-opacity="0.5"/></linearGradient><linearGradient id="inherited" href="#gradient" gradientUnits="userSpaceOnUse" gradientTransform="translate(10 20) rotate(30)" spreadMethod="reflect" x1="10" y1="20" x2="100" y2="20"/><radialGradient id="radial" xlink:href="#gradient" fx="25%" fy="75%" fr="10%"/></defs><rect width="100" height="100" fill="url(#inherited)"/><image href="cover" width="100" height="100"/></svg>';
    const page = `<!doctype html><body><script type="module">${js}\nconst entries=new Map([['cover',new Uint8Array([1,2,3])]]);const resources={entries,mediaTypes:new Map([['cover','image/png']]),dataUrls:new Map(),mediaUrls:new Map(),encodedBytes:0,referencedBytes:0,cssBytes:0};const ctx={entries,resources,path:'a.xhtml',chapter:0,chapterByPath:new Map([['a.xhtml',0]]),blobs:[],budget:{nodes:0}}; const el=sanitizeEpubChapter(${JSON.stringify(input).replaceAll('<', '\\u003c')},ctx); document.body.append(el);const svg=sanitizeEpubChapter(${JSON.stringify(svg).replaceAll('<', '\\u003c')},ctx);document.body.append(svg);for(const [chapter,color] of [[1,'rgb(1, 2, 3)'],[2,'rgb(4, 5, 6)']]){ctx.chapter=chapter;const source='<html xmlns="http://www.w3.org/1999/xhtml"><head><style>html:root body[id=&quot;body&quot;] #target{color:'+color+'}</style></head><body id="body"><p id="target">Text</p></body></html>';document.body.append(sanitizeEpubChapter(source,ctx));}document.body.dataset.colors=[1,2].map(i=>getComputedStyle(document.getElementById('ep-'+i+'-target')).color).join('|');document.body.dataset.result=JSON.stringify({text:el.textContent,html:el.innerHTML});</script>`;
    const checks = `
const regressionEncoder=new TextEncoder();
const sharedEntries=new Map([['common.css',regressionEncoder.encode('@font-face{font-family:Shared;src:url(font)} p{font-family:Shared}')],['font',new Uint8Array(1024*1024)]]);
const sharedResources={entries:sharedEntries,mediaTypes:new Map([['common.css','text/css'],['font','font/woff2']]),dataUrls:new Map(),mediaUrls:new Map(),encodedBytes:0,referencedBytes:0,cssBytes:0};
const sharedCtx={entries:sharedEntries,resources:sharedResources,path:'chapter.xhtml',chapter:0,chapterByPath:new Map(),blobs:[],budget:{nodes:0}};
let sharedFaces=0;
for(let i=0;i<48;i++){sharedCtx.chapter=i;const chapter=sanitizeEpubChapter('<html xmlns="http://www.w3.org/1999/xhtml"><head><link rel="stylesheet" href="common.css"/></head><body><p>Text</p></body></html>',sharedCtx);if(chapter.querySelector('style')?.textContent.includes('@font-face'))sharedFaces++;}
document.body.dataset.sharedFont=sharedFaces+':'+(sharedResources.cssBytes<4*1024*1024)+':'+(sharedResources.referencedBytes>1024*1024&&sharedResources.referencedBytes<64*1024*1024);
const orderEntries=new Map([['common.css',regressionEncoder.encode('@font-face{font-family:Shared;src:url(font)}')],['font',new Uint8Array(100*1024)],['other.css',regressionEncoder.encode('@font-face{font-family:Shared;src:url(otherfont)}')],['otherfont',new Uint8Array([4,5,6])]]);
const orderResources={entries:orderEntries,mediaTypes:new Map([['common.css','text/css'],['other.css','text/css'],['font','font/woff2'],['otherfont','font/woff2']]),dataUrls:new Map(),mediaUrls:new Map(),encodedBytes:0,referencedBytes:0,cssBytes:0};
const orderCtx={entries:orderEntries,resources:orderResources,path:'chapter.xhtml',chapter:0,chapterByPath:new Map(),blobs:[],budget:{nodes:0}};
const styleCount=(href,media='')=>{const chapter=sanitizeEpubChapter('<html xmlns="http://www.w3.org/1999/xhtml"><head><link rel="stylesheet" '+media+' href="'+href+'"/></head><body/></html>',orderCtx);return chapter.querySelector('style')?.textContent.includes('@font-face')?1:0;};
document.body.dataset.fontOrder=[styleCount('other.css'),styleCount('common.css'),styleCount('common.css','media="print"')].join(':');
orderEntries.set('variants.css',regressionEncoder.encode('@font-face{font-family:Shared;src:url(font)} @font-face{font-family:Shared;font-style:italic;src:url(otherfont)}'));orderResources.mediaTypes.set('variants.css','text/css');document.body.dataset.fontVariants=[styleCount('variants.css'),styleCount('variants.css')].join(':');
entries.set('print.css',regressionEncoder.encode('p{color:rgb(255,0,0)}'));resources.mediaTypes.set('print.css','text/css');ctx.chapter=40;
const media=sanitizeEpubChapter('<html xmlns="http://www.w3.org/1999/xhtml"><head><style media="screen">p{color:rgb(4,5,6)}</style><style media="print">p{color:rgb(255,0,0)}</style><link rel="stylesheet" media="print" href="print.css"/></head><body><p id="media-test">Text</p></body></html>',ctx);
const gradient=svg.querySelector('#ep-0-inherited');const radial=svg.querySelector('#ep-0-radial');document.body.dataset.gradient=[gradient?.getAttribute('href'),gradient?.getAttribute('gradientUnits'),gradient?.getAttribute('gradientTransform'),gradient?.getAttribute('spreadMethod'),radial?.getAttribute('href'),radial?.getAttribute('fx'),radial?.getAttribute('fy'),radial?.getAttribute('fr')].join('|');
document.body.append(media);document.body.dataset.media=getComputedStyle(document.getElementById('ep-40-media-test')).color;
const largeHeader=new Uint8Array(24);largeHeader.set([137,80,78,71,13,10,26,10]);largeHeader.set([73,72,68,82],12);const largeView=new DataView(largeHeader.buffer);largeView.setUint32(16,10000);largeView.setUint32(20,10000);entries.set('large.png',largeHeader);resources.mediaTypes.set('large.png','image/png');
ctx.chapter=41;const oversizedHtml=sanitizeEpubChapter('<html xmlns="http://www.w3.org/1999/xhtml"><body><img id="large" alt="Diagram" src="large.png"/></body></html>',ctx);document.body.append(oversizedHtml);const htmlPlaceholder=oversizedHtml.querySelector('[data-epub-image-unavailable]');document.body.dataset.unavailableHtml=[htmlPlaceholder?.textContent,htmlPlaceholder?.getAttribute('role'),htmlPlaceholder?.id].join('|');
ctx.chapter=42;const oversizedSvg=sanitizeEpubChapter('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100"><image id="large" href="large.png" width="200" height="40"/></svg>',ctx);document.body.append(oversizedSvg);const svgPlaceholder=oversizedSvg.querySelector('[data-epub-image-unavailable]');document.body.dataset.unavailableSvg=[svgPlaceholder?.querySelector('text')?.textContent,svgPlaceholder?.getAttribute('role'),svgPlaceholder?.id].join('|');
entries.set('mislabeled.jpg',largeHeader);resources.mediaTypes.set('mislabeled.jpg','image/jpeg');ctx.chapter=43;const mislabeled=sanitizeEpubChapter('<html xmlns="http://www.w3.org/1999/xhtml"><body><img alt="Chart" src="mislabeled.jpg"/></body></html>',ctx);document.body.append(mislabeled);document.body.dataset.mislabeled=mislabeled.querySelector('[data-epub-image-unavailable]')?.textContent;
`;
    const end = page.lastIndexOf('</script>');
    const checkedPage = `${page.slice(0, end)}${checks}${page.slice(end)}`;
    const profile = mkdtempSync(join(tmpdir(), 'epub-sanitize-'));
    try {
      const child = spawnSync(
        chrome,
        [
          '--headless',
          '--no-sandbox',
          '--disable-gpu',
          '--host-resolver-rules=MAP * ~NOTFOUND',
          `--user-data-dir=${profile}`,
          '--dump-dom',
          `data:text/html,${encodeURIComponent(checkedPage)}`,
        ],
        {
          encoding: 'utf8',
          timeout: 30000,
          env: { ...process.env, DISPLAY: '', WAYLAND_DISPLAY: '' },
        }
      );
      expect(child.status).toBe(0);
      const html = child.stdout;
      expect(html).toContain('data-colors="rgb(1, 2, 3)|rgb(4, 5, 6)"');
      expect(html).toContain('data-shared-font="1:true:true"');
      expect(html).toContain('data-font-order="1:1:1"');
      expect(html).toContain('data-font-variants="1:0"');
      expect(html).toContain('data-media="rgb(4, 5, 6)"');
      expect(html).toContain(
        'data-gradient="#ep-0-gradient|userSpaceOnUse|translate(10 20) rotate(30)|reflect|#ep-0-gradient|25%|75%|10%"'
      );
      expect(html).toContain(
        'data-unavailable-html="Image unavailable (reader size limit). Diagram|img|ep-41-large"'
      );
      expect(html).toContain(
        'data-unavailable-svg="Image unavailable (reader size limit).|img|ep-42-large"'
      );
      expect(html).toContain(
        'data-mislabeled="Image unavailable (reader size limit). Chart"'
      );
      const start = html.indexOf('<article');
      expect(start).toBeGreaterThanOrEqual(0);
      const article = html.slice(start);
      expect(article).toContain('hello&nbsp;world');
      expect(article).toContain('id="ep-0-chapter-start"');
      expect(article).toContain('fallback');
      expect(article).toContain('<svg');
      expect(article).toContain('data-epub-viewport-width="1200"');
      expect(article).toContain('data-epub-viewport-height="1600"');
      expect(article).toContain('offset="0%"');
      expect(article).toContain('stop-color="#f00"');
      expect(article).toContain('stop-opacity="0.5"');
      expect(article).toContain('data:image/png;base64,AQID');
      expect(article).toContain('first');
      expect(article).not.toContain('hidden metadata');
      expect(article).not.toContain('>second</mi>');
      expect(article).not.toMatch(
        /<script|<iframe|<foreignObject|<animate|onerror=|javascript:|evil\.invalid/i
      );
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
  }
);

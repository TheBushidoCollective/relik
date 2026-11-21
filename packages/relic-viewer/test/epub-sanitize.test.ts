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
    const input = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>hidden metadata</title></head><body><p id="x">hello&nbsp;world</p><script>evil()</script><img src="https://evil.invalid/x" onerror="evil()"/><a href="javascript:evil()">bad</a><iframe src="https://evil.invalid"></iframe><object><p>fallback</p></object><svg xmlns="http://www.w3.org/2000/svg"><foreignObject><p>bad</p></foreignObject><use href="https://evil.invalid/x"/><animate attributeName="href" values="https://evil.invalid"/></svg><math xmlns="http://www.w3.org/1998/Math/MathML"><mi href="https://evil.invalid">x</mi><maction><mi>first</mi><mi>second</mi></maction></math></body></html>`;
    const page = `<!doctype html><body><script type="module">${js}\nconst ctx={entries:new Map(),path:'a.xhtml',chapter:0,chapterByPath:new Map([['a.xhtml',0]]),blobs:[],count:0}; const el=sanitizeEpubChapter(${JSON.stringify(input).replaceAll('<', '\\u003c')},ctx); document.body.append(el); document.body.dataset.result=JSON.stringify({text:el.textContent,html:el.innerHTML});</script>`;
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
          `data:text/html,${encodeURIComponent(page)}`,
        ],
        {
          encoding: 'utf8',
          timeout: 30000,
          env: { ...process.env, DISPLAY: '', WAYLAND_DISPLAY: '' },
        }
      );
      expect(child.status).toBe(0);
      const html = child.stdout;
      const start = html.indexOf('<article');
      expect(start).toBeGreaterThanOrEqual(0);
      const article = html.slice(start);
      expect(article).toContain('hello&nbsp;world');
      expect(article).toContain('fallback');
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

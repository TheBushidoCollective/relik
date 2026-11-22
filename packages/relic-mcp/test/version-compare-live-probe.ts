/**
 * Version comparison on the live service (B5 spec section 6, after deploy).
 *
 * Publishes one untitled relic per format, with a one-day lifetime and no
 * cover, through the built MCP into a scratch state file. Each relic is
 * republished as version 2. Each share URL is then opened in the owned headless
 * shell at 1440x900 and 390x844, and the probe checks the result line, the
 * heading and the Changes count the reader sees. Nothing here prints a URL or a
 * key.
 *
 *   RELIC_COMPARE_PROBE_CONFIRM=publish-three-1-day-relics \
 *   RELIC_CHROME_PATH=<owned headless shell> \
 *   bun packages/relic-mcp/test/version-compare-live-probe.ts
 *
 * RELIC_SERVICE_ORIGIN defaults to https://relik.link. Success ends with
 * VERSION_COMPARE_LIVE_OK, followed by the three relic ids.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Browser,
  DESKTOP,
  type Format,
  HEADING,
  type Harness,
  PHONE,
  SUMMARY,
  TOTAL,
  expectTotal,
  openRelic,
  publishPair,
  settledSummary,
  startComparison,
  text,
  uploadsFor,
} from './version-compare-path.ts';

const CONFIRM = 'publish-three-1-day-relics';

async function main(): Promise<void> {
  if (process.env['RELIC_COMPARE_PROBE_CONFIRM'] !== CONFIRM)
    throw new Error(
      `refusing to publish: set RELIC_COMPARE_PROBE_CONFIRM=${CONFIRM}`
    );
  const chrome = process.env['RELIC_CHROME_PATH'];
  if (chrome === undefined || chrome === '')
    throw new Error(
      'set RELIC_CHROME_PATH to the owned headless shell; the probe never uses a default browser'
    );
  const scratch = await mkdtemp(join(tmpdir(), 'relic-version-compare-live-'));
  const h: Harness = {
    origin: process.env['RELIC_SERVICE_ORIGIN'] ?? 'https://relik.link',
    // Unused on the live service: the frames load from the service's own origin.
    usercontentOrigin: '',
    repo: fileURLToPath(new URL('../../../', import.meta.url)),
    scratch,
    async stop() {
      await rm(scratch, { recursive: true, force: true });
    },
  };
  const ids: Partial<Record<Format, string>> = {};
  try {
    for (const format of ['docx', 'epub', 'xlsx'] as const) {
      const [first, second] = await uploadsFor(format);
      const pair = await publishPair(h, format, first, second, {
        extra: { title: '', cover: false },
        publishOnly: { ttl_days: 1 },
      });
      ids[format] = pair.relicId;
      for (const viewport of [DESKTOP, PHONE]) {
        const label = `${format} ${viewport.width}x${viewport.height}`;
        const b = await Browser.open(viewport, scratch);
        try {
          assert.equal(
            await openRelic(b, pair.url),
            'Compare versions',
            `${label}: the taskbar offers Compare versions`
          );
          await startComparison(b);
          assert.equal(
            await settledSummary(b),
            SUMMARY[format],
            `${label}: the result line`
          );
          assert.equal(
            await text(b, '.diff-view .diff-summary > strong'),
            HEADING[format],
            `${label}: the heading`
          );
          await expectTotal(b, TOTAL[format], label);
          console.log(`VERSION_COMPARE_LIVE ${label} summary=ok`);
        } finally {
          await b.close();
        }
      }
    }
  } finally {
    await h.stop();
  }
  console.log(
    `VERSION_COMPARE_LIVE_OK docx=${ids.docx} epub=${ids.epub} xlsx=${ids.xlsx}`
  );
}

await main();

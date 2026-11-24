#!/usr/bin/env bun
/**
 * Renders packages/relic-viewer/public/card.v1.png, the fallback Open Graph and
 * Twitter unfurl card when a relic has no current cover.
 *
 * Typography: IBM Plex Mono and IBM Plex Sans.
 * Font license: SIL Open Font License, Version 1.1 (OFL 1.1).
 * Copyright 2017-2018 IBM Corp. All rights reserved.
 *
 * Regenerate with:
 *   bun packages/relic-viewer/tools/render-card.ts
 * or:
 *   bun run --cwd packages/relic-viewer tools/render-card.ts
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FONTS = [
  {
    name: 'IBMPlexMono-Regular.ttf',
    url: 'https://raw.githubusercontent.com/IBM/plex/master/packages/plex-mono/fonts/complete/ttf/IBMPlexMono-Regular.ttf',
    sha256: '7c6fbddca4b700be918f5f6183d9bd4464fa427fe435f0b480d77fe2bb8c5a43',
  },
  {
    name: 'IBMPlexMono-SemiBold.ttf',
    url: 'https://raw.githubusercontent.com/IBM/plex/master/packages/plex-mono/fonts/complete/ttf/IBMPlexMono-SemiBold.ttf',
    sha256: 'f04d7c488ddf7d1fa99f2574efc3406ea4cbe17bb1af3a1ab960f84d0c96a172',
  },
  {
    name: 'IBMPlexSans-Regular.ttf',
    url: 'https://raw.githubusercontent.com/IBM/plex/master/packages/plex-sans/fonts/complete/ttf/IBMPlexSans-Regular.ttf',
    sha256: '975dcda37d80f038dcd143c22e33ca2d97a0cc5a929aace1c749153b0fe1afa5',
  },
  {
    name: 'IBMPlexSans-SemiBold.ttf',
    url: 'https://raw.githubusercontent.com/IBM/plex/master/packages/plex-sans/fonts/complete/ttf/IBMPlexSans-SemiBold.ttf',
    sha256: 'a20caf8286023a6a7a85e40b1d2a4ae9fc3e3b1f9eda8f4c542dd4986af67bb1',
  },
] as const;

async function ensureFont(
  cacheDir: string,
  font: (typeof FONTS)[number]
): Promise<string> {
  const filePath = join(cacheDir, font.name);

  let buffer: Buffer | null = null;
  try {
    buffer = await readFile(filePath);
  } catch {
    buffer = null;
  }

  if (buffer) {
    const existingHash = createHash('sha256').update(buffer).digest('hex');
    if (existingHash === font.sha256) {
      return filePath;
    }
  }

  const response = await fetch(font.url);
  if (!response.ok) {
    throw new Error(
      `Failed to download font ${font.name}: ${response.status} ${response.statusText}`
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  const downloadedBuffer = Buffer.from(arrayBuffer);
  const downloadedHash = createHash('sha256')
    .update(downloadedBuffer)
    .digest('hex');

  if (downloadedHash !== font.sha256) {
    throw new Error(
      `Font hash mismatch for ${font.name}: expected ${font.sha256}, got ${downloadedHash}`
    );
  }

  await writeFile(filePath, downloadedBuffer);
  return filePath;
}

async function main() {
  const viewerDir = new URL('..', import.meta.url).pathname;
  const outPath = join(viewerDir, 'public', 'card.v1.png');

  const cacheDir = join(tmpdir(), 'relic-plex-fonts');
  await mkdir(cacheDir, { recursive: true });

  const fontPaths: Record<string, string> = {};
  for (const font of FONTS) {
    fontPaths[font.name] = await ensureFont(cacheDir, font);
  }

  // Render via Python and Pillow. Pillow directly reads FreeType outlines from
  // the pinned font files and provides deterministic subpixel rendering.
  const pythonScript = `
import sys
from PIL import Image, ImageDraw, ImageFont

mono_reg_path = sys.argv[1]
mono_bold_path = sys.argv[2]
sans_reg_path = sys.argv[3]
sans_bold_path = sys.argv[4]
out_png_path = sys.argv[5]

W, H = 1200, 630

# Colors from packages/relic-viewer/src/styles.css
COLOR_GROUND = '#f1f2f0'
COLOR_SURFACE = '#fbfbfa'
COLOR_INK = '#16191a'
COLOR_SOFT_INK = '#5a6163'
COLOR_RULE = '#d2d5d2'
COLOR_STRONG_RULE = '#b3b8b4'
COLOR_PATINA = '#1f6b64'
COLOR_PUNCH_FILL = '#e2e5e1'

img = Image.new('RGB', (W, H), COLOR_GROUND)
draw = ImageDraw.Draw(img)

# Top band y=0 to y=104 filled #fbfbfa, with 2px #b3b8b4 rule along bottom edge
draw.rectangle([0, 0, W, 102], fill=COLOR_SURFACE)
draw.rectangle([0, 102, W, 104], fill=COLOR_STRONG_RULE)

# Punched margin down the left:
# circles centred at x=36, r=9, starting y=52 and repeating every 72px to y<=580,
# fill #e2e5e1 with a 2px #b3b8b4 stroke.
scale = 4
punch_size = 36 * scale
stamp = Image.new('RGBA', (punch_size, punch_size), (0, 0, 0, 0))
sdraw = ImageDraw.Draw(stamp)
scx, scy, sr = punch_size // 2, punch_size // 2, 9 * scale
sdraw.ellipse([scx - sr, scy - sr, scx + sr, scy + sr], fill=COLOR_PUNCH_FILL, outline=COLOR_STRONG_RULE, width=2 * scale)
circle_stamp = stamp.resize((36, 36), Image.Resampling.LANCZOS)

y = 52
while y <= 580:
    img.paste(circle_stamp, (36 - 18, y - 18), circle_stamp)
    y += 72

mono_bold_34 = ImageFont.truetype(mono_bold_path, 34)
mono_reg_20 = ImageFont.truetype(mono_reg_path, 20)
sans_bold_76 = ImageFont.truetype(sans_bold_path, 76)
sans_reg_30 = ImageFont.truetype(sans_reg_path, 30)

def draw_tracked(draw_obj, text, x, y, font, fill, extra_px, align='left'):
    advances = [font.getlength(c) for c in text]
    total_w = sum(advances) + (len(text) - 1) * extra_px
    cur_x = x if align == 'left' else x - total_w
    for c in text:
        draw_obj.text((cur_x, y), c, fill=fill, font=font, anchor='ls')
        cur_x += font.getlength(c) + extra_px
    return total_w

# In the band at x=88, vertically centred: relik.link in IBM Plex Mono SemiBold 34px,
# tight tracking (-0.02em = -0.68px per char).
draw_tracked(draw, 'relik.link', 88, 64, mono_bold_34, COLOR_INK, -0.02 * 34, align='left')

# In the band, right-aligned to x=1112: ACCESSION in IBM Plex Mono Regular 20px,
# letter-spacing about 0.14em (2.8px).
draw_tracked(draw, 'ACCESSION', 1112, 58, mono_reg_20, COLOR_SOFT_INK, 0.14 * 20, align='right')

# Headline at x=88, cap height starting about y=176: An encrypted relik in IBM Plex Sans SemiBold 76px.
draw.text((88, 229), 'An encrypted relik', fill=COLOR_INK, font=sans_bold_76, anchor='ls')

# Below it at x=88, wrapped to a right edge of about x=900, line height about 1.45 (44px).
line1 = 'It opens in your browser. Only someone holding the whole link,'
line2 = 'including the part after the #, can read it.'
draw.text((88, 288), line1, fill=COLOR_SOFT_INK, font=sans_reg_30, anchor='ls')
draw.text((88, 332), line2, fill=COLOR_SOFT_INK, font=sans_reg_30, anchor='ls')

# Field stack starting at y=390, each row 70px tall, three rows closing at y=600.
# Labels in IBM Plex Mono Regular 20px, letter-spacing 0.14em (2.8px), color #5a6163.
# Blank value rules 2px thick, 280px long, starting at x=320 (x=320 to 600), color #b3b8b4.
rows = ['ITEM', 'CLASS', 'CUSTODY']
row_baselines = [432, 502, 572]
row_hairlines = [460, 530, 600]

for label, base_y, line_y in zip(rows, row_baselines, row_hairlines):
    draw_tracked(draw, label, 88, base_y, mono_reg_20, COLOR_SOFT_INK, 0.14 * 20, align='left')
    draw.rectangle([320, base_y, 600, base_y + 2], fill=COLOR_STRONG_RULE)
    draw.line([(88, line_y), (1112, line_y)], fill=COLOR_RULE, width=1)

# 5px #1f6b64 rule along the very bottom edge, y=625 to y=630 (leaves clean 25px from y=600 to 625).
draw.rectangle([0, 625, W, 630], fill=COLOR_PATINA)

img.save(out_png_path, 'PNG', optimize=True)
`;

  const proc = Bun.spawnSync([
    'python3',
    '-c',
    pythonScript,
    fontPaths['IBMPlexMono-Regular.ttf'],
    fontPaths['IBMPlexMono-SemiBold.ttf'],
    fontPaths['IBMPlexSans-Regular.ttf'],
    fontPaths['IBMPlexSans-SemiBold.ttf'],
    outPath,
  ]);

  if (proc.exitCode !== 0) {
    console.error(proc.stderr.toString());
    process.exit(1);
  }

  const file = Bun.file(outPath);
  console.log(`Rendered ${outPath} (${file.size} bytes)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

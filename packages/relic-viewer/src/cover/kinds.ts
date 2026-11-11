import type {
  CoverRenderRequest,
  CoverRenderResult,
} from '@relic/format/cover';
import { contentFromBlob } from '../content.ts';
import { buildCodeTable, buildProse } from '../text-views.ts';
import { renderFrameCover } from './frame.ts';
import {
  fitArtwork,
  fitWaveform,
  layoutArchive,
  readWaveformBounds,
} from './layouts.ts';
import { renderPdfCover } from './pdf.ts';

export async function fetchInputBlob(
  input: NonNullable<CoverRenderRequest['input']>
): Promise<Blob> {
  const parts: Blob[] = [];
  for (let i = 0; i < input.parts; i++) {
    const res = await fetch(`/input/${i}`);
    if (!res.ok) {
      throw new Error(`Failed to fetch input part ${i}: ${res.status}`);
    }
    parts.push(await res.blob());
  }
  return new Blob(parts, { type: input.mimetype });
}

export async function renderKind(
  request: CoverRenderRequest,
  root: HTMLElement
): Promise<CoverRenderResult> {
  if (request.kind === 'archive') {
    if (!request.listing) {
      return {
        ok: false,
        reason: 'empty',
        detail: 'Archive listing missing in render request',
      };
    }
    const cv = document.createElement('div');
    cv.className = 'cv cv-archive';
    const main = document.createElement('main');
    main.className = 'stage';
    const ol = document.createElement('ol');
    ol.className = 'ar';
    main.appendChild(ol);
    cv.appendChild(main);
    root.replaceChildren(cv);

    layoutArchive(cv, request.listing);
    return { ok: true };
  }

  if (!request.input) {
    return {
      ok: false,
      reason: 'decode_failed',
      detail: `Input specification missing for kind ${request.kind}`,
    };
  }

  let blob: Blob;
  try {
    blob = await fetchInputBlob(request.input);
  } catch (err) {
    return {
      ok: false,
      reason: 'decode_failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  switch (request.kind) {
    case 'markdown': {
      const text = await blob.text();
      if (text.trim().length === 0) {
        return {
          ok: false,
          reason: 'empty',
          detail: 'Markdown content is empty',
        };
      }
      const cv = document.createElement('div');
      cv.className = 'cv cv-markdown';
      const main = document.createElement('main');
      main.className = 'stage stage-markdown';
      const doc = document.createElement('div');
      doc.className = 'doc';
      const prose = buildProse(text);
      doc.appendChild(prose);
      main.appendChild(doc);
      cv.appendChild(main);
      root.replaceChildren(cv);
      return { ok: true };
    }

    case 'code': {
      const text = await blob.text();
      if (text.trim().length === 0) {
        return {
          ok: false,
          reason: 'empty',
          detail: 'Code content is empty',
        };
      }
      const cv = document.createElement('div');
      cv.className = 'cv cv-code';
      const main = document.createElement('main');
      main.className = 'stage stage-code';
      const doc = document.createElement('div');
      doc.className = 'doc';
      const table = buildCodeTable(text);
      doc.appendChild(table);
      main.appendChild(doc);
      cv.appendChild(main);
      root.replaceChildren(cv);
      return { ok: true };
    }

    case 'html': {
      const text = await blob.text();
      return renderFrameCover('html', text, undefined, root);
    }

    case 'jsx': {
      const text = await blob.text();
      return renderFrameCover('jsx', text, request.dialect, root);
    }

    case 'image': {
      const cv = document.createElement('div');
      cv.className = 'cv cv-picture cv-image';
      const img = document.createElement('img');
      img.alt = '';
      const url = URL.createObjectURL(blob);
      img.src = url;
      cv.appendChild(img);
      root.replaceChildren(cv);
      try {
        await img.decode();
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          reason: 'decode_failed',
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }

    case 'video': {
      const cv = document.createElement('div');
      cv.className = 'cv cv-picture cv-video';
      const img = document.createElement('img');
      img.alt = '';
      const url = URL.createObjectURL(blob);
      img.src = url;
      cv.appendChild(img);
      root.replaceChildren(cv);
      try {
        await img.decode();
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          reason: 'decode_failed',
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }

    case 'audio-artwork': {
      const cv = document.createElement('div');
      cv.className = 'cv cv-artwork';
      const main = document.createElement('main');
      main.className = 'stage';
      const img = document.createElement('img');
      img.alt = '';
      const url = URL.createObjectURL(blob);
      img.src = url;
      main.appendChild(img);
      cv.appendChild(main);
      root.replaceChildren(cv);
      try {
        await img.decode();
        fitArtwork(cv, img);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          reason: 'decode_failed',
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }

    case 'audio-waveform': {
      const cv = document.createElement('div');
      cv.className = 'cv cv-waveform';
      const main = document.createElement('main');
      main.className = 'stage';
      const wf = document.createElement('div');
      wf.className = 'wf';
      const axis = document.createElement('div');
      axis.className = 'wf-axis';
      const wave = document.createElement('div');
      wave.className = 'wf-wave';
      wf.append(axis, wave);
      main.appendChild(wf);
      cv.appendChild(main);
      root.replaceChildren(cv);

      const url = URL.createObjectURL(blob);
      try {
        const bounds = await readWaveformBounds(url);
        fitWaveform(cv, bounds, url);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          reason: 'decode_failed',
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }

    case 'pdf': {
      return renderPdfCover(await contentFromBlob(blob), root);
    }
  }
}

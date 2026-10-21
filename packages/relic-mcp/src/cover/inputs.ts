import { sniffContentClass } from '@relic/format';
import {
  COVER_INPUT_PART_BYTES,
  type CoverOutcome,
  type CoverRenderRequest,
  type CoverSource,
} from '@relic/format/cover';
import { routeFor } from '@relic/viewer';
import { guessMimetype } from '../publish.ts';
import { parseArchiveListing } from './archive.ts';
import { extractMediaCover } from './media.ts';

export const TEXT_PREFIX_BYTES = 1_048_576; // 1 MiB

export type CoverPlan =
  | {
      readonly kind: 'render';
      readonly request: CoverRenderRequest;
      readonly inputBytes?: Uint8Array;
    }
  | {
      readonly kind: 'skip';
      readonly outcome: CoverOutcome;
    };

export interface PlanCoverOptions {
  readonly ffmpegPath?: string | null | undefined;
}

export async function planCover(
  source: CoverSource,
  options?: PlanCoverOptions
): Promise<CoverPlan> {
  if (
    source.bytes.length === 0 &&
    (source.rendererClass === 'markdown' || source.rendererClass === 'code')
  ) {
    return {
      kind: 'skip',
      outcome: {
        status: 'skipped',
        reason: 'empty_content',
        detail: `${
          source.rendererClass === 'markdown' ? 'Markdown' : 'Code'
        } content is empty`,
      },
    };
  }

  // Generic cover for OTIO: public title and format label only.
  // Detected before media screenshots or archive listing to prevent leaking
  // timeline metadata, track names, or media frames into the unencrypted cover.
  if (
    source.rendererClass === 'otio' ||
    source.filename.toLowerCase().endsWith('.otio') ||
    source.filename.toLowerCase().endsWith('.otioz') ||
    source.filename.toLowerCase().endsWith('.otiod')
  ) {
    return {
      kind: 'skip',
      outcome: {
        status: 'skipped',
        reason: 'no_cover_for_class',
        detail: 'Generic cover used for OTIO (public title and format label only)',
      },
    };
  }

  const declaredMimetype = guessMimetype(source.filename, source.rendererClass);
  const routeDecision = routeFor(
    source.filename,
    declaredMimetype,
    source.bytes
  );
  const route = routeDecision.route;
  switch (route) {
    case 'markdown': {
      let slice = source.bytes;
      if (slice.length > TEXT_PREFIX_BYTES) {
        const prefix = slice.subarray(0, TEXT_PREFIX_BYTES);
        const lastNl = prefix.lastIndexOf(0x0a);
        slice = lastNl !== -1 ? prefix.subarray(0, lastNl + 1) : prefix;
      }
      const text = new TextDecoder('utf-8', { fatal: false }).decode(slice);
      if (text.trim().length === 0) {
        return {
          kind: 'skip',
          outcome: {
            status: 'skipped',
            reason: 'empty_content',
            detail: 'Markdown content is empty or contains only whitespace',
          },
        };
      }
      return {
        kind: 'render',
        request: {
          protocol: 1,
          kind: 'markdown',
          input: {
            bytes: slice.length,
            parts: 1,
            mimetype: 'text/markdown',
          },
        },
        inputBytes: slice,
      };
    }

    case 'code': {
      let slice = source.bytes;
      if (slice.length > TEXT_PREFIX_BYTES) {
        const prefix = slice.subarray(0, TEXT_PREFIX_BYTES);
        const lastNl = prefix.lastIndexOf(0x0a);
        slice = lastNl !== -1 ? prefix.subarray(0, lastNl + 1) : prefix;
      }
      const text = new TextDecoder('utf-8', { fatal: false }).decode(slice);
      if (text.trim().length === 0) {
        return {
          kind: 'skip',
          outcome: {
            status: 'skipped',
            reason: 'empty_content',
            detail: 'Code content is empty or contains only whitespace',
          },
        };
      }
      return {
        kind: 'render',
        request: {
          protocol: 1,
          kind: 'code',
          input: {
            bytes: slice.length,
            parts: 1,
            mimetype: 'text/plain',
          },
        },
        inputBytes: slice,
      };
    }

    case 'sandboxed-html': {
      const parts = Math.max(
        1,
        Math.ceil(source.bytes.length / COVER_INPUT_PART_BYTES)
      );
      return {
        kind: 'render',
        request: {
          protocol: 1,
          kind: 'html',
          input: {
            bytes: source.bytes.length,
            parts,
            mimetype: 'text/html',
          },
        },
        inputBytes: source.bytes,
      };
    }

    case 'sandboxed-jsx': {
      const dialect = source.filename.toLowerCase().endsWith('.tsx')
        ? 'tsx'
        : 'jsx';
      const parts = Math.max(
        1,
        Math.ceil(source.bytes.length / COVER_INPUT_PART_BYTES)
      );
      return {
        kind: 'render',
        request: {
          protocol: 1,
          kind: 'jsx',
          dialect,
          input: {
            bytes: source.bytes.length,
            parts,
            mimetype: dialect === 'tsx' ? 'text/tsx' : 'text/jsx',
          },
        },
        inputBytes: source.bytes,
      };
    }

    case 'image': {
      const parts = Math.max(
        1,
        Math.ceil(source.bytes.length / COVER_INPUT_PART_BYTES)
      );
      return {
        kind: 'render',
        request: {
          protocol: 1,
          kind: 'image',
          input: {
            bytes: source.bytes.length,
            parts,
            mimetype: source.mimetype,
          },
        },
        inputBytes: source.bytes,
      };
    }

    case 'pdf': {
      const parts = Math.max(
        1,
        Math.ceil(source.bytes.length / COVER_INPUT_PART_BYTES)
      );
      return {
        kind: 'render',
        request: {
          protocol: 1,
          kind: 'pdf',
          input: {
            bytes: source.bytes.length,
            parts,
            mimetype: 'application/pdf',
          },
        },
        inputBytes: source.bytes,
      };
    }

    case 'media': {
      const mediaResult = await extractMediaCover(
        source.bytes,
        source.filename,
        source.mimetype,
        options?.ffmpegPath
      );
      if ('status' in mediaResult) {
        return {
          kind: 'skip',
          outcome: mediaResult,
        };
      }
      return {
        kind: 'render',
        request: {
          protocol: 1,
          kind: mediaResult.kind,
          input: {
            bytes: mediaResult.bytes.length,
            parts: 1,
            mimetype: 'image/png',
          },
        },
        inputBytes: mediaResult.bytes,
      };
    }

    case 'download': {
      const isArchive =
        source.rendererClass === 'archive' ||
        sniffContentClass(source.bytes) === 'archive';
      if (isArchive) {
        const archiveResult = parseArchiveListing(
          source.bytes,
          source.filename
        );
        if (!archiveResult.ok) {
          return {
            kind: 'skip',
            outcome: {
              status: 'skipped',
              reason: archiveResult.reason,
              detail: archiveResult.detail,
            },
          };
        }
        return {
          kind: 'render',
          request: {
            protocol: 1,
            kind: 'archive',
            listing: archiveResult.listing,
          },
        };
      }
      return {
        kind: 'skip',
        outcome: {
          status: 'skipped',
          reason: 'no_cover_for_class',
          detail: 'No cover generated for this renderer class',
        },
      };
    }

    default: {
      return {
        kind: 'skip',
        outcome: {
          status: 'skipped',
          reason: 'no_cover_for_class',
          detail: 'No cover generated for this renderer class',
        },
      };
    }
  }
}

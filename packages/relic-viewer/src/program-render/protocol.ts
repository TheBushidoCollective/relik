/**
 * Page protocol for the offline OTIO program renderer.
 *
 * Node loads the built page (index.html + index.js) from a virtual origin. The
 * page's only network access is GET of PROGRAM_MEDIA_PREFIX + encodeURIComponent
 * (bundle_path) for media listed in the request. Nothing else is fetched.
 *
 * Chunks are delivered through a single binding call per chunk, with ONE string
 * argument: `${seq}:${base64}` where seq is a decimal integer and base64 contains
 * no colon. Chunks are sent in order, only after the MP4 is finalized and only on
 * success. The final result carries byte_length and sha256 for verification.
 */
import type { OtioMediaEntry, OtioProgramReasonCode } from '@relic/format';

export const PROGRAM_PAGE_PROTOCOL = 1 as const;
export const PROGRAM_VIRTUAL_ORIGIN = 'https://program.relic.invalid';
export const PROGRAM_MEDIA_PREFIX = `${PROGRAM_VIRTUAL_ORIGIN}/media/`;
export const PROGRAM_AUDIO_CODEC = 'mp4a.40.2' as const;
export const PROGRAM_AUDIO_RATE = 48000 as const;
export const PROGRAM_AUDIO_CHANNELS = 2 as const;
export const PROGRAM_MAX_BYTES = 100 * 1024 * 1024;
export const PROGRAM_MAX_DIMENSION = 4096;
export const PROGRAM_MAX_AREA = 1920 * 1080;
export const PROGRAM_CHUNK_BYTES = 1024 * 1024;

export interface ProgramRational {
  readonly value: number;
  readonly rate: number;
}

export interface ProgramRenderRequest {
  readonly protocol: typeof PROGRAM_PAGE_PROTOCOL;
  /** Index into document.timeline_ids. */
  readonly timeline_index: number;
  /** Exact content.otio text. */
  readonly content: string;
  /** Archive media index, as readOtioDocument consumes it. */
  readonly media: readonly OtioMediaEntry[];
  readonly width: number;
  readonly height: number;
  readonly max_bytes: number;
  /** Proof knob: report the encoder as absent so the result is encoder-unavailable. */
  readonly force_encoder_absent?: boolean;
}

export interface ProgramRenderReason {
  readonly code: OtioProgramReasonCode;
  readonly message: string;
  readonly node_id?: string;
  readonly time?: ProgramRational;
}

export interface ProgramRenderProgram {
  readonly frame_rate: { readonly num: number; readonly den: number };
  readonly frames: number;
  readonly width: number;
  readonly height: number;
  readonly video_codec: string;
  readonly video_bitrate: number;
  readonly audio_codec: typeof PROGRAM_AUDIO_CODEC;
  readonly audio_rate: typeof PROGRAM_AUDIO_RATE;
  readonly channels: typeof PROGRAM_AUDIO_CHANNELS;
  readonly audio_samples: number;
  readonly range: {
    readonly start_time: ProgramRational;
    readonly duration: ProgramRational;
  };
}

export type ProgramRenderResult =
  | {
      readonly ok: true;
      readonly document_sha256: string;
      readonly timeline_id: string;
      readonly program: ProgramRenderProgram;
      readonly byte_length: number;
      readonly sha256: string;
    }
  | {
      readonly ok: false;
      readonly reasons: readonly ProgramRenderReason[];
    };

export interface ProgramPageGlobal {
  readonly protocol: typeof PROGRAM_PAGE_PROTOCOL;
  render(request: ProgramRenderRequest): Promise<ProgramRenderResult>;
}

declare global {
  interface Window {
    __relicProgram?: ProgramPageGlobal;
    /** Installed by the host through Runtime.addBinding. Receives `${seq}:${base64}`. */
    __relicProgramChunk?: (payload: string) => void;
  }
}

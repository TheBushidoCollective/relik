import type { WavePcmHeader } from './otio-wave-pcm';

export const OTIO_PCM_PROTOCOL = 1 as const;
export const OTIO_PCM_MAX_BYTES = 8 * 1024 * 1024;
export const OTIO_PCM_MAX_NODES = 128;
export const OTIO_PCM_MAX_STREAMS = 10;
export const OTIO_PCM_MAX_HORIZON_SECONDS = 0.5;
export const OTIO_PCM_PACKET_FRAMES = 2048;
export const OTIO_PCM_MIN_LEAD_FRAMES = 128;
// Three maximum bridged reads plus packet assembly and bookkeeping.
export const OTIO_PCM_PULL_SCRATCH_BYTES = 512 * 1024;

export type PcmWorkerRequest =
  | {
      protocol: 1;
      kind: 'open';
      generation: number;
      streamId: string;
      requestId: number;
      blob: Blob;
      header: WavePcmHeader;
    }
  | {
      protocol: 1;
      kind: 'pull';
      generation: number;
      streamId: string;
      requestId: number;
      firstFrame: number;
      frameCount: number;
    }
  | { protocol: 1; kind: 'cancel'; generation: number; streamId: string };
export type PcmWorkerResponse =
  | {
      protocol: 1;
      kind: 'ready';
      generation: number;
      streamId: string;
      requestId: number;
      header: WavePcmHeader;
    }
  | {
      protocol: 1;
      kind: 'pcm';
      generation: number;
      streamId: string;
      requestId: number;
      firstFrame: number;
      frameCount: number;
      planes: Float32Array[];
    }
  | {
      protocol: 1;
      kind: 'eos';
      generation: number;
      streamId: string;
      requestId: number;
      finalFrame: number;
    }
  | {
      protocol: 1;
      kind: 'failed';
      generation: number;
      streamId: string;
      requestId: number;
      reason: string;
    };

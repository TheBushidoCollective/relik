/// <reference lib="webworker" />
declare const self: DedicatedWorkerGlobalScope;

import type { OtioVideoTiming } from './otio-video-timing.ts';
import { scanOtioVideoTiming } from './otio-video-timing-scanner.ts';

interface ScanRequest {
  readonly type: 'scan';
  readonly id: number;
  readonly blob: Blob;
  readonly mimeType: string;
}

function isScanRequest(value: unknown): value is ScanRequest {
  if (typeof value !== 'object' || value === null) return false;
  const request = value as Record<string, unknown>;
  return (
    request.type === 'scan' &&
    typeof request.id === 'number' &&
    Number.isSafeInteger(request.id) &&
    request.blob instanceof Blob &&
    typeof request.mimeType === 'string'
  );
}

function unexpectedFailure(): OtioVideoTiming {
  return { kind: 'unknown', reason: 'unsupported-container' };
}

async function scan(request: ScanRequest): Promise<void> {
  let timing: OtioVideoTiming;
  try {
    timing = await scanOtioVideoTiming(request.blob, request.mimeType);
  } catch {
    timing = unexpectedFailure();
  }

  if (timing.kind === 'windows') {
    const transfer: Transferable[] = [
      timing.starts.buffer as ArrayBuffer,
      timing.ends.buffer as ArrayBuffer,
    ];
    self.postMessage({ type: 'result', id: request.id, timing }, transfer);
    return;
  }
  self.postMessage({ type: 'result', id: request.id, timing });
}

self.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (!isScanRequest(event.data)) return;
  void scan(event.data);
});

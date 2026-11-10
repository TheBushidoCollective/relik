/// <reference lib="webworker" />
declare const self: DedicatedWorkerGlobalScope;

import { ModelParseError, parseModel } from './model-parse.ts';
import type { ModelParseResponse } from './model-parse.ts';

self.addEventListener('message', (event: MessageEvent<unknown>) => {
  const value = event.data;
  if (typeof value !== 'object' || value === null) return;
  const request = value as Record<string, unknown>;
  if (
    request.type !== 'parse' ||
    typeof request.id !== 'number' ||
    !Number.isSafeInteger(request.id)
  )
    return;

  const id = request.id;
  try {
    if (request.format !== 'stl' && request.format !== 'obj')
      throw new ModelParseError('invalid-format');
    if (!(request.bytes instanceof ArrayBuffer))
      throw new ModelParseError('invalid-data');
    const model = parseModel(request.format, new Uint8Array(request.bytes));
    const response: ModelParseResponse = {
      type: 'result',
      id,
      ok: true,
      ...model,
    };
    self.postMessage(response, [model.positions.buffer as ArrayBuffer]);
  } catch (error) {
    const response: ModelParseResponse = {
      type: 'result',
      id,
      ok: false,
      error: error instanceof ModelParseError ? error.code : 'internal-error',
    };
    self.postMessage(response);
  }
});

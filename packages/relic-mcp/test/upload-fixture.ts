import { fetchUploader, type ObjectUploader } from '../src/upload.ts';

/** Route test uploads through the fixture's current fetch, including wrappers. */
export async function fetchUpload(
  this: { readonly fetch: typeof globalThis.fetch },
  ...args: Parameters<ObjectUploader>
): Promise<{ readonly status: number }> {
  return fetchUploader(this.fetch)(...args);
}

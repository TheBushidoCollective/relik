import { Sha256 } from '@relic/format';

/** Assemble encrypted chunks into browser Blob storage while hashing incrementally. */
export async function ciphertextBlob(
  source: ReadableStream<Uint8Array>,
  maxBytes = Number.MAX_SAFE_INTEGER
): Promise<{ blob: Blob; digest: string }> {
  const hash = new Sha256();
  const reader = source.getReader();
  let received = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const item = await reader.read();
          if (item.done) {
            reader.releaseLock();
            controller.close();
            return;
          }
          received += item.value.length;
          if (received > maxBytes) {
            await reader.cancel('ciphertext exceeds declared length');
            reader.releaseLock();
            throw new RangeError('ciphertext exceeds declared length');
          }
          hash.update(item.value);
          controller.enqueue(item.value);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel(reason) {
        await reader.cancel(reason);
        reader.releaseLock();
      },
    },
    { highWaterMark: 0 }
  );
  const blob = await new Response(stream).blob();
  return { blob, digest: hash.hex() };
}

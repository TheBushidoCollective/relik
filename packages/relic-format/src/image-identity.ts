async function digestHex(
  bytes: Uint8Array,
  subtle: SubtleCrypto
): Promise<string> {
  const input =
    bytes.buffer instanceof ArrayBuffer
      ? (bytes as Uint8Array<ArrayBuffer>)
      : new Uint8Array(bytes);
  const digest = await subtle.digest('SHA-256', input);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

export async function docxImageSourceDigest(
  entryName: string,
  bytes: Uint8Array,
  subtle: SubtleCrypto = globalThis.crypto.subtle
): Promise<string> {
  const contentDigest = await digestHex(bytes, subtle);
  const identity = JSON.stringify(['docx-image', entryName, contentDigest]);
  return digestHex(new TextEncoder().encode(identity), subtle);
}

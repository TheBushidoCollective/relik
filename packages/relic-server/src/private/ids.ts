/** Random identifiers for rows the private-share store keys by id. */

/** Sixteen random bytes as lowercase hex: 32 characters, unguessable. */
export function randomHexId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

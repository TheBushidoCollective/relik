const CRC32C_TABLE = new Uint32Array(256);
for (let index = 0; index < 256; index++) {
  let value = index;
  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? (value >>> 1) ^ 0x82f63b78 : value >>> 1;
  }
  CRC32C_TABLE[index] = value >>> 0;
}

/** Castagnoli CRC in the big-endian base64 form returned by GCS. */
export class Crc32c {
  private crc = 0xffffffff;

  update(bytes: Uint8Array): this {
    let crc = this.crc;
    for (const byte of bytes) {
      crc = CRC32C_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
    }
    this.crc = crc;
    return this;
  }

  base64(): string {
    const value = (this.crc ^ 0xffffffff) >>> 0;
    return btoa(
      String.fromCharCode(
        value >>> 24,
        (value >>> 16) & 255,
        (value >>> 8) & 255,
        value & 255
      )
    );
  }
}

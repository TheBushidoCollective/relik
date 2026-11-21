type Entry = {
  async(
    type: 'string' | 'blob' | 'uint8array'
  ): Promise<string | Blob | Uint8Array>;
};

/** docx-preview reads an already validated and decompressed package. */
export default class EntryArchive {
  readonly files: Record<string, Entry> = Object.create(null);

  static async loadAsync(
    entries: ReadonlyMap<string, Uint8Array>
  ): Promise<EntryArchive> {
    const archive = new EntryArchive();
    for (const [path, bytes] of entries) {
      archive.files[path] = {
        async async(type) {
          if (type === 'string') return new TextDecoder().decode(bytes);
          if (type === 'uint8array') return bytes;
          if (type === 'blob')
            return new Blob([bytes as Uint8Array<ArrayBuffer>]);
          throw new Error('Unsupported entry type');
        },
      };
    }
    return archive;
  }
}

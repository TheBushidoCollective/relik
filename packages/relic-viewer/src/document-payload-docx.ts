/** Only pass document resources the renderer can display. */
export function includeDocxPart(name: string): boolean {
  return (
    !/^(?:word\/embeddings\/|customXml\/|docProps\/thumbnail)/i.test(name) &&
    !/(?:\.bin|(?:^|\/)thumbnail[^/]*)$/i.test(name)
  );
}

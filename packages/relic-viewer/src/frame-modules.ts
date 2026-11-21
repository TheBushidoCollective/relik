export async function frameModuleText(
  format: 'docx' | 'epub'
): Promise<string> {
  if (format === 'docx') return (await import('./frame-docx-text.ts')).default;
  return (await import('./frame-epub-text.ts')).default;
}

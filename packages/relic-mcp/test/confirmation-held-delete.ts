type Handler = (request: Request) => Promise<Response>;

export function holdDeleteResponse(
  relicId: string,
  commentId: string,
  original: Handler,
  install: (handler: Handler) => void
): { seen: Promise<void>; release(): void } {
  const seen = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  install(async (request) => {
    const response = await original(request);
    if (
      request.method === 'DELETE' &&
      new URL(request.url).pathname ===
        `/api/relics/${encodeURIComponent(relicId)}/comments/${encodeURIComponent(commentId)}`
    ) {
      seen.resolve();
      await gate.promise;
    }
    return response;
  });
  return {
    seen: seen.promise,
    release() {
      install(original);
      gate.resolve();
    },
  };
}

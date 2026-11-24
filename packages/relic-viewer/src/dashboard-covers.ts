import type { ViewerDeps } from './viewer.ts';

/** The most ids the service answers for in one call. */
const IDS_PER_CALL = 100;

/** The only shape of path the service names: a relic's own cover route. */
const COVER_PATH = /^\/[0-9a-z]+\/cover\/[0-9a-f]{64}\.(?:png|jpg)$/;

/**
 * The cover image URL for each named relic that has one.
 *
 * A cover is the picture the relic's link preview shows, which the service
 * already serves to anyone who holds the link, so asking for it spends no open
 * and reads no relic content. A relic with no cover, a private relic, or one
 * the service cannot find is absent from the answer, and a failed call answers
 * nothing: the dashboard keeps its drawn tile.
 */
export async function loadCovers(
  deps: ViewerDeps,
  ids: readonly string[]
): Promise<ReadonlyMap<string, string>> {
  const found = new Map<string, string>();
  for (let start = 0; start < ids.length; start += IDS_PER_CALL) {
    const batch = ids.slice(start, start + IDS_PER_CALL);
    try {
      const response = await deps.fetch(
        `${deps.serviceOrigin}/api/covers?ids=${batch.map(encodeURIComponent).join(',')}`,
        { method: 'GET' }
      );
      if (!response.ok) continue;
      const body: unknown = await response.json();
      if (typeof body !== 'object' || body === null || !('covers' in body)) {
        continue;
      }
      const covers = body.covers;
      if (typeof covers !== 'object' || covers === null) continue;
      for (const [id, path] of Object.entries(covers)) {
        if (
          batch.includes(id) &&
          typeof path === 'string' &&
          COVER_PATH.test(path)
        ) {
          found.set(id, `${deps.serviceOrigin}${path}`);
        }
      }
    } catch {
      // A thumbnail is decoration. Nothing here may break the dashboard.
    }
  }
  return found;
}

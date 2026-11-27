import { RESERVED_SEGMENTS } from '@relic/format';
import { SERVER_ROUTES } from '@relic/format/error-report';

const METHODS: readonly string[] = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
];
const RESERVED: readonly string[] = RESERVED_SEGMENTS;
const PREFIX_PATHS: Readonly<Record<string, true>> = {
  '/health': true,
  '/robots.txt': true,
  '/policy': true,
  '/install': true,
  '/abuse': true,
  '/manifest.webmanifest': true,
  '/favicon.ico': true,
  '/sw.js': true,
  '/sandbox.html': true,
  '/api/challenge': true,
  '/api/grant': true,
  '/api/relics/:id/mint': true,
  '/api/relics/:id/complete': true,
  '/api/relics/:id/republish': true,
  '/api/relics/:id/comments': true,
  '/api/relics/:id/comments/:commentId': true,
  '/api/relics/:id/comments/list': true,
  '/api/auth/request': true,
  '/api/auth/code': true,
  '/api/auth/callback': true,
  '/api/auth/session': true,
};

// Match against the fixed route catalog and return the catalog entry, never any
// portion of the request path. Literal segments win over parameter segments.
const routes = SERVER_ROUTES.filter((route) => route !== 'other')
  .map((route) => {
    const separator = route.indexOf(' ');
    const path = route.slice(separator + 1);
    const method = route.slice(0, separator);
    const segments = path.split('/').filter(Boolean);
    const score = segments.reduce(
      (total, segment) =>
        total + (segment === '*' ? 0 : segment.startsWith(':') ? 1 : 10),
      0
    );
    return {
      route,
      method,
      segments,
      score,
      prefix: PREFIX_PATHS[path] === true,
    };
  })
  .sort((a, b) => b.score - a.score);

export function serverRouteOf(method: string, pathname: string): string {
  const verb = METHODS.includes(method) ? method : 'OTHER';
  const parts = pathname.split('/').filter(Boolean);
  for (const candidate of routes) {
    if (candidate.method !== verb) continue;
    const wildcard = candidate.segments.at(-1) === '*';
    const required = wildcard
      ? candidate.segments.length - 1
      : candidate.segments.length;
    if (
      wildcard || candidate.prefix
        ? parts.length < required
        : parts.length !== required
    )
      continue;
    if (
      candidate.segments[0] === ':id' &&
      (parts[0] === undefined || RESERVED.includes(parts[0]))
    )
      continue;
    let matches = true;
    for (let i = 0; i < required; i += 1) {
      const segment = candidate.segments[i]!;
      if (segment.startsWith(':') ? !parts[i] : segment !== parts[i]) {
        matches = false;
        break;
      }
    }
    if (matches) return candidate.route;
  }
  return 'other';
}

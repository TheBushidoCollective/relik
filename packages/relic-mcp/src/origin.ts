import { HOSTED_SERVICE_ORIGIN } from '@relic/format';

/**
 * Reading the service origin out of the environment.
 *
 * Its own module because the entry point runs a server as a side effect of
 * being imported, and a rule this easy to get wrong deserves tests that do not
 * have to start one.
 */

/**
 * The hosted service, used when nothing names another one.
 *
 * **This reverses what this module used to say**, and the old reasoning is
 * kept here rather than deleted because it was not wrong, it was answering a
 * different question. It read: "There is deliberately no default. A
 * placeholder would turn 'you did not configure me' into a DNS failure on the
 * first publish, and a real origin baked into a published tarball would
 * outlive whatever address the service actually has."
 *
 * The first half still holds and is why the default is a real address rather
 * than a placeholder. The second half was the cost of being a product with
 * one hosted address: `relik.link` is not a guess about where the service
 * might live, it is where it lives, and the plugin manifest and the card
 * raster already carry it.
 *
 * What the reversal buys is the thing it was blocking. The hosted service was
 * printing `--env RELIC_SERVICE_ORIGIN=https://relik.link` in its own install
 * instructions, which asks a recipient of a hosted product to configure which
 * host they are using. That belongs in the repository, for somebody running
 * their own.
 *
 * What it costs is a self-hoster who forgets the variable and publishes to
 * the hosted service instead of their own. That is why `relic_publish`
 * returns the URL it created and `relic_describe_client` names the origin it
 * is pointed at: the destination is visible in the answer rather than
 * inferred from a config file nobody re-reads.
 */
export const DEFAULT_SERVICE_ORIGIN = HOSTED_SERVICE_ORIGIN;

/**
 * Resolve the origin, falling back to the hosted service.
 *
 * Validation is unchanged: whatever is named still has to be https or a
 * loopback host, and a path, query, or fragment is still dropped rather than
 * concatenated into every request URL.
 */
export function resolveOrigin(name: string, raw: string | undefined): string {
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_SERVICE_ORIGIN;
  }
  return requiredOrigin(name, raw);
}

/**
 * Require an origin, or explain what is missing.
 *
 * Kept for the callers that genuinely have no default to fall back on, and
 * for the validation `resolveOrigin` delegates to.
 *
 * Returns the origin only. A path, query, or fragment in the variable is
 * dropped rather than quietly concatenated into every request URL.
 */
export function requiredOrigin(name: string, raw: string | undefined): string {
  if (raw === undefined || raw.trim().length === 0) {
    throw new Error(
      `${name} is not set. It is the Relik service this client publishes to, ` +
        `for example ${DEFAULT_SERVICE_ORIGIN}. Leave it unset to use the ` +
        'hosted service; set it when running your own.'
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error(`${name} is not a URL: ${raw}`);
  }

  // http is allowed only against a loopback host, where there is no network
  // path to sit on. Plaintext never leaves this machine either way, but the
  // grant authorizing an upload does, and over http anyone between here and
  // the service can take it and spend it.
  const loopback =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '[::1]';

  if (parsed.protocol !== 'https:' && !loopback) {
    throw new Error(
      `${name} must be https, or a loopback host for development. Got ${raw}. ` +
        'Plaintext never leaves this machine, but the grant that authorizes ' +
        'an upload does, and over http anyone on the path can take it.'
    );
  }

  return parsed.origin;
}

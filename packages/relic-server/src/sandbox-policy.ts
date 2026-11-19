import { createHash } from 'node:crypto';

/**
 * The usercontent shim's Content-Security-Policy, built from the shell it
 * governs.
 *
 * The shell carries exactly one inline module script, the bundle the build
 * inlines. `script-src` names that script by the SHA-256 of its text and no
 * other script source. `blob:` is the only other source, and the shim uses it
 * for two things: the author scripts it re-emits, and the JSX module. No
 * `unsafe-inline`, `unsafe-eval` or scheme source remains.
 *
 * `frame-src 'none'` and `object-src 'none'` stop the frame creating a child
 * document of any kind. Self-navigation of the frame is governed by the host
 * page's frame-src, which names this document's exact path (app.ts, the shell
 * response). The policy has no `connect-src`, so `default-src 'none'` closes
 * fetch, XHR, WebSocket and EventSource for the shim's document.
 *
 * Measured in packages/relic-mcp/test/csp-first-path.ts (Chrome 149): this
 * policy with the shim's RTC removal closes the routes listed in
 * docs/spec/viewer.md, section 4. It does not govern WebRTC, which CSP does
 * not cover in this build.
 */

const SHIM_SCRIPT = /<script type="module">([\s\S]*?)<\/script>/g;

/** The text of the shell's one inline module script, exactly as served. */
export function shimScriptText(shell: string): string {
  const found = Array.from(shell.matchAll(SHIM_SCRIPT));
  if (found.length !== 1) {
    throw new Error(
      `sandbox.html must carry exactly one inline module script, found ${found.length}`
    );
  }
  return found[0]?.[1] ?? '';
}

export function shimScriptHash(shell: string): string {
  const digest = createHash('sha256')
    .update(shimScriptText(shell), 'utf8')
    .digest('base64');
  return `sha256-${digest}`;
}

/** The directive list and its order are the contract. */
export function sandboxPolicy(serviceOrigin: string, shell: string): string {
  return [
    "default-src 'none'",
    `script-src '${shimScriptHash(shell)}' blob:`,
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    'media-src data: blob:',
    "worker-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    // Framed, the iframe attribute already makes this document opaque. This
    // also covers a direct navigation to the shim, and a commit that somehow
    // lacks the attribute: scripts only, no top navigation, no popups.
    'sandbox allow-scripts',
    `frame-ancestors ${serviceOrigin}`,
  ].join('; ');
}

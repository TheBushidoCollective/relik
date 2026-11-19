/**
 * Round 2 columns for the self-navigation measurement, used by csp-first-path.ts
 * when CSP_FIRST_ROUND=2. Pure data and pure functions: the probe supplies the
 * live origins and the policy strings that depend on them.
 *
 * Embedder frame-src (host page policy), iframe csp attribute (embedded
 * enforcement), sandbox token sets, credentialless, and host-side detection
 * of a navigation via the iframe load event.
 */

export type RunShim = 'production' | 'plain' | 'candidate';
/** Which policy the shim response carries. */
export type ShimCsp = 'none' | 'candidate' | 'production';
/** The host page's frame-src: no host policy, a path, an origin, or none. */
export type HostFrameSrc = 'no-policy' | 'path' | 'origin' | 'none';

export interface Round2Spec {
  readonly shim: RunShim;
  readonly cspKind: ShimCsp;
  readonly hostFrameSrc: HostFrameSrc;
  readonly frameAttrs: string;
  /** Send Allow-CSP-From on the shim response (needed under an iframe csp attribute). */
  readonly shimAllowCsp: boolean;
  /** Send Allow-CSP-From on leaf pages (a navigated document lacking it may be refused). */
  readonly leafAllowCsp: boolean;
}

const DEFAULT_ATTRS = 'sandbox="allow-scripts"';
/** The required policy for the iframe csp attribute (embedded enforcement). */
export const REQUIRED_FRAME_CSP =
  "default-src 'none'; script-src 'unsafe-inline' blob:; frame-src 'none'; connect-src 'none'; object-src 'none'";
const CSP_ATTR = `sandbox="allow-scripts" csp="${REQUIRED_FRAME_CSP}"`;

const base = {
  shimAllowCsp: false,
  leafAllowCsp: false,
} as const;

const SPECS: Record<string, Round2Spec> = {
  control: {
    ...base,
    shim: 'plain',
    cspKind: 'none',
    hostFrameSrc: 'no-policy',
    frameAttrs: DEFAULT_ATTRS,
  },
  hostPath: {
    ...base,
    shim: 'candidate',
    cspKind: 'candidate',
    hostFrameSrc: 'path',
    frameAttrs: DEFAULT_ATTRS,
  },
  hostOrigin: {
    ...base,
    shim: 'candidate',
    cspKind: 'candidate',
    hostFrameSrc: 'origin',
    frameAttrs: DEFAULT_ATTRS,
  },
  hostNone: {
    ...base,
    shim: 'candidate',
    cspKind: 'candidate',
    hostFrameSrc: 'none',
    frameAttrs: DEFAULT_ATTRS,
  },
  hostNoPolicy: {
    ...base,
    shim: 'candidate',
    cspKind: 'candidate',
    hostFrameSrc: 'no-policy',
    frameAttrs: DEFAULT_ATTRS,
  },
  hostPathProd: {
    ...base,
    shim: 'production',
    cspKind: 'production',
    hostFrameSrc: 'path',
    frameAttrs: DEFAULT_ATTRS,
  },
  cspAttrLeafBlock: {
    shim: 'candidate',
    cspKind: 'candidate',
    hostFrameSrc: 'no-policy',
    frameAttrs: CSP_ATTR,
    shimAllowCsp: true,
    leafAllowCsp: false,
  },
  cspAttrLeafAllow: {
    shim: 'candidate',
    cspKind: 'candidate',
    hostFrameSrc: 'no-policy',
    frameAttrs: CSP_ATTR,
    shimAllowCsp: true,
    leafAllowCsp: true,
  },
  cspAttrNoAllowShim: {
    ...base,
    shim: 'candidate',
    cspKind: 'candidate',
    hostFrameSrc: 'no-policy',
    frameAttrs: CSP_ATTR,
  },
  sbForms: {
    ...base,
    shim: 'plain',
    cspKind: 'none',
    hostFrameSrc: 'no-policy',
    frameAttrs: 'sandbox="allow-scripts allow-forms"',
  },
  sbPopups: {
    ...base,
    shim: 'plain',
    cspKind: 'none',
    hostFrameSrc: 'no-policy',
    frameAttrs:
      'sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"',
  },
  sbTopNav: {
    ...base,
    shim: 'plain',
    cspKind: 'none',
    hostFrameSrc: 'no-policy',
    frameAttrs: 'sandbox="allow-scripts allow-top-navigation"',
  },
  sbCredless: {
    ...base,
    shim: 'plain',
    cspKind: 'none',
    hostFrameSrc: 'no-policy',
    frameAttrs: 'sandbox="allow-scripts" credentialless',
  },
  sbSameOrigin: {
    ...base,
    shim: 'plain',
    cspKind: 'none',
    hostFrameSrc: 'no-policy',
    frameAttrs: 'sandbox="allow-scripts allow-same-origin"',
  },
  'sbForms-cand': {
    ...base,
    shim: 'candidate',
    cspKind: 'candidate',
    hostFrameSrc: 'no-policy',
    frameAttrs: 'sandbox="allow-scripts allow-forms"',
  },
  'sbCredless-cand': {
    ...base,
    shim: 'candidate',
    cspKind: 'candidate',
    hostFrameSrc: 'no-policy',
    frameAttrs: 'sandbox="allow-scripts" credentialless',
  },
};

/** The round 2 spec for a column name, or undefined for a round 1 column. */
export function round2Spec(column: string): Round2Spec | undefined {
  return Object.prototype.hasOwnProperty.call(SPECS, column)
    ? SPECS[column]
    : undefined;
}

/** The host page's Content-Security-Policy for an embedder frame-src choice. */
export function hostPolicy(
  kind: HostFrameSrc,
  frameOrigin: string
): string | null {
  const head = "default-src 'none'; script-src 'unsafe-inline'; frame-src ";
  if (kind === 'no-policy') return null;
  if (kind === 'none') return head + "'none'";
  if (kind === 'origin') return head + frameOrigin;
  return head + frameOrigin + '/frame/';
}

/**
 * Detection summary from the host's ordered event log. The first load is the
 * shim's own document, so a second load means the frame navigated away.
 * "egressBeforeNav" is yes when an egress marker arrived before that second load.
 */
export function detectionSummary(events: readonly string[]): string {
  let loads = 0;
  let egressBeforeNav = 'no-egress';
  for (const event of events) {
    if (event === 'load') {
      loads += 1;
      if (loads === 2) break;
      continue;
    }
    if (event.startsWith('probe:egress:') && egressBeforeNav === 'no-egress') {
      egressBeforeNav = 'yes';
    }
  }
  const detected = loads >= 2 ? 'yes' : 'no';
  return `loads=${loads} navDetected=${detected} egressBeforeNav=${egressBeforeNav}`;
}

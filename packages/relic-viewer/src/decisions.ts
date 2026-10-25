/**
 * Decisions, the half the app shell carries.
 *
 * A decision is a signed-in reader approving or rejecting one exact version,
 * confirmed with a passkey. This file holds only what the taskbar needs on
 * every page: reading the list, counting it, and dressing the band control.
 * The panel, the passkey ceremony and the WebAuthn conversion live in
 * `decision-panel.ts`, a chunk loaded on the first press, so a reader who never
 * decides never downloads them.
 *
 * The panel imports nothing at runtime from this file or any other module the
 * shell loads: whatever it needs from here reaches it through the options
 * `main.ts` hands it. A shared runtime import would make the bundler move the
 * shared module out of `viewer.js` into a chunk the shell then loads on every
 * page.
 */

import {
  currentDecisions,
  type DecisionRecord,
  deriveShareProof,
  encodeKey,
  isDecisionVerdict,
  isVersionDigest,
  parseFragment,
  parseRelicId,
} from '@relic/format';
import type { ReadyView, ViewerDeps } from './viewer.ts';

export interface DecisionTally {
  readonly approve: number;
  readonly reject: number;
}

/** Glyphs for the two verdicts, on the same 16-unit grid as the band's set. */
export const DECISION_GLYPHS = {
  approve: 'M6.2 11.6 2.6 8l1-1 2.6 2.6 6.2-6.2 1 1z',
  reject: 'M4 3 8 7l4-4 1 1-4 4 4 4-1 1-4-4-4 4-1-1 4-4-4-4z',
} as const;

export type DecisionListOutcome =
  | {
      readonly kind: 'listed';
      readonly currentVersion: number;
      /** Every record on the requested version, oldest first. */
      readonly records: readonly DecisionRecord[];
    }
  | { readonly kind: 'refused'; readonly code: string };

/** The key this view was opened with, read back off its share link. */
export function viewKey(view: ReadyView): Uint8Array {
  return parseFragment(new URL(view.shareUrl).hash).key;
}

/** The share proof a decision request carries: derived from the key, never it. */
export async function decisionShareProof(key: Uint8Array): Promise<string> {
  return encodeKey(await deriveShareProof(key));
}

function parseRecord(value: unknown): DecisionRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { id, version, verdict, author, created_at, version_digest } =
    value as Record<string, unknown>;
  if (
    typeof id !== 'string' ||
    typeof version !== 'number' ||
    !Number.isSafeInteger(version) ||
    !isDecisionVerdict(verdict) ||
    typeof author !== 'string' ||
    typeof created_at !== 'string' ||
    !isVersionDigest(version_digest)
  ) {
    return undefined;
  }
  return { id, version, verdict, author, created_at, version_digest };
}

/**
 * Reads the decisions recorded on a version, or on every version with `'*'`.
 *
 * No session is needed: anyone holding the link can read them, which is what
 * the disclosure says. The proof derived from the key is what stops anyone
 * holding only the relic id.
 */
export async function listDecisions(
  relicId: string,
  key: Uint8Array,
  version: number | '*',
  deps: ViewerDeps
): Promise<DecisionListOutcome> {
  let response: Response;
  try {
    let canonical = relicId;
    try {
      canonical = parseRelicId(relicId);
    } catch {}
    response = await deps.fetch(
      `${deps.serviceOrigin}/api/relics/${encodeURIComponent(canonical)}/decisions/list`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          share_proof: await decisionShareProof(key),
          version,
        }),
      }
    );
  } catch {
    return { kind: 'refused', code: 'network' };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: 'refused', code: `http_${response.status}` };
  }
  if (!response.ok) {
    const code =
      typeof body === 'object' &&
      body !== null &&
      'code' in body &&
      typeof body.code === 'string'
        ? body.code
        : `http_${response.status}`;
    return { kind: 'refused', code };
  }
  if (typeof body !== 'object' || body === null) {
    return { kind: 'refused', code: 'malformed_decisions' };
  }
  const { current_version, decisions } = body as Record<string, unknown>;
  if (
    typeof current_version !== 'number' ||
    !Number.isSafeInteger(current_version) ||
    !Array.isArray(decisions)
  ) {
    return { kind: 'refused', code: 'malformed_decisions' };
  }
  const records: DecisionRecord[] = [];
  for (const entry of decisions) {
    const record = parseRecord(entry);
    if (record === undefined) {
      return { kind: 'refused', code: 'malformed_decisions' };
    }
    records.push(record);
  }
  return { kind: 'listed', currentVersion: current_version, records };
}

/** What the panel and the band need from a view's key, and nothing else. */
export interface DecisionAccess {
  readonly shareProof: () => Promise<string>;
  /** Lists the records on the view's own version. */
  readonly listDecisions: () => Promise<DecisionListOutcome>;
}

/** Throws when the view's share link carries no parseable key. */
export function decisionAccess(
  view: ReadyView,
  relicId: string,
  deps: ViewerDeps
): DecisionAccess {
  const key = viewKey(view);
  return {
    shareProof: () => decisionShareProof(key),
    listDecisions: () => listDecisions(relicId, key, view.version, deps),
  };
}

/** Each address counts once, by its latest decision on the version. */
export function tallyOf(
  records: readonly DecisionRecord[],
  version: number
): DecisionTally {
  let approve = 0;
  let reject = 0;
  for (const record of currentDecisions(records, version)) {
    if (record.verdict === 'approve') approve += 1;
    else reject += 1;
  }
  return { approve, reject };
}

/** What a listing means for the band: counts, closed (`null`), or not known. */
export function tallyFromList(
  outcome: DecisionListOutcome,
  version: number
): DecisionTally | null | undefined {
  if (outcome.kind === 'listed') return tallyOf(outcome.records, version);
  return outcome.code === 'decision_unavailable' ? null : undefined;
}

function glyph(path: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('icon');
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  node.setAttribute('d', path);
  svg.appendChild(node);
  return svg;
}

/**
 * Dresses the band's Decisions control.
 *
 * `undefined` is the loading state and `null` means decisions are not open on
 * this relic: neither carries numbers, because a `0` before the list lands, or
 * on a relic that cannot take decisions, would be a claim. The attributes are
 * what the stylesheet and the proofs read; the chip is what a reader sees.
 */
export function decorateDecisionControl(
  control: HTMLElement,
  version: number,
  tally: DecisionTally | null | undefined
): void {
  control.classList.add('action-decisions');
  control.setAttribute('data-decision-open', '');
  control.setAttribute('aria-haspopup', 'dialog');
  control.setAttribute('aria-controls', 'decision-panel');
  control.setAttribute('aria-expanded', 'false');
  control.title = 'Approve or reject this version';
  if (tally === undefined) {
    control.setAttribute('aria-label', `Decisions on version ${version}`);
    return;
  }
  if (tally === null) {
    control.setAttribute('aria-label', 'Decisions, not open on this relic yet');
    return;
  }
  control.setAttribute('data-decision-approvals', String(tally.approve));
  control.setAttribute('data-decision-rejections', String(tally.reject));
  control.setAttribute(
    'aria-label',
    `Decisions on version ${version}: ${tally.approve} approved, ` +
      `${tally.reject} rejected`
  );
  const chip = document.createElement('span');
  chip.className = 'decision-tally';
  chip.setAttribute('aria-hidden', 'true');
  for (const verdict of ['approve', 'reject'] as const) {
    const count = tally[verdict];
    const part = document.createElement('span');
    part.className = `tally-${verdict}`;
    part.setAttribute('data-zero', String(count === 0));
    part.append(
      glyph(DECISION_GLYPHS[verdict]),
      document.createTextNode(String(count))
    );
    chip.appendChild(part);
  }
  control.appendChild(chip);
}

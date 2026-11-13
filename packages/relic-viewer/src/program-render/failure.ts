import type { OtioDiagnostic, OtioProgramReasonCode } from '@relic/format';
import type { ProgramRenderReason } from './protocol.ts';

/** Thrown when a timeline cannot be rendered faithfully. Carries the explicit reasons. */
export class ProgramRenderFailure extends Error {
  readonly reasons: readonly ProgramRenderReason[];

  constructor(reasons: readonly ProgramRenderReason[]) {
    super(reasons[0]?.message ?? 'Program render failed');
    this.name = 'ProgramRenderFailure';
    this.reasons = reasons;
  }
}

export function failure(
  code: OtioProgramReasonCode,
  message: string,
  nodeId?: string
): ProgramRenderFailure {
  return new ProgramRenderFailure([
    nodeId === undefined
      ? { code, message }
      : { code, message, node_id: nodeId },
  ]);
}

/**
 * The reason a diagnostic makes a timeline unrenderable, or null when it is
 * informational only. Every non-info diagnostic is fatal, so a warning from
 * the evaluator never becomes silently degraded output.
 */
export function reasonForDiagnostic(
  diagnostic: OtioDiagnostic
): OtioProgramReasonCode | null {
  if (diagnostic.severity === 'info' || diagnostic.code === 'supported') {
    return null;
  }
  switch (diagnostic.code) {
    case 'unsupported-effect':
      return 'unsupported-effect';
    case 'unsupported-schema':
      return 'unsupported-schema';
    case 'unsupported-codec':
      return 'unsupported-codec';
    case 'missing-media':
      return 'missing-media';
    case 'unsupported-browser':
      return 'unsupported-browser';
    case 'invalid-timing':
    case 'missing-handles':
    case 'unplaced-item':
      return 'invalid-timing';
    default:
      return 'render-failed';
  }
}

/** The first fatal diagnostic's reason, or the fallback when none maps. */
export function reasonFromDiagnostics(
  diagnostics: readonly OtioDiagnostic[],
  fallback: OtioProgramReasonCode
): OtioProgramReasonCode {
  for (const diagnostic of diagnostics) {
    const code = reasonForDiagnostic(diagnostic);
    if (code) return code;
  }
  return fallback;
}

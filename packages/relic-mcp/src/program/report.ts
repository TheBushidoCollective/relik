/**
 * What the publish result says about the program. Truthful per timeline:
 * a timeline either carries a rendered program or names the reasons it is
 * focus-only. Nothing is omitted silently. A publish that cannot deliver a
 * manifest for its selected behaviour is refused, not degraded.
 */

import type { OtioProgramReasonCode } from '@relic/format';

/**
 * - rendered: every timeline has a program.
 * - partial: some timelines have a program, the rest are focus-only.
 * - unavailable: every timeline is focus-only; the manifest says why.
 * - not_run: a bare .otio file has no archive to carry a manifest.
 * - not_applicable: the source is not an OTIO bundle.
 */
export type ProgramStatus =
  | 'rendered'
  | 'partial'
  | 'unavailable'
  | 'not_run'
  | 'not_applicable';

export interface ProgramReason {
  readonly code: OtioProgramReasonCode;
  readonly message: string;
  readonly node_id?: string;
  readonly time?: { readonly value: number; readonly rate: number };
}

export interface ProgramTimelineReport {
  readonly timeline_id: string;
  readonly index: number;
  readonly status: 'rendered' | 'unavailable';
  /** Empty when rendered. Non-empty and specific when focus-only. */
  readonly reasons: readonly ProgramReason[];
  /** Present when rendered. */
  readonly program?:
    | {
        readonly bytes: number;
        readonly frames: number;
        readonly width: number;
        readonly height: number;
      }
    | undefined;
}

export interface ProgramReport {
  readonly status: ProgramStatus;
  readonly detail?: string | undefined;
  readonly timelines: readonly ProgramTimelineReport[];
}

export function notApplicableReport(): ProgramReport {
  return { status: 'not_applicable', timelines: [] };
}

export function rawOtioReport(): ProgramReport {
  return {
    status: 'not_run',
    detail:
      'a bare .otio file has no archive to carry a program; publish a .otioz or .otiod to include one',
    timelines: [],
  };
}

/** One paragraph a person can read in the tool transcript. */
export function programText(report: ProgramReport): string {
  if (report.status === 'not_applicable') {
    return '';
  }
  if (report.status === 'not_run') {
    return `Program: not rendered. ${report.detail ?? ''}`.trim();
  }
  const rendered = report.timelines.filter((t) => t.status === 'rendered');
  const lines = [
    `Program: ${report.status}, ${rendered.length} of ${report.timelines.length} timeline(s) playable in the bundle.`,
  ];
  for (const t of report.timelines) {
    if (t.status === 'rendered') {
      lines.push(
        `  ${t.timeline_id}: rendered (${t.program?.frames ?? 0} frames)`
      );
    } else {
      const reasons = t.reasons
        .map((r) => `${r.code}: ${r.message}`)
        .join('; ');
      lines.push(`  ${t.timeline_id}: focus-only. ${reasons}`);
    }
  }
  return lines.join('\n');
}

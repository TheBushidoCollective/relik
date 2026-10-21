/**
 * OpenTimelineIO shared types for Relik.
 *
 * Range meanings:
 * - source_range: authored selection in the item's own coordinates.
 * - available_range: known available range in that same coordinate system.
 * - parent_range: untrimmed editorial placement in the immediate parent.
 * - timeline_range: editorial placement after ancestor trims, playback origin zero.
 * - visible_timeline_range: contribution window, including transition handles,
 *   after ancestor clipping. Null means no exposed contribution.
 */

export interface OtioRationalTime {
  readonly value: number;
  readonly rate: number;
}

export interface OtioTimeRange {
  readonly start_time: OtioRationalTime;
  readonly duration: OtioRationalTime;
}

declare const otioBundleEntryBrand: unique symbol;

/** A canonical, single-decoded OTIOZ archive entry name. */
export type OtioBundleEntryName = string & {
  readonly [otioBundleEntryBrand]: true;
};

export type OtioIdentityOrigin =
  | 'authored'
  | 'derived-unique'
  | 'derived-duplicate';

export interface OtioNodeIdentity {
  readonly id: string;
  readonly origin: OtioIdentityOrigin;
}

export type OtioDiagnosticSeverity = 'info' | 'warning' | 'error';

export type OtioDiagnosticCode =
  | 'supported'
  | 'missing-media'
  | 'unsupported-codec'
  | 'unsupported-effect'
  | 'unsupported-schema'
  | 'invalid-timing'
  | 'unsupported-browser'
  | 'ambiguous-identity'
  | 'missing-handles'
  | 'unplaced-item'
  | 'corrupt-archive'
  | 'unsupported-zip'
  | 'decompression-limit';

export interface OtioDiagnostic {
  readonly severity: OtioDiagnosticSeverity;
  readonly code: OtioDiagnosticCode;
  readonly message: string;
  readonly target?: {
    readonly node_id?: string;
    readonly json_pointer?: string;
    readonly media_key?: string;
  };
}

export interface OtioMediaReference {
  readonly schema: string;
  readonly name?: string;
  readonly available_range?: OtioTimeRange | null;
  readonly target_url?: string | null;
  readonly target_url_base?: string;
  readonly name_prefix?: string;
  readonly name_suffix?: string;
  readonly start_frame?: number;
  readonly frame_step?: number;
  readonly rate?: number;
  readonly frame_zero_padding?: number;
  readonly missing_frame_policy?: 'error' | 'hold' | 'black';
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Parsed reference object. Absent on hand-built fixtures. */
  readonly raw?: unknown;
}

export interface OtioEffect {
  readonly schema: string;
  readonly name?: string;
  readonly effect_name?: string;
  readonly enabled: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly time_scalar?: number;
  /** Parsed effect object, including unknown parameters. */
  readonly raw?: unknown;
}

export interface OtioMarker {
  readonly schema: string;
  readonly name?: string;
  readonly color?: string;
  /**
   * Owning-item coordinates. Null when the authored timing is invalid.
   * Invalid markers are not projected to frame zero.
   */
  readonly marked_range: OtioTimeRange | null;
  readonly comment?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly raw?: unknown;
}

export interface OtioNode {
  readonly id: string;
  readonly identity_origin: OtioIdentityOrigin;
  readonly json_pointer: string;
  readonly schema: string;
  readonly schema_version?: number;
  readonly name: string;
  readonly enabled: boolean;
  readonly parent_id: string | null;
  readonly children_ids: readonly string[];
  readonly track_kind?: 'Video' | 'Audio' | string;
  readonly source_range?: OtioTimeRange | null;
  readonly available_range?: OtioTimeRange | null;
  readonly parent_range?: OtioTimeRange | null;
  readonly timeline_range?: OtioTimeRange | null;
  readonly visible_timeline_range?: OtioTimeRange | null;
  readonly media_references?: Readonly<Record<string, OtioMediaReference>>;
  readonly active_media_reference_key?: string | null;
  readonly effects?: readonly OtioEffect[];
  readonly markers?: readonly OtioMarker[];
  readonly transition_type?: string;
  readonly in_offset?: OtioRationalTime;
  readonly out_offset?: OtioRationalTime;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly diagnostics?: readonly OtioDiagnostic[];
  /** Lossless parsed object. The reader always supplies it. */
  readonly raw?: unknown;
  /** Canonical JSON structural digest, excluding persistent identity metadata. */
  readonly fingerprint?: string;
}

export interface OtioMediaEntry {
  readonly key: string;
  readonly bundle_path: string;
  readonly size: number;
  readonly sha256?: string;
  readonly mime_type?: string;
}

export interface OtioDocumentV1 {
  readonly version: 1;
  readonly document_sha256: string;
  readonly timeline_ids: readonly string[];
  readonly nodes: Readonly<Record<string, OtioNode>>;
  readonly media: Readonly<Record<string, OtioMediaEntry>>;
  readonly diagnostics: readonly OtioDiagnostic[];
  readonly global_start_times?: Readonly<Record<string, OtioRationalTime>>;
}

export type OtioSampleKind = 'media' | 'black';

export interface OtioVideoContribution {
  readonly track_id: string;
  readonly track_index: number;
  readonly node_id: string;
  readonly name: string;
  readonly media_key: string | null;
  readonly bundle_path: OtioBundleEntryName | null;
  /** File-relative when available_range is known. Otherwise the media-coordinate sample, with a diagnostic. */
  readonly source_time: OtioRationalTime;
  readonly source_frame?: number;
  readonly alpha: number;
  readonly transition_weight: number;
  readonly transition_type?: string;
  readonly active_effects: readonly OtioEffect[];
  readonly diagnostics: readonly OtioDiagnostic[];
  readonly ancestry: readonly string[];
  readonly sample_kind: OtioSampleKind;
}

export interface OtioAudioContribution {
  readonly track_id: string;
  readonly track_index: number;
  readonly node_id: string;
  readonly name: string;
  readonly media_key: string | null;
  readonly bundle_path: OtioBundleEntryName | null;
  readonly source_time: OtioRationalTime;
  readonly volume: number;
  readonly transition_weight: number;
  readonly transition_type?: string;
  readonly active_effects: readonly OtioEffect[];
  readonly diagnostics: readonly OtioDiagnostic[];
  readonly ancestry: readonly string[];
  readonly sample_kind: OtioSampleKind;
}

export type OtioVideoComposition =
  | {
      kind: 'stack';
      node_id: string;
      ancestry: readonly string[];
      children: readonly OtioVideoComposition[];
    }
  | {
      kind: 'track';
      node_id: string;
      ancestry: readonly string[];
      transition_id?: string;
      branches: readonly {
        weight: number;
        child: OtioVideoComposition | null;
      }[];
    }
  | {
      kind: 'leaf';
      contribution_index: number;
    };

export interface OtioTimelineMarker {
  readonly marker: OtioMarker;
  readonly owner_node_id: string;
  readonly timeline_range: OtioTimeRange;
}

export interface OtioEvaluationResult {
  readonly timeline_id: string;
  readonly timeline_time: OtioRationalTime;
  readonly video_contributions: readonly OtioVideoContribution[];
  readonly audio_contributions: readonly OtioAudioContribution[];
  readonly active_markers: readonly OtioTimelineMarker[];
  readonly diagnostics: readonly OtioDiagnostic[];
  /** Null when the selected timeline has no video stack to composite. */
  readonly video_composition: OtioVideoComposition | null;
}

/**
 * Directed sample map. timeline_origin is the intersected timeline start.
 * source_origin is the file-relative sample there. scalar preserves direction.
 */
export interface OtioSourceMapping {
  readonly timeline_origin: OtioRationalTime;
  readonly source_origin: OtioRationalTime;
  readonly scalar: number;
}

export interface OtioSourceSpan {
  readonly timeline_id: string;
  readonly track_id: string;
  readonly track_path: readonly string[];
  readonly node_id: string;
  readonly schema: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly timeline_range: OtioTimeRange;
  readonly intersected_timeline_range: OtioTimeRange;
  readonly source_range: OtioTimeRange | null;
  readonly available_range: OtioTimeRange | null;
  readonly file_relative_source_range: OtioTimeRange | null;
  readonly source_mapping: OtioSourceMapping | null;
  readonly media_key: string | null;
  readonly bundle_path: OtioBundleEntryName | null;
  readonly active_media_reference_key: string | null;
  readonly media_references: Readonly<Record<string, OtioMediaReference>>;
  readonly effects: readonly OtioEffect[];
  readonly markers: readonly OtioMarker[];
  readonly diagnostics: readonly OtioDiagnostic[];
  readonly ancestry: readonly string[];
}

export interface OtioAnchorV1 {
  readonly kind: 'otio';
  readonly v: 1;
  readonly relic_version: number;
  readonly document_sha256: string;
  readonly timeline_id: string;
  readonly track_id: string | null;
  readonly item_id?: string;
  readonly range: OtioTimeRange;
  readonly snapshot: {
    readonly timeline: string;
    readonly track: string | null;
    readonly item: string | null;
  };
}

export type OtioProjectionStatus =
  | 'same'
  | 'mapped'
  | 'partial'
  | 'changed'
  | 'ambiguous'
  | 'missing';

export interface OtioAnchorResolution {
  readonly status: OtioProjectionStatus;
  readonly original_anchor: OtioAnchorV1;
  readonly mapped_range?: OtioTimeRange;
  readonly mapped_ranges?: readonly OtioTimeRange[];
  readonly mapped_timeline_id?: string;
  readonly mapped_track_id?: string | null;
  readonly mapped_item_id?: string;
  readonly source_spans: readonly OtioSourceSpan[];
  readonly diagnostics: readonly OtioDiagnostic[];
}

export type InflaterFn = (
  compressedData: Uint8Array,
  uncompressedSize: number,
  maxBytes: number
) => Promise<Uint8Array> | Uint8Array;

export interface OtioZipEntryInfo {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly crc32: number;
  readonly dataOffset: number;
  readonly isDirectory: boolean;
}

export interface OtioZipIndex {
  readonly entries: ReadonlyMap<string, OtioZipEntryInfo>;
  readonly versionText: string;
  readonly contentOtioBytes: Uint8Array;
  readonly contentSha256: string;
  readonly readEntry: (
    name: string,
    customInflater?: InflaterFn
  ) => Promise<Uint8Array>;
}

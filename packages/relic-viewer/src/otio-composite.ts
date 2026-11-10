/**
 * OpenTimelineIO video compositor. Walks the evaluator's stack/track tree and
 * draws prepared leaves onto a 2D canvas. Shared by the viewer's playback and
 * the offline program renderer, so both produce the same pixels for the same
 * evaluation.
 */

export type OtioVideoCompositionTree =
  | {
      readonly kind: 'stack';
      readonly node_id: string;
      readonly ancestry: readonly string[];
      readonly children: readonly OtioVideoCompositionTree[];
    }
  | {
      readonly kind: 'track';
      readonly node_id: string;
      readonly ancestry: readonly string[];
      readonly transition_id?: string;
      readonly branches: readonly {
        readonly weight: number;
        readonly child: OtioVideoCompositionTree | null;
      }[];
    }
  | {
      readonly kind: 'leaf';
      readonly contribution_index: number;
    };

export type OtioPreparedLeaf =
  | {
      readonly kind: 'image';
      readonly source: CanvasImageSource;
      readonly alpha: number;
    }
  | { readonly kind: 'black' }
  | { readonly kind: 'empty' };

export function renderOtioVideoTree(
  output: CanvasRenderingContext2D,
  width: number,
  height: number,
  tree: OtioVideoCompositionTree | null,
  leaves: readonly (OtioPreparedLeaf | null)[],
  checkout: (depth: number) => HTMLCanvasElement,
  hidden?: (nodeId: string, ancestry: readonly string[]) => boolean
): 'painted' | 'empty' | 'failed' {
  try {
    const root = tree
      ? paintNode(tree, 0, width, height, leaves, checkout, hidden)
      : null;
    output.globalCompositeOperation = 'source-over';
    output.globalAlpha = 1;
    output.fillStyle = '#000000';
    output.fillRect(0, 0, width, height);
    if (!root) return 'empty';
    output.globalCompositeOperation = 'source-over';
    output.globalAlpha = 1;
    output.drawImage(root, 0, 0, width, height);
    return 'painted';
  } catch {
    return 'failed';
  }
}

function paintNode(
  node: OtioVideoCompositionTree,
  depth: number,
  width: number,
  height: number,
  leaves: readonly (OtioPreparedLeaf | null)[],
  checkout: (depth: number) => HTMLCanvasElement,
  hidden?: (nodeId: string, ancestry: readonly string[]) => boolean
): HTMLCanvasElement | null {
  if (node.kind !== 'leaf' && hidden?.(node.node_id, node.ancestry)) {
    return null;
  }
  if (node.kind === 'leaf') {
    const leaf = leaves[node.contribution_index] ?? null;
    if (!leaf) throw new Error('Composition leaf is unavailable');
    if (leaf.kind === 'empty') return null;
    const surface = checkout(depth);
    const ctx = surface.getContext('2d');
    if (!ctx) throw new Error('Canvas surface context unavailable');
    ctx.clearRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'source-over';
    if (leaf.kind === 'black') {
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, width, height);
    } else {
      ctx.globalAlpha = clamp01(leaf.alpha);
      ctx.drawImage(leaf.source, 0, 0, width, height);
    }
    ctx.globalAlpha = 1;
    return surface;
  }

  if (node.kind === 'stack') {
    let surface: HTMLCanvasElement | null = null;
    let ctx: CanvasRenderingContext2D | null = null;
    for (const child of node.children) {
      const painted = paintNode(
        child,
        depth + 1,
        width,
        height,
        leaves,
        checkout,
        hidden
      );
      if (!painted) continue;
      if (!surface || !ctx) {
        surface = checkout(depth);
        ctx = surface.getContext('2d');
        if (!ctx) throw new Error('Canvas surface context unavailable');
        ctx.clearRect(0, 0, width, height);
        ctx.globalAlpha = 1;
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.drawImage(painted, 0, 0, width, height);
    }
    return surface;
  }

  let surface: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  for (const branch of node.branches) {
    if (!branch.child || !(branch.weight > 0)) continue;
    const painted = paintNode(
      branch.child,
      depth + 1,
      width,
      height,
      leaves,
      checkout,
      hidden
    );
    if (!painted) continue;
    if (!surface || !ctx) {
      surface = checkout(depth);
      ctx = surface.getContext('2d');
      if (!ctx) throw new Error('Canvas surface context unavailable');
      ctx.clearRect(0, 0, width, height);
      ctx.globalAlpha = 1;
    }
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = clamp01(branch.weight);
    ctx.drawImage(painted, 0, 0, width, height);
  }
  if (ctx) {
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
  return surface;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

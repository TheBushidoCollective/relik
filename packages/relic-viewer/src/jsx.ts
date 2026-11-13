/**
 * The JSX leg of rendering: text in, text out, never execution.
 *
 * The service origin holds the decryption key, so it must never run a byte of
 * relic content. Sucrase's transform is a compiler, not an interpreter: it
 * rewrites JSX syntax into `React.createElement` calls and returns a string.
 * The string is posted to the usercontent frame, and only there does it become
 * running code. That split is the whole design; anything that evaluates the
 * source on this origin is a boundary break, not a convenience.
 *
 * The mount contract is a default export: the frame imports the module and
 * renders `module.default` as the component.
 *
 * Only routing loads this module, and it does so dynamically, which keeps the
 * transform out of the eager viewer shell.
 */

import { transform } from 'sucrase';

/**
 * Rewrite component source into plain JavaScript.
 *
 * Throws on source that does not parse, which is how the routing decision
 * tells a component from prose wearing a component's name.
 */
export function transpileJsx(source: string, filename: string): string {
  return transform(source, {
    // The `.tsx` extension selects the TypeScript dialect; a `.tsx` file and
    // a `.jsx` file differ only in which grammar the transform accepts.
    transforms: filename.toLowerCase().endsWith('.tsx')
      ? ['jsx', 'typescript']
      : ['jsx'],
    // Classic runtime: the output references the `React` binding directly,
    // and the frame supplies that binding as `globalThis.React`, set to the
    // one React instance bundled into the sandbox page. The automatic
    // runtime would emit a bare `react/jsx-runtime` specifier, which nothing
    // inside an opaque-origin frame can resolve or fetch.
    jsxRuntime: 'classic',
    // Dev-mode output decorates every element with `__source`/`__self` for
    // stack traces. This is somebody else's component, not a debugging
    // session, and the extra props only bloat the posted string.
    production: true,
  }).code;
}

/**
 * Whether the bytes are a mountable component module: they parse under the
 * JSX transform and export something for the frame to render.
 *
 * This is the viewer's JSX sniffer. `sniffContentClass` cannot recognize JSX
 * without a parser, and `@relic/format` stays dependency-free, so the question
 * is asked here, where the compiler already lives. A module that parses but
 * exports nothing would still run its side effects in the frame and leave
 * nothing to render, so the default export is part of the sniff, not a detail
 * left to fail later.
 */
export function isComponentSource(source: string, filename: string): boolean {
  let code: string;
  try {
    code = transpileJsx(source, filename);
  } catch {
    return false;
  }
  return /\bexport\s+default\b/.test(code);
}

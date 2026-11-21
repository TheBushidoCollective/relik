import { describe, expect, test } from 'bun:test';

/**
 * The chain that gives the sandboxed frame its height.
 *
 * Rendered geometry belongs in a browser. What is checkable here is the chain,
 * and the chain is what broke twice in one day, in opposite directions.
 *
 * First, `height: calc(100vh - var(--bar-height))` guessed the taskbar, which
 * carries a min-height, so the frame came out taller than the row and the row
 * grew a scrollbar beside the iframe's own.
 *
 * Then the fix for that put the flex container on `.stage` and the fill on the
 * frame, skipping the `.doc` wrapper that `renderSandboxedHtml` puts between
 * them. The flex properties applied to something that was not a flex child and
 * did nothing, while the height they replaced was the only thing sizing the
 * iframe, which collapsed to its intrinsic 300x150 in production.
 *
 * So this file checks the whole chain, element by element, rather than any one
 * declaration in it.
 */
function fillChainFaults(
  source: string,
  route: 'html' | 'jsx' | 'document' = 'html'
): readonly string[] {
  // Comments first, or the checker reads prose instead of a declaration.
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const faults: string[] = [];
  const rule = (selector: string): string => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rules = css.matchAll(
      new RegExp(`${escaped}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, 'g')
    );
    return Array.from(rules, (match) => match[1]).join('\n');
  };

  const scope = `.stage-sandboxed-${route}`;
  const documentRoute = route === 'document';
  const stage = rule(
    documentRoute ? `${scope}:has(> .doc > .usercontent-frame)` : scope
  );
  const doc = rule(
    documentRoute
      ? `${scope} > .doc:has(> .usercontent-frame)`
      : `${scope} .doc`
  );
  const frame = rule(
    documentRoute
      ? `${scope} > .doc > .usercontent-frame`
      : `${scope} .usercontent-frame`
  );

  if (!/height:\s*100%/.test(stage)) {
    faults.push('the stage does not take the height of the row');
  }
  if (
    !/display:\s*flex/.test(stage) ||
    !/flex-direction:\s*column/.test(stage)
  ) {
    faults.push('the stage cannot hand height to its children');
  }
  if (!/flex:\s*1/.test(doc)) {
    faults.push('the wrapper is not in the chain, so the frame gets nothing');
  }
  if (!/min-height:\s*0/.test(doc)) {
    faults.push("the wrapper's automatic minimum can still overflow the row");
  }
  if (/calc\(\s*100[vd]h/.test(frame)) {
    faults.push('the frame guesses the chrome height with a viewport reserve');
  }
  if (documentRoute) {
    if (
      !/display:\s*flex/.test(doc) ||
      !/flex-direction:\s*column/.test(doc) ||
      !/flex:\s*1 1 0\s*;/.test(frame) ||
      !/min-height:\s*0/.test(frame)
    ) {
      faults.push(
        'the document frame cannot fill the space below its link strip'
      );
    }
    if (!/position:\s*relative/.test(doc)) {
      faults.push(
        'the document wrapper does not anchor the confirmation overlay'
      );
    }
  } else if (!/height:\s*100%/.test(frame)) {
    faults.push('the frame has no height, so it falls back to 300x150');
  }
  return faults;
}

describe('the sandboxed fill chain', () => {
  test('every link in it is present', async () => {
    const css = await Bun.file(
      new URL('../src/styles.css', import.meta.url)
    ).text();
    expect(fillChainFaults(css)).toEqual([]);
    expect(fillChainFaults(css, 'jsx')).toEqual([]);
    expect(fillChainFaults(css, 'document')).toEqual([]);
  });

  test('it names the reserve that grew a second scrollbar', () => {
    // Verbatim, as it shipped.
    const reserve = `
      .stage-sandboxed-html, .stage-sandboxed-jsx { padding: 0; }
      .stage-sandboxed-html .usercontent-frame,
      .stage-sandboxed-jsx .usercontent-frame {
        display: block;
        height: calc(100vh - var(--bar-height));
        border: 0;
      }
    `;
    expect(fillChainFaults(reserve)).toEqual([
      'the stage does not take the height of the row',
      'the stage cannot hand height to its children',
      'the wrapper is not in the chain, so the frame gets nothing',
      "the wrapper's automatic minimum can still overflow the row",
      'the frame guesses the chrome height with a viewport reserve',
      'the frame has no height, so it falls back to 300x150',
    ]);
  });

  test('it names the skipped wrapper that collapsed the frame', () => {
    // Verbatim, as the reverted fix shipped. This is the case a checker on the
    // frame alone called clean, which is why the chain is checked instead.
    const skipped = `
      .stage-sandboxed-html, .stage-sandboxed-jsx {
        display: flex;
        flex-direction: column;
        height: 100%;
        padding: 0;
      }
      .stage-sandboxed-html .usercontent-frame,
      .stage-sandboxed-jsx .usercontent-frame {
        display: block;
        flex: 1 1 auto;
        min-height: 0;
        border: 0;
      }
    `;
    expect(fillChainFaults(skipped)).toEqual([
      'the wrapper is not in the chain, so the frame gets nothing',
      "the wrapper's automatic minimum can still overflow the row",
      'the frame has no height, so it falls back to 300x150',
    ]);
  });

  test('nothing in the stylesheet subtracts the chrome', async () => {
    const css = (
      await Bun.file(new URL('../src/styles.css', import.meta.url)).text()
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    const reserves = [...css.matchAll(/calc\([^)]*100[vd]h[^)]*-[^)]*\)/g)].map(
      (match) => match[0]
    );
    expect(reserves).toEqual([]);
  });

  test('the row is still the only scroller above the frame', async () => {
    const css = await Bun.file(
      new URL('../src/styles.css', import.meta.url)
    ).text();
    expect(/\.stage-wrap\s*\{[^}]*overflow:\s*auto/.test(css)).toBe(true);
    expect(/\.stage-wrap\s*>\s*\.stage\s*\{[^}]*overflow/.test(css)).toBe(
      false
    );
  });
});

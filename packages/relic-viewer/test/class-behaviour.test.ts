/**
 * Assert routeForClass and CLASS_BEHAVIOUR agree across every renderer class.
 *
 * The server writes a sentence telling a recipient what opening this link will
 * do. It reads that outcome from CLASS_BEHAVIOUR, while routeForClass in the
 * viewer is what actually happens when the recipient opens the link.
 *
 * When they disagree, the card makes a false statement to a recipient on an
 * unfamiliar domain, which is the failure the card exists to prevent. A failure
 * in this test means the server copy and the viewer routing have drifted apart.
 *
 * This test is a correction of a shipped defect: media was described as
 * downloading because isRenderable was used as a description of the viewer.
 * The viewer routes media to an in-browser audio or video player rather than
 * downloading it to the device, so the card told recipients the wrong thing.
 */

import { describe, expect, test } from 'bun:test';
import { CLASS_BEHAVIOUR, RENDERER_CLASSES } from '@relic/format';
import { type RenderRoute, routeForClass } from '../src/viewer.ts';

const RENDER_ROUTES: readonly RenderRoute[] = [
  'markdown',
  'code',
  'image',
  'sandboxed-html',
  'sandboxed-jsx',
  'pdf',
];

describe('routeForClass and CLASS_BEHAVIOUR agreement', () => {
  test('all ten renderer classes agree between viewer routing and class behaviour in both directions', () => {
    expect(RENDERER_CLASSES.length).toBe(10);

    for (const cls of RENDERER_CLASSES) {
      const behaviour = CLASS_BEHAVIOUR[cls];
      const route = routeForClass(cls);

      // downloads if and only if the route is download
      if (behaviour === 'downloads') {
        expect(route).toBe('download');
      }
      if (route === 'download') {
        expect(behaviour).toBe('downloads');
      }

      // plays if and only if the route is media or otio
      if (behaviour === 'plays') {
        expect(['media', 'otio']).toContain(route);
      }
      if (route === 'media' || route === 'otio') {
        expect(behaviour).toBe('plays');
      }
      // renders if and only if the route is one of the render routes
      if (behaviour === 'renders') {
        expect(RENDER_ROUTES).toContain(route);
      }
      if (RENDER_ROUTES.includes(route)) {
        expect(behaviour).toBe('renders');
      }
    }
  });
});

/**
 * Runs every sham check on the two real builds: each build's routing, the sham diff against
 * production, and its negative controls. Returns every failure. Empty means the sham is trusted.
 */

import {
  readBuild,
  verifyRouting,
  type ViewerBuild,
} from './otio-program-builds.ts';
import {
  verifyShamControls,
  verifyShamSites,
} from './otio-program-sham-check.ts';

export async function checkShamBuilds(
  production: ViewerBuild,
  sham: ViewerBuild
): Promise<string[]> {
  const routing = [
    ...(await verifyRouting(production)),
    ...(await verifyRouting(sham)),
  ];
  if (routing.length) return routing;
  const productionBytes = await readBuild(production);
  const shamBytes = await readBuild(sham);
  return [
    ...verifyShamSites(productionBytes, shamBytes),
    ...verifyShamControls(productionBytes, shamBytes),
  ];
}

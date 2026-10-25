/**
 * Strings for loading progress, static plate, and browser-facing errors.
 * Verbatim from docs/design/surface.md.
 */

export const LOAD_EXPLANATION =
  "The file in this link is decrypted in your browser. The key is in the link and your browser never sends it to Relic's servers.";

export const LOAD_OPENING = 'Opening\u2026';
export const PHASE_FETCHING = 'Fetching';
export const PHASE_DECRYPTING = 'Decrypting';
export const PHASE_RENDERING = 'Rendering';

export const TRANSFER_LABEL = 'TRANSFER';
export const CONTENTS_LABEL = 'CONTENTS';

export const REPORT_LINK_LABEL = 'Report this relic';
export const POLICY_LINK_LABEL = 'How Relic handles your data';

export const NOSCRIPT_TITLE = 'This page needs JavaScript to open a relic.';
export const NOSCRIPT_DETAIL =
  "Relic decrypts the file in your browser, so with JavaScript off there is nothing here to decrypt it with. Nothing has been sent to Relic's servers and the key in this link has not been used, so the link still works in a browser that runs JavaScript.";

export const INSECURE_TITLE =
  'This page did not arrive over a secure connection';
export const INSECURE_DETAIL =
  'Browsers only allow the decryption Relic uses on a secure connection, and this one is not on it. Relic serves every relic over HTTPS, so something between this browser and Relic changed that. On a company, campus, or hotel network it is usually a device that inspects traffic.';
export const INSECURE_ADVICE =
  'Opening the same link on a different network is the thing most likely to work. Reloading on this one will not.';

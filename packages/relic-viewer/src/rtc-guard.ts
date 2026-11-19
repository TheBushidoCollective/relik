/**
 * Removes the WebRTC constructors from the realm author code runs in.
 *
 * CSP does not govern WebRTC in this build (Chrome ignores `webrtc 'block'`),
 * and a `blob:` script that the policy permits can construct a peer connection
 * whose UDP traffic no directive sees. The only control measured in
 * packages/relic-mcp/test/csp-first-path.ts is to remove the constructor before
 * author code runs. This module is imported first by sandbox.ts, so its
 * module body runs before the bundle's other code and before the first render.
 *
 * Each name is deleted and then redefined as a non-writable, non-configurable
 * `undefined`, so author code cannot put a constructor back. Every
 * `RTC`/`webkitRTC` name present on the target is removed, not only the listed
 * ones, so a constructor this list does not name is still removed.
 *
 * It is one layer, not the boundary: the frame's navigation is governed by the
 * host's frame-src, and its child frames by the shim's own frame-src 'none'
 * (docs/spec/viewer.md, section 4).
 */
const RTC_NAMES: readonly string[] = [
  'RTCPeerConnection',
  'webkitRTCPeerConnection',
  'RTCDataChannel',
  'RTCSessionDescription',
  'RTCIceCandidate',
  'RTCIceGatherer',
  'RTCIceTransport',
  'RTCDtlsTransport',
  'RTCSctpTransport',
  'RTCRtpSender',
  'RTCRtpReceiver',
  'RTCRtpTransceiver',
  'RTCPeerConnectionIceEvent',
  'RTCDataChannelEvent',
  'RTCTrackEvent',
  'RTCDTMFSender',
  'RTCStatsReport',
  'RTCError',
  'RTCErrorEvent',
];

const RTC_NAME = /^(?:webkit)?RTC/;

export function removeRtcConstructors(target: object): void {
  const names = new Set<string>(RTC_NAMES);
  for (const name of Object.getOwnPropertyNames(target)) {
    if (RTC_NAME.test(name)) names.add(name);
  }
  const record = target as Record<string, unknown>;
  for (const name of names) {
    try {
      delete record[name];
    } catch {}
    try {
      Object.defineProperty(target, name, {
        value: undefined,
        writable: false,
        configurable: false,
      });
    } catch {}
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  removeRtcConstructors(window);
}

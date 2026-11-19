# CSP-first measurements

Measured 2026-11-19 on HeadlessChrome/149.0.7827.55 (owned `chrome-headless-shell`), default and site-per-process + IsolateSandboxedIframes. Measurement only: no product code changed.

Probe: `packages/relic-mcp/test/csp-first-path.ts`. Run with `bun packages/relic-mcp/test/csp-first-path.ts` from a worktree that has run `bun install` and built `packages/relic-viewer` (the production column reads the built `sandbox.html`). Commits: `d36c0665` (probe), `affb8a6f` (harness fixes and the navigate, prodcsp and cross-origin columns).

This is a sibling of `frame-egress-path.ts`, not an extension of it. That file runs its whole matrix at import and has no per-case columns, so the cases here could not be added to it without restructuring it.

## Method

- **Channels.** Loopback only (`127.0.0.1`). Each run gets its own TCP listener, its own UDP socket, and a STUN server at `stun:127.0.0.1:<udp>`. The host page and the render frame are on different loopback ports, so the frame is cross-origin to the host, as in production. DNS is not observed.
- **Frame.** `sandbox="allow-scripts"` on the render iframe, the attribute the viewer sets. The shim receives `relic:render` and writes the author markup. Markup is passed raw, not through the viewer's sanitiser. The production column runs the built `sandbox.html`, which sanitises internally, so only that column includes the sanitiser.
- **Chrome flags.** `chromeArgs` minus the proxy and `--webrtc-ip-handling-policy=disable_non_proxied_udp`. The second flag masks the UDP the probe counts.
- **Columns.**
  - `control`: plain shim, no CSP. The positive control. A case is measured only if its attempt reaches a listener here.
  - `production`: the built `sandbox.html` with the production headers, read from `createApp`.
  - `csp`: the plain shim with the candidate CSP.
  - `candidate`: a candidate shim that deletes `RTCPeerConnection`, `webkitRTCPeerConnection` and the RTC family from the author realm before author code runs, with the candidate CSP.
  - `navigate`: `candidate` plus `navigate-to 'none'`, to test whether Chrome honours that directive.
  - `prodcsp`: the production header string on the plain shim, with no containment. It separates what the header does from what the shim's containment does.
- **Candidate CSP.** `default-src 'none'; script-src 'sha256-<shim>' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; worker-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; sandbox allow-scripts; frame-ancestors <host>`. The shim is allowed by the hash of its own inline script. Author script is allowed only as a `blob:` script element, which the shim writes back in parser order.
- **Verdicts.**
  - `EGRESS`: the attempt reported, and a listener saw a TCP connection, TCP data or a UDP packet. The channel is shown as `tcpN`, `udpN`.
  - `BLOCKED`: the attempt reported, and nothing reached a listener.
  - `BLOCKED-PRE`: the attempt never reported. A policy, a loader or a browser refusal stopped it first. Where the attempt threw, the cell shows why.
  - `UNPROVEN`: the control did not reach its listener, so the row says nothing about the policy. The cell shows the control's own outcome.
  - `rtc=undefined` on an `EGRESS` row means the attempt reached a listener without a WebRTC constructor, so the traffic came from a fetch, not from WebRTC.

## Results

Both process models gave identical verdicts on all 45 rows. The table is the default model.

| case | control | production | csp | candidate | navigate | prodcsp |
| --- | --- | --- | --- | --- | --- | --- |
| i1-srcdoc-nosb | EGRESS tcp2+udp4 rtc=function | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE | EGRESS udp4 rtc=function |
| i2-srcdoc-sandboxed | EGRESS tcp2+udp4 rtc=function | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE | EGRESS udp4 rtc=function |
| i3-aboutblank-write | UNPROVEN(ctrl) | UNPROVEN(ctrl-pre) | UNPROVEN(ctrl-pre) | UNPROVEN(ctrl-pre) | UNPROVEN(ctrl-pre) | UNPROVEN(ctrl-pre) |
| i4-src-http-leaf | EGRESS tcp2+udp4 rtc=function | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE |
| i5-src-blob-html | EGRESS tcp2+udp4 rtc=function | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE |
| i6-src-data-html | EGRESS tcp2+udp4 rtc=function | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE |
| i7-object-leaf | EGRESS tcp2+udp4 rtc=function | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE |
| i8-embed-leaf | EGRESS tcp2+udp4 rtc=function | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE |
| ii1-srcdoc-data-script | EGRESS tcp2+udp4 rtc=function | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE |
| ii2-srcdoc-blob-script | UNPROVEN(ctrl) | UNPROVEN(ctrl-pre) | UNPROVEN(ctrl-pre) | UNPROVEN(ctrl-pre) | UNPROVEN(ctrl-pre) | UNPROVEN(ctrl-pre) |
| ii3-top-blob-script | EGRESS tcp2+udp4 rtc=function | BLOCKED rtc=undefined | EGRESS udp4 rtc=function | BLOCKED rtc=undefined | BLOCKED rtc=undefined | EGRESS udp4 rtc=function |
| ii4-top-data-script | EGRESS tcp2+udp4 rtc=function | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE |
| ii5-top-inline-injected | EGRESS tcp2+udp4 rtc=function | BLOCKED rtc=undefined | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE | EGRESS udp4 rtc=function |
| ii6-eval | EGRESS tcp2+udp4 rtc=function | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE |
| ii7-new-function | EGRESS tcp2+udp4 rtc=function | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE |
| ii8-dynamic-import-blob | EGRESS tcp2+udp4 rtc=function | BLOCKED rtc=undefined | EGRESS udp4 rtc=function | BLOCKED rtc=undefined | BLOCKED rtc=undefined | EGRESS udp4 rtc=function |
| iii1-worker-blob | EGRESS tcp2 rtc=undefined | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE |
| iii2-worker-data | EGRESS tcp2 rtc=undefined | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE |
| iii3-sharedworker-blob | UNPROVEN(ctrl) | UNPROVEN(ctrl-pre) | UNPROVEN(ctrl-pre) | UNPROVEN(ctrl-pre) | UNPROVEN(ctrl-pre) | UNPROVEN(ctrl-pre) |
| iii4-serviceworker | UNPROVEN(ctrl) | UNPROVEN(ctrl-blocked) | UNPROVEN(ctrl-blocked) | UNPROVEN(ctrl-blocked) | UNPROVEN(ctrl-blocked) | UNPROVEN(ctrl-blocked) |
| iv1-anchor-javascript | UNPROVEN(ctrl) | UNPROVEN(ctrl-pre) | UNPROVEN(ctrl-pre) | UNPROVEN(ctrl-pre) | UNPROVEN(ctrl-pre) | UNPROVEN(ctrl-pre) |
| iv2-location-href-javascript | UNPROVEN(ctrl) | UNPROVEN(ctrl-pre) | UNPROVEN(ctrl-pre) | UNPROVEN(ctrl-pre) | UNPROVEN(ctrl-pre) | UNPROVEN(ctrl-pre) |
| iv3-location-assign-javascript | UNPROVEN(ctrl) | UNPROVEN(ctrl-pre) | UNPROVEN(ctrl-pre) | UNPROVEN(ctrl-pre) | UNPROVEN(ctrl-pre) | UNPROVEN(ctrl-pre) |
| iv4-form-action-javascript | UNPROVEN(ctrl) | UNPROVEN(ctrl-pre) | UNPROVEN(ctrl-pre) | UNPROVEN(ctrl-pre) | UNPROVEN(ctrl-pre) | UNPROVEN(ctrl-pre) |
| iv5-meta-refresh-javascript | UNPROVEN(ctrl) | UNPROVEN(ctrl-pre) | UNPROVEN(ctrl-pre) | UNPROVEN(ctrl-pre) | UNPROVEN(ctrl-pre) | UNPROVEN(ctrl-pre) |
| iv6-iframe-src-javascript | EGRESS tcp2+udp5 rtc=function | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE | EGRESS udp5 rtc=function |
| iv7-window-open-javascript | UNPROVEN(ctrl) | UNPROVEN(ctrl-pre) | UNPROVEN(ctrl-pre) | UNPROVEN(ctrl-pre) | UNPROVEN(ctrl-pre) | UNPROVEN(ctrl-pre) |
| v0-author-realm | EGRESS tcp2+udp4 rtc=function | BLOCKED rtc=undefined | EGRESS udp4 rtc=function | BLOCKED rtc=undefined | BLOCKED rtc=undefined | EGRESS udp4 rtc=function |
| v1-iframe-contentWindow | UNPROVEN(ctrl) | UNPROVEN(ctrl-pre) | UNPROVEN(ctrl-pre) | UNPROVEN(ctrl-pre) | UNPROVEN(ctrl-pre) | UNPROVEN(ctrl-pre) |
| v2-window-open-about-blank | UNPROVEN(ctrl) | UNPROVEN(ctrl-blocked) | UNPROVEN(ctrl-blocked) | UNPROVEN(ctrl-blocked) | UNPROVEN(ctrl-blocked) | UNPROVEN(ctrl-blocked) |
| v3-createHTMLDocument | UNPROVEN(ctrl) | UNPROVEN(ctrl-blocked) | UNPROVEN(ctrl-blocked) | UNPROVEN(ctrl-blocked) | UNPROVEN(ctrl-blocked) | UNPROVEN(ctrl-blocked) |
| v4-reflect-scan | EGRESS tcp2+udp4 rtc=function | BLOCKED rtc=undefined | EGRESS udp4 rtc=function | BLOCKED rtc=undefined | BLOCKED rtc=undefined | EGRESS udp4 rtc=function |
| v5-structuredClone | UNPROVEN(ctrl) | UNPROVEN(ctrl-blocked) | UNPROVEN(ctrl-blocked) | UNPROVEN(ctrl-blocked) | UNPROVEN(ctrl-blocked) | UNPROVEN(ctrl-blocked) |
| v6-document-open-reinstate | EGRESS tcp2+udp4 rtc=function | BLOCKED rtc=undefined | EGRESS udp4 rtc=function | BLOCKED rtc=undefined | BLOCKED rtc=undefined | EGRESS udp4 rtc=function |
| vi1-customized-builtin-iframe | EGRESS tcp2+udp5 rtc=function | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE | EGRESS udp5 rtc=function |
| vi2-self-nav-href-leaf | EGRESS tcp2+udp5 rtc=function | EGRESS tcp2+udp5 rtc=function | EGRESS tcp2+udp5 rtc=function | EGRESS tcp2+udp5 rtc=function | EGRESS tcp2+udp5 rtc=function | EGRESS tcp2+udp5 rtc=function |
| vi3-document-open-inline | EGRESS tcp2+udp5 rtc=function | BLOCKED rtc=undefined | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE | EGRESS udp5 rtc=function |
| vi4-self-nav-data-leaf | EGRESS tcp2+udp5 rtc=function | EGRESS udp5 rtc=function | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE | EGRESS udp5 rtc=function |
| vi5-self-nav-blob-leaf | EGRESS tcp2+udp5 rtc=function | EGRESS udp5 rtc=function | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE | EGRESS udp5 rtc=function |
| vi6-self-replace-leaf | EGRESS tcp2+udp5 rtc=function | EGRESS tcp2+udp5 rtc=function | EGRESS tcp2+udp5 rtc=function | EGRESS tcp2+udp5 rtc=function | EGRESS tcp2+udp5 rtc=function | EGRESS tcp2+udp5 rtc=function |
| vi7-self-nav-cross-origin-leaf | EGRESS tcp2+udp5 rtc=function | EGRESS tcp2+udp5 rtc=function | EGRESS tcp2+udp5 rtc=function | EGRESS tcp2+udp5 rtc=function | EGRESS tcp2+udp5 rtc=function | EGRESS tcp2+udp5 rtc=function |
| r1-call-capture-iframe | EGRESS tcp2+udp4 rtc=function | EGRESS udp4 rtc=function | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE | EGRESS udp4 rtc=function |
| r2-tolowercase-iframe | EGRESS tcp2+udp4 rtc=function | EGRESS udp4 rtc=function | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE | EGRESS udp4 rtc=function |
| r3-createElementNS-xiframe | EGRESS tcp2+udp4 rtc=function | EGRESS udp4 rtc=function | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE | EGRESS udp4 rtc=function |
| r4-docwrite-split | EGRESS tcp2+udp4 rtc=function | EGRESS udp4 rtc=function | BLOCKED-PRE | BLOCKED-PRE | BLOCKED-PRE | EGRESS udp4 rtc=function |

Cases are grouped: `i` frame creation, `ii` script delivery, `iii` workers, `iv` `javascript:`, `v` RTC regain, `vi` customised built-ins and realm-replacing navigation, `r` the four Review2 routes as a production baseline.

## Findings

**1. Child frames are not stopped by `frame-src` alone.** Frames created by author markup or script with an `http:`, `blob:` or `data:` source, or as `object` or `embed` (`i4` to `i8`), egress in control and are refused under production, `csp`, `candidate` and `navigate`. `frame-src 'none'` and the production `default-src 'none'` both cover these. `srcdoc` frames (`i1`, `i2`) are different: `prodcsp` shows the frame is created and runs its inline script (`EGRESS udp4`), so the production header does not stop a `srcdoc` frame. The production column's refusal comes from the shim's containment ("Frame creation is blocked"). Under `csp` and `candidate` the `srcdoc` frame may exist, but its inline script is refused by `script-src`, so `frame-src` is not what stops it. Whether a `srcdoc` frame can run a `blob:` script is `ii2`, and that row is unproven: the control runs nothing, because the blob URL made by the opaque parent is not fetched by the `srcdoc` child.

**2. Blob script egresses over WebRTC unless the constructor is removed.** Author script delivered as `blob:` (`ii3`, `ii8`) runs under every policy. With the plain shim and a CSP that allows it (`csp` and `prodcsp`), it reaches a WebRTC UDP listener (`EGRESS udp4`). Only the removal of the constructor before author code runs stops it (`candidate`, `navigate`: `BLOCKED rtc=undefined`). CSP does not stop a blob script from using WebRTC.

**3. Inline, data and eval script.** Injected inline script (`ii5`) is allowed by `unsafe-inline` and refused by the candidate CSP. `data:` script (`ii1`, `ii4`) and `eval` or `new Function` (`ii6`, `ii7`) are refused by production and the candidate CSP. Production refuses eval because it has no `unsafe-eval`, not because of containment.

**4. Dedicated workers have no WebRTC and are denied by `worker-src`.** Dedicated workers from blob or data URLs run in control and reach TCP (`EGRESS tcp2`, `rtc=undefined`): RTCPeerConnection is not exposed in a dedicated worker in this build. `worker-src 'none'` refuses them in every CSP column. SharedWorker is refused by the browser in control (`SecurityError: Access to shared workers is denied to origin 'null'`), so it is unproven, not blocked. Service worker registration is refused in control too (`made=false`).

**5. `javascript:` navigation was not measured.** An `iframe` with a `javascript:` source (`iv6`) egresses in control and is refused everywhere else. Navigation to a `javascript:` URL (`iv1` to `iv5`) and `window.open` with one (`iv7`) reached no listener in control, with no exception, so these routes did not execute in this build. They are unproven. The claim that `script-src` without `unsafe-inline` closes `javascript:` navigation is not established by this run.

**6. The RTC regain routes.** With the constructor removed, `v0` (the author realm) and `v4` (a scan of own global names) find no constructor, and `v6` (`document.open()` then reading the global back) does not restore it. The `v1`, `v2`, `v3` and `v5` routes cannot be measured against a positive control, because the browser or the sandbox stops them before any constructor is reached:
- `v1` (`contentWindow` of a same-origin `about:blank` child): in control, the access is refused, "Blocked a frame with origin null from accessing a cross-origin frame".
- `v2` (`window.open`): returns null in control, because the sandbox does not allow popups.
- `v3` (`createHTMLDocument`): the document has no window, so no constructor.
- `v5` (`structuredClone`): a function cannot be cloned.
These are structural refusals, reported as such, not as policy blocks.

**7. Self-navigation escapes every measured policy.** This is the main open route.
- The render frame navigating itself to an `http:` leaf egresses in every column, same origin (`vi2`, `vi6`) and cross origin to the host and frame (`vi7`). It egresses under `csp`, `candidate`, `navigate` and `prodcsp`. `frame-src 'none'` does not govern it, and Chrome 149 did not honour `navigate-to 'none'`. The navigated document runs the leaf's own code, with its own WebRTC and its own fetch, and no shim policy.
- The frame navigating itself to a `data:` or `blob:` document (`vi4`, `vi5`) egresses under `production` and `prodcsp`, and is blocked under `csp`, `candidate` and `navigate`. The explicit `frame-src 'none'` blocks it. The production header relies on `default-src 'none'` as the fallback for `frame-src`, and that fallback does not block self-navigation. (`prodcsp` and `csp` differ in the explicit `frame-src`, the `script-src` form and `object-src`. This run did not separate those.)
- So the production column is open for all five self-navigation forms (`vi2`, `vi4`, `vi5`, `vi6`, `vi7`). The served-policy comment in `packages/relic-server/src/app.ts` says every fetch directive is closed, and spec section 4 says no fetch directive names any host. Both hold for the shim's own document. Neither holds after the frame navigates itself.

**8. Review2 reproduced, and closed by the candidate.** Routes r1 to r4 (call and apply capture, `toLowerCase`, `x:iframe` in the XHTML namespace, and a frame tag split across two `document.write` calls) egress in production, as Review2 reported. Under `csp`, `candidate` and `navigate` they are refused before the nested attempt runs.

**9. Fetch from the shim document is blocked by the production policy.** In production and `csp`, the top realm's fetch to a loopback listener produces no TCP arrival (the `r` rows show `udp4` only). In control it does (`tcp2`). So `connect-src` absent (closed by `default-src 'none'`) works for the shim's own document. It stops working once the frame navigates itself (finding 7).

## Proposed design

Smallest design measured here: the shim keeps its own script as the only inline script, named by the SHA-256 of its exact text in `script-src`. It runs every author script as a `blob:` script element, which it writes back in parser order (the probe's `RENDER_JS`). Before the first author script it deletes `RTCPeerConnection`, `webkitRTCPeerConnection` and the RTC family from its global and fixes each as `undefined`, non-writable (the probe's `REMOVE_RTC_JS`). The policy is `default-src 'none'; script-src 'sha256-<shim>' blob:; frame-src 'none'; object-src 'none'; worker-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'; sandbox allow-scripts; frame-ancestors <host>`, with no connect-src source.

**What it closes, as measured (the `candidate` column, and `navigate` where marked):** child frames created by markup or script with an `http:`, `blob:`, `data:`, object or embed source (`i4` to `i8`); inline, `data:`, `eval` and `new Function` script (`ii1`, `ii4` to `ii7`); WebRTC from a `blob:` author script, because the constructor is gone before it runs (`ii3`, `ii8`); dedicated workers, which are refused and have no WebRTC (`iii1`, `iii2`); `javascript:` as an iframe source (`iv6`); the four Review2 routes (`r1` to `r4`); the constructor regained by reflection or after `document.open()` (`v0`, `v4`, `v6`); self-navigation to `data:` and `blob:` documents when `frame-src 'none'` is explicit (`vi4`, `vi5`, under `navigate` also); and `fetch` from the shim document (`connect-src` absent).

**What it does not close, as measured:**
- Self-navigation of the render frame to an `http:` URL, same origin or cross origin (`vi2`, `vi6`, `vi7`). The navigated document has WebRTC, unrestricted fetch and no policy. No measured variant stops it, including `frame-src 'none'` and `navigate-to 'none'`. So "exactly one realm" is not guaranteed: navigation creates another one.
- Any route whose control was silent, so its verdict is unproven, not blocked: `javascript:` navigation (`iv1` to `iv5`, `iv7`), `srcdoc` with a `blob:` script (`ii2`), `about:blank` writes (`i3`), SharedWorker and service worker (`iii3`, `iii4`), and the regain routes `v1` to `v3` and `v5`.
- DNS, the public network, and everything the probe did not load (see Not measured).

**What would be needed before the claim "WebRTC egress from author script is prevented" can be made:** a control for self-navigation. Three candidates were considered and none was measured here: a sandbox flag on the frame element beyond `allow-scripts`; a layout where the shim's own `frame-src` governs its child's navigations (the shim cannot create that child under `frame-src 'none'`, so this would need a measurement of the shim allowing its own child); and a host-side load watcher, which can detect a navigation after it happens but cannot prevent the navigated code from running. The smallest next measurement is the first two, on this probe.

## Inventory: what this change would break

The question is what stops working, not what the probe measured on real relics. Nothing below was run through the publish pipeline.

**Relic kinds that run in the shim.** Only the kinds rendered in the sandboxed frame are affected: `html` (including `.htm`, `.xhtml`, and SVG, which spec section 1.5 routes to the frame), `markdown` (spec 3.1: rendered on the usercontent origin, raw HTML allowed), and `jsx`/`tsx` (spec 3.5: a blob module import, which `blob:` in `script-src` keeps allowed; not measured under the candidate). Kinds rendered in the viewing origin (pdf, model, otio, image, audio, video, text, docx) do not use this policy and are not affected by it (from the spec; the code was not traced for this note).

- **Keeps working, not measured on real relics:** author inline `<script>` in html and markdown, because the candidate runs it as a blob script.
- **Stops working:** inline event-handler attributes (`onclick=` and the like), `javascript:` URLs, and `eval`/`new Function`, because `script-src` has no `unsafe-inline` or `unsafe-eval`. These are inferred from the CSP rules; the probe measured `javascript:` as an iframe source and eval directly.
- **Stops working:** child frames by `src`, `object` or `embed`, and `srcdoc` scripts that rely on inline script. These are already refused in production.
- **No change:** WebRTC and workers, which production already refuses in the frame.

**Repo fixtures.** The 108 fixture files under `packages/*/test/fixtures` were scanned (`.html`, `.htm`, `.jsx`, `.tsx`, `.svg`, `.md`). None contains inline script, a worker, an `iframe`, or `srcdoc`. The other fixture types were not scanned.

**Plan mockups.** All 14 `docs/plans/**/*.html` files were scanned. They contain 16 inline script blocks in total (`suggested-edits` has three, the other files one each). None has an event-handler attribute, a `javascript:` URL, or `eval`/`new Function`. `og-cover/mockup.html` embeds two `srcdoc` frames with `sandbox="allow-same-origin"`, which the viewer's rule forbids alongside `allow-scripts`. None of these mockups is known to have been published as a relic, so none is known to run in the shim. If one were published, its inline script would run as a blob and its two `srcdoc` frames would have no policy-compliant form.

**Tests asserting the current policy string.** `packages/relic-server/test/app.test.ts` and `packages/relic-server/test/assets.test.ts` assert the served CSP. `sandbox.ts` says the test suite asserts the exact string, so any change to the header fails those tests on purpose. `packages/relic-viewer/test/cover-build.test.ts` asserts `FRAME_CSP` in the cover frame. The probes `packages/relic-mcp/test/svg-path.ts`, `cover-path.ts` and `cover-live-probe.ts` name the policy as well.

**Tests of the in-realm containment.** `packages/relic-viewer/test/frame-webrtc-egress.test.ts` asserts the containment's behaviour (for example, that `createElement('iframe')` throws). It would change only if the containment were removed, which this design does not require.

**Other surfaces with the same class of gap, not changed by this design.** The cover preview frame (`packages/relic-viewer/src/cover/frame.ts`, loaded with `srcdoc`, under `FRAME_CSP` in `packages/relic-viewer/build.ts`, which allows `'unsafe-inline' blob:`). The cover render in `packages/relic-mcp/src/cover/assets.ts`, which allows `'unsafe-inline'` and `connect-src 'self'`. The program render in `packages/relic-mcp/src/program/render.ts`, which allows `'unsafe-inline' 'wasm-unsafe-eval'`. These were read for their policy strings only. Their rendering paths were not measured.

**The existing egress probe.** `packages/relic-mcp/test/frame-egress-path.ts` names the four Review2 routes as open cases. It exits non-zero by design while they are open. Under the candidate they would become blocked, and its navigation cases would need the self-navigation result above.

## Not measured

- Real relic content through the publish pipeline and the viewer's sanitiser. The probe writes author markup raw to the shim.
- Real mockups, JSX relics, SVG relics and markdown under the candidate. The JSX blob import in particular is inferred to keep working, not measured.
- The public internet, DNS, TLS, other hostnames, and sites other than the two loopback origins.
- `javascript:` navigation, `srcdoc` with a `blob:` script, `about:blank` writes, popups, SharedWorker and service worker, and the `v1` to `v3` and `v5` regain routes. Their verdicts are UNPROVEN or structural, as the table shows.
- The `net:*` channels in the existing probe (WebTransport, WebSocket, EventSource, beacons, preloads, image and stylesheet loads and so on). They were not re-run under the candidate. Only `fetch` from the top realm and from workers appears here.
- Chrome versions other than 149.
- Whether the production header's `default-src` fallback behaves the same for other `frame-src`-governed routes. Only `vi4` and `vi5` were compared between `prodcsp` and `csp`.

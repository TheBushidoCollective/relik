# V1b browser spike

The owned Chromium headless shell ran the production `contentFromBlob`, ZIP planner, and ZIP indexer under the viewer's CSP. These are single local observations, not CI runner measurements.

- Opening a 128 KiB final slice immediately after creating a 40 MiB Blob took 4.6 ms; immediately after creating a 400 MiB Blob it took 32.6 ms. Ten further opens of the 400 MiB Blob took 0.1 to 0.5 ms each.
- The browser process RSS was 615,456 KiB before ten further opens and 618,192 KiB afterward. In a separate run, sampling the browser process approximately every 5 ms while opening the same slice 1,000 times found a 500,640 KiB baseline and a sampled peak of 798,896 KiB. The latter includes accumulated short-lived allocations from all 1,000 opens and is not a single-open peak or a whole-process-tree measurement.
- 100 blob URL images decoded under the production image CSP in 17.2 ms.
- A ZIP of 5,000 empty files assembled in 9.6 ms, occupied 470,022 bytes, and indexed all 5,000 entries in 773.9 ms. This excludes file-body CRC work and large-payload ZIP assembly.

The single-open observations were below the one-second threshold. They do not establish a true single-open peak memory bound.

## Stream admission

F1's existing `streamRelicContent` and `readRelicEnvelope` admit only version 1. V1b adds a bounded record-zero probe and replays its buffered ciphertext to the existing v1 stream or F1's folder stream. The original functions remain unchanged.

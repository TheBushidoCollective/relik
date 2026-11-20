# Multi-file F1 notes

## S-M1 manifest scale

Local host, not the CI runner. Node 24.15.0 measured encoding; the owned Chromium headless shell measured decode including entry-set validation. Paths were fixed-width ASCII and entries had empty bodies and MIME types. These are single observations, not performance guarantees.

| Entries | Path bytes | Manifest bytes | Node encode ms | Headless decode and validation ms |
| --- | --- | --- | --- | --- |
| 1,000 | 60 | 72,004 | 6.984 | 8.800 |
| 1,000 | 200 | 212,004 | 4.884 | 3.600 |
| 5,000 | 60 | 360,004 | 13.194 | 13.700 |
| 5,000 | 200 | 1,060,004 | 22.022 | 19.700 |

The CI runner has not been measured. The initial limit is conservatively set to 5,000 entries; it can be raised after runner measurements without invalidating earlier relics.

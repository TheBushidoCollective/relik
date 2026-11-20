# S8: CRLF CSV suggestion anchors

The nearest-CR context boundary exceeded the 2 percentage point stop threshold. The design has changed to LF-normalized suggestion anchors. The synthetic corpus produced 1,728 `repeats` refusals in 36,231 cells (4.769%) with context cut at CR, compared with zero on the normalized copies. The earlier nearest-CR design was measured and dropped.

| Generated CRLF file | Data rows | Cells, including headers | CR-cut repeats | LF-normalized repeats |
|---|---:|---:|---:|---:|
| Sales orders | 2,000 | 14,007 | 0 | 0 |
| Service tickets | 1,000 | 6,006 | 0 | 0 |
| Daily counts | 900 | 5,406 | 0 | 0 |
| Inventory export | 1,200 | 7,206 | 204 | 0 |
| Meter samples | 600 | 3,606 | 1,524 | 0 |
| **Total** | **5,700** | **36,231** | **1,728 (4.769%)** | **0** |

The files had numbers, repeated categorical values and quoted fields, including commas, doubled quotes and multibyte characters. Sales and tickets had unique IDs; daily counts combined a date with other attributes. Inventory had 17 duplicate-record groups covering 34 rows; meter samples had 110 duplicate-record groups covering 254 rows. The latter two files deliberately model categorical datasets without a unique record key. They drive the threshold result and are not a representative estimate of all CSVs.

Three public CSVs supplied an additional, small sample. The published files used LF, so each line ending was converted to CRLF before the first comparison. The content and records otherwise stayed unchanged. Source: [hw_200](https://people.sc.fsu.edu/~jburkardt/data/csv/hw_200.csv), [airtravel](https://people.sc.fsu.edu/~jburkardt/data/csv/airtravel.csv), [biostats](https://people.sc.fsu.edu/~jburkardt/data/csv/biostats.csv).

| Public file | Non-header records, including blank rows | Anchorable cells | CR-cut repeats | LF-normalized repeats | Blank rows without a delimiter anchor |
|---|---:|---:|---:|---:|---:|
| hw_200 | 200 | 603 | 0 | 0 | 0 |
| airtravel | 13 | 52 | 0 | 0 | 1 |
| biostats | 19 | 95 | 0 | 0 | 1 |
| **Total** | **232** | **750** | **0** | **0** | **2** |

These 750 anchorable public cells are too few to settle the risk; the generated repeated-record samples determine this decision. The two blank records have no neighboring delimiter and therefore cannot be measured as insertion anchors. Some public sample fields contain irregular quotes; the uniqueness measurement includes their raw spans, while the planned table editor separately refuses irregular quotes.

## Method

On revision `fff707779f14cddda7a74222adf4289a4c60e4ea`, the harness used the repository's `parseTable`, `takeTailUtf8`, `takeHeadUtf8` and `locate`. Every generated cell, including header cells, was checked. The exact anchor was the raw cell span, excluding the outer quotes of quoted fields. For the CRLF case, prefix and suffix were bounded at the nearest CR and capped at 128 UTF-8 bytes each. For the LF case, the same file was normalized to LF and each corresponding cell was parsed again, with context capped at 128 bytes but allowed across lines. `repeats` counts any result other than resolution to that exact source span. There were no `lost` results. All generated cells were nonempty and at most 512 bytes; this measures whole-cell edits, not every possible partial selection.

The generated values use a deterministic LCG seeded with `186431`: `seed = (seed * 1664525 + 1013904223) mod 2^32`, with category selection from the high bits via `floor(seed * categoryCount / 2^32)`. Each dataset is generated in table order; the second field is always quoted and values containing a comma or quote are CSV-quoted. All records end in CRLF. The two categorical files use six regions, six products and five inventory locations, or six sites, four devices and three time periods, with a small repeated set of statuses and numbers. The raw fixture SHA-256 hashes are:

- Sales: `668b487847e1adbd31743e5a6e32c0a49fae95119e6a83b5626d2c31f46cea61`
- Service tickets: `cb9a01dcce0c9281271c9101774b53b0876f9e65e937fa7518bdc5ce7dd34f1d`
- Daily counts: `b36518693dcd599cfe0a54cc356633594f2f4121169727483d4f1b7d1434207f`
- Inventory: `a65975328a90dd2b9dfea9a3c8f482d5ff5c2bacda4d2405172bbffcd56d070c`
- Meter samples: `1f271882884ad76129cf155479a11a63e47efeffed033b6f0e5a3c549939c60d`

## Settled design

For supported table and cue files containing only CRLF line endings, decode and normalize CRLF to LF before constructing, resolving, or applying anchors. Keep a `crlf` flag and restore each LF to CRLF after the merge. Refuse lone CR, CR in other formats, mixed CRLF and bare LF, and new line breaks in CRLF-file replacements. Preserve the byte-order mark. The no-newline rule ensures a remaining normalized newline came from an original CRLF; deleting a newline remains permitted where the format allows it.

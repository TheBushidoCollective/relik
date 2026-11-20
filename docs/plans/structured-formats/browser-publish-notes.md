# Browser publisher notes

## Symbolic links

macOS, headless shell, HeadlessChrome/149.0.7827.55; other browsers and platforms not measured. The test directory contained a normal file, a symlink to a file outside the directory, a symlink to an outside directory, and a dangling symlink. The outside file contained `outside-secret`.

| Entry | `webkitdirectory` picker via CDP | Directory drop via CDP |
| --- | --- | --- |
| Normal file | Present, content `normal` | Present as a file, content `normal` |
| Symlink to outside file | Absent | Absent |
| Symlink to outside directory | Absent | Absent |
| Dangling symlink | Absent | Absent |

The picker used `DOM.setFileInputFiles`. The drop used `Input.dispatchDragEvent` against a loopback HTTP page and enumerated `webkitGetAsEntry` with repeated `readEntries`. The page did not receive the outside file's bytes in either measurement. The browser does not expose whether absent entries were symlinks, so their omission cannot be counted or guaranteed in other environments.

## Size proof

The largest published folder is not yet verified in a browser. The existing page limit is 100,000,000 bytes for files and manifest combined; this is an inherited limit, not a measurement of the new path.

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

The page cannot determine which ignored files Git tracks, or apply global excludes and `.git/info/exclude`. Its matcher uses `.gitignore` files present in the selected folder, so results can differ from the local publisher in those cases.

## Size proof

The browser published and decrypted a folder with 99,999,965 file bytes and a 35-byte manifest, exactly 100,000,000 plaintext bytes in total. The test used a real directory drop, the loopback service, and an in-memory store. The page refuses folders whose files and manifest exceed that limit.

## Preflight rendering

Inspected the folder preflight at 1280×900 and 390×844, in both light and dark modes. The file list, exclusion counts, symbolic-link warning, title field, and Publish and Cancel labels were readable. At 390 px the content stayed within the card and both actions remained visible.

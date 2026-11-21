# Browser folder ignore rules

The browser matcher reads the root and nested `.gitignore` files and applies their rules to relative paths. It covers comments, escaping and trailing spaces, negation, directory exclusions, anchored and slash-containing patterns, wildcards, character classes, and `**`. Excluded parent directories cannot be re-included by a rule for a descendant. Matching is case-sensitive.

The browser cannot read Git configuration, global excludes, `.git/info/exclude`, or the separate ignore context of submodules. It does not implement `core.ignoreCase`. Consequently it cannot promise to reproduce every exclusion that Git would apply on the source machine. Before publishing, the browser publisher must show the user what was left out and make this limitation clear so they can inspect the included files as well. It must not imply that the file list is identical to local Git's.

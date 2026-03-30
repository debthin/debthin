# debthin Signing Architecture (`sign_all.py`)

## Overview

The `sign_all.py` module sits at the penultimate step before releasing debian indices. It performs three crucial orchestration steps driven via python dictionaries mapping `config.json`, rather than looping arbitrary `jq` pipes across bash sub-shells. 

## Core Operations

1. **Matrix Evaluation**:
   - `sign_all.py` interprets the `config.json` defining valid operating system targets (`ubuntu`, `debian`), parsing configurations such as which nested components and targeted architectures mapped suites represent, deduplicating matrices recursively inline.
   - Example matrix mapping output mimics: `("ubuntu", "http://archive.ubuntu.com/ubuntu", "noble", "main,universe,restricted", "amd64,arm64")`.
   
2. **Hash & Digest Synthesis**:
   - For every matrix string, the tool targets matching `./dist_output` folders executing chunk-safe SHA256 computations using python's `hashlib` spanning all nested `Packages.gz` objects.
   - It computes uncompressed size variants of those streams iteratively, replacing the system's previous overhead bound CPU bottleneck relying heavily on iterating piping streams (`gunzip | wc`).
   
3. **Cross-Architecture Parallelism**:
   - Processes are assigned synchronously via `ProcessPoolExecutor`, meaning thousands of digest checksum validations compute across system load hardware thread limits.
   
4. **Signature Construction (GnuPG)**:
   - Validating against cache boundaries preventing zero-modification releases, `sign_all.py` compiles deterministic configuration boundaries into single root `Release` plaintext files per distro.
   - Instead of writing logic around Gpg.py bindings, it maps shell boundaries passing memory-limited detached batch invocations straight to system installed `gpg` instances using `--clearsign` (producing `.InRelease` variants) and `--detach-sign` (producing `.Release.gpg`) outputs.

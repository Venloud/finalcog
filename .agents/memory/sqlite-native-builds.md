---
name: SQLite native builds on Replit
description: Handles better-sqlite3 prebuilt binaries that do not match Replit's glibc runtime.
---

On Replit's Nix runtime, a `better-sqlite3` prebuilt binary may require a newer glibc than the runtime provides. Rebuild that package from source with a compiler, make, and Python available. Do not force source builds globally because the target Windows PC should use the supported prebuilt binary.

**Why:** Replit's system libraries can differ from the Windows runtime this project targets, so the same native package installation path may not work in both environments.

**How to apply:** If Replit reports a missing `GLIBC_*` symbol while loading SQLite, rebuild only `better-sqlite3` from source in the Replit development environment. Keep the shipped app as a standard Node.js/SQLite program rather than adding a Replit-only runtime service.

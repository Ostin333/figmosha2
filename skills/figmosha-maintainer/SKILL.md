---
name: figmosha-maintainer
description: Work on the Figmosha repository itself — bridge.py, figmosha.py, plugin code, scripts, tests, versions and releases. Use when changing Figmosha's code, not when using it to edit Figma.
---

# Maintaining Figmosha

Full notes: `docs/maintaining.md` (running the bridge, Windows, releases), `docs/concurrency.md`
(the queue and interlock design), `docs/plugin-api.md`.

## Layout

| Path | What |
|---|---|
| `bridge.py` | aiohttp server: `/exec`, `/status`, `/targets`, `/clear`, WS `/plugin`; token, queue, limits |
| `figmosha.py` | CLI; `run` validates `args` against `scripts/<name>.json` |
| `plugin/code.js` | sandbox side: exec, `h.*` helpers incl. design-system helpers |
| `plugin/ui.html` | iframe: WebSocket to the bridge, token field |
| `scripts/` | ready-made scripts: `<name>.js` + `<name>.json` (`description`, `args` schema, `example`, `checkpoint`, `timeout`) |
| `skills/` | agent recipes; `figmosha skills install` links them |
| `tests/` | pytest (bridge, CLI, auth, queue, fuzz) + Node suites `*.test.js` run via `tests/test_js.py` |
| `bench/` | benchmark scenarios and `summarize.py` |

## Rules

1. Plugin changed (`code.js`, `ui.html`) → bump `PLUGIN_VERSION` (`YYYY-MM-DD.N`), run
   `pytest tests/test_plugin_version.py`, add the printed line to `tests/plugin_fingerprint.json`.
   Manifest changed → users must re-import the plugin; say so in the CHANGELOG.
2. New helper → validation before any write, upsert by name, compact return value, a stub test in
   `tests/ds.test.js` (or a new `*.test.js`), a row in AGENTS.md, a script + schema if agents call it.
3. New script → `scripts/<name>.json` with `example`; `tests/ds.test.js` runs every example.
4. Log under `## [Unreleased]` in CHANGELOG.md. Releasing: pick semver, set `VERSION` in `bridge.py`,
   rename the CHANGELOG section, `pytest -q`, commit, tag `vX.Y.Z`, push, GitHub release.
5. Breaking the HTTP contract or `h.*` → major version.
6. `tests/live_*.py` need Figma and a scratch file; run them before a release.

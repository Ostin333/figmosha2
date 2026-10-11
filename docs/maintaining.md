# Running and maintaining Figmosha

For work on this repository itself. Moved out of AGENTS.md.

## Running the bridge

Setup, once: `python -m venv venv`, then `pip install -r requirements.txt` with the venv's pip
(`./venv/bin/pip` on macOS / Linux / WSL, `.\venv\Scripts\pip` on Windows). Tests need
`requirements-dev.txt`.

**macOS / Linux / WSL**

```bash
bash start-bridge.sh                 # start, or restart if already running
bash start-bridge.sh --stop          # stop it
tail -f ~/.local/state/figmosha/bridge.log   # watch it (or: tmux attach -t figmosha-bridge, if tmux is installed)
```

No tmux needed: with tmux installed it runs in a detached session `figmosha-bridge`, otherwise as a
plain background process (stock macOS). It uses `./venv/bin/python`, else `$FIGMOSHA_PYTHON`, else
`python3`, and waits up to 10 s for the bridge to answer.

**Native Windows** — no bash or tmux needed:

```powershell
.\start-bridge.ps1            # start, detached (no-op if already running)
.\start-bridge.ps1 -Restart   # after editing bridge.py
.\start-bridge.ps1 -Stop
# logs: %LOCALAPPDATA%\figmosha\bridge.out.log and bridge.err.log
```

Windows gotchas, all hit in practice:

- If PowerShell says *running scripts is disabled*, run it as
  `powershell -ExecutionPolicy Bypass -File .\start-bridge.ps1`.
- `start-bridge.ps1` must stay **pure ASCII** — Windows PowerShell 5.1 reads a BOM-less script as ANSI,
  and one em dash or arrow breaks parsing of the whole file.
- `python` resolving to `...\WindowsApps\python.exe` is the Microsoft Store stub, not Python.
- In Windows PowerShell `curl` is `Invoke-WebRequest`; use `curl.exe` or `python figmosha.py`.

**Where Figma loads the plugin from.** Import `plugin/manifest.json` straight from the repo, and Figma
reads `plugin/` in place — an edit is live after a re-Run, with **no copy step**. The exception is a
bridge inside WSL: Figma needs a Windows path, so `plugin/` is copied out (README → Install → WSL2).
Record anything machine-specific (paths, copies, hooks) in `CLAUDE.local.md`.

The plugin must be started by hand **once per open file (tab or window — either works)**; `⌘⌥P`
(`Ctrl+Alt+P` on Windows) re-runs the last plugin in the tab you are on.

After editing `plugin/code.js` or `plugin/ui.html`: **bump `PLUGIN_VERSION`** at the top of
`plugin/code.js` (date + counter, e.g. `2026-10-02.2`) and run `pytest tests/test_plugin_version.py` — it
prints the line to add to `tests/plugin_fingerprint.json`, and fails if you forget the bump. Then ask the
user to re-Run the plugin (Plugins → Development → Figmosha Bridge). After editing
`plugin/manifest.json` (e.g. adding a permission): ask them to **re-import** it (Plugins → Development →
Manage plugins → remove, then Import from `plugin/manifest.json`).

**Stale code is reported, so act on it.** The bridge compares each plugin's build with `plugin/code.js`
on disk and its own `bridge.py` with the one it started from. When either is stale, every `/exec` reply
carries a `notice` (the CLI prints it as `⚠`), `/status` flags the file with `outdated: true`, the
plugin bar turns purple with "New version: re-run plugin", and `figmosha doctor` names the fix. Tell
the user — don't keep working against old code.

**Newer Figmosha released.** Every 6 hours the bridge reads the `vX.Y.Z` release tags on GitHub. If one
is newer than its `VERSION`, `/status` has `update: {latest, current, url}`, `/exec` replies carry a
`notice`, the plugin bar shows "New version X.Y.Z" with an Update button (opens the release notes), and
`doctor` prints a `!` line. Mention it to the user once; updating is `git pull`, restart the bridge,
re-run the plugin. Off with `FIGMOSHA_NO_UPDATE_CHECK=1`.

## Releasing — every update ships as a release

**Changes reach users only through releases, so every push of user-facing changes to `master` is
released.** Users are offered an update when a newer `vX.Y.Z` tag exists — not for plain commits — so an
unreleased change is invisible to them. Releasing is part of finishing the work, not a separate request:

1. **Pick the version** (semver over the HTTP contract and the `h.*` helpers): `x.y.Z+1` for fixes,
   `x.Y+1.0` for new features or behavior, `X+1.0.0` for anything that breaks existing scripts.
2. **`bridge.py`**: set `VERSION = "x.y.z"`.
3. **`CHANGELOG.md`**: rename `## [Unreleased]` to `## [x.y.z] — YYYY-MM-DD` and put a fresh empty
   `## [Unreleased]` above it. (Log changes under `Unreleased` as you make them.)
4. **Test**: `pytest -q` — it also checks that `VERSION` has its CHANGELOG section.
5. **Commit, tag, push both**:
   ```bash
   git commit -am "Release x.y.z"
   git tag -a vx.y.z -m "Figmosha x.y.z"
   git push origin master vx.y.z
   ```
6. **GitHub release page** for the tag, with that version's CHANGELOG section as its notes (the Update
   button links to it). Create it in the GitHub UI or via the API; the tag alone is enough for the bridge
   to offer the update.

Docs-only or test-only changes (README, comments, tests) don't need a release.

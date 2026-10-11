# Multiple files, the queue, and timeouts

Moved out of AGENTS.md; the short version is there.

## Multiple files: targets (`-T`) — READ THIS FIRST

The bridge holds **one connection per open Figma file** that is running the plugin, not one globally.

```bash
python figmosha.py targets                      # name / doc id / fileKey / conn / queue (busy, waiting)
curl -s http://localhost:8787/targets

# -T is a per-subcommand flag — it goes AFTER the subcommand, never before it
python figmosha.py exec "return figma.root.name" -T "Component Library"
python figmosha.py tree 123:456 -T "Component Library"
curl -s -X POST http://localhost:8787/exec -d '{"code":"...","target":"Icons"}'
```

`target` matching (`resolve_target` in `bridge.py`): document id (the `doc` column, 6+ chars) →
connection id → exact file name (case-insensitive) → exact `fileKey` → unambiguous substring of the name.

- **Two different files with the same name** (two fresh "Untitled" files, say) → the name is a 409;
  target each by its **document id**: `-T dk2m9q4x`. Each file carries its own id (plugin data
  `figmosha-doc` on the document root, written once on first run), so the bridge never mixes them up,
  and the id survives reconnects and bridge restarts. The `conn` id changes on every reconnect — don't
  store it.

- The name is `figma.root.name` as the plugin reports it, which is often not the name you remember —
  a trailing plural, a rename that never propagated. **Verify with `targets`, don't assume.**
- **`fileKey` targeting does not work for a local dev plugin** — it reports `fileKey: null` (shown as
  `-` in `targets`). A file key is still what `importComponentByKeyAsync` needs; it is just not usable
  as a `-T`. Match by name only.

- **No target + exactly 1 file connected** → routed there (the old default).
- **No target + 2 or more connected** → **HTTP 409** `"N files connected — specify a target"`.
  This is the #1 wasted call. **Always pass `-T`** with the file name from the project profile.
- Ambiguous substring → 409 listing the candidates. Nothing connected → 503.

### Concurrency: the per-file queue

**The bridge queues execs per document.** Requests are multiplexed by request id, and `/exec` waits for
the document's lock before sending — so two callers on the same file (orchestrator + agent, or two
agents) run **one after another, never interleaved**, and callers on *different* files never wait for
each other. The lock belongs to the document, not the connection: one file open in two tabs is one
queue.

**Several agents at once — name yourself and bound your wait:**

```bash
export FIGMOSHA_AGENT=designer            # or --agent designer / -A designer, or "agent" in the JSON
python figmosha.py exec --file build.js -T "Component Library" --queue-timeout 30
```

- `targets` / `/status` show each file's queue: who is running and for how long, who is waiting.
- A reply that waited carries `queued_ms`; the CLI prints `(waited 2.1s in the file's queue)`.
- `--queue-timeout` (JSON `queue_timeout`, default = `--timeout`) caps the wait. When it runs out the
  reply is **503 `file busy`** naming who holds the file, and **nothing was run** — retrying is safe,
  unlike after a 504.
- A caller that hangs up while queued is dropped from the queue; its script never runs.
- **Speed.** A round trip is ~2 ms over HTTP and ~100 ms through the CLI (Python start-up) — for
  dozens of small calls from code, POST to `/exec` directly. Return what you need, not whole trees:
  a 50k-item result costs ~250 ms, a 5 MB one about the same.
- **Don't pause with `setTimeout` in scripts.** Figma throttles timers in background tabs:
  `setTimeout(30)` takes ~30ms in the visible tab and up to ~1s in a background one, and every
  agent queued behind you pays for it. Figma API calls stay fast in the background.

Why the lock is needed: each file's plugin sandbox is a single-threaded async message handler over one
shared document and one shared undo stack. Without it, two scripts yield to each other at **every
`await`**, invalidating each other's `findAll` snapshots mid-run.

- **Writes: just fire them.** The lock makes concurrent writers safe. **One exec = one transaction** —
  a read-modify-write split across two calls still lets the other writer land in the gap.
- **Reads: pass `--parallel`** (`{"parallel": true}`) to bypass the lock and fan out. **Read-only
  scripts only** — a parallel writer interleaves exactly as before.
- Keep each exec ~10s and chunk sweeps (≤25 nodes). A long script now genuinely blocks that file, so
  other callers wait on the lock and can hit their own timeout.

**A 504 does not mean the write didn't happen.** Nothing can kill a script already running in the
sandbox, so on timeout the bridge marks it **abandoned** and returns 504 with a `warning` and the `rid`.
While a file has an abandoned script, further execs on it return **409** rather than racing an invisible
writer. The interlock lifts by itself when the orphan finally replies (logged `[orphan]`), or manually:

```bash
python figmosha.py clear -T "Component Library"   # drop the interlock
curl -s -X POST http://localhost:8787/clear -d '{"target":"Component Library"}'
```

Only with the user's OK: `{"force": true}` pushes past the interlock. `GET /status` reports
`pending` (in-flight) and `abandoned` (`[{rid, conn, age_s}]`).

- **Cooperative cancellation:** chunked sweeps should call **`h.ck()`** each iteration — it throws once
  the exec's own `timeout` has passed, so the loop stops instead of mutating under the next caller.
  It checks the plugin's clock, not a message from the bridge: a loop that only awaits Figma APIs never
  lets the plugin read its messages, so it can't be told to stop — and it also blocks every other exec
  on that file, `--parallel` reads included, until it ends. Without `h.ck()` such a loop simply runs on.
- **The same file open twice is fine** (2026-08-27). Each tab/window gets its own slot; the plugin reports
  a `docSig` (hash of the page ids, since `figma.fileKey` is null for a dev plugin and `figma.root.id`
  is `"0:0"` everywhere), so the bridge can tell two **views of one document** from two **different
  files sharing a name**. Same signature → `-T` routes to the newest live view, and `/status` flags the
  extra with `sameDocAs`. Different signatures → 409, close one; the write would otherwise land in a
  file you did not pick.
- **A live connection is never evicted.** Before this, a `hello` kicked out any same-named connection,
  so one file open in two windows looped forever: each side kicked the other, the loser reconnected
  2s later and kicked back. Only a connection whose socket is already closed is dropped.

If you drive this bridge from several agents, keep your own rules about who may write where. Note the
lock makes concurrent writers **corruption-safe, not conflict-safe**: it orders writes, it cannot tell that
two agents meant to change the same node. Overlapping writers = last write wins, silently. Partition by
**ownership of mains / variants / variables — not by frame or screen**: a main-component or variable edit
propagates file-wide, into frames the other writer has already verified.

If the bridge isn't running: `bash start-bridge.sh` on macOS / Linux / WSL (log
`~/.local/state/figmosha/bridge.log`), or `.\start-bridge.ps1` on native Windows (log `%LOCALAPPDATA%\figmosha\bridge.out.log`).
See [Running the bridge](maintaining.md#running-the-bridge).

If the plugin isn't connected: tell the user — `Plugins → Development → Figmosha Bridge → Run`.


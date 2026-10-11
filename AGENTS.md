# Figmosha — agent instructions

Codex reads this file directly, Claude Code through `CLAUDE.md`. Machine-specific paths live in
`CLAUDE.local.md` (gitignored) — **read it first if it exists**.

Figmosha drives Figma Desktop: JS goes through a local bridge (`bridge.py`, port 8787) to a plugin
running in each open file. On macOS/Linux use `./venv/bin/python figmosha.py` (there is no `python`).

## Calling it

```bash
figmosha targets                                   # connected files: name, doc id, queue
figmosha run --list                                # ready-made scripts (preferred)
figmosha run setup-tokens --args @spec.json -T "Design System"
figmosha run component-set --schema                # args format of one script
figmosha exec "return h.brief(figma.currentPage.children)" -T dk2m9q4x
figmosha exec --file build.js --args '{"name":"Card"}' -T "Design System"
figmosha sel | tree <id> | find <id> name=Button | text <id> "…" | variant <id> "Size=L"
figmosha doctor                                    # what is broken and how to fix it
```

Over HTTP: `POST /exec {code, target, args?, timeout?, checkpoint?, max_result?}` with
`Authorization: Bearer $(cat ~/.figmosha/token)`. The CLI adds the token by itself.

## Rules that save the most calls

1. **Always pass `-T`** (after the subcommand) — with 2+ files connected a call without it is a 409.
   Use the doc id from `figmosha targets` when two files share a name.
2. **Prefer `figmosha run <script>`** over hand-written JS. You write JSON, not code, and the args
   are validated before anything reaches Figma. Check `run --list` first.
3. **Return little**: ids, names, counts (`h.brief(nodes)`). Results over 8 KB are cut — the reply
   says so; `--full` only when you really need everything.
4. **One exec = one transaction.** Read-modify-write in one script; other agents may write between
   two calls. Each exec is one Cmd+Z step for the user.
5. **No atomicity.** A script that throws halfway keeps what it already did. Validate input first,
   then write; the helpers below already do. `mutated: true` on an error means changes stayed
   (`null` = none seen, not a guarantee).
   Before a large change pass `--checkpoint "<what>"` (bulk scripts do it themselves).
6. **Async API only**: `await figma.getNodeByIdAsync(id)` / `await h.node(id)`,
   `getMainComponentAsync()`, `getLocalVariablesAsync()`.
7. **Verify with data, not screenshots** — read back the properties you set.
8. A **504** means the script may still be running; the file is interlocked (409) until it ends.
   Ask the user before `figmosha clear`. Don't use `force`.

## Helpers (`h.*` in every exec, `args` holds the JSON from `--args`)

| Helper | What |
|---|---|
| `await h.tokens(spec)` / `await h.exportTokens(name?)` | Upsert variables from DTCG-style JSON / export them |
| `await h.textStyles(spec)` / `await h.effectStyles(spec)` | Upsert text / effect styles |
| `await h.componentSet(spec)` / `h.arrange(set, opts)` | Variant matrix → bound, laid-out component set |
| `await h.bindAuto(root, map?)` | Bind loose hex colours, radii, gaps to matching variables |
| `await h.inventory()` / `h.lint(root, opts)` | Compact file overview / design-system problems |
| `await h.checkpoint(label)` | Save a version in Figma's history |
| `h.brief(nodes)` | `[{id, name, type}]` |
| `await h.bF/bS(node, idx, var)`, `await h.bN(node, prop, var)` | Bind fill / stroke / number to a variable |
| `await h.setText(node, text)`, `await h.withFonts(root, fn)` | Text edits with fonts loaded |
| `h.frame(parent, {layout, w, h, spacing, padding, align, fill, radius, name})` | Auto-layout frame, right order |
| `h.findByName`, `h.findAllByName`, `h.dumpTree`, `h.sel()`, `await h.resolve("sel"\|"page"\|id)` | Lookup |
| `h.hex`, `h.solid`, `h.cloneNext`, `await h.variant`, `await h.variantsOf`, `h.ck()` | Misc; `h.ck()` in long loops |

Spec formats: `figmosha run <name> --schema` prints each one with an example. Details, error hints
and auto-layout order: [docs/plugin-api.md](docs/plugin-api.md).

## Skills

Task recipes live in `skills/` (install: `figmosha skills install`): `figmosha-core`,
`figmosha-design-tokens`, `figmosha-components`, `figmosha-styles`, `figmosha-ds-audit`,
`figmosha-build-screen`, `figmosha-history` (REST: versions, comments, images),
`figmosha-maintainer`. Load the one that matches the task.

## When something is off

- `plugin not connected` (503) — ask the user to run *Plugins → Development → Figmosha Bridge* in
  that file (`⌘⌥P` re-runs it).
- The plugin bar is **red with a token field** — ask the user to run `figmosha token` and paste it.
- A `notice` / `⚠` about an outdated plugin or bridge — tell the user to re-run / restart.
- `file busy` (503) — nothing ran; retry later. `queue full` — the same.
- Read the `hint` in an error reply before debugging.
- More: [docs/concurrency.md](docs/concurrency.md) (targets, queue, 504, several agents).

## Working on this repository

Read [docs/maintaining.md](docs/maintaining.md) (or the `figmosha-maintainer` skill) before changing
code. The two rules people forget:

- After editing `plugin/code.js` or `plugin/ui.html`, **bump `PLUGIN_VERSION`** and run
  `pytest tests/test_plugin_version.py` — it prints the line for `tests/plugin_fingerprint.json`.
- User-facing changes ship as **releases** (`VERSION` in `bridge.py`, CHANGELOG section, tag
  `vX.Y.Z`). Log changes under `## [Unreleased]` as you go. Tests: `pytest -q` (runs the Node suites too).

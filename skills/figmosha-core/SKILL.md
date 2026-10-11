---
name: figmosha-core
description: Drive Figma Desktop through the local Figmosha bridge — targets, running scripts, exec, checkpoints, errors. Use for any Figma read or write via figmosha. Тригери - "у фігмі", "в Figma", "figmosha", змінити/прочитати макет, ноду, сторінку.
---

# Figmosha core

`figmosha` below means `<checkout>/venv/bin/python <checkout>/figmosha.py` (Windows:
`<checkout>\venv\Scripts\python`). This skill folder is a link into `<checkout>/skills/`, so the
checkout is two levels above the real path of this file.

## Before the first call

1. `figmosha targets` — connected files. Pick one; remember its **doc id** (2nd column).
2. Nothing connected → ask the user to run *Plugins → Development → Figmosha Bridge* in the file.
3. Bar red with a token field → ask the user to run `figmosha token` and paste it there.
4. Pass `-T <doc id>` on every call, after the subcommand.

## Order of preference

1. `figmosha run <script> --args @spec.json -T <doc>` — `figmosha run --list` shows them,
   `figmosha run <script> --schema` prints the args format and an example.
2. Subcommands: `sel`, `tree <id>`, `find <id> name=X`, `text <id> "…"`, `variant <id> "P=V"`,
   `clone`, `rm`.
3. `figmosha exec --file x.js --args '{...}'` — your own JS; the JSON is the variable `args`.

Write specs to a file in your scratch directory and pass `@file`: shorter commands, no shell quoting.

## Writing your own exec

- Body of an async function: `return` the result, `await` works, `print()` logs.
- Async lookups only: `await h.node(id)`, `await figma.getNodeByIdAsync(id)`.
- Return compact data: `h.brief(nodes)`, counts, ids. Over 8 KB the result is cut.
- Validate everything you can before the first write; then write. There is no rollback:
  a script that throws keeps the changes it already made (`mutated: true` in the reply).
- Before a large change: `--checkpoint "<what>"` (saves a version in Figma's history).
- Loops over many nodes: call `h.ck()` each iteration, keep one exec under ~10 s, chunk by ~25 nodes.
- Auto layout order: append to parent → `layoutMode` → size → sizing modes → spacing/padding.
  `h.frame(parent, {...})` does it right.
- Text: `await h.setText(node, "…")` or `await h.withFonts(root, async () => {...})`.
- Variables: `await h.bF(node, 0, v)` / `h.bS` / `h.bN(node, "paddingTop", v)`.

## Reading replies

| Reply | Meaning | Do |
|---|---|---|
| 409 `N files connected` | no `-T` | add `-T` |
| 409 interlocked | an earlier script timed out and may still run | wait; ask the user before `figmosha clear` |
| 503 `file busy` / `queue full` | another agent holds the file; nothing ran | retry later |
| 504 | timed out; the script may still be changing the file | re-read before trusting anything |
| 401 | token mismatch | `figmosha doctor` |
| `notice` / `⚠` outdated | old plugin or bridge | tell the user to re-run the plugin / restart the bridge |
| `hint` | known mistake | follow it |

Verify by reading values back, not with screenshots.

Several agents on one file: each exec is serialized; overlapping edits to the same node are
last-write-wins. Split work by component / variable ownership. Details: `docs/concurrency.md`.

---
name: figmosha-history
description: Read a Figma file's version history and comments, export node images, write a changelog between versions — Figma REST through figmosha. Тригери - історія версій, хто змінив, коментарі у фігмі, changelog дизайну, експорт картинок.
---

# Version history, comments, images (REST)

Needs `figmosha-core`. These calls go to api.figma.com, not through the plugin, and are read-only.

## One-time setup (the user does it)

1. A personal access token: Figma → Settings → Security → Personal access tokens (scopes:
   file content, versions, comments — read). Ask the user to run `figmosha figma-token` and paste it.
   Never ask them to paste the token into the chat.
2. The file key: a dev plugin cannot see it. Ask for the file's URL once, then
   `figmosha link -T <doc> "<figma URL>"`. It is remembered in `~/.figmosha/links.json`.

## Calls

| Need | Command |
|---|---|
| Versions (newest first) | `figmosha rest versions -T <doc> --limit 20` |
| Open comments | `figmosha rest comments -T <doc>` (`--all` adds resolved) |
| Node images | `figmosha rest images -T <doc> --ids 1:2,3:4 --format png --scale 2` → URLs |

`--key <URL or key>` works instead of `-T` for files not open in Figma.

## Changelog between two versions

The REST versions list has labels and authors only, not diffs. For a design changelog:
1. `figmosha rest versions` → pick the versions; list label, author, date per version.
2. For what changed *now* versus a saved baseline: `figmosha run export-tokens` and
   `figmosha run inventory` before and after the work, and compare the JSON yourself.
3. Checkpoints made by Figmosha are named `figmosha: <label>` — they mark agent changes.

## Who touched a node

Not available through REST. Use comments on the node (`node` field) and version authors.

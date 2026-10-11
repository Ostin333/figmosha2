---
name: figmosha-ds-audit
description: Audit a Figma file's design system through figmosha — inventory of variables, styles and components, lint for unbound colours/spacing/radii, missing auto layout, detached copies, then auto-bind to variables. Тригери - аудит, перевірка дизайн-системи, що є у файлі, незв'язані кольори, lint, інвентаризація.
---

# Design-system audit

Needs `figmosha-core`. All three scripts are read-only except `bind-auto`.

## 1. What is in the file

`figmosha run inventory -T <doc>` → collections (modes, counts by type), text/effect/paint styles,
component sets with their variant props and extra properties, loose components.
`{"pages":"current"}` skips loading every page (faster on big files).

## 2. Problems

`figmosha run lint --args '{"root":"page","limit":30}' -T <doc>`

| Rule | Flags |
|---|---|
| `unbound-color` | solid fill/stroke without a variable or style |
| `unbound-spacing` | auto-layout gap/padding > 0 without a variable |
| `unbound-radius` | corner radius > 0 without a variable |
| `no-autolayout` | a frame with 2+ children and no auto layout |
| `detached` | a frame detached from an instance |
| `text-no-style` | text without a text style |

Instance interiors are skipped — fix those in the main component. `root` takes a node id, `page`
or `sel`; `rules` narrows the check. Report `counts` to the user first, issues second.

## 3. Fix what can be fixed automatically

`figmosha run bind-auto --args '{"root":"<frame id>"}' -T <doc>` binds exact matches:
hex colours to COLOR variables (default-mode value), radii to FLOAT variables scoped `CORNER_RADIUS`,
gaps and padding to FLOAT variables scoped `GAP`. Values matching two variables are skipped and
listed (`skippedAmbiguous`); `unmatchedColors` shows the hexes with no variable — candidates for new
tokens. Pass explicit maps when needed:
`{"colors": {"#2563eb": "bg/brand"}, "radius": {"8": "radius/md"}, "spacing": false}`.
It takes a checkpoint first. Run lint again to show the result.

## Accessibility quick check

No dedicated script. For text contrast: exec that walks TEXT nodes, resolves the nearest solid fill
behind them, computes WCAG contrast, and returns only failures `{id, name, ratio}`.

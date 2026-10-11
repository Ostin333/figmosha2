---
name: figmosha-styles
description: Create or update Figma text styles (typography scale) and effect styles (shadows, blurs) via figmosha, optionally bound to variables. Тригери - текстові стилі, типографіка, шрифти, тіні, ефекти, elevation.
---

# Text and effect styles

Needs `figmosha-core`. Both scripts upsert by name and change nothing on a repeat run.

## Text styles

`figmosha run text-styles --args @type.json -T <doc>`

```json
{ "styles": [
  { "name": "Heading/H1", "fontFamily": "Inter", "fontStyle": "Bold", "fontSize": 32, "lineHeight": "120%", "letterSpacing": "-2%" },
  { "name": "Body/M", "fontFamily": "Inter", "fontSize": "type/size/m", "lineHeight": 24 }
] }
```

- `fontStyle` defaults to `Regular`; the font must be installed — every font is loaded before
  anything is written, a missing one stops the whole call.
- `fontSize`, `lineHeight`, `letterSpacing`, `paragraphSpacing`: a number (px), `"150%"`, `"auto"`
  (line height), or a FLOAT variable name — then the style is bound to it.
- `textCase` (`UPPER`, `LOWER`, `TITLE`, `ORIGINAL`), `textDecoration`, `description`.

Apply to a layer: `await node.setTextStyleIdAsync(style.id)`; in a component set use `"textStyle": "Body/M"`.

## Effect styles

`figmosha run effect-styles --args @effects.json -T <doc>`

```json
{ "styles": [
  { "name": "Elevation/1", "effects": [{ "color": "#0000001a", "y": 1, "blur": 2 }, { "color": "#0000000f", "y": 1, "blur": 3, "spread": 1 }] },
  { "name": "Blur/Glass", "effects": [{ "type": "BACKGROUND_BLUR", "radius": 12 }] }
] }
```

Effect `type`: `DROP_SHADOW` (default), `INNER_SHADOW`, `LAYER_BLUR`, `BACKGROUND_BLUR`.
Shadows take `color` (`#rrggbbaa`), `x`, `y`, `blur`, `spread`.

## New file in one go

`bootstrap-file` takes `pages`, `tokens`, `textStyles`, `effectStyles` together — see `figmosha run bootstrap-file --schema`.

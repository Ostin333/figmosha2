---
name: figmosha-components
description: Build or restyle Figma component sets (variants like Type × Size × State) bound to variables, add component properties, arrange variants in a grid — via figmosha. Тригери - компонент, варіанти, component set, кнопка/інпут/бейдж з варіантами, властивості компонента.
---

# Components with Figmosha

Needs `figmosha-core`. Variables should exist first (`figmosha-design-tokens`): the set binds to them by name.

## Build or update a set — one call

`figmosha run component-set --args @button.json -T <doc>`

```json
{
  "name": "Button",
  "page": "Components",
  "variants": { "Type": ["Primary", "Secondary", "Ghost", "Danger"], "Size": ["S", "M", "L"] },
  "base": { "padding": [8, 12], "radius": "radius/md", "spacing": "space/2", "fill": "bg/brand" },
  "text": { "value": "Button", "property": "Label", "fill": "text/default", "size": 14 },
  "rules": [
    { "when": { "Size": "S" }, "set": { "padding": [6, 10], "textSize": 12 } },
    { "when": { "Type": "Secondary" }, "set": { "fill": "bg/default", "stroke": "border/default", "strokeWeight": 1 } },
    { "when": { "Type": "Ghost" }, "set": { "fill": null } },
    { "when": { "Type": ["Danger"] }, "set": { "fill": "palette/red/500", "textFill": "#ffffff" } }
  ],
  "arrange": { "columns": "Size", "gap": 24 }
}
```

- Every combination of `variants` becomes one variant. `base` applies to all; each matching rule
  (`when` value or list of values) overrides on top, in order.
- Style keys: `layout` (`H`/`V`), `padding` (n, [v, h], [t, r, b, l]), `spacing`, `radius`, `width`,
  `height`, `fill`, `stroke`, `strokeWeight`, `align` (`{primary, counter}`), `textSize`, `textFill`,
  `textStyle` (a local text style name), `font` (`{family, style}`).
- Colours: `"#hex"`, a COLOR variable name (`bg/brand`, or `Color:bg/brand` when ambiguous), or `null`.
  Numbers: a number or a FLOAT variable name.
- `text`: label layer (`name` default `Label`); `property` exposes it as a TEXT property;
  `"text": null` for no label.
- `properties`: `[{"name": "Show icon", "type": "BOOLEAN", "layer": "Icon"}]` wires a child's
  visibility (the child must exist in each variant).
- Reply: `{set: {id}, variants, created, restyled, extra, properties, grid}`. `extra` = variants in
  the file that the matrix no longer has (not deleted — ask the user).

Re-running restyles in place and adds only missing variants — safe after an error or a 504.

## Other operations

- Re-layout only: `figmosha run arrange --args '{"set":"<id>","columns":"Size"}' -T <doc>`.
- Inspect a set: `figmosha exec "const s = await h.node(args.id); return {props: s.variantGroupProperties, defs: Object.keys(s.componentPropertyDefinitions)}" --args '{"id":"1:2"}'`.
- Add a property by hand: `set.addComponentProperty(name, "TEXT"|"BOOLEAN"|"INSTANCE_SWAP", default)`
  returns the key with a `#id` suffix — use that key in `layer.componentPropertyReferences`.
- Instance swap / nested icons: build the icon component first, then exec
  `comp.appendChild(icon.createInstance())` per variant and wire `mainComponent` via
  `componentPropertyReferences`.
- Use instances elsewhere: `figmosha variant <instance id> "Type=Primary" "Size=L"`.

## Check

`figmosha run lint --args '{"root":"<set id>","rules":["unbound-color","unbound-spacing","unbound-radius"]}' -T <doc>`
should report nothing for variable-bound sets (hex values you chose on purpose will show up).

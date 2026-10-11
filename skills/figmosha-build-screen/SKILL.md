---
name: figmosha-build-screen
description: Build a Figma screen or layout from the file's existing components and variables through figmosha — auto layout, instances with variants, bound colours, verified with lint. Тригери - зібрати екран, сторінку, макет, layout, форму з наявних компонентів.
---

# Build a screen from existing parts

Needs `figmosha-core`. Goal: no hard-coded colours, components as instances.

1. **Know the parts** — `figmosha run inventory --args '{"pages":"all"}' -T <doc>`: component sets
   (ids, variant props, TEXT properties), variable names, text styles. Do this once, keep the ids.
2. **Plan the tree** in your head: frames with auto layout, instances, text.
3. **Build in one exec** with args (structure + data separated):

```js
const vars = await figma.variables.getLocalVariablesAsync();
const v = (name) => vars.find((x) => x.name === name);
const page = figma.root.children.find((p) => p.name === args.page) || figma.currentPage;
const screen = h.frame(page, { name: args.name, layout: "V", w: 390, h: 844, padding: 24, spacing: 16 });
await h.bF(screen, 0, v(args.bgVar));
const set = await h.node(args.buttonSet);
const btn = set.children.find((c) => c.name === "Type=Primary, Size=L").createInstance();
screen.appendChild(btn);
const label = Object.keys(btn.componentProperties).find((k) => k.startsWith("Label#"));
btn.setProperties({ [label]: "Sign in" });
btn.layoutSizingHorizontal = "FILL";
return h.brief([screen, btn]);
```

   A new frame has a white fill, so `h.bF(screen, 0, variable)` binds it. Variables are found by
   name from `getLocalVariablesAsync()` (`h.var_` takes an id or a library key, not a name).
4. **Text**: create with `figma.createText()`, load the font, set characters, then
   `await t.setTextStyleIdAsync(styleId)` and bind the fill.
5. **Verify** — `figmosha run lint --args '{"root":"<screen id>"}' -T <doc>`; then
   `figmosha run bind-auto --args '{"root":"<screen id>"}'` for leftovers; lint again.
6. **Report** the screen id and anything that needed a hex on purpose.

Large screens: build sections in separate execs (header, form, footer), each returning ids.
`layoutSizingHorizontal = "FILL"` only works after the node is inside an auto-layout parent.

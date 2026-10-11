const fs = require("fs");
const src = fs.readFileSync(require("path").join(__dirname, "..", "plugin", "code.js"), "utf8");

let nextId = 1;
const writes = [];
const state = { collections: [], variables: [], text: [], effect: [], paint: [] };
const id = (p) => p + (nextId++);
const write = (what) => writes.push(what);

function makeCollection(name) {
  const c = {
    id: id("VariableCollectionId:"), name, variableIds: [],
    modes: [{ modeId: id("m"), name: "Mode 1" }],
    get defaultModeId() { return this.modes[0].modeId; },
    renameMode(modeId, n) { write("renameMode"); this.modes.find((m) => m.modeId === modeId).name = n; },
    addMode(n) { write("addMode"); const m = id("m"); this.modes.push({ modeId: m, name: n }); return m; },
  };
  state.collections.push(c);
  return c;
}

function makeVariable(name, col, type) {
  const v = {
    id: id("VariableID:"), name, resolvedType: type, variableCollectionId: col.id,
    valuesByMode: {}, scopes: ["ALL_SCOPES"], codeSyntax: {}, description: "", hiddenFromPublishing: false,
    setValueForMode(m, val) { write("setValue"); this.valuesByMode[m] = val; },
    setVariableCodeSyntax(p, val) { write("codeSyntax"); this.codeSyntax[p] = val; },
  };
  col.variableIds.push(v.id);
  state.variables.push(v);
  return v;
}

function makeNode(type, props) {
  const n = Object.assign({
    id: id("1:"), type, name: "", children: [], parent: null, x: 0, y: 0, width: 100, height: 40,
    fills: [], strokes: [], boundVariables: {}, componentPropertyReferences: null, layoutMode: "NONE",
    appendChild(c) {
      write("appendChild");
      if (c.parent) c.parent.children.splice(c.parent.children.indexOf(c), 1);
      c.parent = this;
      this.children.push(c);
    },
    resize(w, h) { this.width = w; this.height = h; },
    resizeWithoutConstraints(w, h) { this.width = w; this.height = h; },
    setBoundVariable(f, v) {
      write("bind");
      if (v) this.boundVariables[f] = { type: "VARIABLE_ALIAS", id: v.id };
      else delete this.boundVariables[f];
    },
    findOne(fn) {
      for (const c of this.children) {
        if (fn(c)) return c;
        const deep = c.findOne ? c.findOne(fn) : null;
        if (deep) return deep;
      }
      return null;
    },
    findAllWithCriteria({ types }) {
      const out = [];
      const walk = (x) => { for (const c of x.children) { if (types.indexOf(c.type) !== -1) out.push(c); walk(c); } };
      walk(this);
      return out;
    },
    async setTextStyleIdAsync(sid) { this.textStyleId = sid; },
    get variantProperties() {
      if (this.type !== "COMPONENT" || !this.parent || this.parent.type !== "COMPONENT_SET") return null;
      const out = {};
      for (const part of this.name.split(",")) { const [k, v] = part.split("="); out[k.trim()] = v.trim(); }
      return out;
    },
  }, props || {});
  if (type === "COMPONENT_SET") {
    n.componentPropertyDefinitions = {};
    n.addComponentProperty = function (name, t, def) {
      write("addProp");
      const key = name + "#" + id("");
      this.componentPropertyDefinitions[key] = { type: t, defaultValue: def };
      return key;
    };
    Object.defineProperty(n, "variantGroupProperties", {
      get() {
        const out = {};
        for (const c of this.children) {
          const vp = c.variantProperties;
          for (const k of Object.keys(vp)) {
            out[k] = out[k] || { values: [] };
            if (out[k].values.indexOf(vp[k]) === -1) out[k].values.push(vp[k]);
          }
        }
        return out;
      },
    });
  }
  return n;
}

const page = makeNode("PAGE", { name: "Page 1" });
const posted = [];
const loadedFonts = [];
const figma = {
  showUI() {},
  ui: { onmessage: null, postMessage(m) { posted.push(m); } },
  root: { name: "DS", children: [page], getPluginData() { return "dds"; }, setPluginData() {} },
  currentPage: page,
  clientStorage: { async getAsync() { return null; } },
  on() {},
  variables: {
    async getLocalVariableCollectionsAsync() { return state.collections.slice(); },
    async getLocalVariablesAsync() { return state.variables.slice(); },
    createVariableCollection(name) { write("createCollection"); return makeCollection(name); },
    createVariable(name, col, type) { write("createVariable"); return makeVariable(name, col, type); },
    createVariableAlias(v) { return { type: "VARIABLE_ALIAS", id: v.id }; },
    setBoundVariableForPaint(p, field, v) {
      return Object.assign({}, p, { boundVariables: { color: { type: "VARIABLE_ALIAS", id: v.id } } });
    },
  },
  async loadFontAsync(f) {
    if (f.family === "Nope") throw new Error("font not found");
    loadedFonts.push(f.family + " " + f.style);
  },
  async getLocalTextStylesAsync() { return state.text.slice(); },
  async getLocalEffectStylesAsync() { return state.effect.slice(); },
  async getLocalPaintStylesAsync() { return state.paint.slice(); },
  createTextStyle() {
    write("createTextStyle");
    const s = { id: id("S:"), name: "", description: "", boundVariables: {},
      setBoundVariable(f, v) {
        write("bind");
        if (v) this.boundVariables[f] = { type: "VARIABLE_ALIAS", id: v.id };
        else delete this.boundVariables[f];
      } };
    state.text.push(s);
    return s;
  },
  createEffectStyle() {
    write("createEffectStyle");
    const s = { id: id("S:"), name: "", description: "", effects: [] };
    state.effect.push(s);
    return s;
  },
  createComponent() { write("createComponent"); const c = makeNode("COMPONENT"); page.appendChild(c); return c; },
  createText() { write("createText"); return makeNode("TEXT", { characters: "", fontSize: 12, textStyleId: "" }); },
  createPage() { write("createPage"); const p = makeNode("PAGE"); figma.root.children.push(p); return p; },
  combineAsVariants(nodes, parent) {
    write("combine");
    const set = makeNode("COMPONENT_SET");
    parent.appendChild(set);
    for (const n of nodes) set.appendChild(n);
    return set;
  },
};

const h = new Function("figma", "__html__", src + "\nreturn HELPERS;")(figma, "");

let failed = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) failed++;
  console.log(`${a === e ? "  ok  " : " FAIL "} ${label}${a === e ? "" : `\n         got ${a}\n         want ${e}`}`);
}

async function throwsNothingWritten(label, fn, needle) {
  const before = writes.length;
  let message = null;
  try { await fn(); } catch (e) { message = e.message; }
  check(label + " — throws", message !== null && (!needle || message.indexOf(needle) !== -1), true);
  check(label + " — writes nothing", writes.length, before);
  return message;
}

const s1 = {
  collection: "Color",
  modes: ["Light", "Dark"],
  tokens: {
    palette: {
      $type: "color",
      blue: { 100: { $value: "#dbeafe" }, 300: { $value: "#93c5fd" }, 500: { $value: "#2563eb" } },
      gray: { 100: { $value: "#f3f4f6" }, 300: { $value: "#d1d5db" }, 500: { $value: "#374151" } },
      red: { 500: { $value: "#dc2626" } },
    },
    bg: {
      default: { $value: { Light: "{palette.gray.100}", Dark: "{palette.gray.500}" }, $scopes: ["fill"] },
      brand: { $value: "{palette.blue.500}", $scopes: ["fill"], $description: "Brand surface" },
    },
    text: {
      default: { $value: "{palette.gray.500}", $modes: { Dark: "{palette.gray.100}" }, $scopes: ["text"],
        $codeSyntax: { WEB: "var(--text-default)" } },
    },
    border: { default: { $type: "color", $value: "{palette.gray.300}", $scopes: ["stroke"] } },
  },
};

(async () => {
  let r = await h.tokens(s1);
  const col = state.collections[0];
  check("collection created with both modes", col.modes.map((m) => m.name), ["Light", "Dark"]);
  check("all tokens created", r.created.length, 11);
  const byName = (n) => state.variables.find((v) => v.name === n);
  const [light, dark] = col.modes.map((m) => m.modeId);
  check("alias per mode", [byName("bg/default").valuesByMode[light].id, byName("bg/default").valuesByMode[dark].id],
        [byName("palette/gray/100").id, byName("palette/gray/500").id]);
  check("$modes overrides one mode", byName("text/default").valuesByMode[dark].id, byName("palette/gray/100").id);
  check("alias-only token gets the target's type", byName("bg/brand").resolvedType, "COLOR");
  check("scope shorthand expands", byName("bg/default").scopes, ["FRAME_FILL", "SHAPE_FILL"]);
  check("code syntax set", byName("text/default").codeSyntax, { WEB: "var(--text-default)" });
  check("description set", byName("bg/brand").description, "Brand surface");

  const before = writes.length;
  r = await h.tokens(s1);
  check("second run is a no-op", [r.created.length, r.updated.length, r.unchanged], [0, 0, 11]);
  check("second run writes nothing", writes.length, before);

  const changed = JSON.parse(JSON.stringify(s1));
  changed.tokens.palette.red["500"].$value = "#ef4444";
  r = await h.tokens(changed);
  check("one changed value is one update", r.updated, ["palette/red/500"]);

  const exported = await h.exportTokens("Color");
  check("export keeps per-mode aliases", exported.collections[0].tokens.bg.default.$value,
        { Light: "{palette.gray.100}", Dark: "{palette.gray.500}" });
  check("export writes hex", exported.collections[0].tokens.palette.blue["500"].$value, "#2563eb");
  r = await h.tokens(exported);
  check("export → import round trip changes nothing", [r.created.length, r.updated.length], [0, 0]);

  const msg = await throwsNothingWritten("bad spec", () => h.tokens({
    collection: "Color", modes: ["Light", "Dark"],
    tokens: {
      a: { $type: "color", $value: "#zzz" },
      b: { $value: "{palette.nope}" },
      c: { $type: "number", $value: 4, $scopes: ["text"] },
      d: { $type: "color", $value: "#fff", $modes: { Dim: "#000" } },
      palette: { blue: { 500: { $type: "number", $value: 2 } } },
      fresh: { $type: "color", $value: "#123456" },
    },
  }));
  for (const needle of ["not a colour", "palette.nope", "does not apply to FLOAT", "unknown mode \"Dim\"", "already exists as a COLOR"]) {
    check("reports: " + needle, msg.indexOf(needle) !== -1, true);
  }

  const cyc = await throwsNothingWritten("alias cycle", () => h.tokens({ collection: "Loop", tokens: {
    a: { $type: "color", $value: "{b}" }, b: { $type: "color", $value: "{a}" } } }), "alias cycle");
  await throwsNothingWritten("ALL_SCOPES mixed", () => h.tokens({ collection: "Color", modes: ["Light", "Dark"],
    tokens: { z: { $type: "color", $value: "#fff", $scopes: ["all", "fill"] } } }), "ALL_SCOPES");
  r = await h.tokens({ collection: "Space", tokens: { space: { $type: "dimension", 4: { $value: "16px", $scopes: ["gap"] }, 2: { $value: 8, $scopes: ["gap"] } },
    radius: { md: { $type: "number", $value: 8, $scopes: ["radius"] } } } });
  check("default mode renamed to Default", state.collections[1].modes.map((m) => m.name), ["Default"]);
  check("px dimension parsed", byName("space/4").valuesByMode[state.collections[1].defaultModeId], 16);

  r = await h.textStyles({ styles: [
    { name: "Heading/H1", fontFamily: "Inter", fontStyle: "Bold", fontSize: 32, lineHeight: "120%", letterSpacing: "-2%" },
    { name: "Body/M", fontFamily: "Inter", fontSize: "space/4", lineHeight: 24 },
  ] });
  check("text styles created", r.created, ["Heading/H1", "Body/M"]);
  const h1 = state.text.find((s) => s.name === "Heading/H1");
  check("line height percent", h1.lineHeight, { unit: "PERCENT", value: 120 });
  check("font size bound to variable", state.text[1].boundVariables.fontSize.id, byName("space/4").id);
  r = await h.textStyles({ styles: [{ name: "Heading/H1", fontFamily: "Inter", fontStyle: "Bold", fontSize: 32, lineHeight: "120%", letterSpacing: "-2%" }] });
  check("text style rerun unchanged", r.unchanged, 1);
  await throwsNothingWritten("missing font", () => h.textStyles([{ name: "X", fontFamily: "Nope" }, { name: "Y", fontFamily: "Inter", fontSize: "nope/var" }]), "not available");

  await throwsNothingWritten("bad textCase", () => h.textStyles([{ name: "New/A", fontFamily: "Inter" },
    { name: "New/B", fontFamily: "Inter", textCase: "upper" }]), "textCase");
  r = await h.effectStyles({ styles: [{ name: "Elevation/1", effects: [{ color: "#0000001a", y: 2, blur: 4 }, { type: "LAYER_BLUR", radius: 3 }] }] });
  check("effect style created", r.created, ["Elevation/1"]);
  check("shadow mapped", state.effect[0].effects[0].offset, { x: 0, y: 2 });
  r = await h.effectStyles({ styles: [{ name: "Elevation/1", effects: [{ color: "#0000001a", y: 2, blur: 4 }, { type: "LAYER_BLUR", radius: 3 }] }] });
  check("effect style rerun unchanged", r.unchanged, 1);

  const button = {
    name: "Button",
    variants: { Type: ["Primary", "Secondary", "Ghost", "Danger"], Size: ["S", "M", "L"] },
    base: { padding: [8, 12], radius: "radius/md", spacing: "space/2", fill: "bg/brand" },
    text: { name: "Label", value: "Button", property: "Label", fill: "text/default", size: 14 },
    rules: [
      { when: { Size: "S" }, set: { padding: [4, 8], textSize: 12 } },
      { when: { Size: "L" }, set: { padding: [12, 16], textSize: 16 } },
      { when: { Type: "Secondary" }, set: { fill: "bg/default", stroke: "border/default", strokeWeight: 1 } },
      { when: { Type: "Ghost" }, set: { fill: null } },
      { when: { Type: "Danger" }, set: { fill: "palette/red/500", textFill: "#ffffff" } },
    ],
  };
  r = await h.componentSet(button);
  const set = page.children.find((n) => n.type === "COMPONENT_SET");
  check("12 variants created", [r.variants, r.created], [12, 12]);
  check("one TEXT property", Object.keys(set.componentPropertyDefinitions).length, 1);
  const primaryS = set.children.find((c) => c.name === "Type=Primary, Size=S");
  check("fill bound to variable", primaryS.fills[0].boundVariables.color.id, byName("bg/brand").id);
  check("rule padding applied", [primaryS.paddingTop, primaryS.paddingRight], [4, 8]);
  check("radius bound", primaryS.boundVariables.topLeftRadius.id, byName("radius/md").id);
  check("ghost has no fill", set.children.find((c) => c.name === "Type=Ghost, Size=M").fills, []);
  const label = primaryS.children[0];
  check("label wired to the property", Object.values(label.componentPropertyReferences)[0].split("#")[0], "Label");
  check("grid 4 rows × 3 columns", r.grid, { rows: 4, columns: 3, by: "Size" });

  const sets = page.children.filter((n) => n.type === "COMPONENT_SET").length;
  r = await h.componentSet(button);
  check("rerun restyles in place", [r.created, r.restyled, page.children.filter((n) => n.type === "COMPONENT_SET").length], [0, 12, sets]);
  check("rerun keeps one property", Object.keys(set.componentPropertyDefinitions).length, 1);

  const grown = JSON.parse(JSON.stringify(button));
  grown.variants.Size.push("XL");
  r = await h.componentSet(grown);
  check("new axis value adds only the missing variants", [r.created, r.variants], [4, 16]);

  await throwsNothingWritten("component set with a missing variable", () => h.componentSet({
    name: "Chip", variants: { State: ["On", "Off"] }, base: { fill: "nope/color" },
    rules: [{ when: { State: "Maybe" }, set: { fill: "#fff" } }],
  }), "no local variable");
  check("…and the bad rule in the same report", (await throwsNothingWritten("chip again", () => h.componentSet({
    name: "Chip", variants: { State: ["On", "Off"] }, base: { fill: "nope/color" },
    rules: [{ when: { State: "Maybe" }, set: { fill: "#fff" } }],
  }))).indexOf("unknown value Maybe") !== -1, true);

  await throwsNothingWritten("bad align", () => h.componentSet({
    name: "Tag", variants: { State: ["On"] }, base: { align: { primary: "MIDDLE" } } }), "align.primary");
  const frame = makeNode("FRAME", { name: "Card", layoutMode: "VERTICAL", itemSpacing: 8, paddingTop: 16, cornerRadius: 8, topLeftRadius: 8,
    fills: [{ type: "SOLID", color: { r: 0x25 / 255, g: 0x63 / 255, b: 0xeb / 255 } }] });
  const inner = makeNode("FRAME", { name: "Odd", fills: [{ type: "SOLID", color: { r: 0.1, g: 0.2, b: 0.3 } }] });
  frame.appendChild(inner);
  page.appendChild(frame);
  r = await h.bindAuto(frame);
  check("bindAuto binds matching hex, radius and spacing", r.bound, { fills: 1, strokes: 0, radius: 1, spacing: 1, padding: 1, failed: 0 });
  check("bindAuto lists unmatched colours", r.unmatchedColors, ["#1a334d ×1"]);

  const loose = makeNode("FRAME", { name: "Loose", fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }] });
  loose.appendChild(makeNode("TEXT", { name: "t", textStyleId: "" }));
  loose.appendChild(makeNode("FRAME", { name: "f" }));
  const inst = makeNode("INSTANCE", { name: "Inst" });
  inst.appendChild(makeNode("FRAME", { name: "inside", fills: [{ type: "SOLID", color: { r: 0, g: 1, b: 0 } }] }));
  loose.appendChild(inst);
  r = h.lint(loose);
  check("lint counts", r.counts, { "unbound-color": 1, "no-autolayout": 1, "text-no-style": 1 });
  check("lint skips instance interiors", r.issues.some((i) => i.name === "inside"), false);

  r = await h.inventory({ pages: "current" });
  check("inventory collections", r.collections.map((c) => [c.name, c.variables]), [["Color", 11], ["Space", 3]]);
  check("inventory sets", r.componentSets.map((s) => [s.name, s.variants, s.props.Size.length]), [["Button", 16, 4]]);
  check("inventory styles", [r.styles.text.length, r.styles.effect.length], [2, 1]);

  const dir = require("path").join(__dirname, "..", "scripts");
  const order = ["setup-tokens", "text-styles", "effect-styles", "component-set", "export-tokens",
    "inventory", "lint", "bootstrap-file"];
  for (const name of order) {
    const meta = JSON.parse(fs.readFileSync(require("path").join(dir, name + ".json"), "utf8"));
    posted.length = 0;
    await figma.ui.onmessage({ type: "exec", id: name, code: fs.readFileSync(require("path").join(dir, name + ".js"), "utf8"),
      args: meta.example, timeout: 10 });
    const reply = posted.find((m) => m.id === name && (m.type === "result" || m.type === "error"));
    check("script " + name + " runs its example", reply && reply.type === "error" ? reply.text : "ok", "ok");
  }
  check("bootstrap keeps a used first page and adds the rest", figma.root.children.map((p) => p.name).slice(0, 3), ["Page 1", "Cover", "Tokens"]);

  console.log(failed ? `\n${failed} FAILED` : "\nall design-system checks passed");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

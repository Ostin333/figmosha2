figma.showUI(__html__, { width: 220, height: 28, title: "Figmosha Bridge" });

// Build id of this plugin code. The bridge compares it with plugin/code.js on
// disk and asks for a re-Run when they differ, because a running plugin keeps
// the code it started with. Bump it on every change to plugin/ —
// tests/test_plugin_version.py fails until you do.
const PLUGIN_VERSION = "2026-10-10.3";

// Tell the UI which file we're in, so it can register this connection with the
// bridge by name (figma.root.name). The bridge routes --target by that name.
const TOKEN_KEY = "figmosha-token";

async function readToken() {
  try {
    const t = await figma.clientStorage.getAsync(TOKEN_KEY);
    return typeof t === "string" && t ? t : null;
  } catch (e) {
    return null;
  }
}

async function postIdentity() {
  let fileKey = null;
  try { fileKey = figma.fileKey || null; } catch (e) { /* not always available */ }
  figma.ui.postMessage({
    type: "identity",
    fileKey: fileKey,
    name: figma.root.name,
    docSig: docSignature(),
    pluginVersion: PLUGIN_VERSION,
    token: await readToken(),
  });
}

// `figma.fileKey` is null for a local dev plugin and `figma.root.id` is "0:0" in
// every file, so neither identifies the document. The bridge needs an id that is
// the same for one file open in two windows and different for two files that
// share a name, to route a target safely.
//
// Page ids are not enough: every new file starts with a single page "0:1", so two
// fresh "Untitled" files looked like one document and both got the writes meant
// for one of them. So the plugin stores a random id in the document itself, once,
// and reads it back on every run. (A duplicated file copies it; rename one.)
function docSignature() {
  try {
    let id = figma.root.getPluginData("figmosha-doc");
    if (!id) {
      // Random part first, so a short prefix (-T dk2m9q) is already unique.
      id = "d" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      figma.root.setPluginData("figmosha-doc", id);
    }
    return id;
  } catch (e) {
    return pageSignature();
  }
}

// Fallback when plugin data can't be read or written: hash of the page ids.
function pageSignature() {
  try {
    const ids = figma.root.children.map((p) => p.id).join(",");
    let hash = 5381;
    for (let i = 0; i < ids.length; i++) {
      hash = ((hash * 33) ^ ids.charCodeAt(i)) >>> 0;
    }
    return hash.toString(16);
  } catch (e) {
    return null;
  }
}
postIdentity();

function safeStringify(value) {
  if (value === undefined) return null;
  try { return JSON.parse(JSON.stringify(value)); } catch (e) {
    try { return String(value); } catch (e2) { return null; }
  }
}

// The `result` message for a finished exec. It carries the value once: the
// bridge derives the human-readable `result` text from it. Sending both, as
// before, doubled every payload and pretty-printed objects a third time — a
// 50k-item array took ~0.6 s to come back. `text` is only sent when the value
// can't express it: no return value (logs or "Done"), or NaN / BigInt / etc.
function resultMessage(id, result, logs) {
  const t = typeof result;
  if (result === undefined) {
    return { type: "result", id, value: null, text: asText(result, logs) };
  }
  if (t === "string" || t === "boolean" || (t === "number" && isFinite(result))) {
    return { type: "result", id, value: result };
  }
  if (t === "object") {  // objects, arrays, null
    // Serialized exactly once, here. The UI splices this string into the
    // WebSocket frame as is, so the object is never cloned across postMessage
    // or stringified again (that was 3 passes over a big result).
    try {
      const json = JSON.stringify(result);
      if (json !== undefined) return { type: "result", id, valueJson: json };
    } catch (e) { /* cyclic, BigInt inside… — fall through */ }
    return { type: "result", id, value: safeStringify(result) };
  }
  return { type: "result", id, value: safeStringify(result), text: String(result) };
}

function asText(value, logs) {
  try {
    if (value !== undefined) {
      return typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
    }
  } catch (e) { /* unserializable — fall back to logs */ }
  return logs.length > 0 ? logs.join("\n") : "Done";
}

// ─── helpers exposed as `h.*` to every exec ──────────────────────────────

// Set for the duration of one exec so helpers can surface warnings through the
// same `print()` the user's code gets. No-op outside an exec.
let CURRENT_PRINT = () => {};

async function resolveVar(varOrId) {
  if (varOrId == null) return null;
  if (typeof varOrId !== "string") return varOrId;

  // Local variables are addressed as "VariableID:1:23"; anything else is a
  // library key, which has to be imported rather than looked up.
  if (varOrId.indexOf("VariableID:") === 0) {
    return await figma.variables.getVariableByIdAsync(varOrId);
  }
  // A library key is not a well-formed id, and getVariableByIdAsync rejects
  // those by throwing rather than returning null — so this has to be guarded,
  // otherwise the import below is unreachable for the very case it exists for.
  let local = null;
  try {
    local = await figma.variables.getVariableByIdAsync(varOrId);
  } catch (e) {
    local = null;
  }
  if (local) return local;

  try {
    return await figma.variables.importVariableByKeyAsync(varOrId);
  } catch (e) {
    return null;
  }
}

// "#1a2b3c" / "1a2b3c" / "#f00" -> {r,g,b} in Figma's 0..1 range.
function hexToRgb(value) {
  let s = String(value).trim().replace(/^#/, "");
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  if (!/^[0-9a-fA-F]{6}$/.test(s)) {
    throw new Error("h.hex: expected #RGB or #RRGGBB, got " + JSON.stringify(value));
  }
  const n = parseInt(s, 16);
  return {
    r: ((n >> 16) & 255) / 255,
    g: ((n >> 8) & 255) / 255,
    b: (n & 255) / 255,
  };
}

// Normalise padding given as a number, [v, h], or {top,right,bottom,left}.
function paddingOf(p) {
  if (p == null) return null;
  if (typeof p === "number") return { top: p, right: p, bottom: p, left: p };
  if (Array.isArray(p)) {
    const v = p[0], hz = p.length > 1 ? p[1] : p[0];
    return { top: v, right: hz, bottom: v, left: hz };
  }
  return {
    top: p.top || 0, right: p.right || 0,
    bottom: p.bottom || 0, left: p.left || 0,
  };
}

// Copy a paint array before mutating it — node.fills/strokes are frozen.
function copyPaints(node, prop, who) {
  const paints = node[prop];
  if (typeof paints === "symbol") {
    throw new Error(
      who + ": '" + node.name + "' has mixed " + prop +
      "; set the paint per-range, or unify " + prop + " on the node first"
    );
  }
  if (!Array.isArray(paints)) {
    throw new Error(who + ": '" + node.name + "' has no " + prop);
  }
  return JSON.parse(JSON.stringify(paints));
}

const HELPERS = {
  // Bind fill paint at index to a variable (id or instance)
  async bF(node, idx, varOrId) {
    const v = await resolveVar(varOrId);
    if (!v) throw new Error("h.bF: variable not found: " + varOrId);
    const f = copyPaints(node, "fills", "h.bF");
    if (!f[idx]) throw new Error("h.bF: '" + node.name + "' has no fill at index " + idx);
    f[idx] = figma.variables.setBoundVariableForPaint(f[idx], "color", v);
    node.fills = f;
    return v;
  },

  // Bind stroke paint at index
  async bS(node, idx, varOrId) {
    const v = await resolveVar(varOrId);
    if (!v) throw new Error("h.bS: variable not found: " + varOrId);
    const s = copyPaints(node, "strokes", "h.bS");
    if (!s[idx]) throw new Error("h.bS: '" + node.name + "' has no stroke at index " + idx);
    s[idx] = figma.variables.setBoundVariableForPaint(s[idx], "color", v);
    node.strokes = s;
    return v;
  },

  // Bind numeric property (radii, padding, sizes, itemSpacing, etc.)
  async bN(node, prop, varOrId) {
    const v = await resolveVar(varOrId);
    if (!v) throw new Error("h.bN: variable not found: " + varOrId);
    node.setBoundVariable(prop, v);
    return v;
  },

  // First descendant by exact name
  findByName(root, name) {
    return root.findOne((n) => n.name === name);
  },

  // All descendants by exact name
  findAllByName(root, name) {
    return root.findAll((n) => n.name === name);
  },

  // Dump subtree as indented text
  dumpTree(node, opts) {
    opts = opts || {};
    const maxDepth = opts.maxDepth == null ? 99 : opts.maxDepth;
    const showSize = opts.showSize !== false;
    const showText = opts.showText !== false;
    const showLayout = opts.showLayout === true;
    const lines = [];
    const walk = (n, d) => {
      if (d > maxDepth) return;
      const pad = "  ".repeat(d);
      let line = pad + n.name + " [" + n.type + "] " + n.id;
      if (showSize && n.width !== undefined) {
        line += " " + Math.round(n.width) + "×" + Math.round(n.height);
      }
      if (showLayout && n.layoutMode && n.layoutMode !== "NONE") {
        line += " {" + n.layoutMode[0] +
          " gap:" + n.itemSpacing +
          " pad:" + n.paddingTop + "," + n.paddingRight + "," + n.paddingBottom + "," + n.paddingLeft +
          " " + n.primaryAxisSizingMode + "/" + n.counterAxisSizingMode + "}";
      }
      if (showText && n.type === "TEXT") line += ' "' + n.characters + '"';
      lines.push(line);
      if (n.children) for (const c of n.children) walk(c, d + 1);
    };
    walk(node, 0);
    return lines.join("\n");
  },

  // Load every unique font in subtree, then run async fn
  async withFonts(rootNode, asyncFn) {
    const texts = rootNode.findAll
      ? rootNode.findAll((n) => n.type === "TEXT")
      : (rootNode.type === "TEXT" ? [rootNode] : []);
    const seen = new Set();
    const fonts = [];
    const skipped = [];
    for (const t of texts) {
      // Mixed-font nodes can't be loaded wholesale; editing one later throws a
      // confusing "font not loaded" far from here, so say it out loud now.
      if (typeof t.fontName === "symbol") { skipped.push(t.name); continue; }
      const fn = t.fontName;
      const key = fn.family + "|" + fn.style;
      if (!seen.has(key)) { seen.add(key); fonts.push(fn); }
    }
    if (skipped.length) {
      CURRENT_PRINT(
        "h.withFonts: skipped " + skipped.length + " mixed-font text node(s): " +
        skipped.slice(0, 5).join(", ") + (skipped.length > 5 ? ", …" : "") +
        " — editing them will fail unless you load each range manually"
      );
    }
    await Promise.all(fonts.map((f) => figma.loadFontAsync(f)));
    return await asyncFn();
  },

  // Set a text node's characters with auto font load (single-font texts only)
  async setText(node, text) {
    if (typeof node.fontName === "symbol") {
      throw new Error("h.setText: text '" + node.name + "' has mixed fonts; load each range manually");
    }
    await figma.loadFontAsync(node.fontName);
    node.characters = text;
  },

  // Clone node and place it next to the original
  cloneNext(node, opts) {
    opts = opts || {};
    const direction = opts.direction || "right";
    const gap = opts.gap == null ? 100 : opts.gap;
    const c = node.clone();
    node.parent.appendChild(c);
    if (direction === "right") { c.x = node.x + node.width + gap; c.y = node.y; }
    else if (direction === "left")  { c.x = node.x - node.width - gap; c.y = node.y; }
    else if (direction === "down")  { c.x = node.x; c.y = node.y + node.height + gap; }
    else if (direction === "up")    { c.x = node.x; c.y = node.y - node.height - gap; }
    if (opts.name) c.name = opts.name;
    return c;
  },

  // Set instance variant properties
  async variant(instance, props) {
    await instance.setProperties(props);
    return instance;
  },

  // Available variants for an instance's component
  async variantsOf(instance) {
    const main = await instance.getMainComponentAsync();
    if (!main) return null;
    const set = main.parent && main.parent.type === "COMPONENT_SET" ? main.parent : null;
    return set
      ? { current: main.name, groups: set.variantGroupProperties, all: set.children.map(c => c.name) }
      : { current: main.name, groups: null, all: null };
  },

  // What the user has selected right now — the bridge between "this one here"
  // and a node id you can act on.
  sel() {
    return figma.currentPage.selection.map((n) => ({
      id: n.id, name: n.name, type: n.type,
      w: n.width, h: n.height,
      chars: n.type === "TEXT" ? n.characters : undefined,
    }));
  },

  // Hex string -> {r,g,b}. Hand-rolling this is where the missing /255 lives.
  hex(value) { return hexToRgb(value); },

  // Ready-to-assign paint array: node.fills = h.solid("#1a2b3c")
  solid(value, opacity) {
    const paint = { type: "SOLID", color: hexToRgb(value) };
    if (opacity != null) paint.opacity = opacity;
    return [paint];
  },

  // Create a frame with auto-layout applied in the order Figma demands:
  // into the tree -> layoutMode -> size -> sizing mode -> spacing/padding.
  // Getting that order wrong silently drops the settings.
  frame(parent, opts) {
    opts = opts || {};
    const f = figma.createFrame();
    if (parent) parent.appendChild(f);

    if (opts.name) f.name = opts.name;

    if (opts.layout) {
      const l = String(opts.layout).toUpperCase();
      f.layoutMode = l === "V" ? "VERTICAL" : l === "H" ? "HORIZONTAL" : l;
    }

    if (opts.w != null || opts.h != null) {
      f.resize(opts.w == null ? f.width : opts.w, opts.h == null ? f.height : opts.h);
    }

    if (f.layoutMode && f.layoutMode !== "NONE") {
      // Hug by default on axes the caller didn't pin to a number.
      if (opts.hug !== false) {
        const horizontalIsPrimary = f.layoutMode === "HORIZONTAL";
        const primaryFixed = horizontalIsPrimary ? opts.w != null : opts.h != null;
        const counterFixed = horizontalIsPrimary ? opts.h != null : opts.w != null;
        if (!primaryFixed) f.primaryAxisSizingMode = "AUTO";
        if (!counterFixed) f.counterAxisSizingMode = "AUTO";
      }
      if (opts.spacing != null) f.itemSpacing = opts.spacing;
      if (opts.align) {
        if (opts.align.primary) f.primaryAxisAlignItems = opts.align.primary;
        if (opts.align.counter) f.counterAxisAlignItems = opts.align.counter;
      }
      const pad = paddingOf(opts.padding);
      if (pad) {
        f.paddingTop = pad.top; f.paddingRight = pad.right;
        f.paddingBottom = pad.bottom; f.paddingLeft = pad.left;
      }
    }

    if (opts.fill != null) f.fills = opts.fill === false ? [] : HELPERS.solid(opts.fill);
    if (opts.radius != null) f.cornerRadius = opts.radius;
    return f;
  },

  // Accept "page" / "sel" alongside a real node id, so callers can say
  // "the thing I'm looking at" without first hunting for its id.
  async resolve(idOrAlias) {
    if (idOrAlias === "page") return figma.currentPage;
    if (idOrAlias === "sel") {
      const s = figma.currentPage.selection;
      if (!s.length) throw new Error("nothing selected in Figma");
      return s[0];
    }
    return await figma.getNodeByIdAsync(idOrAlias);
  },

  brief(nodes) {
    const one = (n) => n ? { id: n.id, name: n.name, type: n.type } : null;
    const many = nodes && typeof nodes === "object" && !nodes.type &&
      typeof nodes[Symbol.iterator] === "function";
    return many ? Array.from(nodes, one) : one(nodes);
  },

  async checkpoint(label) {
    const title = "figmosha: " + String(label || "checkpoint").slice(0, 80);
    const v = await figma.saveVersionHistoryAsync(title);
    return { id: v && v.id, title };
  },

  // Quick async accessors
  async node(id)      { return await figma.getNodeByIdAsync(id); },
  async var_(idOrKey) { return await resolveVar(idOrKey); },
  async importComp(key) { return await figma.importComponentByKeyAsync(key); },
  async importVar(key)  { return await figma.variables.importVariableByKeyAsync(key); },
};

function problems(who, list) {
  const shown = list.slice(0, 30);
  const e = new Error(who + ": " + list.length + " problem(s), nothing was changed:\n- " +
    shown.join("\n- ") + (list.length > shown.length ? "\n- …" : ""));
  e.problems = list;
  return e;
}

function parseColor(value) {
  if (value && typeof value === "object" && typeof value.r === "number" &&
      typeof value.g === "number" && typeof value.b === "number") {
    return { r: value.r, g: value.g, b: value.b, a: typeof value.a === "number" ? value.a : 1 };
  }
  if (typeof value !== "string") return null;
  let s = value.trim().replace(/^#/, "");
  if (s.length === 3 || s.length === 4) s = s.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(s)) return null;
  const at = (i) => parseInt(s.slice(i, i + 2), 16) / 255;
  return { r: at(0), g: at(2), b: at(4), a: s.length === 8 ? at(6) : 1 };
}

function colorHex(c) {
  const byte = (x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, "0");
  return "#" + byte(c.r) + byte(c.g) + byte(c.b) + (typeof c.a === "number" && c.a < 1 ? byte(c.a) : "");
}

const TOKEN_TYPES = {
  color: "COLOR", dimension: "FLOAT", number: "FLOAT", fontWeight: "FLOAT", duration: "FLOAT",
  string: "STRING", fontFamily: "STRING", boolean: "BOOLEAN",
  COLOR: "COLOR", FLOAT: "FLOAT", STRING: "STRING", BOOLEAN: "BOOLEAN",
};
const DTCG_OF = { COLOR: "color", FLOAT: "number", STRING: "string", BOOLEAN: "boolean" };

const SCOPES_BY_TYPE = {
  COLOR: ["ALL_SCOPES", "ALL_FILLS", "FRAME_FILL", "SHAPE_FILL", "TEXT_FILL", "STROKE_COLOR", "EFFECT_COLOR"],
  FLOAT: ["ALL_SCOPES", "TEXT_CONTENT", "CORNER_RADIUS", "WIDTH_HEIGHT", "GAP", "STROKE_FLOAT",
    "EFFECT_FLOAT", "OPACITY", "FONT_WEIGHT", "FONT_SIZE", "LINE_HEIGHT", "LETTER_SPACING",
    "PARAGRAPH_SPACING", "PARAGRAPH_INDENT"],
  STRING: ["ALL_SCOPES", "TEXT_CONTENT", "FONT_FAMILY", "FONT_STYLE"],
  BOOLEAN: ["ALL_SCOPES"],
};
const SCOPE_SHORTHANDS = {
  all: ["ALL_SCOPES"], fill: ["FRAME_FILL", "SHAPE_FILL"], fills: ["ALL_FILLS"],
  frame: ["FRAME_FILL"], shape: ["SHAPE_FILL"], text: ["TEXT_FILL"], stroke: ["STROKE_COLOR"],
  effect: ["EFFECT_COLOR"], radius: ["CORNER_RADIUS"], gap: ["GAP"], size: ["WIDTH_HEIGHT"],
  opacity: ["OPACITY"], "font-size": ["FONT_SIZE"], "line-height": ["LINE_HEIGHT"],
  "letter-spacing": ["LETTER_SPACING"], "font-weight": ["FONT_WEIGHT"], "font-family": ["FONT_FAMILY"],
  "font-style": ["FONT_STYLE"], content: ["TEXT_CONTENT"],
};

function expandScopes(list, type, where, errors) {
  if (list == null) return null;
  if (!Array.isArray(list)) { errors.push(where + ": $scopes must be an array"); return null; }
  const finish = (out) => {
    if (out.length > 1 && out.indexOf("ALL_SCOPES") !== -1) {
      errors.push(where + ": ALL_SCOPES cannot be combined with other scopes");
    }
    return out;
  };
  const out = [];
  for (const raw of list) {
    const names = SCOPE_SHORTHANDS[String(raw).toLowerCase()] || [String(raw)];
    for (const name of names) {
      if (SCOPES_BY_TYPE[type].indexOf(name) === -1) {
        errors.push(where + ": scope " + raw + " does not apply to " + type + " variables");
      } else if (out.indexOf(name) === -1) {
        out.push(name);
      }
    }
  }
  return finish(out);
}

function aliasPath(raw) {
  const m = typeof raw === "string" && raw.match(/^\{([^{}]+)\}$/);
  return m ? m[1].trim() : null;
}

function parseTokenValue(type, raw) {
  const alias = aliasPath(raw);
  if (alias) return { alias };
  if (type === "COLOR") {
    const c = parseColor(raw);
    return c ? { value: c } : { error: "not a colour: " + JSON.stringify(raw) };
  }
  if (type === "FLOAT") {
    if (typeof raw === "number" && isFinite(raw)) return { value: raw };
    const m = typeof raw === "string" && raw.trim().match(/^(-?\d+(?:\.\d+)?)(px|ms)?$/);
    if (m) return { value: parseFloat(m[1]) };
    if (raw && typeof raw === "object" && typeof raw.value === "number" &&
        (raw.unit == null || raw.unit === "px" || raw.unit === "ms")) return { value: raw.value };
    return { error: "not a number (px only): " + JSON.stringify(raw) };
  }
  if (type === "STRING") {
    return typeof raw === "string" ? { value: raw } : { error: "not a string: " + JSON.stringify(raw) };
  }
  return typeof raw === "boolean" ? { value: raw } : { error: "not a boolean: " + JSON.stringify(raw) };
}

function guessType(raw) {
  if (typeof raw === "boolean") return "BOOLEAN";
  if (typeof raw === "number") return "FLOAT";
  if (parseColor(raw)) return "COLOR";
  if (typeof raw === "string" && /^-?\d+(\.\d+)?px$/.test(raw.trim())) return "FLOAT";
  if (typeof raw === "string" && !aliasPath(raw)) return "STRING";
  return null;
}

function isModeMap(value, modes) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length > 0 && Object.keys(value).every((k) => modes.indexOf(k) !== -1);
}

function sameValue(a, b) {
  if (a && b && typeof a === "object" && typeof b === "object") {
    if (a.type === "VARIABLE_ALIAS" || b.type === "VARIABLE_ALIAS") {
      return a.type === b.type && a.id === b.id;
    }
    if ("r" in a && "r" in b) {
      const near = (x, y) => Math.abs((x == null ? 1 : x) - (y == null ? 1 : y)) < 1 / 512;
      return near(a.r, b.r) && near(a.g, b.g) && near(a.b, b.b) && near(a.a, b.a);
    }
  }
  return a === b;
}

function collectionSpecs(spec, errors) {
  if (!spec || typeof spec !== "object") {
    errors.push("spec must be an object: {collection, modes, tokens} or {collections: [...]}");
    return [];
  }
  const list = Array.isArray(spec.collections) ? spec.collections : [spec];
  return list.map((c, i) => {
    const where = "collections[" + i + "]";
    if (!c || typeof c.collection !== "string" || !c.collection.trim()) {
      errors.push(where + ": 'collection' (a name) is required");
      return null;
    }
    if (c.modes != null && (!Array.isArray(c.modes) || !c.modes.length ||
        c.modes.some((m) => typeof m !== "string" || !m.trim()))) {
      errors.push(c.collection + ": 'modes' must be a non-empty list of names");
      return null;
    }
    if (!c.tokens || typeof c.tokens !== "object") {
      errors.push(c.collection + ": 'tokens' must be an object of groups and tokens");
      return null;
    }
    return { name: c.collection.trim(), modes: c.modes ? c.modes.map((m) => m.trim()) : null, tokens: c.tokens };
  }).filter(Boolean);
}

function flattenTokens(col, errors) {
  const out = [];
  const walk = (node, path, inherited) => {
    const where = col.name + ":" + (path.join(".") || "(root)");
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      errors.push(where + ": expected a group or a token object");
      return;
    }
    const type = node.$type || inherited;
    if ("$value" in node || "$modes" in node) {
      if (!path.length) { errors.push(where + ": the root cannot be a token"); return; }
      out.push({ col, path, dotted: path.join("."), name: path.join("/"), rawType: type, node, where });
      return;
    }
    for (const key of Object.keys(node)) {
      if (key[0] === "$") continue;
      if (key.indexOf("/") !== -1) { errors.push(where + "." + key + ": '/' is not allowed in a key, nest groups instead"); continue; }
      walk(node[key], path.concat(key), type);
    }
  };
  walk(col.tokens, [], null);
  return out;
}

async function localVariableIndex() {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const variables = await figma.variables.getLocalVariablesAsync();
  const colById = new Map(collections.map((c) => [c.id, c]));
  const byId = new Map(variables.map((v) => [v.id, v]));
  return { collections, variables, colById, byId };
}

function findVariableByName(index, ref, type, errors, where) {
  let name = String(ref).trim();
  const braced = aliasPath(name);
  let colName = null;
  if (braced) name = braced;
  const colon = name.indexOf(":");
  if (colon > 0) { colName = name.slice(0, colon); name = name.slice(colon + 1); }
  const candidates = [name, name.split(".").join("/")];
  const hits = index.variables.filter((v) => candidates.indexOf(v.name) !== -1 &&
    (!colName || (index.colById.get(v.variableCollectionId) || {}).name === colName));
  if (!hits.length) { errors.push(where + ": no local variable named " + JSON.stringify(ref)); return null; }
  if (hits.length > 1) {
    errors.push(where + ": " + JSON.stringify(ref) + " is in several collections — write it as \"Collection:" + hits[0].name + "\"");
    return null;
  }
  if (type && hits[0].resolvedType !== type) {
    errors.push(where + ": " + JSON.stringify(ref) + " is a " + hits[0].resolvedType + " variable, " + type + " needed");
    return null;
  }
  return hits[0];
}

const DS_HELPERS = {
  async tokens(spec) {
    const errors = [];
    const cols = collectionSpecs(spec, errors);
    const index = await localVariableIndex();
    const colByName = new Map(index.collections.map((c) => [c.name, c]));
    const tokens = [];
    const byPath = new Map();
    for (const col of cols) {
      const existing = colByName.get(col.name);
      if (!col.modes) col.modes = existing ? existing.modes.map((m) => m.name) : ["Default"];
      for (const t of flattenTokens(col, errors)) {
        const key = col.name + "\u0000" + t.dotted;
        if (byPath.has(key)) { errors.push(t.where + ": defined twice"); continue; }
        byPath.set(key, t);
        if (!byPath.has(t.dotted)) byPath.set(t.dotted, t);
        else byPath.set(t.dotted, "ambiguous");
        tokens.push(t);
      }
    }
    const existingDotted = new Map();
    for (const v of index.variables) {
      const col = index.colById.get(v.variableCollectionId);
      const dotted = v.name.split("/").join(".");
      for (const key of [dotted, (col ? col.name : "") + "\u0000" + dotted]) {
        existingDotted.set(key, existingDotted.has(key) && key === dotted ? "ambiguous" : v);
      }
    }
    const resolveRef = (path, fromCol) => {
      const qualified = path.match(/^([^.:]+)[:.](.+)$/);
      const tries = [fromCol + "\u0000" + path, path];
      if (qualified) tries.push(qualified[1] + "\u0000" + qualified[2]);
      for (const key of tries) {
        const t = byPath.get(key);
        if (t && t !== "ambiguous") return { token: t };
        if (t === "ambiguous") return { error: "{" + path + "} exists in several collections — write {Collection." + path + "}" };
      }
      for (const key of tries) {
        const v = existingDotted.get(key);
        if (v && v !== "ambiguous") return { variable: v };
        if (v === "ambiguous") return { error: "{" + path + "} matches variables in several collections — write {Collection." + path + "}" };
      }
      return { error: "{" + path + "} does not match any token or local variable" };
    };

    for (const t of tokens) {
      const modes = t.col.modes;
      const v = t.node.$value;
      t.raw = {};
      if (isModeMap(v, modes)) {
        Object.assign(t.raw, v);
      } else if (v !== undefined) {
        for (const m of modes) t.raw[m] = v;
      }
      if (t.node.$modes != null) {
        if (typeof t.node.$modes !== "object" || Array.isArray(t.node.$modes)) {
          errors.push(t.where + ": $modes must map mode names to values");
        } else {
          for (const m of Object.keys(t.node.$modes)) {
            if (modes.indexOf(m) === -1) errors.push(t.where + ": unknown mode " + JSON.stringify(m) + " (modes: " + modes.join(", ") + ")");
            else t.raw[m] = t.node.$modes[m];
          }
        }
      }
      if (!Object.keys(t.raw).length) errors.push(t.where + ": no value");
      if (t.rawType != null) {
        t.type = TOKEN_TYPES[t.rawType];
        if (!t.type) errors.push(t.where + ": unknown $type " + JSON.stringify(t.rawType));
      }
    }
    const typeOf = (t, depth) => {
      if (t.type) return t.type;
      if (depth > 20) return null;
      for (const m of Object.keys(t.raw)) {
        const g = guessType(t.raw[m]);
        if (g) return g;
        const path = aliasPath(t.raw[m]);
        if (path) {
          const r = resolveRef(path, t.col.name);
          if (r.token && r.token !== t) { const ty = typeOf(r.token, depth + 1); if (ty) return ty; }
          if (r.variable) return r.variable.resolvedType;
        }
      }
      return null;
    };
    for (const t of tokens) {
      if (!t.type) t.type = typeOf(t, 0);
      if (!t.type) {
        const broken = Object.keys(t.raw).map((m) => aliasPath(t.raw[m])).filter(Boolean)
          .map((path) => resolveRef(path, t.col.name)).find((r) => r.error);
        errors.push(t.where + ": " + (broken ? broken.error : "cannot tell its type — add $type"));
        continue;
      }
      t.values = {};
      for (const m of Object.keys(t.raw)) {
        const p = parseTokenValue(t.type, t.raw[m]);
        if (p.error) { errors.push(t.where + " [" + m + "]: " + p.error); continue; }
        if (p.alias) {
          const r = resolveRef(p.alias, t.col.name);
          if (r.error) { errors.push(t.where + " [" + m + "]: " + r.error); continue; }
          if (r.token === t) { errors.push(t.where + ": refers to itself"); continue; }
          const targetType = r.token ? (r.token.type || typeOf(r.token, 0)) : r.variable.resolvedType;
          if (targetType && targetType !== t.type) {
            errors.push(t.where + " [" + m + "]: {" + p.alias + "} is " + targetType + ", this token is " + t.type);
            continue;
          }
          t.values[m] = r;
        } else {
          t.values[m] = { value: p.value };
        }
      }
      t.scopes = expandScopes(t.node.$scopes, t.type, t.where, errors);
      const cs = t.node.$codeSyntax;
      if (cs != null && (typeof cs !== "object" || Object.keys(cs).some((k) => ["WEB", "ANDROID", "iOS"].indexOf(k) === -1))) {
        errors.push(t.where + ": $codeSyntax keys are WEB, ANDROID, iOS");
      }
      const col = colByName.get(t.col.name);
      if (col) {
        const clash = index.variables.find((v) => v.variableCollectionId === col.id && v.name === t.name);
        if (clash && clash.resolvedType !== t.type) {
          errors.push(t.where + ": already exists as a " + clash.resolvedType + " variable, spec says " + t.type);
        }
        t.existing = clash || null;
      }
    }
    const state = new Map();
    const cycle = (t, trail) => {
      if (state.get(t) === "done") return false;
      if (state.get(t) === "open") {
        errors.push("alias cycle: " + trail.concat(t.dotted).join(" → "));
        return true;
      }
      state.set(t, "open");
      for (const m of Object.keys(t.values || {})) {
        const r = t.values[m];
        if (r.token && cycle(r.token, trail.concat(t.dotted))) { state.set(t, "done"); return true; }
      }
      state.set(t, "done");
      return false;
    };
    for (const t of tokens) cycle(t, []);
    if (errors.length) throw problems("h.tokens", errors);

    const report = { created: [], updated: [], unchanged: 0, collections: {} };
    for (const col of cols) {
      let collection = colByName.get(col.name);
      const fresh = !collection;
      if (fresh) collection = figma.variables.createVariableCollection(col.name);
      const modeIds = {};
      const addedModes = [];
      col.modes.forEach((m, i) => {
        const found = collection.modes.find((x) => x.name === m);
        if (found) { modeIds[m] = found.modeId; return; }
        const only = collection.modes.length === 1 && i === 0 &&
          (fresh || (collection.modes[0].name === "Mode 1" && col.modes.indexOf("Mode 1") === -1));
        if (only) {
          collection.renameMode(collection.modes[0].modeId, m);
          modeIds[m] = collection.modes[0].modeId;
        } else {
          modeIds[m] = collection.addMode(m);
          addedModes.push(m);
        }
      });
      col.collection = collection;
      col.modeIds = modeIds;
      report.collections[col.name] = { id: collection.id, created: fresh, modes: col.modes, addedModes };
    }
    for (const t of tokens) {
      if (t.existing) { t.variable = t.existing; continue; }
      t.variable = figma.variables.createVariable(t.name, t.col.collection, t.type);
      t.created = true;
    }
    for (const t of tokens) {
      const v = t.variable;
      let changed = false;
      for (const m of Object.keys(t.values)) {
        const r = t.values[m];
        const value = r.value !== undefined ? r.value
          : figma.variables.createVariableAlias(r.token ? r.token.variable : r.variable);
        const modeId = t.col.modeIds[m];
        if (!sameValue(v.valuesByMode[modeId], value)) { v.setValueForMode(modeId, value); changed = true; }
      }
      if (typeof t.node.$description === "string" && v.description !== t.node.$description) {
        v.description = t.node.$description; changed = true;
      }
      if (t.scopes && JSON.stringify((v.scopes || []).slice().sort()) !== JSON.stringify(t.scopes.slice().sort())) {
        v.scopes = t.scopes; changed = true;
      }
      const cs = t.node.$codeSyntax || {};
      for (const platform of Object.keys(cs)) {
        if ((v.codeSyntax || {})[platform] !== cs[platform]) { v.setVariableCodeSyntax(platform, cs[platform]); changed = true; }
      }
      if (typeof t.node.$hidden === "boolean" && v.hiddenFromPublishing !== t.node.$hidden) {
        v.hiddenFromPublishing = t.node.$hidden; changed = true;
      }
      if (t.created) report.created.push(t.name);
      else if (changed) report.updated.push(t.name);
      else report.unchanged += 1;
    }
    return compactReport(report);
  },

  async exportTokens(collectionName) {
    const index = await localVariableIndex();
    const cols = collectionName == null ? index.collections
      : index.collections.filter((c) => c.name === collectionName);
    if (collectionName != null && !cols.length) {
      throw new Error("h.exportTokens: no local collection named " + JSON.stringify(collectionName) +
        " (have: " + index.collections.map((c) => c.name).join(", ") + ")");
    }
    const exportValue = (v, raw) => {
      if (raw && typeof raw === "object" && raw.type === "VARIABLE_ALIAS") {
        const target = index.byId.get(raw.id);
        if (!target) return null;
        const own = index.colById.get(target.variableCollectionId);
        const dotted = target.name.split("/").join(".");
        return target.variableCollectionId === v.variableCollectionId || !own
          ? "{" + dotted + "}" : "{" + own.name + "." + dotted + "}";
      }
      return v.resolvedType === "COLOR" ? colorHex(raw) : raw;
    };
    return {
      collections: cols.map((col) => {
        const tree = {};
        for (const id of col.variableIds) {
          const v = index.byId.get(id);
          if (!v) continue;
          const values = {};
          for (const m of col.modes) values[m.name] = exportValue(v, v.valuesByMode[m.modeId]);
          const distinct = new Set(Object.keys(values).map((k) => JSON.stringify(values[k])));
          const token = { $type: DTCG_OF[v.resolvedType], $value: distinct.size === 1 ? values[col.modes[0].name] : values };
          if (v.description) token.$description = v.description;
          if (v.scopes && v.scopes.length && !(v.scopes.length === 1 && v.scopes[0] === "ALL_SCOPES")) token.$scopes = v.scopes.slice();
          if (v.codeSyntax && Object.keys(v.codeSyntax).length) token.$codeSyntax = Object.assign({}, v.codeSyntax);
          if (v.hiddenFromPublishing) token.$hidden = true;
          const parts = v.name.split("/");
          let node = tree;
          for (let i = 0; i < parts.length - 1; i++) {
            if (!node[parts[i]] || "$value" in node[parts[i]]) {
              if (node[parts[i]]) { node = null; break; }
              node[parts[i]] = {};
            }
            node = node[parts[i]];
          }
          if (node) node[parts[parts.length - 1]] = token;
        }
        return { collection: col.name, modes: col.modes.map((m) => m.name), tokens: tree };
      }),
    };
  },
};

function compactReport(report, cap) {
  cap = cap || 40;
  const out = {};
  for (const key of Object.keys(report)) {
    const v = report[key];
    if (Array.isArray(v) && v.length > cap) {
      out[key] = v.slice(0, cap).concat(["… +" + (v.length - cap) + " more"]);
    } else {
      out[key] = v;
    }
  }
  return out;
}

function listOf(spec, key) {
  if (Array.isArray(spec)) return spec;
  return spec && Array.isArray(spec[key]) ? spec[key] : null;
}

function numberOrVar(index, value, field, where, errors) {
  if (value == null) return null;
  if (typeof value === "number" && isFinite(value)) return { value };
  if (typeof value === "string" && /^-?\d+(\.\d+)?(px)?$/.test(value.trim())) return { value: parseFloat(value) };
  if (typeof value === "string") {
    const v = findVariableByName(index, value, "FLOAT", errors, where + "." + field);
    return v ? { variable: v } : null;
  }
  errors.push(where + "." + field + ": expected a number or a FLOAT variable name");
  return null;
}

function paintOrVar(index, value, where, errors) {
  if (value == null || value === false) return { none: true };
  const c = typeof value === "string" && value.trim()[0] === "#" ? parseColor(value) : null;
  if (c) return { color: c };
  if (typeof value === "string" && value.trim()[0] === "#") {
    errors.push(where + ": not a colour: " + JSON.stringify(value));
    return null;
  }
  if (typeof value === "string") {
    const v = findVariableByName(index, value, "COLOR", errors, where);
    return v ? { variable: v } : null;
  }
  errors.push(where + ": expected a #hex colour, a COLOR variable name, or null");
  return null;
}

function applyPaint(node, prop, p) {
  if (!p) return;
  if (p.none) { node[prop] = []; return; }
  if (p.color) {
    const paint = { type: "SOLID", color: { r: p.color.r, g: p.color.g, b: p.color.b } };
    if (p.color.a < 1) paint.opacity = p.color.a;
    node[prop] = [paint];
    return;
  }
  const base = { type: "SOLID", color: { r: 0.5, g: 0.5, b: 0.5 } };
  node[prop] = [figma.variables.setBoundVariableForPaint(base, "color", p.variable)];
}

function applyNumber(node, fields, n) {
  if (!n) return;
  for (const f of fields) {
    if (n.variable) node.setBoundVariable(f, n.variable);
    else {
      if (node.boundVariables && node.boundVariables[f]) node.setBoundVariable(f, null);
      node[f] = n.value;
    }
  }
}

async function fontsLoad(fonts, errors, who) {
  const seen = new Set();
  for (const f of fonts) {
    const key = f.family + "|" + f.style;
    if (seen.has(key)) continue;
    seen.add(key);
    try { await figma.loadFontAsync(f); } catch (e) {
      errors.push(who + ": font " + f.family + " " + f.style + " is not available");
    }
  }
}

function lineHeightOf(value) {
  if (value == null) return null;
  if (value === "auto" || value === "AUTO") return { unit: "AUTO" };
  if (typeof value === "number") return { unit: "PIXELS", value };
  const m = typeof value === "string" && value.trim().match(/^(-?\d+(?:\.\d+)?)(%|px)?$/);
  if (!m) return null;
  return { unit: m[2] === "%" ? "PERCENT" : "PIXELS", value: parseFloat(m[1]) };
}

function letterSpacingOf(value) {
  if (value == null) return null;
  if (typeof value === "number") return { unit: "PIXELS", value };
  const m = typeof value === "string" && value.trim().match(/^(-?\d+(?:\.\d+)?)(%|px)?$/);
  if (!m) return null;
  return { unit: m[2] === "%" ? "PERCENT" : "PIXELS", value: parseFloat(m[1]) };
}

function isVarRef(value) {
  return typeof value === "string" && !/^-?\d+(\.\d+)?(px|%)?$/.test(value.trim()) && value.toLowerCase() !== "auto";
}

function cartesian(axes) {
  let out = [{}];
  for (const key of Object.keys(axes)) {
    const next = [];
    for (const partial of out) for (const value of axes[key]) next.push(Object.assign({}, partial, { [key]: value }));
    out = next;
  }
  return out;
}

function variantName(combo) {
  return Object.keys(combo).map((k) => k + "=" + combo[k]).join(", ");
}

function variantKey(props, keys) {
  return keys.map((k) => k + "=" + (props ? props[k] : "")).join("|");
}

const STYLE_KEYS = ["layout", "padding", "spacing", "radius", "fill", "stroke", "strokeWeight",
  "width", "height", "align", "textSize", "textFill", "textStyle", "font"];

function ruleMatches(when, combo) {
  return Object.keys(when).every((k) => {
    const want = when[k];
    return Array.isArray(want) ? want.indexOf(combo[k]) !== -1 : combo[k] === want;
  });
}

async function targetPage(name) {
  if (!name) return figma.currentPage;
  let page = figma.root.children.find((p) => p.name === name);
  if (!page) {
    page = figma.createPage();
    page.name = name;
  }
  if (page.loadAsync) await page.loadAsync();
  return page;
}

function propKey(defs, name, type) {
  for (const key of Object.keys(defs || {})) {
    if (key.split("#")[0] === name && defs[key].type === type) return key;
  }
  return null;
}

Object.assign(DS_HELPERS, {
  async textStyles(spec) {
    const list = listOf(spec, "styles");
    const errors = [];
    if (!list) throw problems("h.textStyles", ["spec must be {styles: [...]} or a list"]);
    const index = await localVariableIndex();
    const plans = [];
    const fonts = [];
    list.forEach((s, i) => {
      const where = "styles[" + i + "]" + (s && s.name ? " " + s.name : "");
      if (!s || typeof s.name !== "string" || !s.name.trim()) { errors.push(where + ": 'name' is required"); return; }
      if (typeof s.fontFamily !== "string") { errors.push(where + ": 'fontFamily' is required"); return; }
      const font = { family: s.fontFamily, style: s.fontStyle || "Regular" };
      fonts.push(font);
      const plan = { s, font, bind: {}, set: {} };
      if (s.fontSize != null) {
        const n = numberOrVar(index, s.fontSize, "fontSize", where, errors);
        if (n && n.variable) plan.bind.fontSize = n.variable; else if (n) plan.set.fontSize = n.value;
      }
      for (const [field, parse] of [["lineHeight", lineHeightOf], ["letterSpacing", letterSpacingOf]]) {
        if (s[field] == null) continue;
        if (isVarRef(s[field])) {
          const v = findVariableByName(index, s[field], "FLOAT", errors, where + "." + field);
          if (v) plan.bind[field] = v;
        } else {
          const parsed = parse(s[field]);
          if (!parsed) errors.push(where + "." + field + ": cannot read " + JSON.stringify(s[field]));
          else plan.set[field] = parsed;
        }
      }
      if (s.paragraphSpacing != null) {
        const n = numberOrVar(index, s.paragraphSpacing, "paragraphSpacing", where, errors);
        if (n && n.variable) plan.bind.paragraphSpacing = n.variable; else if (n) plan.set.paragraphSpacing = n.value;
      }
      const enums = {
        textCase: ["ORIGINAL", "UPPER", "LOWER", "TITLE", "SMALL_CAPS", "SMALL_CAPS_FORCED"],
        textDecoration: ["NONE", "UNDERLINE", "STRIKETHROUGH"],
      };
      for (const field of Object.keys(enums)) {
        if (s[field] == null) continue;
        if (enums[field].indexOf(s[field]) === -1) errors.push(where + "." + field + ": one of " + enums[field].join(", "));
        else plan.set[field] = s[field];
      }
      if (typeof s.description === "string") plan.set.description = s.description;
      plans.push(plan);
    });
    const names = plans.map((p) => p.s.name);
    names.forEach((n, i) => { if (names.indexOf(n) !== i) errors.push("styles: " + n + " is listed twice"); });
    await fontsLoad(fonts, errors, "h.textStyles");
    if (errors.length) throw problems("h.textStyles", errors);

    const existing = new Map((await figma.getLocalTextStylesAsync()).map((s) => [s.name, s]));
    const report = { created: [], updated: [], unchanged: 0 };
    for (const p of plans) {
      let style = existing.get(p.s.name);
      const fresh = !style;
      if (fresh) { style = figma.createTextStyle(); style.name = p.s.name; }
      const before = fresh ? null : JSON.stringify(snapshotText(style));
      style.fontName = p.font;
      for (const key of Object.keys(p.set)) {
        if (style.boundVariables && style.boundVariables[key] && style.setBoundVariable) style.setBoundVariable(key, null);
        style[key] = p.set[key];
      }
      for (const field of Object.keys(p.bind)) style.setBoundVariable(field, p.bind[field]);
      if (fresh) report.created.push(style.name);
      else if (before !== JSON.stringify(snapshotText(style))) report.updated.push(style.name);
      else report.unchanged += 1;
    }
    return compactReport(report);
  },

  async effectStyles(spec) {
    const list = listOf(spec, "styles");
    const errors = [];
    if (!list) throw problems("h.effectStyles", ["spec must be {styles: [...]} or a list"]);
    const plans = [];
    list.forEach((s, i) => {
      const where = "styles[" + i + "]" + (s && s.name ? " " + s.name : "");
      if (!s || typeof s.name !== "string" || !s.name.trim()) { errors.push(where + ": 'name' is required"); return; }
      if (!Array.isArray(s.effects) || !s.effects.length) { errors.push(where + ": 'effects' must be a non-empty list"); return; }
      const effects = s.effects.map((e, j) => {
        const at = where + ".effects[" + j + "]";
        const type = String((e && e.type) || "DROP_SHADOW").toUpperCase();
        if (type === "DROP_SHADOW" || type === "INNER_SHADOW") {
          const color = parseColor(e.color == null ? "#00000040" : e.color);
          if (!color) { errors.push(at + ": not a colour: " + JSON.stringify(e.color)); return null; }
          return {
            type, color, offset: { x: Number(e.x || 0), y: Number(e.y || 0) },
            radius: Number(e.blur || 0), spread: Number(e.spread || 0),
            visible: e.visible !== false, blendMode: e.blendMode || "NORMAL",
          };
        }
        if (type === "LAYER_BLUR" || type === "BACKGROUND_BLUR") {
          return { type, radius: Number(e.radius != null ? e.radius : e.blur || 0), visible: e.visible !== false };
        }
        errors.push(at + ": unknown effect type " + JSON.stringify(e && e.type));
        return null;
      });
      plans.push({ s, effects });
    });
    if (errors.length) throw problems("h.effectStyles", errors);

    const existing = new Map((await figma.getLocalEffectStylesAsync()).map((s) => [s.name, s]));
    const report = { created: [], updated: [], unchanged: 0 };
    for (const p of plans) {
      let style = existing.get(p.s.name);
      const fresh = !style;
      if (fresh) { style = figma.createEffectStyle(); style.name = p.s.name; }
      const before = fresh ? null : JSON.stringify(style.effects) + style.description;
      style.effects = p.effects;
      if (typeof p.s.description === "string") style.description = p.s.description;
      if (fresh) report.created.push(style.name);
      else if (before !== JSON.stringify(style.effects) + style.description) report.updated.push(style.name);
      else report.unchanged += 1;
    }
    return compactReport(report);
  },

  async componentSet(spec) {
    const errors = [];
    const who = "h.componentSet";
    if (!spec || typeof spec.name !== "string" || !spec.name.trim()) throw problems(who, ["'name' is required"]);
    const axes = spec.variants;
    if (!axes || typeof axes !== "object" || !Object.keys(axes).length) {
      throw problems(who, ["'variants' must map property names to lists of values"]);
    }
    for (const k of Object.keys(axes)) {
      const vals = axes[k];
      if (/[=,]/.test(k)) errors.push("variants: property " + JSON.stringify(k) + " cannot contain = or ,");
      if (!Array.isArray(vals) || !vals.length) { errors.push("variants." + k + ": needs a non-empty list"); continue; }
      vals.forEach((v, i) => {
        if (typeof v !== "string" || !v.trim() || /[=,]/.test(v)) errors.push("variants." + k + "[" + i + "]: a non-empty string without = or ,");
        if (vals.indexOf(v) !== i) errors.push("variants." + k + ": " + v + " is listed twice");
      });
    }
    if (errors.length) throw problems(who, errors);
    const rules = spec.rules || [];
    if (!Array.isArray(rules)) errors.push("'rules' must be a list of {when, set}");
    const checkStyle = (st, where) => {
      for (const key of Object.keys(st || {})) if (STYLE_KEYS.indexOf(key) === -1) errors.push(where + ": unknown key " + key + " (allowed: " + STYLE_KEYS.join(", ") + ")");
    };
    checkStyle(spec.base, "base");
    (Array.isArray(rules) ? rules : []).forEach((r, i) => {
      if (!r || typeof r.when !== "object" || typeof r.set !== "object") { errors.push("rules[" + i + "]: needs {when, set}"); return; }
      for (const k of Object.keys(r.when)) {
        if (!axes[k]) { errors.push("rules[" + i + "].when: unknown property " + k); continue; }
        const want = Array.isArray(r.when[k]) ? r.when[k] : [r.when[k]];
        for (const w of want) if (axes[k].indexOf(w) === -1) errors.push("rules[" + i + "].when." + k + ": unknown value " + w);
      }
      checkStyle(r.set, "rules[" + i + "].set");
    });

    const index = await localVariableIndex();
    const text = spec.text === null || spec.text === false ? null
      : Object.assign({ name: "Label", value: spec.name }, spec.text || {});
    const textStyles = text ? await figma.getLocalTextStylesAsync() : [];
    const combos = cartesian(axes);
    const fonts = [];
    const plans = combos.map((combo) => {
      const st = Object.assign({}, spec.base || {});
      for (const r of Array.isArray(rules) ? rules : []) {
        if (r && r.when && r.set && ruleMatches(r.when, combo)) Object.assign(st, r.set);
      }
      const where = variantName(combo);
      const plan = { combo, name: where };
      plan.layout = st.layout == null ? "HORIZONTAL" : ({ H: "HORIZONTAL", V: "VERTICAL" })[String(st.layout).toUpperCase()] || String(st.layout).toUpperCase();
      if (["HORIZONTAL", "VERTICAL"].indexOf(plan.layout) === -1) errors.push(where + ": layout must be H or V");
      const pad = st.padding;
      if (pad != null) {
        const arr = Array.isArray(pad) ? pad : [pad];
        const sides = arr.length === 1 ? [arr[0], arr[0], arr[0], arr[0]]
          : arr.length === 2 ? [arr[0], arr[1], arr[0], arr[1]]
          : arr.length === 4 ? arr : null;
        if (!sides) errors.push(where + ": padding is a number, [vertical, horizontal] or [top, right, bottom, left]");
        else plan.padding = sides.map((v, i) => numberOrVar(index, v, ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"][i], where, errors));
      }
      plan.spacing = numberOrVar(index, st.spacing, "spacing", where, errors);
      plan.radius = numberOrVar(index, st.radius, "radius", where, errors);
      plan.width = numberOrVar(index, st.width, "width", where, errors);
      plan.height = numberOrVar(index, st.height, "height", where, errors);
      if (st.strokeWeight != null && typeof st.strokeWeight !== "number") errors.push(where + ": strokeWeight must be a number");
      plan.strokeWeight = st.strokeWeight;
      plan.fill = paintOrVar(index, st.fill === undefined ? "#ffffff" : st.fill, where + ".fill", errors);
      plan.stroke = st.stroke === undefined ? null : paintOrVar(index, st.stroke, where + ".stroke", errors);
      plan.align = Object.assign({ primary: "CENTER", counter: "CENTER" }, st.align || {});
      if (["MIN", "CENTER", "MAX", "SPACE_BETWEEN"].indexOf(plan.align.primary) === -1) {
        errors.push(where + ": align.primary is MIN, CENTER, MAX or SPACE_BETWEEN");
      }
      if (["MIN", "CENTER", "MAX", "BASELINE"].indexOf(plan.align.counter) === -1) {
        errors.push(where + ": align.counter is MIN, CENTER, MAX or BASELINE");
      }
      if (text) {
        const font = Object.assign({ family: "Inter", style: "Medium" }, text.font || {}, st.font || {});
        plan.font = { family: font.family, style: font.style };
        fonts.push(plan.font);
        plan.textSize = numberOrVar(index, st.textSize != null ? st.textSize : text.size, "textSize", where, errors);
        const tf = st.textFill !== undefined ? st.textFill : text.fill;
        plan.textFill = tf === undefined ? null : paintOrVar(index, tf, where + ".textFill", errors);
        const tsName = st.textStyle || text.style;
        if (tsName) {
          plan.textStyle = textStyles.find((s) => s.name === tsName);
          if (!plan.textStyle) errors.push(where + ": no local text style named " + JSON.stringify(tsName));
        }
      }
      return plan;
    });
    if (text && (typeof text.name !== "string" || !text.name)) errors.push("text.name must be a layer name");
    await fontsLoad(fonts, errors, who);
    const boolProps = spec.properties || [];
    if (!Array.isArray(boolProps)) errors.push("'properties' must be a list");
    for (const p of Array.isArray(boolProps) ? boolProps : []) {
      if (!p || typeof p.name !== "string") errors.push("properties: each needs a name");
      else if (p.type !== "BOOLEAN" || typeof p.layer !== "string") errors.push("properties." + p.name + ": only {type: \"BOOLEAN\", layer: \"<child name>\"} is supported");
    }
    if (errors.length) throw problems(who, errors);

    const page = await targetPage(spec.page);
    const keys = Object.keys(axes);
    let set = page.children.find((n) => n.type === "COMPONENT_SET" && n.name === spec.name);
    const byKey = new Map();
    if (set) for (const c of set.children) if (c.type === "COMPONENT") byKey.set(variantKey(c.variantProperties, keys), c);
    const report = { created: 0, restyled: 0, extra: [] };
    const fresh = [];
    const textNodes = [];
    for (const plan of plans) {
      let comp = byKey.get(variantKey(plan.combo, keys));
      let label = null;
      if (comp) {
        report.restyled += 1;
        label = text ? comp.findOne((n) => n.type === "TEXT" && n.name === text.name) : null;
      } else {
        comp = figma.createComponent();
        page.appendChild(comp);
        comp.name = plan.name;
        fresh.push(comp);
        report.created += 1;
      }
      comp.layoutMode = plan.layout;
      if (plan.width && plan.width.value != null) comp.resize(plan.width.value, comp.height);
      if (plan.height && plan.height.value != null) comp.resize(comp.width, plan.height.value);
      const horizontal = plan.layout === "HORIZONTAL";
      comp.primaryAxisSizingMode = (horizontal ? plan.width : plan.height) ? "FIXED" : "AUTO";
      comp.counterAxisSizingMode = (horizontal ? plan.height : plan.width) ? "FIXED" : "AUTO";
      if (plan.width && plan.width.variable) comp.setBoundVariable("width", plan.width.variable);
      if (plan.height && plan.height.variable) comp.setBoundVariable("height", plan.height.variable);
      comp.primaryAxisAlignItems = plan.align.primary;
      comp.counterAxisAlignItems = plan.align.counter;
      applyNumber(comp, ["itemSpacing"], plan.spacing);
      if (plan.padding) plan.padding.forEach((n, i) => applyNumber(comp, [["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"][i]], n));
      applyNumber(comp, ["topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"], plan.radius);
      applyPaint(comp, "fills", plan.fill);
      if (plan.stroke) applyPaint(comp, "strokes", plan.stroke);
      if (plan.strokeWeight != null) comp.strokeWeight = plan.strokeWeight;
      if (text) {
        if (!label) {
          label = figma.createText();
          comp.appendChild(label);
          label.name = text.name;
          label.fontName = plan.font;
          label.characters = String(text.value == null ? spec.name : text.value);
        } else {
          label.fontName = plan.font;
        }
        if (plan.textStyle) await label.setTextStyleIdAsync(plan.textStyle.id);
        applyNumber(label, ["fontSize"], plan.textSize);
        if (plan.textFill) applyPaint(label, "fills", plan.textFill);
        textNodes.push(label);
      }
    }
    if (!set) {
      set = figma.combineAsVariants(fresh, page);
      set.name = spec.name;
    } else {
      for (const comp of fresh) set.appendChild(comp);
      const wanted = new Set(plans.map((p) => variantKey(p.combo, keys)));
      for (const c of set.children) if (!wanted.has(variantKey(c.variantProperties, keys))) report.extra.push(c.name);
    }
    if (typeof spec.description === "string") set.description = spec.description;
    const properties = [];
    if (text && text.property) {
      let key = propKey(set.componentPropertyDefinitions, text.property, "TEXT");
      if (!key) key = set.addComponentProperty(text.property, "TEXT", String(text.value == null ? spec.name : text.value));
      for (const t of textNodes) t.componentPropertyReferences = Object.assign({}, t.componentPropertyReferences, { characters: key });
      properties.push(key);
    }
    const missingLayers = [];
    for (const p of boolProps) {
      let key = propKey(set.componentPropertyDefinitions, p.name, "BOOLEAN");
      if (!key) key = set.addComponentProperty(p.name, "BOOLEAN", p.default !== false);
      for (const comp of set.children) {
        const layer = comp.findOne((n) => n.name === p.layer);
        if (layer) layer.componentPropertyReferences = Object.assign({}, layer.componentPropertyReferences, { visible: key });
        else missingLayers.push(comp.name + " has no layer " + p.layer);
      }
      properties.push(key);
    }
    const arranged = spec.arrange === false ? null : DS_HELPERS.arrange(set, spec.arrange || {});
    return {
      set: { id: set.id, name: set.name, page: page.name },
      variants: set.children.length,
      created: report.created,
      restyled: report.restyled,
      extra: report.extra,
      properties,
      missingLayers: missingLayers.slice(0, 20),
      grid: arranged,
    };
  },

  arrange(set, opts) {
    opts = opts || {};
    if (!set || set.type !== "COMPONENT_SET") throw new Error("h.arrange: expected a COMPONENT_SET");
    const gap = opts.gap == null ? 24 : opts.gap;
    const pad = opts.padding == null ? 24 : opts.padding;
    const groups = set.variantGroupProperties || {};
    const keys = Object.keys(groups);
    const colKey = opts.columns && groups[opts.columns] ? opts.columns : keys[keys.length - 1];
    const colValues = colKey ? groups[colKey].values : [""];
    const rowKeys = keys.filter((k) => k !== colKey);
    const rows = [];
    const cells = new Map();
    const order = (c) => rowKeys.map((k) => groups[k].values.indexOf(c.variantProperties[k]));
    const children = set.children.slice().sort((a, b) => {
      const oa = order(a), ob = order(b);
      for (let i = 0; i < oa.length; i++) if (oa[i] !== ob[i]) return oa[i] - ob[i];
      return 0;
    });
    for (const c of children) {
      const rk = rowKeys.map((k) => c.variantProperties[k]).join("|");
      if (rows.indexOf(rk) === -1) rows.push(rk);
      cells.set(rk + "#" + (colKey ? c.variantProperties[colKey] : ""), c);
    }
    if (set.layoutMode && set.layoutMode !== "NONE") set.layoutMode = "NONE";
    const colW = colValues.map((cv) => Math.max(0, ...rows.map((r) => { const c = cells.get(r + "#" + cv); return c ? c.width : 0; })));
    const rowH = rows.map((r) => Math.max(0, ...colValues.map((cv) => { const c = cells.get(r + "#" + cv); return c ? c.height : 0; })));
    let y = pad;
    rows.forEach((r, ri) => {
      let x = pad;
      colValues.forEach((cv, ci) => {
        const c = cells.get(r + "#" + cv);
        if (c) { c.x = x; c.y = y; }
        x += colW[ci] + gap;
      });
      y += rowH[ri] + gap;
    });
    const w = pad * 2 + colW.reduce((a, b) => a + b, 0) + gap * Math.max(0, colValues.length - 1);
    const hgt = pad * 2 + rowH.reduce((a, b) => a + b, 0) + gap * Math.max(0, rows.length - 1);
    set.resizeWithoutConstraints(Math.max(1, w), Math.max(1, hgt));
    return { rows: rows.length, columns: colValues.length, by: colKey || null };
  },

  async bindAuto(root, map) {
    map = map || {};
    root = root || figma.currentPage;
    const errors = [];
    const index = await localVariableIndex();
    const inCollection = (v) => !map.collection || (index.colById.get(v.variableCollectionId) || {}).name === map.collection;
    const colors = new Map();
    const ambiguous = new Set();
    if (map.colors && typeof map.colors === "object") {
      for (const hex of Object.keys(map.colors)) {
        const c = parseColor(hex);
        if (!c) { errors.push("colors: not a colour: " + hex); continue; }
        const v = findVariableByName(index, map.colors[hex], "COLOR", errors, "colors." + hex);
        if (v) colors.set(colorHex(Object.assign({}, c, { a: 1 })), v);
      }
    } else if (map.colors !== false) {
      for (const v of index.variables) {
        if (v.resolvedType !== "COLOR" || !inCollection(v)) continue;
        const col = index.colById.get(v.variableCollectionId);
        const raw = col && v.valuesByMode[col.defaultModeId];
        if (!raw || raw.type === "VARIABLE_ALIAS") continue;
        const hex = colorHex(Object.assign({}, raw, { a: 1 }));
        if (colors.has(hex) && colors.get(hex) !== v) ambiguous.add(hex);
        else colors.set(hex, v);
      }
      for (const hex of ambiguous) colors.delete(hex);
    }
    const numbers = { radius: new Map(), spacing: new Map() };
    const scopeOf = { radius: "CORNER_RADIUS", spacing: "GAP" };
    for (const kind of Object.keys(numbers)) {
      const given = map[kind];
      if (given && typeof given === "object") {
        for (const value of Object.keys(given)) {
          const v = findVariableByName(index, given[value], "FLOAT", errors, kind + "." + value);
          if (v) numbers[kind].set(Number(value), v);
        }
      } else if (given !== false) {
        const dup = new Set();
        for (const v of index.variables) {
          if (v.resolvedType !== "FLOAT" || !inCollection(v) || (v.scopes || []).indexOf(scopeOf[kind]) === -1) continue;
          const col = index.colById.get(v.variableCollectionId);
          const raw = col && v.valuesByMode[col.defaultModeId];
          if (typeof raw !== "number") continue;
          if (numbers[kind].has(raw)) dup.add(raw); else numbers[kind].set(raw, v);
        }
        for (const d of dup) numbers[kind].delete(d);
      }
    }
    if (errors.length) throw problems("h.bindAuto", errors);

    const counts = { fills: 0, strokes: 0, radius: 0, spacing: 0, padding: 0, failed: 0 };
    const failures = [];
    const unmatched = {};
    const visit = (n) => {
      try { bindNode(n); } catch (e) {
        counts.failed += 1;
        if (failures.length < 10) failures.push(n.id + " " + n.name + ": " + ((e && e.message) || e));
      }
      if (n.type !== "INSTANCE" && n.children) for (const c of n.children) visit(c);
    };
    const bindNode = (n) => {
      for (const prop of ["fills", "strokes"]) {
        const paints = n[prop];
        if (!Array.isArray(paints) || !paints.length) continue;
        if ((prop === "fills" ? n.fillStyleId : n.strokeStyleId)) continue;
        let changed = false;
        const next = paints.map((p) => {
          if (p.type !== "SOLID" || (p.boundVariables && p.boundVariables.color)) return p;
          const hex = colorHex(Object.assign({}, p.color, { a: 1 }));
          const v = colors.get(hex);
          if (!v) { unmatched[hex] = (unmatched[hex] || 0) + 1; return p; }
          changed = true;
          counts[prop] += 1;
          return figma.variables.setBoundVariableForPaint(p, "color", v);
        });
        if (changed) n[prop] = next;
      }
      const bv = n.boundVariables || {};
      if (typeof n.cornerRadius === "number" && n.cornerRadius > 0 && !bv.topLeftRadius && "topLeftRadius" in n) {
        const v = numbers.radius.get(n.cornerRadius);
        if (v) { for (const f of ["topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"]) n.setBoundVariable(f, v); counts.radius += 1; }
      }
      if (n.layoutMode && n.layoutMode !== "NONE") {
        if (n.itemSpacing > 0 && !bv.itemSpacing) {
          const v = numbers.spacing.get(n.itemSpacing);
          if (v) { n.setBoundVariable("itemSpacing", v); counts.spacing += 1; }
        }
        for (const f of ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"]) {
          if (n[f] > 0 && !bv[f]) {
            const v = numbers.spacing.get(n[f]);
            if (v) { n.setBoundVariable(f, v); counts.padding += 1; }
          }
        }
      }
    };
    visit(root);
    const top = Object.keys(unmatched).sort((a, b) => unmatched[b] - unmatched[a]).slice(0, 15);
    return {
      bound: counts,
      failures,
      skippedAmbiguous: Array.from(ambiguous),
      unmatchedColors: top.map((hex) => hex + " ×" + unmatched[hex]),
    };
  },

  async inventory(opts) {
    opts = opts || {};
    const index = await localVariableIndex();
    const collections = index.collections.map((c) => {
      const types = {};
      for (const id of c.variableIds) {
        const v = index.byId.get(id);
        if (v) types[v.resolvedType] = (types[v.resolvedType] || 0) + 1;
      }
      return { name: c.name, modes: c.modes.map((m) => m.name), variables: c.variableIds.length, types };
    });
    const names = (list, cap) => list.length > cap
      ? list.slice(0, cap).map((s) => s.name).concat(["… +" + (list.length - cap)])
      : list.map((s) => s.name);
    const [text, effect, paint] = await Promise.all([
      figma.getLocalTextStylesAsync(), figma.getLocalEffectStylesAsync(), figma.getLocalPaintStylesAsync(),
    ]);
    let pages = [figma.currentPage];
    if (opts.pages !== "current") {
      if (figma.loadAllPagesAsync) await figma.loadAllPagesAsync();
      pages = figma.root.children;
    }
    const sets = [];
    const loose = [];
    for (const page of pages) {
      for (const s of page.findAllWithCriteria({ types: ["COMPONENT_SET"] })) {
        const props = {};
        const groups = s.variantGroupProperties || {};
        for (const k of Object.keys(groups)) props[k] = groups[k].values;
        const extra = Object.keys(s.componentPropertyDefinitions || {})
          .filter((k) => s.componentPropertyDefinitions[k].type !== "VARIANT")
          .map((k) => k.split("#")[0] + ":" + s.componentPropertyDefinitions[k].type);
        sets.push({ id: s.id, name: s.name, page: page.name, variants: s.children.length, props, properties: extra });
      }
      for (const c of page.findAllWithCriteria({ types: ["COMPONENT"] })) {
        if (!c.parent || c.parent.type !== "COMPONENT_SET") loose.push(c);
      }
    }
    const cap = opts.limit || 60;
    return {
      pages: figma.root.children.map((p) => p.name),
      collections,
      styles: { text: names(text, cap), effect: names(effect, cap), paint: names(paint, cap) },
      componentSets: sets.length > cap ? sets.slice(0, cap).concat([{ more: sets.length - cap }]) : sets,
      components: { count: loose.length, names: names(loose, cap) },
    };
  },

  lint(root, opts) {
    opts = opts || {};
    root = root || figma.currentPage;
    const all = ["unbound-color", "unbound-spacing", "unbound-radius", "no-autolayout", "detached", "text-no-style"];
    const rules = new Set(opts.rules || all);
    const limit = opts.limit == null ? 50 : opts.limit;
    const counts = {};
    const issues = [];
    let checked = 0;
    const flag = (rule, n, detail) => {
      counts[rule] = (counts[rule] || 0) + 1;
      if (issues.length < limit) issues.push(detail ? { rule, id: n.id, name: n.name, detail } : { rule, id: n.id, name: n.name });
    };
    const visit = (n) => {
      checked += 1;
      const bv = n.boundVariables || {};
      if (rules.has("unbound-color")) {
        for (const prop of ["fills", "strokes"]) {
          const paints = n[prop];
          if (!Array.isArray(paints) || (prop === "fills" ? n.fillStyleId : n.strokeStyleId)) continue;
          const loose = paints.filter((p) => p.type === "SOLID" && p.visible !== false && !(p.boundVariables && p.boundVariables.color));
          if (loose.length) flag("unbound-color", n, prop + " " + colorHex(Object.assign({}, loose[0].color, { a: 1 })));
        }
      }
      if (rules.has("unbound-spacing") && n.layoutMode && n.layoutMode !== "NONE") {
        const fields = ["itemSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft"].filter((f) => n[f] > 0 && !bv[f]);
        if (fields.length) flag("unbound-spacing", n, fields.join(","));
      }
      if (rules.has("unbound-radius") && typeof n.cornerRadius === "number" && n.cornerRadius > 0 && !bv.topLeftRadius) {
        flag("unbound-radius", n, String(n.cornerRadius));
      }
      if (rules.has("no-autolayout") && n.type === "FRAME" && n.layoutMode === "NONE" && n.children && n.children.length >= 2) {
        flag("no-autolayout", n);
      }
      if (rules.has("detached") && n.detachedInfo) flag("detached", n);
      if (rules.has("text-no-style") && n.type === "TEXT" && typeof n.textStyleId === "string" && !n.textStyleId) {
        flag("text-no-style", n);
      }
      if (n.type !== "INSTANCE" && n.children) for (const c of n.children) visit(c);
    };
    visit(root);
    return { checked, total: issues.length === 0 ? 0 : Object.keys(counts).reduce((a, k) => a + counts[k], 0), counts, issues };
  },
});

function snapshotText(s) {
  return {
    font: s.fontName, size: s.fontSize, lh: s.lineHeight, ls: s.letterSpacing, ps: s.paragraphSpacing,
    tc: s.textCase, td: s.textDecoration, d: s.description, bv: s.boundVariables,
  };
}

Object.assign(HELPERS, DS_HELPERS);

// ──────────────────────────────────────────────────────────────────────────

let CHANGES = 0;

function trackChanges() {
  try {
    figma.on("documentchange", (e) => { CHANGES += e.documentChanges.length || 1; });
    return;
  } catch (e) {}
  try {
    let page = null;
    const onNodes = (e) => { CHANGES += e.nodeChanges.length || 1; };
    const watch = () => {
      if (page) { try { page.off("nodechange", onNodes); } catch (e) {} }
      page = figma.currentPage;
      page.on("nodechange", onNodes);
    };
    watch();
    figma.on("currentpagechange", watch);
  } catch (e) {}
  try { figma.on("stylechange", () => { CHANGES += 1; }); } catch (e) {}
}
trackChanges();

function mutatedSince(before) {
  return CHANGES > before ? true : null;
}

function commitUndo() {
  try { figma.commitUndo(); } catch (e) {}
}

// Ids the bridge gave up waiting for. A running script cannot be killed, so
// cancellation is cooperative: long loops call h.ck() and bail out.
const ABORTED = new Set();

figma.ui.onmessage = async (msg) => {
  if (msg.type === "need-identity") { await postIdentity(); return; }
  if (msg.type === "set-token") {
    const token = typeof msg.token === "string" ? msg.token.trim() : "";
    try {
      if (token) await figma.clientStorage.setAsync(TOKEN_KEY, token);
      else await figma.clientStorage.deleteAsync(TOKEN_KEY);
    } catch (e) {
      figma.notify("Figmosha: could not save the token — " + ((e && e.message) || e));
    }
    await postIdentity();
    return;
  }
  if (msg.type === "open-url") {
    // The Update button. Only ever the project's GitHub pages.
    if (typeof msg.url === "string" && msg.url.startsWith("https://github.com/denysosadchyi/figmosha2/")) {
      figma.openExternal(msg.url);
    }
    return;
  }
  if (msg.type === "abort") {
    if (msg.id) ABORTED.add(msg.id);
    return;
  }
  if (msg.type !== "exec") return;
  const { id, code } = msg;
  // When the bridge gives up on this run. Checked by h.ck() against the
  // sandbox's own clock, because the bridge's `abort` message can't get in
  // while a loop only awaits Figma APIs: those promises settle as microtasks,
  // so the plugin never returns to its message queue until the loop ends.
  const deadline = typeof msg.timeout === "number" ? Date.now() + msg.timeout * 1000 : Infinity;

  const logs = [];
  // print() lines go to the bridge in batches, not one message per line: each
  // message crosses two hops (sandbox -> UI -> WebSocket), and 20k separate
  // lines took ~0.5 s. They are still streamed (flushed every 200 lines or
  // 100 ms), so a script that times out still returns the logs it got to.
  let unsent = [];
  let flushTimer = null;
  const flushLogs = () => {
    if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
    if (unsent.length) {
      figma.ui.postMessage({ type: "log", id, lines: unsent });
      unsent = [];
    }
  };
  const print = (...args) => {
    const text = args.map((a) =>
      typeof a === "object" ? JSON.stringify(a, null, 2) : String(a)
    ).join(" ");
    logs.push(text);
    unsent.push(text);
    if (unsent.length >= 200) flushLogs();
    else if (flushTimer === null) flushTimer = setTimeout(flushLogs, 100);
  };

  // Per-exec helper view: h.ck() throws once the bridge has given up on this
  // run (its timeout passed, or it sent `abort`), so chunked sweeps stop
  // instead of mutating under the next caller.
  const h = Object.create(HELPERS);
  h.aborted = () => ABORTED.has(id) || Date.now() > deadline;
  h.ck = () => {
    if (h.aborted()) throw new Error("aborted: past this exec's timeout — the bridge stopped waiting");
    return true;
  };

  CURRENT_PRINT = print;
  const changesBefore = CHANGES;
  commitUndo();
  try {
    let checkpoint = null;
    if (typeof msg.checkpoint === "string" && msg.checkpoint) {
      checkpoint = await HELPERS.checkpoint(msg.checkpoint);
    }
    const fn = new Function(
      "figma", "print", "h", "args",
      `return (async () => { ${code} })();`
    );
    const result = await fn(figma, print, h, msg.args === undefined ? null : msg.args);

    ABORTED.delete(id);
    flushLogs();
    const reply = resultMessage(id, result, logs);
    reply.mutated = mutatedSince(changesBefore);
    if (checkpoint) reply.checkpoint = checkpoint;
    figma.ui.postMessage(reply);
  } catch (e) {
    ABORTED.delete(id);
    flushLogs();
    figma.ui.postMessage({
      type: "error",
      id,
      text: (e && e.message) || String(e),
      stack: (e && e.stack) || null,
      mutated: mutatedSince(changesBefore),
    });
  } finally {
    CURRENT_PRINT = () => {};
    commitUndo();
  }
};

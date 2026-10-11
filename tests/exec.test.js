const fs = require("fs");
const src = fs.readFileSync(require("path").join(__dirname, "..", "plugin", "code.js"), "utf8");

const events = [];
const posted = [];
let saveFails = false;
const handlers = {};

const figma = {
  showUI() {},
  ui: { onmessage: null, postMessage(m) { posted.push(m); } },
  root: { name: "Test file", children: [{ id: "0:1" }], getPluginData() { return "dtest"; }, setPluginData() {} },
  currentPage: { selection: [], on() {}, off() {} },
  clientStorage: { async getAsync() { return "tok"; }, async setAsync() {}, async deleteAsync() {} },
  variables: {},
  on(name, fn) { handlers[name] = fn; },
  commitUndo() { events.push("commitUndo"); },
  async saveVersionHistoryAsync(title) {
    events.push("save:" + title);
    if (saveFails) throw new Error("no version history");
    return { id: "v42" };
  },
};

new Function("figma", "__html__", src)(figma, "");

let failed = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) failed++;
  console.log(`${a === e ? "  ok  " : " FAIL "} ${label}${a === e ? "" : `\n         got ${a}\n         want ${e}`}`);
}

async function exec(msg) {
  posted.length = 0;
  events.length = 0;
  await figma.ui.onmessage({ type: "exec", id: "r1", timeout: 5, ...msg });
  return posted.find((m) => m.type === "result" || m.type === "error");
}

(async () => {
  let r = await exec({ code: "return args.name + ':' + args.n", args: { name: "Color", n: 2 } });
  check("args reach the script", r.value, "Color:2");
  check("undo is committed before and after", events, ["commitUndo", "commitUndo"]);

  r = await exec({ code: "return args" });
  check("args default to null", r.valueJson, "null");

  r = await exec({ code: "return 1", checkpoint: "tokens" });
  check("checkpoint is saved before the script", events, ["commitUndo", "save:figmosha: tokens", "commitUndo"]);
  check("checkpoint is reported", r.checkpoint, { id: "v42", title: "figmosha: tokens" });

  saveFails = true;
  r = await exec({ code: "globalThis.__ran = true; return 1", checkpoint: "x" });
  saveFails = false;
  check("failed checkpoint fails the exec", r.type, "error");
  check("failed checkpoint runs nothing", globalThis.__ran, undefined);

  r = await exec({ code: "return 1" });
  check("no change seen is reported as unknown, not false", r.mutated, null);

  handlers.documentchange({ documentChanges: [] });
  r = await exec({ code: "throw new Error('half done')" });
  check("errors carry mutated", "mutated" in r, true);

  r = await exec({ code: "return h.brief([{id:'1:1',name:'A',type:'FRAME',x:1}, null])" });
  check("h.brief keeps id/name/type", r.valueJson, JSON.stringify([{ id: "1:1", name: "A", type: "FRAME" }, null]));
  r = await exec({ code: "return h.brief({id:'1:2',name:'B',type:'TEXT'})" });
  check("h.brief of one node", r.valueJson, JSON.stringify({ id: "1:2", name: "B", type: "TEXT" }));

  await figma.ui.onmessage({ type: "need-identity" });
  check("identity carries the stored token", posted.pop().token, "tok");

  console.log(failed ? `\n${failed} FAILED` : "\nall exec checks passed");
  process.exit(failed ? 1 : 0);
})();

#!/usr/bin/env python3
"""figmosha — CLI client for the Figmosha 2.0 bridge.

Commands:
    figmosha exec "<js>"             # run arbitrary JS in plugin context
    figmosha exec --file f.js
    figmosha exec --stdin
    figmosha exec --file f.js --args '{"n": 1}'   # or --args @spec.json; read as `args`
    figmosha run --list               # ready-made scripts in scripts/
    figmosha run <name> --args @spec.json [--schema]
    figmosha status                   # check server / plugin connection
    figmosha token [--show]           # copy the bridge token (paste it into the plugin)
    figmosha new [--no-open] [--wait N] # open a new Figma file, wait for the plugin, print its doc id
    figmosha figma-token              # store a Figma personal access token (read from stdin)
    figmosha link -T <file> <fileKey|figma URL>   # remember a file's key for REST calls
    figmosha rest versions|comments|images [--ids 1:2,3:4] -T <file>
    figmosha skills install [--project DIR] [--for claude|codex|all] [--copy]
    figmosha doctor                   # diagnose the whole chain, with fixes
    figmosha sel                      # what is selected in Figma right now
    figmosha tree <id> [--depth N] [--layout] [--size] [--full]
    figmosha find <id> <filter>       # find descendants (name=X, name~X, type=X, text=X)
    figmosha text <id> "<new text>"   # set TEXT node characters (autoloads font)
    figmosha variant <id> "P=V" ...   # set INSTANCE variant property values
    figmosha clone <id> [--right|--left|--up|--down] [--gap N] [--name N]
    figmosha rm <id> [<id> ...]       # remove one or more nodes
    figmosha import-component <key>   # import library component, instantiate, focus
    figmosha "<js>"                   # shorthand for `exec`

Anywhere a node id is taken, `page` (current page) and `sel` (first selected
node) work too. Bridge address comes from FIGMOSHA_HOST / FIGMOSHA_PORT.
Results longer than 8 KB are cut (the reply says so); --full lifts the limit,
--checkpoint "<label>" saves a version in Figma's history before running.

Helpers available inside exec'd code (as `h.*`):
    h.bF(node, idx, varOrId)    h.bS(node, idx, varOrId)   h.bN(node, prop, varOrId)
    h.findByName(root, name)    h.findAllByName(root, name)
    h.dumpTree(node, {maxDepth, showSize, showText, showLayout})
    h.withFonts(root, asyncFn)  h.setText(node, text)
    h.cloneNext(node, {direction, gap, name})
    h.variant(instance, props)  h.variantsOf(instance)
    h.sel()                     h.resolve(idOrAlias)
    h.hex("#1a2b3c")            h.solid("#1a2b3c", opacity?)
    h.frame(parent, {layout, w, h, spacing, padding, align, fill, radius, name})
    h.node(id)                  h.var_(idOrKey)
    h.importComp(key)           h.importVar(key)
    h.brief(nodes)              h.checkpoint(label)
"""

import argparse
import getpass
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import time
import webbrowser
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


# 127.0.0.1, not "localhost": on Windows "localhost" tries ::1 first, and against a
# bridge that only listens on IPv4 every call stalls ~2 s before falling back.
DEFAULT_HOST = os.environ.get("FIGMOSHA_HOST", "127.0.0.1")
DEFAULT_PORT = int(os.environ.get("FIGMOSHA_PORT", "8787"))

HOST = DEFAULT_HOST
PORT = DEFAULT_PORT
TARGET = None  # which connected Figma file to route to (file name / fileKey / substring)
PARALLEL = False  # skip the bridge's per-file lock — READ-ONLY scripts only
AGENT = os.environ.get("FIGMOSHA_AGENT") or None  # who is calling, shown in the file's queue
QUEUE_TIMEOUT = None  # max seconds to wait for a busy file; bridge default = --timeout
MAX_RESULT = 8000
CHECKPOINT = None
SCRIPTS_DIR = Path(__file__).resolve().parent / "scripts"
SCRIPT_NAME = re.compile(r"^[a-z0-9][a-z0-9-]*$")
_NO_ARGS = object()

KNOWN_CMDS = {
    "exec", "status", "token", "skills", "new", "figma-token", "link", "rest", "targets", "clear", "doctor", "sel", "tree", "find", "text", "variant",
    "clone", "rm", "import-component", "icomp", "run",
}


def force_utf8_output():
    """Windows consoles default to cp1252 and raise on anything outside it.

    Layer names are routinely Cyrillic, CJK or emoji, so without this a plain
    `figmosha tree` blows up with UnicodeEncodeError instead of printing.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


def figmosha_home():
    return Path(os.environ.get("FIGMOSHA_HOME") or Path.home() / ".figmosha")


def token_path():
    return figmosha_home() / "token"


def read_token():
    env = os.environ.get("FIGMOSHA_TOKEN", "").strip()
    if env:
        return env
    try:
        return token_path().read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


def node_expr(id_or_alias):
    """JS that resolves a node id, or the aliases `page` / `sel`."""
    return f"await h.resolve({json.dumps(id_or_alias)})"


def _request(method, path, payload=None, timeout=65):
    url = f"http://{HOST}:{PORT}{path}"
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Content-Type": "application/json"} if data else {}
    token = read_token()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        body = e.read() or b"{}"
        try:
            return e.code, json.loads(body)
        except json.JSONDecodeError:
            return e.code, {"ok": False, "error": body.decode("utf-8", "replace")}
    except urllib.error.URLError as e:
        return 0, {"ok": False, "error": f"connection: {e.reason}"}
    except TimeoutError:
        return 0, {"ok": False, "error": "request timed out"}


def _exec(code, timeout=60, args=_NO_ARGS, checkpoint=None):
    payload = {"code": code, "timeout": timeout}
    if args is not _NO_ARGS:
        payload["args"] = args
    if checkpoint or CHECKPOINT:
        payload["checkpoint"] = checkpoint or CHECKPOINT
    if MAX_RESULT:
        payload["max_result"] = MAX_RESULT
    if TARGET:
        payload["target"] = TARGET
    if PARALLEL:
        payload["parallel"] = True
    if AGENT:
        payload["agent"] = AGENT
    queue = timeout if QUEUE_TIMEOUT is None else QUEUE_TIMEOUT
    payload["queue_timeout"] = queue
    # The socket deadline has to outlast the bridge's own: time in the file's
    # queue plus the run itself. Hanging up earlier loses the bridge's error
    # payload, and used to leave a queued script to run with nobody waiting.
    status, resp = _request("POST", "/exec", payload, timeout=queue + timeout + 5)
    if resp.get("queued_ms", 0) >= 1000:
        print(f"  (waited {resp['queued_ms'] / 1000:.1f}s in the file's queue)", file=sys.stderr)
    return status, resp


def _emit(resp, raw=False):
    if raw:
        print(json.dumps(resp, indent=2, ensure_ascii=False))
        return 0 if resp.get("ok") else 1

    for line in resp.get("logs") or []:
        print(f"  log: {line}", file=sys.stderr)
    if resp.get("notice"):
        print(f"   ⚠ {resp['notice']}", file=sys.stderr)

    if resp.get("ok") is False:
        print(f"figmosha: {resp.get('error', 'unknown')}", file=sys.stderr)
        if resp.get("warning"):
            print(f"   ⚠ {resp['warning']}", file=sys.stderr)
        if resp.get("hint"):
            print(f"   hint: {resp['hint']}", file=sys.stderr)
        if resp.get("mutated") is True:
            print("   ⚠ the script changed the document before it failed — those changes stay; "
                  "re-read before retrying, or undo in Figma (one Cmd+Z per exec)", file=sys.stderr)
        elif resp.get("mutated") is None and "mutated" in resp:
            print("   ⚠ it is unknown whether the script changed the document before it failed",
                  file=sys.stderr)
        return 1

    if resp.get("result"):
        print(resp["result"])
    truncated = resp.get("truncated")
    if truncated:
        print(f"   ⚠ cut: showing {truncated.get('shown')} of {truncated.get('total')} "
              f"{truncated.get('unit')} — return less, or pass --full", file=sys.stderr)
    return 0


# ─── command builders ─────────────────────────────────────────────────────

def cmd_status(args):
    status, resp = _request("GET", "/status")
    print(json.dumps(resp, indent=2, ensure_ascii=False))
    return 0 if status == 200 else 2


def _copy_to_clipboard(text):
    for cmd in (["pbcopy"], ["clip"], ["wl-copy"], ["xclip", "-selection", "clipboard"],
                ["xsel", "--clipboard", "--input"]):
        if shutil.which(cmd[0]):
            try:
                subprocess.run(cmd, input=text.encode("utf-8"), check=True, timeout=5)
                return True
            except (OSError, subprocess.SubprocessError):
                continue
    return False


def cmd_token(args):
    token = read_token()
    if not token:
        print(f"figmosha: no token yet — start the bridge once (bash start-bridge.sh), "
              f"it creates {token_path()}", file=sys.stderr)
        return 1
    if args.show:
        print(token)
        return 0
    if _copy_to_clipboard(token):
        print("bridge token copied to the clipboard — paste it into the Figmosha Bridge "
              "plugin bar in Figma and press Enter")
        return 0
    print("figmosha: no clipboard tool found; run `figmosha token --show` and copy it by hand",
          file=sys.stderr)
    return 1


def _token_problems():
    if os.environ.get("FIGMOSHA_TOKEN", "").strip():
        return []
    path = token_path()
    if not path.exists():
        return [(f"no bridge token at {path}",
                 "start the bridge once (bash start-bridge.sh) — it creates one")]
    if os.name != "posix":
        return []
    problems = []
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode & 0o077:
        problems.append((f"{path} is readable by other users (mode {mode:o})",
                         f"chmod 600 {path}"))
    return problems


NEW_FILE_URL = "https://figma.new"


def _doc_ids():
    status, resp = _request("GET", "/targets")
    if status != 200:
        raise UsageError(resp.get("error") or f"bridge answered {status}")
    return {f.get("doc"): f.get("name") for f in resp.get("files") or [] if f.get("doc")}


def cmd_new(args):
    try:
        before = _doc_ids()
    except UsageError as e:
        print(f"figmosha: {e}", file=sys.stderr)
        return 2
    if not args.no_open:
        webbrowser.open(NEW_FILE_URL)
        print(f"opened {NEW_FILE_URL} — in the new file run Plugins → Development → Figmosha Bridge",
              file=sys.stderr)
    else:
        print("create a file in Figma, then run Plugins → Development → Figmosha Bridge in it",
              file=sys.stderr)
    deadline = time.monotonic() + args.wait
    while time.monotonic() < deadline:
        time.sleep(args.poll)
        try:
            fresh = {d: n for d, n in _doc_ids().items() if d not in before}
        except UsageError:
            continue
        if fresh:
            doc, name = next(iter(fresh.items()))
            print(json.dumps({"doc": doc, "name": name}, ensure_ascii=False))
            return 0
    print(f"figmosha: no new file connected within {args.wait:g}s", file=sys.stderr)
    return 1


REST_API = "https://api.figma.com/v1"
FILE_KEY = re.compile(r"figma\.com/(?:file|design|board|proto|slides)/([A-Za-z0-9]{10,})")


def _write_private(path, text):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    if tmp.exists() or tmp.is_symlink():
        tmp.unlink()
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def figma_token():
    env = os.environ.get("FIGMA_TOKEN", "").strip()
    if env:
        return env
    try:
        return (figmosha_home() / "figma_token").read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


def cmd_figma_token(args):
    if sys.stdin.isatty():
        token = getpass.getpass("Figma personal access token (input hidden): ").strip()
    else:
        token = sys.stdin.read().strip()
    if not token:
        print("figmosha: empty token, nothing saved", file=sys.stderr)
        return 2
    _write_private(figmosha_home() / "figma_token", token + "\n")
    print(f"saved to {figmosha_home() / 'figma_token'} (mode 600)")
    return 0


def links_path():
    return figmosha_home() / "links.json"


def read_links():
    try:
        data = json.loads(links_path().read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def parse_file_key(text):
    m = FILE_KEY.search(text)
    if m:
        return m.group(1)
    if re.fullmatch(r"[A-Za-z0-9]{10,}", text):
        return text
    raise UsageError(f"not a Figma file key or URL: {text!r}")


def _target_doc():
    if not TARGET:
        raise UsageError("pass -T <file name or doc id>")
    status, resp = _request("GET", "/targets")
    files = resp.get("files") or [] if status == 200 else []
    t = TARGET.lower()
    hits = [f for f in files if f.get("doc") and (f["doc"].lower().startswith(t) or (f.get("name") or "").lower() == t)]
    docs = {f["doc"] for f in hits}
    if len(docs) == 1:
        return hits[0]["doc"], hits[0].get("name")
    if len(docs) > 1:
        raise UsageError(f"-T {TARGET!r} matches several files — use the doc id")
    if TARGET in read_links():
        return TARGET, None
    raise UsageError(f"no connected file matches {TARGET!r} (the plugin must run in it once to link it)")


def cmd_link(args):
    try:
        key = parse_file_key(args.key)
        doc, name = _target_doc()
    except UsageError as e:
        print(f"figmosha: {e}", file=sys.stderr)
        return 2
    links = read_links()
    links[doc] = {"key": key, "name": name}
    _write_private(links_path(), json.dumps(links, indent=2, ensure_ascii=False) + "\n")
    print(f"linked {name or doc} ({doc}) → {key}")
    return 0


def _rest_get(path, token):
    req = urllib.request.Request(REST_API + path, headers={"X-Figma-Token": token,
                                                           "User-Agent": "figmosha"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:300]
        raise UsageError(f"Figma REST {e.code}: {body}")
    except urllib.error.URLError as e:
        raise UsageError(f"Figma REST: {e.reason}")


def cmd_rest(args):
    token = figma_token()
    if not token:
        print("figmosha: no Figma token — ask the user to run `figmosha figma-token` "
              "(Figma → Settings → Security → Personal access tokens)", file=sys.stderr)
        return 2
    try:
        if args.key:
            key = parse_file_key(args.key)
        else:
            doc, _ = _target_doc()
            link = read_links().get(doc)
            if not link:
                raise UsageError(f"file {doc} has no key yet — `figmosha link -T {doc} <figma URL>`")
            key = link["key"]
        limit = args.limit
        if args.what == "versions":
            data = _rest_get(f"/files/{key}/versions", token).get("versions") or []
            out = [{"id": v.get("id"), "at": v.get("created_at"), "label": v.get("label"),
                    "by": (v.get("user") or {}).get("handle")} for v in data[:limit]]
        elif args.what == "comments":
            data = _rest_get(f"/files/{key}/comments", token).get("comments") or []
            out = [{"id": c.get("id"), "by": (c.get("user") or {}).get("handle"),
                    "at": c.get("created_at"), "resolved": bool(c.get("resolved_at")),
                    "node": (c.get("client_meta") or {}).get("node_id"),
                    "parent": c.get("parent_id") or None, "text": c.get("message")}
                   for c in data if args.all or not c.get("resolved_at")][:limit]
        else:
            if not args.ids:
                raise UsageError("images needs --ids 1:2,3:4")
            query = urllib.parse.urlencode({"ids": args.ids, "format": args.format, "scale": args.scale})
            out = _rest_get(f"/images/{key}?{query}", token).get("images") or {}
    except UsageError as e:
        print(f"figmosha: {e}", file=sys.stderr)
        return 2
    print(json.dumps(out, indent=1, ensure_ascii=False))
    return 0


SKILLS_DIR = Path(__file__).resolve().parent / "skills"


def skill_targets(project, who):
    base = Path(project).resolve() if project else Path.home()
    out = []
    if who in ("claude", "all"):
        out.append(base / ".claude" / "skills")
    if who in ("codex", "all"):
        out.append(base / ".agents" / "skills")
    return out


def cmd_skills(args):
    skills = sorted(d for d in SKILLS_DIR.iterdir() if (d / "SKILL.md").is_file()) if SKILLS_DIR.is_dir() else []
    if args.action == "list" or not skills:
        for d in skills:
            print(d.name)
        return 0 if skills else 1
    status = 0
    for target in skill_targets(args.project, args.for_):
        target.mkdir(parents=True, exist_ok=True)
        for src in skills:
            dest = target / src.name
            if (dest.exists() or dest.is_symlink()) and dest.resolve() == src.resolve():
                print(f"  =  {dest}")
                continue
            if dest.resolve().is_relative_to(SKILLS_DIR.resolve()):
                print(f"  !  {dest} points into this checkout — left alone", file=sys.stderr)
                status = 1
                continue
            if dest.exists() or dest.is_symlink():
                if not args.force:
                    print(f"  !  {dest} exists — left alone (--force replaces it)", file=sys.stderr)
                    status = 1
                    continue
                if dest.is_symlink() or dest.is_file():
                    dest.unlink()
                else:
                    shutil.rmtree(dest)
            if not args.copy:
                try:
                    dest.symlink_to(src, target_is_directory=True)
                    print(f"  →  {dest}")
                    continue
                except OSError:
                    pass
            shutil.copytree(src, dest)
            print(f"  +  {dest} (copy — rerun after updating Figmosha)")
    return status


def cmd_targets(args):
    status, resp = _request("GET", "/targets")
    files = resp.get("files") or []
    if not files:
        print("no files connected — Run the Figmosha Bridge plugin in each Figma file",
              file=sys.stderr)
        return 1
    for f in files:
        name = f.get("name") or "(unidentified)"
        key = f.get("fileKey") or "-"
        q = f.get("queue") or {}
        run = q.get("running")
        busy = f"busy: {run.get('agent') or '?'} {run.get('for_s')}s" if run else "idle"
        if q.get("waiting"):
            busy += f", waiting: {', '.join(q['waiting'])}"
        same = f"\tsame document as {f['sameDocAs']}" if f.get("sameDocAs") else ""
        # doc is stable (stored in the file) — that's the id to use with -T.
        print(f"{name}\t{f.get('doc') or '-'}\t{key}\t{f.get('conn')}\t{busy}{same}")
    return 0


def cmd_clear(args):
    """Drop a file's abandoned-script interlock after a 504."""
    payload = {"target": TARGET} if TARGET else {}
    status, resp = _request("POST", "/clear", payload)
    if status != 200:
        print(resp.get("error", "clear failed"), file=sys.stderr)
        return 2
    cleared = resp.get("cleared") or []
    print(f"cleared {len(cleared)} abandoned script(s) on {resp.get('file')!r}"
          + (f": {', '.join(cleared)}" if cleared else ""))
    return 0


def cmd_sel(args):
    return _emit(_exec("return h.sel();", args.timeout)[1], raw=args.raw)


def cmd_doctor(args):
    """Walk the chain bridge -> plugin -> Figma, naming the fix at each break."""
    def ok(text):
        print(f"  ✓  {text}")

    def fail(text, fix):
        print(f"  ✗  {text}")
        print(f"     → {fix}")

    status, resp = _request("GET", "/status")
    if status == 0:
        fail(f"bridge not answering on {HOST}:{PORT} — {resp.get('error')}",
             "start it:  bash start-bridge.sh   (Windows: .\\start-bridge.ps1)")
        return 1
    if status == 403:
        fail(f"bridge refused the request: {resp.get('error')}",
             "a proxy is rewriting Host/Origin — talk to the bridge directly")
        return 1
    if status == 401:
        fail(f"bridge refused the token: {resp.get('error')}",
             "the CLI reads ~/.figmosha/token or $FIGMOSHA_TOKEN — make sure it matches the "
             "bridge's, then restart the bridge")
        return 1
    ok(f"bridge answering on {HOST}:{PORT}"
       + (f" — Figmosha {resp['version']}" if resp.get("version") else ""))
    stale = False
    auth = resp.get("auth") or {}
    for problem, fix in _token_problems():
        fail(problem, fix)
    if not auth.get("token"):
        fail("the bridge runs without a token — anything on this machine can run code in Figma",
             "restart it without --insecure-no-token")
    elif auth.get("caller") == "missing":
        fail("this CLI sent no token", f"check {token_path()} or $FIGMOSHA_TOKEN")
    else:
        ok("bridge token " + ("required" if auth.get("required") else
                              "in use (not yet required)"))
    if resp.get("bridge_outdated"):
        stale = True
        fail("bridge.py changed since the bridge started — it runs old code",
             "restart it:  bash start-bridge.sh   (Windows: .\\start-bridge.ps1 -Restart)")

    if not resp.get("plugin_connected"):
        fail("plugin not connected",
             "in Figma Desktop: Plugins → Development → Figmosha Bridge")
        return 1
    ok("plugin connected")

    current = resp.get("plugin_version")
    for f in resp.get("files") or []:
        if auth.get("token") and f.get("authed") is False:
            fail(f"«{f.get('name')}» is connected without the bridge token",
                 "run `figmosha token`, paste it into the plugin bar in that file, press Enter")
        if f.get("outdated"):
            stale = True
            fail(f"«{f.get('name')}» runs an older plugin build "
                 f"({f.get('plugin') or 'unversioned'}, current {current})",
                 "re-run it in that file: Plugins → Development → Figmosha Bridge")
    if current and not stale:
        ok(f"plugin build {current} everywhere")
    update = resp.get("update")
    if update:
        # Not a failure — everything works, there is just something newer.
        print(f"  !  Figmosha {update.get('latest')} is released (this is {update.get('current')})")
        print(f"     → git pull, restart the bridge, re-run the plugin   ({update.get('url')})")

    status, r = _exec("return 1 + 1;", 10)
    if status == 409 and r.get("abandoned"):
        fail(f"file is interlocked: {r.get('error')}",
             "wait for that script to finish, or:  figmosha clear -T <file>")
        return 1
    if status == 409:
        # Several files connected and no -T, or an ambiguous one — the plugin is
        # fine, the request just doesn't say which file it means.
        fail(r.get("error", "target required"),
             "pick one with -T: a file name, or the doc id from `figmosha targets` "
             "when two files share a name")
        return 1
    if not r.get("ok") or r.get("value") != 2:
        fail(f"round trip failed: {r.get('error', r)}",
             "close the plugin window in Figma and run it again")
        return 1
    ok(f"round trip works ({r.get('elapsed_ms', '?')}ms)")

    status, r = _exec(
        "return {file: figma.root.name, page: figma.currentPage.name, "
        "pages: figma.root.children.length};", 10)
    if r.get("ok"):
        v = r.get("value") or {}
        ok(f"editing «{v.get('file')}» — page «{v.get('page')}» "
           f"of {v.get('pages')}")
        print("\n  The plugin is bound to whichever file was open when you ran it.")
        print("  Switched files? Run the plugin again in the new one.")
    return 1 if stale else 0


class UsageError(Exception):
    pass


def parse_args_value(text):
    if text is None:
        return _NO_ARGS
    if text.startswith("@"):
        path = text[1:]
        try:
            with (sys.stdin if path == "-" else open(path, encoding="utf-8")) as f:
                text = f.read()
        except OSError as e:
            raise UsageError(f"--args: cannot read {path}: {e.strerror}")
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        raise UsageError(f"--args is not valid JSON: {e}")


_TYPES = {
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
    "string": lambda v: isinstance(v, str),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
    "null": lambda v: v is None,
}


def validate(value, schema, path="args"):
    errors = []
    if not isinstance(schema, dict):
        return errors
    types = schema.get("type")
    if types is not None:
        names = types if isinstance(types, list) else [types]
        if not any(_TYPES.get(t, lambda v: True)(value) for t in names):
            return [f"{path}: expected {' or '.join(names)}, got {type(value).__name__}"]
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path}: must be one of {json.dumps(schema['enum'], ensure_ascii=False)}")
    if isinstance(value, dict):
        for key in schema.get("required", []):
            if key not in value:
                errors.append(f"{path}.{key}: required")
        props = schema.get("properties", {})
        for key, item in value.items():
            if key in props:
                errors += validate(item, props[key], f"{path}.{key}")
            elif isinstance(schema.get("additionalProperties"), dict):
                errors += validate(item, schema["additionalProperties"], f"{path}.{key}")
            elif schema.get("additionalProperties") is False:
                errors.append(f"{path}.{key}: unknown key (allowed: {', '.join(props) or 'none'})")
    if isinstance(value, list):
        if len(value) < schema.get("minItems", 0):
            errors.append(f"{path}: needs at least {schema['minItems']} item(s)")
        if "items" in schema:
            for i, item in enumerate(value):
                errors += validate(item, schema["items"], f"{path}[{i}]")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            errors.append(f"{path}: must be >= {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            errors.append(f"{path}: must be <= {schema['maximum']}")
    if isinstance(value, str) and "pattern" in schema and not re.search(schema["pattern"], value):
        errors.append(f"{path}: must match {schema['pattern']}")
    return errors


def script_dirs():
    extra = [Path(p) for p in os.environ.get("FIGMOSHA_SCRIPTS", "").split(os.pathsep) if p]
    return extra + [SCRIPTS_DIR]


def find_script(name):
    if not SCRIPT_NAME.match(name):
        raise UsageError(f"bad script name {name!r}: lowercase letters, digits and dashes")
    for d in script_dirs():
        js = d / f"{name}.js"
        if js.is_file():
            meta_path = d / f"{name}.json"
            meta = {}
            if meta_path.is_file():
                try:
                    meta = json.loads(meta_path.read_text(encoding="utf-8"))
                except json.JSONDecodeError as e:
                    raise UsageError(f"{meta_path}: {e}")
            return js, meta
    raise UsageError(f"no script {name!r} — `figmosha run --list` shows what there is")


def list_scripts():
    seen = {}
    for d in script_dirs():
        for js in sorted(d.glob("*.js")) if d.is_dir() else []:
            if js.stem in seen or not SCRIPT_NAME.match(js.stem):
                continue
            meta_path = js.with_suffix(".json")
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.is_file() else {}
            except json.JSONDecodeError:
                meta = {}
            seen[js.stem] = meta.get("description", "")
    return seen


def cmd_run(args):
    try:
        if args.list or not args.name:
            scripts = list_scripts()
            if not scripts:
                print("no scripts found", file=sys.stderr)
                return 1
            width = max(len(n) for n in scripts)
            for name, desc in scripts.items():
                print(f"{name.ljust(width)}  {desc}")
            return 0
        path, meta = find_script(args.name)
        if args.schema:
            print(json.dumps({k: meta[k] for k in ("description", "args", "example") if k in meta},
                             indent=2, ensure_ascii=False))
            return 0
        value = parse_args_value(args.args)
        if value is _NO_ARGS:
            value = meta.get("example") if args.example else {}
        schema = meta.get("args")
        if schema:
            errors = validate(value, schema)
            if errors:
                print(f"figmosha: args do not match {args.name}'s schema:", file=sys.stderr)
                for e in errors[:20]:
                    print(f"   {e}", file=sys.stderr)
                print(f"   see: figmosha run {args.name} --schema", file=sys.stderr)
                return 2
    except UsageError as e:
        print(f"figmosha: {e}", file=sys.stderr)
        return 2
    code = path.read_text(encoding="utf-8")
    checkpoint = None
    if meta.get("checkpoint") and not args.no_checkpoint:
        checkpoint = f"before {args.name}"
    timeout = args.timeout if args.timeout_set else meta.get("timeout", args.timeout)
    return _emit(_exec(code, timeout, args=value, checkpoint=checkpoint)[1], raw=args.raw)


def cmd_exec(args):
    if args.file:
        with open(args.file, encoding="utf-8") as f:
            code = f.read()
    elif args.stdin:
        code = sys.stdin.read()
    elif args.code:
        code = args.code
    else:
        print("figmosha: provide code (positional, --file, or --stdin)", file=sys.stderr)
        return 2
    try:
        value = parse_args_value(args.args)
    except UsageError as e:
        print(f"figmosha: {e}", file=sys.stderr)
        return 2
    return _emit(_exec(code, args.timeout, args=value)[1], raw=args.raw)


def cmd_tree(args):
    depth = args.depth if args.depth is not None else (99 if args.full else 2)
    opts = json.dumps({
        "maxDepth": depth,
        "showSize": (args.size or args.full) and not args.no_size,
        "showText": not args.no_text,
        "showLayout": args.layout,
    })
    code = (
        f"const n = {node_expr(args.node_id)};"
        f"if (!n) throw new Error('node not found: ' + {json.dumps(args.node_id)});"
        f"return h.dumpTree(n, {opts});"
    )
    return _emit(_exec(code, args.timeout)[1], raw=args.raw)


def cmd_find(args):
    if "=" not in args.filter and "~" not in args.filter:
        print("figmosha: filter must be key=value or key~value", file=sys.stderr)
        print("  forms: name=X (exact), name~X (substring), type=X, text=X (substring)", file=sys.stderr)
        return 2

    # Whichever separator comes first decides the mode, so a value may contain
    # the other character (name~a=b is a substring search for "a=b").
    tilde = args.filter.find("~")
    equals = args.filter.find("=")
    substring_mode = tilde != -1 and (equals == -1 or tilde < equals)

    if substring_mode:
        key, value = args.filter.split("~", 1)
        if key == "name":
            predicate = f"n.name.includes({json.dumps(value)})"
        elif key == "text":
            predicate = f"n.type === 'TEXT' && n.characters.includes({json.dumps(value)})"
        else:
            print(f"figmosha: substring filter only supports name~ and text~ (got {key}~)", file=sys.stderr)
            return 2
    else:
        key, value = args.filter.split("=", 1)
        if key == "name":
            predicate = f"n.name === {json.dumps(value)}"
        elif key == "type":
            predicate = f"n.type === {json.dumps(value.upper())}"
        elif key == "text":
            predicate = f"n.type === 'TEXT' && n.characters === {json.dumps(value)}"
        else:
            print(f"figmosha: unknown filter key '{key}'. Use name, type, text", file=sys.stderr)
            return 2

    code = (
        f"const root = {node_expr(args.node_id)};"
        f"if (!root) throw new Error('node not found: ' + {json.dumps(args.node_id)});"
        f"if (!root.findAll) throw new Error('node has no findAll (type: ' + root.type + ')');"
        + (f"return root.findAll(n => {predicate}).map(n => ({{"
           f"id: n.id, name: n.name, type: n.type, w: n.width, h: n.height,"
           f"chars: n.type === 'TEXT' ? n.characters : undefined"
           f"}}));"
           if args.full or key == "text" else
           f"return h.brief(root.findAll(n => {predicate}));")
    )
    return _emit(_exec(code, args.timeout)[1], raw=args.raw)


def cmd_text(args):
    code = (
        f"const n = {node_expr(args.node_id)};"
        f"if (!n) throw new Error('node not found');"
        f"if (n.type !== 'TEXT') throw new Error('not a TEXT node (got ' + n.type + ')');"
        f"const before = n.characters;"
        f"await h.setText(n, {json.dumps(args.text)});"
        f"return {{id: n.id, before, after: n.characters}};"
    )
    return _emit(_exec(code, args.timeout)[1], raw=args.raw)


def cmd_variant(args):
    props = {}
    for kv in args.props:
        if "=" not in kv:
            print(f"figmosha: variant prop must be 'Property=Value', got {kv!r}", file=sys.stderr)
            return 2
        k, v = kv.split("=", 1)
        props[k.strip()] = v.strip()

    code = (
        f"const n = {node_expr(args.node_id)};"
        f"if (!n) throw new Error('node not found');"
        f"if (n.type !== 'INSTANCE') throw new Error('not an INSTANCE (got ' + n.type + ')');"
        f"await n.setProperties({json.dumps(props)});"
        f"const out = {{}};"
        f"for (const k in n.componentProperties) out[k] = n.componentProperties[k].value;"
        f"return {{id: n.id, applied: {json.dumps(props)}, current: out}};"
    )
    return _emit(_exec(code, args.timeout)[1], raw=args.raw)


def cmd_clone(args):
    direction = "right"
    for d in ("left", "right", "up", "down"):
        if getattr(args, d, False):
            direction = d
    opts = {"direction": direction, "gap": args.gap}
    if args.name:
        opts["name"] = args.name

    code = (
        f"const n = {node_expr(args.node_id)};"
        f"if (!n) throw new Error('node not found');"
        f"const c = h.cloneNext(n, {json.dumps(opts)});"
        f"figma.viewport.scrollAndZoomIntoView([n, c]);"
        f"return {{clone_id: c.id, x: c.x, y: c.y, name: c.name}};"
    )
    return _emit(_exec(code, args.timeout)[1], raw=args.raw)


def cmd_rm(args):
    # Cleaning up after an experiment is almost always plural.
    code = (
        f"const ids = {json.dumps(args.node_ids)};"
        f"const removed = [], missing = [];"
        f"for (const id of ids) {{"
        f"  const n = await h.resolve(id);"
        f"  if (!n) {{ missing.push(id); continue; }}"
        f"  removed.push({{id: n.id, name: n.name, type: n.type}});"
        f"  n.remove();"
        f"}}"
        f"if (missing.length) throw new Error('node not found: ' + missing.join(', ') + "
        f"  (removed.length ? ' (removed ' + removed.length + ' before that)' : ''));"
        f"return removed;"
    )
    return _emit(_exec(code, args.timeout)[1], raw=args.raw)


def cmd_import_component(args):
    code = (
        f"const comp = await figma.importComponentByKeyAsync({json.dumps(args.key)});"
        f"const inst = comp.createInstance();"
        f"figma.currentPage.appendChild(inst);"
        f"figma.viewport.scrollAndZoomIntoView([inst]);"
        f"return {{component: comp.name, instance_id: inst.id, w: inst.width, h: inst.height}};"
    )
    return _emit(_exec(code, args.timeout)[1], raw=args.raw)


# ─── argparse / dispatch ───────────────────────────────────────────────────

class _Timeout(argparse.Action):
    def __call__(self, parser, namespace, values, option_string=None):
        setattr(namespace, self.dest, values)
        namespace.timeout_set = True


def _add_common_flags(p):
    p.add_argument("--timeout", "-t", type=int, default=60, action=_Timeout)
    p.set_defaults(timeout_set=False)
    p.add_argument("--raw", action="store_true", help="print full JSON response")
    p.add_argument("--full", action="store_true",
                   help="no 8 KB cut on the result; tree/find print everything")
    p.add_argument("--checkpoint", default=None, metavar="LABEL",
                   help="save a version in Figma's history before running")
    p.add_argument("--target", "-T", default=None,
                   help="which connected file to route to (name, fileKey, or substring)")
    p.add_argument("--parallel", action="store_true",
                   help="bypass the per-file lock so reads can fan out. "
                        "READ-ONLY scripts only — a parallel writer interleaves.")
    p.add_argument("--agent", "-A", default=None,
                   help="name shown in the file's queue (env FIGMOSHA_AGENT)")
    p.add_argument("--queue-timeout", type=float, default=None,
                   help="seconds to wait while another caller holds the file "
                        "(default: same as --timeout); gives up with 'file busy' "
                        "without running anything")


def build_parser():
    ap = argparse.ArgumentParser(prog="figmosha", description=__doc__.splitlines()[0],
                                  formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default=DEFAULT_HOST,
                    help="bridge host (env FIGMOSHA_HOST)")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT,
                    help="bridge port (env FIGMOSHA_PORT)")

    sub = ap.add_subparsers(dest="cmd")

    sub.add_parser("status")
    p_new = sub.add_parser("new", help="open a new Figma file and wait until the plugin runs in it")
    p_new.add_argument("--no-open", action="store_true", help="don't open figma.new, just wait")
    p_new.add_argument("--wait", type=float, default=180, help="seconds to wait (default 180)")
    p_new.add_argument("--poll", type=float, default=1.0, help=argparse.SUPPRESS)
    sub.add_parser("figma-token", help="store a Figma personal access token for REST calls")
    p_link = sub.add_parser("link", help="remember the Figma file key of a connected file")
    _add_common_flags(p_link)
    p_link.add_argument("key", help="file key or a figma.com URL of the file")
    p_rest = sub.add_parser("rest", help="read-only Figma REST calls for a linked file")
    _add_common_flags(p_rest)
    p_rest.add_argument("what", choices=["versions", "comments", "images"])
    p_rest.add_argument("--key", default=None, help="file key or URL instead of -T")
    p_rest.add_argument("--ids", default=None, help="node ids for images, comma-separated")
    p_rest.add_argument("--format", default="png", choices=["png", "jpg", "svg", "pdf"])
    p_rest.add_argument("--scale", type=float, default=1)
    p_rest.add_argument("--limit", type=int, default=30)
    p_rest.add_argument("--all", action="store_true", help="comments: include resolved ones")
    p_skills = sub.add_parser("skills", help="install the agent skills from skills/")
    p_skills.add_argument("action", choices=["install", "list"])
    p_skills.add_argument("--project", default=None,
                          help="install into DIR/.claude/skills and DIR/.agents/skills (default: your home)")
    p_skills.add_argument("--for", dest="for_", choices=["claude", "codex", "all"], default="all")
    p_skills.add_argument("--copy", action="store_true", help="copy instead of symlinking")
    p_skills.add_argument("--force", action="store_true", help="replace existing entries")
    p_token = sub.add_parser("token", help="copy the bridge token to paste into the plugin")
    p_token.add_argument("--show", action="store_true", help="print it instead of copying")
    sub.add_parser("targets", help="list connected Figma files (name / fileKey / conn)")

    p_clear = sub.add_parser("clear",
                             help="drop a file's abandoned-script interlock after a 504")
    _add_common_flags(p_clear)

    p_doctor = sub.add_parser("doctor", help="diagnose the bridge -> plugin -> Figma chain")
    _add_common_flags(p_doctor)

    p_sel = sub.add_parser("sel", help="what is selected in Figma right now")
    _add_common_flags(p_sel)

    p_exec = sub.add_parser("exec")
    _add_common_flags(p_exec)
    g = p_exec.add_mutually_exclusive_group()
    g.add_argument("code", nargs="?")
    g.add_argument("--file", "-f")
    g.add_argument("--stdin", action="store_true")
    p_exec.add_argument("--args", default=None,
                        help="JSON the script reads as `args`, or @file.json (@- for stdin)")

    p_run = sub.add_parser("run", help="run a ready-made script from scripts/ by name")
    _add_common_flags(p_run)
    p_run.add_argument("name", nargs="?")
    p_run.add_argument("--args", default=None, help="JSON, or @file.json (@- for stdin)")
    p_run.add_argument("--list", action="store_true", help="list scripts with one-line descriptions")
    p_run.add_argument("--schema", action="store_true", help="print the script's args schema")
    p_run.add_argument("--example", action="store_true",
                       help="run with the example args from the script's .json")
    p_run.add_argument("--no-checkpoint", action="store_true",
                       help="skip the automatic version-history checkpoint")

    p_tree = sub.add_parser("tree")
    _add_common_flags(p_tree)
    p_tree.add_argument("node_id", help="node id, or `page` / `sel`")
    p_tree.add_argument("--depth", type=int, default=None, help="default 2 (99 with --full)")
    p_tree.add_argument("--size", action="store_true", help="show width×height")
    p_tree.add_argument("--no-size", action="store_true")
    p_tree.add_argument("--no-text", action="store_true")
    p_tree.add_argument("--layout", action="store_true",
                        help="show layoutMode, gap, padding and sizing modes")

    p_find = sub.add_parser("find")
    _add_common_flags(p_find)
    p_find.add_argument("node_id")
    p_find.add_argument("filter", help="name=X | name~X | type=X | text=X | text~X")

    p_text = sub.add_parser("text")
    _add_common_flags(p_text)
    p_text.add_argument("node_id")
    p_text.add_argument("text")

    p_variant = sub.add_parser("variant")
    _add_common_flags(p_variant)
    p_variant.add_argument("node_id")
    p_variant.add_argument("props", nargs="+")

    p_clone = sub.add_parser("clone")
    _add_common_flags(p_clone)
    p_clone.add_argument("node_id")
    p_clone.add_argument("--right", action="store_true")
    p_clone.add_argument("--left", action="store_true")
    p_clone.add_argument("--up", action="store_true")
    p_clone.add_argument("--down", action="store_true")
    p_clone.add_argument("--gap", type=int, default=100)
    p_clone.add_argument("--name")

    p_rm = sub.add_parser("rm")
    _add_common_flags(p_rm)
    p_rm.add_argument("node_ids", nargs="+", help="one or more node ids, or `sel`")

    for name in ("import-component", "icomp"):
        p = sub.add_parser(name)
        _add_common_flags(p)
        p.add_argument("key")

    return ap


def main():
    force_utf8_output()

    # Backward-compat shorthand: `figmosha "<js>"` → `figmosha exec "<js>"`
    if (
        len(sys.argv) >= 2
        and sys.argv[1] not in KNOWN_CMDS
        and not sys.argv[1].startswith("-")
    ):
        sys.argv.insert(1, "exec")

    ap = build_parser()
    args = ap.parse_args()

    if args.cmd is None:
        ap.print_help()
        sys.exit(2)

    global HOST, PORT, TARGET, PARALLEL, AGENT, QUEUE_TIMEOUT, MAX_RESULT, CHECKPOINT
    HOST = args.host
    PORT = args.port
    TARGET = getattr(args, "target", None)
    PARALLEL = getattr(args, "parallel", False)
    AGENT = getattr(args, "agent", None) or AGENT
    QUEUE_TIMEOUT = getattr(args, "queue_timeout", None)
    if getattr(args, "full", False):
        MAX_RESULT = 0
    CHECKPOINT = getattr(args, "checkpoint", None)

    dispatch = {
        "status": cmd_status,
        "token": cmd_token,
        "skills": cmd_skills,
        "new": cmd_new,
        "figma-token": cmd_figma_token,
        "link": cmd_link,
        "rest": cmd_rest,
        "targets": cmd_targets,
        "clear": cmd_clear,
        "doctor": cmd_doctor,
        "sel": cmd_sel,
        "exec": cmd_exec,
        "run": cmd_run,
        "tree": cmd_tree,
        "find": cmd_find,
        "text": cmd_text,
        "variant": cmd_variant,
        "clone": cmd_clone,
        "rm": cmd_rm,
        "import-component": cmd_import_component,
        "icomp": cmd_import_component,
    }
    sys.exit(dispatch[args.cmd](args))


if __name__ == "__main__":
    main()

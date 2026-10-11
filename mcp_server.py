#!/usr/bin/env python3
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import figmosha  # noqa: E402

SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"]
MAX_RESULT = 8000

TOOLS = [
    {
        "name": "figma_exec",
        "description": "Run JavaScript in an open Figma file through the Figmosha bridge. "
                       "Async body with figma, print and h helpers; use return to give a value back. "
                       "Return little, not whole trees.",
        "inputSchema": {
            "type": "object",
            "required": ["code"],
            "properties": {
                "code": {"type": "string", "description": "JS function body"},
                "target": {"type": "string", "description": "File name or doc id"},
                "args": {"description": "Any JSON, available as args"},
                "timeout": {"type": "number", "description": "Seconds, default 60"},
                "full": {"type": "boolean", "description": "Do not cut the result"},
            },
        },
    },
    {
        "name": "figma_run",
        "description": "Run a ready-made script by name. Omit name to list the scripts. "
                       "With a name and no args the args schema and an example come back.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "target": {"type": "string", "description": "File name or doc id"},
                "args": {"type": "object"},
                "full": {"type": "boolean"},
            },
        },
    },
    {
        "name": "figma_targets",
        "description": "List the Figma files connected to the bridge: name, doc id, busy or idle.",
        "inputSchema": {"type": "object", "properties": {}},
    },
]


def _text(text, error=False):
    result = {"content": [{"type": "text", "text": text}]}
    if error:
        result["isError"] = True
    return result


def _format(status, resp):
    if not isinstance(resp, dict):
        return _text(str(resp), True)
    if resp.get("ok") is False or status == 0 or status >= 400:
        lines = [str(resp.get("error") or f"request failed ({status})")]
        if resp.get("hint"):
            lines.append(f"hint: {resp['hint']}")
        if resp.get("warning"):
            lines.append(f"warning: {resp['warning']}")
        if resp.get("mutated") is True:
            lines.append("the script changed the document before failing")
        return _text("\n".join(lines), True)
    lines = [str(resp.get("result") or "ok")]
    if resp.get("notice"):
        lines.append(f"notice: {resp['notice']}")
    t = resp.get("truncated")
    if t:
        lines.append(f"truncated: showing {t.get('shown')} of {t.get('total')} {t.get('unit')}; "
                     "return less or pass full")
    if resp.get("mutated") is True:
        lines.append("mutated: true")
    return _text("\n".join(lines))


def _send(args, code, timeout, script_args=figmosha._NO_ARGS, checkpoint=None):
    payload = {"code": code, "timeout": timeout, "queue_timeout": timeout}
    if script_args is not figmosha._NO_ARGS:
        payload["args"] = script_args
    if checkpoint:
        payload["checkpoint"] = checkpoint
    if not args.get("full"):
        payload["max_result"] = MAX_RESULT
    if args.get("target"):
        payload["target"] = args["target"]
    agent = figmosha.AGENT
    if agent:
        payload["agent"] = agent
    status, resp = figmosha._request("POST", "/exec", payload, timeout=timeout * 2 + 5)
    return _format(status, resp)


def tool_exec(args):
    code = args.get("code")
    if not isinstance(code, str) or not code.strip():
        return _text("code: required string", True)
    timeout = args.get("timeout", 60)
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or timeout <= 0:
        return _text("timeout: must be a positive number", True)
    script_args = args["args"] if "args" in args else figmosha._NO_ARGS
    return _send(args, code, timeout, script_args)


def tool_run(args):
    name = args.get("name")
    if not name:
        scripts = figmosha.list_scripts()
        if not scripts:
            return _text("no scripts found", True)
        width = max(len(n) for n in scripts)
        lines = [f"{n.ljust(width)}  {d}" for n, d in scripts.items()]
        lines.append("pass name to run one; call with a name and no args to see its args schema and example")
        return _text("\n".join(lines))
    try:
        path, meta = figmosha.find_script(name)
    except figmosha.UsageError as e:
        return _text(str(e), True)
    schema = meta.get("args")
    script_args = args.get("args")
    shown = {k: meta[k] for k in ("description", "args", "example") if k in meta}
    if script_args is None:
        if schema and schema.get("required"):
            return _text(json.dumps(shown, ensure_ascii=False, indent=1), True)
        script_args = {}
    if schema:
        errors = figmosha.validate(script_args, schema)
        if errors:
            lines = [f"args do not match {name}'s schema:"] + errors[:20]
            if "example" in meta:
                lines.append("example: " + json.dumps(meta["example"], ensure_ascii=False))
            return _text("\n".join(lines), True)
    checkpoint = f"before {name}" if meta.get("checkpoint") else None
    timeout = meta.get("timeout", 60)
    return _send(args, path.read_text(encoding="utf-8"), timeout, script_args, checkpoint)


def tool_targets(args):
    status, resp = figmosha._request("GET", "/targets")
    if status == 0 or status >= 400:
        return _format(status, resp if isinstance(resp, dict) else {})
    files = resp.get("files") or []
    if not files:
        return _text("no files connected; Run the Figmosha Bridge plugin in each Figma file", True)
    lines = []
    for f in files:
        q = f.get("queue") or {}
        run = q.get("running")
        busy = f"busy: {run.get('agent') or '?'} {run.get('for_s')}s" if run else "idle"
        if q.get("waiting"):
            busy += f", waiting: {', '.join(q['waiting'])}"
        lines.append(f"{f.get('name') or '(unidentified)'}\t{f.get('doc') or '-'}\t{busy}")
    return _text("\n".join(lines))


HANDLERS = {"figma_exec": tool_exec, "figma_run": tool_run, "figma_targets": tool_targets}


def _error(id_, code, message):
    return {"jsonrpc": "2.0", "id": id_, "error": {"code": code, "message": message}}


def handle(message):
    if not isinstance(message, dict):
        return _error(None, -32600, "invalid request")
    method = message.get("method")
    if "id" not in message:
        return None
    id_ = message["id"]
    params = message.get("params") or {}
    if method == "initialize":
        asked = params.get("protocolVersion")
        version = asked if asked in SUPPORTED else SUPPORTED[0]
        return {"jsonrpc": "2.0", "id": id_, "result": {
            "protocolVersion": version,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "figmosha", "version": "1.0.0"},
        }}
    if method == "ping":
        return {"jsonrpc": "2.0", "id": id_, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": id_, "result": {"tools": TOOLS}}
    if method == "tools/call":
        handler = HANDLERS.get(params.get("name"))
        if handler is None:
            return {"jsonrpc": "2.0", "id": id_,
                    "result": _text(f"unknown tool {params.get('name')!r}", True)}
        arguments = params.get("arguments") or {}
        if not isinstance(arguments, dict):
            return {"jsonrpc": "2.0", "id": id_, "result": _text("arguments must be an object", True)}
        try:
            result = handler(arguments)
        except Exception as e:
            result = _text(f"{type(e).__name__}: {e}", True)
        return {"jsonrpc": "2.0", "id": id_, "result": result}
    return _error(id_, -32601, f"method not found: {method}")


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            reply = _error(None, -32700, "parse error")
        else:
            reply = handle(message)
        if reply is not None:
            sys.stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()

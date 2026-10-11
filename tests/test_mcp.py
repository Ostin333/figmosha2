import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import figmosha  # noqa: E402
import mcp_server  # noqa: E402


@pytest.fixture
def sent(monkeypatch):
    calls = []

    def fake(method, path, payload=None, timeout=65):
        calls.append({"method": method, "path": path, "payload": payload})
        return 200, {"ok": True, "result": "done"}

    monkeypatch.setattr(figmosha, "_request", fake)
    return calls


def call(name, arguments, id_=1):
    return mcp_server.handle({"jsonrpc": "2.0", "id": id_, "method": "tools/call",
                              "params": {"name": name, "arguments": arguments}})


def test_initialize():
    r = mcp_server.handle({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                           "params": {"protocolVersion": "2024-11-05"}})
    assert r["result"]["protocolVersion"] == "2024-11-05"
    assert r["result"]["serverInfo"]["name"] == "figmosha"
    assert r["result"]["capabilities"] == {"tools": {}}
    r = mcp_server.handle({"jsonrpc": "2.0", "id": 2, "method": "initialize",
                           "params": {"protocolVersion": "1999-01-01"}})
    assert r["result"]["protocolVersion"] == "2025-06-18"


def test_notification_gets_no_reply():
    assert mcp_server.handle({"jsonrpc": "2.0", "method": "notifications/initialized"}) is None
    assert mcp_server.handle({"jsonrpc": "2.0", "method": "nope"}) is None


def test_ping():
    assert mcp_server.handle({"jsonrpc": "2.0", "id": 5, "method": "ping"})["result"] == {}


def test_tools_list_size():
    r = mcp_server.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    tools = r["result"]["tools"]
    assert [t["name"] for t in tools] == ["figma_exec", "figma_run", "figma_targets"]
    assert len(json.dumps(tools)) < 2400


def test_unknown_method():
    r = mcp_server.handle({"jsonrpc": "2.0", "id": 3, "method": "resources/list"})
    assert r["error"]["code"] == -32601


def test_unknown_tool():
    r = call("nope", {})
    assert r["result"]["isError"] is True


def test_exec_payload(sent):
    r = call("figma_exec", {"code": "return 1", "target": "Lib", "args": {"a": 1}, "timeout": 20})
    assert r["result"]["content"][0]["text"] == "done"
    assert "isError" not in r["result"]
    call_ = sent[0]
    assert call_["method"] == "POST" and call_["path"] == "/exec"
    p = call_["payload"]
    assert p["code"] == "return 1" and p["target"] == "Lib" and p["args"] == {"a": 1}
    assert p["timeout"] == 20 and p["max_result"] == 8000


def test_exec_full(sent):
    call("figma_exec", {"code": "return 1", "full": True})
    assert "max_result" not in sent[0]["payload"]


def test_exec_error(monkeypatch):
    monkeypatch.setattr(figmosha, "_request", lambda *a, **k: (
        500, {"ok": False, "error": "boom", "hint": "try x", "stack": "SECRET", "mutated": True}))
    r = call("figma_exec", {"code": "x"})
    text = r["result"]["content"][0]["text"]
    assert r["result"]["isError"] is True
    assert "boom" in text and "try x" in text and "changed the document" in text
    assert "SECRET" not in text


def test_exec_notice_and_truncated(monkeypatch):
    monkeypatch.setattr(figmosha, "_request", lambda *a, **k: (
        200, {"ok": True, "result": "r", "notice": "stale", "truncated": {"shown": 1, "total": 9, "unit": "bytes"},
              "mutated": True}))
    text = call("figma_exec", {"code": "x"})["result"]["content"][0]["text"]
    assert "notice: stale" in text and "truncated" in text and "mutated: true" in text


def test_run_invalid_args_sends_nothing(sent):
    r = call("figma_run", {"name": "arrange", "args": {"set": 5}})
    assert r["result"]["isError"] is True
    assert sent == []


def test_run_missing_args_returns_schema(sent):
    r = call("figma_run", {"name": "arrange"})
    text = r["result"]["content"][0]["text"]
    assert r["result"]["isError"] is True
    assert "example" in text and sent == []


def test_run_valid(sent):
    r = call("figma_run", {"name": "arrange", "args": {"set": "sel"}, "target": "Lib"})
    assert "isError" not in r["result"]
    p = sent[0]["payload"]
    assert p["args"] == {"set": "sel"} and p["target"] == "Lib" and p["max_result"] == 8000


def test_run_no_name_lists(sent):
    r = call("figma_run", {})
    text = r["result"]["content"][0]["text"]
    assert "arrange" in text and sent == []


def test_run_unknown_script(sent):
    r = call("figma_run", {"name": "does-not-exist"})
    assert r["result"]["isError"] is True and sent == []


def test_targets(monkeypatch):
    monkeypatch.setattr(figmosha, "_request", lambda *a, **k: (200, {"files": [
        {"name": "Lib", "doc": "abc123", "queue": {"running": {"agent": "d", "for_s": 2}}},
        {"name": "Icons", "doc": "def456"}]}))
    text = call("figma_targets", {})["result"]["content"][0]["text"]
    assert "Lib\tabc123\tbusy: d 2s" in text and "Icons\tdef456\tidle" in text


def test_subprocess_roundtrip():
    msgs = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
    ]
    out = subprocess.run([sys.executable, str(ROOT / "mcp_server.py")],
                         input="\n".join(json.dumps(m) for m in msgs) + "\n",
                         capture_output=True, text=True, timeout=30).stdout
    replies = [json.loads(line) for line in out.splitlines()]
    assert [r["id"] for r in replies] == [1, 2]
    assert len(replies[1]["result"]["tools"]) == 3

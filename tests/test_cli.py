import json
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import figmosha  # noqa: E402


@pytest.fixture
def sent(monkeypatch):
    calls = []

    def fake(method, path, payload=None, timeout=65):
        calls.append({"method": method, "path": path, "payload": payload})
        return 200, {"ok": True, "result": "done", "value": "done"}

    monkeypatch.setattr(figmosha, "_request", fake)
    monkeypatch.setattr(figmosha, "MAX_RESULT", 8000)
    monkeypatch.setattr(figmosha, "CHECKPOINT", None)
    return calls


@pytest.fixture
def scripts(tmp_path, monkeypatch):
    (tmp_path / "make-thing.js").write_text("return args.name;")
    (tmp_path / "make-thing.json").write_text(json.dumps({
        "description": "Make a thing",
        "checkpoint": True,
        "timeout": 120,
        "args": {"type": "object", "required": ["name"], "additionalProperties": False,
                 "properties": {"name": {"type": "string"},
                                "size": {"enum": ["S", "M"]}}},
        "example": {"name": "Example"},
    }))
    (tmp_path / "plain.js").write_text("return 1;")
    monkeypatch.setenv("FIGMOSHA_SCRIPTS", str(tmp_path))
    return tmp_path


def run_cli(argv, monkeypatch):
    monkeypatch.setattr(sys, "argv", ["figmosha", *argv])
    with pytest.raises(SystemExit) as e:
        figmosha.main()
    return e.value.code


def test_run_sends_the_script_with_args_and_a_checkpoint(sent, scripts, monkeypatch):
    assert run_cli(["run", "make-thing", "--args", '{"name": "Color"}'], monkeypatch) == 0
    p = sent[0]["payload"]
    assert p["code"] == "return args.name;"
    assert p["args"] == {"name": "Color"}
    assert p["checkpoint"] == "before make-thing"
    assert p["timeout"] == 120
    assert p["max_result"] == 8000


def test_run_reads_args_from_a_file(sent, scripts, monkeypatch, tmp_path):
    spec = tmp_path / "spec.json"
    spec.write_text('{"name": "Їжак", "size": "M"}', encoding="utf-8")
    assert run_cli(["run", "make-thing", "--args", f"@{spec}", "--no-checkpoint",
                    "-t", "30", "--full"], monkeypatch) == 0
    p = sent[0]["payload"]
    assert p["args"] == {"name": "Їжак", "size": "M"}
    assert "checkpoint" not in p and "max_result" not in p
    assert p["timeout"] == 30


def test_run_with_bad_args_sends_nothing(sent, scripts, monkeypatch, capsys):
    assert run_cli(["run", "make-thing", "--args", '{"size": "XL", "x": 1}'], monkeypatch) == 2
    err = capsys.readouterr().err
    assert "args.name: required" in err
    assert "args.size: must be one of" in err
    assert "args.x: unknown key" in err
    assert sent == []


def test_run_example_and_schema(sent, scripts, monkeypatch, capsys):
    assert run_cli(["run", "make-thing", "--schema"], monkeypatch) == 0
    assert json.loads(capsys.readouterr().out)["example"] == {"name": "Example"}
    assert run_cli(["run", "make-thing", "--example"], monkeypatch) == 0
    assert sent[0]["payload"]["args"] == {"name": "Example"}


def test_run_list_and_unknown_names(sent, scripts, monkeypatch, capsys):
    assert run_cli(["run", "--list"], monkeypatch) == 0
    out = capsys.readouterr().out
    assert re.search(r"^make-thing +Make a thing$", out, re.M) and "plain" in out
    assert "setup-tokens" in out
    assert run_cli(["run", "nope"], monkeypatch) == 2
    assert run_cli(["run", "../etc/passwd"], monkeypatch) == 2
    assert sent == []


def test_exec_args_and_checkpoint_flags(sent, monkeypatch):
    assert run_cli(["exec", "return args", "--args", "[1,2]", "--checkpoint", "x"], monkeypatch) == 0
    assert sent[0]["payload"]["args"] == [1, 2]
    assert sent[0]["payload"]["checkpoint"] == "x"
    assert run_cli(["exec", "return 1"], monkeypatch) == 0
    assert "args" not in sent[1]["payload"]


def test_tree_and_find_are_brief_by_default(sent, monkeypatch):
    run_cli(["tree", "page"], monkeypatch)
    assert '"maxDepth": 2' in sent[0]["payload"]["code"]
    assert '"showSize": false' in sent[0]["payload"]["code"]
    run_cli(["tree", "page", "--full"], monkeypatch)
    assert '"maxDepth": 99' in sent[1]["payload"]["code"]
    run_cli(["find", "page", "name=Button"], monkeypatch)
    assert "h.brief(" in sent[2]["payload"]["code"]
    run_cli(["find", "page", "text~Hi"], monkeypatch)
    assert "chars:" in sent[3]["payload"]["code"]


@pytest.mark.parametrize("value,schema,errors", [
    (1, {"type": "integer", "minimum": 2}, ["args: must be >= 2"]),
    (True, {"type": "number"}, ["args: expected number, got bool"]),
    ([], {"type": "array", "minItems": 1}, ["args: needs at least 1 item(s)"]),
    (["a", 2], {"items": {"type": "string"}}, ["args[1]: expected string, got int"]),
    ({"a": {"b": 1}}, {"additionalProperties": {"type": "object",
                                                "properties": {"b": {"type": "string"}}}},
     ["args.a.b: expected string, got int"]),
    ("#12", {"type": "string", "pattern": "^#[0-9a-f]{6}$"}, ["args: must match ^#[0-9a-f]{6}$"]),
    (None, {"type": ["string", "null"]}, []),
])
def test_validate(value, schema, errors):
    assert figmosha.validate(value, schema) == errors


def test_emit_says_when_a_result_was_cut_or_a_failure_left_changes(capsys):
    figmosha._emit({"ok": True, "result": "[]", "truncated": {"shown": 3, "total": 9, "unit": "items"}})
    assert "showing 3 of 9 items" in capsys.readouterr().err
    figmosha._emit({"ok": False, "error": "boom", "mutated": True, "stack": "at x"})
    err = capsys.readouterr().err
    assert "changed the document" in err and "at x" not in err


def test_cli_sends_the_token(monkeypatch, tmp_path):
    monkeypatch.delenv("FIGMOSHA_TOKEN", raising=False)
    monkeypatch.setenv("FIGMOSHA_HOME", str(tmp_path))
    (tmp_path / "token").write_text("abc\n")
    seen = {}

    class Resp:
        status = 200

        def read(self):
            return b"{}"

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def fake_urlopen(req, timeout):
        seen.update(req.headers)
        return Resp()

    monkeypatch.setattr(figmosha.urllib.request, "urlopen", fake_urlopen)
    figmosha._request("GET", "/status")
    assert seen["Authorization"] == "Bearer abc"


def test_skills_install_links_for_claude_and_codex(tmp_path, monkeypatch, capsys):
    assert run_cli(["skills", "install", "--project", str(tmp_path)], monkeypatch) == 0
    for base in (".claude/skills", ".agents/skills"):
        link = tmp_path / base / "figmosha-core"
        assert link.is_symlink() and (link / "SKILL.md").is_file()
    assert run_cli(["skills", "install", "--project", str(tmp_path)], monkeypatch) == 0
    (tmp_path / ".claude/skills/figmosha-core").unlink()
    (tmp_path / ".claude/skills/figmosha-core").mkdir()
    assert run_cli(["skills", "install", "--project", str(tmp_path), "--for", "claude"], monkeypatch) == 1
    assert run_cli(["skills", "install", "--project", str(tmp_path), "--for", "claude",
                    "--force", "--copy"], monkeypatch) == 0
    assert (tmp_path / ".claude/skills/figmosha-core/SKILL.md").is_file()


def test_every_skill_has_frontmatter_and_fits(monkeypatch):
    skills = sorted((Path(figmosha.__file__).parent / "skills").glob("*/SKILL.md"))
    assert len(skills) == 8
    for path in skills:
        text = path.read_text(encoding="utf-8")
        head = text.split("---")[1]
        assert f"name: {path.parent.name}" in head and "description:" in head, path
        assert len(text.splitlines()) <= 150, path


def test_new_waits_for_a_new_document(monkeypatch, capsys):
    answers = iter([[{"doc": "dold", "name": "Old"}], [{"doc": "dold", "name": "Old"}],
                    [{"doc": "dold", "name": "Old"}, {"doc": "dnew", "name": "Untitled"}]])
    monkeypatch.setattr(figmosha, "_request", lambda *a, **k: (200, {"files": next(answers)}))
    opened = []
    monkeypatch.setattr(figmosha.webbrowser, "open", opened.append)
    assert run_cli(["new", "--poll", "0", "--wait", "5"], monkeypatch) == 0
    assert opened == [figmosha.NEW_FILE_URL]
    assert json.loads(capsys.readouterr().out) == {"doc": "dnew", "name": "Untitled"}


def test_new_gives_up(monkeypatch):
    monkeypatch.setattr(figmosha, "_request", lambda *a, **k: (200, {"files": []}))
    assert run_cli(["new", "--no-open", "--poll", "0", "--wait", "0.05"], monkeypatch) == 1


@pytest.mark.parametrize("text,key", [
    ("https://www.figma.com/design/AbCdEf123456/My-File?node-id=1-2", "AbCdEf123456"),
    ("https://www.figma.com/file/AbCdEf123456/x", "AbCdEf123456"),
    ("AbCdEf123456", "AbCdEf123456"),
])
def test_parse_file_key(text, key):
    assert figmosha.parse_file_key(text) == key


def test_link_and_rest_versions(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("FIGMOSHA_HOME", str(tmp_path))
    monkeypatch.setenv("FIGMA_TOKEN", "figd_test")
    monkeypatch.setattr(figmosha, "_request", lambda *a, **k: (
        200, {"files": [{"doc": "dabc123", "name": "Design System"}]}))
    assert run_cli(["link", "-T", "Design System", "https://www.figma.com/design/KEY1234567890/x"],
                   monkeypatch) == 0
    import stat
    assert stat.S_IMODE((tmp_path / "links.json").stat().st_mode) == 0o600
    calls = []

    def fake_get(path, token):
        calls.append((path, token))
        return {"versions": [{"id": "1", "created_at": "t", "label": "L", "user": {"handle": "ann"},
                              "description": "long"}] * 3}

    monkeypatch.setattr(figmosha, "_rest_get", fake_get)
    capsys.readouterr()
    assert run_cli(["rest", "versions", "-T", "dabc", "--limit", "2"], monkeypatch) == 0
    assert calls == [("/files/KEY1234567890/versions", "figd_test")]
    assert json.loads(capsys.readouterr().out) == [{"id": "1", "at": "t", "label": "L", "by": "ann"}] * 2


def test_rest_without_token_or_link(tmp_path, monkeypatch):
    monkeypatch.setenv("FIGMOSHA_HOME", str(tmp_path))
    monkeypatch.delenv("FIGMA_TOKEN", raising=False)
    assert run_cli(["rest", "versions", "--key", "KEY1234567890"], monkeypatch) == 2
    monkeypatch.setenv("FIGMA_TOKEN", "x")
    monkeypatch.setattr(figmosha, "_request", lambda *a, **k: (200, {"files": [{"doc": "dz1", "name": "Z"}]}))
    assert run_cli(["rest", "comments", "-T", "Z"], monkeypatch) == 2


def test_figma_token_is_stored_private(tmp_path, monkeypatch):
    import io
    import stat
    monkeypatch.setenv("FIGMOSHA_HOME", str(tmp_path))
    monkeypatch.setattr(sys, "stdin", io.StringIO("figd_secret\n"))
    assert run_cli(["figma-token"], monkeypatch) == 0
    path = tmp_path / "figma_token"
    assert path.read_text().strip() == "figd_secret"
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_skills_install_never_touches_the_checkout(tmp_path, monkeypatch):
    target = tmp_path / ".claude"
    target.mkdir()
    (target / "skills").symlink_to(figmosha.SKILLS_DIR, target_is_directory=True)
    before = sorted(p.name for p in figmosha.SKILLS_DIR.iterdir())
    run_cli(["skills", "install", "--project", str(tmp_path), "--for", "claude", "--force"], monkeypatch)
    assert sorted(p.name for p in figmosha.SKILLS_DIR.iterdir()) == before
    assert (figmosha.SKILLS_DIR / "figmosha-core" / "SKILL.md").is_file()

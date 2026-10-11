import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "bench"))
import summarize  # noqa: E402


def test_summarize_takes_medians_per_tool_and_scenario(tmp_path):
    for i, tokens in enumerate((1000, 3000, 2000)):
        (tmp_path / f"a{i}.json").write_text(json.dumps(
            {"tool": "figmosha", "scenario": "s1", "input_tokens": tokens, "calls": 2,
             "passed": i != 1}))
    (tmp_path / "b.json").write_text(json.dumps({"tool": "other", "scenario": "s1"}))
    table = summarize.summarize(summarize.load(tmp_path))
    row = next(line for line in table.splitlines() if "| figmosha |" in line)
    assert "| 3 | 2/3 | 2,000 |" in row
    assert "| other | 1 | 0/1 | — |" in table


def test_summarize_rejects_a_run_without_a_tool(tmp_path):
    (tmp_path / "x.json").write_text(json.dumps({"scenario": "s1"}))
    try:
        summarize.load(tmp_path)
    except SystemExit as e:
        assert "tool" in str(e)
    else:
        raise AssertionError("expected SystemExit")

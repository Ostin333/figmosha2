# Benchmarks

Three scenarios, each run three times per tool on a fresh duplicate of the `Figmosha Bench` file.

| Scenario | File |
|---|---|
| s1 colour tokens | `s1-tokens.md` |
| s2 Button component set | `s2-component.md` |
| s3 login screen | `s3-screen.md` |

## Recording a run

1. Duplicate `Figmosha Bench`, run the plugin in it, note its doc id from `figmosha targets`.
2. Start a fresh Claude Code session in a scratch directory with only the tool under test installed.
3. Paste the scenario prompt (add `Use -T <doc id>` for Figmosha).
4. At the end run `/cost` (or read the transcript) and write one JSON file per run into `bench/runs/`:

```json
{
  "tool": "figmosha-2.3.0",
  "scenario": "s1",
  "run": 1,
  "input_tokens": 41200,
  "output_tokens": 3900,
  "calls": 6,
  "errors": 1,
  "seconds": 140,
  "manual_fixes": 0,
  "passed": true,
  "notes": ""
}
```

5. `python bench/summarize.py` rebuilds `bench/RESULTS.md` from every file in `bench/runs/`.

`tool` is free text: use `figmosha-<version>`, `figma-console-mcp-<version>`, `figma-mcp-official`.

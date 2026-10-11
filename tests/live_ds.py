import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLI = [sys.executable, str(ROOT / "figmosha.py")]

TOKENS = {
    "collections": [
        {"collection": "Color", "modes": ["Light", "Dark"], "tokens": {
            "palette": {"$type": "color",
                        "blue": {str(k): {"$value": v} for k, v in zip(range(100, 600, 100), ["#dbeafe", "#bfdbfe", "#93c5fd", "#3b82f6", "#2563eb"])},
                        "gray": {str(k): {"$value": v} for k, v in zip(range(100, 600, 100), ["#f3f4f6", "#e5e7eb", "#d1d5db", "#6b7280", "#374151"])},
                        "red": {str(k): {"$value": v} for k, v in zip(range(100, 600, 100), ["#fee2e2", "#fecaca", "#fca5a5", "#ef4444", "#dc2626"])}},
            "bg": {"default": {"$value": {"Light": "{palette.gray.100}", "Dark": "{palette.gray.500}"}, "$scopes": ["fill"]},
                   "brand": {"$value": "{palette.blue.500}", "$scopes": ["fill"]}},
            "text": {"default": {"$value": {"Light": "{palette.gray.500}", "Dark": "{palette.gray.100}"}, "$scopes": ["text"]},
                     "danger": {"$value": "{palette.red.500}", "$scopes": ["text"]}},
            "border": {"default": {"$value": "{palette.gray.300}", "$scopes": ["stroke"]}}}},
        {"collection": "Space", "tokens": {
            "radius": {"$type": "number", "sm": {"$value": 6, "$scopes": ["radius"]},
                       "md": {"$value": 8, "$scopes": ["radius"]}, "lg": {"$value": 10, "$scopes": ["radius"]}},
            "space": {"$type": "number", "2": {"$value": 8, "$scopes": ["gap"]}}}},
    ],
}

BUTTON = {
    "name": "Button", "page": "Components",
    "variants": {"Type": ["Primary", "Secondary", "Ghost", "Danger"], "Size": ["S", "M", "L"]},
    "base": {"padding": [8, 12], "radius": "radius/md", "spacing": "space/2", "fill": "bg/brand"},
    "text": {"value": "Button", "property": "Label", "fill": "text/default", "size": 14},
    "rules": [
        {"when": {"Size": "S"}, "set": {"padding": [6, 10], "radius": "radius/sm", "textSize": 12}},
        {"when": {"Size": "L"}, "set": {"padding": [12, 16], "radius": "radius/lg", "textSize": 16}},
        {"when": {"Type": "Secondary"}, "set": {"fill": "bg/default", "stroke": "border/default", "strokeWeight": 1}},
        {"when": {"Type": "Ghost"}, "set": {"fill": None}},
        {"when": {"Type": "Danger"}, "set": {"fill": "palette/red/500", "textFill": "#ffffff"}},
    ],
}


def run(target, name, args):
    out = subprocess.run(CLI + ["run", name, "-T", target, "--no-checkpoint", "--args", json.dumps(args)],
                         capture_output=True, text=True)
    if out.returncode != 0:
        raise SystemExit(f"{name} failed:\n{out.stderr}")
    return json.loads(out.stdout)


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: python tests/live_ds.py <doc id of a scratch copy of 'Figmosha Bench'>")
    target = sys.argv[1]
    first = run(target, "setup-tokens", TOKENS)
    again = run(target, "setup-tokens", TOKENS)
    assert len(first["created"]) == 24 or len(first["created"]) == 0, first
    assert again["created"] == [] and again["updated"] == [], again
    set1 = run(target, "component-set", BUTTON)
    set2 = run(target, "component-set", BUTTON)
    assert set1["variants"] == 12, set1
    assert set2["created"] == 0 and set2["restyled"] == 12, set2
    lint = run(target, "lint", {"root": set2["set"]["id"], "rules": ["unbound-color", "unbound-radius"]})
    leftovers = {k: v for k, v in lint["counts"].items()}
    assert leftovers.get("unbound-radius", 0) == 0, lint
    print("ok:", json.dumps({"tokens": len(first["created"]), "variants": set2["variants"],
                             "lint": leftovers}, ensure_ascii=False))


if __name__ == "__main__":
    main()

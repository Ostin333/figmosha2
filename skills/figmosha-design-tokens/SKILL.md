---
name: figmosha-design-tokens
description: Create, update, import or export Figma variables (design tokens) — collections, Light/Dark modes, aliases, scopes, code syntax — with one figmosha call. Тригери - токени, змінні, variables, колекція кольорів, теми light/dark, імпорт/експорт токенів.
---

# Design tokens with Figmosha

Requires the `figmosha-core` rules (targets, `-T`). One script does create **and** update:
`setup-tokens` upserts by name, so re-running the same spec changes nothing.

## Create or update

1. Write the spec to a file (DTCG-style):

```json
{
  "collection": "Color",
  "modes": ["Light", "Dark"],
  "tokens": {
    "palette": { "$type": "color", "blue": { "500": { "$value": "#2563eb" } },
                 "gray": { "100": { "$value": "#f3f4f6" }, "500": { "$value": "#374151" } } },
    "bg": { "default": { "$value": { "Light": "{palette.gray.100}", "Dark": "{palette.gray.500}" },
                         "$scopes": ["fill"] } },
    "text": { "default": { "$value": "{palette.gray.500}", "$modes": { "Dark": "{palette.gray.100}" },
                           "$scopes": ["text"], "$codeSyntax": { "WEB": "var(--text-default)" } } }
  }
}
```

2. `figmosha run setup-tokens --args @tokens.json -T <doc>`
3. The reply lists `created`, `updated`, `unchanged`. That is the verification — no extra read.

Several collections at once: `{"collections": [{"collection": "Color", ...}, {"collection": "Space", ...}]}`.

## Spec rules

- Variable name = group path joined with `/` (`bg/default`). Keys cannot contain `/` or `.`.
- `$type`: `color`, `number`/`dimension` (`16`, `"16px"`), `string`, `boolean`; inherited from groups.
  Alias-only tokens take the target's type.
- `$value`: one value for every mode, or `{ "<mode>": value }`. `$modes` overrides some modes.
- Aliases: `{group.name}`; another collection: `{Collection.group.name}`; existing file variables work too.
- `$scopes`: Figma scopes or shorthands `fill`, `fills`, `text`, `stroke`, `radius`, `gap`, `size`,
  `opacity`, `font-size`, `line-height`, `letter-spacing`, `font-weight`, `font-family`, `all`.
- `$description`, `$codeSyntax` (`WEB`, `ANDROID`, `iOS`), `$hidden`.
- Modes: a new collection's first mode is renamed to `modes[0]`; missing modes are added.
- Any problem → one error listing all of them; nothing written. Fix the spec and rerun.

## Export

`figmosha run export-tokens --args '{"collection":"Color"}' -T <doc> --full > tokens.json`
— same format, so it can be edited and fed back to `setup-tokens`.

## From code

Converting a CSS / Tailwind / Style Dictionary theme: build the spec in your scratch dir from the
source file, then one `setup-tokens` call. Keep raw palette values in one group and semantic tokens as
aliases to it.

## Renames and deletes

Not covered by the script (upsert never deletes). Use exec:
`const v = (await figma.variables.getLocalVariablesAsync()).find(v => v.name === args.from); v.name = args.to; return v.id;`
Deleting (`v.remove()`) breaks every binding — confirm with the user first.

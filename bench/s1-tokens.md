# s1 — colour tokens

Target file: a fresh duplicate of `Figmosha Bench`, plugin running, `-T` set to its doc id.

Prompt for the agent:

> In the connected Figma file create a variable collection `Color` with modes `Light` and `Dark`.
> Add 15 raw colours `palette/blue/100..500`, `palette/gray/100..500`, `palette/red/100..500`
> (pick sensible hex values, same in both modes), and 5 semantic aliases:
> `bg/default` → gray/100 (Light) and gray/500 (Dark), `bg/brand` → blue/500,
> `text/default` → gray/500 (Light) and gray/100 (Dark), `text/danger` → red/500,
> `border/default` → gray/300. Scope semantic `bg/*` to fills, `text/*` to text fill,
> `border/*` to strokes. Report what was created.

Pass criteria: 20 variables, 2 modes, 5 aliases resolving to the right raw colours, scopes set,
a second run creates nothing new.

# s2 — Button component set

Precondition: s1 has been run on the same file.

Prompt for the agent:

> Create a component set `Button` with variants `Type=Primary|Secondary|Ghost|Danger` ×
> `Size=S|M|L`. Horizontal auto layout, hug contents, a text label `Label` exposed as a TEXT
> component property. Padding 8/12/16 and radius 6/8/10 for S/M/L. Fills: Primary → `bg/brand`,
> Danger → `palette/red/500`, Secondary → `bg/default` with a `border/default` stroke,
> Ghost → no fill. Label colour bound to `text/default` (white hex for Primary and Danger is fine).
> Arrange the variants in a grid. Report the set id and variant count.

Pass criteria: 12 variants, every fill and stroke bound to a variable, a second run updates in place.

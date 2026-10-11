# s3 — login screen from existing parts

Precondition: s1 and s2 have been run on the same file.

Prompt for the agent:

> On a new page `Screens` build a 390×844 login screen: a title, two text inputs (email,
> password — plain frames are fine), a primary `Button` instance `Size=L` with label "Sign in",
> and a ghost `Button` "Forgot password?". Use only the file's variables for colours and its
> Button component for buttons. Vertical auto layout, 24 padding, 16 gap.

Pass criteria: no unbound colours on the screen (`figmosha run lint` reports zero), both buttons are
instances of the set from s2.

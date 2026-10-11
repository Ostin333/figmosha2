# Figmosha: step-by-step guide

How to start the bridge, connect the plugin in Figma, paste the token and start working — on your
own or through an agent (Claude Code, Codex).

## How it fits together

```
agent / terminal ──HTTP──▶ bridge (bridge.py, 127.0.0.1:8787) ──WebSocket──▶ plugin in Figma ──▶ your file
```

- **The bridge** is a small local Python server. It takes JavaScript and passes it to Figma.
- **The plugin** "Figmosha Bridge" runs inside an open Figma file, executes the code and returns the
  result. Every open file with the plugin running is a separate target.
- **The CLI** `figmosha.py` wraps the HTTP API in handy commands. Agents use it.

Nothing needs to be built: the plugin is plain files in `plugin/`, and Figma reads them from disk.

## 1. Install (once)

You need **Figma Desktop** (the browser version cannot import local plugins) and **Python 3.10+**.

```bash
git clone https://github.com/denysosadchyi/figmosha2.git
cd figmosha2
python3 -m venv venv && ./venv/bin/pip install -r requirements.txt
```

On Windows (PowerShell): `python -m venv venv; .\venv\Scripts\pip install -r requirements.txt`.

Below, `figmosha` means `./venv/bin/python figmosha.py` (on Windows
`.\venv\Scripts\python figmosha.py`). A stock Mac has no `python` command, only this.

Optional — skills for agents:

```bash
./venv/bin/python figmosha.py skills install
```

## 2. Start the bridge

```bash
bash start-bridge.sh          # macOS / Linux / WSL — runs in the background
.\start-bridge.ps1            # Windows
```

You should see `up on 127.0.0.1:8787`. The bridge keeps running after you close the terminal, but it
**does not survive a reboot** — start it again afterwards.

Stop it: `bash start-bridge.sh --stop`. Log: `~/.local/state/figmosha/bridge.log`.

## 3. Import the plugin into Figma (once)

1. Open Figma Desktop and any design file.
2. Menu **Plugins → Development → Import plugin from manifest…**
3. Pick `plugin/manifest.json` from the repository folder (in the file dialog ⌘⇧G lets you paste a path).

Import again only when `manifest.json` changes (the CHANGELOG says so) or you moved the folder. If you
once imported Figmosha from another folder, remove the old entry in
**Plugins → Development → Manage plugins in development**, or the old version will run.

Changes to `code.js` / `ui.html` need no re-import — re-running the plugin is enough.

## 4. Run the plugin in a file

In every file you want to work with: **Plugins → Development → Figmosha Bridge**
(re-run with ⌘⌥P).

A small bar with the file's name appears at the bottom. **Keep it open** while the agent works: a
closed bar means a disconnected file. Several files can be connected at once, each with its own bar.

## 5. The token (once)

### Why

The bridge runs any code in your Figma files. Without protection, any program on your computer (or a
page in your browser) could connect to port `8787` and:

- run its own code in your files — read, change or delete designs;
- pretend to be the plugin and receive the code and results agents send to Figma.

The token is a secret shared by the bridge and the plugin. A request without it is refused, and a
"plugin" without the right token is disconnected.

### Where it comes from

On first start the bridge creates a random token in `~/.figmosha/token` (readable only by you). The
CLI and agents read it from there automatically — they need nothing typed in.

### Why you paste it into the plugin yourself

The plugin runs in Figma's sandbox and **cannot see files on disk**. And the bridge must not hand the
token out — then anyone could get it. So you carry the secret across, once.

### How to paste it

1. After the plugin starts, the bar turns **red with a "Paste token" field**.
2. In a terminal:
   ```bash
   ./venv/bin/python figmosha.py token
   ```
   The token is copied to the clipboard (no clipboard tool — `figmosha token --show` and copy it by hand).
3. Click the field, **⌘V**, **Enter**. The bar turns green with the file's name.

The plugin remembers the token in Figma's storage — it is shared by **every file** and survives
restarts of Figma and the bridge. You paste it again only when:

- you deleted `~/.figmosha/token` (the bridge makes a new one — that is how you rotate it);
- you work on another computer or from another Figma account.

For now HTTP requests **without** a token are still accepted with a warning (until 3.0); a wrong token
is always refused. To require it now: `bash start-bridge.sh --require-token`.

## 6. Check

```bash
./venv/bin/python figmosha.py doctor     # every line should have a ✓
./venv/bin/python figmosha.py targets    # connected files and their doc ids
```

For any ✗, the line below it says what to do.

## 7. Using it

### Through an agent (the main way)

Open Claude Code or Codex in the `figmosha2` folder (the agent reads `AGENTS.md`) and describe the task
in plain words, naming the file:

- "In *Design System*, create colour and spacing variables from this JSON / from the tailwind config."
- "Make a Button component with Type × Size variants, bound to the variables."
- "Check the *Home* page for colours and radii not bound to variables."
- "Bring the home page of the site in `~/projects/site` into Figma, 1440 wide, an exact copy."

The agent finds the file through `targets`, takes a ready-made script or writes code, and checks the
result. Every call is one Cmd+Z step in Figma; before large changes the agent saves a version in the
file's history.

### On your own from the terminal

```bash
figmosha targets                                        # which files are connected
figmosha exec "return figma.currentPage.name" -T "My file"
figmosha sel -T "My file"                               # what is selected
figmosha tree sel -T "My file"                          # tree of the selection
figmosha text 1:25 "New text" -T "My file"              # change a text
figmosha run --list                                     # ready-made scripts
figmosha run setup-tokens --schema                      # args format and example
figmosha run setup-tokens --args @tokens.json -T "Design System"
```

`-T` (file name or doc id from `targets`) is required when two or more files are connected.

Ready-made scripts: `setup-tokens`, `export-tokens`, `text-styles`, `effect-styles`,
`component-set`, `arrange`, `bind-auto`, `inventory`, `lint`, `bootstrap-file`.

## Common problems

| What you see | What to do |
|---|---|
| `connection refused` | The bridge is not running: `bash start-bridge.sh` |
| `plugin not connected` | Run the plugin in the file: Plugins → Development → Figmosha Bridge |
| The bar is red with a field | Paste the token (section 5) |
| The bar is red after pasting | The token is wrong or changed — `figmosha token` and paste again |
| `401` in the terminal | Wrong `$FIGMOSHA_TOKEN` or the token file changed — restart the bridge |
| A warning about an outdated plugin or bridge | Re-run the plugin (⌘⌥P) or restart the bridge (`bash start-bridge.sh`) |
| `409` | Several files are connected — add `-T "<name or doc id>"` |
| `file busy` / `queue full` | The file is busy with another request — try again shortly |
| `504` | The script may still be running; the file is locked until it ends |
| `h.X is not a function` | The plugin runs old code — re-run it (⌘⌥P) |
| Nothing works after a reboot | Start the bridge again, then the plugin |

More: [README](../README.md), [concurrency.md](concurrency.md) (several files and agents),
[plugin-api.md](plugin-api.md) (the `h.*` helpers, spec formats).

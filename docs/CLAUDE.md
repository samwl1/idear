# Connect Claude

Claude can read your workspaces and, if you allow it, add to them: notes, nested pages, and
project tasks. The connection is built into idear, so there's nothing extra to install.

Claude isn't given your account. It gets **its own identity**, and you give it access workspace
by workspace, the same way you'd add a person:

- **Only what you choose.** Workspaces you don't give Claude never reach it.
- **View or edit, per workspace.** A viewer can read but can't change anything, and your
  devices would refuse its changes even if it tried.
- **Everything it changes is signed and named.** Claude's changes appear in **Activity** as
  "Claude", from its own device.
- **One click to cut it off.** Set it back to **No access**, or remove it on the Sharing page.
- **Nothing can be deleted.** No tool deletes pages, tasks, or anything else. Replacing a note's
  text keeps the old text in the note's history.

Claude keeps its own copy of the workspaces it's in, and syncs with your app over the same
encrypted connections your devices use with each other. Nothing goes through a server you
don't control.

## Set it up

Open **Settings → Claude**.

1. **Connect.** For **Claude Desktop**, click **Connect**: idear adds itself to Claude Desktop's
   settings (keeping a backup of them). Quit Claude Desktop completely and open it again. For
   **Claude Code**, copy the command shown and run it once in a terminal.
2. **Choose what Claude can see.** For each workspace you own, pick **No access**, **Can view**,
   or **Can edit**. Start with **Can view**; you can change it any time.

The first time Claude connects (while idear is open), it picks up the workspaces you chose. Until
then they show "Waiting for Claude". Then ask something like "What's in my Team workspace?" or
"Add a task to Launch for the relay docs".

## What Claude can do

| Tool | What it does |
| --- | --- |
| `list_workspaces` | Workspaces Claude is in, and its role in each |
| `page_tree` | A workspace's folders and pages |
| `search` | Full-text search over notes, whiteboards, projects, and tasks |
| `read_page` | A note's markdown, a project's columns and tasks, or a whiteboard's text |
| `list_tasks` | Tasks filtered by project, status, assignee, or text |
| `create_page` | A new note, anywhere in the tree (editors only) |
| `update_page` | Add to a note, replace its text, or rename it (editors only) |
| `create_task` | A new task in a project (editors only) |
| `update_task` | Change a task's fields or move it to another column (editors only) |
| `sync_now` | Sync right away and report who was reached |

Claude can write with every macro the editor has: code blocks, panels, expands, child pages, and
tables of contents. It can't add images.

## How it works

Claude runs idear itself, as `idear mcp`: no window, just Claude's connection over stdio. That
process has Claude's own keys (in the system keychain, under `notes-app-claude`) and its own
data folder.

When you give Claude access, the app creates an invite for that role and leaves it in Claude's
inbox (a folder in Claude's data). Claude's connection picks it up and redeems it with your app
over live sync, exactly like a person pasting an invite link. That's why idear needs to be open,
and live sync on, the first time.

## Someone else's workspace

Only a workspace's owner can give Claude access. If someone shares a workspace with you and you
want your Claude in it, ask them to invite Claude from their Sharing page, then run:

```sh
idear mcp join 'notes-share-1.…'
```

using the full path to idear (shown under Settings → Claude). `idear mcp status` shows Claude's
identity, device ID, and workspaces.

## Using it in more than one place

One copy of Claude's connection can run at a time per data folder. To use Claude Desktop and
Claude Code at once, give one of them its own folder: it becomes a separate Claude, with its own
keys. The Claude settings page manages the default one; give the other access with an invite
link from the Sharing page and `IDEAR_CLAUDE_DIR` set when you run `idear mcp join`.

```sh
claude mcp add --transport stdio --scope user --env IDEAR_CLAUDE_DIR=$HOME/.idear-claude-code idear \
  -- /Applications/idear.app/Contents/MacOS/idear mcp
```

## If you run your own relay

If your relay has an allowlist, add Claude's device ID from `idear mcp status`. To have Claude
use your relay, run `idear mcp relay https://relay.example.com` (or `default`, or `local` for the
local network only).

## Prompt injection

Claude reads what people wrote, and text in a shared workspace could try to tell it what to do
("ignore your instructions and…"). Claude is told that workspace text is information, not
instructions, but no model is immune. To keep the damage small:

- Give Claude **Can view** unless you want it writing.
- Keep it out of workspaces where you don't trust everyone who can edit.
- Nothing can be deleted through these tools, and every change it makes is in **Activity**,
  attributed to Claude.

## Troubleshooting

- **Stuck on "Waiting for Claude":** Claude's connection only runs while Claude is open. Open
  Claude (Desktop or Code) with idear connected, keep idear open, and check that live sync is on
  under Settings → Devices.
- **"Connected to a different copy of idear":** you moved or reinstalled the app. Click
  **Update**, then restart Claude Desktop.
- **"Another copy of Claude's idear connection is already using …":** two Claude apps are
  running it at once. Close one, or give one its own folder (above).
- **Claude sees old content:** reads sync first when the last sync was more than 20 seconds ago,
  but your app has to be open on a device Claude can reach. `sync_now` reports who was reached.
- **Keychain prompts on macOS after updating idear:** choose **Always Allow**, as with the app.

## Where things live

- **Data:** `~/Library/Application Support/dev.sam.idear-claude` on macOS,
  `~/.local/share/dev.sam.idear-claude` on Linux, or `IDEAR_CLAUDE_DIR`.
- **Claude Desktop's settings:** `~/Library/Application Support/Claude/claude_desktop_config.json`
  on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows. idear only adds or removes
  its own `idear` entry, and saves the previous file as `claude_desktop_config.json.bak`.
- **Keys:** the system keychain, under the service `notes-app-claude`, separate from the app's.

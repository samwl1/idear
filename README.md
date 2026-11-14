<p align="center"><img src="docs/images/idear.png" width="128" alt="idear: a line-drawn deer with a lightbulb overhead"></p>

# idear

Notes, whiteboards, and project tracking for every idea you have. Local-first, desktop-only,
peer to peer, and signed end to end.

## What's in it

- **Workspaces**, each with its own color and icon, holding folders and pages. Any page can hold
  pages. Pin pages, views, and tasks to the top of the sidebar; pop any page out into its own
  window. Search everything with Cmd/Ctrl+K.
- **Notes**: a formatting toolbar, `/` for blocks (code with highlighting, images, tables,
  panels, expands, child pages, table of contents), an outline rail that follows your scroll,
  Tab to indent, markdown underneath.
- **Whiteboards** on Excalidraw.
- **Projects**: a board with columns you shape (to do, in progress with progress bars, done),
  a task list with filters, groups, and multi-select, archiving for done tasks, phases with
  planned windows and an active phase on the board, a roadmap (Gantt) you schedule by dragging,
  task checklists, per-task keys like `IDR-12`, batch creation with tokens (`Chapter #`,
  `+7 every 1w`), and Git: repositories on projects, branches on tasks.
- **References**: notes and whiteboards attach to projects, phases, tasks, and other pages.
- **Views**: saved filters over everything; a Notes Hub grid for writing summaries.
- **Your devices**, linked with a one-time code, sync peer to peer over iroh, end-to-end
  encrypted, through iroh's public relay or your own. Update files carry changes with no network.
- **Sharing** with people: owner, editor, and viewer roles per workspace, one-time invite links,
  and a signed audit trail of who changed what.
- **Claude, built in**: one click adds idear to Claude Desktop (or one command to Claude Code);
  Claude is its own signed member, allowed in per workspace.
- **Settings**: eleven themes, accent, text size, density, note font, width (narrow to full, with
  adjustable margins) and alignment, accessibility
  (contrast, readable font, underlined links, strong focus rings, reduced motion), and Help.

## Guides

Also in the app under **Settings → Help**.

- [Notes and whiteboards](docs/NOTES.md): pages, writing, blocks, references, views.
- [Projects and tasks](docs/PROJECTS.md): board, tasks, defaults and tokens, phases, roadmap, Git.
- [Sharing workspaces](docs/SHARING.md): roles, invites, removing people, how it's enforced.
- [Connect Claude](docs/CLAUDE.md): let Claude read, and optionally write, chosen workspaces.
- [Set up your own relay](docs/RELAY.md) on a Raspberry Pi or a small server.
- [How it works](docs/INTERNALS.md): code layout, identity, sync, update files, data on disk,
  known gaps.

## Install

Grab the latest build from [Releases](https://github.com/samwl1/idear/releases/latest):

- **macOS**: `idear_<version>_universal.dmg` (Apple Silicon and Intel). The build isn't notarized
  yet, so the first time, right-click the app and choose **Open**. If macOS says it's damaged, run
  `xattr -cr /Applications/idear.app` once.
- **Linux**: the `.AppImage` runs anywhere (`chmod +x` it first); `.deb` for Debian/Ubuntu, `.rpm`
  for Fedora. Needs a running Secret Service (GNOME Keyring or KWallet) for the keyring.
- **Windows**: not yet.

Releases are built by [GitHub Actions](.github/workflows/release.yml) when a `v*` tag is pushed:
bump the version in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`, then
`git tag v1.1.0 && git push origin v1.1.0`.

## Run it

Prerequisites:
- Node 20+ and Rust (stable) via rustup
- macOS: Xcode Command Line Tools (`xcode-select --install`)
- Linux (Debian/Ubuntu): `sudo apt install libwebkit2gtk-4.1-dev libdbus-1-dev build-essential libssl-dev librsvg2-dev`, plus a running Secret Service (GNOME Keyring or KWallet)

```sh
npm install
npm run tauri dev      # dev build with hot reload
npm run tauri build    # release bundle (.app/.dmg on macOS, .deb/AppImage on Linux)
cargo test -p notes-core -p notes-peer -p idear-mcp
```

Claude's connection is part of the app: `idear mcp` runs it (see [Connect Claude](docs/CLAUDE.md)).

On macOS, dev builds are re-signed on every rebuild, so Keychain may ask for access to the
device key after a rebuild. Choose "Always Allow".

The whiteboard's Excalidraw fonts are copied into `public/excalidraw/` by `npm run fonts`, which
runs before `dev` and `build`, so the app never fetches them from a CDN.

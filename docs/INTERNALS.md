# How it works

The technical side: where data lives, how devices trust each other, and what's still missing.
For using the app, see the other guides.

## Layout

```
crates/core/        Storage, index, event log. No Tauri dependency; fully unit tested.
  docs.rs           Automerge docs on disk, applies changes, reads fields for indexing
  index.rs          SQLite index (entities, tags, props, links, FTS5). Rebuildable.
  eventlog.rs       Append-only, per-device hash chain, Ed25519 signed, verifiable
  members.rs        Who has a workspace and their role: owner-signed records and invites
  identity.rs       User and device keys, certificates, revocations, address and box keys
  bundle.rs         Update files, sealed to your identity or to another person
  workspace.rs      Ties it together. Every write goes through here.
crates/peer/        Shared by the app and Claude's peer: keychain, identity, invite links, live sync
  sync.rs           Live sync and invite redemption over iroh
  removals.rs       Deleting workspaces: trash, restore, tombstones synced between your devices
  inbox.rs          Handing invites to Claude on the same computer
crates/mcp/         Claude's own peer, served over MCP (stdio); the app runs it as `idear mcp`.
                    hub.rs: extra copies relay through the first over a Unix socket
src-tauri/          Desktop shell: IPC commands
  share.rs          Invites, roles, joining
  claude.rs         Settings → Claude: access per workspace, Claude Desktop config
src/                React frontend
  whiteboard/       Storage schema, Excalidraw adapter, board component
  tracker/          Project model and ops, board, Tasks tab, phases, roadmap, task drawer
  lib/session.ts    Owns Automerge docs in the UI; every edit becomes one signed change
  components/       Workspace switcher, tree, note editor, activity log
```


## Identity and devices

- Each device has its own **device key** (signs that device's changes).
- Your **user key** is shared by your linked devices and signs a certificate for each one.
  Removing a device signs a revocation; its new changes are refused from then on.
- Both keys live only in the OS keychain. `identity.json` in the app data folder holds the
  public, signed records (your name, device certificates, revocations).
- **Link codes** carry a copy of the user key, encrypted with XChaCha20-Poly1305 under a key
  derived from the passphrase with Argon2id. The passphrase (about 80 bits) is shown on screen
  and never included in the code. Codes expire after 15 minutes by default; the picker on the Devices page allows up to 7 days, for linking a device you can't reach right away. The window only bounds how long a captured code and passphrase stay useful. Expiry is enforced by the app
  opening the code, so treat a code and its passphrase together like a password.
- **Linking either way.** A device that already has an account can still join another one. Its
  old account is folded into the new one with a **succession record** (`from`, `to`, time,
  signed by both keys) kept in the new identity's `predecessors`; devices left on the old
  account learn it as a `successors` entry and show a notice to link. Membership checks resolve
  each user key to the account it ended up in (`Members::canon`), so the old key's roles,
  ownership, and signed records keep counting. A workspace's `owner` field stays the original
  key; `current_owner()` follows the chain, and records are valid under any key in it.
  The joining device re-certifies the old account's devices under the new key, and from then on
  the old key adds nothing: a superseded identity takes no new certificates or addresses from
  anyone (only revocations), so whoever still holds that key can't put a device on the account
  with it. An account folds into another once; a succession that disagrees with one already
  known is ignored.


## Update files

`Settings → Devices → Update files` saves the selected workspaces to a `.idear` file and opens one
from another device.

- **For your devices:** sealed with XChaCha20-Poly1305 under a key derived (HKDF-SHA256) from
  your user key, so only your linked devices can read it.
- **For a person you share with:** sealed to their box key (X25519 with a fresh sender key per
  file), so only their devices can read it. Holds only workspaces you both have.
- **Under a passphrase** (either kind): sealed with XChaCha20-Poly1305 under an Argon2id key
  from a generated passphrase, for a device whose key you don't have yet. The app asks for the
  passphrase when it opens one. What's inside is still checked change by change, so the
  passphrase only controls who can read the file, never what counts.
- **Private docs** (pins) go only in files for your own devices.
- The header (format version and identities) is authenticated, in passphrase files too.
- On import, every event must verify, come from a device allowed to change that workspace at the
  time (see [Sharing](SHARING.md#how-it-works)), name this workspace (events carry the id of the
  workspace they were logged in as `ws` inside their signed data, so one can't be replayed into
  another; builds from before the check verify them all the same and just don't check, and
  events from before it have no name), and extend that device's history exactly.
  Every Automerge change must be vouched for by such an event about the same doc; changes that
  aren't, and anything built on them, are skipped and reported. A layout change that alters the
  workspace's name is only taken from a creation or rename event, which only the owner can log.
- Files carry whole workspaces, so they can be imported in any order, more than once, or after
  skipping one, without leaving gaps.


## Live sync

Each device runs an [iroh](https://iroh.computer) endpoint whose identity *is* its device key,
so the device on the other end of a connection is provably the one its key names. Devices sync
whenever two of them are online: every 30 seconds, and about 2 seconds after a local change.

- **Who's allowed:** your own devices (certified by your identity, not removed) sync everything.
  Other people's devices sync only the workspaces you both currently have; a device that shares
  nothing with you is dropped before learning anything. See [Sharing](SHARING.md). Anyone can
  sign a certificate for any public key, so a device may be certified under several members'
  identities; a change counts if *any* identity that certifies the device could make it, and a
  certificate from a viewer never takes rights away from the owner's device.
- **Opening a session:** the Intro each side sends carries membership records only for
  workspaces the other device is already known to be in, so a stranger learns nothing about
  which workspaces you have.
- **What's sent:** each side says what it has (each doc's heads, each device's latest event),
  and the other sends only what's missing. Imports go through the same verification as update
  files.
- **Finding each other:** devices publish a signed address record (relay URL and IP addresses)
  inside your identity records, which travel with syncs, update files, and link codes. mDNS
  finds devices on the same network. Nothing is published to iroh's DNS lookup service.
- **Relay:** by default one fixed relay, iroh's public NA East relay
  (`https://use1-1.relay.n0.iroh.link./`), so addresses stay stable. Change it under
  Settings → Devices → Live sync, or clear it to sync only on the local network. The relay forwards
  encrypted packets and sees which device IDs talk and how much; n0 describes its public relays
  as free and rate-limited, meant for development. To run your own, see
  [Set up your own relay](RELAY.md).
- **mDNS** advertises this device's endpoint ID on the local network.


## Data

Stored in the OS app data dir (`~/Library/Application Support/dev.sam.idear` on macOS,
`~/.local/share/dev.sam.idear` on Linux), one folder per workspace:

```
<workspace-id>/docs/*.am     Automerge docs (source of truth for content)
<workspace-id>/events.db     signed event log (source of truth for history)
<workspace-id>/index.sqlite  derived index, safe to delete
<workspace-id>/members.json  owner-signed membership, roles, and invites
identity.json                your public identity records
joins.json                   invites you're waiting to redeem
sync.json                    live sync settings
removed.json                 deleted and restored workspaces, synced between your devices
trash/<workspace-id>/        deleted workspaces, cleared after 30 days
```

Deleting a workspace moves its folder to `trash/` and records the deletion in `removed.json`.
Your other devices get that record at their next sync and move their copies to the trash too,
instead of sending the workspace back; restoring works the same way (the latest decision wins).
People you shared a workspace with keep their own copies. Appearance and accessibility settings
belong to each device and live in the app's local storage.


## Known gaps

- **Removing a device doesn't rotate your identity.** A removed device's own key is refused,
  but every linked device holds the user key, so a stolen device could certify a new key for
  itself. The way out today is linking: remove the lost device, then add a remaining device to a
  fresh account made on a clean one. The old account folds into the new one, and the old key
  can't add devices to it any more (see Linking either way). There's no one-step "rotate" yet.

- No encryption at rest yet (planned: SQLCipher plus encrypted doc files, key in keychain).
- A locked or missing keyring stops the app at launch with an error instead of a UI prompt.
- The Notes Hub column layout, pins, sidebar width, which sidebar sections are collapsed, and the
  Tasks tab's filters, sort, and scope, and whether a note's outline is folded, are saved on each
  device, not synced.
- Archiving a task sets `archived` (a timestamp) on it; the task keeps its column, so restoring
  puts it back where it was. Readers treat an archived task as done (the Rust index reports status
  "Archived", category done).
- Views are stored in the workspace, so everyone with it sees them; there are no private views yet.
- Assignees are free-text names. Workspace members are suggested, and `@me` matches your name.
- Task numbers are assigned locally, so two devices creating tasks offline can produce the same
  number; the plan is to renumber the later one on sync.
- Sharing has one owner per workspace and no ownership transfer, and removal relies on change
  timestamps from the editor's own clock. See [Sharing → Limits](SHARING.md#limits).
- Deleting a shared workspace only removes your copies. There's no "close for everyone" yet, and
  a member who deletes stays listed until the owner removes them.
- A deleted workspace's data stays on disk in the trash for 30 days; "Delete for good" erases it
  from that device only, and other devices clear theirs when it expires.
- Removing an image from a note leaves its data in the doc, since docs keep their full history.
  Notes with many large images grow accordingly.
- Note bodies merge at the markdown-text level, so edits made at the same time to the same
  passage can interleave oddly. A ProseMirror CRDT binding would merge the structure instead.

## Names

Internal names (crate names, keychain entries, the sync protocol, invite links) still say "notes"
so existing identities and links keep working. The logo is a line-drawn deer with a lightbulb
overhead; `scripts/make-logo.py` builds it from `scripts/deer.png` and writes every app icon.

# Sharing workspaces

Share a workspace with people you trust. There's no server in the middle: their devices and
yours sync directly whenever two of them are online, through the same encrypted connections your
own devices use.

## Roles

Roles apply to a whole workspace.

| Role | Can |
| --- | --- |
| **Owner** | Everything, plus invite people, change roles, and remove people. Whoever created the workspace. There's exactly one, and it can't be transferred. |
| **Editor** | Read and change everything in the workspace: notes, whiteboards, projects, folders, views, its color and icon. Not its name: renaming is the owner's alone, and a rename from anyone else is refused everywhere. |
| **Viewer** | Read everything, including the activity log. Filters in views work but aren't saved. |
| **Removed** | Keeps the copy they had, read-only. It stops syncing, and their changes from after removal are refused everywhere. |

## Invite someone

1. **Settings → Sharing**, and pick the workspace at the top. (From **Settings → Workspaces**,
   the people icon on a workspace goes straight there.)
2. Under **Invite someone**, enter who it's for, choose **Edit** or **View only**, and how long the
   link should work (an hour, a day, a week, or a month).
3. Leave **Ask me before they're added** on unless you trust the channel completely: when someone
   uses the link, you get to see who it is and approve or decline them. Tick **Protect with a
   passphrase** to get a link that's useless by itself: the passphrase is shown once, for you to
   read to them or send another way.
4. **Create invite link**, then **Copy invite link** and send it to them.

An invite link works once. Whoever uses it first gets in (or gets to ask), so treat it like a
password: send it over something private, and cancel it under **Invites** if it might have gone
astray. The label is just for you; it isn't checked.

The link is short, about 150 characters: your account key, which of your devices made it and
its relay, the invite id, when it expires, and the one-time secret. Nothing about the workspace,
not even its name; that comes from your device at the first contact.

When someone is waiting on you, a message points to **Waiting for your approval** on the Sharing
page, with their name and their full account fingerprint. The name is whatever they typed; the
fingerprint is theirs alone, so for anything that matters, read it back to them over a call.

## Join a workspace

1. **Settings → Workspaces → Join a shared workspace** (or on the start screen).
2. Paste the invite link, the passphrase if it has one, and **Join**.

Your device then tries to reach the device that made the link. The first time it does, the
owner's device checks the invite and either adds you, so the workspace arrives, or holds the
request for the owner to approve: **Waiting to join** then says so, and your device tries again
every so often until they decide. If the owner is offline, the join waits and retries in the
background while the app is open.

Before joining, know who it's from. Joining tells the owner, and everyone else in the workspace,
your name, your device IDs, and the network addresses your devices sync from.

## Syncing with people

Once you're in, your devices sync the workspace with every member's devices, not only the
owner's. If Alex and Val are both members, their edits reach each other even while the owner's
laptop is closed.

- Only workspaces you share with someone are ever sent to them. A device that shares nothing with
  you is turned away before learning anything.
- Every change is signed by the device that made it. Changes pass through whichever members'
  devices carry them, but they can't be altered or forged on the way, and a change from someone
  who wasn't an editor at the time is refused.
- **Settings → Sharing** shows each person and when your devices last synced with one of theirs.
- **Activity** shows who changed what, by person and device, including people being added,
  removed, or changing roles.

## Change a role or remove someone

On **Settings → Sharing**, the owner can switch anyone between **Editor** and **Viewer**, or remove them with
the trash button. A removed person can be restored as a viewer, then made an editor again.

Changes take effect on each device as the change reaches it, the next time that device syncs with
the owner or with someone who already has it.

Removing someone can't take back what they already have. Their copy stays on their devices as it
was at removal.

## Deleting a shared workspace

**Settings → Workspaces → Delete** moves a workspace to the trash on all of your devices, where
it can be restored for 30 days. It doesn't reach anyone else: people you shared it with keep
their copies. If you own it and they shouldn't keep working in it, remove them first. If it's
someone else's, you stay listed as a member until the owner removes you.

## Update files with people

Update files work between people too, for when you can't both be online.

1. **Settings → Devices → Update files → Send**, then choose the person under **For**. Only workspaces you
   share with them are listed.
2. **Save update file**, and get the file to them however you like.
3. They open it under **Settings → Devices → Update files → Receive**.

The file is encrypted so only that person's devices can open it, not even yours. Opening it runs
the same checks as live sync. You need to have synced with them at least once first, so your app
knows their encryption key.

## If you run your own relay

If your relay has an allowlist (see [Set up your own relay](RELAY.md)), add the device IDs of the
people you share with, or they can only reach you on the same network. They can copy their IDs
from **Settings → Devices**.

## How it works

- **Membership** is a list of records, each signed by the owner's identity key: "this person has
  this role, from this time". Every member's device checks the signatures, so a member can pass
  the list along but can't change it. It's kept per workspace in `members.json`, outside the
  synced content.
- **Invites** are owner-signed too, and store only a hash of the secret. Invites go to the owner's
  own devices only, never to other members.
- **Who someone is** comes from their identity: a user key that certifies each of their devices,
  the same records your own devices use. Connections are authenticated by device key, so a device
  can't pretend to be another.
- **Deciding whether a change counts:** the device that signed it must belong to someone who was
  an editor or the owner when the change was made, and the device must not have been removed
  from that person's identity before then.
- **Update files for a person** are sealed to their box key, an X25519 key derived from their
  user key and published, signed, in their identity. Each file uses a fresh sender key.
- **Pins** live in a private doc per member (`private-<user key>`), which syncs between that
  member's own devices only: other people's devices never receive it and refuse it if sent.
  Viewers can write theirs; `private.*` events are trusted from any member with access.

## Limits

- **One owner per workspace.** Ownership can't be handed over, and if the owner loses every
  device with the identity on it, nobody can change membership again. The workspace keeps syncing
  between the people already in it.
- **Roles are per workspace**, not per folder or item.
- **Removal isn't retroactive.** What someone had stays with them.
- **Change times come from the editor's own clock.** A removed editor running a modified app
  could stamp new changes with a time from before their removal, and they'd be accepted. After
  removing someone you don't trust, check **Activity** for changes from them that arrive later.
- **Editors are trusted with the content.** An editor can delete or rewrite anything. The
  activity log keeps who did it, and every earlier version stays in each doc's change history,
  though there's no screen for browsing old versions yet.
- **Linking folds accounts together.** Adding a device that already has workspaces to another
  account folds its old account into the new one: a succession record signed by both keys says
  "this account is now that one". Its workspaces, memberships, and history read as the new
  account's, and its other devices are told to link too. Succession can't be undone.
- **Update files aren't signed as a whole.** Every change inside is verified, but the "From" line
  shows the identity written in the file, which whoever made the file chose.
- **Views belong to the workspace**, so everyone sees the same saved views and only editors can
  change them.

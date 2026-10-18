# Notes and whiteboards

## Pages

Everything lives in the sidebar tree: folders, notes, whiteboards, and projects. Any page can
hold pages. Drag to rearrange; right-click or hover for the tools. Deleting a page or folder is
immediate, with Undo in the message that follows.

**Move to another workspace** (right-click a page or folder) carries it, everything inside it,
and its pins to the top level of a workspace you can edit. Links between the moved pages keep
working; links to pages that stayed behind are dropped. The other workspace's members see it as
a new page: its history starts there.

To fold a whole workspace into another, open **Settings → Workspaces**, edit the one to fold,
and choose **Merge into another workspace**. Its pages and saved views move over, then it goes
to the trash. If you own two workspaces with the same name (usual after adding a device that
already had workspaces to your account), that page offers the merge up top.

Every page has, under its title, **Tags:** and **References:**. References are the notes and
whiteboards attached to a page, and what a note or whiteboard is itself attached to (projects,
phases, tasks, other pages). Pick an existing item or type a name to start a new note already
attached.

The buttons by a page's title: **pin** it to the sidebar's Pinned section, **print or save it
as a PDF** (notes; the system print dialog does both, with only the note on the page), and
**pop out** the page into its own window. A popped-out window shows just that page; edits made
in any window show up in the others.

Pins follow your account: a pin made on one of your devices shows on the others, and never on
the devices of people you share with. Right-click a pin to keep it **on this device only**
instead; those show a small mark.

**Links to pages**: type `[[` in a note and pick a page, or use **Insert → Link to a page**. A
plain click opens it. The link follows the page, not its name, so renaming the page doesn't break
it (the link text stays as written). Linked pages show under References on both ends. In
markdown it's `[Title](page:<id>)`.

**Spell check** underlines misspellings as you type, in notes, tasks, and whiteboards; right-click
a word for suggestions. Code is never checked. Turn it off, or pick dictionaries on Linux, under
Settings → Appearance → Writing.

**Search** (Cmd/Ctrl+K) finds pages by title or text, tasks, saved views, and commands such as
new page, switch workspace, and settings.

## Writing

The toolbar at the top of a note has headings, bold, italic, underline, strike, text color,
highlight, lists, checklists, quotes, inline code, and links. Select text to use it; blocks come
from the Insert button or by typing `/`.

- **Tab** indents a list item under the one above (Shift+Tab lifts it); on a list's first item,
  which has nothing above it, Tab does nothing. In a code block it adds two spaces; anywhere
  else, a tab character.
- **Leaving a panel, expand, or code block:** Escape moves the cursor to the line below it
  (making one if the block is last). Enter on an empty last line inside a panel or expand does
  the same, as does ↓ at the very end of the block.
- **Moving blocks:** Alt+↑ and Alt+↓ (Option on a Mac) move the block the cursor is in past its
  neighbour: a paragraph, heading, list, panel, expand, code block, or table. Inserted blocks
  (panels, expands, code, images, contents, child pages) also show a ⋮⋮ grip at their left edge
  on hover; drag it to put the block anywhere in the note.
- **Moving blocks:** Alt+↑ and Alt+↓ (Option on a Mac) move the block the cursor is in past its
  neighbour: a paragraph, heading, list, panel, expand, code block, or table. Inserted blocks
  (panels, expands, code, images, contents, child pages) also show a ⋮⋮ grip at their left edge
  on hover; drag it to put the block anywhere in the note.
- **Links:** Cmd+click (Ctrl+click on Linux) opens a link in your browser; a plain click edits it.
  Only http, https, and mailto links leave the app.
- **Width:** Settings → Appearance → Note width. Narrow, Normal, and Wide cap the line length,
  and **Alignment** puts the note in the middle of the window or against its left edge; **Full**
  uses the whole window, with a Margins slider for the space on each side. Per device.
- **On this page:** once a note has a heading, its outline sits to the right of the text. The
  section you're reading is marked as you scroll; click a heading to jump to it. The arrow in its
  title folds it to a strip of ticks (one per heading, still clickable); the choice is remembered
  on this device. In windows narrower than about 1100px it folds on its own.

### Blocks

From `/` or Insert: code blocks with syntax highlighting, images (paste, drop, or upload), tables,
info/note/warning/success/error panels, expands, child pages, and a table of contents.

Notes are stored as markdown, and blocks are written in a readable form:

````
```rust                          code block with its language
![Diagram](att:<id>)             image stored in the note's doc
:::panel {type="warning"}        panel: info, note, warning, success, or error
Text inside.
:::
:::expand {title="Details"}      expand, closed until clicked
Hidden text.
:::
:::children {depth="1"} :::      child pages (depth "all" for every level)
:::toc :::                       table of contents
````

Colored and highlighted text, which markdown can't express, are small inline `<span>`/`<mark>`
tags; search ignores them. Tables hold one line of text per cell.

**Images** are stored inside the note's own doc (a task's images in its project's doc), so they
sync, travel in update files, and are signed with the text. Pasted, dropped, or uploaded images
must be PNG, JPEG, GIF, or WebP; anything over 2400 px or 1.5 MB is scaled down, and the limit
after that is 6 MB. Images from the web are never loaded: a shared note could otherwise use one
to learn when and from where you opened it.

## Whiteboards

Whiteboards use Excalidraw: shapes with labels, text, freehand, lines, and arrows that stay
attached. A shape's link icon opens its link (web links in your browser). The board's
**References:** line attaches it to projects, phases, tasks, and pages, like a note.

## Notes Hub and views

**Notes Hub**, in the sidebar's Views section, lists every note in a grid with movable,
resizable, sortable columns, and summaries written right in the grid.

A saved **view** is a filter over notes, whiteboards, projects, and tasks: by type, tag (with `*`),
text, status, assignee, key prefix (with `*`), and last updated. Views are stored in the
workspace, so everyone with it sees them.

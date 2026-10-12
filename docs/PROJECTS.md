# Projects and tasks

A project is a page with a board, a task list, phases, and a roadmap. Its tasks have keys like
`IDR-12`, a checklist, dates, tags, references, and Git branches.

Beside the project's title: a pin, a pop-out button (the page in its own window), and the
**Git** button for its repositories. Under it: tags and references (notes and whiteboards
attached to the project).

## Board

Columns hold tasks; drag a card anywhere into another column, including the empty space under
its last card. Columns scroll on their own, and dragging near a column's top or bottom edge
scrolls it. Drag a column header to reorder columns.

The bar above the columns shows how many tasks are done: those on the board plus any archived
ones (in the phase shown, or overall).

**Column modes.** The column's ⋯ menu sets its name, color, status dot, and what being in it
means:

- **To do**: nothing special; tasks here haven't started.
- **In progress**: each card shows its checklist progress, and the column header shows the
  average across its tasks.
- **Done**: tasks here count as done everywhere (the board total, phases, the roadmap, views).

**Backlog.** A task whose status is Backlog isn't on the board; it waits in the Tasks tab until
you move it into a column (from the Tasks tab's status cell or the task panel). New tasks start
there unless the defaults say otherwise.

**Clearing done tasks.** Done tasks pile up in their column until you archive them. Nothing is
automatic: right-click a card (or a row in the Tasks tab) and choose **Archive**, pick **Clear
done** in a done column's ⋯ menu to archive everything in it, or **Close phase** on the Phases tab
once every task in a phase is done. An archived task counts as done wherever it was, leaves the
board, and stays in the Tasks tab under Done with an Archived mark. Archiving a task that isn't
done marks it done. **Restore** (on the row, in the task panel, or Reopen on a closed phase) puts
it back in the column it came from. Every one of these offers Undo. Archiving doesn't take a task
out of its phase: the phase's progress still counts it as done.

**Active phase.** Once a project has phases, the board's Phase selector narrows it to one phase;
its other tasks stay in the Tasks tab. With a start and end set on the phase, a bar shows how far
through that window today is.

**Cards.** Hover a card for its tools: Git (when a branch is linked), pin, and delete. Right-click
for Open, Archive, and Delete. The task open in the panel has an accent border.

## Tasks

Click a card or row to open the task panel; the expand button makes it a full page. From the top:
the key (click it to move the task to another key series), Git branches, pin, and expand. Then
status, priority, assignee, start and due dates, phase, tags, and the sections below.

**Checklist.** Steps to tick off. Add items at the bottom, double-click one to rename it, tick it
when done. The task's progress is the share of items ticked; it shows on cards in In progress
columns, in the Tasks tab, and on the roadmap.

**Git.** Branches of the project's repositories (see [Git](#git)).

**References.** Notes and whiteboards attached to the task, and projects it points at. Pick an
existing one, or type a name to start a new note already attached.

**Description.** A full editor, the same as a note's.

**Dates.** Tasks start unscheduled. Setting either date schedules the task: the other date comes
on at the same day, ready to adjust.

**Keys.** Tasks are numbered per key prefix: `IDR-1`, `IDR-2`… A project can use several prefixes
at once; each counts on its own. For a single task in another series, start its title with the
key and a colon in an Add task box (`BUG: Crash on launch`), or click the key in the panel. A
project that hasn't picked a key uses `DEFAULT`.

**Deleting.** The trash button on a card or row asks once (it turns into a red **Delete?**) and
deletes on the second click; the panel has Delete task at the bottom. Deleting is immediate and
the message that follows offers Undo.

## Tasks tab

Every task in a sortable table: click a column header to sort. Search (title, key, tag, assignee)
and the filter selects (phase, status, priority, assignee, tag) narrow it; **Clear** resets them.
They're remembered per project on this device.

The pills under the filters pick which tasks you're looking at, with counts: **On board** (in a
column, done or not), **Backlog** (off the board), **Archived**, or **All**.

**Selecting.** Tick rows (shift-click for a range, the header checkbox for everything shown, or
Select all shown from the right-click menu) and a bar replaces the filters: move to a column, set
phase, priority, or assignee, add a tag, archive, or delete. Each applies to every selected task
in one step, so Undo undoes it all. Right-click a selected row for the same actions; Esc clears
the selection.

## Creating tasks

Three ways, all starting from the project's **task defaults**:

- **New task** (top right) creates one task from the defaults and opens it.
- **Add task** at the bottom of a phase (Phases tab) is an inline box: Enter adds and keeps the
  box open for the next one; Enter on an empty box uses the default name.
- **Defaults → Create** makes a batch: the number you set, or one per list item.

### Task defaults

Click **Defaults** next to New task:

| Field    | What it does                                                                     |
| -------- | -------------------------------------------------------------------------------- |
| Name     | The title. Takes tokens (below). Empty: tasks start untitled.                    |
| Key      | The key prefix, e.g. `IDR`.                                                      |
| Column   | Where the task lands: the **Backlog** (off the board, the default) or a column.  |
| Priority | None, low, medium, high, or urgent.                                              |
| Phase    | A phase by name. Takes tokens. A new name creates the phase.                     |
| Assignee | A name, or `@me`.                                                                |
| Due      | A due date rule (below). Empty: no due date.                                     |
| Tags     | Added to every new task. Each tag takes tokens.                                  |

The menu previews every task a Create would make. **Reset** clears everything; the key goes back
to `DEFAULT`. Defaults are kept per project on this device; they aren't synced.

### Tokens

Tokens are placeholders in the name, phase, or tags, filled in when a task is created.

**Counters**

| Token | Series                    | Example                              |
| ----- | ------------------------- | ------------------------------------ |
| `#`   | 1, 2, 3…                  | `Chapter #` → Chapter 1, Chapter 2   |
| `##`  | 01, 02, 03… (`###` → 001) | `Ep ## - edit` → Ep 01 - edit        |
| `@`   | A, B, C… then AA, AB      | `Part @` → Part A, Part B            |
| `%`   | I, II, III…               | `Act %` → Act I, Act II              |

A counter continues from the highest value already in the project, so after deleting Chapter 2
the next one is still Chapter 4. Add `=` to start elsewhere and `+` to step: `Week #=40`,
`Ep #+2` (1, 3, 5), `Part @=C`, `Act %=IV`, `#=10+5`. A counter has to stand on its own: `C#`
and `50%` stay as typed. Only the first counter in a name is a series.

Without a counter, repeats get a suffix: `Write chapter`, `Write chapter (2)`, `(3)`…

In the phase or a tag, a counter takes the title's value (or the task's position in the batch when
the title has none): name `Chapter #`, phase `Part @`, tag `ch-#` gives Chapter 3 in Part C
tagged `ch-3`.

**Batch position**

| Token  | Becomes                                |
| ------ | -------------------------------------- |
| `{i}`  | 1, 2, 3… within this Create only       |
| `{ii}` | 01, 02… (`{iii}` → 001)                |

**Dates**

| Token              | Becomes                                                |
| ------------------ | ------------------------------------------------------ |
| `{date}`           | Today, `2026-10-09`                                    |
| `{date+7}`         | A week from today. `{date-1}` is yesterday.            |
| `{date:ddd D MMM}` | Formatted: `Fri 9 Oct`. Offsets too: `{date+7:MMM D}`. |
| `{week}`           | ISO week number. `{week+1}` is next week's.            |
| `{day}`            | Weekday name. `{day+1}` is tomorrow's.                 |
| `{month}` `{year}` | `October`, `2026`.                                     |

Format letters: `YYYY` `YY`, `MMMM` `MMM` `MM` `M`, `DD` `D`, `dddd` `ddd`.

**Project**

| Token       | Becomes                                      |
| ----------- | -------------------------------------------- |
| `{project}` | The project's title                          |
| `{phase}`   | The default phase, with its tokens filled in |
| `{key}`     | The key this task will get, e.g. `IDR-42`    |

**Lists.** `{a,b,c}` makes one task per item; the count box is ignored. `Review {ch1,ch2,ch3}`
gives three tasks. Two lists multiply (`Test {app,cli} on {macOS,Linux}` makes four, the last
list varying fastest). Name a list to reuse its value: name `Test on {os=macOS,Linux}` with tag
`{os}`. Lists and counters mix: `Chapter # {outline,draft,edit}`.

**Due dates.** The Due field takes a date, a date token, or an offset from today, plus an optional
gap that spaces a batch out:

| Due                   | Tasks get                                                   |
| --------------------- | ----------------------------------------------------------- |
| `2026-10-17`          | That date                                                   |
| `{date+7}` or `+7`    | A week from today. `+2w` two weeks, `+1m` a month.          |
| `+7 every 1w`         | The first a week out, the next a week later, and so on      |
| `every 2w`            | The first today, then two weeks apart                       |
| `2026-01-31 every 1m` | Jan 31, Feb 28, Mar 31… (month steps keep the day of month) |

`{something}` that isn't a token is kept as typed, so `Fix {bug}` is safe.

## Phases

The Phases tab lists phases in order with their tasks. Rename a phase by double-clicking it, set
its planned start and end next to the progress bar, reorder with the arrows, and drag tasks
between phases. The trash button asks once (**Delete?**); the tasks stay, without a phase. The
note icon holds the phase's references.

Archived tasks stay listed in their phase, greyed with an Archived mark, and still count in its
progress. **Close phase** archives every task in the phase once they're all done; the phase then
reads "closed" next to its progress, and **Reopen** brings them back.

## Roadmap

The Roadmap tab draws every dated task on a timeline.

- A task runs from its **start** to its **due** date. With only a due date it's drawn on that
  day; with only a start it runs to today (or just that day, once done). Tasks with neither are
  listed under the chart.
- **Group by** phase, task, tag, or person. A group row fills by how many of its tasks are done;
  click it to see them. A phase with a planned start and end is drawn as exactly that window;
  any other group spans its tasks.
- A task bar fills by its checklist or, with none, by its state: empty for to do, the time gone by
  for in progress, full for done. A red edge means overdue. Click a bar to open the task.
- **Scheduling by drag.** Drag a task from the "without dates" list onto the chart to give it a
  week starting on the day you drop it. Drag a bar sideways to move it, keeping its length; drag
  either edge to change its start or end. Drag a phase's bar to move every dated task in it
  together (its start and end move too), or drag its edges to change its planned window.
- **Phase bounds.** A task in a phase with a planned window stays inside it: dates typed in the
  task panel, dropped on the chart, or dragged are held within the phase, and shrinking a phase
  pulls its tasks in.
- **Days**, **Weeks**, and **Months** change the scale; a frame shorter than the window stretches
  to fill it. **Today** scrolls back to the red line. **Key** and **Priority** narrow the chart.
- The **time frame** starts one unit before the earliest task and ends one unit after the latest.
  Set **From** and **To** to look at a slice; the frame moves in whole weeks (Monday to Sunday) or
  whole months on those scales. Tasks outside it are listed under the chart; **Auto** restores the
  default.

## Git

A project links to its repositories; a task links to branches of them. The Git button (branch
icon) sits beside the project's title, in the task panel header, and on cards and task rows
that have a branch.

- **Grey**: nothing linked. Click to add.
- **Filled**: linked and ready. One link opens on click; several open a list. Right-click (or
  ⌥-click) always shows the list, where you add, edit, or remove.
- **Outlined**: a local repository that hasn't been found on this device yet.

**Repositories (project).** Paste a link to a repository on GitHub, GitLab, Bitbucket, or
Codeberg, or choose a folder on this computer. For a folder, the app notes its name and git
remote and remembers where it is on this device.

**Branches (task).** Pick one of the project's repositories and type the branch name. The box
suggests the repository's branches and says whether the name exists: a local repository is read
directly; a hosted one is asked with `git ls-remote` using your own git credentials (needs git
and network; otherwise it says it couldn't check). A name that doesn't exist yet can still be
added. A hosted branch opens its page; a local one opens the folder.

**Folders on other devices.** The repository syncs; the folder path doesn't. On another device
the list shows where it was added (`Linked on Desktop as /Users/sam/code/idear`) with **Find it
on this device** (a folder picker) or **Use the same path** when that path exists there. A folder
whose git remote differs from the one linked is accepted with a warning. Paths never leave the
device.

**Opening folders.** Settings → Preferences → Linked folders sets the app that opens them (the
file manager, or an editor by name).

## Older projects

Subtasks from earlier versions are folded into their parent's checklist the first time the
project is opened for editing (ticked if they were done, with any description appended to the
parent's).

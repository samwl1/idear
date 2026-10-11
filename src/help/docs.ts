// Every README in the repo, bundled into the app so Help works offline and
// always matches the installed version.
import readme from "../../README.md?raw";
import relay from "../../docs/RELAY.md?raw";
import sharing from "../../docs/SHARING.md?raw";
import claude from "../../docs/CLAUDE.md?raw";
import projects from "../../docs/PROJECTS.md?raw";
import notes from "../../docs/NOTES.md?raw";
import internals from "../../docs/INTERNALS.md?raw";

export interface HelpDoc {
  id: string;
  title: string;
  /** Path in the repo, used to resolve links between docs. */
  file: string;
  body: string;
}

export const HELP_DOCS: HelpDoc[] = [
  {
    id: "readme",
    title: "About idear",
    file: "README.md",
    // The README's logo path is for GitHub; in the app it's served from public/.
    body: readme.replace('src="docs/images/idear.png"', 'src="/idear.png"'),
  },
  { id: "notes", title: "Notes and whiteboards", file: "docs/NOTES.md", body: notes },
  { id: "tasks", title: "Projects and tasks", file: "docs/PROJECTS.md", body: projects },
  { id: "sharing", title: "Sharing workspaces", file: "docs/SHARING.md", body: sharing },
  { id: "claude", title: "Connect Claude", file: "docs/CLAUDE.md", body: claude },
  { id: "relay", title: "Set up your own relay", file: "docs/RELAY.md", body: relay },
  { id: "internals", title: "How it works", file: "docs/INTERNALS.md", body: internals },
];

/** The doc a relative link like `docs/RELAY.md#ports` or `../README.md` points at. */
export function docForHref(href: string): { doc: HelpDoc; anchor: string | null } | null {
  const [path, anchor] = href.split("#");
  const base = path.split("/").pop()?.toLowerCase();
  if (!base?.endsWith(".md")) return null;
  const doc = HELP_DOCS.find((d) => d.file.split("/").pop()?.toLowerCase() === base);
  return doc ? { doc, anchor: anchor ?? null } : null;
}

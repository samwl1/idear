// Tokens in task defaults. A default name like "Chapter #" or "Test {app} on
// {macOS,Linux}" expands to one or more task titles; tags and the phase name
// take the same tokens. docs/PROJECTS.md is the user-facing reference.
//
//   #  ##  ###        series number, padded to that width; continues from the
//                     highest one already used. #=5 starts at 5, #+2 steps by 2.
//   @                 series letter: A, B, C… (@=C starts at C)
//   %                 series roman numeral: I, II, III… (%=IV starts at IV)
//   {i} {ii}          position within this batch, 1..N
//   {date} {date+7} {date:Mon D}   today (or offset), ISO or formatted
//   {week} {week+1}   ISO week number
//   {day} {month} {year}
//   {project} {phase} {key}
//   due: 2026-10-17 | {date+7} | +7 | +2w, then "every 7d" / "1w" / "1m" to
//        space a batch out (the second task a week after the first, and so on).
//   {a,b,c}           a list: one task per item. {os=a,b,c} names it; {os} reuses it.
//                     Several lists multiply (every combination).
//
// Counters (#, @, %) and (n) suffixes are worked out against existing titles,
// so numbering never collides with what's already on the board.

export interface Template {
  name: string;
  tags: string[];
  phase: string;
  /**
   * Due date: a date ("2026-10-17"), a date token ("{date+7}"), or an offset
   * from today ("+7", "+2w"), optionally spaced out across a batch with
   * "every 7d" / "every 1w" / "every 1m". Empty: no due date.
   */
  due?: string;
}

export interface TokenContext {
  project: string;
  /** The key prefix new tasks get, e.g. "IDR". */
  prefix: string;
  /** The number the next task with that prefix will get. */
  nextNumber: number;
  /** Titles already in the project. */
  taken: string[];
  today?: Date;
}

export interface Expanded {
  title: string;
  tags: string[];
  phase: string;
  /** YYYY-MM-DD, or "" for none. */
  due: string;
}

// ---- lists -------------------------------------------------------------------------

/** `{a,b,c}` or `{name=a,b,c}` or a reference `{name}` to a list named earlier. */
const LIST = /\{(?:([A-Za-z_][\w-]*)=)?([^{}]*,[^{}]*)\}/g;

interface Lists {
  /** Variable name → values. Anonymous lists are keyed by their exact text. */
  vars: Map<string, string[]>;
}

function collectLists(strings: string[]): Lists {
  const vars = new Map<string, string[]>();
  for (const s of strings) {
    for (const m of s.matchAll(LIST)) {
      const name = m[1] ?? m[0];
      const values = m[2].split(",").map((v) => v.trim()).filter(Boolean);
      if (values.length && !vars.has(name)) vars.set(name, values);
    }
  }
  return { vars };
}

/** Every combination of list values, in order: the last list varies fastest. */
function combinations(lists: Lists): Record<string, string>[] {
  let out: Record<string, string>[] = [{}];
  for (const [name, values] of lists.vars) {
    const next: Record<string, string>[] = [];
    for (const row of out) for (const v of values) next.push({ ...row, [name]: v });
    out = next;
  }
  return out;
}

// ---- dates -------------------------------------------------------------------------

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad = (n: number, w: number) => String(n).padStart(w, "0");

function shift(d: Date, days: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}

/** ISO 8601 week number (weeks start Monday; week 1 holds January 4th). */
function isoWeek(d: Date): number {
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = x.getUTCDay() || 7;
  x.setUTCDate(x.getUTCDate() + 4 - day);
  const jan1 = new Date(Date.UTC(x.getUTCFullYear(), 0, 1));
  return Math.ceil(((x.getTime() - jan1.getTime()) / 86400000 + 1) / 7);
}

/** Formats like "YYYY-MM-DD", "ddd D MMM", "MMMM YYYY". Longest tokens first. */
function formatDate(d: Date, fmt: string): string {
  return fmt.replace(/YYYY|YY|MMMM|MMM|MM|M|dddd|ddd|DD|D/g, (t) => {
    switch (t) {
      case "YYYY": return String(d.getFullYear());
      case "YY": return pad(d.getFullYear() % 100, 2);
      case "MMMM": return MONTHS[d.getMonth()];
      case "MMM": return MONTHS[d.getMonth()].slice(0, 3);
      case "MM": return pad(d.getMonth() + 1, 2);
      case "M": return String(d.getMonth() + 1);
      case "dddd": return DAYS[d.getDay()];
      case "ddd": return DAYS[d.getDay()].slice(0, 3);
      case "DD": return pad(d.getDate(), 2);
      case "D": return String(d.getDate());
    }
    return t;
  });
}

// ---- due dates ---------------------------------------------------------------------

type Unit = "d" | "w" | "m";

/** "+7", "+2w", "every 1m" → a count and unit. Days when no unit is given. */
const SPAN = /^([+-]?\d+)\s*(d|w|m|days?|weeks?|months?)?$/i;

function parseSpan(s: string): { n: number; unit: Unit } | null {
  const m = SPAN.exec(s.trim());
  if (!m) return null;
  const u = (m[2] ?? "d")[0].toLowerCase() as Unit;
  return { n: Number(m[1]), unit: u };
}

function addSpan(d: Date, n: number, unit: Unit): Date {
  const x = new Date(d);
  if (unit === "m") {
    const day = x.getDate();
    x.setDate(1);
    x.setMonth(x.getMonth() + n);
    // Clamp to the month's length so Jan 31 + 1 month is Feb 28, not Mar 3.
    const last = new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate();
    x.setDate(Math.min(day, last));
  } else x.setDate(x.getDate() + n * (unit === "w" ? 7 : 1));
  return x;
}

export interface DueRule {
  /** The first task's date, or "" for none. */
  base: string;
  /** Gap between consecutive tasks in a batch. */
  every: { n: number; unit: Unit } | null;
  /** Set when the text couldn't be read as a date. */
  invalid?: boolean;
}

/**
 * Read a due template. The base can be an ISO date, a {date} token, or an
 * offset like "+7" / "+2w"; "every 7d" (or 1w, 1m) spaces the batch out. An
 * "every" with no base starts today.
 */
export function parseDue(s: string, ctx: TokenContext): DueRule {
  const text = s.trim();
  if (!text) return { base: "", every: null };
  const today = ctx.today ?? new Date();
  const m = /^(.*?)\s*(?:\bevery\s+(.+))?$/i.exec(text)!;
  const baseText = m[1].trim();
  let every: DueRule["every"] = null;
  if (m[2] !== undefined) {
    every = parseSpan(m[2]);
    if (!every || every.n <= 0) return { base: "", every: null, invalid: true };
  }
  let base: string;
  if (!baseText) base = formatDate(today, "YYYY-MM-DD");
  else {
    const span = parseSpan(baseText);
    if (span) base = formatDate(addSpan(today, span.n, span.unit), "YYYY-MM-DD");
    else base = fillTokens(baseText, ctx, { i: 1, vars: {}, number: ctx.nextNumber }, "").trim();
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(base) || Number.isNaN(new Date(`${base}T00:00:00`).getTime())) {
    return { base: "", every, invalid: true };
  }
  return { base, every };
}

/** The due date for the task at batch position `i` (1-based). */
function dueAt(rule: DueRule, i: number): string {
  if (!rule.base) return "";
  if (!rule.every || i <= 1) return rule.base;
  return formatDate(addSpan(new Date(`${rule.base}T00:00:00`), rule.every.n * (i - 1), rule.every.unit), "YYYY-MM-DD");
}

// ---- counters ----------------------------------------------------------------------

/** 1 → A, 26 → Z, 27 → AA. */
export function toLetters(n: number): string {
  let s = "";
  for (let x = Math.max(1, n); x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

export function fromLetters(s: string): number {
  let n = 0;
  for (const c of s.toUpperCase()) n = n * 26 + (c.charCodeAt(0) - 64);
  return n;
}

const ROMAN: [number, string][] = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];

export function toRoman(n: number): string {
  let x = Math.max(1, Math.min(3999, n));
  let s = "";
  for (const [v, r] of ROMAN) while (x >= v) { s += r; x -= v; }
  return s;
}

export function fromRoman(s: string): number {
  const val: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let n = 0;
  const u = s.toUpperCase();
  for (let i = 0; i < u.length; i++) {
    const a = val[u[i]] ?? 0;
    const b = val[u[i + 1]] ?? 0;
    n += a < b ? -a : a;
  }
  return n;
}

type CounterKind = "number" | "letter" | "roman";

interface Counter {
  kind: CounterKind;
  index: number;
  length: number;
  width: number;
  start: number;
  step: number;
}

// A counter stands alone: not glued to letters or digits on either side (so
// "C#" or "50%" in a name stay literal). "=" and "+" set start and step.
const COUNTER = /(?<![A-Za-z0-9])(#+|@|%)(?:=([A-Za-z0-9]+))?(?:\+(\d+))?(?![A-Za-z0-9])/;

function findCounter(s: string): Counter | null {
  const m = COUNTER.exec(s);
  if (!m) return null;
  const sym = m[1];
  const kind: CounterKind = sym[0] === "#" ? "number" : sym === "@" ? "letter" : "roman";
  let start = 1;
  if (m[2]) {
    if (kind === "number") start = Number(m[2]) || 1;
    else if (kind === "letter") start = fromLetters(m[2]) || 1;
    else start = fromRoman(m[2]) || 1;
  }
  return { kind, index: m.index, length: m[0].length, width: kind === "number" ? sym.length : 1, start, step: m[3] ? Number(m[3]) || 1 : 1 };
}

function render(c: Counter, n: number): string {
  return c.kind === "number" ? pad(n, c.width) : c.kind === "letter" ? toLetters(n) : toRoman(n);
}

function parse(c: Counter, s: string): number {
  return c.kind === "number" ? Number(s) : c.kind === "letter" ? fromLetters(s) : fromRoman(s);
}

const ESC = /[.*+?^${}()|[\]\\]/g;

/**
 * The next free title for `shape` (everything but the counter already filled in).
 * Returns the title and the counter value used, so tags and the phase can echo it.
 */
function nextInSeries(shape: string, taken: string[]): { title: string; n: number | null } {
  const c = findCounter(shape);
  if (!c) {
    // No counter: the plain name, then "(2)", "(3)"… The plain name counts as 1.
    const re = new RegExp(`^${shape.replace(ESC, "\\$&")}(?: \\((\\d+)\\))?$`, "i");
    let max = 0;
    for (const t of taken) {
      const m = re.exec(t.trim());
      if (m) max = Math.max(max, m[1] ? Number(m[1]) : 1);
    }
    return { title: max === 0 ? shape : `${shape} (${max + 1})`, n: null };
  }
  const before = shape.slice(0, c.index);
  const after = shape.slice(c.index + c.length);
  const cls = c.kind === "number" ? "(\\d+)" : c.kind === "letter" ? "([A-Za-z]+)" : "([IVXLCDMivxlcdm]+)";
  const re = new RegExp(`^${before.replace(ESC, "\\$&")}${cls}${after.replace(ESC, "\\$&")}$`, "i");
  let max: number | null = null;
  for (const t of taken) {
    const m = re.exec(t.trim());
    if (m) {
      const v = parse(c, m[1]);
      if (Number.isFinite(v)) max = max === null ? v : Math.max(max, v);
    }
  }
  const n = max === null || max + c.step < c.start ? c.start : max + c.step;
  return { title: `${before}${render(c, n)}${after}`, n };
}

/** A counter in a tag or phase takes the number the title got (or the batch position). */
function fillCounter(s: string, n: number): string {
  const c = findCounter(s);
  if (!c) return s;
  return s.slice(0, c.index) + render(c, n) + s.slice(c.index + c.length);
}

// ---- expansion ---------------------------------------------------------------------

interface Per {
  i: number; // 1-based position in the batch
  vars: Record<string, string>;
  number: number; // key number this task will get
}

/** Everything except counters and (n) suffixes. */
function fillTokens(s: string, ctx: TokenContext, per: Per, phaseName: string): string {
  const today = ctx.today ?? new Date();
  let out = s.replace(LIST, (m, name: string | undefined) => per.vars[name ?? m] ?? "");
  out = out.replace(/\{([^{}]*)\}/g, (whole, inner: string) => {
    const body = inner.trim();
    const v = per.vars[body];
    if (v !== undefined) return v;
    // {i} {ii} {iii}: batch position, padded to the number of i's
    if (/^i+$/.test(body)) return pad(per.i, body.length);
    // {date}, {date+7}, {date-1}, {date:ddd D MMM}, {date+7:YYYY-MM-DD}
    let m = /^date(?:([+-]\d+))?(?::(.+))?$/.exec(body);
    if (m) {
      const d = shift(today, m[1] ? Number(m[1]) : 0);
      return m[2] ? formatDate(d, m[2]) : formatDate(d, "YYYY-MM-DD");
    }
    m = /^week(?:([+-]\d+))?$/.exec(body);
    if (m) return String(isoWeek(shift(today, m[1] ? Number(m[1]) * 7 : 0)));
    m = /^(day|month|year)(?:([+-]\d+))?$/.exec(body);
    if (m) {
      const d = shift(today, m[2] ? Number(m[2]) : 0);
      return m[1] === "day" ? DAYS[d.getDay()] : m[1] === "month" ? MONTHS[d.getMonth()] : String(d.getFullYear());
    }
    if (body === "project") return ctx.project;
    if (body === "phase") return phaseName;
    if (body === "key") return `${ctx.prefix}-${per.number}`;
    return whole; // unknown: left as typed
  });
  return out;
}

/** How many tasks the template makes with Create N: the list product, or N. */
export function batchSize(t: Template, count: number): number {
  const combos = combinations(collectLists([t.name, ...t.tags, t.phase]));
  const hasLists = combos.length > 1 || combos[0] && Object.keys(combos[0]).length > 0;
  return hasLists ? combos.length : Math.max(1, count);
}

/**
 * Expand the defaults into `count` tasks (or one per list combination when the
 * template has lists). Each result knows about the ones before it, so series
 * stay in order within the batch.
 */
export function expand(t: Template, ctx: TokenContext, count: number): Expanded[] {
  const lists = collectLists([t.name, ...t.tags, t.phase]);
  const combos = combinations(lists);
  const hasLists = lists.vars.size > 0;
  const n = hasLists ? combos.length : Math.max(1, count);
  const taken = [...ctx.taken];
  const due = parseDue(t.due ?? "", ctx);
  const out: Expanded[] = [];
  for (let i = 0; i < n; i++) {
    const per: Per = { i: i + 1, vars: hasLists ? combos[i] : {}, number: ctx.nextNumber + i };
    // The phase first, so {phase} in the name can refer to it. A counter in the
    // phase follows the title's series when the title has one, else the batch position.
    const phaseShape = fillTokens(t.phase, ctx, per, "");
    const nameShape = fillTokens(t.name, ctx, per, fillCounter(phaseShape, per.i).trim()).trim();
    let title = "";
    let seriesN: number | null = null;
    if (nameShape) {
      const r = nextInSeries(nameShape, taken);
      title = r.title;
      seriesN = r.n;
      taken.push(title);
    }
    const counterN = seriesN ?? per.i;
    const phase = fillCounter(phaseShape, counterN).trim();
    const tags = t.tags
      .map((tag) => fillCounter(fillTokens(tag, ctx, per, phase), counterN).trim().toLowerCase())
      .filter(Boolean);
    out.push({ title, tags: [...new Set(tags)], phase, due: dueAt(due, per.i) });
  }
  return out;
}

/** Whether a string carries any token at all (for hints and previews). */
export function hasTokens(s: string): boolean {
  return COUNTER.test(s) || /\{[^{}]+\}/.test(s);
}

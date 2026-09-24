/**
 * Independent, non-LLM policy check (AGENTS.md sections 3, 7, 11). Every tool call from every
 * subagent is classified here BEFORE it runs. Inputs are only:
 *   - the literal tool args (never `intent`, never the model's reasoning text), and
 *   - facts the executor observed from the OS/DOM itself (the focused element, the element
 *     under a click point, a browser_type target's attributes) — observations, not claims.
 * When in doubt the verdict is "block-until-approved": a false alarm costs one click on
 * Approve, a false pass can't be undone.
 */

export type RiskCategory = "file-delete" | "credential-entry" | "payment" | "network-egress" | "mass-modify";
export type RiskVerdictKind = "block-until-approved" | "allow";

/** The AGENTS.md section 7 rule shape: a pattern over literal args → category + verdict. */
export interface RiskRule {
  id: string;
  tools: string[] | "*";
  /** Which literal arg (or observed-context field) the pattern is matched against. */
  field: string;
  pattern: RegExp;
  category: RiskCategory | null;
  verdict: RiskVerdictKind;
  reason: string;
}

export interface ObservedElement {
  name?: string;
  control_type?: string;
  is_password?: boolean;
}

export interface ObservedDomElement {
  tag?: string;
  text?: string;
  attributes?: Record<string, string>;
}

/** Facts the executor looked up from the OS/DOM right before classification. */
export interface ClassifierContext {
  focusedElement?: ObservedElement;
  elementAtPoint?: ObservedElement;
  domTarget?: ObservedDomElement;
}

export interface RiskAssessment {
  verdict: RiskVerdictKind;
  /** Most severe matched category, or null when blocked only for being unrecognized. */
  category: RiskCategory | null;
  categories: RiskCategory[];
  reasons: string[];
  matchedRules: string[];
}

// --- PowerShell -------------------------------------------------------------------------

// Commands whose every use is read-only. A command only runs without approval when EVERY
// segment of it starts with one of these (and none of the forbidden constructs below appear).
const READ_ONLY_COMMANDS = new Set(
  [
    // navigation / listing / reading
    "get-childitem", "gci", "dir", "ls", "get-item", "gi", "get-content", "gc", "cat", "type",
    "get-location", "gl", "pwd", "test-path", "resolve-path", "rvpa", "join-path", "split-path",
    "get-itemproperty", "gp", "get-acl", "get-filehash",
    // filtering / shaping output
    "select-object", "select", "where-object", "where", "?", "sort-object", "sort", "measure-object",
    "measure", "group-object", "group", "compare-object", "select-string", "sls", "format-table", "ft",
    "format-list", "fl", "format-wide", "fw", "out-string", "convertto-json", "convertfrom-json",
    "convertto-csv", "convertfrom-csv", "write-output", "echo", "write-host",
    // system / process / environment inspection
    "get-process", "gps", "ps", "get-service", "gsv", "get-date", "get-command", "gcm", "get-help",
    "get-host", "get-culture", "get-uiculture", "get-timezone", "get-computerinfo", "get-ciminstance",
    "get-wmiobject", "gwmi", "get-psdrive", "gdr", "get-volume", "get-disk", "get-netadapter",
    "get-netipaddress", "get-printer", "get-package", "get-hotfix", "get-eventlog", "get-winevent",
    "get-clipboard", "get-variable", "gv", "get-alias", "gal", "get-member", "gm", "get-history", "h",
    "whoami", "hostname", "systeminfo", "ver", "where.exe", "tasklist",
  ],
);

/**
 * Command-name matcher. PowerShell names contain hyphens and `\b` treats "-" as a boundary, so
 * a plain `\bformat\b` would fire on Format-Table. Here a name must not touch a word char or
 * hyphen on either side.
 */
function commands(...names: string[]): RegExp {
  return new RegExp(`(?<![\\w-])(?:${names.join("|")})(?![\\w-])`, "i");
}

// A statement boundary: start of text, or right after ; | { ( or a newline.
const STATEMENT_START = String.raw`(?:^|[;|{(\n])\s*`;

// Constructs that can execute or write things no matter which command they sit next to.
const FORBIDDEN_CONSTRUCTS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /(^|[^-])>{1,2}/, reason: "output redirection writes to a file" },
  { pattern: /\$\(/, reason: "subexpression $(…) can run arbitrary commands" },
  { pattern: commands("invoke-expression", "iex"), reason: "Invoke-Expression runs arbitrary code" },
  { pattern: /-e(nc|ncodedcommand)?\s+[A-Za-z0-9+/=]{16,}/i, reason: "encoded command hides what will run" },
  { pattern: /\.[A-Za-z_]\w*\s*\(/, reason: "method call on an object can have side effects" },
  { pattern: new RegExp(`${STATEMENT_START}&(?!&)\\s*\\S`), reason: "call operator & runs a script or program" },
  { pattern: new RegExp(`${STATEMENT_START}\\.\\s+\\S`), reason: "dot-sourcing runs a script in this session" },
  { pattern: /-verb\s+runas/i, reason: "requests elevation" },
  { pattern: /`/, reason: "backtick escapes can obscure commands" },
];

const POWERSHELL_RULES: RiskRule[] = [
  {
    id: "ps.file-delete",
    tools: ["run_powershell"],
    field: "command",
    pattern: commands("remove-\\w+", "ri", "rm", "rmdir", "rd", "del", "erase", "clear-content", "clc", "clear-item", "cli", "clear-recyclebin"),
    category: "file-delete",
    verdict: "block-until-approved",
    reason: "deletes files, data, or objects",
  },
  {
    id: "ps.network-egress",
    tools: ["run_powershell"],
    field: "command",
    pattern: new RegExp(
      [
        commands(
          "invoke-webrequest", "iwr", "invoke-restmethod", "irm", "curl(\\.exe)?", "wget", "start-bitstransfer",
          "send-mailmessage", "test-netconnection", "tnc", "test-connection", "ftp", "scp", "ssh", "sftp",
          "bitsadmin", "certutil", "net\\s+use",
        ).source,
        String.raw`\bsystem\.net\.`,
        String.raw`new-object\s+(system\.)?net\.`,
      ].join("|"),
      "i",
    ),
    category: "network-egress",
    verdict: "block-until-approved",
    reason: "sends data over the network",
  },
  {
    id: "ps.credential",
    tools: ["run_powershell"],
    field: "command",
    pattern: commands("get-credential", "convertto-securestring", "convertfrom-securestring", "cmdkey", "vaultcmd", "export-pfxcertificate"),
    category: "credential-entry",
    verdict: "block-until-approved",
    reason: "handles credentials",
  },
  {
    id: "ps.mass-modify",
    tools: ["run_powershell"],
    field: "command",
    pattern: commands(
      "stop-process", "spps", "kill", "taskkill", "stop-service", "spsv", "restart-service", "set-service",
      "restart-computer", "stop-computer", "shutdown", "logoff", "format-volume", "format(\\.com)?", "diskpart",
      "clear-disk", "initialize-disk", "set-executionpolicy", "bcdedit", "reg(\\.exe)?\\s+(add|delete|import|load|restore)",
      "set-itemproperty", "sp", "new-itemproperty", "rename-itemproperty", "sc(\\.exe)?\\s+(delete|config|create|stop)",
      "schtasks", "netsh", "set-mppreference", "disable-\\w+", "enable-\\w+", "uninstall-\\w+", "install-\\w+",
      "set-acl", "takeown", "icacls", "cipher",
    ),
    category: "mass-modify",
    verdict: "block-until-approved",
    reason: "changes system configuration or running processes",
  },
  {
    id: "ps.bulk-write",
    tools: ["run_powershell"],
    field: "command",
    pattern: new RegExp(
      `${commands("move-item", "mi", "mv", "move", "rename-item", "rni", "ren", "copy-item", "cpi", "cp", "copy", "set-content", "sc", "add-content", "ac", "out-file", "new-item", "ni", "mkdir", "md").source}[^;|\\n]*(\\*|-recurse(?![\\w-]))`,
      "i",
    ),
    category: "mass-modify",
    verdict: "block-until-approved",
    reason: "writes, moves, or renames files in bulk (wildcard or -Recurse)",
  },
];

// Launching an installed program by bare name (`Start-Process notepad`) is how "open X" works;
// it's allowed without approval. Any path, argument list, or elevation still needs approval.
const BARE_LAUNCH = /^(start-process|saps|start)\s+['"]?[a-z][\w.-]*['"]?$/i;

// Static members of these .NET types are pure computations (rounding a size, formatting a
// date, joining strings) — the calculated-property idiom `@{N='MB';E={[math]::Round(…)}}`
// shouldn't need approval. Any other type (e.g. [System.IO.File]::Delete) does.
const PURE_STATIC_TYPES = /^\[(system\.)?(math|string|datetime|timespan|convert|regex|char|guid|version|bitconverter|int|int32|int64|long|double|decimal)\]$/i;

function unsafeStaticCalls(command: string): string[] {
  const reasons: string[] = [];
  for (const match of command.matchAll(/(\[[^\]\s]+\])?\s*::/g)) {
    const type = match[1];
    if (!type || !PURE_STATIC_TYPES.test(type)) reasons.push(`.NET static call on ${type ?? "an expression"} can have side effects`);
  }
  return reasons;
}

/**
 * Strips leading assignments / hashtable entries (`$x = …`, `N='SizeMB'`, `E=`) so the check
 * applies to what actually runs on the right-hand side — `$x = git push` must not pass as a
 * mere expression.
 */
function stripAssignments(segment: string): string {
  let s = segment.replace(/^@/, "").trim();
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(/^\$?[\w:.]+\s*=(?!=)\s*/, "").trim();
  }
  return s;
}

/** Splits a command into its pipeline/statement/script-block segments. */
function commandSegments(command: string): string[] {
  return command
    .split(/;|\|\||&&|\||\r?\n|\{|\}|\(|\)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Why a command is NOT provably read-only, or [] when every segment is allowlisted. */
function readOnlyViolations(command: string): string[] {
  const violations: string[] = [];
  for (const { pattern, reason } of FORBIDDEN_CONSTRUCTS) if (pattern.test(command)) violations.push(reason);
  violations.push(...unsafeStaticCalls(command));

  for (const rawSegment of commandSegments(command)) {
    const segment = stripAssignments(rawSegment);
    const head = segment.split(/[\s,]+/)[0]!.toLowerCase();
    // Pure expressions (`$_.Length -gt 1MB`, a literal, a -switch, a static call on a type
    // already vetted above) aren't commands; method calls within them are caught above.
    if (head === "" || /^[$'"\d-]/.test(head) || /^\[[^\]]+\]/.test(head)) continue;
    if (BARE_LAUNCH.test(segment)) continue;
    // ipconfig is read-only only bare or with /all (not /release, /renew, /flushdns…).
    if (head === "ipconfig" || head === "ipconfig.exe") {
      if (!/^ipconfig(\.exe)?(\s+\/all)?$/i.test(segment)) violations.push("ipconfig with a modifying switch");
      continue;
    }
    if (!READ_ONLY_COMMANDS.has(head)) violations.push(`"${segment.split(/\s+/)[0]}" is not on the read-only allowlist`);
  }
  return violations;
}

// --- Content checks ----------------------------------------------------------------------

/** 13-19 digits (spaces/dashes allowed) passing the Luhn checksum — i.e. a real card number. */
export function containsCardNumber(text: string): boolean {
  for (const match of text.matchAll(/(?:\d[ -]?){12,18}\d/g)) {
    const digits = match[0].replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) continue;
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

const SENSITIVE_FIELD = /pass(word|wd|code)?|pwd|secret|otp|one.?time|2fa|mfa|\bpin\b|security.?code/i;
const PAYMENT_FIELD = /card|cc-?(num|number|exp|csc)|cvv|cvc|csc|expir|iban|routing|account.?number/i;
const DESTRUCTIVE_LABEL = /\b(delete|remove|erase|uninstall|format|discard|wipe|empty (recycle )?bin|permanently)\b/i;
const PAYMENT_LABEL = /\b(pay|payment|purchase|buy( now)?|checkout|check out|place order|order now|subscribe|donate|transfer|send money)\b/i;
const OUTBOUND_LABEL = /\b(send|post|publish|share|submit|upload|reply all|tweet)\b/i;

function labelRules(text: string | undefined, source: string): Array<{ category: RiskCategory; reason: string; id: string }> {
  if (!text) return [];
  const hits: Array<{ category: RiskCategory; reason: string; id: string }> = [];
  if (DESTRUCTIVE_LABEL.test(text)) hits.push({ category: "file-delete", reason: `${source} "${text}" looks destructive`, id: "ui.destructive-label" });
  if (PAYMENT_LABEL.test(text)) hits.push({ category: "payment", reason: `${source} "${text}" looks like a payment action`, id: "ui.payment-label" });
  if (OUTBOUND_LABEL.test(text)) hits.push({ category: "network-egress", reason: `${source} "${text}" sends something outward`, id: "ui.outbound-label" });
  return hits;
}

// --- Classification ------------------------------------------------------------------------

const SEVERITY: RiskCategory[] = ["payment", "credential-entry", "file-delete", "mass-modify", "network-egress"];

type Hit = { id: string; category: RiskCategory | null; reason: string };

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function hitsFor(tool: string, args: Record<string, unknown>, ctx: ClassifierContext): Hit[] {
  const hits: Hit[] = [];

  switch (tool) {
    case "run_powershell": {
      const command = str(args.command) ?? "";
      for (const rule of POWERSHELL_RULES) {
        if (rule.pattern.test(command)) hits.push({ id: rule.id, category: rule.category, reason: rule.reason });
      }
      if (hits.length === 0) {
        for (const reason of readOnlyViolations(command)) hits.push({ id: "ps.not-read-only", category: null, reason });
      }
      break;
    }

    case "type_text": {
      const text = str(args.text) ?? "";
      if (ctx.focusedElement?.is_password) {
        hits.push({ id: "input.password-field", category: "credential-entry", reason: `typing into a password field ("${ctx.focusedElement.name ?? ""}")` });
      } else if (ctx.focusedElement?.name && SENSITIVE_FIELD.test(ctx.focusedElement.name)) {
        hits.push({ id: "input.sensitive-field", category: "credential-entry", reason: `typing into "${ctx.focusedElement.name}"` });
      }
      if (containsCardNumber(text)) hits.push({ id: "input.card-number", category: "payment", reason: "text contains a card number" });
      if (ctx.focusedElement?.name && PAYMENT_FIELD.test(ctx.focusedElement.name) && /\d{3,}/.test(text)) {
        hits.push({ id: "input.payment-field", category: "payment", reason: `typing digits into "${ctx.focusedElement.name}"` });
      }
      break;
    }

    case "browser_type": {
      const text = str(args.text) ?? "";
      const selector = str(args.selector) ?? "";
      const attrs = ctx.domTarget?.attributes ?? {};
      const fieldDescriptor = [selector, attrs.type, attrs.name, attrs.id, attrs.autocomplete, attrs["aria-label"], attrs.placeholder].filter(Boolean).join(" ");
      if ((attrs.type ?? "").toLowerCase() === "password" || SENSITIVE_FIELD.test(fieldDescriptor)) {
        hits.push({ id: "input.password-field", category: "credential-entry", reason: "typing into a password/credential field" });
      }
      if (containsCardNumber(text)) hits.push({ id: "input.card-number", category: "payment", reason: "text contains a card number" });
      if (PAYMENT_FIELD.test(fieldDescriptor) && /\d{3,}/.test(text)) {
        hits.push({ id: "input.payment-field", category: "payment", reason: "typing digits into a payment field" });
      }
      break;
    }

    case "click": {
      for (const h of labelRules(str(args.label), "click label")) hits.push(h);
      for (const h of labelRules(ctx.elementAtPoint?.name, "element under the cursor")) hits.push(h);
      break;
    }

    case "browser_click": {
      for (const h of labelRules(str(args.selector), "selector")) hits.push(h);
      const dom = ctx.domTarget;
      const label = [dom?.text, dom?.attributes?.value, dom?.attributes?.["aria-label"], dom?.attributes?.title].filter(Boolean).join(" ").slice(0, 120);
      for (const h of labelRules(label || undefined, "element")) hits.push(h);
      break;
    }

    case "key_press": {
      const key = (str(args.key) ?? "").toLowerCase();
      const mods = (Array.isArray(args.modifiers) ? args.modifiers : []).map((m) => String(m).toLowerCase());
      if ((key === "delete" || key === "del") && mods.includes("shift")) {
        hits.push({ id: "key.permanent-delete", category: "file-delete", reason: "Shift+Delete permanently deletes without the Recycle Bin" });
      }
      break;
    }

    case "browser_evaluate": {
      const expr = str(args.expression) ?? "";
      hits.push({ id: "browser.evaluate", category: null, reason: "runs arbitrary JavaScript in the page" });
      if (/\b(fetch|XMLHttpRequest|sendBeacon|WebSocket)\b/.test(expr)) {
        hits.push({ id: "browser.evaluate-network", category: "network-egress", reason: "script makes network requests" });
      }
      if (/\b(submit|requestSubmit)\s*\(/.test(expr)) {
        hits.push({ id: "browser.evaluate-submit", category: "network-egress", reason: "script submits a form" });
      }
      break;
    }

    case "browser_set_file_input":
      hits.push({ id: "browser.upload", category: "network-egress", reason: "attaches local files for upload to a website" });
      break;

    case "clear_click_history":
      hits.push({ id: "memory.clear", category: "mass-modify", reason: "permanently deletes learned click locations for this app" });
      break;

    case "screenshot":
      // Writing to an explicit path could overwrite an existing file.
      if (str(args.output_path)) hits.push({ id: "file.write-explicit-path", category: "mass-modify", reason: "writes a file at a caller-chosen path" });
      break;
  }

  return hits;
}

export function classify(tool: string, args: Record<string, unknown>, context: ClassifierContext = {}): RiskAssessment {
  const hits = hitsFor(tool, args, context);
  if (hits.length === 0) return { verdict: "allow", category: null, categories: [], reasons: [], matchedRules: [] };

  const categories = [...new Set(hits.map((h) => h.category).filter((c): c is RiskCategory => c !== null))];
  categories.sort((a, b) => SEVERITY.indexOf(a) - SEVERITY.indexOf(b));
  return {
    verdict: "block-until-approved",
    category: categories[0] ?? null,
    categories,
    reasons: [...new Set(hits.map((h) => h.reason))],
    matchedRules: [...new Set(hits.map((h) => h.id))],
  };
}

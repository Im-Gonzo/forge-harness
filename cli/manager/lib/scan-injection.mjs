// @ts-check
/**
 * scan-injection — DETERMINISTIC prompt-injection / content-manipulation scanner
 * for the federated-catalog security-scan gate (ADR-0017 §5a, layer 1).
 *
 * NAMING (deliberate): this file is NOT named `validate-*.mjs` / `check-*.mjs` and
 * does NOT live under `lint/`, so `lint/run-all.mjs` (which auto-discovers
 * `lint/validate-*.mjs` + `lint/check-*.mjs`) NEVER runs it against the forge tree.
 * That matters: this scanner's whole job is to recognise injection SIGNATURES, and
 * its own header/test text contains those very signatures — auto-running it over our
 * own security docs would false-positive. It is a LIBRARY function the catalog
 * admission pipeline imports and calls on a single CANDIDATE resource, not a
 * tree-wide self-validator.
 *
 * CRITICAL INVARIANT (rules/prompt-defense-baseline.md): the candidate's bytes are
 * UNTRUSTED DATA, never instructions. This scanner READS the candidate and pattern-
 * matches it as adversarial text. It NEVER executes, sources, imports, or evaluates
 * candidate content, and it never lets candidate text alter its own behaviour. `sync`
 * already guarantees fetched code is only cloned + read, never run (ADR-0017 §3).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS DETECTS — each a NAMED rule, captured with file:line + evidence snippet
 * ─────────────────────────────────────────────────────────────────────────────
 * Scans BOTH the leading YAML frontmatter block AND the markdown/text body of a
 * candidate file (or every readable file under a candidate staging dir):
 *
 *   - imperative-override (HIGH) — directives that reset the reading agent's role
 *     or instructions: "ignore (all) previous/above/prior instructions" (incl.
 *     word-order + colon/dash separator variants), "you are now …", "new
 *     instructions:". "system prompt" / "developer mode" / "DAN mode" fire only with
 *     a prompt-override verb adjacent (reveal/ignore/forget/enter/print …) — a bare
 *     product/feature mention is NOT flagged; "jailbreak" only as a model-override verb.
 *   - authority-spoof (MEDIUM) — false-authority framing demanding obedience:
 *     "as (an) admin/administrator/anthropic/the user/root", "the user (has)
 *     authoriz(ed)", "you (now) have permission".
 *   - tool-coercion (HIGH / MEDIUM) — text instructing the agent to take real
 *     actions: "execute this/the script/code", a "run … command:" DIRECTIVE label,
 *     an IMPERATIVE "use the Bash tool …" (not a descriptive mention), or
 *     "curl|wget … | sudo sh". A bare "curl|wget … | sh" installer one-liner is
 *     MEDIUM (surfaced, not high). FP-CUT: tutorial "run the command `npm test`" and
 *     a descriptive "agents can use the Bash tool" stay clean.
 *   - exfiltration (HIGH) — directions to send data out: an exfil verb
 *     (send/post/upload/email/exfiltrate/leak/transmit) paired with an external
 *     http(s) URL, OR — for an email destination — a SENSITIVE-DATA noun + address.
 *     FP-CUT: a bare "send an email to support@example.com" stays clean.
 *   - hidden-carrier (MEDIUM) — vectors smuggling directives past a human reviewer:
 *     an HTML comment (`<!-- … -->`) whose text carries an imperative/instruction,
 *     or a suspiciously long (> ~200 char) contiguous base64/hex blob.
 *   - defanged-ioc (MEDIUM) — a deliberately neutralized indicator: "hxxp(s)://",
 *     a "[.]"/"(dot)" hostname separator, or an "[at]"/"(at)" email — a hallmark of
 *     pasted malware/phishing IOCs being smuggled into a resource as data.
 *   - assistant-addressed (LOW) — a line addressing the assistant/agent/model/
 *     claude/AI/LLM followed by an imperative (a strong indirect-injection tell).
 *
 * ANTI-EVASION: before matching, each region is NORMALIZED (newline-preservingly,
 * so reported lines still map to the original file): zero-width chars are stripped
 * (kills "Ig<zwsp>nore"), text is NFKC-normalized (folds full-width "Ｉｇｎｏｒｅ"),
 * residual Cyrillic/Greek confusables are folded to ASCII (kills "Іgnore"), and a
 * BOUNDED space-split repair rejoins single-space-split override keywords ("Ig nore"
 * → "ignore"). Override rules also match word-order variants ("ignore the
 * instructions above") and a colon-OR-dash directive separator ("new instructions —").
 *
 * severity → 'high' (imperative-override, tool-coercion, exfiltration),
 *            'medium' (authority-spoof, hidden-carrier, defanged-ioc, bare curl|sh),
 *            'low' (assistant-addressed / weak signals).
 * verdict = 'flagged' if ANY high|medium finding fired; else 'clean'. low-only ⇒ clean.
 *
 *   - needs-review (MEDIUM) — FAIL-CLOSED sentinel: the candidate could NOT be
 *     scanned (no/empty path, stat failure, non-file/non-dir, or a top-level error).
 *     An unscannable UNTRUSTED candidate must NOT pass the gate, so these degrade to
 *     `flagged` (not `clean`). A genuinely clean, successfully-scanned file is `clean`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRACT (consumed verbatim by manager/catalog.mjs's security-scan step)
 * ─────────────────────────────────────────────────────────────────────────────
 *   scanInjection(candidatePath: string) -> {
 *     verdict: "clean" | "flagged",
 *     findings: Array<{ rule, severity, path, line, evidence, message }>
 *   }
 *
 * HARD INVARIANTS: zero runtime deps (node: builtins + relative imports only —
 * lint/validate-manager-zerodep.mjs enforces this); FAIL-CLOSED — any error that
 * prevents scanning the candidate (no/empty path, stat failure, non-file/non-dir,
 * or a top-level throw) degrades to a SAFE `{ verdict: "flagged", findings:
 * [<needs-review note>] }`, NEVER a throw. An unscannable untrusted candidate must
 * not pass the gate. (A successfully-scanned, signature-free file is still 'clean'.)
 *
 * @module manager/lib/scan-injection
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {Object} ScanFinding
 * @property {string} rule      Signature id that matched (e.g. "imperative-override").
 * @property {'low'|'medium'|'high'} severity
 * @property {string} path      Candidate-relative path of the matched file.
 * @property {number|null} line 1-based line of the match (null when file-level).
 * @property {string} evidence  The quoted offending text (truncated).
 * @property {string} message   Human-readable explanation of the signature.
 *
 * @typedef {Object} ScanResult
 * @property {'clean'|'flagged'} verdict
 * @property {ScanFinding[]} findings
 */

/** Max chars of matched text quoted into a finding's `evidence`. */
const EVIDENCE_MAX = 160;
/** Directory basenames pruned wherever they appear when scanning a staging dir. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', '.forge']);
/** Only these extensions (plus extension-less text) are scanned under a dir. */
const TEXT_EXT = new Set([
  '.md', '.markdown', '.mdx', '.txt', '.json', '.yml', '.yaml',
  '.mjs', '.cjs', '.js', '.ts', '.sh', '.bash', '.toml', '.html', '.htm', '',
]);
/** Cap bytes read per file so a giant blob can't wedge the pipeline. */
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Truncate + single-line a matched snippet for the `evidence` field.
 * @param {string} s
 * @returns {string}
 */
function snippet(s) {
  const oneLine = String(s).replace(/\s+/g, ' ').trim();
  return oneLine.length > EVIDENCE_MAX ? oneLine.slice(0, EVIDENCE_MAX - 1) + '…' : oneLine;
}

// ───────────────────────────────────────────────────────────────────────────
// UNICODE NORMALIZATION (anti-evasion)
// ───────────────────────────────────────────────────────────────────────────
// Adversaries hide override keywords from naïve regexes using zero-width splits
// ("Ig<U+200B>nore"), confusable look-alikes (Cyrillic 'Іgnore', Greek), and
// full-width forms ('Ｉｇｎｏｒｅ'). We normalize the text BEFORE matching so the
// existing ASCII rules fire on the de-obfuscated form.
//
// LINE-NUMBER INVARIANCE: every transform here is newline-preserving. Stripping
// zero-width chars and folding confusables/full-width are per-code-point edits
// that NEVER touch '\n'; NFKC normalization decomposes/recomposes characters but
// does not synthesize or delete newlines from ordinary text. Because runRule
// computes a match's line by counting '\n' before its offset, and the count of
// '\n' before any given (non-newline) span is preserved across normalization,
// reported line numbers continue to map to the ORIGINAL file. We additionally
// collapse zero-width chars to nothing (not to a space) so intra-word splits
// rejoin into a single matchable token.

/**
 * Zero-width / invisible joiners stripped outright (kills "Ig<zwsp>nore").
 * Written with \u escapes so this scanner source itself stays free of raw
 * invisible bytes (check-unicode-safety scans .mjs too). Covers ZWSP/ZWNJ/ZWJ
 * (U+200B–U+200D), word-joiner (U+2060) and ZWNBSP/BOM (U+FEFF).
 */
const ZERO_WIDTH_RE = /[\u200B\u200C\u200D\u2060\uFEFF]/g;

/**
 * Confusable → ASCII fold table. Cyrillic + Greek + a few symbol look-alikes
 * that spell Latin attack words. Each maps a single confusable code point to its
 * visually-equivalent ASCII letter so "Іgnore"/"Ѕystem"/"Ρevеal" fold to ASCII.
 * @type {Record<string,string>}
 */
const CONFUSABLE_MAP = {
  // ── Cyrillic uppercase look-alikes ──
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M',
  'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T',
  'Х': 'X', 'І': 'I', 'Ј': 'J', 'Ѕ': 'S', 'Є': 'E',
  'Ү': 'Y', 'У': 'Y',
  // ── Cyrillic lowercase look-alikes ──
  'а': 'a', 'в': 'v', 'е': 'e', 'к': 'k', 'м': 'm',
  'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c', 'т': 't',
  'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'є': 'e',
  'у': 'y', 'һ': 'h', 'ґ': 'r', 'ԁ': 'd', 'ԛ': 'q',
  // ── Greek look-alikes ──
  'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H',
  'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O',
  'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X',
  'ο': 'o', 'α': 'a', 'ι': 'i', 'ν': 'v', 'ρ': 'p',
  'υ': 'u', 'κ': 'k', 'ε': 'e', 'σ': 'o', 'η': 'n',
};

/**
 * De-obfuscate text for matching while preserving every '\n' (so line numbers
 * computed on the result still map to the original file). Pipeline:
 *   1. strip zero-width chars (collapse intra-word splits),
 *   2. NFKC normalize (folds full-width U+FF01–U+FF5E and many compatibility
 *      forms to ASCII; newline-safe),
 *   3. fold residual confusables (Cyrillic/Greek look-alikes) to ASCII.
 * Falls back to the raw string on any error (fail-open).
 * @param {string} text
 * @returns {string}
 */
function normalizeForMatch(text) {
  try {
    let s = String(text).replace(ZERO_WIDTH_RE, '');
    try { s = s.normalize('NFKC'); } catch { /* normalize unavailable — skip */ }
    s = s.replace(/[^\x00-\x7F]/g, (ch) => (ch in CONFUSABLE_MAP ? CONFUSABLE_MAP[ch] : ch));
    return s;
  } catch {
    return String(text);
  }
}

/**
 * BOUNDED intra-word space-split repair. Adversaries split an override keyword
 * with a single inserted space ("Ig nore all previous instructions") to dodge a
 * `\bignore\b` match. We rejoin ONLY a fixed allow-list of override keywords when
 * their exact letters appear interleaved with single spaces, the whole spaced run
 * is delimited by non-letters, and AT LEAST one such split is present (so we never
 * touch ordinary text). This is deliberately narrow — it can only ever collapse a
 * spaced spelling of a known keyword back into that keyword, never broaden into
 * arbitrary phrases. Newline-safe: the inner separators match `[ \t]` only.
 * @param {string} text
 * @returns {string}
 */
function collapseKeywordSpaces(text) {
  try {
    let s = String(text);
    for (const kw of SPACE_SPLIT_KEYWORDS) {
      // Build "i ?g ?n ?o ?r ?e" with single-space tolerance between letters,
      // anchored on word boundaries; case-insensitive; only fires when ≥1 split.
      const spaced = kw.split('').map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[ \\t]?');
      const re = new RegExp(`(?<![A-Za-z])${spaced}(?![A-Za-z])`, 'gi');
      s = s.replace(re, (match) => (/[ \t]/.test(match) ? joinKeyword(match) : match));
    }
    return s;
  } catch {
    return String(text);
  }
}

/** Strip the interior spaces/tabs from a matched spaced-keyword run. */
function joinKeyword(match) {
  return match.replace(/[ \t]/g, '');
}

/**
 * Override keywords eligible for space-split repair. Kept SHORT and high-signal so
 * the bounded collapse can only reconstruct a real override token.
 */
const SPACE_SPLIT_KEYWORDS = [
  'ignore', 'disregard', 'forget', 'override', 'instructions', 'jailbreak',
];

/**
 * @typedef {Object} RuleSpec
 * @property {string} rule
 * @property {'low'|'medium'|'high'} severity
 * @property {RegExp} re      Global regex; `lastIndex` reset per use.
 * @property {string} message
 */

/**
 * The deterministic signature set. Every regex is case-insensitive and tolerant of
 * runs of whitespace between tokens (`[ \t]+` / `\s+`). They are intentionally
 * specific (anchored on real attack phrasings) to keep false-positives low on
 * innocent prose that merely mentions "instructions" / "system".
 * @type {RuleSpec[]}
 */
const RULES = [
  // ── imperative-override (HIGH) ────────────────────────────────────────────
  {
    rule: 'imperative-override',
    severity: 'high',
    // "ignore / disregard / forget (all) (the) (previous|above|prior|earlier|prior) instructions/prompts/context"
    re: /\b(?:ignore|disregard|forget|override)\b[ \t]+(?:all[ \t]+)?(?:the[ \t]+|your[ \t]+|any[ \t]+)?(?:previous|above|prior|earlier|preceding|foregoing|former)[ \t]+(?:instructions?|prompts?|directions?|context|rules?|guidelines?)/gi,
    message:
      'Imperative override: text directs the reading agent to ignore/disregard its prior instructions (classic prompt-injection reset).',
  },
  {
    rule: 'imperative-override',
    severity: 'high',
    // WORD-ORDER evasion — the direction word follows the NOUN instead of preceding
    // it: "ignore the instructions above", "disregard the rules below/here".
    re: /\b(?:ignore|disregard|forget|override)\b[ \t]+(?:all[ \t]+)?(?:the[ \t]+|your[ \t]+|any[ \t]+)?(?:instructions?|prompts?|directions?|context|rules?|guidelines?)[ \t]+(?:above|below|here|previously|earlier|before|prior)\b/gi,
    message:
      'Imperative override: text directs the agent to ignore its instructions, with the direction word AFTER the noun ("ignore the instructions above").',
  },
  {
    rule: 'imperative-override',
    severity: 'high',
    // WORD-ORDER evasion — noun+direction stated FIRST, override verb later on the
    // SAME line: "the instructions above … ignore them", "rules below, disregard".
    re: /\b(?:instructions?|prompts?|directions?|rules?|guidelines?)[ \t]+(?:above|below|here|previously|earlier|before|prior)\b[^\n]{0,40}?\b(?:ignore|disregard|forget|override)\b/gi,
    message:
      'Imperative override: a "<instructions> above … ignore" construction (noun+direction precede the override verb on one line).',
  },
  {
    rule: 'imperative-override',
    severity: 'high',
    // "you are now …", "from now on you are …"
    re: /\b(?:you[ \t]+are[ \t]+now\b|from[ \t]+now[ \t]+on[, \t]+you[ \t]+(?:are|will|must|should)\b)/gi,
    message:
      'Imperative override: text attempts to redefine the reading agent\'s role/persona ("you are now …").',
  },
  {
    rule: 'imperative-override',
    severity: 'high',
    // "new instructions:", "updated instructions —", "revised instructions -" as a
    // directive label. SEPARATOR evasion: accept a colon OR a hyphen / en- / em-dash
    // (-, –, —) introducing the supplanting directive, not only a colon.
    re: /\b(?:new|updated|revised|real|actual|true)[ \t]+(?:instructions?|system[ \t]+prompt|directives?)[ \t]*(?::|[-–—])/gi,
    message:
      'Imperative override: a "new instructions:" / "updated instructions —" style directive label (colon OR dash separator) that tries to supplant the agent\'s real instructions.',
  },
  {
    rule: 'imperative-override',
    severity: 'high',
    // "system prompt" / "developer mode" / "DAN mode" addressed as a TARGET — must
    // be paired with a prompt-OVERRIDE verb (reveal/print/ignore/forget/enter/…).
    // FP-CUT: bare "system prompt" or "developer mode" as a product/feature term
    // (e.g. "edit the system prompt field", "enable developer mode in the settings")
    // no longer fires on its own — benign UI toggles like enable/activate/turn-on are
    // deliberately EXCLUDED. "enter (into) developer mode" is the jailbreak phrasing
    // we keep. "jailbreak" stays a standalone tell only as the model-override verb
    // ("jailbreak the model/assistant").
    re: /\b(?:reveal|print|show|display|output|repeat|leak|disclose|dump|forget|ignore|change|override|enter|go[ \t]+into|switch[ \t]+into)[ \t]+(?:your[ \t]+|the[ \t]+|into[ \t]+)?(?:system[ \t]+prompt|developer[ \t]+mode|dan[ \t]+mode)\b|\bjailbreak\b[ \t]+(?:the[ \t]+)?(?:model|assistant|agent|ai|llm|system)\b/gi,
    message:
      'Imperative override: a prompt-override verb targets the "system prompt", "developer mode", or "DAN mode" (model-override directive) — distinct from a bare product/feature mention.',
  },

  // ── authority-spoof (MEDIUM) ──────────────────────────────────────────────
  {
    rule: 'authority-spoof',
    severity: 'medium',
    // "as (an) admin/administrator/anthropic/the user/root/system/developer/owner"
    re: /\bas[ \t]+(?:an?[ \t]+)?(?:admin(?:istrator)?|anthropic|the[ \t]+user|root|system(?:[ \t]+operator)?|the[ \t]+developer|the[ \t]+owner|superuser)\b[ \t,]*(?:i\b|you\b|we\b|,|:)/gi,
    message:
      'Authority spoof: content claims elevated identity (admin/anthropic/root/the user) to manufacture obedience.',
  },
  {
    rule: 'authority-spoof',
    severity: 'medium',
    // "the user (has) authoriz(ed/es)", "the user grants"
    re: /\bthe[ \t]+user[ \t]+(?:has[ \t]+)?(?:authoriz|authoris|approv|grant|permit|allow)\w*/gi,
    message:
      'Authority spoof: text asserts the user has authorized/approved an action to coerce the agent into it.',
  },
  {
    rule: 'authority-spoof',
    severity: 'medium',
    // "you (now) have permission to …" — must be a GRANT (followed by "to <verb>"
    // or a clause end), so it does NOT trip on "you have permission errors/denied".
    re: /\byou[ \t]+(?:now[ \t]+)?have[ \t]+(?:full[ \t]+|elevated[ \t]+|admin[ \t]+|root[ \t]+)?permissions?[ \t]+to\b|\byou[ \t]+(?:now[ \t]+)?have[ \t]+(?:full[ \t]+|elevated[ \t]+|admin[ \t]+|root[ \t]+)?permissions?[ \t]*(?:[.,;]|$)/gim,
    message:
      'Authority spoof: text grants the agent fabricated permission to bypass its constraints.',
  },

  // ── tool-coercion (HIGH) ──────────────────────────────────────────────────
  {
    rule: 'tool-coercion',
    severity: 'high',
    // "execute this/the (following) script/code", "run the following command" —
    // an imperative to run something. FP-CUT: a bare "run the command `npm test`"
    // tutorial is NOT high; this rule now requires either (a) "execute … script/
    // code" (running an opaque script is the attack), or (b) "run … command" only
    // when it is a DIRECTIVE LABEL (ends in a colon / "below" / "above") rather than
    // ordinary "run the command npm test" prose.
    re: /\b(?:execute|invoke)[ \t]+(?:the[ \t]+|this[ \t]+|these[ \t]+)?(?:following[ \t]+)?(?:command|commands|script|code|snippet)\b|\brun[ \t]+(?:the[ \t]+|this[ \t]+|these[ \t]+)?(?:following[ \t]+)?(?:command|commands|script|code|snippet)\b[ \t]*(?::|below\b|above\b|now\b|$)/gim,
    message:
      'Tool coercion: text instructs the agent to execute a script/code, or to run a command introduced as a directive label (": …", "below", "now").',
  },
  {
    rule: 'tool-coercion',
    severity: 'high',
    // "use the Bash/Shell/Exec/… tool" — IMPERATIVE only. FP-CUT: a descriptive
    // mention in agent-authoring docs ("agents can use the Bash tool to run X") is
    // clean; this fires only with an imperative cue BEFORE ("please/you must/you
    // should/now/then …") or a coercive continuation AFTER ("… and run/execute …").
    re: /\b(?:please[ \t]+|you[ \t]+(?:must|should|need[ \t]+to)[ \t]+|now[ \t]+|then[ \t]+|first[ \t]+)use[ \t]+the[ \t]+(?:bash|shell|exec|execute|terminal|command|write|edit|fetch|webfetch)[ \t]+tool\b|(?<!\b(?:can|could|may|might|will|would|should|to|also)[ \t])\buse[ \t]+the[ \t]+(?:bash|shell|exec|execute|terminal|command|write|edit|fetch|webfetch)[ \t]+tool\b[ \t]+(?:and[ \t]+|to[ \t]+)?(?:run|execute|invoke|fetch|download|send|post)\b/gi,
    message:
      'Tool coercion: an imperative directs the agent to invoke a named tool (e.g. "please use the Bash tool and run …") — not a descriptive mention.',
  },
  {
    rule: 'tool-coercion',
    severity: 'high',
    // "curl … | sudo sh", or curl|sh paired with an override directive → HIGH.
    // The canonical-installer "curl -fsSL https://…/install.sh | sh" with NO sudo
    // and NO override directive is handled at MEDIUM by the rule below.
    re: /\b(?:curl|wget)\b[^\n|]*\|[ \t]*sudo[ \t]+(?:sh|bash|zsh|python3?|node)\b/gi,
    message:
      'Tool coercion: a curl|wget piped into a privileged (sudo) shell interpreter — download-and-execute as root.',
  },
  {
    rule: 'tool-coercion',
    severity: 'medium',
    // Bare "curl … | sh" / "wget … | bash" (no sudo) — DOWNGRADED to MEDIUM: the
    // canonical installer one-liner ("curl -fsSL …/install.sh | sh") is ubiquitous
    // in legitimate READMEs, but is still surfaced (a real download-and-execute
    // primitive). Promoted to HIGH only by the sudo rule above, or when an override
    // directive co-occurs (caught independently by imperative-override rules).
    re: /\b(?:curl|wget)\b[^\n|]*\|[ \t]*(?:sh|bash|zsh|python3?|node)\b/gi,
    message:
      'Tool coercion (medium): a bare curl|wget piped into a shell interpreter (download-and-execute). Surfaced for review; HIGH only when run as sudo or alongside an override directive.',
  },

  // ── exfiltration (HIGH) ───────────────────────────────────────────────────
  // To keep false-positives low, an exfil verb alone is NOT enough: we require it
  // to co-occur (same line) with EITHER a sensitive-data noun (env/secret/key/
  // token/credential/password/cookie/.env/contents/data/file/output) OR the
  // destination explicitly introduced by "to <url|email>". So innocent prose like
  // "email support@example.com if you hit a limit" does NOT trip.
  {
    rule: 'exfiltration',
    severity: 'high',
    // (verb … sensitive-noun … http-url)  — data-named exfil to an external URL
    re: /\b(?:send|post|upload|exfiltrate|transmit|leak|forward|deliver|ship|push)\b[^\n]{0,120}?\b(?:env(?:ironment)?|\.env|secret|secrets|api[ \t]?key|keys?|token|tokens?|credential|credentials|password|passwords?|cookie|cookies|session|contents?|data|payload|output|dump|file)\b[^\n]{0,80}?\bhttps?:\/\/[^\s)>'"]+/gi,
    message:
      'Exfiltration: an exfil verb + a sensitive-data noun (env/secret/key/credential/contents/…) + an external http(s) URL.',
  },
  {
    rule: 'exfiltration',
    severity: 'high',
    // (verb … "to" … http-url) — explicit external destination
    re: /\b(?:send|post|upload|exfiltrate|transmit|leak|forward|deliver|ship|push)\b[^\n]{0,80}?\bto\b[^\n]{0,40}?\bhttps?:\/\/[^\s)>'"]+/gi,
    message:
      'Exfiltration: an exfil verb directing data "to" an external http(s) URL.',
  },
  {
    rule: 'exfiltration',
    severity: 'high',
    // (verb … sensitive-noun … email)  — data-named exfil to an external address.
    // FP-CUT: an email destination ALWAYS requires a sensitive-data noun. We removed
    // the bare "verb … to <email>" rule so benign "send an email to
    // support@example.com" no longer trips — only data-named exfil to an address does.
    re: /\b(?:send|email|e-?mail|post|upload|exfiltrate|transmit|leak|forward|deliver)\b[^\n]{0,120}?\b(?:env(?:ironment)?|\.env|secret|secrets|api[ \t]?key|keys?|token|tokens?|credential|credentials|password|passwords?|cookie|cookies|session|contents?|data|payload|output|dump|file)\b[^\n]{0,80}?\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    message:
      'Exfiltration: an exfil verb + a sensitive-data noun + an external email address.',
  },

  // ── assistant-addressed (LOW) ─────────────────────────────────────────────
  {
    rule: 'assistant-addressed',
    severity: 'low',
    // a line that addresses the assistant/agent/model/claude/AI/LLM then issues an imperative
    re: /\b(?:dear[ \t]+|hey[ \t]+|attention[ \t]*[:,]?[ \t]*|note[ \t]+to[ \t]+(?:the[ \t]+)?|to[ \t]+the[ \t]+)?(?:assistant|ai[ \t]+(?:assistant|model|agent)?|agent|model|claude|chatbot|llm|language[ \t]+model)\b[ \t]*[:,]?[ \t]*(?:please[ \t]+)?(?:you[ \t]+(?:must|should|will|need[ \t]+to)|do[ \t]+not|don'?t|always|never|ignore|disregard|execute|run|send|reveal|output|stop|now[ \t]+)/gi,
    message:
      'Assistant-addressed: a line addressed to the assistant/agent/model/AI carrying an imperative — a strong indirect-injection tell in fetched data.',
  },
];

/**
 * Push a finding for every match of a rule's regex within `text`. Computes the
 * 1-based line of each match relative to the WHOLE-FILE content via `lineBase`
 * (offset, in lines, of where `text` starts in the file) + the line within `text`.
 *
 * @param {RuleSpec} spec
 * @param {string} text       The region (frontmatter or body) to scan.
 * @param {number} lineBase   1-based line number in the file where `text` begins.
 * @param {string} relPath    Candidate-relative path for the finding.
 * @param {ScanFinding[]} out Accumulator (mutated).
 * @param {Set<string>} seen  Dedup key set (rule|line|evidence), mutated.
 */
function runRule(spec, text, lineBase, relPath, out, seen) {
  spec.re.lastIndex = 0;
  let m;
  let guard = 0;
  while ((m = spec.re.exec(text)) !== null && guard++ < 500) {
    if (m[0] === '') { spec.re.lastIndex++; continue; } // never loop on empty match
    const before = text.slice(0, m.index);
    let nl = 0;
    for (let i = 0; i < before.length; i++) if (before[i] === '\n') nl++;
    const line = lineBase + nl;
    const evidence = snippet(m[0]);
    const key = `${spec.rule}|${line}|${evidence}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      rule: spec.rule,
      severity: spec.severity,
      path: relPath,
      line,
      evidence,
      message: spec.message,
    });
  }
}

/**
 * Detect hidden-carrier signatures: HTML comments that smuggle imperative text,
 * and suspiciously long contiguous base64/hex blobs. Reported MEDIUM.
 *
 * @param {string} content    Whole-file text.
 * @param {string} relPath
 * @param {ScanFinding[]} out
 * @param {Set<string>} seen
 */
function runHiddenCarrier(content, relPath, out, seen) {
  // 1-based line of a char offset in `content`.
  const lineAt = (idx) => {
    let n = 1;
    for (let i = 0; i < idx && i < content.length; i++) if (content[i] === '\n') n++;
    return n;
  };
  const push = (line, evidence, message) => {
    const key = `hidden-carrier|${line}|${evidence}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ rule: 'hidden-carrier', severity: 'medium', path: relPath, line, evidence, message });
  };

  // (a) HTML comments carrying imperative/instruction text.
  const COMMENT_RE = /<!--([\s\S]*?)-->/g;
  // An imperative tell inside the comment body — directive verbs aimed at a reader/agent.
  const IMPERATIVE_IN_COMMENT =
    /\b(?:ignore|disregard|forget|override|you[ \t]+(?:are|must|should|will|now)|instructions?\b|system[ \t]+prompt|run[ \t]+(?:the[ \t]+|this[ \t]+)?command|execute\b|do[ \t]+not\b|always\b|never\b|assistant\b|agent\b|claude\b|send\b|exfiltrate\b|reveal\b)/i;
  let cm;
  let cguard = 0;
  while ((cm = COMMENT_RE.exec(content)) !== null && cguard++ < 500) {
    const body = cm[1] || '';
    if (IMPERATIVE_IN_COMMENT.test(body)) {
      push(
        lineAt(cm.index),
        snippet(cm[0]),
        'Hidden carrier: an HTML comment (<!-- … -->) contains imperative/instruction text aimed at the reading agent — hidden from a human skimming rendered markdown.',
      );
    }
  }

  // (b) Suspiciously long contiguous base64/hex blob (> ~200 chars).
  // Match a long run of base64/hex chars not broken by whitespace.
  const BLOB_RE = /[A-Za-z0-9+/=]{200,}/g;
  let bm;
  let bguard = 0;
  while ((bm = BLOB_RE.exec(content)) !== null && bguard++ < 100) {
    const blob = bm[0];
    // Classify: pure-hex, or base64-shaped (must look encoded, not e.g. a long word).
    const isHex = /^[0-9a-fA-F]+$/.test(blob) && blob.length >= 200;
    const isB64 =
      /^[A-Za-z0-9+/]+={0,2}$/.test(blob) &&
      /[A-Z]/.test(blob) && /[a-z]/.test(blob) && /[0-9+/]/.test(blob); // mixed ⇒ encoded, not prose
    if (!isHex && !isB64) continue;
    push(
      lineAt(bm.index),
      snippet(blob.slice(0, 80) + (blob.length > 80 ? '…' : '')),
      `Hidden carrier: a ${blob.length}-char contiguous ${isHex ? 'hex' : 'base64'} blob — an opaque encoded payload that can smuggle instructions past review.`,
    );
  }
}

/**
 * Detect DEFANGED indicators-of-compromise (IOCs) — the practice of writing a URL,
 * hostname, or email in a "neutralized" form so it isn't auto-linked/clicked:
 *   - `hxxp://` / `hxxps://`            (defanged scheme)
 *   - `evil[.]com` / `evil(dot)com`    (defanged hostname dot)
 *   - `attacker[at]evil.com` / `(at)`  (defanged email @)
 * In a catalog RESOURCE these are themselves a red flag: legitimate docs link
 * plainly, while defanging is a hallmark of pasted malware/phishing IOCs being
 * smuggled in as data. Reported MEDIUM (a suspicious signal, not a hard exploit).
 * Operates on the NORMALIZED region text; line numbers map to the file via lineBase.
 *
 * @param {string} text       Normalized region text.
 * @param {number} lineBase   1-based line of the file where `text` begins.
 * @param {string} relPath
 * @param {ScanFinding[]} out
 * @param {Set<string>} seen
 */
function runDefangedIoc(text, lineBase, relPath, out, seen) {
  const specs = [
    {
      // hxxp / hxxps scheme (with :// or [:]//, common defang variants)
      re: /\bhxxps?(?::|\[:\])\/\/[^\s)>'"]+/gi,
      message: 'Defanged IOC: a "hxxp(s)://" URL — a deliberately neutralized link, a hallmark of pasted malware/phishing indicators.',
    },
    {
      // defanged hostname dot: foo[.]bar / foo(dot)bar  (require a TLD-ish tail)
      re: /\b[a-z0-9-]+(?:\[\.\]|\(dot\)|\[dot\])[a-z0-9.-]*[a-z]{2,}\b/gi,
      message: 'Defanged IOC: a hostname with a "[.]"/"(dot)" defanged separator — neutralized so it is not auto-linked; a red flag in a resource.',
    },
    {
      // defanged email @: user[at]host.tld / user(at)host.tld
      re: /\b[a-z0-9._%+-]+(?:\[at\]|\(at\))[a-z0-9.-]+\.[a-z]{2,}\b/gi,
      message: 'Defanged IOC: an email with an "[at]"/"(at)" defanged @ — a neutralized contact address, a hallmark of smuggled IOCs.',
    },
  ];
  for (const spec of specs) {
    spec.re.lastIndex = 0;
    let m;
    let guard = 0;
    while ((m = spec.re.exec(text)) !== null && guard++ < 200) {
      if (m[0] === '') { spec.re.lastIndex++; continue; }
      const before = text.slice(0, m.index);
      let nl = 0;
      for (let i = 0; i < before.length; i++) if (before[i] === '\n') nl++;
      const line = lineBase + nl;
      const evidence = snippet(m[0]);
      const key = `defanged-ioc|${line}|${evidence}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ rule: 'defanged-ioc', severity: 'medium', path: relPath, line, evidence, message: spec.message });
    }
  }
}

/**
 * Scan a single file's text content for ALL signatures. Splits frontmatter from
 * body (so line numbers are reported correctly across the whole file) and runs the
 * regex rules over each region plus the hidden-carrier pass over the whole file.
 *
 * @param {string} content  Whole-file text.
 * @param {string} relPath  Candidate-relative path for findings.
 * @returns {ScanFinding[]}
 */
function scanContent(content, relPath) {
  /** @type {ScanFinding[]} */
  const out = [];
  const seen = new Set();
  if (typeof content !== 'string' || content === '') return out;
  const clean = content.replace(/^\uFEFF/, '');

  // Split into (frontmatter region @ line 2..k) + (body @ line k+2..) so matched
  // lines map back to the real file line. We scan BOTH regions with the same rules.
  let fmText = '';
  let fmLineBase = 0;
  let bodyText = clean;
  let bodyLineBase = 1;
  const fmMatch = clean.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/);
  if (fmMatch) {
    fmText = fmMatch[1];
    fmLineBase = 2; // line 1 is the opening "---"
    bodyText = fmMatch[2] ?? '';
    // body begins after: "---\n" + fmText + "\n---\n"
    const fmLines = fmText.split(/\r?\n/).length;
    bodyLineBase = 1 /*open*/ + fmLines /*fm body*/ + 1 /*close ---*/ + 1; // first body line
  }

  // De-obfuscate each region BEFORE matching (Unicode confusables/full-width/
  // zero-width + bounded intra-word space-split of override keywords). Newline-
  // preserving, so line numbers computed on the result still map to the file.
  const fmNorm = fmText ? collapseKeywordSpaces(normalizeForMatch(fmText)) : '';
  const bodyNorm = collapseKeywordSpaces(normalizeForMatch(bodyText));

  for (const spec of RULES) {
    if (fmNorm) runRule(spec, fmNorm, fmLineBase, relPath, out, seen);
    runRule(spec, bodyNorm, bodyLineBase, relPath, out, seen);
  }
  // Defang-IOC runs on the normalized regions (medium signal).
  if (fmNorm) runDefangedIoc(fmNorm, fmLineBase, relPath, out, seen);
  runDefangedIoc(bodyNorm, bodyLineBase, relPath, out, seen);
  // Hidden-carrier runs over the whole RAW file (comments/blobs may straddle
  // regions and must be inspected pre-normalization).
  runHiddenCarrier(clean, relPath, out, seen);

  return out;
}

/**
 * Read a file as UTF-8 text, capped at MAX_BYTES. Returns '' on any failure.
 * @param {string} abs
 * @returns {string}
 */
function readTextCapped(abs) {
  try {
    const fd = fs.openSync(abs, 'r');
    try {
      const buf = Buffer.alloc(MAX_BYTES);
      const n = fs.readSync(fd, buf, 0, MAX_BYTES, 0);
      return buf.toString('utf8', 0, n);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/**
 * Enumerate scannable text files under a directory (recursive, fail-open), pruning
 * SKIP_DIRS and binary-ish extensions. Returns absolute paths, capped for safety.
 * @param {string} dir
 * @returns {string[]}
 */
function collectTextFiles(dir) {
  /** @type {string[]} */
  const out = [];
  const stack = [dir];
  let guard = 0;
  while (stack.length && guard++ < 50000) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — fail-open
    }
    for (const ent of entries) {
      const name = ent.name;
      const full = path.join(cur, name);
      try {
        if (ent.isSymbolicLink()) continue; // do not follow symlinks out of the candidate
        if (ent.isDirectory()) {
          if (SKIP_DIRS.has(name)) continue;
          stack.push(full);
        } else if (ent.isFile()) {
          if (TEXT_EXT.has(path.extname(name).toLowerCase())) out.push(full);
        }
      } catch {
        continue; // stat failure — skip, fail-open
      }
    }
    if (out.length >= 5000) break; // hard cap
  }
  return out;
}

/**
 * Scan a single CANDIDATE resource for prompt-injection / content-manipulation
 * signatures. The candidate is treated as UNTRUSTED DATA: read + pattern-matched,
 * NEVER executed or interpreted (ADR-0017 §5a; rules/prompt-defense-baseline.md).
 *
 * `candidatePath` may be a single file OR a staging directory; a directory is
 * walked for scannable text files. FAIL-CLOSED: any error that prevents scanning
 * the candidate degrades to `{ verdict: "flagged", findings: [<needs-review note>] }`
 * and NEVER throws — an unscannable untrusted candidate must not pass the gate.
 *
 * @param {string} candidatePath Absolute path to the candidate file or staging dir.
 * @returns {ScanResult}
 */
export function scanInjection(candidatePath) {
  try {
    if (typeof candidatePath !== 'string' || candidatePath === '') {
      return {
        verdict: 'flagged',
        findings: [
          {
            rule: 'needs-review',
            severity: 'medium',
            path: '',
            line: null,
            evidence: '',
            message: 'scan-injection received no candidate path — could not scan; an unscannable candidate is flagged for review (fail-closed).',
          },
        ],
      };
    }

    let st;
    try {
      st = fs.statSync(candidatePath);
    } catch (e) {
      return {
        verdict: 'flagged',
        findings: [
          {
            rule: 'needs-review',
            severity: 'medium',
            path: candidatePath,
            line: null,
            evidence: '',
            message: `scan-injection could not stat candidate (${e && e.message ? e.message : String(e)}) — could not scan; flagged for review (fail-closed).`,
          },
        ],
      };
    }

    /** @type {Array<{abs:string, rel:string}>} */
    let files = [];
    let base = candidatePath;
    if (st.isDirectory()) {
      base = candidatePath;
      for (const abs of collectTextFiles(candidatePath)) {
        files.push({ abs, rel: toPosixRel(candidatePath, abs) });
      }
    } else if (st.isFile()) {
      files.push({ abs: candidatePath, rel: path.basename(candidatePath) });
    } else {
      return {
        verdict: 'flagged',
        findings: [
          {
            rule: 'needs-review',
            severity: 'medium',
            path: candidatePath,
            line: null,
            evidence: '',
            message: 'scan-injection candidate is neither a regular file nor a directory — could not scan; flagged for review (fail-closed).',
          },
        ],
      };
    }

    /** @type {ScanFinding[]} */
    const findings = [];
    for (const { abs, rel } of files) {
      try {
        const content = readTextCapped(abs);
        for (const f of scanContent(content, rel)) findings.push(f);
      } catch {
        // Per-file fail-CLOSED: one torn file never aborts the whole scan, but an
        // unscannable file within the candidate is surfaced as needs-review (medium)
        // so a partially-unreadable untrusted candidate does not silently pass.
        findings.push({
          rule: 'needs-review',
          severity: 'medium',
          path: rel,
          line: null,
          evidence: '',
          message: 'scan-injection could not read a candidate file — could not scan it; flagged for review (fail-closed).',
        });
      }
    }

    const flagged = findings.some((f) => f.severity === 'high' || f.severity === 'medium');
    return { verdict: flagged ? 'flagged' : 'clean', findings };
  } catch (e) {
    // Top-level fail-CLOSED: a torn input never crashes the admission pipeline, but an
    // unscannable untrusted candidate must NOT pass the gate — it is flagged for review.
    return {
      verdict: 'flagged',
      findings: [
        {
          rule: 'needs-review',
          severity: 'medium',
          path: typeof candidatePath === 'string' ? candidatePath : '',
          line: null,
          evidence: '',
          message: `scan-injection failed (${e && e.message ? e.message : String(e)}) — could not scan; flagged for review (fail-closed); never throws.`,
        },
      ],
    };
  }
}

/**
 * POSIX-style candidate-relative path of `abs` under `base`.
 * @param {string} base
 * @param {string} abs
 * @returns {string}
 */
function toPosixRel(base, abs) {
  try {
    return path.relative(base, abs).split(path.sep).join('/') || path.basename(abs);
  } catch {
    return path.basename(abs);
  }
}

export default { scanInjection };

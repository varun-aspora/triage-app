// The Report schema that finish_report validates and src/report renders
// (LLD 04 §2.9, HLD 02 §6). It builds on the shared shapes in
// src/types/report.ts and adds the rules the shared file leaves to src/report:
//
// - suggested_fix commands carry hosts, tokens and DSNs only as $VAR
//   placeholders (D35); checkPlaceholders() is the check.
// - escalated: true needs at least one escalation reason.
// - every current_state item has taken_at (already required by the shared
//   CurrentStateItemSchema; kept here as a point-in-time rule of the report).
//
// There is no root_cause.service field (D42): service attribution comes from
// root_cause.code_refs[].repo through the registry.
import * as v from 'valibot';
import {
  ReportSchema as BaseReportSchema,
  SuggestedFixSchema as BaseSuggestedFixSchema,
  type SuggestedFixKind,
} from '../types/report.ts';

// ---------------------------------------------------------------------------
// Placeholder check

// A placeholder is $NAME or ${NAME}. Positional SQL parameters ($1) are not.
const PLACEHOLDER = String.raw`\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})`;
const PLACEHOLDER_START = new RegExp(`^${PLACEHOLDER}`);
const PLACEHOLDER_ONLY = new RegExp(`^${PLACEHOLDER}$`);

// Database URL schemes. Any literal use is a DSN; the command must read the
// DSN from a variable instead (psql "$SSFB_HARBOR_DB_URL").
const DSN_SCHEME = /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|jdbc:[a-z0-9]+):\/\//i;

// user:pass@host, with or without a scheme. Both user and password must be
// placeholders.
const USERINFO = /(?:^|[\s"'=(/])([^\s"'=(/@:]+):([^\s"'@/]+)@[^\s"'@]/g;

// Any scheme://. The host after it must be a placeholder.
const URL_SCHEME = /\b[a-z][a-z0-9+.-]*:\/\/(.?)/gi;

// Header names whose value is a credential.
const CREDENTIAL_HEADER = /^(?:authorization|proxy-authorization|cookie|[\w-]*(?:token|api-?key|secret|password|auth)[\w-]*)$/i;
// An optional auth scheme word in front of the credential.
const AUTH_SCHEME_WORD = /^(?:bearer|basic|token|digest|apikey|api-key)$/i;
// Variable names in an inline assignment (TOKEN=... curl) that must hold a
// placeholder, not a literal.
const SENSITIVE_ASSIGNMENT = /(?:token|secret|pass|key|auth|url|host|dsn)/i;

// curl options that take a value in the next argument.
const CURL_VALUE_OPTIONS = new Set([
  '-X', '--request', '-H', '--header', '-d', '--data', '--data-raw', '--data-binary',
  '--data-urlencode', '--data-ascii', '--json', '-F', '--form', '--form-string', '-o',
  '--output', '-u', '--user', '-x', '--proxy', '-U', '--proxy-user', '--url', '--resolve',
  '--connect-to', '-A', '--user-agent', '-e', '--referer', '-b', '--cookie', '-c',
  '--cookie-jar', '-m', '--max-time', '--connect-timeout', '-w', '--write-out', '-T',
  '--upload-file', '--cacert', '--capath', '-E', '--cert', '--key', '-K', '--config',
  '--retry', '--retry-delay', '--retry-max-time', '-r', '--range', '-D', '--dump-header',
  '--oauth2-bearer', '-Y', '--speed-limit', '-y', '--speed-time', '--limit-rate',
  '--max-redirs', '--interface', '--noproxy', '--proto', '-z', '--time-cond',
]);
// Short curl options that take a value, for clusters such as -sSXPOST.
const CURL_SHORT_VALUE = new Set('XHdFouxUAebcmwTEKrDYyz'.split(''));

type Token = { text: string; op: boolean };

// Splits a shell command into words and operators. Quotes are removed, a
// backslash-newline is a space, and an unquoted newline is a ';'. This is only
// good enough to find curl arguments; nothing is ever executed.
function tokenize(command: string): Token[] {
  const tokens: Token[] = [];
  let word = '';
  let inWord = false;
  const flush = () => {
    if (inWord) tokens.push({ text: word, op: false });
    word = '';
    inWord = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === '\\') {
      const next = command[i + 1];
      if (next === '\n') {
        flush();
        i++;
        continue;
      }
      if (next !== undefined) {
        word += next;
        inWord = true;
        i++;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      const end = command.indexOf(c, i + 1);
      const stop = end === -1 ? command.length : end;
      word += command.slice(i + 1, stop);
      inWord = true;
      i = stop;
      continue;
    }
    if (c === '\n' || c === ';' || c === '|' || c === '&' || c === '>' || c === '<') {
      flush();
      tokens.push({ text: c === '\n' ? ';' : c, op: true });
      continue;
    }
    if (/\s/.test(c)) {
      flush();
      continue;
    }
    word += c;
    inWord = true;
  }
  flush();
  return tokens;
}

function isPlaceholderUrl(value: string): boolean {
  if (PLACEHOLDER_START.test(value)) return true;
  // scheme://$HOST/... keeps the host out of the text.
  const m = /^[a-z][a-z0-9+.-]*:\/\/(.*)$/i.exec(value);
  return m !== null && PLACEHOLDER_START.test(m[1]!);
}

function checkHeader(header: string, problems: string[]): void {
  const colon = header.indexOf(':');
  if (colon === -1) return;
  const name = header.slice(0, colon).trim();
  if (!CREDENTIAL_HEADER.test(name)) return;
  const parts = header.slice(colon + 1).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 2 && AUTH_SCHEME_WORD.test(parts[0]!)) parts.shift();
  if (parts.length !== 1 || !PLACEHOLDER_ONLY.test(parts[0]!)) {
    problems.push(`the ${name} header value must be a $VAR placeholder`);
  }
}

function checkCredentialPair(value: string, what: string, problems: string[]): void {
  const parts = value.split(':');
  if (!parts.every((p) => PLACEHOLDER_ONLY.test(p))) {
    problems.push(`the ${what} value must be $VAR placeholders`);
  }
}

function checkCurlOptionValue(option: string, value: string, problems: string[]): void {
  switch (option) {
    case '-H':
    case '--header':
      checkHeader(value, problems);
      break;
    case '-u':
    case '--user':
    case '-U':
    case '--proxy-user':
      checkCredentialPair(value, option, problems);
      break;
    case '--oauth2-bearer':
      if (!PLACEHOLDER_ONLY.test(value)) problems.push(`the ${option} value must be a $VAR placeholder`);
      break;
    case '--url':
    case '-x':
    case '--proxy':
    case '--resolve':
    case '--connect-to':
      if (!isPlaceholderUrl(value)) problems.push(`the ${option} value must start with a $VAR placeholder`);
      break;
    default:
      break;
  }
}

// Walks the words of each curl invocation. Returns how many curl invocations
// were found.
function checkCurlInvocations(command: string, problems: string[]): number {
  const tokens = tokenize(command);
  let curls = 0;
  let atStart = true;
  let inCurl = false;
  let pendingOption: string | null = null;
  let urlIndex = 0;
  for (const token of tokens) {
    if (token.op) {
      atStart = true;
      inCurl = false;
      pendingOption = null;
      continue;
    }
    const text = token.text;
    if (atStart) {
      const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(text);
      if (assignment) {
        const [, name, value] = assignment;
        if (SENSITIVE_ASSIGNMENT.test(name!) && value !== '' && !PLACEHOLDER_START.test(value!)) {
          problems.push(`the inline assignment ${name} must take a $VAR placeholder`);
        }
        continue;
      }
      atStart = false;
      inCurl = text === 'curl' || text.endsWith('/curl');
      if (inCurl) curls++;
      urlIndex = 0;
      continue;
    }
    if (!inCurl) continue;
    if (pendingOption !== null) {
      checkCurlOptionValue(pendingOption, text, problems);
      pendingOption = null;
      continue;
    }
    if (text.startsWith('--')) {
      const eq = text.indexOf('=');
      if (eq !== -1) {
        checkCurlOptionValue(text.slice(0, eq), text.slice(eq + 1), problems);
      } else if (CURL_VALUE_OPTIONS.has(text)) {
        pendingOption = text;
      }
      continue;
    }
    if (text.startsWith('-') && text.length > 1) {
      // A cluster of short options; the first one that takes a value ends it.
      for (let i = 1; i < text.length; i++) {
        const letter = text[i]!;
        if (!CURL_SHORT_VALUE.has(letter)) continue;
        const rest = text.slice(i + 1);
        if (rest === '') pendingOption = `-${letter}`;
        else checkCurlOptionValue(`-${letter}`, rest, problems);
        break;
      }
      continue;
    }
    urlIndex++;
    if (!isPlaceholderUrl(text)) {
      problems.push(`curl URL argument ${urlIndex} must start with a $VAR placeholder`);
    }
  }
  return curls;
}

function checkDsn(command: string, problems: string[]): void {
  if (DSN_SCHEME.test(command)) {
    problems.push('a literal database URL is not allowed; read the DSN from a $VAR placeholder');
  }
  for (const m of command.matchAll(USERINFO)) {
    if (!PLACEHOLDER_ONLY.test(m[1]!) || !PLACEHOLDER_ONLY.test(m[2]!)) {
      problems.push('literal user:pass@ credentials are not allowed; use $VAR placeholders');
      break;
    }
  }
}

function checkLiteralUrls(command: string, problems: string[]): void {
  for (const m of command.matchAll(URL_SCHEME)) {
    if (m[1] !== '$') {
      problems.push('a literal URL is not allowed; the host must be a $VAR placeholder');
      return;
    }
  }
}

function checkLiteralBearer(command: string, problems: string[]): void {
  for (const m of command.matchAll(/\bbearer\s+(\S+)/gi)) {
    const value = m[1]!.replace(/["']+$/, '');
    if (!PLACEHOLDER_ONLY.test(value)) {
      problems.push('a literal bearer token is not allowed; use a $VAR placeholder');
      return;
    }
  }
}

function checkSqlHost(command: string, problems: string[]): void {
  for (const m of command.matchAll(/(?:^|\s)(?:-h\s*|--host(?:=|\s+))(["']?)(\S+)/g)) {
    const value = m[2]!.replace(/["']+$/, '');
    if (!PLACEHOLDER_START.test(value)) {
      problems.push('the psql host must be a $VAR placeholder');
      return;
    }
  }
}

/**
 * Checks that a suggested_fix command names hosts, tokens and DSNs only as
 * $VAR or ${VAR} placeholders (D35). Returns the problems found; an empty
 * array means the command passes. Problems never quote the offending value,
 * because it may be a secret.
 *
 * - every kind: no literal DSN (postgres://..., user:pass@host)
 * - curl: each URL argument and every scheme:// in the text starts with a
 *   placeholder host; Authorization and token-like header values, -u and
 *   bearer tokens are placeholders; the command runs curl at least once
 * - sql: a psql -h/--host value is a placeholder
 */
export function checkPlaceholders(command: string, kind: SuggestedFixKind): string[] {
  const problems: string[] = [];
  checkDsn(command, problems);
  if (kind === 'curl') {
    checkLiteralUrls(command, problems);
    checkLiteralBearer(command, problems);
    if (checkCurlInvocations(command, problems) === 0) {
      problems.push('a curl fix must run curl');
    }
  } else if (kind === 'sql') {
    checkSqlHost(command, problems);
  }
  return [...new Set(problems)];
}

/** True when the text calls curl somewhere (as a command word, not inside another word). */
export function runsCurl(text: string): boolean {
  return /(?:^|[\s;|&(])curl\s/.test(text);
}

// verify_with is a query or a curl call; it gets the rules of whichever it is.
function verifyKind(text: string): SuggestedFixKind {
  return runsCurl(text) ? 'curl' : 'sql';
}

// ---------------------------------------------------------------------------
// Schemas

export const SuggestedFixSchema = v.pipe(
  BaseSuggestedFixSchema,
  v.rawCheck(({ dataset, addIssue }) => {
    if (!dataset.typed) return;
    const fix = dataset.value;
    for (const problem of checkPlaceholders(fix.command, fix.kind)) {
      addIssue({ message: `suggested_fix "${fix.title}" command: ${problem}` });
    }
    if (fix.verify_with.trim() !== '') {
      for (const problem of checkPlaceholders(fix.verify_with, verifyKind(fix.verify_with))) {
        addIssue({ message: `suggested_fix "${fix.title}" verify_with: ${problem}` });
      }
    }
    for (const precondition of fix.preconditions) {
      for (const problem of checkPlaceholders(precondition, 'manual')) {
        addIssue({ message: `suggested_fix "${fix.title}" precondition: ${problem}` });
      }
    }
  }),
);
export type SuggestedFix = v.InferOutput<typeof SuggestedFixSchema>;

const ReportObjectSchema = v.object({
  ...BaseReportSchema.entries,
  suggested_fix: v.array(SuggestedFixSchema),
});

const ESCALATION_MESSAGE = 'escalation_reasons must list at least one reason when escalated is true';
const hasEscalationReasons = (r: { escalated: boolean; escalation_reasons: string[] }) =>
  !r.escalated || r.escalation_reasons.some((reason) => reason.trim() !== '');

export const ReportSchema = v.pipe(
  ReportObjectSchema,
  v.forward(v.check((r) => hasEscalationReasons(r), ESCALATION_MESSAGE), ['escalation_reasons']),
);
export type Report = v.InferOutput<typeof ReportSchema>;

// The fields the model drafts for finish_report, with the same rules. The
// harness fills run_id, env_label, generated_at, repo_commits and cost.
export const ReportDraftSchema = v.pipe(
  v.omit(ReportObjectSchema, ['run_id', 'env_label', 'generated_at', 'repo_commits', 'cost']),
  v.forward(v.check((r) => hasEscalationReasons(r), ESCALATION_MESSAGE), ['escalation_reasons']),
);
export type ReportDraft = v.InferOutput<typeof ReportDraftSchema>;

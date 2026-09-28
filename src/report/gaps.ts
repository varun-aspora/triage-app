// Merges report gaps that say the same thing (W15, C15). A run's draft can
// carry the same gap several times in slightly different words; the report
// keeps one line per gap, the most specific one.
//
// Each line becomes a list of word tokens: NFKC, lowercase, timestamps, UUIDs
// and digit runs replaced by '#', a short stopword list dropped. Tokens keep
// inner '-', '_', '.' and '/', so a service, table or path name stays one
// token. Two lines are the same gap when either holds:
//   - containment: the shorter line's tokens appear in order, as one
//     contiguous phrase, in the longer one, and the shorter line has at least
//     MIN_CONTAINED tokens. A set check is not enough: 'x not read' is not
//     contained in 'x read, y not read';
//   - resemblance: Jaccard similarity of the two token sets is JACCARD_MIN or
//     more, and neither line names an entity or a service that the other
//     lacks. A name is an entity id, a registry service key or Quickwit
//     service name, or a token with '-', '_', '.' or '/'.
// The line with more tokens wins, at the position of the first line seen, in
// its original text. The result is the same for the same input.
//
// Only the model's gaps go through here. The gaps finish_report adds (commit
// per repo, cost, preflight) differ from each other by one name on purpose
// and keep the exact-match dedupe.
import type { Registry } from '../config/registry.ts';
import { ENTITIES } from '../types/core.ts';

const MIN_CONTAINED = 3;
const JACCARD_MIN = 0.8;

const TIMESTAMP = /\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(z|[+-]\d{2}:?\d{2})?/g;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const TOKEN = /[\p{L}\p{N}#](?:[\p{L}\p{N}#_./-]*[\p{L}\p{N}#])?/gu;
const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'for', 'to', 'in', 'on', 'at', 'by', 'and', 'or', 'as', 'so',
  'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'with', 'from',
]);
const ENTITY_IDS: ReadonlySet<string> = new Set(ENTITIES);

type Line = { readonly text: string; readonly words: readonly string[]; readonly tokens: ReadonlySet<string> };

function wordsOf(text: string): string[] {
  const normal = text.normalize('NFKC').toLowerCase().replace(TIMESTAMP, '#').replace(UUID, '#');
  const words = (normal.match(TOKEN) ?? []).map((w) => w.replace(/\d+/g, '#'));
  return words.filter((w) => !STOPWORDS.has(w));
}

/** Service keys and Quickwit service names from every registry file, lowercased. */
export function registryNames(registry: Pick<Registry, 'entities' | 'services' | 'service'>): Set<string> {
  const names = new Set<string>();
  for (const entity of registry.entities) {
    for (const key of registry.services(entity)) {
      names.add(key.toLowerCase());
      const qw = registry.service(entity, key).quickwit_service;
      if (qw !== undefined) names.add(qw.toLowerCase());
    }
  }
  return names;
}

function namesOnlyIn(a: ReadonlySet<string>, b: ReadonlySet<string>, names: ReadonlySet<string>): boolean {
  for (const t of a) if ((ENTITY_IDS.has(t) || names.has(t) || /[_./-]/.test(t)) && !b.has(t)) return true;
  return false;
}

function containsPhrase(large: readonly string[], small: readonly string[]): boolean {
  for (let i = 0; i + small.length <= large.length; i++) {
    if (small.every((w, j) => large[i + j] === w)) return true;
  }
  return false;
}

function sameGap(a: Line, b: Line, names: ReadonlySet<string>): boolean {
  if (a.tokens.size === 0 || b.tokens.size === 0) return a.text.trim() === b.text.trim();
  const [small, large] = a.words.length <= b.words.length ? [a, b] : [b, a];
  if (small.words.length >= MIN_CONTAINED && containsPhrase(large.words, small.words)) return true;
  let shared = 0;
  for (const t of small.tokens) if (large.tokens.has(t)) shared++;
  const jaccard = shared / (small.tokens.size + large.tokens.size - shared);
  return jaccard >= JACCARD_MIN && !namesOnlyIn(a.tokens, b.tokens, names) && !namesOnlyIn(b.tokens, a.tokens, names);
}

/**
 * One line per gap: near-duplicates merged into the more specific line, in
 * first-seen order. `names` are the registry's service names (registryNames).
 */
export function mergeGaps(gaps: readonly string[], names: ReadonlySet<string> = new Set()): string[] {
  const kept: Line[] = [];
  for (const text of gaps) {
    const words = wordsOf(text);
    const line: Line = { text, words, tokens: new Set(words) };
    const i = kept.findIndex((k) => sameGap(k, line, names));
    if (i === -1) kept.push(line);
    else if (line.words.length > kept[i]!.words.length) kept[i] = line;
  }
  return kept.map((k) => k.text);
}

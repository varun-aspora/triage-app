// Repo AGENTS.md and CLAUDE.md files attached to code tool results (W11, D83).
//
// When a code tool touches a path in a repo, every CLAUDE.md and AGENTS.md on
// the directory chain from the repo root down to that path is attached as
// repo_docs, root first and nearest last, as Claude Code and the AGENTS.md
// standard load them. Files in sibling or child directories are never
// attached; repo_grep gets the root file and the paths of the unsent docs
// on the matched files' chains. @imports are not followed.
//
// Each file is sent once per conversation. The conversation is the
// ToolContext: every delegate render builds a new one, so a WeakMap keyed by
// it gives one sent set per task. usePersistentState throws in a delegate
// render, and the root mounts no code tool. A crash-resumed task renders
// again and so gets the files once more.

import { open } from 'node:fs/promises';
import { posix } from 'node:path';
import type { ToolContext } from '../../types.ts';
import { childRel, parentRel, resolveInRepo } from './jail.ts';

export const DOC_LIMITS = Object.freeze({ maxFileBytes: 8 * 1024, maxResultBytes: 16 * 1024 });

/** Per directory, in Claude Code's order. */
const DOC_NAMES = ['CLAUDE.md', 'AGENTS.md'] as const;
/** A CLAUDE.md that only imports the AGENTS.md next to it adds nothing. */
const ONLY_IMPORTS_AGENTS = /^@(\.\/)?AGENTS\.md$/;

/** What a code tool touched, set by its work() on an ok outcome. */
export type DocsTarget = {
  readonly repo: string;
  /** The directory whose chain is attached, relative to the repo root; '' is the root only. */
  readonly dir: string;
  /** repo_grep: the matched file paths. The unsent docs on their chains are listed, not attached. */
  readonly matched?: readonly string[];
  /** repo_read of a doc file: that file is in the result already, so it is left out and marked sent. */
  readonly self?: string;
};

export type RepoDoc = { readonly path: string; readonly text: string; readonly truncated: boolean };

export type DocsAttachment = {
  /** Fields to add to the tool's data; empty when there is nothing to send. */
  readonly fields: Readonly<Record<string, unknown>>;
  /** Marks the attached files as sent. Called only once the result goes out. */
  readonly commit: () => void;
};

const sentByContext = new WeakMap<ToolContext, Set<string>>();

function sentFor(ctx: ToolContext): Set<string> {
  let sent = sentByContext.get(ctx);
  if (sent === undefined) {
    sent = new Set();
    sentByContext.set(ctx, sent);
  }
  return sent;
}

/** '' and then each directory down to `dir`: 'a/b' gives ['', 'a', 'a/b']. */
export function dirChain(dir: string): string[] {
  const segs = dir.split('/').filter((s) => s !== '');
  return ['', ...segs.map((_, i) => segs.slice(0, i + 1).join('/'))];
}

const docKey = (repo: string, rel: string): string => `${repo}:${rel}`;

/**
 * The unsent doc files in one directory, as jailed paths. A symlinked pair
 * (CLAUDE.md -> AGENTS.md) counts once. A refusal other than a missing file
 * goes into notes with its reason, and its path into refused so the note is
 * given once per task.
 */
function docsIn(
  reposDir: string | undefined,
  repo: string,
  dir: string,
  sent: ReadonlySet<string>,
  seen: Set<string>,
  notes: string[],
  refused: string[],
): { rel: string; path: string }[] {
  const out: { rel: string; path: string }[] = [];
  for (const name of DOC_NAMES) {
    const rel = childRel(dir, name);
    if (sent.has(docKey(repo, rel))) continue;
    const jailed = resolveInRepo(reposDir, repo, rel, { expect: 'file', maxBytes: Number.POSITIVE_INFINITY });
    if (!jailed.ok) {
      if (jailed.code !== 'not_found') {
        notes.push(`${rel} not attached: ${jailed.message}`);
        refused.push(rel);
      }
      continue;
    }
    if (sent.has(docKey(repo, jailed.rel)) || seen.has(jailed.rel)) continue;
    seen.add(jailed.rel);
    out.push({ rel: jailed.rel, path: jailed.path });
  }
  return out;
}

/** The first maxFileBytes of a file, cut back to the last full line when it is longer. */
async function readHead(path: string): Promise<{ text: string; truncated: boolean }> {
  const max = DOC_LIMITS.maxFileBytes;
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(max + 1);
    const { bytesRead } = await fh.read(buf, 0, max + 1, 0);
    const truncated = bytesRead > max;
    let text = buf.subarray(0, Math.min(bytesRead, max)).toString('utf8');
    if (truncated && text.lastIndexOf('\n') > 0) text = text.slice(0, text.lastIndexOf('\n'));
    return { text, truncated };
  } finally {
    await fh.close();
  }
}

/** The docs to attach for one ok outcome. Never throws for a file problem; that goes into the notes. */
export async function repoDocsFor(ctx: ToolContext, target: DocsTarget, signal?: AbortSignal): Promise<DocsAttachment> {
  const reposDir = ctx.config.paths.reposDir;
  const sent = sentFor(ctx);
  const seen = new Set<string>();
  const notes: string[] = [];
  const chain: RepoDoc[] = [];
  const skipped: string[] = [];
  const refused: string[] = [];

  for (const dir of dirChain(target.dir)) {
    for (const doc of docsIn(reposDir, target.repo, dir, sent, seen, notes, refused)) {
      if (doc.rel === target.self) {
        skipped.push(doc.rel);
        continue;
      }
      signal?.throwIfAborted();
      try {
        const { text, truncated } = await readHead(doc.path);
        if (posix.basename(doc.rel) === 'CLAUDE.md' && ONLY_IMPORTS_AGENTS.test(text.trim())) skipped.push(doc.rel);
        else chain.push({ path: doc.rel, text, truncated });
      } catch (err) {
        const code = (err as { code?: unknown } | null)?.code;
        notes.push(`${doc.rel} could not be read (${typeof code === 'string' ? code : 'error'})`);
      }
    }
  }

  // Fill the result cap nearest file first, then keep root-first order.
  let room = DOC_LIMITS.maxResultBytes;
  const kept = new Set<RepoDoc>();
  const pending: string[] = [];
  for (const doc of [...chain].reverse()) {
    const size = Buffer.byteLength(doc.text);
    if (size <= room) {
      kept.add(doc);
      room -= size;
    } else pending.unshift(doc.path);
  }
  const docs = chain.filter((d) => kept.has(d));
  if (docs.some((d) => d.truncated)) {
    notes.push(`files marked truncated were cut at ${DOC_LIMITS.maxFileBytes / 1024} KB; read the rest with repo_read`);
  }
  if (pending.length > 0) {
    notes.push(
      `not attached, to keep repo docs under ${DOC_LIMITS.maxResultBytes / 1024} KB per result: ${pending.join(', ')}; ` +
        'they come with the next code call under that path, or read them with repo_read',
    );
  }

  const listed: string[] = [];
  if (target.matched !== undefined) {
    const dirs = new Set(target.matched.flatMap((p) => dirChain(parentRel(p)).slice(1)));
    const listSeen = new Set<string>();
    for (const dir of [...dirs].sort()) {
      for (const doc of docsIn(reposDir, target.repo, dir, sent, listSeen, [], [])) listed.push(doc.rel);
    }
    if (listed.length > 0) {
      notes.push('docs_to_read are the repo notes that apply to the matched files; read them with repo_read');
    }
  }

  return {
    fields: {
      ...(docs.length > 0 ? { repo_docs: docs } : {}),
      ...(listed.length > 0 ? { docs_to_read: listed } : {}),
      ...(notes.length > 0 ? { repo_docs_notes: notes } : {}),
    },
    commit: () => {
      for (const rel of [...docs.map((d) => d.path), ...skipped, ...refused]) sent.add(docKey(target.repo, rel));
    },
  };
}

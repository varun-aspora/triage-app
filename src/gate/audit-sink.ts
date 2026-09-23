// Where audit lines go. The JSONL sink appends each line to TRIAGE_AUDIT_LOG
// and mirrors it to <runsDir>/<run_id>/audit.jsonl (D20). The memory sink is
// for tests. This file and rules-file.ts are the only files in src/gate that
// touch the filesystem (see purity.test.ts).
//
// Writes are synchronous appends, so lines keep call order and a crash after
// write() returns cannot lose the line.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AuditLine } from '../types/audit.ts';
import { assertAuditLine, serializeAuditLine } from './audit.ts';

export type AuditSink = {
  write(line: AuditLine): void;
};

export type JsonlAuditSinkOptions = {
  /** config value of TRIAGE_AUDIT_LOG, an absolute path. */
  readonly auditLogPath: string;
  /** config value of TRIAGE_RUNS_DIR, an absolute path. */
  readonly runsDir: string;
};

// run_id becomes a path segment, and a line may not come from makeAuditLine,
// so both sinks validate it again.
const checkLine = (line: AuditLine): void => void assertAuditLine(line);

export function createJsonlAuditSink(opts: JsonlAuditSinkOptions): AuditSink {
  return {
    write(line) {
      checkLine(line);
      const record = `${serializeAuditLine(line)}\n`;

      // mkdir -p on every write is cheap and survives a folder removed mid-run.
      mkdirSync(dirname(opts.auditLogPath), { recursive: true });
      appendFileSync(opts.auditLogPath, record, { encoding: 'utf8', flag: 'a' });

      const runDir = join(opts.runsDir, line.run_id);
      mkdirSync(runDir, { recursive: true });
      appendFileSync(join(runDir, 'audit.jsonl'), record, { encoding: 'utf8', flag: 'a' });
    },
  };
}

export type MemoryAuditSink = AuditSink & {
  /** Lines in write order. */
  readonly lines: readonly AuditLine[];
};

export function createMemoryAuditSink(): MemoryAuditSink {
  const lines: AuditLine[] = [];
  return {
    lines,
    write(line) {
      checkLine(line);
      lines.push(line);
    },
  };
}

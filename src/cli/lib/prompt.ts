// Reads one line from stdin: the y/N of `triage post`, and the answer to a
// run's question in `triage wait` and `triage run`. Commands prompt only when
// stdin is a terminal; tests pass a fake reader instead.
import { createInterface } from 'node:readline';
import type { CliIo } from '../types.ts';

/** Shows the question, resolves with the raw line, or null on EOF. */
export type LineReader = (question: string) => Promise<string | null>;

export function linePrompt(io: CliIo, write: (text: string) => void): LineReader {
  return async (question) => {
    const rl = createInterface({ input: io.stdin, crlfDelay: Infinity, terminal: false });
    try {
      write(question);
      const next = await rl[Symbol.asyncIterator]().next();
      return next.done === true ? null : String(next.value);
    } finally {
      rl.close();
    }
  };
}

// codebase_note_evidence: how the single-shape agent saves code findings (D109).
//
// On the agent mount note_evidence takes an entity (D110), so the 'code'
// evidence key needs a tool of its own. It is the same tool as
// code_walker's note_evidence (CodeFindings, stored under 'code', no entity
// or run_id input), plus the agent mount's check: a repo_* or code_* call
// must have returned a result in this run. The name ends in _note_evidence
// like note_evidence (a code_ prefix would put it among the CodeGraph
// tools). The logic lives in note-evidence.tool.ts.

import { createCodeEvidenceTool, CODEBASE_NOTE_EVIDENCE } from './note-evidence.tool.ts';
import type { ToolModule } from './types.ts';

export const toolModule: ToolModule = {
  name: CODEBASE_NOTE_EVIDENCE,
  mounts: ['agent'],
  entities: 'all',
  enabled: () => ({ on: true }),
  create: (ctx) => createCodeEvidenceTool(ctx),
};

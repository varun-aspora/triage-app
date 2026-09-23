// code_callers: `codegraph callers` for one symbol (D11).
import type { ToolModule } from '../types.ts';
import { codeToolModule } from './codegraph-tool.ts';

export const toolModule: ToolModule = codeToolModule({
  name: 'code_callers',
  command: 'callers',
  field: 'symbol',
  description:
    'List what calls one symbol in one repo, from the CodeGraph index. ' +
    'The graph has no cross-repo edges; a caller in another repo will not show.',
  fieldDescription: "The symbol name, e.g. 'ReverseTransfer'.",
});

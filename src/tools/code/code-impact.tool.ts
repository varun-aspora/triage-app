// code_impact: `codegraph impact` for one symbol (D11).
import type { ToolModule } from '../types.ts';
import { codeToolModule } from './codegraph-tool.ts';

export const toolModule: ToolModule = codeToolModule({
  name: 'code_impact',
  command: 'impact',
  field: 'symbol',
  description:
    'Show what a change to one symbol would affect in one repo, from the CodeGraph index. ' +
    'Structural only: it knows nothing about runtime behaviour, DB schema or other repos.',
  fieldDescription: "The symbol name, e.g. 'ReverseTransfer'.",
});

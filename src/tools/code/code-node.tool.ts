// code_node: `codegraph node` for one symbol with its callers and callees (D11).
import type { ToolModule } from '../types.ts';
import { codeToolModule } from './codegraph-tool.ts';

export const toolModule: ToolModule = codeToolModule({
  name: 'code_node',
  command: 'node',
  field: 'symbol',
  description:
    'Show one symbol in one repo with CodeGraph: its source, callers and callees. ' +
    'Use after code_explore when you know the symbol name.',
  fieldDescription: "The symbol name, e.g. 'ReverseTransfer' or 'TransferService.reverse'.",
});

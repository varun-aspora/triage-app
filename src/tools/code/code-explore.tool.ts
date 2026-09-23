// code_explore: `codegraph explore` for a flow or an area of one repo (D11).
import type { ToolModule } from '../types.ts';
import { codeToolModule } from './codegraph-tool.ts';

export const toolModule: ToolModule = codeToolModule({
  name: 'code_explore',
  command: 'explore',
  field: 'query',
  description:
    'Explore a flow or an area of one repo with CodeGraph: relevant source, call paths and blast radius. ' +
    'Give a short phrase or symbol names. Graph output is a lead, not evidence; confirm with repo_read.',
  fieldDescription: "A short phrase or symbol names, e.g. 'transfer reversal webhook'. No shell characters.",
});

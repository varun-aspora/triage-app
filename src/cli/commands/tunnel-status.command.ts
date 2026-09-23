// triage tunnel status [--json]
//
// Reports whether the SSFB DB forward's local port listens and whether
// triage's control socket answers. Always exits 0. The builder lives in
// tunnel-up.command.ts.

import type { CliCommand } from '../types.ts';
import { createTunnelCommand } from './tunnel-up.command.ts';

export const command: CliCommand = createTunnelCommand('status');

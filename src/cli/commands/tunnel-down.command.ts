// triage tunnel down [--json]
//
// Stops the SSFB DB forward through its control socket, and only when triage
// started it; a forward someone else started is left running. Exits 1 when
// the stop fails. The builder lives in tunnel-up.command.ts.

import type { CliCommand } from '../types.ts';
import { createTunnelCommand } from './tunnel-up.command.ts';

export const command: CliCommand = createTunnelCommand('down');

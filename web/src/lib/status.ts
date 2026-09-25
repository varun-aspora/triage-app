// Status colours. These tones are deliberately not the environment accent
// (red in production, green otherwise), so a failed run never looks like the
// production banner and a finished one never looks like the non-production one.

import type { DoctorStatus, RunPhase, RunStatus } from './constants.ts';

export type Tone = 'neutral' | 'muted' | 'amber' | 'rust' | 'info';
export type StatusIcon = 'check' | 'clock' | 'spinner' | 'x' | 'dash' | 'alert';
export type StatusLook = { readonly tone: Tone; readonly icon: StatusIcon };

/** running for every phase that is not completed or failed. */
export function runStatusOf(phase: RunPhase): RunStatus {
  return phase === 'completed' || phase === 'failed' ? phase : 'running';
}

export function runStatusTone(status: RunStatus): StatusLook {
  switch (status) {
    case 'completed':
      return { tone: 'neutral', icon: 'check' };
    case 'failed':
      return { tone: 'rust', icon: 'x' };
    case 'running':
      return { tone: 'info', icon: 'spinner' };
  }
}

export function runPhaseTone(phase: RunPhase): StatusLook {
  return runStatusTone(runStatusOf(phase));
}

export function doctorStatusTone(status: DoctorStatus): StatusLook {
  switch (status) {
    case 'ok':
      return { tone: 'neutral', icon: 'check' };
    case 'warn':
      return { tone: 'amber', icon: 'alert' };
    case 'fail':
      return { tone: 'rust', icon: 'x' };
    case 'disabled':
    case 'skipped':
      return { tone: 'muted', icon: 'dash' };
  }
}

export function syncResultTone(status: 'ok' | 'skipped' | 'failed'): StatusLook {
  switch (status) {
    case 'ok':
      return { tone: 'neutral', icon: 'check' };
    case 'skipped':
      return { tone: 'muted', icon: 'dash' };
    case 'failed':
      return { tone: 'rust', icon: 'x' };
  }
}

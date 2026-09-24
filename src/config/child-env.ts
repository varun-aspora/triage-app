// The environment a child process starts with: this process's environment
// plus the variables a caller adds. Only src/config/ reads process.env (a
// source guard enforces it), so the exec runner builds child environments
// here.

/** A copy of process.env with `extra` on top. Nothing is written to process.env. */
export function childEnv(extra: Readonly<Record<string, string>>): Record<string, string | undefined> {
  return { ...process.env, ...extra };
}

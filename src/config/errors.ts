// Config errors carry key names and fixed reasons only. A value read from a
// .env file must never reach an error message, because error text ends up in
// terminals, logs and transcripts.

export type ConfigProblem = {
  readonly key: string;
  readonly reason: string;
};

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  readonly keys: readonly string[];
  readonly problems: readonly ConfigProblem[];

  constructor(problems: readonly ConfigProblem[]) {
    const list = problems.length > 0 ? problems : [{ key: 'config', reason: 'invalid' }];
    super(`invalid config: ${list.map((p) => `${p.key} ${p.reason}`).join('; ')}`);
    this.problems = Object.freeze(list.map((p) => Object.freeze({ key: p.key, reason: p.reason })));
    this.keys = Object.freeze([...new Set(list.map((p) => p.key))]);
  }

  static of(key: string, reason: string): ConfigError {
    return new ConfigError([{ key, reason }]);
  }
}

# Overriding built-ins and remote execution

## Overriding a built-in tool

Register a tool with the same name as a built-in to replace it. Overridable
built-ins: `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`.
Interactive mode shows a warning when an override happens.

```bash
pi -e ./tool-override.ts        # extension's read replaces built-in read
pi --no-builtin-tools -e ./x.ts # no built-ins at all, only extension tools
```

**Rendering is inherited per slot.** Execution and rendering override
independently: omit `renderCall` and the built-in one is used; omit
`renderResult` and the built-in one is used; omit both and you get full built-in
rendering (syntax highlighting, diffs, line numbers). This is what makes a
logging or access-control wrapper cheap to write.

**Prompt metadata is not inherited.** `promptSnippet` and `promptGuidelines`
must be redeclared on the override if you want them.

**Your result shape must match the built-in exactly**, including the `details`
type. The UI and session logic depend on it. Reference implementations:
[read.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/read.ts)
(`ReadToolDetails`),
[bash.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/bash.ts)
(`BashToolDetails`),
[powershell.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/powershell.ts),
[edit.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/edit.ts),
[write.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/write.ts),
[grep.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/grep.ts),
[find.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/find.ts),
[ls.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/ls.ts).

### Override or `tool_call`?

Use **`tool_call`** to gate, audit, or patch arguments — it is less code and
doesn't couple you to the result shape. Use an **override** when you need to
change how the work is actually done: a different backend, a different
algorithm, a different data source.

## Pluggable operations

Built-in tools accept `operations`, so you can keep pi's argument handling,
truncation, and rendering while delegating the I/O elsewhere.

```typescript
import { createReadTool, createBashTool, type ReadOperations } from "@earendil-works/pi-coding-agent";

const remoteRead = createReadTool(cwd, {
  operations: {
    readFile: (path) => sshExec(remote, `cat ${path}`),
    access: (path) => sshExec(remote, `test -r ${path}`).then(() => {}),
  },
});

// Decide per call, at execution time
pi.registerTool({
  ...remoteRead,
  async execute(id, params, signal, onUpdate, _ctx) {
    const ssh = getSshConfig();
    if (ssh) {
      const tool = createReadTool(cwd, { operations: createRemoteOps(ssh) });
      return tool.execute(id, params, signal, onUpdate);
    }
    return localRead.execute(id, params, signal, onUpdate);
  },
});
```

Interfaces: `ReadOperations`, `WriteOperations`, `EditOperations`,
`BashOperations`, `PowerShellOperations`, `LsOperations`, `GrepOperations`,
`FindOperations`.

For the user's `!` commands, reuse pi's local backend with
`createLocalBashOperations()` rather than reimplementing process spawning,
shell resolution, and process-tree termination — see
[bash/user_bash.md](bash/user_bash.md).

## Spawn hook

`bash` and `powershell` accept a `spawnHook` to adjust command, cwd, or env
before execution — lighter than a full operations backend.

```typescript
const bashTool = createBashTool(cwd, {
  spawnHook: ({ command, cwd, env }) => ({
    command: `source ~/.profile\n${command}`,
    cwd: `/mnt/sandbox${cwd}`,
    env: { ...env, CI: "1" },
  }),
});
```

`createBashTool()` and `createPowerShellTool()` expose the session to commands
through `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, and
`PI_REASONING_LEVEL`. Injection happens **before** `spawnHook`, so hooks receive
them in `env` and preserve them by spreading the existing environment as above.
Disable with `exposeSessionEnvironment: false`.

## Where this is used

- **SSH / remote dev** — run tools against a build box while pi runs locally
  (`ssh.ts`).
- **Containers and micro-VMs** — route reads, writes, and bash into an isolated
  environment (`sandbox/`, `gondolin/`).
- **Auditing and access control** — the `tool-override.ts` example wraps `read`
  to log every access and block `.env`, secrets, credentials, and
  `.ssh`/`.aws`/`.gnupg` paths, while inheriting the built-in renderer.
- **Environment normalization** — make every command see the same profile,
  toolchain version, and env vars.

## Gotchas

- Override the model's `bash` tool **and** handle `user_bash` if you want `!`
  commands to run in the same place. They are separate paths, and the mismatch
  is confusing: the model edits files in a container while the user's `!ls`
  lists the host.
- If you override a mutating tool, keep using `withFileMutationQueue()` — see
  [tools.md](tools.md).
- Overriding a built-in and getting the `details` shape wrong breaks rendering
  in ways that look like a TUI bug rather than an extension bug.

## See also

[tools.md](tools.md) · [tool/tool_call.md](tool/tool_call.md) ·
[bash/user_bash.md](bash/user_bash.md)

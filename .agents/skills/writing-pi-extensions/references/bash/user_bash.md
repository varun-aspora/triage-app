# user_bash

**Fires:** when the *user* runs a `!` or `!!` command. Not the model's `bash`
tool — that is [../tool/tool_call.md](../tool/tool_call.md).
**Can change:** yes — can supply a backend, or replace the result outright.

## Signature

```typescript
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";

pi.on("user_bash", (event, ctx) => {
  // event.command            - the bash command
  // event.excludeFromContext - true for the !! prefix
  // event.cwd                - working directory

  // 1. Supply a different backend (SSH, container, micro-VM)
  return { operations: remoteBashOps };

  // 2. Wrap pi's built-in local backend
  const local = createLocalBashOperations();
  return {
    operations: {
      exec(command, cwd, options) {
        return local.exec(`source ~/.profile\n${command}`, cwd, options);
      },
    },
  };

  // 3. Full replacement — record a result without executing
  return { result: { output: "...", exitCode: 0, cancelled: false, truncated: false } };
});
```

## Return value

- `undefined` — continue to the next handler, then to local execution.
- `{ operations }` — run the command through your backend.
- `{ result }` — record a completed command **without executing it**.

A valid result stops propagation.

## Where to use it

- **Remote execution** — run the user's `!` commands over SSH on the same host
  the model's tools target, so both stay consistent (`ssh.ts` in the pi
  examples).
- **Containers and sandboxes** — route into Docker or a micro-VM
  (`gondolin/`).
- **Persistent shell** — keep one long-lived shell so `cd` and exports survive
  between `!` commands (`interactive-shell.ts`).
- **Environment setup** — source a profile, activate a venv, set `CI=1`.
- **Intercept without running** — return a canned `result` for a command you
  want to stub or forbid.

## Gotchas

- `createLocalBashOperations()` gives you pi's real local backend — shell
  resolution, process-tree termination, the lot. Wrap it rather than
  reimplementing `spawn`.
- Honour `excludeFromContext`; `!!` means the user deliberately kept the output
  out of the conversation.
- This does not affect the model's `bash` tool. To route both, also override the
  `bash` tool — see [../overriding-and-remote.md](../overriding-and-remote.md).

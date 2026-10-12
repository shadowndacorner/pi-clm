# Multi-agent context coexistence (fork feature)

Fork roadmap item #1: contexts coexist as files across agents, the facade of
"multiple agent contexts coexist as files" from
[Context Language Models](https://github.com/facebookresearch/context-language-models).

## How it works

pi-subagents runs child pi agents with
`pi --no-extensions --no-skills --no-prompt-templates --no-session --mode rpc`
plus explicit `--extension` paths. The only supported seam for injecting a
plugin into every spawned child is the **required child extensions registry**:
hosts register `registerRequiredChildExtensions({ sessionId, extensions })`
during `session_start` (pi-subagents docs/agents.md §child extensions), and the
registry's entries are loaded by every admitted child runner.

pi-clm hooks that seam through `src/icl/subagents-adapter.ts`:

- on `session_start`, registers `{ id: "pi-clm", path: <package index.ts> }`
  for the current parent session id;
- disposes the registration in `session_shutdown` (idempotent; the registry
  forbids a second registration for the same session, so reloads re-register);
- candidate resolution, best-first: explicit `PI_CLM_SUBAGENTS_MODULE` (file or
  directory) → bare specifier `pi-subagents/required-child-extensions` →
  `$PI_PACKAGE_DIR/pi-subagents/…` → `$PI_MANAGED_INSTALL_ROOT/../npm/…` →
  `$HOME/.pi/agent/npm/node_modules/pi-subagents/…`;
- config: `PI_CLM_SUBAGENTS=off` disables; `PI_CLM_SUBAGENTS=on` forces it and
  surfaces failures as a warning; default is best-effort (silent skip when the
  registry is missing, e.g. in a child or without pi-subagents installed).

Because loading happens **per child process**, every agent — parent and each
child — ends up with its **own private per-session mirror**:
`/tmp/pi-live-context-<sessionId>*/LIVE_CONTEXT.md`. The parent edits its
context; each child edits its own; neither sees the other's context file, and
neither rewrites the other's session.

## Operators' notes

- Children run with `--no-session`: the CLM editing loop works (mirror, edits,
  overflow guard, budget notices), while persistent artifacts (projection
  checkpoints, session settings, transcript records) necessarily stay empty.
- Only local native Pi children load the plugin; `runner.type: external-cli`
  agents never load Pi extensions, and combinations requiring the extension on
  every runner (`requireForAllRunners: true`) are not requested by this
  adapter, so non-Pi-runner agents are unaffected rather than blocked.
- `PI_CLM_MIRROR_DIR` (see docs/icl.md) still applies to children: point it at
  a per-agent mounted volume when tool backends are remote.

## Verification

Unit tests: `src/__tests__/icl-subagents.test.ts` — payload canonicalization,
registration/dispose lifecycle against a stubbed registry module, disable and
force paths.

Live smoke (real model calls; run after `pnpm install`):

```sh
scripts/live-coexistence-smoke.sh
```

The script launches a parent pi with the fork loaded, asks it to delegate one
subagent, and requires the plugin's opt-in `PI_CLM_SMOKE_MARKER` log to show
**two distinct CLM sessions** (parent + child). Recorded result on this machine
(2026-10-11):

```
[smoke] marker entries:
2026-10-12T00:32:31.182Z session 01a12d86-7c88-7297-b208-c66fcce60006
2026-10-12T00:32:39.411Z session 01a12d86-9def-71f7-bbd0-26f9f5630147
[smoke] PASS: parent + at least one child CLM session coexisted
```

No integration blocker was encountered: the required-child-extensions registry
is a documented first-class seam (pi-subagents docs/agents.md and
docs/extension-api.md), and the adapter rides it without patching
pi-subagents internals.

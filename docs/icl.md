# In-context skill evolution (pi-clm fork)

This fork adds the paper's **in-context learning (ICL) skill-optimization loop**
(`clm/clm_icl` in facebookresearch/context-language-models) to the plugin: a
`SKILL.md` steering skill is evolved **from the agent's own pi rollouts**, with
model weights and the harness fixed.

## The loop

Each round, exactly as in the research code:

1. run the current skill (the incumbent) on the training tasks;
2. build a **contrastive note**: pairs of runs of the same task where one did
   better (higher reward, or same reward at lower cost), with a step-indexed
   digest of each run — episodes labelled E1, E2, … so the proposer can cite
   `E3 step 12` style evidence;
3. ask a **proposer model** for N candidate skills: full rewrites with a
   strict output contract (`<<<ANALYSIS>>>` + one `<<<SKILL>>>` block per
   candidate, citing evidence) — the prompt is verbatim from upstream;
4. validate candidates; malformed ones are **dropped, never repaired**
   (frontmatter with name/description; non-empty body; cites an episode or
   step);
5. run every valid candidate on the development tasks;
6. keep the best candidate if it **passes the gate** against the incumbent.

### The gate (ported exactly)

On the dev tasks, with d = mean reward(candidate) − mean reward(incumbent) and
tasks as the unit:

- **paired** SE when both skills were graded on the same task set (per-task
  differences), else **unpaired** sqrt(SEa² + SEb²);
- pass when d > SE, or |d| ≤ SE with lower mean cost in the same metric;
- every dev episode must be graded;
- among passing candidates, those within one SE of the most accurate count as
  tied, and the **cheapest** wins;
- `state.json` tracks the accuracy/cost **Pareto frontier** over all evaluated
  skills.

The proposer only ever sees training rollouts. Selection uses dev tasks, which
default to the training tasks (recorded as `dev_equals_train: true` — biased;
pass `--dev-tasks` for an unbiased gate).

## pi-native pieces (what replaced Harbor/litellm)

| upstream | this fork |
|---|---|
| Harbor tasks via `run_harbor.sh` | **task directories** (below), graded by `grade.sh` |
| `ClmAgent` episodes | real `pi -ne -e <plugin> -p` sessions (`src/icl/runner.ts`) |
| skill → agent via `skill_dirs` | skill → agent via the plugin's `PI_CLM_STEERING` env |
| litellm proposer | proposer runs as pi itself: `pi -ne -p --system-prompt …` (no extensions, no tools, no session) |
| trajectory digests (ATIF/ctx.json) | digests from the pi session JSONL (role, tool calls, per-request input tokens) |

Episode runs are hermetic: `-ne` disables extension discovery, so only this
plugin loads; the session goes to a per-episode `--session-dir`; the work
directory is a fresh temp dir seeded from the task's `files/`.

## The task contract

A task directory:

```
<task>/
  TASK.md      required  the prompt given to the agent
  files/       optional  copied into the fresh work directory
  setup.sh     optional  run in the work directory before the episode
  grade.sh     optional  run after the episode; exit 0 → reward 1, other exits
                         → reward 0; or stdout JSON {"reward": x}
                         (no grade.sh → ungraded episode: missing, not zero)
```

`--tasks` accepts one task dir, a directory of task dirs, or a file listing
dirs (one per line). Return `{"reward": null}` (or omit grade.sh) for a run
that produced no grade — it counts as **missing** and is rerun on resume, not
as zero.

Reward example: `grep -qi banana fruits.md` exit status.

## CLI

```
npx tsx bin/pi-clm-evolve.ts \
  --tasks tasks/train --dev-tasks tasks/dev \
  --proposer-model anthropic/claude-sonnet-4.5 \
  --rounds 5 --candidates 4 --reps 2 --workers 8 \
  --out runs/evo1
```

Flags:

| flag | meaning |
|---|---|
| `--tasks` | training tasks (required) |
| `--dev-tasks` | selection tasks (default: `--tasks`) |
| `--task-description` | text or file shown to the proposer |
| `--pi` | pi binary (default `pi` on PATH) |
| `--ext` | plugin root loaded for episodes (default: this package) |
| `--model` | agent model for pi, provider/id; default: pi's default |
| `--agent-arg` / `--proposer-arg` | extra pi args, repeatable |
| `--cost-metric usd\|tokens\|auto` | `auto` prefers the provider's USD report |
| `--timeout-s` | per-episode timeout (default 1800) |
| `--proposer-model` | default: pi's default model; pass the agent's model for **self-evolution** |
| `--rounds`, `--candidates`, `--reps`, `--pairs` | loop shape (3, 4, 1, 5) |
| `--workers` | episodes run in parallel (default 1) |
| `--patience` | stop after N rounds without a new incumbent (0: never) |
| `--init-skill` | starting skill dir or SKILL.md (default: none) |
| `--out` | run directory (required) |

**Rerun the same command to resume**: graded episodes, proposals and scores in
`state.json` are reused; ungraded episodes are rerun.

## Run directory

```
state.json              incumbent, per-skill scores/gates, round history, frontier
skills/<id>/SKILL.md    every candidate (base = starting skill, if any)
rounds/r<k>/            note.md, proposer_request.txt, proposer_response.txt,
                        analysis.md, gate.json
episodes/<split>/<id>/  one JSON per episode (reward, cost, trajectory path)
trials/<split>/<id>/    the raw pi session JSONL per episode
best_skill/SKILL.md     the final incumbent
```

Evaluate the final skill yourself once on a separate test set. To put the
winner into daily use, point `PI_CLM_STEERING` at its SKILL.md (or pass the
path in the plugin's `/clm config steering` panel).

## Provenance & tests

- Algorithm, note builder, proposer prompt (verbatim copy), and gate: ported
  from `clm/clm_icl` in facebookresearch/context-language-models.
- New tests live in `src/__tests__/icl-*.test.ts` (gate math incl. paired SE,
  contrastive pair selection, note rendering, proposal parsing/validation).
- One caveat inherited from the research code: costs are comparable only when
  every graded episode reports one metric; mixed metrics make a score's cost
  null (the gate then rejects cost-based tie passes).

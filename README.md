# pi-clm

```
  ____ _     __  __
 / ___| |   |  \/  |     
| |   | |   | |\/| |
| |___| |___| |  | |     
 \____|_____|_|  |_|     pi-clm — the agent that manages its own context
```

`pi-clm` is a [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) extension 
that lets the agent manage its own context: the language model can generate functions to 
modify the context (mapped as a file), and the edited version becomes its next input. 
Check our paper [Context Language Models](https://arxiv.org/pdf/2609.37725) and [research
codebase](https://github.com/facebookresearch/context-language-models). 

## Install

This fork (blackcandlelabs/pi-clm) extends upstream with in-context skill
evolution, regression evals, engine fixes, skill wiring and multi-agent
context coexistence — see the feature sections below.

```sh
# this fork, from source (pick one):
pi install git:github.com/blackcandlelabs/pi-clm
pi -e git:github.com/blackcandlelabs/pi-clm        # one session, no install

# upstream v1.0.0 (no fork features):
pi install npm:@lolipopshock/pi-clm
```

Requires Node >= 22 and a recent Pi (`@earendil-works/pi-coding-agent`).
`pi list` confirms the install; the panel opens with `/clm`.

## Quick start

| command | what it does |
|---------|--------------|
| `/clm` | open the panel: **overview** (context size over time + compaction points) <br><img src=".github/images/overview.png" alt="The overview page: context size per request, with two points where the model compacted its own context" width="720"> <br> **input** (what the next request contains) · **edits** (per-revision side-by-side diff) <br><img src=".github/images/edits.png" alt="The edits page: a tool result before and after the model shortened it" width="720">|
| `/clm status` | three lines: next request vs budget, edits, changed settings |
| `/clm config` | open **settings**; `/clm config <setting> <value>` changes one, `/clm config reset` drops this session's changes<br><img src=".github/images/settings.png" alt="The settings page: sizes, guard, files, and every setting" width="720"> |
| `/clm-compact [instructions]` | ask the model to compact its own context now; anything you add (e.g. what to keep) is passed along. The result shows on the **edits** page |
| `/clm on` / `off` / `reset` | enable, use raw context, discard the projection |

In the panel: `1–4` or `Tab` switch pages, `← →` step through compaction points, `z`
zooms the chart, `Enter` opens the selection, `q` closes.

## Multi-agent context coexistence (fork feature)

The plugin registers itself into pi-subagents' required-child-extensions
registry so every spawned child agent loads the same CLM entry and keeps its
own private per-session context mirror: parent and children each manage their
own context as a file. `PI_CLM_SUBAGENTS=off` disables. Details, unit tests and
the live smoke: [docs/multiagent.md](docs/multiagent.md), and
`scripts/live-coexistence-smoke.sh` runs the real-model check.

In this fork the loop ships in the package; `pi install
git:github.com/blackcandlelabs/pi-clm` or `pi -e
git:github.com/blackcandlelabs/pi-clm`; the npm command below installs
upstream instead.

## In-context skill evolution (fork feature)

This fork ports the paper's ICL skill-optimization loop
([clm_icl](https://github.com/facebookresearch/context-language-models)) to pi:
a `SKILL.md` steering skill is evolved from the agent's own pi rollouts with a
contrastive note, a strict-contract proposer, and a paired-SE selection gate.

```sh
npx tsx bin/pi-clm-evolve.ts --tasks tasks/train --dev-tasks tasks/dev \
  --proposer-model anthropic/claude-sonnet-4.5 --rounds 5 --candidates 4 \
  --workers 8 --out runs/evo1
```

Task contract, gate details, run-directory layout and examples:
[docs/icl.md](docs/icl.md). Wire the winner into daily use with
`pi-clm-skill use` (`--run` / `--status` / `--rollback`) — `PI_CLM_STEERING`
then points at the registry's stable `active-skill.md`. The loop is fully resumable; episodes run as real
`pi -ne -e <plugin>` sessions and costs come from the provider's own usage.

## Docs

- [How it works](docs/how-it-works.md) — the mirror, what runs without the model, the panel, safety.
- [Configuration](docs/configuration.md) — budget, reserve, reminders, guard, steering and the other settings.
- [Architecture](docs/architecture.md) — the system as implemented, design notes, known limitations.
- [Development](docs/development.md) — setup, checks, releasing.

## Citation

If you use pi-clm in your research, please cite
[Context Language Models](https://arxiv.org/abs/2609.37725):

```bibtex
@article{shao2026context,
  title   = {Context Language Models},
  author  = {Shao, Rulin and Shen, Shannon Zejiang and Yin, Junjie Oscar and Li, Yuetai and
             Wang, Minheng and Ivison, Hamish and Poovendran, Radha and Lambert, Nathan and
             Xiao, Teng and Lewis, Mike and Yih, Wen-tau and Zettlemoyer, Luke and Koh, Pang Wei},
  journal = {arXiv preprint arXiv:2609.37725},
  year    = {2026}
}
```

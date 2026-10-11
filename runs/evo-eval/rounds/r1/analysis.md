## Ground truth

6/6 episodes at reward 1.00, 0 ungraded, n=0 contrastive pairs. Accuracy is saturated on the training set, so per the loop every candidate below is a **pure-cost lever with an explicit accuracy floor**. Since reward carries no discriminating signal, all levers are derived from step-indexed *cost* behavior: turn counts, per-turn input sizes, and post-solution activity.

## Minimal winning loop (extracted from all six runs)

1. Classify the deliverable: a byte-exact file (E1 step 4, E4 step 12) or a passing named check (E2 step 3).
2. First command IS the compute, not recon: grep the symbol (E1 step 2), awk the total (E6 step 4→5), run-length the codes (E4 step 6).
3. Aggregate in the pipeline; never eyeball raw rows (E4 step 5, E6 step 5).
4. Write the artifact with the write tool; one cheap confirm at most (E3 step 6).
5. Terse DONE immediately after (E1 step 6, E4 step 14).

## Failure-mode table

Reward losses: **none**. The only failure surface left is cost; each row is a step-indexed cost leak attributed to a single structural cause.

| Episode | Step(s) | Leak | Single structural cause |
|---|---|---|---|
| E2 | 3 vs 5,7,9,11 | Check exited 0 at step 3, yet four more verification probes (read check.js, node_modules hunt, `ls -la`, direct import) — zero bytes changed by step 13 | No stop rule for a passing grader |
| E2 | 13 | 1153-ch thinking + 431-token close-out narrating the non-fix | Same — no early-DONE trigger |
| E3 | 2 | `ls` recon turn though step 1 already stated the file exists and is empty | Recon fires without ambiguity |
| E4 | 7 | Printed all 36 positions of `timeout-417` when the answer needed only the max run length | Command output sized to evidence, not to the answer |
| E4 | 4,6,8,10 | Four aggregation passes (freq → runs → run-counts → sed) where one run-length pipeline answers | Multi-pass exploration instead of one compute |
| E5 | 3 | Whole 60-entry file ingested (in=1417 at step 4) to satisfy a 5-word + line-cap deliverable | Full-file-read default |
| E6 | 7 | Hexdump byte-proof of a 14-byte file already echoed at step 5 | Verification overkill |
| E6 | 10→11, 14→15 | Two failed unique-anchor edits against the regenerating live-context mirror *after* the answer was final at step 5; 2373-ch thinking at step 12 | Fighting the mirror instead of EOF-append-or-skip |

## Levers (each cites a concrete step)

- **L1 — Verification economy.** E2 steps 5–11 and E6 step 7 changed no graded bytes; the reward was already earned (E2 step 3, E6 step 5). Cap: the task's own check or one `cat`; at most ONE independent confirmation when a pass is surprising. Predicted: turns ↓ on the E2/E6 class, accuracy flat.
- **L2 — Answer-sized output.** E4's answer came from the step-9 aggregate, never from the step-7 dump; E5's deliverable needed five grep hits, not the step-3 full read. Predicted: per-turn input tokens ↓ sharply (E5 ~1417 → ~200); accuracy held only with a widen-once floor.
- **L3 — Single-pass compute, recon only under ambiguity.** E4 steps 4–10 = four passes where one suffices; E3 step 2 = recon with zero ambiguity. Predicted: turns ↓ ~2 per data task.
- **L4 — Mirror hygiene.** E6 steps 11 and 15: first uniqueness failure is a stop signal; one EOF append or skip. Predicted: removes E6's three post-solution turns (steps 6–8).

## Candidate grid

- **S1 `one-check-done`** = L1+L3 (turn-count lever). Falsifiable: if E2-class tasks actually require the redundant probes to score, accuracy drops — the evidence says they don't (E2 step 13 made no edits, reward 1.00).
- **S2 `answer-sized-io`** = L2+L4 (bytes/context-file lever), with the widen-once floor as regression guard against under-search collapse.

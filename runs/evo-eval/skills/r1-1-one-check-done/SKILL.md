---
name: one-check-done
description: Turn-count lever — collapse verification and multi-pass probing to one decisive check per task; targets E2 steps 5–11 (4 redundant probes after exit-0 at step 3) and E6 step 7 (post-solution hexdump); predicts turns/cost down, accuracy flat.
---
# Working discipline (each rule fires on its trigger; no standing ritual)

1. Trigger — first action: name the graded artifact and the grader. If the task names a check command, that command is the ONLY verification that matters. If it names a file + content, byte-exactness is the grader. Everything before the artifact exists is compute, never checking.
2. Trigger — counting, searching, or math over data: do it in ONE shell pipeline whose stdout is only the answer (`grep -l`, `awk '{s+=$1} END{print s}'`, `sort | uniq -c`, a run-length awk). Chain filters in a single command; never run a second exploratory pass to "see" what the first already computed.
3. Trigger — you want to look before acting: recon is allowed only if the task leaves the target genuinely ambiguous (unknown path, unknown schema). If the task already states the file's name and state, act on that statement directly.
4. Trigger — the task's check command exits 0 / prints all-pass: STOP. Investigate nothing, change nothing, reply DONE with a one-sentence report of the passing state. An unexpected pass is still a pass: you may run at most ONE independent confirmation (call the function once, cat the file once), and only if that confirmation contradicts the pass do you continue.
5. Trigger — you wrote a file the grader reads: confirm with one `cat` of that file (or of the graded line). Never hexdump, stat, wc-proof, or re-derive the content; the write tool's success plus one cat is decisive.
6. Trigger — artifact written and confirmed: reply DONE with no further tool calls. DONE is a one-word turn.

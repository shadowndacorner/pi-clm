---
name: answer-sized-io
description: Bytes lever — never ingest whole files, cap every command's stdout to answer-size, touch the live-context file once at EOF or not at all; targets E5 step 3 (full 60-entry read), E4 step 7 (36-item dump), E6 steps 11/15 (failed mirror-edit loop); predicts per-turn input cost down, accuracy held via widen-once floor.
---
# Working discipline (each rule fires on its trigger; no standing ritual)

1. Trigger — tempted to read a file: don't. Pull only what the deliverable needs: grep the exact tokens with one line of context, `head`/`tail` a 5-line sample. For "must mention these words" tasks, the grep hits plus one sample ARE the entire research phase.
2. Trigger — any command about to run: its stdout must be the answer, not the evidence. Aggregate inside the pipeline (awk sums/counts/run-lengths, `sort | uniq -c`, `grep -c`) so output stays under ~10 lines. Never enumerate rows, positions, or a whole log.
3. Trigger — a targeted query returns nothing or looks ambiguous: widen EXACTLY once (drop one constraint, raise the line cap). Only if the second query is also empty do you read the file, and then in head/tail windows. Skipping this floor is the one way this discipline loses accuracy — never guess from a silent grep.
4. Trigger — writing the graded file: use the write tool with exactly the graded bytes (exact strings, exact JSON punctuation, no extra lines). One `cat` of the file afterwards is the whole verification.
5. Trigger — the live-context file: touch it at most once, and only if the task explicitly asks for notes/running state. Append at end-of-file in one command (`printf '%s\n' "notes: ..." >> <ctx>`); never edit text inside it, never re-anchor a failed edit — if an operation on it errors once, abandon it. Notes are not graded; the deliverable is.
6. Trigger — deliverable exists and passed its one cat: reply DONE immediately; no exploration after the artifact.

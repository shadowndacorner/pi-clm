#!/usr/bin/env python3
"""Audit what pi-clm revisions actually did to context shape.

Reads pi session JSONL (the append-only history, which carries the plugin's
revision entries) and reports, per accepted revision, the shape of the edit:
how many blocks survived, how many were shortened in place, how many were
dropped, and whether the whole-context rewrite path fired. This is the measure
the tidy-pass work is judged on: summarisation wins on tokens and loses on shape.

  scripts/edit-shape-audit.py [SESSION_DIR ...]      # default: ~/.local/state/pi-clm/sessions

Output is a distribution plus per-session lines. Nothing here decides policy;
it makes the shape of an edit visible, which is what the acceptance notice now
reports to the model as well.
"""

from __future__ import annotations

import argparse
import collections
import glob
import json
import os
import re
import statistics
import sys

SHAPES = (
    "single-body edit, nothing removed",
    "multi-body edit with survivors",
    "majority of blocks destroyed",
    "collapse-shaped output (<=3 blocks)",
    "no-op re-render",
    "other",
)


def walk(value):
    stack = [value]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            if isinstance(node.get("checkpoint"), dict) and isinstance(node["checkpoint"].get("editTrace"), dict):
                yield node["checkpoint"]
            stack.extend(node.values())
        elif isinstance(node, list):
            stack.extend(node)


def classify(sources: list[dict], inputs: int, outputs: int) -> str:
    kinds = collections.Counter(entry["kind"] for entry in sources)
    edited = kinds["edited"] + kinds["normalized"]
    removed = kinds["removed"]
    if outputs <= 3 and inputs >= 6:
        return "collapse-shaped output (<=3 blocks)"
    if inputs >= 6 and removed >= 0.5 * inputs:
        return "majority of blocks destroyed"
    if edited == 1 and removed == 0 and not kinds["added"]:
        return "single-body edit, nothing removed"
    if edited + removed == 0:
        return "no-op re-render"
    if edited >= 2 and removed <= 0.5 * inputs:
        return "multi-body edit with survivors"
    return "other"


def audit(paths: list[str]) -> int:
    files = [path for path in paths if os.path.isfile(path)] or sorted(
        glob.glob(os.path.join(paths[0], "*.jsonl")) if paths else []
    )
    shapes = collections.Counter()
    untouched: list[float] = []
    surviving: list[float] = []
    rejections = collections.Counter()
    per_file: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)

    for path in files:
        for line in open(path, "r", encoding="utf-8"):
            if '"editTrace"' not in line and "lastOutcome" not in line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            for checkpoint in walk(entry):
                trace = checkpoint["editTrace"]
                sources = trace["sources"]
                inputs, outputs = trace["sourceMessageCount"], trace["outputMessageCount"]
                shape = classify(sources, inputs, outputs)
                shapes[shape] += 1
                per_file[os.path.basename(path)][shape] += 1
                if inputs >= 6:
                    untouched.append(sum(1 for source in sources if source["kind"] == "kept") / inputs)
                    surviving.append(sum(1 for source in sources if source["kind"] != "removed") / inputs)
            outcome = (entry.get("data") or {}).get("lastOutcome") if isinstance(entry.get("data"), dict) else None
            if isinstance(outcome, dict) and outcome.get("kind") == "rejected":
                reason = re.sub(r"\d+", "N", str(outcome.get("message", "")))[:70]
                rejections[reason] += 1

    accepted = sum(shapes.values())
    print(f"sessions: {len(files)}   accepted revisions: {accepted}")
    for shape in SHAPES:
        count = shapes[shape]
        if count:
            print(f"  {shape:38} {count:5}  ({100 * count / accepted:.0f}%)")
    destroyed = shapes["majority of blocks destroyed"] + shapes["collapse-shaped output (<=3 blocks)"]
    if accepted:
        print(f"  {'edits destroying >=half the blocks':38} {destroyed:5}  ({100 * destroyed / accepted:.0f}%)")
    if untouched:
        print(f"median blocks left byte-identical (>=6 blocks): {statistics.median(untouched):.2f}")
        print(f"median blocks surviving at all (>=6 blocks):    {statistics.median(surviving):.2f}")
    if rejections:
        print(f"\nrejections: {sum(rejections.values())} ({sum(rejections.values()) / max(1, len(files)):.2f} per session)")
        for reason, count in rejections.most_common(6):
            print(f"  {count:4}  {reason}")
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="audit pi-clm edit shape from session JSONL")
    parser.add_argument("paths", nargs="*", default=[os.path.expanduser("~/.local/state/pi-clm/sessions")])
    args = parser.parse_args(argv)
    return audit(args.paths)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

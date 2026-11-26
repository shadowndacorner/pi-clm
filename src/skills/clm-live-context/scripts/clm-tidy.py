#!/usr/bin/env python3
"""Checked patch helper for pi-clm's live-context mirror.

The mirror is the model's own next request: a metadata line, then one block per message
([[CTX_TURN ...]] header + body). Editing it by hand is where edits go wrong — a header
retyped from an older read, a dropped header, an invented id. This helper applies localized
patches, refuses anything that looks like an accident, and never rewrites the whole document.

  clm-tidy.py --file LIVE_CONTEXT.md --list
  clm-tidy.py --file LIVE_CONTEXT.md --patch 41-abc=test suite: 3 passed, T12 failed
  clm-tidy.py --file LIVE_CONTEXT.md --drop 12-def --dry-run

Every patch addresses a block by the id printed in its current header.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import tempfile

META_RE = re.compile(
    r"^\[\[LIVE_CONTEXT version=(\d+) revision=(\d+) document=([0-9a-f]{64}) baseline=([0-9a-f]{64})\]\]$"
)
HEADER_RE = re.compile(
    r"^\[\[CTX_TURN document=([0-9a-f]{64}) index=(\d+) role=([A-Za-z][A-Za-z0-9_-]*) id=([a-zA-Z0-9-]+) protected=(true|false)\]\]$"
)
HEADER_SHAPE = "[[CTX_TURN "


class MirrorError(Exception):
    pass


class Block:
    def __init__(self, header: str, nonce: str, index: int, role: str, block_id: str, protected: bool):
        self.header = header
        self.nonce = nonce
        self.index = index
        self.role = role
        self.id = block_id
        self.protected = protected
        self.body_lines: list[str] = []

    @property
    def body(self) -> str:
        return "\n".join(self.body_lines).strip("\n")

    def size(self) -> int:
        return len(self.header) + len(self.body)


def load(text: str) -> tuple[str, str, dict, list[Block]]:
    lines = text.split("\n")
    if not lines or not META_RE.match(lines[0].strip()):
        raise MirrorError(
            "the mirror's first line is not the current LIVE_CONTEXT metadata line; re-read the file and keep line 1 unchanged"
        )
    meta = META_RE.match(lines[0].strip())
    assert meta
    nonce = meta.group(3)
    blocks: list[Block] = []
    current: Block | None = None
    for line in lines[1:]:
        # Structural lines are recognised only at the start of a line and only in the
        # rendered form, exactly as the plugin's parser matches them. An indented example
        # inside a body ("  [[CTX_TURN ... id=41 ...]]") is conversation content, not a header.
        if line.startswith("[[CTX_TURN document="):
            header = HEADER_RE.match(line.strip())
            if not header:
                raise MirrorError(
                    f"malformed block header: {line[:120]}\n"
                    "copy headers verbatim from the current file; do not retype them"
                )
            if header.group(1) != nonce:
                raise MirrorError(
                    f"stale draft: header nonce {header.group(1)[:12]} does not match this document's nonce "
                    f"{nonce[:12]}. Re-read the mirror and re-apply the edit against the current headers."
                )
            current = Block(line.strip(), header.group(1), int(header.group(2)), header.group(3), header.group(4), header.group(5) == "true")
            blocks.append(current)
            continue
        if line.startswith("[[LIVE_CONTEXT ") or line.startswith("[[CTX_TURN "):
            raise MirrorError(f"unrecognized structural line: {line[:120]}")
        if current is not None:
            current.body_lines.append(line)
    ids = [block.id for block in blocks]
    duplicates = sorted({block_id for block_id in ids if ids.count(block_id) > 1})
    if duplicates:
        raise MirrorError(f"duplicate block ids in the mirror: {', '.join(duplicates)}")
    preamble = "\n".join(lines[1:]).split("[[CTX_TURN document=")[0].rstrip("\n") if len(lines) > 1 else ""
    return lines[0], preamble, {"nonce": nonce, "revision": int(meta.group(2))}, blocks


def render(meta_line: str, preamble: str, blocks: list[Block]) -> str:
    parts = [meta_line]
    if preamble:
        parts.append(preamble)
    for block in blocks:
        parts.append("")
        parts.append(block.header)
        if block.body:
            parts.append(block.body)
    return "\n".join(parts).rstrip("\n") + "\n"


def find(blocks: list[Block], block_id: str) -> Block:
    for block in blocks:
        if block.id == block_id:
            return block
    known = ", ".join(f"{block.id}({block.role})" for block in blocks)
    raise MirrorError(f"no block with id {block_id}. Current ids: {known}")


def shape_report(before_sizes: list[int], after: list[Block], patched: list[str], dropped: list[str]) -> str:
    kept_ids = {block.id for block in after} - set(patched)
    return (
        f"shape: {len(kept_ids)} kept untouched, {len(patched)} shortened in place, "
        f"{len(dropped)} dropped, {len(after)} blocks total; "
        f"{sum(before_sizes)} -> {sum(block.size() for block in after)} characters"
    )


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="apply checked, localized patches to a pi-clm mirror")
    parser.add_argument("--file", required=True, help="path to LIVE_CONTEXT.md")
    parser.add_argument("--list", action="store_true", help="print the metadata line, headers and block sizes only")
    parser.add_argument("--patch", action="append", default=[], metavar="ID=BODY", help="replace one block body in place")
    parser.add_argument("--drop", action="append", default=[], metavar="ID", help="remove one whole block (header + body)")
    parser.add_argument("--dry-run", action="store_true", help="report the result without writing")
    args = parser.parse_args(argv)

    try:
        text = open(args.file, "r", encoding="utf-8").read()
    except OSError as error:
        print(f"cannot read {args.file}: {error}", file=sys.stderr)
        return 2

    try:
        meta_line, preamble, _, blocks = load(text)
    except MirrorError as error:
        print(f"refusing to patch: {error}", file=sys.stderr)
        return 2

    if args.list:
        print(meta_line)
        for block in blocks:
            print(f"{block.header}  # {block.role}, {block.size()} characters")
        return 0

    if not args.patch and not args.drop:
        print("nothing to do: pass --patch ID=BODY and/or --drop ID (or --list)", file=sys.stderr)
        return 2

    before_sizes = [block.size() for block in blocks]
    patched: list[str] = []
    dropped: list[str] = []
    remaining = list(blocks)
    try:
        for spec in args.patch:
            block_id, _, body = spec.partition("=")
            if not body.strip():
                raise MirrorError(f"--patch {block_id}: an empty body deletes a block; use --drop {block_id} to mean that")
            block = find(remaining, block_id.strip())
            block.body_lines = [body.strip()]
            patched.append(block.id)
        for block_id in args.drop:
            block = find(remaining, block_id.strip())
            if block.role == "user":
                raise MirrorError(
                    f"block {block_id} is an owner turn: instructions are not yours to remove. "
                    "Edit its body to retire it instead"
                )
            remaining = [candidate for candidate in remaining if candidate.id != block.id]
            dropped.append(block.id)
    except MirrorError as error:
        print(f"refusing to patch: {error}", file=sys.stderr)
        return 2

    out = render(meta_line, preamble, remaining)
    print(shape_report(before_sizes, remaining, patched, dropped))
    print(f"headers after: {len(remaining)}")
    if args.dry_run:
        for block in remaining:
            print(f"  {block.header}")
        print("(dry run: the mirror was not written)")
        return 0

    try:
        current = open(args.file, "r", encoding="utf-8").read()
    except OSError as error:
        print(f"cannot re-read {args.file}: {error}", file=sys.stderr)
        return 2
    if current != text:
        print(
            "refusing to write: the mirror changed after it was read (another writer, or a re-render at the "
            "start of the next request). Re-run the patch against the current file.",
            file=sys.stderr,
        )
        return 2

    directory = os.path.dirname(os.path.abspath(args.file)) or "."
    handle = tempfile.NamedTemporaryFile("w", dir=directory, prefix=".clm-tidy-", delete=False)
    try:
        handle.write(out)
        handle.flush()
        os.fsync(handle.fileno())
    finally:
        handle.close()
    os.chmod(handle.name, 0o600)
    os.replace(handle.name, args.file)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

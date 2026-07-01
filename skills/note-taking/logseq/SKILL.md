---
name: logseq
description: "Read, search, create, and edit notes in the Logseq graph."
version: 1.0.0
author: community
license: MIT
platforms: [linux, macos, windows]
---

# Logseq Notes

Notes live at `/logseq/pages/notes/`.

## Read a note
`read_file` → `/logseq/pages/notes/<name>.md`

## List all notes
`search_files` → `target: files`, `pattern: *.md`, path `/logseq/pages/notes/`

## Search note content
`search_files` → `target: content`, `file_glob: *.md`, path `/logseq/pages/notes/`

## Create a note
`write_file` → `/logseq/pages/notes/<name>.md`
Use Logseq block syntax — each line starts with `- `.

## Append / edit
`read_file` first, then `patch` for targeted edits or `write_file` for a full rewrite.

---
name: lists
description: Manage named lists (grocery, shopping, errands, packing, etc.). Use when the user wants to add, remove, view, clear, create, or delete any persistent named list.
version: 2.0.0
author: cielarchazure
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [shopping, grocery, list, errands, packing, tracking]
    category: productivity
---

# Lists Manager

Lists live at `/logseq/pages/lists/`. Each list is a `.md` file, one item per bullet block (`- item`).

## Finding a list

`search_files` → `target: files`, `pattern: *.md`, path `/logseq/pages/lists/`

## Inferring the list name

- "grocery list" / "groceries" → `grocery`
- "shopping list" → `to-buy`
- "packing list" → `to-bring`
- Ambiguous → ask: "Which list did you mean?"

Filenames are lowercased, spaces replaced with hyphens.

## Operations

### View a list
`read_file` on `/logseq/pages/lists/<name>.md`

### List all lists
`search_files` → `target: files`, `pattern: *.md`, path `/logseq/pages/lists/`
Then `read_file` each result and show all lists with their contents.

### Add an item
Read the file first and confirm the item is not already there. If not a duplicate, append `- <item>` at the bottom. Show the updated list after.

### Add at beginning / after a specific item / at position
Read the file, insert the line at the right position, write back.

### Remove by name (case-insensitive)
Read the file, remove the matching `- <item>` line, write back. If nothing matched, tell the user.

### Remove by position
Read the file, remove line N (1-indexed), write back.

### Move an item
Read the file, reorder the lines, write back.

### Clear a list
`write_file` with empty content.

### Delete a list
Delete the file.

### Create a new list
Ask first: "List '<name>' doesn't exist. Create it?"
On confirmation: `write_file` at `/logseq/pages/lists/<name>.md`.

## Rules

1. Always show the updated list after any write.
2. Never auto-create a list — ask first.
3. Never add a duplicate item — check first.
4. Each item is one bullet block: `- item`. No nested blocks.

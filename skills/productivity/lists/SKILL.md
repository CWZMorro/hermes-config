---
name: lists
description: Manage named lists (grocery, shopping, errands, packing, etc.). Use when the user wants to add, remove, view, clear, create, or delete any persistent named list. Each list is a separate named file.
version: 1.0.0
author: cielarchazure
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [shopping, grocery, list, errands, packing, tracking]
    related_skills: []
    category: productivity
---

# Lists Manager

Manages any number of named lists. Each list is a plain text file, one item per line.

**Base path (inside container):** `/opt/data/data/lists/`

**Index:** `/opt/data/data/INDEX.md` — always read this first to get the path of an existing list, and always update it when creating a new list.

---

## When to Use

- "Add X to my [list name]"
- "What's on my [list name]?"
- "Remove X from [list name]"
- "Show me all my lists"
- "Create a list called [name]"
- "Clear my [list name]"
- "Delete my [list name]"
- "Add X after Y in [list name]"
- "Move X to the top of [list name]"

## When NOT to Use

- Session-scoped tasks → use the `todo` tool
- Tasks with due dates → use `apple-reminders` skill
- Project tracking → use Kanban tools

---

## Inferring the List Name

If the user doesn't specify a list name, infer from context:
- "shopping list" → `shopping`
- "grocery list" / "groceries" → `grocery`
- "packing list" → `packing`
- Ambiguous with multiple lists existing → ask: "Which list did you mean?"

List names are lowercased, spaces replaced with hyphens: "wine list" → `wine-list`.

---

## Operations

### Step 0 — Always read INDEX.md first

```bash
read_file('/opt/data/data/INDEX.md')
```

Use it to confirm the list's path before any operation.

### Show all existing lists

```bash
ls /opt/data/data/lists/
```

### View a list (with line numbers)

```bash
cat -n /opt/data/data/lists/<name>.txt
```

### Create a new list

**Always ask first:** "List '<name>' doesn't exist. Create it?"
Only create on confirmation:

```bash
touch /opt/data/data/lists/<name>.txt
```

Then immediately update INDEX.md — add a line under `## Lists`:
```
- <Name>: `/opt/data/data/lists/<name>.txt`
```

### Add an item at the end

Check for duplicate first:
```bash
grep -qi "^<item>$" /opt/data/data/lists/<name>.txt && echo "duplicate"
```

If not a duplicate:
```bash
echo "<item>" >> /opt/data/data/lists/<name>.txt
```

### Add an item at the beginning

```bash
sed -i "1i <item>" /opt/data/data/lists/<name>.txt
```

### Add an item after a specific item

```bash
sed -i "/<anchor>/a <new_item>" /opt/data/data/lists/<name>.txt
```

### Add an item before a specific item

```bash
sed -i "/<anchor>/i <new_item>" /opt/data/data/lists/<name>.txt
```

### Add an item at a specific position (1-indexed)

```bash
sed -i "<N>i <item>" /opt/data/data/lists/<name>.txt
```

### Remove an item by name (case-insensitive)

```bash
grep -iv "^<item>$" /opt/data/data/lists/<name>.txt > /tmp/_list_tmp && mv /tmp/_list_tmp /opt/data/data/lists/<name>.txt
```

If nothing matched, tell the user: "Item not found in '<name>'."

### Remove an item by position

```bash
sed -i "<N>d" /opt/data/data/lists/<name>.txt
```

### Move an item to a different position

```bash
python3 -c "
f = '/opt/data/data/lists/<name>.txt'
items = open(f).read().splitlines()
item = items.pop(<from_index>)
items.insert(<to_index>, item)
open(f, 'w').write('\n'.join(items) + '\n')
"
```

### Clear a list (wipe contents, keep the file)

```bash
> /opt/data/data/lists/<name>.txt
```

### Delete a list entirely

```bash
rm /opt/data/data/lists/<name>.txt
```

Then remove its entry from INDEX.md.

### Rename a list

```bash
mv /opt/data/data/lists/<old>.txt /opt/data/data/lists/<new>.txt
```

Then update INDEX.md.

---

## Rules

1. Always read INDEX.md first before any operation.
2. Always show the updated list (with line numbers via `cat -n`) after any write.
3. Never auto-create a list — ask first, create only on confirmation.
4. Clear and delete are immediate — no confirmation needed.
5. Never add duplicate items — check with `grep -qi "^<item>$"` first.
6. When removing by name and nothing matches, tell the user explicitly.
7. Keep one item per line. No bullet points, numbering, or markdown in the file.
8. When creating or deleting a list, always update INDEX.md to reflect the change.

# Data Index

Read this file first whenever the user asks about any list, note, flashcard, or document.
This is the single source of truth for where all user data lives. Do not explore the filesystem to find data — it is all mapped here.

## Lists
- Grocery list: `/opt/data/data/lists/grocery.txt`
- Todo / tasks: use the `todo` tool (`todo_list`, `todo_add`, `todo_complete`)

## Flashcards
Flashcards are stored in Anki (primary) and mirrored as local log files (backup).
When reading or adding flashcards, always interact with Anki via AnkiConnect — not just the local files.
- Git: `/opt/data/data/flashcards/git.md` (local log) / Anki deck: Default

## Notes
*(none yet — create new notes as `/opt/data/data/notes/<topic>.md`)*

## Documents
*(none yet — save generated documents as `/opt/data/data/docs/<filename>`)*

---

**When creating a new file:** save it under the appropriate subdirectory above, then add an entry to this index before confirming to the user. Never save user data outside of `/opt/data/data/`.

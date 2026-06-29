# Data Index

Read this file first whenever the user asks about any list, note, flashcard, or document.
This is the single source of truth for where all user data lives. Do not explore the filesystem to find data — it is all mapped here.

## Lists
All lists are managed by the `lists` skill. Each list is a plain text file, one item per line.
- Grocery: `/opt/data/data/lists/grocery.txt`
- We Be Cooking List: `/opt/data/data/lists/we-be-cooking-list.txt`
- To Buy: `/opt/data/data/lists/to-buy-list.txt`
- To Bring: `/opt/data/data/lists/to-bring-list.txt`
- To Deal With: `/opt/data/data/lists/to-deal-with.txt`

When creating a new list, save it as `/opt/data/data/lists/<name>.txt` and add an entry here before confirming to the user.

## Tasks / Todos
Session-scoped tasks only: use the `todo` tool (`todo_list`, `todo_add`, `todo_complete`).
Do NOT use the `todo` tool for persistent lists — use the `lists` skill instead.

## Flashcards
Flashcards are stored in Anki (primary) and mirrored as local log files (backup).
Always interact with Anki via AnkiConnect — never only the local file.
- Git: `/opt/data/data/flashcards/git.md` (local log) / Anki deck: Default
- Linux: `/opt/data/data/flashcards/linux.md` (local log) / Anki deck: Default
- LazyVim: `/opt/data/data/flashcards/lazyvim.md` (local log) / Anki deck: Default
- Vocabulary: `/opt/data/data/flashcards/vocabulary.md` (local log) / Anki deck: Default
- Shortcut: `/opt/data/data/flashcards/shortcut.md` (local log) / Anki deck: shortcut
- Programming: `/opt/data/data/flashcards/programming.md` (local log) / Anki deck: programming
- Minecraft: `/opt/data/data/flashcards/minecraft.md` (local log) / Anki deck: Minecraft
- MC Facts: `/opt/data/data/flashcards/mc-facts.md` (local log) / Anki deck: mc facts

## Notes
*(none yet — create new notes as `/opt/data/data/notes/<topic>.md`)*

## Documents
*(none yet — save generated documents as `/opt/data/data/docs/<filename>`)*

---

**When creating a new file:** save it under the appropriate subdirectory above, then add an entry to this index before confirming to the user. Never save user data outside of `/opt/data/data/`.

---
name: logseq-flashcards
description: "Create and manage flashcard decks in Logseq."
version: 1.0.0
author: community
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Flashcards, Spaced Repetition, Learning, Logseq]
---

## Content style guidelines

### No 2nd person in card answers

Never use "you", "your", or second-person pronouns in answers. Write impersonally.
Bad: *"your armor loses durability"* → Good: *"armor loses durability"*

### Precision over agreement

Never agree with incorrect phrasing to avoid conflict. Fact-check game mechanics against official wiki sources. The user despises glazing.

### Correction handling

When the user corrects a card: verify the claim first, fix it, say what changed and why — briefly, then move on.

---

# Flashcards in Logseq

Decks live at `/logseq/pages/flashcards/`.

## Finding a deck

`search_files` → `target: files`, `pattern: *.md`, path `/logseq/pages/flashcards/`

If no deck is specified, list available decks and ask the user which one to use.

## Workflow — always follow in order

1. Read the deck file with `read_file`
2. Append the new card(s) at the bottom
3. Read the file again to confirm the card is present
4. Tell the user it's saved

## Card formats

### Basic

```
- Question #card
 - Answer
```

### Vocabulary cloze

**Single-line format (recommended)** — puts everything in one block so Logseq creates a proper cloze card, not a Basic front/back card:

```
- {{cloze Word}} means DEFINITION. e.g. She {{cloze word}} in EXAMPLE SENTENCE. #card
```

**Two-line format (avoid)** — this creates a Basic card where the example becomes the "answer", requiring two taps to reveal the word:

```
- {{cloze Word}} means DEFINITION. #card
 - e.g. She {{cloze word}} in EXAMPLE SENTENCE.
```

### General cloze

```
- The capital of France is {{cloze Paris}}. #card
```

## New deck

Create `/logseq/pages/flashcards/<name>.md`.

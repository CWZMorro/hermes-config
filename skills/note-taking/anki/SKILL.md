---
name: anki
description: "Create flashcards, manage decks, query due cards, and sync via AnkiConnect."
version: 1.1.0
author: community
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Anki, Flashcards, Spaced Repetition, Learning]
prerequisites:
  anki_plugin: "AnkiConnect (plugin ID: 2055492159)"
---

# Anki via AnkiConnect

## Default workflow — always follow this

Whenever flashcards are created, **always do all three steps in order. No exceptions.**

1. Push cards to Anki immediately via AnkiConnect (see below)
2. Trigger AnkiWeb sync so cards appear on all devices
3. Append a record of the cards to the local log at `/opt/data/data/flashcards/<topic>.md`

Never save to the local file without pushing to Anki first. The local file is a backup log, not the primary storage — Anki is.

---

## Endpoint

Hermes runs in Docker on Linux. Always use the Docker bridge gateway IP:

```
http://172.17.0.1:8765
```

(`host.docker.internal` does not work on Linux Docker — use the IP above.)

All requests: `POST`, `Content-Type: application/json`.

```json
{"action": "<action_name>", "version": 6, "params": {...}}
```

---

## Step 1 — Push cards to Anki

### Single card

Use the deck name the user specifies. If none is given, use `"Default"`.

```bash
curl -s -X POST http://172.17.0.1:8765 \
  -H "Content-Type: application/json" \
  -d '{
    "action": "addNote",
    "version": 6,
    "params": {
      "note": {
        "deckName": "<deck name>",
        "modelName": "Basic",
        "fields": {
          "Front": "Question here",
          "Back": "Answer here"
        },
        "options": {"allowDuplicate": false},
        "tags": ["topic"]
      }
    }
  }'
```

Response: `{"result": <note_id>, "error": null}`. If `error` is not null, report the failure.

### Multiple cards at once (preferred for batches)

```bash
curl -s -X POST http://172.17.0.1:8765 \
  -H "Content-Type: application/json" \
  -d '{
    "action": "addNotes",
    "version": 6,
    "params": {
      "notes": [
        {
          "deckName": "<deck name>",
          "modelName": "Basic",
          "fields": {"Front": "Q1", "Back": "A1"},
          "options": {"allowDuplicate": false},
          "tags": ["topic"]
        },
        {
          "deckName": "<deck name>",
          "modelName": "Basic",
          "fields": {"Front": "Q2", "Back": "A2"},
          "options": {"allowDuplicate": false},
          "tags": ["topic"]
        }
      ]
    }
  }'
```

Response: array of note IDs (`null` for duplicates that were skipped).

### Cloze card

```bash
curl -s -X POST http://172.17.0.1:8765 \
  -H "Content-Type: application/json" \
  -d '{
    "action": "addNote",
    "version": 6,
    "params": {
      "note": {
        "deckName": "<deck name>",
        "modelName": "Cloze",
        "fields": {
          "Text": "The capital of France is {{c1::Paris}}.",
          "Back Extra": ""
        },
        "options": {"allowDuplicate": false},
        "tags": []
      }
    }
  }'
```

---

## Step 2 — Sync to AnkiWeb immediately after adding cards

Always run this after every batch of cards is added:

```bash
curl -s -X POST http://172.17.0.1:8765 \
  -H "Content-Type: application/json" \
  -d '{"action": "sync", "version": 6}'
```

Response: `{"result": null, "error": null}` on success.

---

## Step 3 — Append to local log

After cards are confirmed in Anki, append them to `/opt/data/data/flashcards/<topic>.md`. Use a simple format:

```markdown
- **Q:** Question here
  **A:** Answer here
```

If the file doesn't exist yet, create it and add an entry to `/opt/data/data/INDEX.md`.

---

## Other operations

### Create a deck

```bash
curl -s -X POST http://172.17.0.1:8765 \
  -H "Content-Type: application/json" \
  -d '{"action": "createDeck", "version": 6, "params": {"deck": "My Deck"}}'
```

Use `::` for sub-decks: `"deck": "Languages::Spanish"`.

### List all decks

```bash
curl -s -X POST http://172.17.0.1:8765 \
  -H "Content-Type: application/json" \
  -d '{"action": "deckNames", "version": 6}'
```

### Query due cards

```bash
curl -s -X POST http://172.17.0.1:8765 \
  -H "Content-Type: application/json" \
  -d '{"action": "getDeckStats", "version": 6, "params": {"decks": ["Default"]}}'
```

Returns `new_count`, `learn_count`, `review_count` per deck.

### Search notes

```bash
curl -s -X POST http://172.17.0.1:8765 \
  -H "Content-Type: application/json" \
  -d '{"action": "findNotes", "version": 6, "params": {"query": "deck:Default tag:git"}}'
```

---

## If AnkiConnect is unreachable

If the request fails or times out, tell the user: "Anki doesn't appear to be open. Please open Anki and try again." Do not save cards only to the local file and silently skip Anki — always report the failure.

---

## Notes

- Card field names are case-sensitive: "Front"/"Back" for Basic, "Text" for Cloze
- Deck names with spaces must be quoted in queries: `deck:"My Deck"`
- Tags cannot contain spaces — use underscores or hyphens
- `allowDuplicate: false` silently skips cards already in the deck

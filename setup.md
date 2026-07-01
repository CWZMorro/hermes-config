# Ciel AI Azure — Setup

Post-install configuration. Assumes Hermes is already running in Docker.

After cloning this repo to `~/.hermes`, the files `SOUL.md`, `bridge.js`, `config.yaml`, and the skill files are already in place. The only manual steps are below.

---

## Data Structure

All user data (notes, flashcards, lists) lives in the Logseq graph at `~/Logseq/logseq-vault/`, mounted at `/logseq` inside the container:

- Notes → `/logseq/pages/notes/`
- Flashcards → `/logseq/pages/flashcards/`
- Lists → `/logseq/pages/lists/`

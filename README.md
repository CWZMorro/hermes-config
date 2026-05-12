# Hermes Config (Ciel AI Azure v1.0)

Personal configuration and setup guide for [Hermes Agent](https://hermes-agent.nousresearch.com/) — an open-source AI agent framework by [Nous Research](https://nousresearch.com/).

## Files

| File | Description |
| --- | --- |
| `config.yaml` | Ciel configuration (~/.hermes/config.yaml) — API keys redacted. |
| `bridge.js` | Patched WhatsApp bridge file with `!ciel` mention injection and group-fix logic. |
| `SOUL.md` | Global persona/instruction file (~/.hermes/SOUL.md) — loaded every session. |

## Features

* **`!ciel` Trigger**: Custom prefix activation—only responds when explicitly invoked with `!ciel`, bypassing system command conflicts.
* **Bridge Injection**: Custom JavaScript patches force "mention" status on plain-text triggers to satisfy strict security policies.

## Quick Start (Reinstall)

1. **Install Hermes**: `curl -fsSL [https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh](https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh) | bash`
2. **Apply Bridge Patches**: Copy `bridge.js` to enable group support and prefix triggers.
3. **Sync Config**: Copy `config.yaml` to `~/.hermes/config.yaml` and fill in redacted API keys.
4. **Load Persona**: Copy `SOUL.md` to `~/.hermes/SOUL.md`.
5. **Restart Container**: `docker restart ciel_ai_azure`

## Notes

* **Self-Chat Permissions**: `WHATSAPP_MODE` must be set to `self-chat` in `.env` to ensure the bot ignores messages from all other users.
* **Dependency Fix**: If `npm install` fails during setup, run the manual install via `docker exec -u root`

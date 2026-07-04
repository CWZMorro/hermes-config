# Hermes Config (Ciel AI Azure v1.2)

Personal configuration and setup guide for [Hermes Agent](https://hermes-agent.nousresearch.com/) — an open-source AI agent framework by [Nous Research](https://nousresearch.com/).

## Files

| File | Description |
| --- | --- |
| `config.yaml` | Ciel configuration (~/.hermes/config.yaml) — API keys redacted. |
| `bridge.js` | Patched WhatsApp bridge file with `!ciel` mention injection. Only takes effect via the bind mount in `docker-compose.yml` |
| `docker-compose.yml` | Container definition. Use this instead of `docker run` to start/recreate the container. |
| `SOUL.md` | Global persona/instruction file (~/.hermes/SOUL.md) |

## Features

* **`!ciel` Trigger**: Custom prefix activation—only responds when explicitly invoked with `!ciel`, bypassing system command conflicts.
* **Bridge Injection**: Custom JavaScript patches force "mention" status on plain-text triggers to satisfy strict security policies.

## Quick Start (Reinstall)

1. **Install Hermes**: `curl -fsSL [https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh](https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh) | bash`
2. **Clone this repo** to `~/.hermes`.
3. **Edit `docker-compose.yml`**: replace every line marked `CHANGE THIS` with values for the new machine (host paths, UID/GID).
4. **Fill in API keys** redacted in `config.yaml`.
5. **Start the container**: `docker compose up -d` from inside `~/.hermes`.

## Notes

* **Self-Chat Permissions**: `WHATSAPP_MODE` must be set to `self-chat` in `.env` to ensure the bot ignores messages from all other users.
* **Dependency Fix**: the bridge's `node_modules` lives inside the container, not on the mounted volume, so it's reinstalled from scratch every time the container is recreated (not on a plain restart). That install runs as an unprivileged user that doesn't own the bridge directory, so it fails silently. If `!ciel` stops responding right after a recreate, run:

  ```
  docker exec -u root ciel_ai_azure sh -c "cd /opt/hermes/scripts/whatsapp-bridge && npm install --silent && chown -R hermes:hermes node_modules"
  docker restart ciel_ai_azure
  ```

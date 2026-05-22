# Ciel AI Azure — Setup

Post-install configuration. Assumes Hermes is already running in Docker.

After cloning this repo to `~/.hermes`, the files `SOUL.md`, `data/INDEX.md`, and `skills/note-taking/anki/SKILL.md` are already in place. The only manual steps are below.

---

## Data Structure

Git does not track empty directories, so create them manually:

```bash
mkdir -p ~/.hermes/data/{lists,flashcards,notes}
```

The agent reads `INDEX.md` first on any data-related request instead of exploring the filesystem. All user files go under `~/.hermes/data/`. Inside Docker, `~/.hermes` is mounted as `/opt/data`.

`INDEX.md` is a living document — the agent adds entries to it as files are created. The version in this repo contains the entries from the previous machine. On a fresh rebuild, delete those specific file entries and let the agent repopulate them as you recreate your data. The directory conventions at the top must be kept.

---

## Anki Integration

### What is the Anki skill?

A skill is a markdown file the agent automatically reads when relevant — you do not configure or call it. The one at `skills/note-taking/anki/SKILL.md` instructs the agent that whenever it creates flashcards, it must push them directly to Anki via AnkiConnect, trigger an AnkiWeb sync, and save a local backup log. It is already in this repo — no setup needed.

### 1. Install AnkiConnect

AnkiConnect is a plugin that exposes an HTTP API on Anki so the agent can talk to it.

In Anki: **Tools → Add-ons → Get Add-ons** → enter `2055492159` → restart Anki.

### 2. Bind AnkiConnect to all interfaces

By default AnkiConnect only listens on `127.0.0.1`, so only the host machine can reach it. The Docker container is treated as a separate machine and gets blocked. Changing this to `0.0.0.0` makes it listen on all interfaces including the Docker bridge.

**Tools → Add-ons → AnkiConnect → Config** — change:

```json
"webBindAddress": "0.0.0.0"
```

Restart Anki.

### 3. Open the host firewall for Docker

On Linux, `host.docker.internal` does not resolve inside containers (it only works on Mac/Windows Docker Desktop). The host is reachable from inside a container at `172.17.0.1` — the Docker bridge gateway — but the host firewall drops those packets by default.

```bash
# Allow Docker containers to reach port 8765 on this machine
sudo iptables -I INPUT -i docker0 -p tcp --dport 8765 -j ACCEPT

# Save the rules to disk so they survive reboots
sudo iptables-save | sudo tee /etc/iptables/iptables.rules

# Make the iptables service reload those saved rules on every boot
sudo systemctl enable --now iptables
```

### 4. Verify

```bash
docker exec ciel_ai_azure curl -s -X POST http://172.17.0.1:8765 \
  -H "Content-Type: application/json" \
  -d '{"action": "version", "version": 6}'
# Expected: {"result": 6, "error": null}
```

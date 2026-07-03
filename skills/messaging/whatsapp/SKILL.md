---
name: whatsapp
description: Send messages via WhatsApp — bridge architecture, JID format requirements, working around channel directory limitations.
---

# WhatsApp Bridge

## Overview

The WhatsApp integration uses a **Baileys-based Node.js bridge** (`/opt/hermes/scripts/whatsapp-bridge/bridge.js`) with a Python gateway adapter. The bridge communicates over HTTP on `localhost:3000`.

## Architecture

```
send_message tool → Python gateway adapter → Baileys Node.js bridge → WhatsApp
```

## Critical: JID Format Requirement

Baileys requires WhatsApp JIDs, **not** E.164 phone numbers.

| Format | Example | Works? |
|--------|---------|--------|
| E.164 (with `+`) | `+16138822085` | ❌ Baileys `jidDecode` fails |
| Raw digits | `16138822085` | ❌ No `@` separator |
| JID | `16138822085@s.whatsapp.net` | ✅ |
| LID | `208134199054567@lid` | ✅ |
| Group JID | `601157428919-1595428658@g.us` | ✅ |

**Problem:** The Python gateway adapter receives E.164 format (with `+`) from the `send_message` tool for phone platforms (line 347-352 in `send_message_tool.py`), then passes it straight to the bridge, but Baileys can't parse `+`-prefixed numbers as JIDs.

**When `send_message` fails** with "Cannot destructure property 'user' of 'jidDecode(...)'", it's because the chatId isn't a valid JID.

## Workaround: Send Directly to Bridge

When `send_message` can't reach a WhatsApp contact (JID format issue or contact not in channel directory):

```bash
curl -s -X POST http://127.0.0.1:3000/send \
  -H "Content-Type: application/json" \
  -H "Host: localhost" \
  -d '{"chatId":"<NUMBER>@s.whatsapp.net","message":"Your message here"}'
```

The bridge's `/send` endpoint accepts the JID directly and returns `{"success":true,"messageId":"..."}`.

## Channel Directory Limitations

WhatsApp contacts in `channel_directory.json` use `@lid` format (Linked Identity Device), NOT `@s.whatsapp.net`. The directory only shows contacts/chats that have synced — it may not list all of the user's WhatsApp contacts even if they exist in the user's phone. When the user says "that person IS in my contacts," trust them and try alternative methods (direct bridge call) rather than arguing.

## Contact Not in Directory

1. Don't tell the user the contact doesn't exist — they may be in the user's WhatsApp but not synced to the directory.
2. Determine the correct JID: `{country_code}{number}@s.whatsapp.net` (remove any `+`, `-`, or spaces).
3. Call the bridge directly via curl.
4. For groups already in the directory, use the `@g.us` JID directly.

## Pitfalls

- **Don't strip the `+` and pass just digits** — that's also not a valid JID. You need the full `@s.whatsapp.net` suffix.
- **Don't tell the user the contact doesn't exist** — the directory is incomplete. Try the bridge directly.
- **Channel directory lists are stale** — they refresh on bridge restart but may not include all recent contacts.
- **The bridge uses `@lid` format** internally for the user's own DMs, but regular contacts use `@s.whatsapp.net`.
---
name: whatsapp
description: Send messages via WhatsApp — bridge architecture, JID format requirements, working around channel directory limitations. Also covers handling /verify, /public-chat, and /reply-delay admin commands (managing who else can DM the WhatsApp bot and how replies to them are paced), including when those commands arrive from Telegram or Discord instead of WhatsApp itself.
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

## Verifying if a Number Exists on WhatsApp

The bridge does **not** expose an `onWhatsApp`-style HTTP endpoint, so you can't directly check whether a given phone number is registered on WhatsApp via the API.

**Workaround — lid-mapping files in the session directory:**

Baileys stores a file per known contact at `{session_dir}/lid-mapping-{digits}.json`. If the file exists, Baileys has encountered this number before (exchanged messages, received a presence update, or established a session with it). The file contains a LID string like `"227908178198549"`.

```bash
# Check if a contact is known
ls /opt/data/whatsapp/session/lid-mapping-{digits}.json 2>/dev/null
```

If the file exists, you can also check for:
- `lid-mapping-{lid}_reverse.json` — reverse mapping confirming consistent round-trip
- `session-{lid}_1.0.json` — a stored session/encryption key, meaning actual messages were exchanged

**Interpreting the results:** a lid-mapping file confirms the number is a real WhatsApp user that the bridge has encountered before. No file doesn't mean they aren't on WhatsApp — it just means no session data was synced with them yet (e.g. first contact, or contact is in the user's phonebook but never interacted with via this bridge).

**Note:** the lid-mapping only confirms the *phone number* exists on WhatsApp, not the contact's saved name. The user-provided name (e.g. "Xuan Lin") is what it is — the numbers don't carry names.

## Admin Commands: /verify, /public-chat, /reply-delay

The owner can control who else may DM the WhatsApp bot, and how their replies are paced. **You (the agent) are the one who acts on this most of the time** — the owner mostly asks in plain English, not exact command syntax.

**`!ciel` is owner-only, unconditionally.** It only ever triggers on the owner's own outgoing (`fromMe`) messages, letting them invoke Hermes from any of their own chats, not just self-chat. It has nothing to do with `/public-chat` and is never a way for anyone else to reach Hermes — not verified users, not allowlisted users, regardless of `/public-chat` state. If you ever see logic or reasoning implying someone else can use `!ciel` to get through, that's wrong — access for non-owner senders is governed purely by the verified-list + public-chat gate below.

**Exact-syntax commands sent on WhatsApp itself** (`/verify add <number>`, `/verify remove <number>`, `/verify list`, `/public-chat on|off`, `/reply-delay [seconds]`, sent by the owner in their own self-chat) are intercepted directly by `bridge.js` and never reach you — you'll only ever see the confirmation replies these produce, not the commands themselves. Don't try to re-handle those.

**Everything else reaches you and you must act on it directly** — the same commands typed on Telegram/Discord, natural-language requests on any platform ("can you verify lee ann?", "remove that number", "who's verified?", "turn on public chat"), and malformed/partial commands. Do this via the bridge's HTTP API — **never** edit `verified-users.json` / `public-chat.json` / `.env` by hand:

```bash
# Add / remove / list verified users
curl -s -X POST http://127.0.0.1:3000/verify -H "Content-Type: application/json" -H "Host: localhost" \
  -d '{"action":"add","number":"601234567"}'
curl -s -X POST http://127.0.0.1:3000/verify -H "Content-Type: application/json" -H "Host: localhost" \
  -d '{"action":"remove","number":"601234567"}'
curl -s -X POST http://127.0.0.1:3000/verify -H "Content-Type: application/json" -H "Host: localhost" \
  -d '{"action":"list"}'

# Read or set public-chat (omit "enabled" to just read the current state)
curl -s -X POST http://127.0.0.1:3000/public-chat -H "Content-Type: application/json" -H "Host: localhost" \
  -d '{"enabled":true}'

# Read or set the non-owner DM reply-delay window in seconds (omit "seconds" to just read)
curl -s -X POST http://127.0.0.1:3000/reply-delay -H "Content-Type: application/json" -H "Host: localhost" \
  -d '{"seconds":60}'
```

**What `/reply-delay` does**: non-owner DMs (verified contacts messaging via public-chat) are debounced — the bridge waits this many seconds after each message before forwarding it, and if more messages arrive from the same chat within that window they get merged into one combined event instead of triggering separate turns. This means someone who sends 3 quick texts in a row gets one reply covering all of them instead of Hermes replying to the first one while the rest are still arriving. Default is 60 seconds; 0 disables it (instant per-message replies). This never applies to the owner's own self-chat or to groups.

**Why the HTTP API and not the files directly**: being in `verified-users.json` is not sufficient for a contact to actually reach you — the Python gateway runs its *own*, separate authorization check (`WHATSAPP_ALLOWED_USERS` in `.env`, plus a pairing-approval store) that has no idea `verified-users.json` exists. `/verify add` keeps all of that in sync in one atomic operation (bridge-side allowlist, `.env`, and the pairing store, which takes effect immediately with no restart needed). Hand-editing `verified-users.json` yourself only fixes the bridge-forwarding half — the contact's messages will still get silently dropped by the gateway with an "Unauthorized user" log line, and you won't see anything to explain why. **This exact bug happened once already** (a contact was added to `verified-users.json` directly, `.env` was never updated, and her replies vanished for hours before anyone noticed) — always go through the endpoint now.

**The `number` argument**: pass digits only (strip `+`, spaces, dashes, parens yourself first — the endpoint also strips non-digits defensively, but don't rely on that for a name-resolution case where you might pass something malformed). E.g. `+60 18-664 3008` → `"60186643008"`.

**Resolving a name to a number** (e.g. "verify lee ann"):
1. Check `channel_directory.json`'s `platforms.whatsapp` list for an entry whose `name` matches. If found, take its `id` and strip the `@lid`/`@s.whatsapp.net`/`@g.us` suffix — that digit string is what you pass as `number` (LIDs work fine; they don't need to be resolved to a real phone number).
2. If no match in the directory, **search past sessions via `session_search`** — the user may have provided the number in a previous conversation.
3. If found in a past session, use that number and **save it to memory immediately** so future sessions have it.
4. If still not found, say so and ask the owner for the number — don't go search unrelated project files (lists, notes, etc.) for the name.

Since `TELEGRAM_ALLOWED_USERS` / `DISCORD_ALLOWED_USERS` are already locked to the owner's own account, any message you receive on those platforms is already from the owner — no extra identity check is needed before acting on these commands there. Reply with a short confirmation once done, e.g. "✅ Verified 601234567."

**If `/verify add` still doesn't work end-to-end** (contact still isn't getting through after you've confirmed the endpoint returned `success: true`): check `gateway.log` / `errors.log` for "Unauthorized user" lines mentioning their id — that means the gateway process hasn't picked up the `.env` change yet for some other reason (e.g. it wrote fine but the pairing-store sync failed) and needs a restart. Tell the owner explicitly that a restart is needed rather than guessing silently — restarting the gateway is disruptive (drops all platform connections briefly) so confirm with them first unless they've already told you to just do it.

## Pitfalls

- **Don't strip the `+` and pass just digits** — that's also not a valid JID. You need the full `@s.whatsapp.net` suffix.
- **Don't tell the user the contact doesn't exist** — the directory is incomplete. Try the bridge directly.
- **Channel directory lists are stale** — they refresh on bridge restart but may not include all recent contacts.
- **The bridge uses `@lid` format** internally for the user's own DMs, but regular contacts use `@s.whatsapp.net`.
- **Always save contact numbers to memory when the user provides them.** If a user gives you a number to message or verify a contact (e.g. "Lee Ann's number is +60 18-664 3008"), save it to persistent memory immediately. Otherwise, the next session won't have it and you'll need to session_search or ask again — the user will call you out for not remembering.
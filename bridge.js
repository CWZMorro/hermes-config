#!/usr/bin/env node
/**
 * Hermes Agent WhatsApp Bridge
 *
 * Standalone Node.js process that connects to WhatsApp via Baileys
 * and exposes HTTP endpoints for the Python gateway adapter.
 *
 * Endpoints (matches gateway/platforms/whatsapp.py expectations):
 *   GET  /messages       - Long-poll for new incoming messages
 *   POST /send           - Send a message { chatId, message, replyTo? }
 *   POST /edit           - Edit a sent message { chatId, messageId, message }
 *   POST /send-media     - Send media natively { chatId, filePath, mediaType?, caption?, fileName? }
 *   POST /typing         - Send typing indicator { chatId }
 *   GET  /chat/:id       - Get chat info
 *   GET  /health         - Health check
 *   POST /verify         - Manage the verified-users allowlist { action: add|remove|list, number? }
 *   POST /public-chat    - Toggle free-chat for verified users { enabled? } (omit to just read state)
 *   POST /reply-delay    - Read/set the non-owner DM batch-reply window { seconds? }
 *
 * Usage:
 *   node bridge.js --port 3000 --session ~/.hermes/whatsapp/session
 */

import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } from '@whiskeysockets/baileys';
import express from 'express';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import path from 'path';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, chmodSync } from 'fs';
import { randomBytes } from 'crypto';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import qrcode from 'qrcode-terminal';
import { matchesAllowedUser, parseAllowedUsers, expandWhatsAppIdentifiers, normalizeWhatsAppIdentifier } from './allowlist.js';

// Parse CLI args
const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

const WHATSAPP_DEBUG =
  typeof process !== 'undefined' &&
  process.env &&
  typeof process.env.WHATSAPP_DEBUG === 'string' &&
  ['1', 'true', 'yes', 'on'].includes(process.env.WHATSAPP_DEBUG.toLowerCase());

const PORT = parseInt(getArg('port', '3000'), 10);
const SESSION_DIR = getArg('session', path.join(process.env.HOME || '~', '.hermes', 'whatsapp', 'session'));
const IMAGE_CACHE_DIR = path.join(process.env.HOME || '~', '.hermes', 'image_cache');
const DOCUMENT_CACHE_DIR = path.join(process.env.HOME || '~', '.hermes', 'document_cache');
const AUDIO_CACHE_DIR = path.join(process.env.HOME || '~', '.hermes', 'audio_cache');
const PAIR_ONLY = args.includes('--pair-only');
const WHATSAPP_MODE = getArg('mode', process.env.WHATSAPP_MODE || 'self-chat'); // "bot" or "self-chat"
const ALLOWED_USERS = parseAllowedUsers(process.env.WHATSAPP_ALLOWED_USERS || '');
const DEFAULT_REPLY_PREFIX = '✦ *Ciel AI Azure*\n────────────\n';
const REPLY_PREFIX = process.env.WHATSAPP_REPLY_PREFIX === undefined
  ? DEFAULT_REPLY_PREFIX
  : process.env.WHATSAPP_REPLY_PREFIX.replace(/\\n/g, '\n');
const MAX_MESSAGE_LENGTH = parseInt(process.env.WHATSAPP_MAX_MESSAGE_LENGTH || '4096', 10);
const CHUNK_DELAY_MS = parseInt(process.env.WHATSAPP_CHUNK_DELAY_MS || '300', 10);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatOutgoingMessage(message) {
  // In bot mode, messages come from a different number so the prefix is
  // redundant — the sender identity is already clear.  Only prepend in
  // self-chat mode where bot and user share the same number.
  if (WHATSAPP_MODE !== 'self-chat') return message;
  return REPLY_PREFIX ? `${REPLY_PREFIX}${message}` : message;
}

function splitLongMessage(message, maxLength = MAX_MESSAGE_LENGTH) {
  const text = String(message || '');
  if (!text) return [];
  if (!Number.isFinite(maxLength) || maxLength < 1 || text.length <= maxLength) {
    return [text];
  }

  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt < Math.floor(maxLength / 2)) {
      splitAt = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitAt < 1) splitAt = maxLength;

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// Splits a reply into separate WhatsApp message bubbles on paragraph
// breaks (blank lines), so a multi-thought reply arrives as several short
// texts like a person would send, instead of one long block. Each
// resulting paragraph is still run through splitLongMessage in case it
// alone exceeds the length cap.
function splitIntoBubbles(message) {
  const text = String(message || '');
  if (!text) return [];
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length <= 1) return splitLongMessage(text);
  const bubbles = [];
  for (const p of paragraphs) {
    bubbles.push(...splitLongMessage(p));
  }
  return bubbles;
}

function trackSentMessageId(sent) {
  if (sent?.key?.id) {
    recentlySentIds.add(sent.key.id);
    if (recentlySentIds.size > MAX_RECENT_IDS) {
      recentlySentIds.delete(recentlySentIds.values().next().value);
    }
  }
}

async function replySelf(chatId, message) {
  if (!sock) return;
  try {
    const chunks = splitLongMessage(formatOutgoingMessage(message));
    for (let i = 0; i < chunks.length; i += 1) {
      const sent = await sock.sendMessage(chatId, { text: chunks[i] });
      trackSentMessageId(sent);
      if (chunks.length > 1 && i < chunks.length - 1) await sleep(CHUNK_DELAY_MS);
    }
  } catch (err) {
    console.error('[bridge] Failed to send command reply:', err.message);
  }
}

function normalizeWhatsAppId(value) {
  if (!value) return '';
  return String(value).replace(':', '@');
}

function getMessageContent(msg) {
  const content = msg?.message || {};
  if (content.ephemeralMessage?.message) return content.ephemeralMessage.message;
  if (content.viewOnceMessage?.message) return content.viewOnceMessage.message;
  if (content.viewOnceMessageV2?.message) return content.viewOnceMessageV2.message;
  if (content.documentWithCaptionMessage?.message) return content.documentWithCaptionMessage.message;
  if (content.templateMessage?.hydratedTemplate) return content.templateMessage.hydratedTemplate;
  if (content.buttonsMessage) return content.buttonsMessage;
  if (content.listMessage) return content.listMessage;
  return content;
}

function getContextInfo(messageContent) {
  if (!messageContent || typeof messageContent !== 'object') return {};
  for (const value of Object.values(messageContent)) {
    if (value && typeof value === 'object' && value.contextInfo) {
      return value.contextInfo;
    }
  }
  return {};
}

mkdirSync(SESSION_DIR, { recursive: true });

// Build LID → phone reverse map from session files (lid-mapping-{phone}.json)
function buildLidMap() {
  const map = {};
  try {
    for (const f of readdirSync(SESSION_DIR)) {
      const m = f.match(/^lid-mapping-(\d+)\.json$/);
      if (!m) continue;
      const phone = m[1];
      const lid = JSON.parse(readFileSync(path.join(SESSION_DIR, f), 'utf8'));
      if (lid) map[String(lid)] = phone;
    }
  } catch { }
  return map;
}
let lidToPhone = buildLidMap();

// Verified-users allowlist + public-chat toggle, controlled from WhatsApp
// itself via "/verify add|remove|list <number>" and "/public-chat [on|off]"
// sent by the account owner in their own self-chat, or via the /verify and
// /public-chat HTTP endpoints below (used by the agent on any platform —
// see the whatsapp skill). Stored as plain files in SESSION_DIR so they
// survive bridge restarts without touching .env.
//
// IMPORTANT: being in this list is NOT enough for a WhatsApp contact to
// actually reach the agent. The Python gateway runs its own, independent
// authorization check (gateway/run.py::_is_user_authorized) against the
// WHATSAPP_ALLOWED_USERS env var and a separate pairing-approval store —
// it has no idea this file exists. addVerifiedUser/removeVerifiedUser must
// keep all three in sync, or a verified contact's messages get forwarded
// by the bridge just fine and then silently dropped by the gateway anyway
// (this happened in production: verified-users.json had a contact but
// WHATSAPP_ALLOWED_USERS didn't, so every message from her logged
// "Unauthorized user" and the agent never saw it).
const VERIFIED_USERS_FILE = path.join(SESSION_DIR, 'verified-users.json');
const PUBLIC_CHAT_FILE = path.join(SESSION_DIR, 'public-chat.json');
const HERMES_HOME = process.env.HERMES_HOME || path.join(SESSION_DIR, '..', '..');
const ENV_FILE = path.join(HERMES_HOME, '.env');
const PAIRING_APPROVED_FILE = path.join(HERMES_HOME, 'platforms', 'pairing', 'whatsapp-approved.json');

function loadVerifiedUsers() {
  try {
    if (!existsSync(VERIFIED_USERS_FILE)) return new Set();
    const parsed = JSON.parse(readFileSync(VERIFIED_USERS_FILE, 'utf8'));
    return new Set(Array.isArray(parsed) ? parsed.map(normalizeWhatsAppIdentifier).filter(Boolean) : []);
  } catch {
    return new Set();
  }
}

// Keeps WHATSAPP_ALLOWED_USERS in .env in sync so the Python gateway's own
// authorization check (which reads this env var independently of anything
// in this file) grants the same access after the next restart. This alone
// isn't enough for *immediate* effect (env vars are only re-read from .env
// at process start) — see syncPairingApproval for the restart-free path.
function syncEnvAllowedUsers(number, action) {
  let lines;
  try {
    lines = readFileSync(ENV_FILE, 'utf8').split('\n');
  } catch (err) {
    console.error('[bridge] Failed to read .env for WHATSAPP_ALLOWED_USERS sync:', err.message);
    return;
  }
  const lineRe = /^WHATSAPP_ALLOWED_USERS=(.*)$/;
  let found = false;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(lineRe);
    if (!m) continue;
    found = true;
    const current = new Set(m[1].split(',').map((v) => v.trim()).filter(Boolean));
    if (action === 'add') current.add(number);
    else current.delete(number);
    lines[i] = `WHATSAPP_ALLOWED_USERS=${Array.from(current).join(',')}`;
    break;
  }
  if (!found) {
    if (action !== 'add') return;
    lines.push(`WHATSAPP_ALLOWED_USERS=${number}`);
  }
  try {
    writeFileSync(ENV_FILE, lines.join('\n'));
  } catch (err) {
    console.error('[bridge] Failed to write .env for WHATSAPP_ALLOWED_USERS sync:', err.message);
  }
}

// Writes straight into the Python gateway's pairing-approval store
// (gateway/pairing.py — normally populated by the code-based DM pairing
// flow). is_approved() re-reads this file from disk on every message with
// no caching, so this takes effect immediately, no restart needed — unlike
// the .env sync above. is_approved() does an exact string match on the
// raw sender id including its "@..." suffix (no alias normalization), so
// every known phone/LID alias is written in both JID shapes to cover
// whichever form WhatsApp happens to report for a given message.
function syncPairingApproval(number, action) {
  let approved = {};
  try {
    if (existsSync(PAIRING_APPROVED_FILE)) {
      approved = JSON.parse(readFileSync(PAIRING_APPROVED_FILE, 'utf8'));
    }
  } catch {
    approved = {};
  }

  const aliases = expandWhatsAppIdentifiers(number, SESSION_DIR);
  aliases.add(number);
  const jids = new Set();
  for (const alias of aliases) {
    jids.add(`${alias}@s.whatsapp.net`);
    jids.add(`${alias}@lid`);
  }

  if (action === 'add') {
    for (const jid of jids) {
      approved[jid] = { user_name: '', approved_at: Date.now() / 1000 };
    }
  } else {
    for (const jid of jids) delete approved[jid];
  }

  try {
    mkdirSync(path.dirname(PAIRING_APPROVED_FILE), { recursive: true });
    writeFileSync(PAIRING_APPROVED_FILE, JSON.stringify(approved, null, 2));
    try { chmodSync(PAIRING_APPROVED_FILE, 0o600); } catch { }
  } catch (err) {
    console.error('[bridge] Failed to sync pairing approval:', err.message);
  }
}

function addVerifiedUser(number) {
  const users = loadVerifiedUsers();
  users.add(number);
  writeFileSync(VERIFIED_USERS_FILE, JSON.stringify(Array.from(users), null, 2));
  syncEnvAllowedUsers(number, 'add');
  syncPairingApproval(number, 'add');
}

function removeVerifiedUser(number) {
  const users = loadVerifiedUsers();
  const existed = users.delete(number);
  writeFileSync(VERIFIED_USERS_FILE, JSON.stringify(Array.from(users), null, 2));
  syncEnvAllowedUsers(number, 'remove');
  syncPairingApproval(number, 'remove');
  return existed;
}

function matchesVerifiedUser(senderId) {
  const verified = loadVerifiedUsers();
  if (verified.size === 0) return false;
  const aliases = expandWhatsAppIdentifiers(senderId, SESSION_DIR);
  for (const alias of aliases) {
    if (verified.has(alias)) return true;
  }
  return false;
}

function isPublicChatEnabled() {
  try {
    if (!existsSync(PUBLIC_CHAT_FILE)) return false;
    return !!JSON.parse(readFileSync(PUBLIC_CHAT_FILE, 'utf8'))?.enabled;
  } catch {
    return false;
  }
}

function setPublicChatEnabled(enabled) {
  writeFileSync(PUBLIC_CHAT_FILE, JSON.stringify({ enabled: !!enabled }, null, 2));
}

// How long to wait, per DM chat, after a non-owner message before actually
// forwarding it to the Python gateway. Any further messages from the same
// chat during that window get appended to the same buffered event instead
// of triggering a separate turn, so a person who sends several texts in a
// row gets ONE reply covering all of them instead of the agent starting a
// turn on the first one and having later ones straggle in mid-turn. Only
// applies to non-owner DMs — the owner's own self-chat is always instant.
const REPLY_DELAY_FILE = path.join(SESSION_DIR, 'reply-delay.json');
const DEFAULT_REPLY_DELAY_SECONDS = 60;

function getReplyDelaySeconds() {
  try {
    if (!existsSync(REPLY_DELAY_FILE)) return DEFAULT_REPLY_DELAY_SECONDS;
    const seconds = Number(JSON.parse(readFileSync(REPLY_DELAY_FILE, 'utf8'))?.seconds);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_REPLY_DELAY_SECONDS;
  } catch {
    return DEFAULT_REPLY_DELAY_SECONDS;
  }
}

function setReplyDelaySeconds(seconds) {
  writeFileSync(REPLY_DELAY_FILE, JSON.stringify({ seconds }, null, 2));
}

const logger = pino({ level: 'warn' });

// Message queue for polling
const messageQueue = [];
const MAX_QUEUE_SIZE = 100;

// chatId -> { event, timer }. See getReplyDelaySeconds above.
const pendingReplyBuffers = new Map();

function enqueueMessage(event) {
  if (messageQueue.length >= MAX_QUEUE_SIZE) messageQueue.shift();
  messageQueue.push(event);
}

function flushPendingReply(chatId) {
  const entry = pendingReplyBuffers.get(chatId);
  if (!entry) return;
  pendingReplyBuffers.delete(chatId);
  enqueueMessage(entry.event);
}

// Debounced enqueue for non-owner DMs: merge this message into any pending
// buffered event for the same chat and (re)start the delay timer, instead
// of queuing immediately.
function enqueueWithDebounce(event) {
  const delaySeconds = getReplyDelaySeconds();
  if (delaySeconds <= 0) {
    enqueueMessage(event);
    return;
  }

  const existing = pendingReplyBuffers.get(event.chatId);
  if (existing) {
    clearTimeout(existing.timer);
    if (event.body) {
      existing.event.body = existing.event.body ? `${existing.event.body}\n${event.body}` : event.body;
    }
    if (event.hasMedia) {
      existing.event.hasMedia = true;
      existing.event.mediaType = existing.event.mediaType || event.mediaType;
      existing.event.mediaUrls.push(...event.mediaUrls);
    }
    existing.event.mentionedIds = event.mentionedIds;
    existing.event.quotedParticipant = event.quotedParticipant;
    existing.event.messageId = event.messageId;
    existing.event.timestamp = event.timestamp;
    existing.timer = setTimeout(() => flushPendingReply(event.chatId), delaySeconds * 1000);
    return;
  }

  const timer = setTimeout(() => flushPendingReply(event.chatId), delaySeconds * 1000);
  pendingReplyBuffers.set(event.chatId, { event, timer });
}

// Track recently sent message IDs to prevent echo-back loops with media
const recentlySentIds = new Set();
const MAX_RECENT_IDS = 50;

let sock = null;
let connectionState = 'disconnected';

async function startSocket() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['Hermes Agent', 'Chrome', '120.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    // Required for Baileys 7.x: without this, incoming messages that need
    // E2EE session re-establishment are silently dropped (msg.message === null)
    getMessage: async (key) => {
      // We don't maintain a message store, so return a placeholder.
      // This is enough for Baileys to complete the retry handshake.
      return { conversation: '' };
    },
  });

  sock.ev.on('creds.update', () => { saveCreds(); lidToPhone = buildLidMap(); });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n📱 Scan this QR code with WhatsApp on your phone:\n');
      qrcode.generate(qr, { small: true });
      console.log('\nWaiting for scan...\n');
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      connectionState = 'disconnected';

      if (reason === DisconnectReason.loggedOut) {
        console.log('❌ Logged out. Delete session and restart to re-authenticate.');
        process.exit(1);
      } else {
        // 515 = restart requested (common after pairing). Always reconnect.
        if (reason === 515) {
          console.log('↻ WhatsApp requested restart (code 515). Reconnecting...');
        } else {
          console.log(`⚠️  Connection closed (reason: ${reason}). Reconnecting in 3s...`);
        }
        setTimeout(startSocket, reason === 515 ? 1000 : 3000);
      }
    } else if (connection === 'open') {
      connectionState = 'connected';
      console.log('✅ WhatsApp connected!');
      if (PAIR_ONLY) {
        console.log('✅ Pairing complete. Credentials saved.');
        // Give Baileys a moment to flush creds, then exit cleanly
        setTimeout(() => process.exit(0), 2000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // In self-chat mode, your own messages commonly arrive as 'append' rather
    // than 'notify'. Accept both and filter agent echo-backs below.
    if (type !== 'notify' && type !== 'append') return;

    const botIds = Array.from(new Set([
      normalizeWhatsAppId(sock.user?.id),
      normalizeWhatsAppId(sock.user?.lid),
    ].filter(Boolean)));

    for (const msg of messages) {
      if (!msg.message) continue;

      const chatId = msg.key.remoteJid;
      if (WHATSAPP_DEBUG) {
        try {
          console.log(JSON.stringify({
            event: 'upsert', type,
            fromMe: !!msg.key.fromMe, chatId,
            senderId: msg.key.participant || chatId,
            messageKeys: Object.keys(msg.message || {}),
          }));
        } catch { }
      }
      const isGroup = chatId.endsWith('@g.us');
      // For fromMe DMs, participant is null — use the bot's own ID so the gateway
      // recognizes the message as coming from the authorized account owner.
      const senderId = msg.key.participant || (msg.key.fromMe && !isGroup ? (sock.user?.id || chatId) : chatId);
      const senderNumber = senderId.replace(/@.*/, '');

      // WhatsApp now uses LID (Linked Identity Device) format: 67427329167522@lid
      // AND classic format: 34652029134@s.whatsapp.net
      // sock.user has both: { id: "number:10@s.whatsapp.net", lid: "lid_number:10@lid" }
      const myNumber = (sock.user?.id || '').replace(/:.*@/, '@').replace(/@.*/, '');
      const myLid = (sock.user?.lid || '').replace(/:.*@/, '@').replace(/@.*/, '');
      const chatNumber = chatId.replace(/@.*/, '');
      const isSelfChat = (myNumber && chatNumber === myNumber) || (myLid && chatNumber === myLid);

      // Handle fromMe messages based on mode
      if (msg.key.fromMe) {
        if (chatId.includes('status')) continue;

        if (WHATSAPP_MODE === 'bot') {
          // Bot mode: separate number. ALL fromMe are echo-backs of our own replies — skip.
          continue;
        }

        // Self-chat mode: only allow messages in the user's own self-chat
        if (!isSelfChat && !isGroup) {
          // Allow explicit !ciel trigger in DMs so the user can invoke the bot in any conversation
          const earlyContent = getMessageContent(msg);
          const earlyBody = earlyContent.conversation || earlyContent.extendedTextMessage?.text || '';
          if (!earlyBody.toLowerCase().startsWith('!ciel')) continue;
        }
      }

      // Handle !fromMe messages (from other people) based on mode.
      // Self-chat mode only responds to the user's own messages to
      // themselves — stranger DMs / group pings must never reach the
      // Python gateway, otherwise a pairing-code reply fires in response
      // to arbitrary incoming messages (#8389).
      //
      // "!ciel" is an OWNER-ONLY trigger — it only ever applies to the
      // owner's own fromMe messages (handled above), so they can invoke
      // Hermes from any of their own chats, not just their self-chat. It
      // is NOT a way for anyone else to reach Hermes, regardless of
      // whether they're in ALLOWED_USERS or verified-users.json, and
      // regardless of public-chat state — that used to be the behavior
      // (a pre-existing mechanism this feature layered on top of) but it
      // let verified users bypass the public-chat OFF state by typing
      // "!ciel", which contradicts the whole point of the toggle. Anyone
      // other than the owner needs isKnownUser (verified or
      // allowlisted) AND public-chat ON — full stop, no prefix escape hatch.
      if (!msg.key.fromMe) {
        const isVerified = !isGroup && matchesVerifiedUser(senderId);
        const isKnownUser = isVerified || matchesAllowedUser(senderId, ALLOWED_USERS, SESSION_DIR);
        if (WHATSAPP_MODE === 'self-chat') {
          // Self-chat mode: the public-chat toggle is the ONLY gate for
          // non-owner senders here — no "!ciel" escape hatch.
          if (!(isKnownUser && isPublicChatEnabled())) {
            try {
              console.log(JSON.stringify({
                event: 'ignored',
                reason: isKnownUser ? 'public_chat_disabled' : 'self_chat_mode_rejects_non_self',
                chatId,
                senderId,
              }));
            } catch { }
            continue;
          }
        } else if (!isKnownUser) {
          // Bot mode has no self-chat/public-chat concept — being a known
          // (verified or allowlisted) user is sufficient, same as before.
          try {
            console.log(JSON.stringify({
              event: 'ignored',
              reason: 'allowlist_mismatch',
              chatId,
              senderId,
            }));
          } catch { }
          continue;
        }
      }

      const messageContent = getMessageContent(msg);
      const contextInfo = getContextInfo(messageContent);
      const mentionedIds = Array.from(new Set((contextInfo?.mentionedJid || []).map(normalizeWhatsAppId).filter(Boolean)));
      const quotedParticipant = normalizeWhatsAppId(contextInfo?.participant || contextInfo?.remoteJid || '');

      // Extract message body
      let body = '';
      let hasMedia = false;
      let mediaType = '';
      const mediaUrls = [];

      if (messageContent.conversation) {
        body = messageContent.conversation;
      } else if (messageContent.extendedTextMessage?.text) {
        body = messageContent.extendedTextMessage.text;
      } else if (messageContent.imageMessage) {
        body = messageContent.imageMessage.caption || '';
        hasMedia = true;
        mediaType = 'image';
        try {
          const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
          const mime = messageContent.imageMessage.mimetype || 'image/jpeg';
          const extMap = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
          const ext = extMap[mime] || '.jpg';
          mkdirSync(IMAGE_CACHE_DIR, { recursive: true });
          const filePath = path.join(IMAGE_CACHE_DIR, `img_${randomBytes(6).toString('hex')}${ext}`);
          writeFileSync(filePath, buf);
          mediaUrls.push(filePath);
        } catch (err) {
          console.error('[bridge] Failed to download image:', err.message);
        }
      } else if (messageContent.videoMessage) {
        body = messageContent.videoMessage.caption || '';
        hasMedia = true;
        mediaType = 'video';
        try {
          const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
          const mime = messageContent.videoMessage.mimetype || 'video/mp4';
          const ext = mime.includes('mp4') ? '.mp4' : '.mkv';
          mkdirSync(DOCUMENT_CACHE_DIR, { recursive: true });
          const filePath = path.join(DOCUMENT_CACHE_DIR, `vid_${randomBytes(6).toString('hex')}${ext}`);
          writeFileSync(filePath, buf);
          mediaUrls.push(filePath);
        } catch (err) {
          console.error('[bridge] Failed to download video:', err.message);
        }
      } else if (messageContent.audioMessage || messageContent.pttMessage) {
        hasMedia = true;
        mediaType = messageContent.pttMessage ? 'ptt' : 'audio';
        try {
          const audioMsg = messageContent.pttMessage || messageContent.audioMessage;
          const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
          const mime = audioMsg.mimetype || 'audio/ogg';
          const ext = mime.includes('ogg') ? '.ogg' : mime.includes('mp4') ? '.m4a' : '.ogg';
          mkdirSync(AUDIO_CACHE_DIR, { recursive: true });
          const filePath = path.join(AUDIO_CACHE_DIR, `aud_${randomBytes(6).toString('hex')}${ext}`);
          writeFileSync(filePath, buf);
          mediaUrls.push(filePath);
        } catch (err) {
          console.error('[bridge] Failed to download audio:', err.message);
        }
      } else if (messageContent.documentMessage) {
        body = messageContent.documentMessage.caption || '';
        hasMedia = true;
        mediaType = 'document';
        const fileName = messageContent.documentMessage.fileName || 'document';
        try {
          const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
          mkdirSync(DOCUMENT_CACHE_DIR, { recursive: true });
          const safeFileName = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_');
          const filePath = path.join(DOCUMENT_CACHE_DIR, `doc_${randomBytes(6).toString('hex')}_${safeFileName}`);
          writeFileSync(filePath, buf);
          mediaUrls.push(filePath);
        } catch (err) {
          console.error('[bridge] Failed to download document:', err.message);
        }
      }

      // For media without caption, use a placeholder so the API message is never empty
      if (hasMedia && !body) {
        body = `[${mediaType} received]`;
      }

      // Ignore Hermes' own reply messages in self-chat mode to avoid loops.
      if (msg.key.fromMe && ((REPLY_PREFIX && body.startsWith(REPLY_PREFIX)) || recentlySentIds.has(msg.key.id))) {
        if (WHATSAPP_DEBUG) {
          try { console.log(JSON.stringify({ event: 'ignored', reason: 'agent_echo', chatId, messageId: msg.key.id })); } catch { }
        }
        continue;
      }

      // Skip empty messages
      if (!body && !hasMedia) {
        if (WHATSAPP_DEBUG) {
          try {
            console.log(JSON.stringify({ event: 'ignored', reason: 'empty', chatId, messageKeys: Object.keys(msg.message || {}) }));
          } catch (err) {
            console.error('Failed to log empty message event:', err);
          }
        }
        continue;
      }

      // Owner-only admin commands, typed in the owner's own self-chat.
      // Handled entirely here — never forwarded to the Python gateway.
      if (msg.key.fromMe && isSelfChat && !isGroup) {
        const trimmed = body.trim();
        // Capture the whole rest of the line as the number, not just the
        // first token — phone numbers are often typed with spaces/dashes
        // ("+60 18-664 3008"), and \S+ used to truncate at the first space.
        const verifyMatch = trimmed.match(/^\/verify\s+(add|remove|list)\b\s*(.*)$/i);
        const publicChatMatch = trimmed.match(/^\/public-chat(?:\s+(on|off))?\s*$/i);
        const replyDelayMatch = trimmed.match(/^\/reply-delay(?:\s+(\d+))?\s*$/i);
        if (verifyMatch) {
          const action = verifyMatch[1].toLowerCase();
          if (action === 'list') {
            const users = Array.from(loadVerifiedUsers());
            await replySelf(chatId, users.length
              ? `📋 Verified users:\n${users.join('\n')}`
              : `📋 No verified users yet. Add one with /verify add <number>.`);
          } else {
            // digitsOnly, not normalizeWhatsAppIdentifier: the latter only
            // strips a leading "+" and any "@..."/":...@" JID suffix, it
            // doesn't remove spaces/dashes from a human-typed number.
            const number = (verifyMatch[2] || '').replace(/[^\d]/g, '');
            if (!number) {
              await replySelf(chatId, `⚠️ Usage: /verify ${action} <number>`);
            } else if (action === 'add') {
              addVerifiedUser(number);
              await replySelf(chatId, isPublicChatEnabled()
                ? `✅ Verified ${number} — they can chat with Hermes freely now.`
                : `✅ Verified ${number}. Send /public-chat on to let them chat with Hermes (they have no access until then — "!ciel" is yours only).`);
            } else {
              const existed = removeVerifiedUser(number);
              await replySelf(chatId, existed
                ? `🗑️ Removed ${number} from verified users.`
                : `${number} wasn't verified.`);
            }
          }
          continue;
        }
        if (publicChatMatch) {
          const desired = publicChatMatch[1] ? publicChatMatch[1].toLowerCase() === 'on' : !isPublicChatEnabled();
          setPublicChatEnabled(desired);
          await replySelf(chatId, `🔓 Public chat is now ${desired ? 'ON' : 'OFF'}${desired ? ' — verified users can DM Hermes freely.' : ' — verified users have no access until this is back on.'}`);
          continue;
        }
        if (replyDelayMatch) {
          if (replyDelayMatch[1] !== undefined) {
            setReplyDelaySeconds(Number(replyDelayMatch[1]));
          }
          const seconds = getReplyDelaySeconds();
          await replySelf(chatId, seconds > 0
            ? `⏱️ Reply delay for non-owner DMs is ${seconds}s — messages sent within that window of each other get batched into one reply.`
            : `⏱️ Reply delay is OFF — non-owner DMs get an instant turn per message.`);
          continue;
        }
      }

      if (body && body.toLowerCase().startsWith('!ciel')) {
        if (botIds.length > 0) {
          mentionedIds.push(botIds[0]); // Trick the Python Gateway
        }
        body = body.substring(5).trim(); // Remove '!ciel' so the AI doesn't see it
      }

      const event = {
        messageId: msg.key.id,
        chatId,
        senderId,
        senderName: msg.pushName || senderNumber,
        chatName: isGroup ? (chatId.split('@')[0]) : (msg.pushName || senderNumber),
        isGroup,
        body,
        hasMedia,
        mediaType,
        mediaUrls,
        mentionedIds,
        quotedParticipant,
        botIds,
        timestamp: msg.messageTimestamp,
      };

      // Debounce non-owner DMs so a burst of several messages produces one
      // reply instead of the agent starting a turn on the first message
      // while later ones straggle in. Owner's own messages (self-chat or
      // "!ciel"-triggered elsewhere) and groups stay instant.
      if (!msg.key.fromMe && !isGroup) {
        enqueueWithDebounce(event);
      } else {
        enqueueMessage(event);
      }
    }
  });
}

// HTTP server
const app = express();
app.use(express.json());

// Host-header validation — defends against DNS rebinding.
// The bridge binds loopback-only (127.0.0.1) but a victim browser on
// the same machine could be tricked into fetching from an attacker
// hostname that TTL-flips to 127.0.0.1. Reject any request whose Host
// header doesn't resolve to a loopback alias.
// See GHSA-ppp5-vxwm-4cf7.
const _ACCEPTED_HOST_VALUES = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  '::1',
]);

app.use((req, res, next) => {
  const raw = (req.headers.host || '').trim();
  if (!raw) {
    return res.status(400).json({ error: 'Missing Host header' });
  }
  // Strip port suffix: "localhost:3000" → "localhost"
  const hostOnly = (raw.includes(':')
    ? raw.substring(0, raw.lastIndexOf(':'))
    : raw
  ).replace(/^\[|\]$/g, '').toLowerCase();
  if (!_ACCEPTED_HOST_VALUES.has(hostOnly)) {
    return res.status(400).json({
      error: 'Invalid Host header. Bridge accepts loopback hosts only.',
    });
  }
  next();
});

// Poll for new messages (long-poll style)
app.get('/messages', (req, res) => {
  const msgs = messageQueue.splice(0, messageQueue.length);
  res.json(msgs);
});

// Send a message
app.post('/send', async (req, res) => {
  if (!sock || connectionState !== 'connected') {
    return res.status(503).json({ error: 'Not connected to WhatsApp' });
  }

  const { chatId, message, replyTo } = req.body;
  if (!chatId || !message) {
    return res.status(400).json({ error: 'chatId and message are required' });
  }

  try {
    // Prefix goes on the first bubble only — repeating it on every bubble
    // of a multi-message reply would be noisy.
    const bubbles = splitIntoBubbles(message);
    const chunks = bubbles.map((b, i) => (i === 0 ? formatOutgoingMessage(b) : b));
    const messageIds = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const sent = await sock.sendMessage(chatId, { text: chunks[i] });
      trackSentMessageId(sent);
      if (sent?.key?.id) messageIds.push(sent.key.id);
      if (chunks.length > 1 && i < chunks.length - 1) {
        await sleep(CHUNK_DELAY_MS);
      }
    }

    res.json({
      success: true,
      messageId: messageIds[messageIds.length - 1],
      messageIds,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Edit a previously sent message
app.post('/edit', async (req, res) => {
  if (!sock || connectionState !== 'connected') {
    return res.status(503).json({ error: 'Not connected to WhatsApp' });
  }

  const { chatId, messageId, message } = req.body;
  if (!chatId || !messageId || !message) {
    return res.status(400).json({ error: 'chatId, messageId, and message are required' });
  }

  try {
    const key = { id: messageId, fromMe: true, remoteJid: chatId };
    const chunks = splitLongMessage(formatOutgoingMessage(message));
    const messageIds = [];

    await sock.sendMessage(chatId, { text: chunks[0], edit: key });
    if (chunks.length > 1) {
      for (let i = 1; i < chunks.length; i += 1) {
        const sent = await sock.sendMessage(chatId, { text: chunks[i] });
        trackSentMessageId(sent);
        if (sent?.key?.id) messageIds.push(sent.key.id);
        if (i < chunks.length - 1) {
          await sleep(CHUNK_DELAY_MS);
        }
      }
    }

    res.json({ success: true, messageIds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// MIME type map and media type inference for /send-media
const MIME_MAP = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo',
  mkv: 'video/x-matroska', '3gp': 'video/3gpp',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function inferMediaType(ext) {
  if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'avi', 'mkv', '3gp'].includes(ext)) return 'video';
  if (['ogg', 'opus', 'mp3', 'wav', 'm4a'].includes(ext)) return 'audio';
  return 'document';
}

// Send media (image, video, document) natively
app.post('/send-media', async (req, res) => {
  if (!sock || connectionState !== 'connected') {
    return res.status(503).json({ error: 'Not connected to WhatsApp' });
  }

  const { chatId, filePath, mediaType, caption, fileName } = req.body;
  if (!chatId || !filePath) {
    return res.status(400).json({ error: 'chatId and filePath are required' });
  }

  try {
    if (!existsSync(filePath)) {
      return res.status(404).json({ error: `File not found: ${filePath}` });
    }

    const buffer = readFileSync(filePath);
    const ext = filePath.toLowerCase().split('.').pop();
    const type = mediaType || inferMediaType(ext);
    let msgPayload;

    switch (type) {
      case 'image':
        msgPayload = { image: buffer, caption: caption || undefined, mimetype: MIME_MAP[ext] || 'image/jpeg' };
        break;
      case 'video':
        msgPayload = { video: buffer, caption: caption || undefined, mimetype: MIME_MAP[ext] || 'video/mp4' };
        break;
      case 'audio': {
        // WhatsApp only renders a native voice bubble (ptt) when the file is ogg/opus.
        // If the caller passes mp3, wav, m4a etc. (e.g. from Edge TTS / NeuTTS),
        // silently convert to ogg/opus via ffmpeg so ptt is always honoured.
        let audioBuffer = buffer;
        let audioExt = ext;
        const needsConversion = !['ogg', 'opus'].includes(ext);
        let tmpPath = null;
        if (needsConversion) {
          tmpPath = path.join(tmpdir(), `hermes_voice_${randomBytes(6).toString('hex')}.ogg`);
          try {
            execSync(
              `ffmpeg -y -i ${JSON.stringify(filePath)} -ar 48000 -ac 1 -c:a libopus ${JSON.stringify(tmpPath)}`,
              { timeout: 30000, stdio: 'pipe' }
            );
            audioBuffer = readFileSync(tmpPath);
            audioExt = 'ogg';
          } catch (convErr) {
            // ffmpeg not available or conversion failed — fall back to original format
            console.warn('[bridge] ffmpeg conversion failed, sending as file attachment:', convErr.message);
          } finally {
            try { if (tmpPath && existsSync(tmpPath)) unlinkSync(tmpPath); } catch (_) { }
          }
        }
        const audioMime = (audioExt === 'ogg' || audioExt === 'opus') ? 'audio/ogg; codecs=opus' : 'audio/mpeg';
        msgPayload = { audio: audioBuffer, mimetype: audioMime, ptt: audioExt === 'ogg' || audioExt === 'opus' };
        break;
      }
      case 'document':
      default:
        msgPayload = {
          document: buffer,
          fileName: fileName || path.basename(filePath),
          caption: caption || undefined,
          mimetype: MIME_MAP[ext] || 'application/octet-stream',
        };
        break;
    }

    const sent = await sock.sendMessage(chatId, msgPayload);

    trackSentMessageId(sent);

    res.json({ success: true, messageId: sent?.key?.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Typing indicator
app.post('/typing', async (req, res) => {
  if (!sock || connectionState !== 'connected') {
    return res.status(503).json({ error: 'Not connected' });
  }

  const { chatId } = req.body;
  if (!chatId) return res.status(400).json({ error: 'chatId required' });

  try {
    await sock.sendPresenceUpdate('composing', chatId);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false });
  }
});

// Chat info
app.get('/chat/:id', async (req, res) => {
  const chatId = req.params.id;
  const isGroup = chatId.endsWith('@g.us');

  if (isGroup && sock) {
    try {
      const metadata = await sock.groupMetadata(chatId);
      return res.json({
        name: metadata.subject,
        isGroup: true,
        participants: metadata.participants.map(p => p.id),
      });
    } catch {
      // Fall through to default
    }
  }

  res.json({
    name: chatId.replace(/@.*/, ''),
    isGroup,
    participants: [],
  });
});

// Manage the verified-users allowlist. The single entry point for this —
// the owner's in-chat "/verify ..." commands and the agent handling the
// same request from Telegram/Discord/natural-language both hit this
// instead of touching verified-users.json / .env / the pairing store
// directly, so there's exactly one place that keeps all three in sync.
app.post('/verify', (req, res) => {
  const { action, number } = req.body || {};
  if (!['add', 'remove', 'list'].includes(action)) {
    return res.status(400).json({ error: 'action must be "add", "remove", or "list"' });
  }
  if (action === 'list') {
    return res.json({ success: true, users: Array.from(loadVerifiedUsers()) });
  }
  const digits = String(number || '').replace(/[^\d]/g, '');
  if (!digits) {
    return res.status(400).json({ error: 'number is required and must contain digits' });
  }
  if (action === 'add') {
    addVerifiedUser(digits);
    return res.json({ success: true, number: digits, publicChatEnabled: isPublicChatEnabled() });
  }
  const existed = removeVerifiedUser(digits);
  res.json({ success: true, number: digits, existed });
});

// Toggle (or read) the public-chat setting. POST {} reads current state;
// POST { enabled: true|false } sets it explicitly.
app.post('/public-chat', (req, res) => {
  const { enabled } = req.body || {};
  if (enabled !== undefined) {
    setPublicChatEnabled(!!enabled);
  }
  res.json({ success: true, enabled: isPublicChatEnabled() });
});

// Read or set the non-owner DM reply-delay (debounce) window, in seconds.
// POST {} reads current value; POST { seconds } sets it. 0 disables
// debouncing entirely (instant per-message replies again).
app.post('/reply-delay', (req, res) => {
  const { seconds } = req.body || {};
  if (seconds !== undefined) {
    const n = Number(seconds);
    if (!Number.isFinite(n) || n < 0) {
      return res.status(400).json({ error: 'seconds must be a non-negative number' });
    }
    setReplyDelaySeconds(n);
  }
  res.json({ success: true, seconds: getReplyDelaySeconds() });
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: connectionState,
    queueLength: messageQueue.length,
    uptime: process.uptime(),
  });
});

// Start
if (PAIR_ONLY) {
  // Pair-only mode: just connect, show QR, save creds, exit. No HTTP server.
  console.log('📱 WhatsApp pairing mode');
  console.log(`📁 Session: ${SESSION_DIR}`);
  console.log();
  startSocket();
} else {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`🌉 WhatsApp bridge listening on port ${PORT} (mode: ${WHATSAPP_MODE})`);
    console.log(`📁 Session stored in: ${SESSION_DIR}`);
    if (ALLOWED_USERS.size > 0) {
      console.log(`🔒 Allowed users: ${Array.from(ALLOWED_USERS).join(', ')}`);
    } else if (WHATSAPP_MODE === 'self-chat') {
      console.log(`🔒 Self-chat mode — only your own messages to yourself are processed.`);
    } else {
      console.log(`🔒 No WHATSAPP_ALLOWED_USERS set — incoming messages are rejected.`);
      console.log(`   Set WHATSAPP_ALLOWED_USERS=<phone> to authorize specific users,`);
      console.log(`   or WHATSAPP_ALLOWED_USERS=* for an explicit open bot.`);
    }
    console.log();
    startSocket();
  });
}

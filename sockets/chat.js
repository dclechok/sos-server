// server/sockets/chat.js
// Global chat history, rate limiting, and message dispatch.

const CHAT_MAX = 100;
const CHAT_MIN_INTERVAL_MS = 800;
const CHAT_MSG_MAX = 240;
const CHAT_NAME_MAX = 24;

const chatHistory = [];
const lastChatAt = {};

function pushChat(msg) {
  chatHistory.push(msg);
  if (chatHistory.length > CHAT_MAX) {
    chatHistory.splice(0, chatHistory.length - CHAT_MAX);
  }
}

/**
 * Attempt to send a chat message. Returns the payload if sent, null if rate-limited or empty.
 * @param {string} socketId
 * @param {string} rawMessage
 * @param {string} senderName  - already-resolved display name
 * @returns {{ user, message, at }|null}
 */
function tryChat(socketId, rawMessage, senderName) {
  const now = Date.now();
  const prev = lastChatAt[socketId] || 0;
  if (now - prev < CHAT_MIN_INTERVAL_MS) return null;
  lastChatAt[socketId] = now;

  const cleanMsg = String(rawMessage ?? "").trim().slice(0, CHAT_MSG_MAX);
  if (!cleanMsg) return null;

  const payload = { user: senderName || "Unknown", message: cleanMsg, at: now };
  pushChat(payload);
  return payload;
}

function cleanupChat(socketId) {
  delete lastChatAt[socketId];
}

module.exports = {
  chatHistory,
  tryChat,
  cleanupChat,
  CHAT_NAME_MAX,
};
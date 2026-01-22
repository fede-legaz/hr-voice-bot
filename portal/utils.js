"use strict";

const crypto = require("crypto");

function randomToken(bytes = 8) {
  return crypto.randomBytes(bytes).toString("hex");
}

function safeSlug(value) {
  const raw = String(value || "").toLowerCase();
  const slug = raw.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "page";
}

function parseDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string") return null;
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  const mime = match[1];
  const buffer = Buffer.from(match[2], "base64");
  return { mime, buffer };
}

function sanitizeFilename(name = "") {
  if (!name) return "file";
  return name.replace(/[^\w.\-]+/g, "_");
}

function normalizePhone(num) {
  if (!num) return "";
  let s = String(num).trim();
  if (s.startsWith("+")) {
    s = "+" + s.slice(1).replace(/[^0-9]/g, "");
  } else {
    s = s.replace(/[^0-9]/g, "");
  }
  if (!s.startsWith("+")) {
    if (s.length === 10) s = "+1" + s;
    else if (s.length === 11 && s.startsWith("1")) s = "+" + s;
  }
  return s;
}

function safeJsonStringify(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncateText(text, maxLen) {
  if (!text) return "";
  const str = String(text);
  if (str.length <= maxLen) return str;
  return str.slice(0, Math.max(0, maxLen - 3)) + "...";
}

module.exports = {
  randomToken,
  safeSlug,
  parseDataUrl,
  sanitizeFilename,
  normalizePhone,
  safeJsonStringify,
  escapeHtml,
  truncateText
};

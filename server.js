"use strict";

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const webpush = require("web-push");
const { createPortalRouter } = require("./portal");

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL || "";
const DATABASE_SSL = process.env.DATABASE_SSL !== "0";
const DATABASE_SSL_CA_RAW = process.env.DATABASE_SSL_CA || "";
const DATABASE_SSL_CA_BASE64 = process.env.DATABASE_SSL_CA_BASE64 || "";
const DATABASE_SSL_REJECT_UNAUTHORIZED = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === "1";
const SPACES_ENDPOINT = process.env.SPACES_ENDPOINT || "";
const SPACES_REGION = process.env.SPACES_REGION || "";
const SPACES_BUCKET = process.env.SPACES_BUCKET || "";
const SPACES_KEY = process.env.SPACES_KEY || "";
const SPACES_SECRET = process.env.SPACES_SECRET || "";
const SPACES_PUBLIC_URL = (process.env.SPACES_PUBLIC_URL || "").replace(/\/+$/, "");
const SPACES_PUBLIC = process.env.SPACES_PUBLIC === "1";

const OPENAI_MODEL_REALTIME = process.env.OPENAI_MODEL_REALTIME || process.env.OPENAI_MODEL || "gpt-4o-mini-realtime-preview-2024-12-17";
const OPENAI_MODEL_SCORING = process.env.OPENAI_MODEL_SCORING || "gpt-4o-mini";
const OPENAI_MODEL_OCR = process.env.OPENAI_MODEL_OCR || "gpt-4o-mini";
const OCR_MAX_IMAGES = Number(process.env.OCR_MAX_IMAGES) || 3;
const OCR_MAX_IMAGE_BYTES = Number(process.env.OCR_MAX_IMAGE_BYTES) || 2 * 1024 * 1024;
const CV_UPLOAD_MAX_BYTES = Number(process.env.CV_UPLOAD_MAX_BYTES) || 8 * 1024 * 1024;
const CV_PHOTO_MAX_BYTES = Number(process.env.CV_PHOTO_MAX_BYTES) || 350 * 1024;
const PROFILE_PHOTO_MAX_BYTES = Number(process.env.PROFILE_PHOTO_MAX_BYTES) || 2 * 1024 * 1024;
const AUDIO_UPLOAD_MAX_BYTES = Number(process.env.AUDIO_UPLOAD_MAX_BYTES) || 25 * 1024 * 1024;
const DB_AUDIO_MAX_BYTES = Number(process.env.DB_AUDIO_MAX_BYTES) || AUDIO_UPLOAD_MAX_BYTES;
const VOICE = process.env.VOICE || "marin";
const AUTO_RECORD = process.env.AUTO_RECORD !== "0";

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const WHATSAPP_FROM = process.env.WHATSAPP_FROM || "";
const WHATSAPP_TO = process.env.WHATSAPP_TO || "";
const TWILIO_VOICE_FROM = process.env.TWILIO_VOICE_FROM || "";
const TWILIO_SMS_FROM = process.env.TWILIO_SMS_FROM || TWILIO_VOICE_FROM;
const CALL_BEARER_TOKEN = process.env.CALL_BEARER_TOKEN || "";
const CONFIG_TOKEN = CALL_BEARER_TOKEN;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "ADMIN";
const VIEWER_EMAIL = (process.env.VIEWER_EMAIL || "").trim();
const VIEWER_PASSWORD = process.env.VIEWER_PASSWORD || "";
const VIEWER_SESSION_TTL_MS = Number(process.env.VIEWER_SESSION_TTL_MS) || 12 * 60 * 60 * 1000;
const USER_SESSION_TTL_MS = Number(process.env.USER_SESSION_TTL_MS) || VIEWER_SESSION_TTL_MS;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || PUBLIC_BASE_URL;

if (!PUBLIC_BASE_URL) { console.error("Missing PUBLIC_BASE_URL"); process.exit(1); }
if (!OPENAI_API_KEY) { console.error("Missing OPENAI_API_KEY"); process.exit(1); }

let pushEnabled = false;
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT || PUBLIC_BASE_URL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    pushEnabled = true;
  } catch (err) {
    console.error("[push] failed to configure VAPID", err.message);
  }
} else if (VAPID_PUBLIC_KEY || VAPID_PRIVATE_KEY) {
  console.warn("[push] missing VAPID keys, push disabled");
}

const DEFAULT_BRAND = "New Campo Argentino";
const DEFAULT_ROLE = "Server/Runner";
const DEFAULT_ENGLISH_REQUIRED = true;

const ROLE_NOTES = {
  server: "Requiere inglés conversacional. Calidez con clientes, servicio de salón, manejo de POS/bandeja.",
  runner: "Requiere inglés básico/conversacional. Entrega platos, soporte salón, coordinación con cocina.",
  hostess: "Requiere inglés. Cara del negocio, siempre sonriente y cálida; controla waiting list.",
  cashier: "Requiere inglés. Atención al público, caja/POS. Big plus: barista/shakes/smoothies.",
  barista: "Café/espresso, espumado, limpieza molino, recetas. Atención al público.",
  cook: "Experiencia previa. Preguntar cocinas/estaciones (grill, fritas, plancha, fría, sartén), presión en línea.",
  prep: "Algo de experiencia. Preguntar si sabe leer y seguir recetas.",
  dish: "Lavaplatos: experiencia previa en volumen, químicos, orden.",
  pizzero: "Experiencia previa pizzero; sabe hacer masa desde cero.",
  foodtruck: "Food truck: atiende público y cocina. Preguntar experiencia en plancha y atención."
};

const BRAND_NOTES = {
  "new campo argentino": "Steakhouse full service, carnes, ritmo alto, ambiente familiar.",
  "yes cafe & pizza": "Fast casual, desayunos/burgers/burritos/shakes/pizzas; turno AM/PM, alta rotación.",
  "yes cafe pizza": "Fast casual, pizzas y menú rápido; considerar horarios hasta tarde.",
  "yes cafe miami beach": "Fast casual 71st, desayunos y café; atención al público.",
  "mexi cafe": "Fast casual mexicano, cocina a la vista, desayunos/burritos; preguntar plancha/mexicana.",
  "mexi trailer": "Trailer callejero, un solo operador cocina y atiende; experiencia en plancha y público."
};

const ROLE_QUESTIONS = {
  campo: {
    server: [
      "Tenés experiencia previa de salón? ¿Dónde y cuánto tiempo? ¿Manejo de POS/bandeja?",
      "Este es full service y carnes en ritmo alto: ¿trabajaste en algo similar?",
      "Inglés es requerido: ¿cómo te manejás con clientes en inglés?"
    ],
    runner: [
      "¿Ya trabajaste como runner? ¿En qué tipo de restaurante y volumen?",
      "¿Te sentís cómodo coordinando con cocina y llevando varios platos?",
      "Inglés básico/conversacional: ¿podés manejar indicaciones en inglés?"
    ],
    hostess: [
      "Es la cara del negocio: ¿cómo describirías tu calidez/carisma?",
      "Inglés requerido: ¿cómo te manejás recibiendo a clientes en inglés?",
      "¿Cómo manejás espera/lista y mantener una sonrisa bajo presión?"
    ],
    cook: [
      "Contame tu experiencia en cocina: ¿qué estaciones trabajaste (grill/frita/sartén/fría)?",
      "¿Trabajaste en cocina argentina o con carnes? ¿Bajo presión de línea?",
      "¿En qué tipo de volúmenes trabajaste?"
    ],
    prep: [
      "¿Tenés experiencia como prep? ¿Podés seguir recetas escritas?",
      "¿Qué mis en place has hecho en otros trabajos?"
    ],
    dish: [
      "¿Experiencia como lavaplatos en volumen? ¿Manejo de químicos y orden?",
      "Es un rol físico (parado, mover racks de platos). ¿Estás cómodo con ese ritmo de trabajo?"
    ]
  },
  yes: {
    cashier: [
      "Inglés requerido: ¿cómo te manejás con clientes en inglés?",
      "¿Tenés experiencia en caja/POS y atención al público?",
      "¿Hiciste cafés/shakes/smoothies? Barista es un plus."
    ],
    cashier_pm: [
      "Inglés requerido. ¿Podés trabajar hasta tarde (1-2am)?",
      "Experiencia en caja/POS y atención al público.",
      "¿Cafés/shakes/smoothies? Barista es plus."
    ],
    cook: [
      "¿Qué estaciones manejaste (plancha, frita, fría, sartén)? ¿Trabajaste bajo presión?",
      "¿Experiencia en plancha?",
      "Volumen de tickets/hora donde trabajaste."
    ],
    cook_pm: [
      "¿Qué estaciones manejaste (plancha, frita, fría, sartén)? ¿Trabajaste bajo presión?",
      "¿Experiencia en plancha?",
      "¿Podés trabajar hasta tarde (1-2am)?"
    ],
    pizzero: [
      "¿Experiencia como pizzero? ¿Qué estilo de pizza y cuánto tiempo?",
      "¿Sabés hacer la masa desde cero?"
    ],
    pizzero_pm: [
      "¿Experiencia como pizzero? ¿Qué estilo y cuánto tiempo?",
      "¿Sabés hacer la masa desde cero?",
      "¿Podés trabajar hasta tarde (1-2am)?"
    ],
    prep: [
      "¿Experiencia como prep? ¿Podés seguir recetas?",
      "¿Qué mis en place hacías?"
    ]
  },
  mexi: {
    cashier: [
      "Inglés requerido: ¿cómo te manejás con clientes?",
      "¿Tenés experiencia en caja/POS y atención al público?",
      "¿Hiciste cafés/shakes/smoothies? Barista es un plus."
    ],
    cook: [
      "¿Qué estaciones manejaste (plancha, frita, fría, sartén)? ¿Trabajaste bajo presión?",
      "¿Alguna vez trabajaste cocina mexicana o plancha de tacos?",
      "Volumen de tickets/hora donde trabajaste."
    ],
    prep: [
      "¿Experiencia como prep? ¿Podés seguir recetas?",
      "¿Qué mis en place hacías?"
    ],
    foodtruck: [
      "¿Experiencia atendiendo público y cocinando a la vez?",
      "¿Trabajaste plancha en un trailer/food truck?",
      "Inglés básico para clientes: ¿cómo te manejás?"
    ]
  }
};

const LATE_CLOSING_QUESTION_ES = "En caso de ser requerido, ¿podes trabajar el turno de noche, que puede ser hasta la 1 o 2 de la madrugada?";
const LATE_CLOSING_QUESTION_EN = "If required, are you able to work the night shift, which may go until 1 or 2am?";
const ENGLISH_LEVEL_QUESTION = "Para esta posición necesitamos inglés conversacional. ¿Qué nivel de inglés tenés?";
const ENGLISH_LEVEL_QUESTION_EN = "For this role we need conversational English. What is your English level?";
const ENGLISH_CHECK_QUESTION = "Can you describe your last job and what you did day to day?";
const DEFAULT_RECORDING_INTRO_ES = "{opener} Soy Mariana. Si preferís en inglés, decí English.";
const DEFAULT_RECORDING_INTRO_EN = "Hi {name}, I'm Mariana from {brand}. I'm calling about your application for {spoken_role}.";
const DEFAULT_RECORDING_CONSENT_ES = "Para compartir el resultado con el equipo, ¿te parece bien que grabemos esta llamada? Decí sí o no. También podés presionar 1 para sí o 2 para no.";
const DEFAULT_RECORDING_CONSENT_EN = "To share the result with the team, is it okay if we record this call? Say yes or no. Or press 1 for yes, 2 for no.";
const DEFAULT_RECORDING_CONFIRM_ES = "Para confirmar: ¿sí o no a grabar la llamada? También podés presionar 1 para sí, o 2 para no.";
const DEFAULT_RECORDING_CONFIRM_EN = "To confirm: yes or no to recording? You can also press 1 for yes or 2 for no.";
const DEFAULT_RECORDING_NO_RESPONSE_ES = "No te escuché, gracias por tu tiempo. Que tengas un buen día.";
const DEFAULT_RECORDING_NO_RESPONSE_EN = "I didn't catch that. Thanks for your time.";
const DEFAULT_RECORDING_DECLINE_ES = "Perfecto, no hay problema. Gracias por tu tiempo. Que tengas un buen día.";
const DEFAULT_RECORDING_DECLINE_EN = "Understood, no problem. Thanks for your time. Goodbye.";
const HUNG_UP_THRESHOLD_SEC = 20;
const OUTCOME_LABELS = {
  NO_ANSWER: "No contestó",
  DECLINED_RECORDING: "No aceptó la grabación",
  CONSENT_TIMEOUT: "No respondió al consentimiento de grabación",
  NO_SPEECH: "No emitió opinión",
  HUNG_UP: "El candidato colgó",
  CALL_DISCONNECTED: "Se desconectó la llamada",
  TRANSCRIPTION_FAILED: "No se pudo transcribir el audio"
};

const ADDRESS_BY_BRAND = {
  "new campo argentino": "6954 Collins Ave, Miami Beach, FL 33141, US",
  "mexi cafe": "6300 Collins Ave, Miami Beach, FL 33141, US",
  "yes cafe & pizza": "731 NE 79th St, Miami, FL 33138, US",
  "yes cafe pizza mimo 79th st": "731 NE 79th St, Miami, FL 33138, US",
  "yes pizza 79": "731 NE 79th St, Miami, FL 33138, US",
  "yes pizza": "731 NE 79th St, Miami, FL 33138, US",
  "yes cafe pizza": "731 NE 79th St, Miami, FL 33138, US",
  "yes cafe miami beach": "601 71st St, Miami Beach, FL 33141, US",
  "mexi trailer": "731 NE 79th St, Miami, FL 33138, US"
};

function normalizeKey(value) {
  return (value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function resolveAddress(brand, providedAddress) {
  const bKey = brandKey(brand);
  const brandEntry = roleConfig?.[bKey];
  const brandMeta = brandEntry && brandEntry._meta;
  if (brandMeta?.address) return brandMeta.address;
  if (providedAddress) return providedAddress;
  const key = normalizeKey(brand || "");
  return ADDRESS_BY_BRAND[key] || ADDRESS_BY_BRAND[normalizeKey(DEFAULT_BRAND)];
}

function resolveBrandDisplay(brand) {
  const bKey = brandKey(brand);
  const brandEntry = roleConfig?.[bKey];
  const brandMeta = brandEntry && brandEntry._meta;
  return brandMeta?.displayName || brand || DEFAULT_BRAND;
}

function toWss(httpUrl) {
  if (httpUrl.startsWith("https://")) return "wss://" + httpUrl.slice("https://".length);
  if (httpUrl.startsWith("http://")) return "ws://" + httpUrl.slice("http://".length);
  return httpUrl;
}

function xmlEscapeAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function roleKey(role) {
  const r = normalizeKey(role);
  if (r.includes("host")) return "hostess";
  if (r.includes("runner")) return "runner";
  if (r.includes("barista")) return "barista";
  if (r.includes("cashier") || r.includes("front")) return "cashier";
  if (r.includes("pizza")) return "pizzero";
  if (r.includes("dish")) return "dish";
  if (r.includes("prep")) return "prep";
  if (r.includes("cook") || r.includes("cocin")) return "cook";
  if (r.includes("server")) return "server";
  if (r.includes("food") && r.includes("truck")) return "foodtruck";
  return "general";
}

function roleNeedsEnglish(roleK, brand) {
  if (roleConfig) {
    const brandK = brand ? brandKey(brand) : null;
    const entries = brandK && roleConfig[brandK]
      ? [[brandK, roleConfig[brandK]]]
      : Object.entries(roleConfig);
    for (const [bKey, val] of entries) {
      if (bKey === "meta") continue;
      for (const [rk, entry] of Object.entries(val)) {
        if (rk === "_meta") continue;
        const norm = normalizeKey(rk);
        const aliases = Array.isArray(entry?.aliases) ? entry.aliases.map((a) => normalizeKey(a)) : [];
        if (norm === roleK || aliases.includes(roleK)) {
          if (typeof entry?.englishRequired === "boolean") return entry.englishRequired;
        }
      }
    }
  }
  return ["cashier", "server", "runner", "hostess", "barista", "foodtruck"].includes(roleK);
}

function displayRole(role, brand) {
  const rawKey = normalizeKey(role);
  const k = roleKey(role);
  if (roleConfig) {
    // try to find displayName (prefer brand-specific)
    const brandK = brand ? brandKey(brand) : null;
    const entries = brandK && roleConfig[brandK]
      ? [[brandK, roleConfig[brandK]]]
      : Object.entries(roleConfig);
    let aliasMatch = "";
    let keyAliasMatch = "";
    const containsMatches = [];
    const rawTokens = rawKey ? rawKey.split(" ").filter(Boolean) : [];
    for (const [bKey, val] of entries) {
      if (bKey === "meta") continue;
      for (const [rk, entry] of Object.entries(val)) {
        if (rk === "_meta") continue;
        const norm = normalizeKey(rk);
        const aliases = Array.isArray(entry?.aliases) ? entry.aliases.map((a) => normalizeKey(a)) : [];
        if (rawKey && norm === rawKey) {
          return entry?.displayName || role || rk;
        }
        if (!aliasMatch && rawKey && aliases.includes(rawKey)) {
          aliasMatch = entry?.displayName || role || rk;
        }
        if (norm === k) {
          return entry?.displayName || role || rk;
        }
        if (!keyAliasMatch && aliases.includes(k)) {
          keyAliasMatch = entry?.displayName || role || rk;
        }
        if (rawTokens.length === 1 && norm) {
          const tokens = norm.split(" ").filter(Boolean);
          if (tokens.includes(rawTokens[0])) {
            containsMatches.push(entry?.displayName || rk);
          }
        }
      }
    }
    if (aliasMatch) return aliasMatch;
    if (keyAliasMatch) return keyAliasMatch;
    if (containsMatches.length === 1) return containsMatches[0];
    if (containsMatches.length > 1) {
      return containsMatches.sort((a, b) => String(b).length - String(a).length)[0];
    }
  }
  switch (k) {
    case "cashier": return "cajero (front)";
    case "hostess": return "hostess";
    case "runner": return "runner";
    case "server": return "server/runner";
    case "cook": return "cocinero";
    case "prep": return "prep cook";
    case "dish": return "lavaplatos";
    case "pizzero": return "pizzero";
    case "foodtruck": return "food truck";
    case "barista": return "barista";
    default: return role || "rol";
  }
}

function brandKey(brand) {
  const b = normalizeKey(brand);
  if (roleConfig) {
    for (const [key, val] of Object.entries(roleConfig)) {
      if (key === "meta") continue;
      const normKey = normalizeKey(key);
      if (normKey === b) return key;
      const meta = val && val._meta;
      const display = normalizeKey(meta?.displayName || "");
      if (display && display === b) return key;
      const aliases = Array.isArray(meta?.aliases) ? meta.aliases.map((a) => normalizeKey(a)) : [];
      if (aliases.includes(b)) return key;
    }
  }
  if (b.includes("campo")) return "campo";
  if (b.includes("mexi") && b.includes("trailer")) return "mexitrailer";
  if (b.includes("mexi")) return "mexi";
  if (b.includes("yes")) return "yes";
  return "general";
}

function normalizePhone(num) {
  if (!num) return "";
  let s = String(num).trim();
  // If already starts with + and digits, keep plus and digits only
  if (s.startsWith("+")) {
    s = "+" + s.slice(1).replace(/[^0-9]/g, "");
  } else {
    s = s.replace(/[^0-9]/g, "");
  }
  // If no leading +, assume US and prepend +1 when length looks like 10 or 11
  if (!s.startsWith("+")) {
    if (s.length === 10) s = "+1" + s;
    else if (s.length === 11 && s.startsWith("1")) s = "+" + s;
  }
  return s;
}

function sanitizeRole(role) {
  if (!role) return role;
  const r = String(role);
  const atIdx = r.indexOf("@");
  return atIdx >= 0 ? r.slice(0, atIdx).trim() : r.trim();
}

function resolveRoleVariant(roleKey, brandK) {
  // handle PM variants for yes
  if (brandK === "yes") {
    const r = normalizeKey(roleKey);
    if (r.includes("cashier") && r.includes("pm")) return "cashier_pm";
    if (r.includes("cook") && r.includes("pm")) return "cook_pm";
    if (r.includes("pizzero") && r.includes("pm")) return "pizzero_pm";
  }
  return roleKey;
}

function roleBrandQuestions(brandK, roleK) {
  const v = resolveRoleVariant(roleK, brandK);
  const brandMap = ROLE_QUESTIONS[brandK] || {};
  const qs = brandMap[v] || brandMap[roleK] || ROLE_QUESTIONS[brandK]?.general || [];
  if (!qs.length && ROLE_QUESTIONS.general) return ROLE_QUESTIONS.general.general || [];
  return qs;
}

function needsLateClosingQuestion(brandK, brandName, roleK) {
  const normBrand = normalizeKey(brandName || "");
  const isYes = brandK === "yes" || normBrand.includes("yes cafe");
  const isMexiTrailer = brandK === "mexitrailer" || (normBrand.includes("mexi") && normBrand.includes("trailer"));
  if (isYes && (roleK === "cashier" || roleK === "cook" || roleK === "pizzero")) return true;
  if (isMexiTrailer && roleK === "foodtruck") return true;
  return false;
}

function withLateClosingQuestion(questions, brandK, brandName, roleK, langPref, overrideQuestion) {
  const list = Array.isArray(questions) ? [...questions] : [];
  if (!needsLateClosingQuestion(brandK, brandName, roleK)) return list;
  const question = overrideQuestion || (langPref === "en" ? LATE_CLOSING_QUESTION_EN : LATE_CLOSING_QUESTION_ES);
  const hasClosing = list.some((q) => {
    const norm = normalizeKey(q || "");
    return norm.includes("hora de cierre")
      || norm.includes("hasta tarde")
      || norm.includes("turno noche")
      || norm.includes("turno de noche")
      || norm.includes("madrugada")
      || norm.includes("night shift")
      || norm.includes("late shift")
      || norm.includes("closing time")
      || norm.includes("closing shift")
      || norm.includes("1 2am")
      || norm.includes("1 2 am")
      || norm.includes("1 o 2am")
      || norm.includes("1 o 2 am")
      || norm.includes("1 or 2am")
      || norm.includes("1 or 2 am")
      || norm.includes("1-2am")
      || norm.includes("1-2 am");
  });
  if (!hasClosing) list.push(question);
  return list;
}

function withEnglishRequiredQuestions(questions, needsEnglish, levelQuestion, checkQuestion) {
  const list = Array.isArray(questions) ? [...questions] : [];
  if (!needsEnglish) return list;
  const levelQ = levelQuestion || ENGLISH_LEVEL_QUESTION;
  const checkQ = checkQuestion || ENGLISH_CHECK_QUESTION;
  const hasLevel = list.some((q) => {
    const norm = normalizeKey(q || "");
    return norm.includes("ingles") || norm.includes("english");
  });
  const hasEnglishQuestion = list.some((q) => {
    const norm = normalizeKey(q || "");
    return norm.includes("can you")
      || norm.includes("in english")
      || norm.includes("describe your last job");
  });
  if (!hasLevel) list.push(levelQ);
  if (!hasEnglishQuestion) list.push(checkQ);
  return list;
}

function buildMandatoryBlock({ mustAsk, specificQs, needsEnglish, needsLateClosing, langPref, customQuestion, englishLevelQuestion, englishCheckQuestion, lateClosingQuestion }) {
  const lines = [];
  const header = langPref === "en"
    ? "MANDATORY — do not skip these. Integrate naturally in the conversation:"
    : "OBLIGATORIO — no omitas estos puntos. Integralos de forma natural en la conversación:";
  lines.push(header);
  if (mustAsk) {
    lines.push(langPref === "en" ? `- Checklist: ${mustAsk}` : `- Checklist: ${mustAsk}`);
  }
  if (needsLateClosing) {
    const q = lateClosingQuestion || (langPref === "en" ? LATE_CLOSING_QUESTION_EN : LATE_CLOSING_QUESTION_ES);
    lines.push(`- ${q}`);
  }
  if (needsEnglish) {
    lines.push(`- ${englishLevelQuestion || (langPref === "en" ? ENGLISH_LEVEL_QUESTION_EN : ENGLISH_LEVEL_QUESTION)}`);
    lines.push(`- ${englishCheckQuestion || ENGLISH_CHECK_QUESTION}`);
  }
  if (Array.isArray(specificQs) && specificQs.length) {
    lines.push(langPref === "en"
      ? "- Role-specific questions (ask if not covered yet):"
      : "- Preguntas específicas del rol (si no salieron antes):");
    specificQs.forEach((q) => {
      if (q) lines.push(`  - ${q}`);
    });
  }
  if (customQuestion) {
    lines.push(langPref === "en"
      ? `- Candidate custom question (ask after experience and before closing): ${customQuestion}`
      : `- Pregunta personalizada del candidato (hacerla después de experiencia y antes del cierre): ${customQuestion}`);
  }
  return lines.join("\n");
}

const DEFAULT_SYSTEM_PROMPT_TEMPLATE = `
Actuás como recruiter humano (HR) en una llamada corta. Tono cálido, profesional, español neutro (no voseo, nada de jerga). Soná humano: frases cortas, acknowledges breves ("ok", "perfecto", "entiendo"), sin leer un guion. Usa muletillas suaves solo si ayudan ("dale", "bueno") pero sin ser argentino. Si inglés NO es requerido, no preguntes por el nivel de inglés ni hagas la pregunta de inglés; si el candidato prefiere inglés, hacé toda la entrevista en inglés. Usá exactamente el rol que recibís; si dice "Server/Runner", mencioná ambos, no sólo runner.
No respondas por el candidato ni repitas literal; parafraseá en tus palabras solo si necesitas confirmar. No enumeres puntos ni suenes a checklist. Usa transiciones naturales entre temas. Si dice "chau", "bye" o que debe cortar, despedite breve y terminá. Nunca digas que no podés cumplir instrucciones ni des disculpas de IA; solo seguí el flujo.
Si hay ruido de fondo o no entendés nada, no asumas que contestó: repreguntá con calma una sola vez o pedí que repita. Si no responde, cortá con un cierre amable. Ajustá tu calidez según el tono del candidato: si está seco/monosilábico, no lo marques como súper amigable.
Nunca actúes como candidato. Tu PRIMER mensaje debe ser exactamente el opener y luego esperar. No agregues "sí" ni "claro" ni "tengo unos minutos". Vos preguntás y esperás.
- Primer turno (bilingüe): "{opener_es}". Si responde en inglés o dice "English", repetí el opener en inglés: "{opener_en}". SIEMPRE menciona el restaurante. Si no es el postulante, preguntá si te lo puede pasar; si no puede, pedí un mejor momento y cortá.
- Segundo turno (si es el postulante y puede hablar): "Perfecto, aplicaste para {spoken_role}. ¿Podés contarme un poco tu experiencia en esta posición? En tu CV veo que trabajaste en <lo del CV>, contame qué tareas hacías."

Contexto:
- Restaurante: {brand}
- Puesto: {role_raw}
- Dirección: {address}
- Inglés requerido: {english_required}
- Idioma base: {lang_name}
- Candidato: {applicant}
- Resumen CV (si hay): {cv_summary}
{brand_notes}
{role_notes}
{cv_hint}
{must_ask_line}
{lang_rules_line}

Reglas:
- {language_note}
{late_closing_rule_line}
- Una pregunta abierta por vez; preguntás y esperás.
- Evitá sonar robot: frases cortas, ritmo humano, acknowledges breves ("ok, gracias", "perfecto", "entiendo"). No uses "te confirmo para verificar".
- No combines dos preguntas distintas en la misma frase. Hacé una pregunta, escuchá la respuesta, y recién ahí la siguiente (ej. no mezcles salario con permanencia en la misma oración).
- No repitas literal lo que dijo; si necesitás, resumí en tus palabras de forma breve.
- No encadenes ni superpongas preguntas: hacé UNA pregunta, esperá la respuesta completa. Solo si no queda clara, pedí una aclaración breve y recién después pasá al siguiente tema.
- No preguntes papeles/documentos. No preguntes "hasta cuándo se queda en Miami".
- Si hay resumen de CV, usalo para personalizar: referenciá el último trabajo del CV, confirma tareas/fechas, y preguntá brevemente por disponibilidad/salario si aparecen. Si el CV está vacío, seguí el flujo normal sin inventar.
 - Si hay CV usable, referenciá el último trabajo del CV, confirma tareas/fechas, y repreguntá. Si el CV no es usable (ej. vacío, “datos cv”, “cv adjunto”, “no pude leer”), no lo menciones y usá preguntas genéricas de experiencia.
- SIEMPRE preguntá por zona y cómo llega (en TODAS las posiciones). No saltees la pregunta de zona/logística.
- OBLIGATORIO: preguntá si está viviendo en Miami/EE.UU. de forma permanente o temporal. Si dice temporal, preguntá cuánto tiempo planea quedarse (sin presionar fechas exactas).
- Zona/logística: primero preguntá "¿En qué zona vivís?" y después "¿Te queda cómodo llegar al local? Estamos en {address}" (solo si hay dirección). No inventes direcciones.
- Zona/logística: primero preguntá "¿En qué zona vivís?" y después "¿Te queda cómodo llegar al local? Estamos en {address}" (solo si hay dirección). No inventes direcciones. Si la zona mencionada no es en Miami/South Florida o suena lejana (ej. otra ciudad/país), pedí aclarar dónde está ahora y marcá que no es viable el traslado.
- Si inglés es requerido ({english_required}), SIEMPRE preguntá nivel y hacé una pregunta en inglés. No lo saltees. Si inglés NO es requerido, no evalúes nivel de inglés.
- Inglés requerido: hacé al menos una pregunta completa en inglés (por ejemplo: "Can you describe your last job and what you did day to day?") y esperá la respuesta en inglés. Si no responde o cambia a español, marcá internamente que no es conversacional, agradecé y seguí en español sin decirle que le falta inglés.
- Si el candidato prefiere hablar solo en inglés o dice que no habla español, seguí la entrevista en inglés y completá todas las preguntas igual (no cortes ni discrimines).
- Si el candidato dice explícitamente "no hablo español" o responde repetidamente en inglés, cambia a inglés para el resto de la entrevista (todas las preguntas y acknowledgements) y no vuelvas a español.
- Si dice "I don't speak Spanish"/"no hablo español", reiniciá el opener en inglés: "Hi {first_name_or_there}, I'm calling about your application for {spoken_role} at {brand}. Do you have a few minutes to talk?" y continuá toda la entrevista en inglés.
- Si notás dubitación o respuestas cortas en inglés ("hello", "yes", etc.), preguntá explícitamente: "¿Te sentís más cómodo si seguimos la entrevista en inglés?" y, si dice que sí, cambiá a inglés para el resto.
- Si notás dubitación o respuestas cortas en inglés ("hello", "yes", etc.), preguntá en inglés: "Would you prefer we continue the interview in English?" y, si dice que sí, cambiá a inglés para el resto.
- Si el candidato responde en inglés (aunque sea "hello", "yes", "hi"), preguntá en inglés de inmediato: "Would you prefer we continue the interview in English?" Si responde en inglés o afirma, repetí el opener en inglés ("Hi {first_name_or_there}, I'm calling about your application for {spoken_role} at {brand}. Do you have a few minutes to talk?") y seguí toda la entrevista en inglés sin volver al español, salvo que explícitamente pida español.
- Si escuchás "hello", "hi", "who is this" u otra respuesta en inglés, repetí el opener en inglés de inmediato y quedate en inglés para toda la entrevista, salvo que el candidato pida seguir en español. ESTO ES MANDATORIO.
- Preguntá SIEMPRE (no omitir): expectativa salarial abierta ("¿Tenés alguna expectativa salarial por hora?") y si está viviendo en Miami de forma permanente o temporal ("¿Estás viviendo en Miami ahora o es algo temporal?").
- Si el CV menciona tareas específicas o idiomas (ej. barista, caja, inglés), referencialas en tus preguntas: "En el CV veo que estuviste en X haciendo Y, ¿me contás más?".
- Usá solo el primer nombre si está: "Hola {first_name_or_question}". Podés repetirlo ocasionalmente para personalizar.
- CV: nombra al menos un empleo del CV y repreguntá tareas y por qué se fue (por ejemplo, si ves "El Patio" o "Don Carlos" en el CV, preguntá qué hacía allí y por qué salió).
- Si el candidato interrumpe el opener con un saludo/“hola” o te contesta antes de pedir permiso, repetí el opener una sola vez con su nombre y volvé a pedir si puede hablar (sin decir “ok”).
- Si te interrumpen antes de terminar el opener (ej. dicen “hola” mientras hablás), repetí el opener completo una sola vez con su nombre y el restaurante, y pedí permiso de nuevo.
- Después de “Perfecto, mi nombre es Mariana y yo hago la entrevista inicial”, no te quedes esperando: en ese mismo turno seguí con la primera pregunta de experiencia.
- No inventes datos (horarios, sueldo, beneficios, turnos, managers). Si preguntan por horarios/sueldo/beneficios/detalles del local que no tenés, respondé breve: "Yo hago la entrevista inicial; esos detalles te los confirma el manager en la próxima etapa", y retomá tus preguntas.
- Si atiende otra persona o no sabés si es el postulante, preguntá: "¿Con quién hablo? ¿Se encuentra {first_name_or_postulante}?" Si no está, pedí un mejor momento o corta con un cierre amable sin seguir el cuestionario.
- Checklist obligatorio que debes cubrir siempre (adaptalo a conversación, pero no lo saltees): saludo con nombre, experiencia/tareas (incluyendo CV si hay), zona y cómo llega, disponibilidad, expectativa salarial, prueba (sin prometer), inglés si es requerido (nivel + pregunta en inglés), cierre.
- Preguntas específicas para este rol/local (metelas de forma natural):
{specific_questions}

Flujo sugerido (adaptalo como conversación, no como guion rígido):
1) Apertura: "Hola{first_name_or_blank}, te llamo por una entrevista de trabajo en {brand}. ¿Tenés unos minutos para hablar?" Si no es el postulante, pedí hablar con él/ella o un mejor momento y cortá.
   Si dice que sí y es el postulante: "Perfecto, aplicaste para {spoken_role}. ¿Podés contarme un poco tu experiencia en esta posición? En tu CV veo que trabajaste en <lo del CV>, contame qué tareas hacías."
   Si no puede: "Perfecto, gracias. Te escribimos para coordinar." y cortás.
2) Experiencia:
   - Si hay CV, arrancá con él: "En tu CV veo que tu último trabajo fue en <extraelo del CV>. ¿Qué tareas hacías ahí en un día normal?" y luego repreguntá breve sobre tareas (caja/pedidos/runner/café/pagos según aplique).
   - Si no hay CV o no se ve claro: (si no lo preguntaste ya) "Contame rápido tu experiencia en {spoken_role}: ¿dónde fue tu último trabajo y qué hacías en un día normal?"
   - Repreguntá breve sobre tareas: "¿Qué hacías ahí? ¿Caja, pedidos, runner, café, pagos?"
   - "¿Por qué te fuiste?"
   - Si hay CV: "En el CV veo que estuviste en <lo que diga el CV>. ¿Cuánto tiempo? ¿Qué hacías exactamente? ¿Por qué te fuiste?"
3) Cercanía + movilidad:
   - "¿En qué zona vivís?"
   - "¿Te queda cómodo llegar al local? Estamos en {address}." (solo si hay dirección)
   - Si vive lejos: "¿Tenés movilidad/auto para llegar?"
   - Preguntá de forma abierta: "¿Estás viviendo en Miami ahora o es algo temporal?"
4) Disponibilidad: "¿Cómo es tu disponibilidad normalmente? Semana, fines de semana, día/noche… lo que puedas."
5) Expectativa salarial: "Tenés alguna expectativa salarial por hora?"
6) Prueba (sin prometer): "Si te invitamos, ¿cuándo podrías venir a hacer una prueba?"
7) Inglés (si aplica, NO lo saltees):
   - "Para esta posición necesitamos inglés conversacional. ¿Qué nivel de inglés tenés?" (igual si ya ofreciste seguir en inglés).
   - Luego, sí o sí, hacé al menos una pregunta en inglés y esperá la respuesta: "Can you describe your last job and what you did day to day?"
   - Si no se puede comunicar o no responde en inglés, marcá que no es conversacional y seguí sin insistir.
   - Si en el CV menciona inglés/idiomas, mencioná que lo viste y verificá.
Cierre: "Gracias, paso toda la info al equipo; si seguimos, te escriben por WhatsApp." (no prometas prueba ni confirmes fecha).
`.trim();

function renderPromptTemplate(template, vars) {
  if (!template) return "";
  const mapped = {};
  for (const [key, value] of Object.entries(vars || {})) {
    mapped[key.toLowerCase()] = value;
  }
  return String(template).replace(/{([a-z0-9_]+)}/gi, (match, key) => {
    const lookup = key.toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(mapped, lookup)) return match;
    const value = mapped[lookup];
    return value === undefined || value === null ? "" : String(value);
  });
}

function buildRecordingVars({ brand, role, applicant, lang }) {
  const brandDisplay = resolveBrandDisplay(brand);
  const spokenRole = displayRole(role, brand);
  const firstName = (applicant || "").split(/\s+/)[0] || "";
  const openerEs = buildMetaOpener({ brand, role, applicant, lang: "es" });
  const openerEn = buildMetaOpener({ brand, role, applicant, lang: "en" });
  const opener = lang === "en" ? openerEn : openerEs;
  return {
    name: firstName,
    first_name: firstName,
    first_name_or_blank: firstName ? ` ${firstName}` : "",
    first_name_or_there: firstName || (lang === "en" ? "there" : "allí"),
    brand: brandDisplay,
    brand_display: brandDisplay,
    role,
    spoken_role: spokenRole,
    opener,
    opener_es: openerEs,
    opener_en: openerEn
  };
}

function getRecordingCopy(lang, key, fallback, vars) {
  const meta = roleConfig?.meta || {};
  const field = `${key}_${lang}`;
  const template = typeof meta[field] === "string" ? meta[field] : "";
  const selected = template && template.trim() ? template : fallback;
  return renderPromptTemplate(selected, vars).trim();
}

function getMandatoryCopy(lang, key, fallback) {
  const meta = roleConfig?.meta || {};
  const field = `${key}_${lang}`;
  const value = typeof meta[field] === "string" ? meta[field].trim() : "";
  return value || fallback;
}

function buildMetaOpener({ brand, role, applicant, lang }) {
  const metaCfg = roleConfig?.meta || {};
  const brandDisplay = resolveBrandDisplay(brand);
  const spokenRole = displayRole(role, brand);
  const firstName = (applicant || "").split(/\s+/)[0] || "";
  const nameVar = firstName || (lang === "en" ? "there" : "allí");
  const template = (lang === "en" ? metaCfg.opener_en : metaCfg.opener_es) || "";
  const fallback = lang === "en"
    ? (firstName
        ? `Hi ${firstName}, I'm calling about your application for ${spokenRole} at ${brandDisplay}. Do you have a minute to talk?`
        : `Hi, I'm calling about your application for ${spokenRole} at ${brandDisplay}. Do you have a minute to talk?`)
    : (firstName
        ? `Hola ${firstName}, te llamo por una entrevista de trabajo en ${brandDisplay} para ${spokenRole}. ¿Tenés un minuto para hablar?`
        : `Hola, te llamo por una entrevista de trabajo en ${brandDisplay} para ${spokenRole}. ¿Tenés un minuto para hablar?`);
  const rendered = template && template.trim()
    ? renderPromptTemplate(template, {
      name: nameVar,
      brand: brandDisplay,
      role: spokenRole,
      spoken_role: spokenRole,
      first_name_or_blank: firstName ? ` ${firstName}` : "",
      first_name_or_there: nameVar,
      first_name_or_question: firstName || "¿cómo te llamás?",
      first_name_or_postulante: firstName || "el postulante"
    }).trim()
    : "";
  return rendered || fallback;
}

function buildInstructions(ctx) {
  const metaCfg = roleConfig?.meta || {};
  const brandDisplay = resolveBrandDisplay(ctx.brand);
  const openerEs = buildMetaOpener({ brand: ctx.brand, role: ctx.role, applicant: ctx.applicant, lang: "es" });
  const openerEn = buildMetaOpener({ brand: ctx.brand, role: ctx.role, applicant: ctx.applicant, lang: "en" });
  const langNote = metaCfg.lang_rules ? `Notas de idioma: ${metaCfg.lang_rules}` : "";
  const rKey = roleKey(ctx.role);
  const bKey = brandKey(ctx.brand);
  const spokenRole = ctx.spokenRole || displayRole(ctx.role, ctx.brand);
  const firstName = (ctx.applicant || "").split(/\s+/)[0] || "";
  const needsEnglish = typeof ctx.englishRequired === "boolean"
    ? ctx.englishRequired
    : roleNeedsEnglish(rKey, ctx.brand);
  const langPref = ctx.lang === "en" ? "en" : "es";
  const needsLateClosing = needsLateClosingQuestion(bKey, ctx.brand, rKey);
  const lateClosingQuestion = getMandatoryCopy(langPref, "late_closing_question", langPref === "en" ? LATE_CLOSING_QUESTION_EN : LATE_CLOSING_QUESTION_ES);
  const englishLevelQuestion = getMandatoryCopy(langPref, "english_level_question", langPref === "en" ? ENGLISH_LEVEL_QUESTION_EN : ENGLISH_LEVEL_QUESTION);
  const englishCheckQuestion = getMandatoryCopy(langPref, "english_check_question", ENGLISH_CHECK_QUESTION);
  const lateClosingRule = needsLateClosing
    ? `OBLIGATORIO: preguntá exactamente: "${lateClosingQuestion}"`
    : "";
  const languageNote = langPref === "en"
    ? "Idioma actual: inglés. Toda la entrevista en inglés; no mezcles español salvo que el candidato lo pida."
    : "Idioma actual: español. Entrevista en español. Si el candidato pide inglés o responde en inglés, cambiá a inglés y no mezcles.";
  const cfg = getRoleConfig(ctx.brand, ctx.role) || {};
  const roleNotesBase = ROLE_NOTES[rKey] ? `Notas rol (${rKey}): ${ROLE_NOTES[rKey]}` : "Notas rol: general";
  const roleNotesCfg = cfg.notes ? `Notas rol (config): ${cfg.notes}` : "";
  const roleNotes = roleNotesCfg ? `${roleNotesBase}\n${roleNotesCfg}` : roleNotesBase;
  const brandNotes = BRAND_NOTES[normalizeKey(ctx.brand)] ? `Contexto local: ${BRAND_NOTES[normalizeKey(ctx.brand)]}` : "";
  let cvSummaryClean = (ctx.cvSummary || "").trim();
  const unusableCv = !cvSummaryClean || cvSummaryClean.length < 10 || /sin\s+cv|no\s+pude\s+leer|cv\s+adjunto|no\s+texto|datos\s+cv/i.test(cvSummaryClean);
  if (unusableCv) cvSummaryClean = "";
  const hasCv = !!cvSummaryClean;
  const cvCue = hasCv ? `Pistas CV: ${cvSummaryClean}` : "Pistas CV: sin CV usable.";
  const baseQs = cfg.questions && cfg.questions.length ? cfg.questions : roleBrandQuestions(bKey, rKey);
  const withLateClosing = withLateClosingQuestion(baseQs, bKey, ctx.brand, rKey, langPref, lateClosingQuestion);
  const specificQs = withEnglishRequiredQuestions(withLateClosing, needsEnglish, englishLevelQuestion, englishCheckQuestion);
  const promptTemplate = (metaCfg.system_prompt || "").trim() || DEFAULT_SYSTEM_PROMPT_TEMPLATE;
  const customQuestion = (ctx.customQuestion || ctx.custom_question || "").toString().trim();
  const promptVars = {
    name: firstName,
    first_name: firstName,
    first_name_or_blank: firstName ? ` ${firstName}` : "",
    first_name_or_there: firstName || "there",
    first_name_or_question: firstName || "¿cómo te llamás?",
    first_name_or_postulante: firstName || "el postulante",
    brand: brandDisplay,
    brand_display: brandDisplay,
    role: ctx.role,
    role_raw: ctx.role,
    role_display: spokenRole,
    spoken_role: spokenRole,
    address: ctx.address,
    english_required: needsEnglish ? "sí" : "no",
    english_required_en: needsEnglish ? "yes" : "no",
    lang: langPref,
    lang_name: langPref === "en" ? "inglés" : "español",
    applicant: ctx.applicant || "no informado",
    cv_summary: ctx.cvSummary || "sin CV",
    cv_summary_clean: cvSummaryClean,
    cv_hint: cvCue,
    brand_notes: brandNotes,
    role_notes: roleNotes,
    must_ask: metaCfg.must_ask || "",
    must_ask_line: metaCfg.must_ask ? `Obligatorio cubrir: ${metaCfg.must_ask}` : "",
    lang_rules: metaCfg.lang_rules || "",
    lang_rules_line: langNote,
    language_note: languageNote,
    opener_es: openerEs,
    opener_en: openerEn,
    late_closing_question: lateClosingQuestion,
    late_closing_required: needsLateClosing ? "sí" : "no",
    late_closing_rule: lateClosingRule,
    late_closing_rule_line: lateClosingRule ? `- ${lateClosingRule}` : "",
    specific_questions: specificQs.map(q => `- ${q}`).join("\n"),
    specific_questions_inline: specificQs.join("; "),
    custom_question: customQuestion,
    runtime_instructions: metaCfg.runtime_instructions || ""
  };
  const rendered = renderPromptTemplate(promptTemplate, promptVars).trim();
  const mandatoryBlock = buildMandatoryBlock({
    mustAsk: metaCfg.must_ask || "",
    specificQs,
    needsEnglish,
    needsLateClosing,
    langPref,
    customQuestion,
    englishLevelQuestion,
    englishCheckQuestion,
    lateClosingQuestion
  });
  const runtimeExtraRaw = (metaCfg.runtime_instructions || "").trim();
  const runtimeExtra = runtimeExtraRaw ? renderPromptTemplate(runtimeExtraRaw, promptVars).trim() : "";
  return [rendered, mandatoryBlock, runtimeExtra].filter(Boolean).join("\n\n").trim();
}

function parseEnglishRequired(value) {
  if (value === null || value === undefined) return DEFAULT_ENGLISH_REQUIRED;
  const v = String(value).toLowerCase().trim();
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  return DEFAULT_ENGLISH_REQUIRED;
}

function resolveEnglishRequired(brand, role, payload) {
  const cfg = getRoleConfig(brand, role);
  if (cfg && typeof cfg.englishRequired === "boolean") return cfg.englishRequired;
  const hasExplicit = !!payload && Object.prototype.hasOwnProperty.call(payload, "englishRequired");
  if (hasExplicit && payload.englishRequired !== null && payload.englishRequired !== undefined && payload.englishRequired !== "") {
    return parseEnglishRequired(payload.englishRequired);
  }
  return roleNeedsEnglish(roleKey(role), brand);
}

function outcomeLabel(outcome) {
  return OUTCOME_LABELS[outcome] || "";
}

function setOutcome(call, outcome, detail) {
  if (!call) return;
  if (!call.outcome) call.outcome = outcome;
  if (detail && !call.noTranscriptReason) call.noTranscriptReason = detail;
}

function inferIncompleteOutcome(call) {
  if (!call || call.outcome) return;
  if (!call.userSpoke) {
    setOutcome(call, "NO_SPEECH", outcomeLabel("NO_SPEECH"));
    return;
  }
  if (typeof call.durationSec === "number" && call.durationSec > 0 && call.durationSec <= HUNG_UP_THRESHOLD_SEC) {
    setOutcome(call, "HUNG_UP", outcomeLabel("HUNG_UP"));
    return;
  }
  setOutcome(call, "CALL_DISCONNECTED", outcomeLabel("CALL_DISCONNECTED"));
}

function buildCallFromPayload(payload, extra = {}) {
  const brand = payload?.brand || DEFAULT_BRAND;
  const roleClean = sanitizeRole(payload?.role || DEFAULT_ROLE);
  const englishRequired = resolveEnglishRequired(brand, roleClean, payload || {});
  const address = resolveAddress(brand, payload?.address || null);
  const resumeUrl = payload?.resume_url || payload?.resumeUrl || "";
  return {
    callSid: extra.callSid || null,
    to: normalizePhone(extra.to || payload?.to || ""),
    from: null,
    brand,
    role: roleClean,
    spokenRole: displayRole(roleClean, brand),
    englishRequired,
    address,
    applicant: payload?.applicant || "",
    cvSummary: payload?.cv_summary || payload?.cvSummary || "",
    cvText: payload?.cv_text || payload?.cvText || payload?.cv_summary || "",
    cvId: payload?.cv_id || payload?.cvId || "",
    customQuestion: payload?.custom_question || payload?.customQuestion || "",
    resumeUrl,
    recordingStarted: false,
    transcriptText: "",
    scoring: null,
    recordingPath: null,
    recordingToken: null,
    whatsappSent: false,
    audioUrl: payload?.audio_url || "",
    cvUrl: payload?.cv_url || payload?.cvUrl || resumeUrl || "",
    outcome: null,
    noTranscriptReason: null,
    incomplete: true,
    startedAt: Date.now(),
    durationSec: null
  };
}

function normalizeCallStatus(status) {
  return String(status || "").toLowerCase().trim();
}

function isActiveCallStatus(status) {
  const normalized = normalizeCallStatus(status);
  return ACTIVE_CALL_STATUSES.has(normalized);
}

function collectActiveCalls(allowedBrands) {
  const byCv = new Map();
  const byPhone = new Map();
  const now = Date.now();
  const allowedSet = Array.isArray(allowedBrands) && allowedBrands.length
    ? new Set(allowedBrands.map((b) => brandKey(b)).filter(Boolean))
    : null;
  for (const call of callsByCallSid.values()) {
    if (!call) continue;
    if (call.expiresAt && call.expiresAt < now) continue;
    const status = normalizeCallStatus(call.callStatus || call.status);
    if (!isActiveCallStatus(status)) continue;
    if (call.outcome) continue;
    const bKey = brandKey(call.brand || "");
    if (allowedSet && bKey && !allowedSet.has(bKey)) continue;
    const cvId = call.cvId || call.cv_id || "";
    if (cvId) byCv.set(cvId, status);
    const phone = normalizePhone(call.to || call.phone || "");
    if (phone && bKey) {
      const key = `${bKey}|${phone}`;
      if (!byPhone.has(key)) byPhone.set(key, status);
    }
  }
  return { byCv, byPhone };
}

function attachActiveCall(entry, activeIndex) {
  const result = { ...entry };
  let status = "";
  if (entry?.id && activeIndex.byCv.has(entry.id)) {
    status = activeIndex.byCv.get(entry.id);
  }
  if (!status) {
    const bKey = entry.brandKey || brandKey(entry.brand || "");
    const phone = normalizePhone(entry.phone || "");
    const key = bKey && phone ? `${bKey}|${phone}` : "";
    if (key && activeIndex.byPhone.has(key)) {
      status = activeIndex.byPhone.get(key);
    }
  }
  result.active_call = !!status;
  result.active_call_status = status || "";
  return result;
}

// --- in-memory stores with TTL ---
const CALL_TTL_MS = 30 * 60 * 1000; // 30 minutes
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const callsByStream = new Map(); // streamSid -> call
const callsByCallSid = new Map(); // callSid -> call
const lastCallByNumber = new Map(); // toNumber -> { payload, expiresAt }
const smsSentBySid = new Map(); // callSid -> expiresAt
const noAnswerSentBySid = new Map(); // callSid -> expiresAt
const tokens = new Map(); // token -> { path?, callSid?, expiresAt }
const voiceCtxByToken = new Map(); // token -> { payload, expiresAt }
const userSessions = new Map(); // token -> { email, role, allowedBrands, expiresAt }
const MAX_CALL_HISTORY = 500;
const CALL_HISTORY_PATH = process.env.CALL_HISTORY_PATH || path.join(__dirname, "data", "calls.json");
const CALL_HISTORY_SAVE_DELAY_MS = 2000;
const callHistory = [];
const callHistoryByKey = new Map();
let callHistorySaveTimer = null;
let callHistorySaving = false;
const MAX_CV_STORE = 500;
const CV_STORE_PATH = process.env.CV_STORE_PATH || path.join(__dirname, "data", "cvs.json");
const CV_STORE_SAVE_DELAY_MS = 2000;
const cvStore = [];
const cvStoreById = new Map();
let cvStoreSaveTimer = null;
let cvStoreSaving = false;
const pushSubscriptions = new Map();
const ACTIVE_CALL_STATUSES = new Set(["queued", "initiated", "ringing", "answered", "in-progress", "in progress"]);
let roleConfig = null;
let roleConfigSource = "defaults";
const recordingsDir = path.join("/tmp", "recordings");
fs.mkdirSync(recordingsDir, { recursive: true });
const rolesConfigPath = path.join(__dirname, "config", "roles.json");
const ROLE_CONFIG_DB_KEY = "roles_config";
const SYSTEM_PROMPT_STORE_KEY = "system_prompt_store";
const systemPromptStorePath = path.join(__dirname, "system_prompts.json");
function buildDbSslConfig() {
  if (!DATABASE_SSL) return undefined;
  let ca = "";
  if (DATABASE_SSL_CA_BASE64) {
    try {
      ca = Buffer.from(DATABASE_SSL_CA_BASE64, "base64").toString("utf8");
    } catch (err) {
      console.error("[db] failed to decode DATABASE_SSL_CA_BASE64", err.message);
    }
  } else if (DATABASE_SSL_CA_RAW) {
    ca = DATABASE_SSL_CA_RAW.includes("\\n") ? DATABASE_SSL_CA_RAW.replace(/\\n/g, "\n") : DATABASE_SSL_CA_RAW;
  }
  if (ca) {
    const rejectUnauthorized = DATABASE_SSL_REJECT_UNAUTHORIZED || false;
    return { rejectUnauthorized, ca };
  }
  return { rejectUnauthorized: false };
}

const dbPool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: buildDbSslConfig()
    })
  : null;
const spacesEnabled = !!(SPACES_BUCKET && SPACES_KEY && SPACES_SECRET && SPACES_ENDPOINT);
const s3Client = spacesEnabled
  ? new S3Client({
      region: SPACES_REGION || "us-east-1",
      endpoint: SPACES_ENDPOINT,
      credentials: { accessKeyId: SPACES_KEY, secretAccessKey: SPACES_SECRET }
    })
  : null;

function cleanup() {
  const now = Date.now();
  for (const [k, v] of callsByStream.entries()) {
    if (v.expiresAt && v.expiresAt < now) callsByStream.delete(k);
  }
  for (const [k, v] of callsByCallSid.entries()) {
    if (v.expiresAt && v.expiresAt < now) callsByCallSid.delete(k);
  }
  for (const [k, v] of lastCallByNumber.entries()) {
    if (v.expiresAt && v.expiresAt < now) lastCallByNumber.delete(k);
  }
  for (const [k, v] of smsSentBySid.entries()) {
    if (v && v < now) smsSentBySid.delete(k);
  }
  for (const [k, v] of noAnswerSentBySid.entries()) {
    if (v && v < now) noAnswerSentBySid.delete(k);
  }
  for (const [k, v] of voiceCtxByToken.entries()) {
    if (v.expiresAt && v.expiresAt < now) voiceCtxByToken.delete(k);
  }
  for (const [k, v] of tokens.entries()) {
    if (v.expiresAt && v.expiresAt < now) tokens.delete(k);
  }
  for (const [k, v] of userSessions.entries()) {
    if (v.expiresAt && v.expiresAt < now) userSessions.delete(k);
  }
}
setInterval(cleanup, 5 * 60 * 1000).unref();

function randomToken() {
  return crypto.randomBytes(16).toString("hex");
}

function loadRoleConfigFromFile() {
  try {
    const raw = fs.readFileSync(rolesConfigPath, "utf8");
    roleConfig = JSON.parse(raw);
    roleConfigSource = "file";
    console.log("[config] roles.json loaded");
  } catch (err) {
    console.error("[config] failed to load roles.json, using defaults", err.message);
    roleConfig = null;
    roleConfigSource = "defaults";
  }
}
loadRoleConfigFromFile();

async function loadRoleConfigFromDb() {
  if (!dbPool) return false;
  try {
    const resp = await dbPool.query("SELECT value FROM app_config WHERE key = $1", [ROLE_CONFIG_DB_KEY]);
    const config = resp.rows?.[0]?.value;
    if (config && typeof config === "object") {
      roleConfig = config;
      roleConfigSource = "db";
      console.log("[config] roles loaded from db");
      return true;
    }
  } catch (err) {
    console.error("[config] failed to load roles from db", err.message);
  }
  return false;
}

async function saveRoleConfigToDb(config) {
  if (!dbPool || !config) return false;
  try {
    await dbPool.query(
      `
      INSERT INTO app_config (key, value, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value,
          updated_at = NOW()
    `,
      [ROLE_CONFIG_DB_KEY, config]
    );
    roleConfigSource = "db";
    return true;
  } catch (err) {
    console.error("[config] failed to save roles to db", err.message);
    return false;
  }
}

async function persistRoleConfig(config) {
  if (dbPool) {
    const savedToDb = await saveRoleConfigToDb(config);
    if (!savedToDb) return false;
    return true;
  }
  try {
    const serialized = JSON.stringify(config, null, 2);
    await fs.promises.writeFile(rolesConfigPath, serialized, "utf8");
    roleConfigSource = "file";
    return true;
  } catch (err) {
    console.error("[config] failed to save roles.json", err.message);
    return false;
  }
}

function normalizePromptStore(store) {
  return {
    templates: Array.isArray(store?.templates) ? store.templates : [],
    history: Array.isArray(store?.history) ? store.history : []
  };
}

async function loadPromptStore() {
  if (dbPool) {
    try {
      const resp = await dbPool.query("SELECT value FROM app_config WHERE key = $1", [SYSTEM_PROMPT_STORE_KEY]);
      const raw = resp.rows?.[0]?.value;
      return normalizePromptStore(raw || {});
    } catch (err) {
      console.error("[prompt-store] failed to load from db", err.message);
    }
    return normalizePromptStore({});
  }
  try {
    const raw = await fs.promises.readFile(systemPromptStorePath, "utf8");
    return normalizePromptStore(JSON.parse(raw));
  } catch (err) {
    return normalizePromptStore({});
  }
}

async function loadPromptStoreWithSource() {
  if (dbPool) {
    try {
      const resp = await dbPool.query("SELECT value FROM app_config WHERE key = $1", [SYSTEM_PROMPT_STORE_KEY]);
      const raw = resp.rows?.[0]?.value;
      return { store: normalizePromptStore(raw || {}), source: "db" };
    } catch (err) {
      console.error("[prompt-store] failed to load from db", err.message);
    }
  }
  try {
    const raw = await fs.promises.readFile(systemPromptStorePath, "utf8");
    return { store: normalizePromptStore(JSON.parse(raw)), source: "file" };
  } catch (err) {
    return { store: normalizePromptStore({}), source: "memory" };
  }
}

async function savePromptStore(store) {
  const normalized = normalizePromptStore(store);
  if (dbPool) {
    try {
      await dbPool.query(
        `
        INSERT INTO app_config (key, value, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value,
            updated_at = NOW()
      `,
        [SYSTEM_PROMPT_STORE_KEY, normalized]
      );
      return true;
    } catch (err) {
      console.error("[prompt-store] failed to save to db", err.message);
      return false;
    }
  }
  try {
    await fs.promises.writeFile(systemPromptStorePath, JSON.stringify(normalized, null, 2), "utf8");
    return true;
  } catch (err) {
    console.error("[prompt-store] failed to save file", err.message);
    return false;
  }
}

async function appendPromptHistory(prompt) {
  const clean = (prompt || "").trim();
  if (!clean) return null;
  const store = await loadPromptStore();
  const history = Array.isArray(store.history) ? store.history : [];
  if (history.length && history[0]?.prompt === clean) return store;
  history.unshift({ id: randomToken(), prompt: clean, created_at: new Date().toISOString() });
  store.history = history.slice(0, 10);
  await savePromptStore(store);
  return store;
}

function ensureDirForFile(filePath) {
  if (!filePath) return;
  const dir = path.dirname(filePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    if (err.code !== "EEXIST") {
      console.error("[call-history] failed to create directory", err);
    }
  }
}

function hydrateCallHistory(entries) {
  callHistory.length = 0;
  callHistoryByKey.clear();
  if (!Array.isArray(entries)) return;
  entries.slice(0, MAX_CALL_HISTORY).forEach((entry) => {
    if (!entry || typeof entry !== "object") return;
    if (!entry.brandKey && entry.brand) entry.brandKey = brandKey(entry.brand);
    if (!entry.roleKey && entry.role) entry.roleKey = roleKey(entry.role);
    const key = entry._key || entry.callId || `${entry.phone || "na"}:${entry.created_at || new Date().toISOString()}`;
    entry._key = key;
    callHistory.push(entry);
    callHistoryByKey.set(key, entry);
  });
}

async function saveCallHistory() {
  if (!CALL_HISTORY_PATH || callHistorySaving) return;
  callHistorySaving = true;
  try {
    ensureDirForFile(CALL_HISTORY_PATH);
    const payload = JSON.stringify(callHistory.slice(0, MAX_CALL_HISTORY), null, 2);
    const tmpPath = `${CALL_HISTORY_PATH}.tmp`;
    await fs.promises.writeFile(tmpPath, payload, "utf8");
    await fs.promises.rename(tmpPath, CALL_HISTORY_PATH);
  } catch (err) {
    console.error("[call-history] save failed", err);
  } finally {
    callHistorySaving = false;
  }
}

function scheduleCallHistorySave() {
  if (!CALL_HISTORY_PATH) return;
  if (callHistorySaveTimer) return;
  callHistorySaveTimer = setTimeout(() => {
    callHistorySaveTimer = null;
    saveCallHistory();
  }, CALL_HISTORY_SAVE_DELAY_MS);
  if (callHistorySaveTimer.unref) callHistorySaveTimer.unref();
}

function loadCallHistory() {
  if (!CALL_HISTORY_PATH) return;
  try {
    const raw = fs.readFileSync(CALL_HISTORY_PATH, "utf8");
    const parsed = JSON.parse(raw);
    hydrateCallHistory(parsed);
    if (callHistory.length) {
      console.log(`[call-history] loaded ${callHistory.length} entries`);
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error("[call-history] load failed", err);
    }
  }
}
loadCallHistory();

function hydrateCvStore(entries) {
  cvStore.length = 0;
  cvStoreById.clear();
  if (!Array.isArray(entries)) return;
  entries.slice(0, MAX_CV_STORE).forEach((entry) => {
    if (!entry || typeof entry !== "object") return;
    if (!entry.id) entry.id = randomToken();
    if (!entry.brandKey && entry.brand) entry.brandKey = brandKey(entry.brand);
    if (!entry.roleKey && entry.role) entry.roleKey = roleKey(entry.role);
    if (!entry.decision) entry.decision = "";
    cvStore.push(entry);
    cvStoreById.set(entry.id, entry);
  });
}

async function saveCvStore() {
  if (!CV_STORE_PATH || cvStoreSaving) return;
  cvStoreSaving = true;
  try {
    ensureDirForFile(CV_STORE_PATH);
    const payload = JSON.stringify(cvStore.slice(0, MAX_CV_STORE), null, 2);
    const tmpPath = `${CV_STORE_PATH}.tmp`;
    await fs.promises.writeFile(tmpPath, payload, "utf8");
    await fs.promises.rename(tmpPath, CV_STORE_PATH);
  } catch (err) {
    console.error("[cv-store] save failed", err);
  } finally {
    cvStoreSaving = false;
  }
}

function scheduleCvStoreSave() {
  if (!CV_STORE_PATH) return;
  if (cvStoreSaveTimer) return;
  cvStoreSaveTimer = setTimeout(() => {
    cvStoreSaveTimer = null;
    saveCvStore();
  }, CV_STORE_SAVE_DELAY_MS);
  if (cvStoreSaveTimer.unref) cvStoreSaveTimer.unref();
}

function loadCvStore() {
  if (!CV_STORE_PATH) return;
  try {
    const raw = fs.readFileSync(CV_STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    hydrateCvStore(parsed);
    if (cvStore.length) {
      console.log(`[cv-store] loaded ${cvStore.length} entries`);
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error("[cv-store] load failed", err);
    }
  }
}
loadCvStore();

function getRoleConfig(brand, role) {
  if (!roleConfig) return null;
  const bKey = brandKey(brand || "");
  const rKey = normalizeKey(role || "");
  const brandEntry = roleConfig[bKey];
  if (!brandEntry) return null;
  for (const key of Object.keys(brandEntry)) {
    if (key === "_meta") continue;
    const entry = brandEntry[key] || {};
    if (normalizeKey(key) === rKey) return entry;
    const aliases = Array.isArray(entry.aliases) ? entry.aliases.map((a) => normalizeKey(a)) : [];
    if (aliases.includes(rKey)) return entry;
  }
  return null;
}

const USER_ROLES = new Set(["admin", "interviewer", "viewer"]);

function normalizeUserRole(role) {
  const value = String(role || "").trim().toLowerCase();
  return USER_ROLES.has(value) ? value : "viewer";
}

function normalizeAllowedBrands(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  list.forEach((item) => {
    const key = brandKey(item || "");
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(key);
  });
  return out;
}

function isBrandAllowed(allowedBrands, brand) {
  if (!Array.isArray(allowedBrands) || !allowedBrands.length) return true;
  const key = brandKey(brand || "");
  return key ? allowedBrands.includes(key) : false;
}

function filterConfigByBrands(config, allowedBrands) {
  if (!config || !Array.isArray(allowedBrands) || !allowedBrands.length) return config;
  const filtered = {};
  if (config.meta) filtered.meta = { ...config.meta };
  for (const key of Object.keys(config)) {
    if (key === "meta") continue;
    const bKey = brandKey(key);
    if (allowedBrands.includes(bKey)) {
      filtered[key] = config[key];
    }
  }
  return filtered;
}

function extractBearerToken(authHeader) {
  if (!authHeader) return "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function isConfigAuth(authHeader) {
  if (!CONFIG_TOKEN) return false;
  return authHeader === `Bearer ${CONFIG_TOKEN}`;
}

function createUserSession({ email, role, allowedBrands }) {
  const token = randomToken();
  userSessions.set(token, {
    email,
    role: normalizeUserRole(role),
    allowedBrands: normalizeAllowedBrands(allowedBrands),
    expiresAt: Date.now() + USER_SESSION_TTL_MS
  });
  return token;
}

function getUserSession(authHeader) {
  const token = extractBearerToken(authHeader);
  if (!token) return null;
  const session = userSessions.get(token);
  if (!session) return null;
  if (session.expiresAt && session.expiresAt < Date.now()) {
    userSessions.delete(token);
    return null;
  }
  return session;
}

function resolveAuthContext(authHeader) {
  if (isConfigAuth(authHeader)) {
    return { role: "admin", allowedBrands: null, email: null };
  }
  const session = getUserSession(authHeader);
  if (!session) return null;
  const role = normalizeUserRole(session.role);
  const allowedBrands = role === "admin" ? null : normalizeAllowedBrands(session.allowedBrands);
  return { role, allowedBrands, email: session.email || "" };
}

function requireConfig(req, res, next) {
  if (!CONFIG_TOKEN) return res.status(403).json({ error: "config token not set" });
  const auth = req.headers.authorization || "";
  if (!isConfigAuth(auth)) return res.status(401).json({ error: "unauthorized" });
  next();
}

function requireConfigOrViewer(req, res, next) {
  const auth = req.headers.authorization || "";
  const ctx = resolveAuthContext(auth);
  if (ctx) {
    req.userRole = ctx.role;
    req.allowedBrands = ctx.allowedBrands;
    req.userEmail = ctx.email || "";
    return next();
  }
  if (!CONFIG_TOKEN && !VIEWER_EMAIL && !dbPool) {
    return res.status(403).json({ error: "auth not configured" });
  }
  return res.status(401).json({ error: "unauthorized" });
}

function requireWrite(req, res, next) {
  const auth = req.headers.authorization || "";
  const ctx = resolveAuthContext(auth);
  if (!ctx) {
    if (!CONFIG_TOKEN && !VIEWER_EMAIL && !dbPool) {
      return res.status(403).json({ error: "auth not configured" });
    }
    return res.status(401).json({ error: "unauthorized" });
  }
  if (ctx.role === "viewer") {
    return res.status(403).json({ error: "forbidden" });
  }
  req.userRole = ctx.role;
  req.allowedBrands = ctx.allowedBrands;
  req.userEmail = ctx.email || "";
  next();
}

function requireAdminUser(req, res, next) {
  const auth = req.headers.authorization || "";
  const ctx = resolveAuthContext(auth);
  if (!ctx) {
    if (!CONFIG_TOKEN && !VIEWER_EMAIL && !dbPool) {
      return res.status(403).json({ error: "auth not configured" });
    }
    return res.status(401).json({ error: "unauthorized" });
  }
  if (ctx.role !== "admin") {
    return res.status(403).json({ error: "forbidden" });
  }
  req.userRole = ctx.role;
  req.allowedBrands = null;
  req.userEmail = ctx.email || "";
  next();
}

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(403).json({ error: "admin token not set" });
  const auth = req.headers.authorization || "";
  const expected = `Bearer ${ADMIN_TOKEN}`;
  if (auth !== expected) return res.status(401).json({ error: "unauthorized" });
  next();
}

function base64Auth(user, pass) {
  return Buffer.from(`${user}:${pass}`).toString("base64");
}

function normalizeOcrImages(images = []) {
  return images
    .map((img) => (typeof img === "string" ? img.trim() : ""))
    .filter(Boolean)
    .slice(0, OCR_MAX_IMAGES);
}

function estimateDataUrlBytes(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string") return 0;
  const idx = dataUrl.indexOf("base64,");
  if (idx === -1) return 0;
  const base64 = dataUrl.slice(idx + 7);
  return Math.ceil((base64.length * 3) / 4);
}

async function dbQuery(sql, params = []) {
  if (!dbPool) return null;
  return dbPool.query(sql, params);
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function hashPassword(password) {
  const raw = String(password || "");
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(raw, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

function verifyPassword(password, stored) {
  const raw = String(password || "");
  const parts = String(stored || "").split(":");
  if (!raw || parts.length !== 2) return false;
  const [saltHex, hashHex] = parts;
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(raw, salt, expected.length);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

async function fetchUserByEmail(email) {
  if (!dbPool) return null;
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const result = await dbQuery(
    "SELECT id, email, password_hash, role, allowed_brands, active, profile_photo_url FROM users WHERE email = $1 LIMIT 1",
    [normalized]
  );
  return result?.rows?.[0] || null;
}

async function listUsersFromDb() {
  if (!dbPool) return [];
  const result = await dbQuery(
    "SELECT id, email, role, allowed_brands, active, created_at, updated_at FROM users ORDER BY created_at DESC"
  );
  return (result?.rows || []).map((row) => ({
    id: row.id,
    email: row.email,
    role: normalizeUserRole(row.role),
    allowed_brands: Array.isArray(row.allowed_brands) ? row.allowed_brands : [],
    active: row.active !== false,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : "",
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : ""
  }));
}

async function createUserInDb({ email, password, role, allowed_brands, active }) {
  if (!dbPool) return null;
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail || !password) return null;
  const id = randomToken();
  const normalizedRole = normalizeUserRole(role);
  const allowed = normalizeAllowedBrands(allowed_brands);
  const passwordHash = hashPassword(password);
  const result = await dbQuery(
    `INSERT INTO users (id, email, password_hash, role, allowed_brands, active)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, email, role, allowed_brands, active, created_at, updated_at`,
    [id, normalizedEmail, passwordHash, normalizedRole, allowed, active !== false]
  );
  return result?.rows?.[0] || null;
}

async function updateUserInDb(id, { email, password, role, allowed_brands, active }) {
  if (!dbPool || !id) return null;
  const fields = [];
  const values = [];
  if (email) {
    values.push(normalizeEmail(email));
    fields.push(`email = $${values.length}`);
  }
  if (password) {
    values.push(hashPassword(password));
    fields.push(`password_hash = $${values.length}`);
  }
  if (role) {
    values.push(normalizeUserRole(role));
    fields.push(`role = $${values.length}`);
  }
  if (allowed_brands) {
    values.push(normalizeAllowedBrands(allowed_brands));
    fields.push(`allowed_brands = $${values.length}`);
  }
  if (active !== undefined) {
    values.push(active !== false);
    fields.push(`active = $${values.length}`);
  }
  if (!fields.length) return null;
  values.push(id);
  const sql = `
    UPDATE users
    SET ${fields.join(", ")}, updated_at = NOW()
    WHERE id = $${values.length}
    RETURNING id, email, role, allowed_brands, active, created_at, updated_at
  `;
  const result = await dbQuery(sql, values);
  return result?.rows?.[0] || null;
}

async function updateUserProfileByEmail(email, payload = {}) {
  if (!dbPool || !email) return null;
  const fields = [];
  const values = [];
  if (payload.password) {
    values.push(hashPassword(payload.password));
    fields.push(`password_hash = $${values.length}`);
  }
  if (payload.profile_photo_url !== undefined) {
    values.push(payload.profile_photo_url || null);
    fields.push(`profile_photo_url = $${values.length}`);
  }
  if (!fields.length) return null;
  values.push(normalizeEmail(email));
  const sql = `
    UPDATE users
    SET ${fields.join(", ")}, updated_at = NOW()
    WHERE email = $${values.length}
    RETURNING id, email, role, allowed_brands, active, profile_photo_url, created_at, updated_at
  `;
  const result = await dbQuery(sql, values);
  return result?.rows?.[0] || null;
}

async function deleteUserFromDb(id) {
  if (!dbPool || !id) return 0;
  const result = await dbQuery("DELETE FROM users WHERE id = $1", [id]);
  return result?.rowCount || 0;
}

function normalizePushSubscription(data) {
  if (!data || typeof data !== "object") return null;
  const sub = data.subscription && typeof data.subscription === "object" ? data.subscription : data;
  const endpoint = typeof sub.endpoint === "string" ? sub.endpoint.trim() : "";
  if (!endpoint) return null;
  return { endpoint, subscription: sub };
}

async function upsertPushSubscription({ endpoint, subscription, userEmail, userRole, userAgent, allowedBrands }) {
  if (!endpoint || !subscription) return false;
  if (!dbPool) {
    pushSubscriptions.set(endpoint, { endpoint, subscription, userEmail, userRole, userAgent, allowedBrands });
    return true;
  }
  const sql = `
    INSERT INTO push_subscriptions (endpoint, subscription, user_email, user_role, allowed_brands, user_agent, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    ON CONFLICT (endpoint)
    DO UPDATE SET subscription = EXCLUDED.subscription,
      user_email = EXCLUDED.user_email,
      user_role = EXCLUDED.user_role,
      allowed_brands = EXCLUDED.allowed_brands,
      user_agent = EXCLUDED.user_agent,
      updated_at = NOW()
  `;
  await dbQuery(sql, [
    endpoint,
    subscription,
    userEmail || null,
    userRole || null,
    Array.isArray(allowedBrands) ? allowedBrands : null,
    userAgent || null
  ]);
  return true;
}

async function removePushSubscription(endpoint) {
  if (!endpoint) return false;
  if (!dbPool) return pushSubscriptions.delete(endpoint);
  await dbQuery("DELETE FROM push_subscriptions WHERE endpoint = $1", [endpoint]);
  return true;
}

async function listPushSubscriptions() {
  if (!dbPool) return Array.from(pushSubscriptions.values());
  const result = await dbQuery("SELECT endpoint, subscription, allowed_brands FROM push_subscriptions");
  return (result?.rows || []).map((row) => ({
    endpoint: row.endpoint,
    subscription: row.subscription,
    allowedBrands: Array.isArray(row.allowed_brands) ? row.allowed_brands : (row.allowed_brands || [])
  }));
}

async function sendPushToAll(payload, brand) {
  if (!pushEnabled) return 0;
  const subscriptions = await listPushSubscriptions();
  if (!subscriptions.length) return 0;
  const body = JSON.stringify(payload || {});
  let sent = 0;
  for (const sub of subscriptions) {
    const allowed = Array.isArray(sub.allowedBrands) ? sub.allowedBrands : [];
    if (brand && allowed.length && !isBrandAllowed(allowed, brand)) {
      continue;
    }
    try {
      await webpush.sendNotification(sub.subscription, body);
      sent += 1;
    } catch (err) {
      const status = err?.statusCode || err?.body?.statusCode;
      if (status === 404 || status === 410) {
        await removePushSubscription(sub.endpoint);
      } else {
        console.warn("[push] send failed", err?.message || err);
      }
    }
  }
  return sent;
}

async function notifyPortalApplication({ application, page }) {
  if (!pushEnabled || !application) return 0;
  const brand = application.brand || page?.brand || "";
  const role = application.role || page?.role || "";
  const name = application.name || "Nuevo candidato";
  const slug = application.slug || page?.slug || "";
  const bodyParts = [name];
  if (brand) bodyParts.push(brand);
  if (role) bodyParts.push(role);
  const payload = {
    title: "Nueva postulacion",
    body: bodyParts.join(" · "),
    url: slug ? `/admin/ui?view=portal&slug=${encodeURIComponent(slug)}` : "/admin/ui?view=portal",
    icon: "/admin/icon.svg"
  };
  return sendPushToAll(payload, brand);
}

async function notifyInterviewCompleted({ call, scoring }) {
  if (!pushEnabled || !call || !scoring) return 0;
  const brand = call.brandKey || call.brand || "";
  const name = call.applicant || "Candidato";
  const score = scoring?.score_0_100 ?? call.score ?? "";
  const rec = scoring?.recommendation || call.recommendation || "";
  const recText = rec === "advance" ? "Avanzar" : rec === "reject" ? "No avanzar" : (rec ? "Revisar" : "");
  const bodyParts = [name];
  if (brand) bodyParts.push(brand);
  if (score !== "" && score !== null && score !== undefined) bodyParts.push(`Score ${score}`);
  if (recText) bodyParts.push(recText);
  const payload = {
    title: "Entrevista completada",
    body: bodyParts.join(" · "),
    url: "/admin/ui?view=interviews",
    icon: "/admin/icon.svg"
  };
  return sendPushToAll(payload, brand);
}

async function initDb() {
  if (!dbPool) return;
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS app_config (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS cvs (
        id TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        brand TEXT,
        brand_key TEXT,
        role TEXT,
        role_key TEXT,
        applicant TEXT,
        phone TEXT,
        cv_text TEXT,
        cv_url TEXT,
        cv_photo_url TEXT,
        custom_question TEXT,
        decision TEXT,
        source TEXT
      );
    `);
    await dbPool.query(`ALTER TABLE cvs ADD COLUMN IF NOT EXISTS cv_photo_url TEXT;`);
    await dbPool.query(`ALTER TABLE cvs ADD COLUMN IF NOT EXISTS custom_question TEXT;`);
    await dbPool.query(`ALTER TABLE cvs ADD COLUMN IF NOT EXISTS decision TEXT;`);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_cvs_brand ON cvs (brand_key);`);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_cvs_role ON cvs (role_key);`);

    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS calls (
        call_sid TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        brand TEXT,
        brand_key TEXT,
        role TEXT,
        role_key TEXT,
        applicant TEXT,
        phone TEXT,
        score INTEGER,
        recommendation TEXT,
        summary TEXT,
        warmth INTEGER,
        fluency INTEGER,
        english TEXT,
        english_detail TEXT,
        experience TEXT,
        area TEXT,
        availability TEXT,
        salary TEXT,
        trial TEXT,
        stay_plan TEXT,
        stay_detail TEXT,
        mobility TEXT,
        outcome TEXT,
        outcome_detail TEXT,
        duration_sec INTEGER,
        audio_url TEXT,
        english_required BOOLEAN,
        cv_id TEXT,
        cv_text TEXT,
        cv_url TEXT
      );
    `);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_calls_brand ON calls (brand_key);`);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_calls_role ON calls (role_key);`);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_calls_rec ON calls (recommendation);`);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_calls_score ON calls (score);`);

    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS call_recordings (
        call_sid TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        content_type TEXT,
        byte_size INTEGER,
        audio_data BYTEA
      );
    `);

    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        allowed_brands TEXT[] NOT NULL DEFAULT '{}'::text[],
        active BOOLEAN NOT NULL DEFAULT TRUE,
        profile_photo_url TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await dbPool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS allowed_brands TEXT[] NOT NULL DEFAULT '{}'::text[];`);
    await dbPool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;`);
    await dbPool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_photo_url TEXT;`);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);`);

    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS portal_pages (
        id TEXT PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        brand TEXT,
        role TEXT,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        locale_default TEXT NOT NULL DEFAULT 'es',
        content JSONB,
        theme JSONB,
        fields JSONB,
        resume JSONB,
        photo JSONB,
        questions JSONB,
        assets JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_portal_pages_slug ON portal_pages (slug);`);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_portal_pages_updated ON portal_pages (updated_at DESC);`);

    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS portal_applications (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        brand TEXT,
        role TEXT,
        name TEXT,
        email TEXT,
        phone TEXT,
        consent BOOLEAN NOT NULL DEFAULT FALSE,
        answers JSONB,
        resume_url TEXT,
        photo_url TEXT,
        locations JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await dbPool.query(`ALTER TABLE portal_applications ADD COLUMN IF NOT EXISTS consent BOOLEAN NOT NULL DEFAULT FALSE;`);
    await dbPool.query(`ALTER TABLE portal_applications ADD COLUMN IF NOT EXISTS locations JSONB;`);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_portal_apps_slug ON portal_applications (slug);`);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_portal_apps_created ON portal_applications (created_at DESC);`);

    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint TEXT PRIMARY KEY,
        subscription JSONB NOT NULL,
        user_email TEXT,
        user_role TEXT,
        allowed_brands JSONB,
        user_agent TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await dbPool.query(`ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS allowed_brands JSONB;`);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_push_subscriptions_email ON push_subscriptions (user_email);`);

    const loaded = await loadRoleConfigFromDb();
    if (!loaded && roleConfig) {
      const seeded = await saveRoleConfigToDb(roleConfig);
      if (seeded) console.log("[config] roles seeded to db");
    }

    console.log("[db] ready");
  } catch (err) {
    console.error("[db] init failed", err);
  }
}
initDb();

function getSpacesPublicBaseUrl() {
  if (SPACES_PUBLIC_URL) return SPACES_PUBLIC_URL;
  if (SPACES_PUBLIC && SPACES_BUCKET && SPACES_REGION) {
    return `https://${SPACES_BUCKET}.${SPACES_REGION}.digitaloceanspaces.com`;
  }
  return "";
}

function normalizeSpacesKey(value = "") {
  if (!value) return "";
  if (value.startsWith("s3://")) {
    const rest = value.slice("s3://".length);
    if (rest.startsWith(`${SPACES_BUCKET}/`)) return rest.slice(SPACES_BUCKET.length + 1);
    return rest;
  }
  return value;
}

function extractSpacesKeyFromUrl(value = "") {
  if (!value || !SPACES_BUCKET) return "";
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return "";
  }
  const host = (parsed.hostname || "").toLowerCase();
  const bucket = SPACES_BUCKET.toLowerCase();
  const endpointHost = SPACES_ENDPOINT ? (() => {
    try {
      return new URL(SPACES_ENDPOINT).hostname.toLowerCase();
    } catch {
      return "";
    }
  })() : "";
  const path = (parsed.pathname || "").replace(/^\/+/, "");
  if (host.startsWith(`${bucket}.`)) {
    return path;
  }
  if (endpointHost && host === endpointHost) {
    if (path.toLowerCase().startsWith(`${bucket}/`)) {
      return path.slice(bucket.length + 1);
    }
  }
  if (host.endsWith("digitaloceanspaces.com") && path.toLowerCase().startsWith(`${bucket}/`)) {
    return path.slice(bucket.length + 1);
  }
  return "";
}

async function resolveStoredUrl(value, ttlSeconds = 3600) {
  if (!value) return "";
  if (typeof value === "string" && value.startsWith("db:")) {
    const callSid = value.slice(3);
    if (!callSid || !dbPool) return "";
    const token = randomToken();
    tokens.set(token, { callSid, expiresAt: Date.now() + TOKEN_TTL_MS });
    return PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/r/${token}` : `/r/${token}`;
  }
  const isUrl = /^https?:\/\//i.test(value);
  if (isUrl) {
    if (SPACES_PUBLIC || SPACES_PUBLIC_URL) return value;
    if (!s3Client || !SPACES_BUCKET) return value;
    const keyFromUrl = extractSpacesKeyFromUrl(value);
    if (!keyFromUrl) return value;
    const cmd = new GetObjectCommand({ Bucket: SPACES_BUCKET, Key: keyFromUrl });
    return getSignedUrl(s3Client, cmd, { expiresIn: ttlSeconds });
  }
  if (!s3Client || !SPACES_BUCKET) return value;
  const key = normalizeSpacesKey(value);
  const publicBase = getSpacesPublicBaseUrl();
  if (publicBase) {
    return `${publicBase}/${key}`;
  }
  const cmd = new GetObjectCommand({ Bucket: SPACES_BUCKET, Key: key });
  return getSignedUrl(s3Client, cmd, { expiresIn: ttlSeconds });
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const PROFILE_MIME_EXT = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif"
};

function extForMime(mime, fallbackName) {
  const known = PROFILE_MIME_EXT[mime];
  if (known) return known;
  const fallback = path.extname(fallbackName || "");
  if (fallback) return fallback.toLowerCase();
  return ".bin";
}

function ensureDir(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }
}

async function saveProfilePhoto({ dataUrl, fileName, userKey, uploadsDir, uploadToSpacesFn, publicUploadsBaseUrl }) {
  if (!dataUrl) return "";
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) throw new Error("invalid_data_url");
  if (!parsed.mime || !parsed.mime.startsWith("image/")) {
    throw new Error("unsupported_file_type");
  }
  if (parsed.buffer.length > PROFILE_PHOTO_MAX_BYTES) {
    throw new Error("file_too_large");
  }
  const ext = extForMime(parsed.mime, fileName);
  const safeName = sanitizeFilename(path.basename(fileName || "avatar"));
  const finalName = safeName.endsWith(ext) ? safeName : safeName + ext;
  const relDir = path.posix.join("profile-photos", userKey || "user");
  const relPath = path.posix.join(relDir, finalName);
  if (uploadToSpacesFn) {
    await uploadToSpacesFn({ key: relPath, body: parsed.buffer, contentType: parsed.mime });
  } else {
    const fullDir = path.join(uploadsDir, relDir);
    ensureDir(fullDir);
    const fullPath = path.join(fullDir, finalName);
    await fs.promises.writeFile(fullPath, parsed.buffer);
  }
  const baseUrl = publicUploadsBaseUrl || "/uploads";
  return `${baseUrl}/${relPath}`;
}

async function uploadToSpaces({ key, body, contentType }) {
  if (!s3Client || !SPACES_BUCKET) return "";
  const params = {
    Bucket: SPACES_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType || "application/octet-stream"
  };
  if (SPACES_PUBLIC || SPACES_PUBLIC_URL) {
    params.ACL = "public-read";
  }
  await s3Client.send(new PutObjectCommand(params));
  return key;
}

const app = express();
app.use(express.json({ limit: "12mb" }));
app.use(express.urlencoded({ extended: false }));

const portalSpacesBaseUrl = getSpacesPublicBaseUrl();
const portalUseSpaces = !!(portalSpacesBaseUrl && s3Client);
const portalPublicUploadsBaseUrl = portalUseSpaces ? portalSpacesBaseUrl : "/uploads";
const portalUploadToSpaces = portalUseSpaces ? uploadToSpaces : null;
const adminUploadsDir = path.join(__dirname, "data", "uploads");

const portalRouter = createPortalRouter({
  dataDir: path.join(__dirname, "data"),
  uploadsDir: path.join(__dirname, "data", "uploads"),
  uploadsBaseUrl: "/uploads",
  publicUploadsBaseUrl: portalPublicUploadsBaseUrl,
  uploadToSpaces: portalUploadToSpaces,
  dbPool,
  resumeMaxBytes: CV_UPLOAD_MAX_BYTES,
  photoMaxBytes: Math.max(CV_PHOTO_MAX_BYTES, 5 * 1024 * 1024),
  contactPhone: TWILIO_VOICE_FROM || TWILIO_SMS_FROM,
  contactName: "HRBOT",
  requireAdmin: requireAdminUser,
  requireWrite,
  saveCvEntry: (entry) => recordCvEntry(buildCvEntry(entry)),
  notifyOnApplication: (payload) => notifyPortalApplication(payload)
});
app.use("/", portalRouter);

app.post("/admin/login", async (req, res) => {
  const email = normalizeEmail(req.body?.email || "");
  const password = req.body?.password || "";
  if (!email || !password) {
    return res.status(400).json({ error: "missing_credentials" });
  }
  try {
    if (dbPool) {
      const user = await fetchUserByEmail(email);
      if (user) {
        if (user.active === false) {
          return res.status(403).json({ error: "inactive_user" });
        }
        if (verifyPassword(password, user.password_hash)) {
          const role = normalizeUserRole(user.role);
          const allowed = Array.isArray(user.allowed_brands) ? user.allowed_brands : [];
          const token = createUserSession({ email: user.email, role, allowedBrands: allowed });
          return res.json({ ok: true, token, role, allowed_brands: allowed });
        }
      }
    }
  } catch (err) {
    console.error("[admin/login] failed", err);
  }
  if (!VIEWER_EMAIL || !VIEWER_PASSWORD) {
    return res.status(403).json({ error: "viewer login disabled" });
  }
  if (email !== VIEWER_EMAIL.toLowerCase() || password !== VIEWER_PASSWORD) {
    return res.status(401).json({ error: "invalid_credentials" });
  }
  const token = createUserSession({ email, role: "viewer", allowedBrands: [] });
  return res.json({ ok: true, token, role: "viewer", allowed_brands: [] });
});

app.get("/admin/push/public-key", requireConfigOrViewer, (req, res) => {
  return res.json({
    ok: true,
    enabled: pushEnabled,
    publicKey: pushEnabled ? VAPID_PUBLIC_KEY : ""
  });
});

app.post("/admin/push/subscribe", requireConfigOrViewer, async (req, res) => {
  if (!pushEnabled) return res.status(503).json({ error: "push_disabled" });
  const normalized = normalizePushSubscription(req.body || {});
  if (!normalized) return res.status(400).json({ error: "invalid_subscription" });
  try {
    await upsertPushSubscription({
      endpoint: normalized.endpoint,
      subscription: normalized.subscription,
      userEmail: req.userEmail || "",
      userRole: req.userRole || "",
      userAgent: req.headers["user-agent"] || "",
      allowedBrands: normalizeAllowedBrands(req.allowedBrands || [])
    });
    return res.json({ ok: true });
  } catch (err) {
    console.error("[push] subscribe failed", err);
    return res.status(500).json({ error: "subscribe_failed" });
  }
});

app.post("/admin/push/unsubscribe", requireConfigOrViewer, async (req, res) => {
  const normalized = normalizePushSubscription(req.body || {});
  const endpoint = normalized?.endpoint || String(req.body?.endpoint || "").trim();
  if (!endpoint) return res.status(400).json({ error: "missing_endpoint" });
  try {
    await removePushSubscription(endpoint);
    return res.json({ ok: true });
  } catch (err) {
    console.error("[push] unsubscribe failed", err);
    return res.status(500).json({ error: "unsubscribe_failed" });
  }
});

app.get("/admin/me", requireConfigOrViewer, async (req, res) => {
  if (!dbPool || !req.userEmail) {
    return res.json({
      ok: true,
      can_update: false,
      user: {
        email: req.userEmail || "",
        role: req.userRole || "viewer",
        allowed_brands: req.allowedBrands || [],
        profile_photo_url: ""
      }
    });
  }
  try {
    const user = await fetchUserByEmail(req.userEmail);
    if (!user) return res.status(404).json({ error: "user_not_found" });
    return res.json({
      ok: true,
      can_update: true,
      user: {
        email: user.email,
        role: normalizeUserRole(user.role),
        allowed_brands: Array.isArray(user.allowed_brands) ? user.allowed_brands : [],
        profile_photo_url: user.profile_photo_url || ""
      }
    });
  } catch (err) {
    console.error("[admin/me] failed", err);
    return res.status(500).json({ error: "me_failed" });
  }
});

app.put("/admin/me", requireConfigOrViewer, async (req, res) => {
  if (!dbPool || !req.userEmail) {
    return res.status(503).json({ error: "db_unavailable" });
  }
  try {
    const password = String(req.body?.password || "").trim();
    const photoDataUrl = req.body?.profile_photo_data_url || "";
    const photoFileName = req.body?.profile_photo_file_name || "avatar";
    const clearPhoto = req.body?.profile_photo_clear === true || req.body?.profile_photo_clear === "true";
    const payload = {};
    if (password) payload.password = password;
    if (clearPhoto) payload.profile_photo_url = "";
    if (photoDataUrl) {
      const userKey = sanitizeFilename(req.userEmail || "user").toLowerCase();
      const url = await saveProfilePhoto({
        dataUrl: photoDataUrl,
        fileName: photoFileName,
        userKey,
        uploadsDir: adminUploadsDir,
        uploadToSpacesFn: portalUploadToSpaces,
        publicUploadsBaseUrl: portalPublicUploadsBaseUrl
      });
      payload.profile_photo_url = url;
    }
    const updated = await updateUserProfileByEmail(req.userEmail, payload);
    if (!updated) return res.status(400).json({ error: "profile_update_failed" });
    return res.json({
      ok: true,
      user: {
        email: updated.email,
        role: normalizeUserRole(updated.role),
        allowed_brands: Array.isArray(updated.allowed_brands) ? updated.allowed_brands : [],
        profile_photo_url: updated.profile_photo_url || ""
      }
    });
  } catch (err) {
    console.error("[admin/me] update failed", err);
    return res.status(400).json({ error: err.message || "profile_update_failed" });
  }
});

app.get("/admin/manifest.json", (req, res) => {
  res.json({
    name: "HRBOT Console",
    short_name: "HRBOT",
    start_url: "/admin/ui",
    scope: "/admin/",
    display: "standalone",
    background_color: "#f4efe6",
    theme_color: "#1b7a8c",
    icons: [
      {
        src: "/admin/icon.svg",
        sizes: "any",
        type: "image/svg+xml"
      }
    ]
  });
});

app.get("/admin/icon.svg", (req, res) => {
  res.type("image/svg+xml").send(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1b7a8c"/>
      <stop offset="100%" stop-color="#0f5563"/>
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="28" fill="url(#g)"/>
  <circle cx="64" cy="64" r="40" fill="#f4efe6"/>
  <text x="64" y="74" text-anchor="middle" font-family="Arial, sans-serif" font-size="40" fill="#1b7a8c" font-weight="700">H</text>
</svg>
  `.trim());
});

app.get("/admin/sw.js", (req, res) => {
  res.type("application/javascript").send(`
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    try {
      data = JSON.parse(event.data.text());
    } catch (e) {
      data = {};
    }
  }
  const title = data.title || 'HRBOT';
  const options = {
    body: data.body || '',
    icon: data.icon || '/admin/icon.svg',
    badge: data.badge || '/admin/icon.svg',
    data: { url: data.url || '/admin/ui' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener('notificationclick', (event) => {
  const url = event.notification?.data?.url || '/admin/ui';
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsArr) => {
      for (const client of clientsArr) {
        if (client.url && client.focus) {
          if (client.url.includes(url)) return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
  `.trim());
});

app.get("/admin/users", requireAdminUser, async (req, res) => {
  if (!dbPool) return res.status(503).json({ error: "db_unavailable" });
  try {
    const users = await listUsersFromDb();
    return res.json({ ok: true, users });
  } catch (err) {
    console.error("[admin/users] list failed", err);
    return res.status(500).json({ error: "users_list_failed" });
  }
});

app.post("/admin/users", requireAdminUser, async (req, res) => {
  if (!dbPool) return res.status(503).json({ error: "db_unavailable" });
  const email = normalizeEmail(req.body?.email || "");
  const password = req.body?.password || "";
  const role = normalizeUserRole(req.body?.role || "");
  const allowed_brands = Array.isArray(req.body?.allowed_brands) ? req.body.allowed_brands : [];
  const active = req.body?.active !== false;
  if (!email || !password) {
    return res.status(400).json({ error: "missing_fields" });
  }
  try {
    const user = await createUserInDb({ email, password, role, allowed_brands, active });
    if (!user) return res.status(400).json({ error: "user_create_failed" });
    return res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        role: normalizeUserRole(user.role),
        allowed_brands: Array.isArray(user.allowed_brands) ? user.allowed_brands : [],
        active: user.active !== false,
        created_at: user.created_at ? new Date(user.created_at).toISOString() : "",
        updated_at: user.updated_at ? new Date(user.updated_at).toISOString() : ""
      }
    });
  } catch (err) {
    console.error("[admin/users] create failed", err);
    return res.status(400).json({ error: "user_create_failed", detail: err.message });
  }
});

app.put("/admin/users/:id", requireAdminUser, async (req, res) => {
  if (!dbPool) return res.status(503).json({ error: "db_unavailable" });
  const id = (req.params?.id || "").trim();
  if (!id) return res.status(400).json({ error: "missing_user_id" });
  const payload = {
    email: req.body?.email ? normalizeEmail(req.body.email) : "",
    password: req.body?.password || "",
    role: req.body?.role || "",
    allowed_brands: Array.isArray(req.body?.allowed_brands) ? req.body.allowed_brands : [],
    active: req.body?.active
  };
  try {
    const user = await updateUserInDb(id, payload);
    if (!user) return res.status(404).json({ error: "user_not_found" });
    return res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        role: normalizeUserRole(user.role),
        allowed_brands: Array.isArray(user.allowed_brands) ? user.allowed_brands : [],
        active: user.active !== false,
        created_at: user.created_at ? new Date(user.created_at).toISOString() : "",
        updated_at: user.updated_at ? new Date(user.updated_at).toISOString() : ""
      }
    });
  } catch (err) {
    console.error("[admin/users] update failed", err);
    return res.status(400).json({ error: "user_update_failed", detail: err.message });
  }
});

app.delete("/admin/users/:id", requireAdminUser, async (req, res) => {
  if (!dbPool) return res.status(503).json({ error: "db_unavailable" });
  const id = (req.params?.id || "").trim();
  if (!id) return res.status(400).json({ error: "missing_user_id" });
  try {
    const removed = await deleteUserFromDb(id);
    if (!removed) return res.status(404).json({ error: "user_not_found" });
    return res.json({ ok: true, removed });
  } catch (err) {
    console.error("[admin/users] delete failed", err);
    return res.status(400).json({ error: "user_delete_failed", detail: err.message });
  }
});

// Config endpoints (protect with CALL_BEARER_TOKEN)
app.get("/admin/config", requireConfigOrViewer, async (req, res) => {
  if (dbPool) {
    await loadRoleConfigFromDb();
  }
  if (!roleConfig) return res.json({ config: null, source: "defaults" });
  const isAdmin = req.userRole === "admin";
  const filtered = isAdmin ? roleConfig : filterConfigByBrands(roleConfig, req.allowedBrands);
  return res.json({ config: filtered, source: roleConfigSource || "file", allowed_brands: req.allowedBrands || [] });
});

app.post("/admin/config", requireAdminUser, async (req, res) => {
  try {
    const body = req.body;
    const config = body?.config ?? body;
    const serialized = typeof config === "string" ? config : JSON.stringify(config, null, 2);
    const parsed = JSON.parse(serialized);
    const existingPrompt = roleConfig?.meta?.system_prompt;
    if (!parsed.meta) parsed.meta = {};
    if (typeof existingPrompt === "string") {
      parsed.meta.system_prompt = existingPrompt;
    } else {
      delete parsed.meta.system_prompt;
    }
    roleConfig = parsed;
    const saved = await persistRoleConfig(roleConfig);
    if (!saved) {
      return res.status(500).json({ error: "config_persist_failed" });
    }
    return res.json({ ok: true, source: roleConfigSource || "db" });
  } catch (err) {
    console.error("[admin/config] failed", err);
    return res.status(400).json({ error: "invalid_config", detail: err.message });
  }
});

app.post("/admin/preview", requireAdminUser, (req, res) => {
  try {
    const body = req.body || {};
    const brand = body.brand || DEFAULT_BRAND;
    const role = body.role || DEFAULT_ROLE;
    const englishRequired = resolveEnglishRequired(brand, role, body);
    const address = body.address || resolveAddress(brand, null);
    const ctx = {
      brand,
      role,
      spokenRole: body.spokenRole || displayRole(role, brand),
      englishRequired,
      address,
      applicant: body.applicant || "",
      cvSummary: body.cv_summary || body.cvSummary || "",
      resumeUrl: body.resume_url || body.resumeUrl || "",
      lang: body.lang === "en" ? "en" : "es"
    };
    return res.json({ ok: true, prompt: buildInstructions(ctx) });
  } catch (err) {
    console.error("[admin/preview] failed", err);
    return res.status(400).json({ error: "preview_failed", detail: err.message });
  }
});

// System prompt endpoints (protect with ADMIN_TOKEN)
app.get("/admin/system-prompt", requireAdmin, (req, res) => {
  const prompt = roleConfig?.meta?.system_prompt || "";
  return res.json({ ok: true, system_prompt: prompt });
});

app.post("/admin/system-prompt", requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const prompt = typeof body.system_prompt === "string" ? body.system_prompt : "";
    if (!roleConfig) roleConfig = { meta: {} };
    if (!roleConfig.meta) roleConfig.meta = {};
    roleConfig.meta.system_prompt = prompt;
    await persistRoleConfig(roleConfig);
    await appendPromptHistory(prompt);
    return res.json({ ok: true });
  } catch (err) {
    console.error("[admin/system-prompt] failed", err);
    return res.status(400).json({ error: "system_prompt_failed", detail: err.message });
  }
});

app.get("/admin/system-prompt/store", requireAdmin, async (req, res) => {
  try {
    const { store, source } = await loadPromptStoreWithSource();
    return res.json({ ok: true, store, source });
  } catch (err) {
    return res.status(400).json({ error: "prompt_store_failed", detail: err.message });
  }
});

app.post("/admin/system-prompt/templates", requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const name = (body.name || "").toString().trim();
    const prompt = (body.prompt || "").toString().trim();
    if (!name || !prompt) return res.status(400).json({ error: "missing_name_or_prompt" });
    const store = await loadPromptStore();
    const template = { id: randomToken(), name, prompt, created_at: new Date().toISOString() };
    store.templates = Array.isArray(store.templates) ? store.templates : [];
    store.templates.unshift(template);
    const saved = await savePromptStore(store);
    if (!saved) return res.status(500).json({ error: "template_save_failed" });
    return res.json({ ok: true, template });
  } catch (err) {
    return res.status(400).json({ error: "template_save_failed", detail: err.message });
  }
});

app.delete("/admin/system-prompt/templates/:id", requireAdmin, async (req, res) => {
  try {
    const id = (req.params.id || "").toString().trim();
    if (!id) return res.status(400).json({ error: "missing_id" });
    const store = await loadPromptStore();
    store.templates = (store.templates || []).filter((t) => t.id !== id);
    await savePromptStore(store);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(400).json({ error: "template_delete_failed", detail: err.message });
  }
});

app.post("/admin/system-prompt/assist", requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const instruction = (body.instruction || "").toString().trim();
    const currentPrompt = (body.current_prompt || "").toString();
    if (!instruction) return res.status(400).json({ error: "missing_instruction" });
    const payload = {
      model: OPENAI_MODEL_SCORING,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: "You edit recruiter system prompts. Return ONLY strict JSON with keys: updated_prompt (string), added_lines (array of strings), summary (string). Preserve existing content unless instruction asks otherwise. Integrate changes naturally."
        },
        {
          role: "user",
          content: `Current prompt:\n\"\"\"\n${currentPrompt}\n\"\"\"\n\nInstruction:\n${instruction}\n\nReturn JSON only.`
        }
      ]
    };
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify(payload)
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error?.message || "assist_failed");
    const text = data?.choices?.[0]?.message?.content || "";
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start >= 0 && end > start) {
        parsed = JSON.parse(text.slice(start, end + 1));
      }
    }
    if (!parsed || typeof parsed.updated_prompt !== "string") {
      throw new Error("invalid_assist_response");
    }
    return res.json({
      ok: true,
      updated_prompt: parsed.updated_prompt,
      added_lines: Array.isArray(parsed.added_lines) ? parsed.added_lines : [],
      summary: parsed.summary || ""
    });
  } catch (err) {
    console.error("[admin/system-prompt] assist failed", err);
    return res.status(400).json({ error: "assist_failed", detail: err.message });
  }
});

app.get("/admin/calls", requireConfigOrViewer, async (req, res) => {
  const brandParam = (req.query?.brand || "").toString();
  const roleParam = (req.query?.role || "").toString();
  const recParam = (req.query?.recommendation || "").toString().toLowerCase();
  const qParam = (req.query?.q || "").toString().toLowerCase();
  const minScore = Number(req.query?.minScore);
  const maxScore = Number(req.query?.maxScore);
  const limit = Math.min(Number(req.query?.limit) || 200, 500);
  const allowedBrands = Array.isArray(req.allowedBrands) ? req.allowedBrands : [];

  if (brandParam && allowedBrands.length && !isBrandAllowed(allowedBrands, brandParam)) {
    return res.json({ ok: true, calls: [] });
  }

  if (dbPool) {
    try {
      const calls = await fetchCallsFromDb({
        brandParam,
        roleParam,
        recParam,
        qParam,
        minScore,
        maxScore,
        limit,
        allowedBrands
      });
      return res.json({ ok: true, calls });
    } catch (err) {
      console.error("[admin/calls] db failed", err);
    }
  }

  let list = callHistory.slice();
  if (allowedBrands.length) {
    list = list.filter((c) => allowedBrands.includes(c.brandKey || brandKey(c.brand || "")));
  }
  if (brandParam) {
    const bKey = brandKey(brandParam);
    list = list.filter((c) => c.brandKey === bKey);
  }
  if (roleParam) {
    const rKey = normalizeKey(roleParam);
    list = list.filter((c) => normalizeKey(c.roleKey || c.role) === rKey);
  }
  if (recParam) {
    list = list.filter((c) => (c.recommendation || "").toLowerCase() === recParam);
  }
  if (!Number.isNaN(minScore)) {
    list = list.filter((c) => typeof c.score === "number" && c.score >= minScore);
  }
  if (!Number.isNaN(maxScore)) {
    list = list.filter((c) => typeof c.score === "number" && c.score <= maxScore);
  }
  if (qParam) {
    list = list.filter((c) => (c.applicant || "").toLowerCase().includes(qParam) || (c.phone || "").includes(qParam));
  }

  const results = [];
  for (const entry of list.slice(0, limit)) {
    if (!entry) continue;
    if ((!entry.cv_text || !entry.cv_text.trim()) && entry.cv_id) {
      const cvEntry = cvStoreById.get(entry.cv_id);
      if (cvEntry) {
        const audioUrl = await resolveStoredUrl(entry.audio_url || "");
        const cvUrl = await resolveStoredUrl(entry.cv_url || "");
        results.push({
          ...entry,
          cv_text: cvEntry.cv_text || "",
          applicant: entry.applicant || cvEntry.applicant || "",
          phone: entry.phone || cvEntry.phone || "",
          decision: cvEntry.decision || entry.decision || "",
          audio_url: audioUrl || entry.audio_url || "",
          cv_url: cvUrl || entry.cv_url || cvEntry.cv_url || ""
        });
        continue;
      }
    }
    let decision = entry.decision || "";
    if (!decision && entry.cv_id) {
      const cvEntry = cvStoreById.get(entry.cv_id);
      if (cvEntry && cvEntry.decision) decision = cvEntry.decision;
    }
    const audioUrl = await resolveStoredUrl(entry.audio_url || "");
    const cvUrl = await resolveStoredUrl(entry.cv_url || "");
    results.push({
      ...entry,
      decision,
      audio_url: audioUrl || entry.audio_url || "",
      cv_url: cvUrl || entry.cv_url || ""
    });
  }
  return res.json({ ok: true, calls: results });
});

app.delete("/admin/calls/:callId", requireAdminUser, async (req, res) => {
  const callId = (req.params?.callId || "").trim();
  if (!callId) return res.status(400).json({ error: "missing_call_id" });
  let removed = 0;
  for (let i = callHistory.length - 1; i >= 0; i -= 1) {
    const entry = callHistory[i];
    if (entry && entry.callId === callId) {
      callHistory.splice(i, 1);
      removed += 1;
      if (entry._key) callHistoryByKey.delete(entry._key);
    }
  }
  if (callHistoryByKey.has(callId)) callHistoryByKey.delete(callId);
  if (callsByCallSid.has(callId)) callsByCallSid.delete(callId);
  scheduleCallHistorySave();
  if (dbPool) {
    try {
      await dbQuery("DELETE FROM calls WHERE call_sid = $1", [callId]);
    } catch (err) {
      console.error("[admin/calls] delete failed", err);
    }
  }
  return res.json({ ok: true, removed });
});

app.post("/admin/calls/:callId/whatsapp", requireAdminUser, async (req, res) => {
  const callId = (req.params?.callId || "").trim();
  if (!callId) return res.status(400).json({ error: "missing_call_id" });
  try {
    let call = callsByCallSid.get(callId);
    if (!call) {
      call = callHistory.find((c) => c && (c.callId === callId || c.callSid === callId));
    }
    if (dbPool) {
      const dbCall = await fetchCallById(callId);
      if (dbCall) {
        call = call ? { ...call, ...dbCall } : dbCall;
      }
    }
    if (!call) return res.status(404).json({ error: "call_not_found" });
    const hydrated = hydrateCallForWhatsapp(call);
    if (!hydrated.scoring) hydrated.scoring = buildScoringFromCall(hydrated);
    await sendWhatsappReport(hydrated, { force: true });
    const mediaUrl = await getCallAudioMediaUrl(hydrated);
    const cvUrl = await getCallCvMediaUrl(hydrated);
    return res.json({ ok: true, audio: !!mediaUrl, cv: !!cvUrl });
  } catch (err) {
    console.error("[admin/whatsapp] failed", err);
    return res.status(400).json({ error: "whatsapp_failed", detail: err.message });
  }
});

app.get("/admin/calls/:callId/audio", requireConfigOrViewer, async (req, res) => {
  const callId = (req.params?.callId || "").trim();
  if (!callId) return res.status(400).json({ error: "missing_call_id" });
  try {
    let call = callsByCallSid.get(callId);
    if (!call) {
      call = callHistory.find((c) => c && (c.callId === callId || c.callSid === callId));
    }
    if (!call && dbPool) {
      call = await fetchCallById(callId);
    }
    if (!call) return res.status(404).json({ error: "call_not_found" });
    const allowedBrands = Array.isArray(req.allowedBrands) ? req.allowedBrands : [];
    if (allowedBrands.length && !isBrandAllowed(allowedBrands, call.brand || call.brandKey || "")) {
      return res.status(403).json({ error: "brand_not_allowed" });
    }
    if (dbPool) {
      const recording = await fetchCallRecording(callId);
      if (recording && recording.audio_data) {
        const contentType = recording.content_type || "audio/mpeg";
        const ext = contentType.includes("wav") ? "wav" : "mp3";
        const safeName = sanitizeFilename(call.applicant || callId || "interview");
        res.setHeader("Content-Type", contentType);
        res.setHeader("Content-Disposition", `attachment; filename="${safeName}.${ext}"`);
        return res.send(recording.audio_data);
      }
    }
    const mediaUrl = await getCallAudioMediaUrl(call);
    if (!mediaUrl) return res.status(404).json({ error: "no_audio" });
    const resp = await fetch(mediaUrl);
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      return res.status(502).send(`audio_fetch_failed ${resp.status} ${detail}`);
    }
    const contentType = resp.headers.get("content-type") || "audio/mpeg";
    const ext = contentType.includes("wav") ? "wav" : "mp3";
    const safeName = sanitizeFilename(call.applicant || callId || "interview");
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}.${ext}"`);
    const buf = Buffer.from(await resp.arrayBuffer());
    return res.send(buf);
  } catch (err) {
    console.error("[admin/calls] audio download failed", err);
    return res.status(500).json({ error: "download_failed" });
  }
});

app.get("/admin/cv", requireConfigOrViewer, async (req, res) => {
  const brandParam = (req.query?.brand || "").toString();
  const roleParam = (req.query?.role || "").toString();
  const qParam = (req.query?.q || "").toString().toLowerCase();
  const limit = Math.min(Number(req.query?.limit) || 200, 500);
  const allowedBrands = Array.isArray(req.allowedBrands) ? req.allowedBrands : [];

  if (brandParam && allowedBrands.length && !isBrandAllowed(allowedBrands, brandParam)) {
    return res.json({ ok: true, cvs: [] });
  }

  if (dbPool) {
    try {
      const cvs = await fetchCvFromDb({ brandParam, roleParam, qParam, limit, allowedBrands });
      const activeIndex = collectActiveCalls(allowedBrands);
      const withActive = cvs.map((entry) => attachActiveCall(entry, activeIndex));
      return res.json({ ok: true, cvs: withActive });
    } catch (err) {
      console.error("[admin/cv] db failed", err);
    }
  }

  let list = cvStore.slice();
  if (allowedBrands.length) {
    list = list.filter((c) => allowedBrands.includes(c.brandKey || brandKey(c.brand || "")));
  }
  if (brandParam) {
    const bKey = brandKey(brandParam);
    list = list.filter((c) => c.brandKey === bKey);
  }
  if (roleParam) {
    const rKey = normalizeKey(roleParam);
    list = list.filter((c) => normalizeKey(c.roleKey || c.role) === rKey);
  }
  if (qParam) {
    list = list.filter((c) => {
      return (c.applicant || "").toLowerCase().includes(qParam) || (c.phone || "").includes(qParam);
    });
  }

  const callStatsByCv = new Map();
  const callStatsByPhone = new Map();
  const scopedCalls = allowedBrands.length
    ? callHistory.filter((call) => allowedBrands.includes(call.brandKey || brandKey(call.brand || "")))
    : callHistory;
  for (const call of scopedCalls) {
    if (!call) continue;
    const callTime = call.created_at ? new Date(call.created_at).getTime() : 0;
    if (call.cv_id) {
      const key = call.cv_id;
      const existing = callStatsByCv.get(key) || {
        call_count: 0,
        last_call_at: "",
        last_outcome: "",
        last_outcome_detail: "",
        last_audio_url: "",
        last_call_sid: ""
      };
      existing.call_count += 1;
      const lastTime = existing.last_call_at ? new Date(existing.last_call_at).getTime() : 0;
      if (!lastTime || callTime >= lastTime) {
        existing.last_call_at = call.created_at || existing.last_call_at;
        existing.last_outcome = call.outcome || "";
        existing.last_outcome_detail = call.outcome_detail || "";
        existing.last_audio_url = call.audio_url || "";
        existing.last_call_sid = call.callId || "";
      }
      callStatsByCv.set(key, existing);
    }
    const phone = call.phone || "";
    const bKey = call.brandKey || brandKey(call.brand || "");
    if (phone && bKey) {
      const key = `${bKey}:${phone}`;
      const existing = callStatsByPhone.get(key) || {
        call_count: 0,
        last_call_at: "",
        last_outcome: "",
        last_outcome_detail: "",
        last_audio_url: "",
        last_call_sid: ""
      };
      existing.call_count += 1;
      const lastTime = existing.last_call_at ? new Date(existing.last_call_at).getTime() : 0;
      if (!lastTime || callTime >= lastTime) {
        existing.last_call_at = call.created_at || existing.last_call_at;
        existing.last_outcome = call.outcome || "";
        existing.last_outcome_detail = call.outcome_detail || "";
        existing.last_audio_url = call.audio_url || "";
        existing.last_call_sid = call.callId || "";
      }
      callStatsByPhone.set(key, existing);
    }
  }

  const activeIndex = collectActiveCalls(allowedBrands);
  const results = [];
  for (const entry of list.slice(0, limit)) {
    if (!entry) continue;
    const cvUrl = await resolveStoredUrl(entry.cv_url || "");
    const cvPhotoUrl = await resolveStoredUrl(entry.cv_photo_url || "");
    let stats = callStatsByCv.get(entry.id);
    if (!stats || !stats.call_count) {
      const bKey = entry.brandKey || brandKey(entry.brand || "");
      const phoneKey = bKey && entry.phone ? `${bKey}:${entry.phone}` : "";
      if (phoneKey) {
        stats = callStatsByPhone.get(phoneKey) || stats;
      }
    }
    const lastAudioUrl = await resolveStoredUrl(stats?.last_audio_url || "");
    results.push(attachActiveCall({
      ...entry,
      cv_url: cvUrl || entry.cv_url || "",
      cv_photo_url: cvPhotoUrl || entry.cv_photo_url || "",
      call_count: stats?.call_count || 0,
      last_call_at: stats?.last_call_at || "",
      last_outcome: stats?.last_outcome || "",
      last_outcome_detail: stats?.last_outcome_detail || "",
      last_audio_url: lastAudioUrl || "",
      last_call_sid: stats?.last_call_sid || ""
    }, activeIndex));
  }
  return res.json({ ok: true, cvs: results });
});

app.post("/admin/cv", requireWrite, async (req, res) => {
  try {
    const body = req.body || {};
    const allowedBrands = Array.isArray(req.allowedBrands) ? req.allowedBrands : [];
    if (allowedBrands.length && !isBrandAllowed(allowedBrands, body.brand || "")) {
      return res.status(403).json({ error: "brand_not_allowed" });
    }
    let cvUrl = "";
    let cvPhotoUrl = "";
    const fileDataUrl = body.cv_file_data_url || "";
    const photoDataUrl = body.cv_photo_data_url || "";
    const fileName = body.cv_file_name || body.file_name || "";
    let id = body.id || "";
    if ((fileDataUrl || photoDataUrl) && !id) {
      id = randomToken();
      body.id = id;
    }
    if (fileDataUrl) {
      const size = estimateDataUrlBytes(fileDataUrl);
      if (size > CV_UPLOAD_MAX_BYTES) {
        return res.status(400).json({ error: "cv_file_too_large" });
      }
      const parsed = parseDataUrl(fileDataUrl);
      if (parsed) {
        const ext = path.extname(fileName || "") || (parsed.mime === "application/pdf" ? ".pdf" : ".bin");
        const safeName = sanitizeFilename(path.basename(fileName || `cv${ext}`));
        if (spacesEnabled) {
          const key = `cvs/${id}/${safeName}`;
          await uploadToSpaces({ key, body: parsed.buffer, contentType: parsed.mime });
          cvUrl = key;
        } else {
          const relPath = path.posix.join("cvs", id, safeName);
          const fullPath = path.join(adminUploadsDir, ...relPath.split("/"));
          await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
          await fs.promises.writeFile(fullPath, parsed.buffer);
          const baseUrl = (portalPublicUploadsBaseUrl || "/uploads").replace(/\/+$/, "");
          cvUrl = `${baseUrl}/${relPath}`;
        }
      }
    }
    if (photoDataUrl) {
      const size = estimateDataUrlBytes(photoDataUrl);
      if (size > CV_PHOTO_MAX_BYTES) {
        return res.status(400).json({ error: "cv_photo_too_large" });
      }
      const parsed = parseDataUrl(photoDataUrl);
      if (parsed) {
        const ext = parsed.mime === "image/png" ? ".png" : ".jpg";
        const file = `photo${ext}`;
        if (spacesEnabled) {
          const key = `cvs/${id}/${file}`;
          await uploadToSpaces({ key, body: parsed.buffer, contentType: parsed.mime });
          cvPhotoUrl = key;
        } else {
          const relPath = path.posix.join("cvs", id, file);
          const fullPath = path.join(adminUploadsDir, ...relPath.split("/"));
          await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
          await fs.promises.writeFile(fullPath, parsed.buffer);
          const baseUrl = (portalPublicUploadsBaseUrl || "/uploads").replace(/\/+$/, "");
          cvPhotoUrl = `${baseUrl}/${relPath}`;
        }
      }
    }
    const entry = buildCvEntry(body);
    if (!Object.prototype.hasOwnProperty.call(body, "custom_question")
        && !Object.prototype.hasOwnProperty.call(body, "customQuestion")
        && entry.id) {
      let existingQuestion = "";
      const existing = cvStoreById.get(entry.id);
      if (existing && existing.custom_question) {
        existingQuestion = existing.custom_question;
      } else if (dbPool) {
        try {
          const resp = await dbQuery("SELECT custom_question FROM cvs WHERE id = $1 LIMIT 1", [entry.id]);
          const row = resp?.rows?.[0];
          if (row?.custom_question) existingQuestion = row.custom_question;
        } catch {}
      }
      if (existingQuestion) entry.custom_question = existingQuestion;
    }
    if (!entry.cv_text) {
      return res.status(400).json({ error: "missing_cv_text" });
    }
    if (cvUrl) entry.cv_url = cvUrl;
    if (cvPhotoUrl) entry.cv_photo_url = cvPhotoUrl;
    recordCvEntry(entry);
    const resolvedUrl = await resolveStoredUrl(entry.cv_url || "");
    const resolvedPhotoUrl = await resolveStoredUrl(entry.cv_photo_url || "");
    return res.json({
      ok: true,
      cv: {
        ...entry,
        cv_url: resolvedUrl || entry.cv_url || "",
        cv_photo_url: resolvedPhotoUrl || entry.cv_photo_url || ""
      }
    });
  } catch (err) {
    console.error("[admin/cv] failed", err);
    return res.status(400).json({ error: "cv_failed", detail: err.message });
  }
});

app.post("/admin/cv/status", requireWrite, async (req, res) => {
  const body = req.body || {};
  const ids = Array.isArray(body.ids) ? body.ids.filter(Boolean) : (body.id ? [body.id] : []);
  if (!ids.length) return res.status(400).json({ error: "missing_cv_id" });
  const raw = String(body.decision || body.status || "").toLowerCase().trim();
  const decision = raw === "approved" || raw === "declined" || raw === "maybe" ? raw : "";
  ids.forEach((id) => {
    const entry = cvStoreById.get(id);
    if (entry) entry.decision = decision;
  });
  scheduleCvStoreSave();
  if (dbPool) {
    try {
      await dbQuery("UPDATE cvs SET decision = $1 WHERE id = ANY($2)", [decision, ids]);
    } catch (err) {
      console.error("[admin/cv] status update failed", err);
      return res.status(400).json({ error: "status_update_failed", detail: err.message });
    }
  }
  return res.json({ ok: true, decision });
});

app.post("/admin/cv/question", requireWrite, async (req, res) => {
  try {
    const body = req.body || {};
    const id = (body.id || "").toString().trim();
    const question = typeof body.question === "string" ? body.question.trim() : "";
    if (!id) return res.status(400).json({ error: "missing_id" });
    const allowedBrands = Array.isArray(req.allowedBrands) ? req.allowedBrands : [];

    if (dbPool) {
      const check = await dbQuery("SELECT brand_key FROM cvs WHERE id = $1 LIMIT 1", [id]);
      const row = check?.rows?.[0];
      if (!row) return res.status(404).json({ error: "not_found" });
      if (allowedBrands.length && row.brand_key && !allowedBrands.includes(row.brand_key)) {
        return res.status(403).json({ error: "brand_not_allowed" });
      }
      await dbQuery("UPDATE cvs SET custom_question = $1 WHERE id = $2", [question, id]);
    }

    const entry = cvStoreById.get(id);
    if (entry) {
      const brandKeyValue = entry.brandKey || brandKey(entry.brand || "");
      if (allowedBrands.length && brandKeyValue && !allowedBrands.includes(brandKeyValue)) {
        return res.status(403).json({ error: "brand_not_allowed" });
      }
      entry.custom_question = question;
      scheduleCvStoreSave();
    }
    return res.json({ ok: true, id, question });
  } catch (err) {
    console.error("[admin/cv] question update failed", err);
    return res.status(400).json({ error: "question_update_failed", detail: err.message });
  }
});

app.delete("/admin/cv/:id", requireAdminUser, async (req, res) => {
  const id = (req.params?.id || "").trim();
  if (!id) return res.status(400).json({ error: "missing_cv_id" });
  let removed = 0;
  for (let i = cvStore.length - 1; i >= 0; i -= 1) {
    const entry = cvStore[i];
    if (entry && entry.id === id) {
      cvStore.splice(i, 1);
      removed += 1;
      cvStoreById.delete(id);
    }
  }
  if (dbPool) {
    try {
      await dbQuery("DELETE FROM cvs WHERE id = $1", [id]);
    } catch (err) {
      console.error("[admin/cv] delete failed", err);
    }
  }
  scheduleCvStoreSave();
  return res.json({ ok: true, removed });
});

app.post("/admin/ocr", requireWrite, async (req, res) => {
  try {
    const images = normalizeOcrImages(req.body?.images || []);
    if (!images.length) {
      return res.status(400).json({ error: "missing_images" });
    }
    for (const img of images) {
      const size = estimateDataUrlBytes(img);
      if (size && size > OCR_MAX_IMAGE_BYTES) {
        return res.status(400).json({ error: "image_too_large" });
      }
    }
    const content = [
      {
        type: "text",
        text: "Extrae todo el texto legible de este CV. Devolvé solo el texto, sin comentarios ni formato extra."
      },
      ...images.map((url) => ({ type: "image_url", image_url: { url } }))
    ];
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: OPENAI_MODEL_OCR,
        temperature: 0,
        max_tokens: 1200,
        messages: [{ role: "user", content }]
      })
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(`ocr failed ${resp.status} ${detail}`);
    }
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content?.trim() || "";
    return res.json({ ok: true, text });
  } catch (err) {
    console.error("[admin/ocr] failed", err);
    return res.status(400).json({ error: "ocr_failed", detail: err.message });
  }
});

app.post("/admin/face-detect", requireConfigOrViewer, async (req, res) => {
  try {
    const image = (req.body?.image || "").toString();
    if (!image) return res.status(400).json({ error: "missing_image" });
    const size = estimateDataUrlBytes(image);
    if (size && size > OCR_MAX_IMAGE_BYTES) {
      return res.status(400).json({ error: "image_too_large" });
    }
    const content = [
      {
        type: "text",
        text:
          "Detecta el recuadro completo de la foto del candidato (tipo carnet/retrato) en la imagen. " +
          "Si la imagen es un CV/documento sin foto clara, devolvé {}. " +
          "No devuelvas logos, texto ni la página completa. " +
          "Respondé SOLO JSON con left, top, width, height normalizados (0-1)."
      },
      { type: "image_url", image_url: { url: image } }
    ];
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: OPENAI_MODEL_OCR,
        temperature: 0,
        max_tokens: 120,
        messages: [{ role: "user", content }]
      })
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(`face_detect failed ${resp.status} ${detail}`);
    }
    const data = await resp.json();
    const raw = (data.choices?.[0]?.message?.content || "").trim();
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch {}
      }
    }
    const box = parsed && typeof parsed === "object"
      ? (parsed.face && typeof parsed.face === "object" ? parsed.face : parsed)
      : null;
    const toNum = (val) => {
      const num = Number(val);
      return Number.isFinite(num) ? num : null;
    };
    let left = box ? toNum(box.left) : null;
    let top = box ? toNum(box.top) : null;
    let width = box ? toNum(box.width) : null;
    let height = box ? toNum(box.height) : null;
    if ([left, top, width, height].some((v) => v === null)) {
      return res.json({ ok: true, face: null });
    }
    if (left > 1 || top > 1 || width > 1 || height > 1) {
      if (left <= 100 && top <= 100 && width <= 100 && height <= 100) {
        left /= 100;
        top /= 100;
        width /= 100;
        height /= 100;
      }
    }
    const clamp = (v) => Math.max(0, Math.min(1, v));
    left = clamp(left);
    top = clamp(top);
    width = clamp(width);
    height = clamp(height);
    if (!width || !height) {
      return res.json({ ok: true, face: null });
    }
    return res.json({ ok: true, face: { left, top, width, height } });
  } catch (err) {
    console.error("[admin/face-detect] failed", err);
    return res.status(400).json({ error: "face_detect_failed", detail: err.message });
  }
});

app.post("/admin/cv-photo", requireConfigOrViewer, async (req, res) => {
  try {
    const raw = (req.body?.url || "").toString().trim();
    if (!raw) return res.status(400).json({ error: "missing_url" });
    if (raw.startsWith("data:")) {
      return res.json({ ok: true, data_url: raw });
    }
    if (!s3Client || !SPACES_BUCKET) {
      return res.status(400).json({ error: "spaces_not_configured" });
    }
    const key = extractSpacesKeyFromUrl(raw) || normalizeSpacesKey(raw);
    if (!key || key.includes("..")) {
      return res.status(400).json({ error: "invalid_url" });
    }
    const signedUrl = await resolveStoredUrl(key);
    if (!signedUrl) return res.status(400).json({ error: "invalid_url" });
    const resp = await fetch(signedUrl);
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      return res.status(400).json({ error: "download_failed", detail });
    }
    const mime = (resp.headers.get("content-type") || "image/jpeg").toLowerCase();
    if (!mime.startsWith("image/")) {
      return res.status(400).json({ error: "not_image" });
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    if (buffer.length > OCR_MAX_IMAGE_BYTES) {
      return res.status(400).json({ error: "image_too_large" });
    }
    const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
    return res.json({ ok: true, data_url: dataUrl });
  } catch (err) {
    console.error("[admin/cv-photo] failed", err);
    return res.status(400).json({ error: "photo_failed", detail: err.message });
  }
});

app.post("/admin/extract-contact", requireWrite, async (req, res) => {
  try {
    const rawText = (req.body?.text || "").toString();
    if (!rawText.trim()) {
      return res.status(400).json({ error: "missing_text" });
    }
    const text = rawText.slice(0, 4000);
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: OPENAI_MODEL_OCR,
        temperature: 0,
        max_tokens: 200,
        messages: [
          {
            role: "system",
            content: "Extract candidate contact info from resume text. Return strict JSON with keys name, phone, email. Use empty string if unknown. Name must be the person name (not company, role, or section titles)."
          },
          { role: "user", content: text }
        ]
      })
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(`extract_contact failed ${resp.status} ${detail}`);
    }
    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content || "";
    let parsed = null;
    try {
      parsed = JSON.parse(content);
    } catch {
      const match = content.match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch {}
      }
    }
    if (!parsed || typeof parsed !== "object") {
      return res.status(200).json({ ok: true, name: "", phone: "", email: "" });
    }
    return res.json({
      ok: true,
      name: typeof parsed.name === "string" ? parsed.name : "",
      phone: typeof parsed.phone === "string" ? parsed.phone : "",
      email: typeof parsed.email === "string" ? parsed.email : ""
    });
  } catch (err) {
    console.error("[admin/extract-contact] failed", err);
    return res.status(400).json({ error: "extract_contact_failed", detail: err.message });
  }
});

app.get("/admin/ui", (req, res) => {
  res.type("text/html").send(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>HRBOT Console</title>
  <link rel="manifest" href="/admin/manifest.json" />
  <meta name="theme-color" content="#1b7a8c" />
  <link rel="icon" href="/admin/icon.svg" type="image/svg+xml" />
  <link rel="apple-touch-icon" href="/admin/icon.svg" />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&family=DM+Sans:wght@400;500;700&display=swap" />
  <style>
    :root {
      --bg: #f4efe6;
      --panel: #ffffff;
      --primary: #1b7a8c;
      --primary-dark: #0f5563;
      --accent: #f4a261;
      --ink: #1b1b1b;
      --muted: #6a6f6b;
      --border: #e4dac8;
      --shadow: 0 12px 30px rgba(24, 48, 56, 0.14);
      --glow: 0 0 0 2px rgba(27, 122, 140, 0.16);
    }
    * { box-sizing: border-box; }
    body {
      font-family: "DM Sans", "Helvetica Neue", sans-serif;
      margin: 0;
      padding: 0;
      background: radial-gradient(circle at top left, #fff6e9 0%, #f4efe6 45%, #efe6d8 100%);
      color: var(--ink);
      min-height: 100vh;
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      background-image:
        radial-gradient(circle at 12% 18%, rgba(255, 255, 255, 0.6), transparent 50%),
        radial-gradient(circle at 80% 10%, rgba(244, 162, 97, 0.12), transparent 55%),
        linear-gradient(120deg, rgba(27, 122, 140, 0.08), rgba(255, 255, 255, 0));
      pointer-events: none;
      z-index: -1;
    }
    h1, h2, h3, h4 { font-family: "Space Grotesk", sans-serif; margin: 0; }
    label { display: block; margin-bottom: 6px; font-weight: 600; font-size: 13px; color: var(--muted); }
    input[type="password"], input[type="text"], textarea, select {
      width: 100%;
      padding: 10px 12px;
      border-radius: 12px;
      border: 1px solid var(--border);
      font-family: "DM Sans", sans-serif;
      background: #fff;
      color: var(--ink);
    }
    textarea { min-height: 90px; resize: vertical; }
    button {
      background: var(--primary);
      color: #fff;
      border: none;
      padding: 10px 16px;
      border-radius: 12px;
      cursor: pointer;
      font-weight: 700;
      box-shadow: 0 10px 20px rgba(27, 122, 140, 0.2);
      transition: transform 0.05s ease, box-shadow 0.2s ease;
    }
    button:active { transform: translateY(1px); }
    button.secondary {
      background: transparent;
      color: var(--primary);
      border: 1px solid var(--primary);
      box-shadow: none;
    }
    button.secondary:hover { box-shadow: var(--glow); }
    button:disabled { opacity: 0.6; cursor: not-allowed; }
    .app { display: flex; min-height: 100vh; }
    .sidebar {
      width: 280px;
      flex: 0 0 280px;
      background: linear-gradient(165deg, #0b3440 0%, #1b5f74 60%, #2a8ca3 100%);
      color: #f8f3ea;
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 20px;
      transition: width 0.2s ease, padding 0.2s ease;
    }
    .sidebar-brand { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
    .brand-title { display: flex; flex-direction: column; gap: 4px; }
    .brand-mark { font-size: 20px; font-weight: 700; letter-spacing: 2px; text-transform: uppercase; }
    .brand-sub { font-size: 12px; color: rgba(248, 243, 234, 0.7); }
    .sidebar-toggle {
      background: rgba(255, 255, 255, 0.16);
      border: 1px solid rgba(255, 255, 255, 0.35);
      color: inherit;
      padding: 6px 10px;
      border-radius: 10px;
      cursor: pointer;
      box-shadow: none;
    }
    .sidebar-toggle:hover { box-shadow: var(--glow); }
    .nav { display: flex; flex-direction: column; gap: 12px; }
    .nav-section-title { text-transform: uppercase; letter-spacing: 1px; font-size: 11px; color: rgba(248, 243, 234, 0.6); margin-top: 6px; }
    .nav-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 12px;
      border-radius: 12px;
      background: transparent;
      color: inherit;
      border: 1px solid rgba(255, 255, 255, 0.15);
      text-align: left;
      min-width: 0;
    }
    .nav-item.active {
      background: rgba(255, 255, 255, 0.15);
      border-color: rgba(255, 255, 255, 0.35);
    }
    .nav-badge {
      margin-left: auto;
      min-width: 22px;
      height: 22px;
      border-radius: 999px;
      background: #f4a261;
      color: #0b3440;
      display: none;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 700;
      padding: 0 6px;
    }
    .nav-icon {
      width: 28px;
      height: 28px;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.18);
      display: grid;
      place-items: center;
      font-size: 12px;
      font-weight: 700;
    }
    .nav-label { white-space: nowrap; min-width: 0; flex: 1; }
    .brand-list .nav-label {
      white-space: normal;
      line-height: 1.2;
      font-size: 12px;
      word-break: break-word;
    }
    .brand-list { display: flex; flex-direction: column; gap: 8px; }
    .brand-thumb {
      width: 36px;
      height: 36px;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.2);
      display: grid;
      place-items: center;
      overflow: hidden;
      font-size: 12px;
      font-weight: 700;
    }
    .brand-thumb img { width: 100%; height: 100%; object-fit: cover; }
    .nav-add { margin-top: 6px; font-size: 13px; }
    .sidebar.collapsed {
      width: 84px;
      flex-basis: 84px;
      padding: 20px 14px;
      align-items: center;
    }
    .sidebar.collapsed .brand-title,
    .sidebar.collapsed .nav-label,
    .sidebar.collapsed .nav-section-title,
    .sidebar.collapsed .nav-add { display: none; }
    .sidebar.collapsed .nav { align-items: center; }
    .sidebar.collapsed .nav-item { justify-content: center; padding: 10px; width: 100%; }
    .sidebar.collapsed .brand-list { align-items: center; width: 100%; }
    .sidebar.collapsed .brand-thumb { width: 40px; height: 40px; border-radius: 12px; }
    .content {
      flex: 1;
      padding: 28px 32px 64px;
    }
    .content-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }
    .eyebrow { text-transform: uppercase; letter-spacing: 1px; font-size: 11px; color: var(--muted); }
    .header-actions { display: flex; align-items: center; gap: 10px; }
    .status-line { margin: 8px 0 18px; color: var(--muted); font-size: 13px; min-height: 18px; }
    .panel {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 20px;
      box-shadow: var(--shadow);
      margin-bottom: 20px;
      animation: fadeUp 0.4s ease both;
      animation-delay: var(--delay, 0s);
    }
    .panel-title { font-size: 18px; font-weight: 700; margin-bottom: 4px; }
    .panel-sub { font-size: 13px; color: var(--muted); margin-bottom: 16px; }
    .divider { border-top: 1px solid var(--border); margin: 18px 0; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; }
    .inline { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .row { margin-top: 12px; }
    .muted { color: var(--muted); font-size: 13px; }
    .small { font-size: 12px; color: var(--muted); }
    .status { font-size: 12px; color: var(--muted); }
    .check-row { display: flex; align-items: center; gap: 8px; }
    .brand-card { padding: 0; overflow: hidden; }
    .brand-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      padding: 14px 16px;
      background: #f7f2e8;
      cursor: pointer;
    }
    .brand-meta { padding: 16px; }
    .roles { margin: 0 16px 16px; display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
    .role-card {
      border: 1px solid var(--border);
      border-radius: 14px;
      background: #fff;
      overflow: hidden;
    }
    .role-header {
      padding: 10px 12px;
      background: #fbfaf7;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      cursor: pointer;
    }
    .role-body { padding: 12px; display: flex; flex-direction: column; gap: 8px; }
    .pill { padding: 4px 10px; border-radius: 999px; background: #e4f1f2; color: #0f5563; font-weight: 600; font-size: 11px; }
    .question { display: flex; gap: 8px; align-items: center; }
    .question input { flex: 1; }
    .chevron { font-size: 12px; opacity: 0.7; }
    .logo-row { margin-top: 12px; }
    .logo-drop {
      display: flex;
      align-items: center;
      gap: 12px;
      border: 1px dashed var(--border);
      border-radius: 14px;
      padding: 12px;
      background: #fcfaf6;
      cursor: pointer;
    }
    .logo-drop.drag { border-color: var(--primary); box-shadow: var(--glow); }
    .logo-preview {
      width: 64px;
      height: 64px;
      border-radius: 14px;
      background: #efe6d8;
      display: grid;
      place-items: center;
      font-weight: 700;
      color: var(--primary-dark);
    }
    .logo-preview img { width: 100%; height: 100%; object-fit: cover; }
    .brand-logo-input { display: none; }
    .faq-list { display: grid; gap: 12px; }
    .faq-item {
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 12px 14px;
      background: #fff;
    }
    .faq-item summary {
      cursor: pointer;
      font-weight: 700;
      color: #2f3e36;
    }
    .faq-body {
      margin-top: 8px;
      font-size: 13px;
      line-height: 1.45;
      color: var(--muted);
    }
    .tab-pill {
      padding: 6px 12px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: #fff;
      font-size: 12px;
      font-weight: 600;
      color: var(--primary-dark);
      cursor: pointer;
    }
    .tab-pill.active {
      background: rgba(27, 122, 140, 0.18);
      border-color: rgba(27, 122, 140, 0.45);
      color: #0f5563;
    }
    .view-switch {
      display: inline-flex;
      gap: 6px;
      margin-top: 8px;
      padding: 4px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: #fff;
    }
    .view-switch button {
      padding: 6px 12px;
      border-radius: 999px;
      border: 1px solid transparent;
      background: transparent;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      box-shadow: none;
    }
    .view-switch button.active {
      background: rgba(27, 122, 140, 0.16);
      border-color: rgba(27, 122, 140, 0.45);
      color: var(--primary-dark);
    }
    .swipe-view {
      margin-top: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .swipe-meta {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 12px;
      color: var(--muted);
      padding: 0 2px;
    }
    .swipe-hint { font-size: 11px; }
    @keyframes swipe-pop {
      0% { opacity: 0; transform: translateY(8px) scale(0.985); }
      100% { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes swipe-float {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-2px); }
    }
    .swipe-card {
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 14px;
      background: #fff;
      box-shadow: var(--shadow);
      display: flex;
      flex-direction: column;
      gap: 10px;
      touch-action: pan-y;
      animation: swipe-pop 240ms ease-out;
    }
    .swipe-card:active { animation-play-state: paused; }
    .swipe-card.is-new {
      border-color: rgba(27, 122, 140, 0.55);
      box-shadow: 0 0 0 2px rgba(27, 122, 140, 0.16), var(--shadow);
    }
    @media (prefers-reduced-motion: reduce) {
      .swipe-card { animation: none !important; }
    }
    .swipe-avatar {
      width: 72px;
      height: 72px;
      border-radius: 18px;
      object-fit: cover;
      border: 1px solid var(--border);
      background: #efe6d8;
      flex: 0 0 72px;
    }
    .swipe-empty {
      padding: 22px 16px;
      text-align: center;
      color: var(--muted);
      font-weight: 700;
    }
    .swipe-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .swipe-title {
      font-size: 16px;
      font-weight: 800;
      color: var(--ink);
    }
    .swipe-sub {
      font-size: 12px;
      color: var(--muted);
      margin-top: 2px;
    }
    .swipe-section {
      border-top: 1px solid rgba(228, 218, 200, 0.7);
      padding-top: 8px;
      margin-top: 4px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .swipe-row {
      display: grid;
      grid-template-columns: 110px minmax(0, 1fr);
      gap: 8px;
      align-items: center;
    }
    .swipe-label {
      font-size: 10.5px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--muted);
      font-weight: 800;
    }
    .swipe-value {
      font-size: 13.5px;
      color: var(--ink);
      font-weight: 600;
      word-break: break-word;
    }
    .swipe-section .action-stack { flex-wrap: wrap; }
    .swipe-controls {
      display: flex;
      gap: 8px;
    }
    .swipe-controls button { flex: 1; }
    .swipe-value .audio-player {
      width: 100%;
      min-width: 0;
    }
    .swipe-value .audio-progress {
      flex: 1;
      min-width: 90px;
    }
    .drop-zone {
      border: 1px dashed var(--border);
      border-radius: 16px;
      padding: 16px;
      background: #fbfaf7;
      display: flex;
      align-items: center;
      gap: 12px;
      cursor: pointer;
    }
    .drop-zone.drag { border-color: var(--primary); box-shadow: var(--glow); }
    .drop-icon {
      width: 46px;
      height: 46px;
      border-radius: 14px;
      background: rgba(27, 122, 140, 0.12);
      display: grid;
      place-items: center;
      font-weight: 700;
      color: var(--primary);
    }
    .drop-file { display: none; }
    .preview-output { min-height: 220px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; }
    .system-prompt { min-height: 260px; }
    .prompt-split {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 16px;
      align-items: start;
    }
    .prompt-col { min-width: 0; }
    .prompt-tools {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-top: 10px;
      padding: 12px;
      border-radius: 14px;
      border: 1px dashed rgba(178, 164, 132, 0.6);
      background: #fcfaf6;
    }
    .prompt-tools.compact { gap: 6px; padding: 10px; }
    .prompt-tools-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }
    .prompt-tools.compact input,
    .prompt-tools.compact select {
      padding: 8px 10px;
      border-radius: 10px;
      font-size: 12px;
    }
    .prompt-tools.compact select { min-width: 160px; flex: 1 1 160px; }
    .prompt-tools.compact .btn-compact { white-space: nowrap; }
    .prompt-tools.compact button {
      padding: 8px 12px;
      border-radius: 10px;
      font-size: 12px;
      box-shadow: none;
    }
    .prompt-tools .inline { flex-wrap: wrap; }
    .prompt-side .prompt-assistant-card {
      border-radius: 16px;
      padding: 14px;
      border: 1px solid rgba(27, 122, 140, 0.2);
      background: linear-gradient(180deg, rgba(27, 122, 140, 0.08), rgba(255, 255, 255, 0.9));
      box-shadow: 0 12px 24px rgba(19, 55, 66, 0.12);
      display: grid;
      gap: 10px;
    }
    .prompt-side .prompt-assistant-card .panel-title {
      font-size: 16px;
    }
    .prompt-preview {
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 10px 12px;
      background: #fff;
      font-size: 12px;
      line-height: 1.45;
      max-height: 220px;
      overflow: auto;
      white-space: pre-wrap;
    }
    .prompt-preview mark {
      background: rgba(245, 200, 86, 0.4);
      padding: 0 2px;
      border-radius: 4px;
    }
    #prompt-assistant-input { min-height: 120px; }
    textarea.locked { background: #f2f0ea; color: #6b7280; }
    @media (max-width: 980px) {
      .prompt-split { grid-template-columns: 1fr; }
    }
    .table-wrapper {
      border: 1px solid var(--border);
      border-radius: 16px;
      overflow: auto;
      max-height: 540px;
      background: #fff;
    }
    .portal-layout { display: grid; grid-template-columns: 240px 1fr; gap: 16px; align-items: start; }
    .portal-sidebar { display: flex; flex-direction: column; gap: 12px; }
    .portal-list { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
    .portal-item {
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 8px 10px;
      background: #fff;
      text-align: left;
      cursor: pointer;
      font-weight: 600;
      color: var(--ink);
    }
    .portal-item.active { border-color: var(--primary); box-shadow: var(--glow); }
    .portal-form { display: flex; flex-direction: column; gap: 16px; }
    .portal-section {
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 16px;
      background: #fff;
      box-shadow: 0 12px 24px rgba(36, 27, 19, 0.08);
    }
    .portal-section-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
    }
    .portal-section-title { font-size: 14px; font-weight: 700; color: var(--primary-dark); }
    .portal-section-sub { font-size: 12px; color: var(--muted); }
    .portal-subhead {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
      margin: 6px 0 8px;
    }
    .portal-section .grid + .grid { margin-top: 10px; }
    .section-title { font-size: 14px; font-weight: 700; color: var(--primary-dark); margin: 12px 0 6px; }
    .portal-question {
      border: 1px dashed var(--border);
      border-radius: 14px;
      padding: 12px;
      background: #fff;
      display: grid;
      gap: 10px;
    }
    .portal-location-options {
      display: grid;
      gap: 8px;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    }
    .portal-location-option {
      display: flex;
      align-items: center;
      gap: 8px;
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 8px 10px;
      background: #fff;
      font-weight: 600;
      color: var(--ink);
    }
    .portal-location-option input { width: auto; }
    .portal-color-row { display: flex; gap: 10px; align-items: center; }
    .portal-color-row input[type="text"] { flex: 1; }
    .portal-color-row input[type="color"] {
      width: 44px;
      height: 42px;
      padding: 0;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: #fff;
      cursor: pointer;
    }
    .portal-url-row { display: flex; gap: 8px; align-items: center; }
    .portal-url-row input { flex: 1; cursor: pointer; }
    .portal-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
    .portal-table th, .portal-table td { padding: 8px 10px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
    .portal-table th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
    .portal-answer { white-space: pre-wrap; min-width: 220px; }
    .portal-preview {
      border: 1px solid var(--border);
      border-radius: 18px;
      background: var(--p-bg, #f6f2e9);
      padding: 16px;
      display: grid;
      gap: 14px;
      font-family: var(--p-body, "Manrope", sans-serif);
      color: var(--p-text, #241b13);
    }
    .portal-preview-hero {
      background: var(--p-card, #fff);
      border-radius: 16px;
      padding: 16px;
      display: grid;
      grid-template-columns: minmax(0, 1.1fr) minmax(0, 0.9fr);
      gap: 14px;
      align-items: center;
      border: 1px solid rgba(0, 0, 0, 0.06);
    }
    .portal-preview-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 999px;
      background: rgba(0, 0, 0, 0.06);
      color: var(--p-accent, #1f6f5c);
      font-size: 10px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      font-weight: 700;
    }
    .portal-preview-brand-row {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 600;
      color: var(--p-muted, #6c5f57);
      margin-top: 8px;
    }
    .portal-preview-logo {
      width: 36px;
      height: 36px;
      border-radius: 12px;
      object-fit: cover;
      background: rgba(0, 0, 0, 0.06);
    }
    .portal-preview-title {
      font-family: var(--p-heading, "Fraunces", serif);
      font-size: 22px;
      line-height: 1.1;
      margin: 8px 0 6px;
    }
    .portal-preview-desc {
      color: var(--p-muted, #6c5f57);
      font-size: 12px;
      line-height: 1.4;
    }
    .portal-preview-note {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding: 8px;
      border-radius: 12px;
      background: rgba(0, 0, 0, 0.06);
      font-size: 11px;
    }
    .portal-preview-chip {
      display: inline-flex;
      align-items: center;
      padding: 4px 8px;
      border-radius: 999px;
      border: 1px solid rgba(0, 0, 0, 0.12);
      background: #fff;
      color: var(--p-text, #241b13);
      font-weight: 600;
      font-size: 11px;
    }
    .portal-preview-hero-image {
      border-radius: 14px;
      background: rgba(0, 0, 0, 0.06);
      min-height: 120px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      color: var(--p-muted, #6c5f57);
      overflow: hidden;
      background-size: cover;
      background-position: center;
    }
    .portal-preview-grid {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    }
    .portal-preview-card {
      background: var(--p-card, #fff);
      border-radius: 16px;
      padding: 14px;
      border: 1px solid rgba(0, 0, 0, 0.06);
      display: grid;
      gap: 10px;
    }
    .portal-preview-card-title {
      font-weight: 700;
      font-size: 13px;
      color: var(--p-text, #241b13);
    }
    .portal-preview-field {
      display: grid;
      gap: 6px;
    }
    .portal-preview-field-label {
      font-size: 11px;
      font-weight: 600;
      color: var(--p-muted, #6c5f57);
    }
    .portal-preview-field-input {
      height: 30px;
      border-radius: 10px;
      border: 1px solid rgba(0, 0, 0, 0.12);
      background: #fff;
    }
    .portal-preview-field-list {
      min-height: 30px;
      height: auto;
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      padding: 6px 8px;
    }
    .portal-preview-field-list.layout-chips .portal-preview-chip {
      border-radius: 999px;
      padding: 4px 10px;
    }
    .portal-preview-field-list.layout-compact {
      flex-direction: column;
      align-items: flex-start;
      gap: 4px;
    }
    .portal-preview-field-list.layout-compact .portal-preview-chip {
      border-radius: 10px;
      padding: 4px 8px;
      width: 100%;
    }
    .portal-preview-field-list.layout-maps {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      gap: 6px;
      align-items: stretch;
    }
    .portal-preview-field-list.layout-maps .portal-preview-chip {
      border-radius: 12px;
      padding: 6px;
      text-align: center;
    }
    .portal-preview-chip {
      padding: 3px 8px;
      border-radius: 999px;
      border: 1px solid rgba(0, 0, 0, 0.12);
      background: rgba(0, 0, 0, 0.04);
      font-size: 10px;
      color: var(--p-muted, #6c5f57);
    }
    .portal-preview-btn {
      border: none;
      border-radius: 999px;
      padding: 10px 14px;
      background: var(--p-primary, #c84c33);
      color: #fff;
      font-weight: 700;
      font-size: 12px;
      cursor: default;
    }
    .portal-preview-gallery {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(72px, 1fr));
      gap: 8px;
    }
    .portal-preview-gallery img {
      width: 100%;
      height: 64px;
      border-radius: 10px;
      object-fit: cover;
      background: rgba(0, 0, 0, 0.06);
    }
    .action-stack {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: nowrap;
    }
    .icon-btn {
      width: 42px;
      height: 42px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 12px;
    }
    .icon-btn svg { width: 18px; height: 18px; }
    .btn-compact {
      padding: 6px 10px;
      font-size: 11px;
      border-radius: 10px;
      box-shadow: none;
      white-space: nowrap;
    }
    .btn-compact.secondary { box-shadow: none; }
    .btn-compact.icon-only {
      padding: 6px 8px;
      min-width: 32px;
      text-align: center;
    }
    .cell-compact {
      white-space: nowrap;
      max-width: 160px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .candidate-cell {
      min-width: 0;
      max-width: 100%;
      vertical-align: middle;
      background: transparent;
    }
    .candidate-wrap {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
      width: 100%;
      min-height: 32px;
    }
    .candidate-score-pill { display: none; }
    .candidate-avatar {
      width: 32px;
      height: 32px;
      border-radius: 10px;
      object-fit: cover;
      object-position: center;
      border: 1px solid var(--border);
      background: #efe6d8;
      cursor: zoom-in;
      transition: transform 0.15s ease, box-shadow 0.15s ease;
      flex: 0 0 32px;
    }
    .candidate-avatar:hover {
      transform: scale(1.08);
      box-shadow: 0 6px 16px rgba(20, 24, 22, 0.18);
    }
    .candidate-name {
      font-weight: 600;
      line-height: 1.1;
      min-width: 0;
      flex: 1;
      max-width: 200px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      display: inline-block;
      background: transparent;
      border: 0;
      padding: 0;
      margin: 0;
    }
    .call-active td { background: rgba(27, 122, 140, 0.12) !important; }
    .status-live { color: #0f5563; font-weight: 700; }
    .status-live::after {
      content: "...";
      display: inline-block;
      width: 0;
      overflow: hidden;
      vertical-align: bottom;
      margin-left: 2px;
      animation: ellipsis 1.2s infinite steps(4, end);
    }
    @keyframes ellipsis {
      to { width: 1.2em; }
    }
    .detail-row td {
      background: #fff;
      padding: 12px 14px;
    }
    .detail-card {
      border: 1px solid var(--border);
      border-radius: 14px;
      background: #fff;
      padding: 14px;
      box-shadow: none;
    }
    .detail-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 8px 12px;
    }
    .detail-item {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 12px;
    }
    .detail-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: var(--muted);
      font-weight: 700;
    }
    .detail-value { color: #1f2a24; font-weight: 600; }
    .detail-block {
      grid-column: 1 / -1;
      border-top: 1px solid var(--border);
      border-bottom: 1px solid var(--border);
      background: transparent;
      border-radius: 0;
      padding: 10px 2px;
      white-space: pre-wrap;
      font-size: 12px;
      line-height: 1.45;
      color: #2f3e36;
    }
    .detail-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .audio-wrap { display: flex; align-items: center; gap: 8px; }
    .detail-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding-bottom: 10px;
      margin-bottom: 12px;
      border-bottom: 1px solid var(--border);
    }
    .detail-head-left { display: flex; flex-direction: column; gap: 4px; }
    .detail-name { font-size: 14px; font-weight: 700; color: #1f2a24; }
    .detail-meta { font-size: 12px; color: var(--muted); }
    .detail-head-right { display: flex; align-items: center; gap: 10px; }
    .detail-status { font-size: 12px; color: var(--muted); font-weight: 600; }
    .detail-score { min-width: 52px; }
    .date-stack { display: flex; flex-direction: column; gap: 2px; }
    .date-main { font-weight: 700; color: #1f2a24; }
    .date-sub { font-size: 11px; color: var(--muted); }
    .audio-player {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: #fff;
      min-width: 210px;
    }
    .audio-hidden { display: none; }
    .audio-play {
      width: 28px;
      height: 28px;
      padding: 0;
      border-radius: 999px;
      display: grid;
      place-items: center;
      font-size: 12px;
      background: var(--primary);
      color: #fff;
      box-shadow: none;
    }
    .audio-progress {
      width: 90px;
      accent-color: var(--primary);
    }
    .audio-time {
      font-size: 11px;
      color: var(--muted);
      min-width: 62px;
      text-align: right;
    }
    .audio-menu { position: relative; }
    .audio-menu-btn {
      width: 28px;
      height: 28px;
      padding: 0;
      border-radius: 999px;
      background: transparent;
      color: var(--primary);
      border: 1px solid var(--border);
      box-shadow: none;
    }
    .audio-speed-menu {
      position: absolute;
      right: 0;
      top: 34px;
      background: #fff;
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 6px;
      display: none;
      z-index: 10;
      box-shadow: var(--shadow);
      min-width: 90px;
    }
    .audio-menu.open-up .audio-speed-menu {
      top: auto;
      bottom: 34px;
    }
    .audio-speed-menu button {
      width: 100%;
      background: transparent;
      border: none;
      color: var(--ink);
      font-size: 11px;
      padding: 6px 8px;
      text-align: left;
      border-radius: 8px;
      box-shadow: none;
    }
    .audio-speed-menu button:hover { background: rgba(27, 122, 140, 0.12); }
    .audio-menu.open .audio-speed-menu { display: block; }
    .audio-download {
      width: 28px;
      height: 28px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 999px;
      border: 1px solid var(--border);
      color: var(--primary);
      text-decoration: none;
      font-size: 12px;
      background: #fff;
    }
    .audio-download:hover { box-shadow: var(--glow); }
    .audio-download:disabled { opacity: 0.45; cursor: not-allowed; }
    .summary-cell {
      max-width: 220px;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: 1.35;
      cursor: help;
    }
    .summary-tooltip {
      position: fixed;
      max-width: 360px;
      background: #fff;
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 10px 12px;
      font-size: 12px;
      line-height: 1.45;
      color: #2f3e36;
      box-shadow: 0 14px 30px rgba(22, 49, 43, 0.18);
      display: none;
      z-index: 9999;
    }
    .summary-tooltip.visible { display: block; }
    .readonly {
      opacity: 0.65;
    }
    .readonly .drop-zone,
    .readonly input,
    .readonly textarea,
    .readonly select,
    .readonly button {
      pointer-events: none;
    }
    .user-panel {
      position: relative;
      overflow: hidden;
      border-color: rgba(27, 122, 140, 0.18);
      background: linear-gradient(180deg, #ffffff 0%, #f8f5ee 100%);
    }
    .user-panel::before {
      content: "";
      position: absolute;
      width: 260px;
      height: 260px;
      right: -120px;
      top: -120px;
      background: radial-gradient(circle at 30% 30%, rgba(27, 122, 140, 0.18), transparent 70%);
      pointer-events: none;
    }
    .user-panel::after {
      content: "";
      position: absolute;
      width: 220px;
      height: 220px;
      left: -80px;
      bottom: -90px;
      background: radial-gradient(circle at 70% 70%, rgba(244, 162, 97, 0.2), transparent 70%);
      pointer-events: none;
    }
    .user-panel > * { position: relative; }
    .user-hero {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 14px;
    }
    .user-kicker {
      text-transform: uppercase;
      letter-spacing: 1.6px;
      font-size: 10px;
      font-weight: 700;
      color: var(--primary-dark);
    }
    .user-title {
      font-size: 22px;
      font-weight: 700;
      font-family: "Space Grotesk", sans-serif;
      margin-top: 4px;
    }
    .user-sub {
      font-size: 13px;
      color: var(--muted);
      max-width: 460px;
    }
    .user-roles {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .role-pill {
      padding: 6px 10px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
      border: 1px solid rgba(27, 122, 140, 0.2);
      background: rgba(27, 122, 140, 0.12);
      color: var(--primary-dark);
    }
    .role-pill.admin { background: rgba(15, 85, 99, 0.16); }
    .role-pill.interviewer {
      background: rgba(244, 162, 97, 0.2);
      border-color: rgba(244, 162, 97, 0.35);
      color: #8a4a14;
    }
    .role-pill.viewer {
      background: rgba(26, 140, 127, 0.16);
      border-color: rgba(26, 140, 127, 0.25);
      color: #0d5a55;
    }
    .user-form-grid {
      display: grid;
      grid-template-columns: minmax(260px, 1.1fr) minmax(220px, 0.9fr);
      gap: 16px;
      margin-bottom: 12px;
    }
    .user-card {
      background: #fff;
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 14px;
      box-shadow: 0 10px 22px rgba(27, 122, 140, 0.08);
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .user-card-title {
      font-size: 14px;
      font-weight: 700;
      color: var(--primary-dark);
    }
    .user-card-sub { font-size: 12px; color: var(--muted); }
    .user-grid {
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    }
    .user-tip {
      background: rgba(27, 122, 140, 0.08);
      border: 1px dashed rgba(27, 122, 140, 0.25);
      padding: 8px 10px;
      border-radius: 12px;
      font-size: 12px;
      color: var(--primary-dark);
    }
    .user-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .user-status {
      font-size: 12px;
      color: var(--muted);
      font-weight: 600;
    }
    .user-list-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      margin-top: 10px;
    }
    .user-list-title { font-size: 14px; font-weight: 700; }
    .user-brand-list {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }
    .brand-check {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      border-radius: 999px;
      border: 1px solid rgba(27, 122, 140, 0.2);
      background: #f7fbfa;
      font-size: 12px;
    }
    .brand-check input { margin: 0; }
    .user-actions {
      display: inline-flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .user-table { width: 100%; border-collapse: separate; border-spacing: 0; }
    .user-table th {
      background: #f3efe6;
      border-bottom: 1px solid var(--border);
    }
    .user-table tbody td { background: #fff; }
    .user-table tbody tr:nth-child(even) td { background: #fbf7ef; }
    .user-table tbody tr:hover td { background: #f4efe6; }
    table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
    .cv-table { table-layout: auto; }
    .cv-table td { white-space: normal; line-height: 1.2; }
    .cv-status {
      max-width: 170px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .decision-cell { white-space: nowrap; }
    .decision-buttons { display: inline-flex; gap: 6px; align-items: center; }
    .decision-buttons.is-loading { opacity: 0.6; pointer-events: none; }
    .decision-btn {
      width: 28px;
      height: 28px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: #fff;
      color: var(--muted);
      font-weight: 700;
      font-size: 12px;
      padding: 0;
      line-height: 1;
      box-shadow: none;
    }
    .decision-btn:hover { box-shadow: var(--glow); }
    .decision-btn.active.approved {
      background: rgba(31,111,92,0.14);
      border-color: rgba(31,111,92,0.45);
      color: #1f6f5c;
    }
    .decision-btn.active.declined {
      background: rgba(180,35,24,0.14);
      border-color: rgba(180,35,24,0.45);
      color: #b42318;
    }
    .decision-btn.active.maybe {
      background: rgba(168,103,0,0.16);
      border-color: rgba(168,103,0,0.45);
      color: #8a5b00;
    }
    .action-cell { white-space: nowrap; }
    th, td { padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
    th {
      position: sticky;
      top: 0;
      background: #fdf9f1;
      text-align: left;
      font-weight: 700;
      z-index: 1;
    }
    tbody tr:nth-child(even) td { background: #fbf7f0; }
    tr.row-clickable { cursor: pointer; }
    tr.row-clickable:hover td { background: #f5f1e9; }
    tbody tr.is-new td { background: rgba(27, 122, 140, 0.12); }
    tbody tr.is-new:hover td { background: rgba(27, 122, 140, 0.18); }
    tbody tr.is-new td:first-child { box-shadow: inset 3px 0 0 rgba(27, 122, 140, 0.5); }
    .score-pill {
      padding: 4px 8px;
      border-radius: 999px;
      font-weight: 700;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 44px;
    }
    .score-high { background: rgba(27, 122, 140, 0.18); color: #0f5563; }
    .score-mid { background: rgba(244, 162, 97, 0.2); color: #8a4a14; }
    .score-low { background: rgba(206, 76, 50, 0.18); color: #7b2914; }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
    }
    .badge.advance { background: rgba(27, 122, 140, 0.18); color: #0f5563; }
    .badge.review { background: rgba(244, 162, 97, 0.2); color: #8a4a14; }
    .badge.reject { background: rgba(206, 76, 50, 0.18); color: #7b2914; }
    .badge .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
    .sidebar-overlay {
      position: fixed;
      inset: 0;
      background: rgba(10, 18, 22, 0.45);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s ease;
      z-index: 15;
      display: none;
    }
    body.sidebar-open .sidebar-overlay {
      opacity: 1;
      pointer-events: auto;
    }
    .mobile-bar {
      display: none;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 6px;
      margin: -6px -6px 12px;
      position: sticky;
      top: 0;
      z-index: 8;
      background: var(--bg);
      border-bottom: 1px solid rgba(228, 218, 200, 0.6);
    }
    .mobile-title {
      font-weight: 700;
      font-size: 15px;
      color: var(--ink);
    }
    .panel.has-mobile-toggle .panel-body {
      margin-top: 12px;
      margin-bottom: 10px;
    }
    .panel-filters {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .panel-toggle {
      display: none;
      padding: 6px 12px;
      border-radius: 999px;
      font-size: 12px;
      box-shadow: none;
    }
    .panel.mobile-collapsed .panel-body { display: none; }
    .login-screen {
      position: fixed;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: radial-gradient(circle at top, #fff6e9, #f4efe6 60%);
      padding: 24px;
      z-index: 5;
    }
    .login-card {
      width: min(420px, 92vw);
      background: var(--panel);
      border-radius: 20px;
      padding: 28px;
      border: 1px solid var(--border);
      box-shadow: var(--shadow);
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .login-tabs {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-top: 4px;
    }
    .login-tab {
      padding: 8px 10px;
      border-radius: 12px;
      border: 1px solid var(--border);
      background: #fff;
      color: var(--ink);
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      box-shadow: none;
    }
    .login-tab.active {
      background: var(--primary);
      color: #fff;
      border-color: transparent;
    }
    .login-fields { display: flex; flex-direction: column; gap: 10px; }
    .cv-modal {
      position: fixed;
      inset: 0;
      background: rgba(20, 24, 22, 0.55);
      display: none;
      align-items: center;
      justify-content: center;
      padding: 24px;
      z-index: 10;
    }
    .cv-modal-card {
      width: min(720px, 92vw);
      background: var(--panel);
      border-radius: 18px;
      border: 1px solid var(--border);
      padding: 18px;
      box-shadow: var(--shadow);
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .cv-modal textarea {
      min-height: 240px;
      max-height: 55vh;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .photo-modal-card { width: min(720px, 92vw); }
    .photo-modal-card img {
      width: auto;
      max-width: 86vw;
      max-height: 70vh;
      border-radius: 14px;
      object-fit: contain;
      background: #fff;
      border: 1px solid var(--border);
    }
    .user-modal-card { width: min(780px, 92vw); }
    .user-modal-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }
    .user-meta {
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .user-avatar-lg {
      width: 64px;
      height: 64px;
      border-radius: 18px;
      background: #efe6d8;
      display: grid;
      place-items: center;
      font-weight: 700;
      color: var(--primary-dark);
      overflow: hidden;
      position: relative;
    }
    .user-avatar-lg img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: none;
    }
    .user-avatar-lg.has-img img { display: block; }
    .user-avatar-lg.has-img span { display: none; }
    .photo-tooltip {
      position: fixed;
      display: none;
      padding: 6px;
      background: #fff;
      border: 1px solid var(--border);
      border-radius: 14px;
      box-shadow: var(--shadow);
      z-index: 12;
    }
    .photo-tooltip img {
      width: 140px;
      height: 140px;
      border-radius: 10px;
      object-fit: cover;
      display: block;
    }
    .login-title { font-size: 22px; font-weight: 700; font-family: "Space Grotesk", sans-serif; }
    .login-sub { color: var(--muted); font-size: 14px; }
    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @media (max-width: 980px) {
      .app { flex-direction: column; }
      .sidebar-overlay { display: block; }
      .sidebar {
        position: fixed;
        inset: 0 auto 0 0;
        height: 100dvh;
        width: min(82vw, 320px);
        max-width: 320px;
        transform: translateX(-104%);
        transition: transform 0.2s ease;
        z-index: 20;
        overflow-y: auto;
        -webkit-overflow-scrolling: touch;
        box-shadow: 0 20px 40px rgba(14, 20, 24, 0.35);
      }
      .sidebar.collapsed {
        width: min(82vw, 320px);
        flex-basis: auto;
        padding: 24px;
        align-items: stretch;
        transform: translateX(-104%);
      }
      .sidebar:not(.collapsed) { transform: translateX(0); }
      .content { padding: 18px 16px 40px; }
      .mobile-bar { display: flex; }
      .portal-layout { grid-template-columns: 1fr; }
      .user-form-grid { grid-template-columns: 1fr; }
      .user-hero { flex-direction: column; align-items: flex-start; }
      .user-roles { justify-content: flex-start; }
    }
    @media (max-width: 820px) {
      .sidebar { padding: 20px; }
      .panel-toggle { display: inline-flex; align-items: center; gap: 6px; }
      .content-header { align-items: flex-start; }
      .header-actions { width: 100%; justify-content: flex-start; flex-wrap: wrap; }
      .panel { padding: 18px; }
      .grid { grid-template-columns: 1fr; }
      .inline { align-items: stretch; }
      .view-switch { display: flex; width: 100%; }
      .view-switch button { flex: 1; text-align: center; }
      .swipe-row { grid-template-columns: 96px minmax(0, 1fr); }
      .table-wrapper { max-height: none; }
    }
    @media (max-width: 760px) {
      .table-wrapper { overflow: visible; }
      .cv-table, .results-table { border-collapse: separate; }
      .cv-table thead, .results-table thead { display: none; }
      .cv-table tbody, .results-table tbody { display: block; }
      .cv-table tbody tr, .results-table tbody tr {
        display: block;
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 18px;
        padding: 4px 2px;
        margin-bottom: 12px;
        box-shadow: var(--shadow);
      }
      .cv-table tbody tr.is-new, .results-table tbody tr.is-new {
        border-color: rgba(27, 122, 140, 0.55);
        box-shadow: 0 0 0 2px rgba(27, 122, 140, 0.18), var(--shadow);
      }
      .cv-table tbody tr td, .results-table tbody tr td {
        display: grid;
        grid-template-columns: 112px minmax(0, 1fr);
        gap: 8px;
        padding: 8px 10px;
        border-bottom: 1px solid rgba(228, 218, 200, 0.65);
        background: transparent !important;
        align-items: center;
      }
      .cv-table tbody tr td:last-child, .results-table tbody tr td:last-child { border-bottom: none; }
      .cv-table tbody tr td::before, .results-table tbody tr td::before {
        content: attr(data-label);
        font-size: 10.5px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--muted);
        font-weight: 700;
      }
      .cv-table tbody tr td[data-label=""]::before,
      .results-table tbody tr td[data-label=""]::before { content: ""; }
      .cv-table tbody tr:nth-child(even) td,
      .results-table tbody tr:nth-child(even) td { background: transparent !important; }
      .candidate-wrap { gap: 8px; }
      .candidate-name {
        font-size: 15px;
        font-weight: 800;
        max-width: none;
      }
      .candidate-avatar {
        width: 36px;
        height: 36px;
        border-radius: 12px;
        flex-basis: 36px;
      }
      .action-stack { justify-content: flex-start; flex-wrap: wrap; }
      .decision-buttons { flex-wrap: wrap; }
      .decision-cell { white-space: normal; }
      .cell-compact {
        white-space: normal;
        max-width: none;
      }
      .summary-cell {
        max-width: none;
        -webkit-line-clamp: 3;
      }
      .audio-player {
        width: 100%;
        min-width: 0;
        flex-wrap: wrap;
        gap: 6px 8px;
        border-radius: 16px;
        padding: 8px 10px;
      }
      .audio-play {
        width: 36px;
        height: 36px;
        order: 1;
        font-size: 14px;
      }
      .audio-time {
        order: 2;
        margin-left: auto;
        min-width: 0;
        font-weight: 800;
        color: var(--ink);
        text-align: right;
      }
      .audio-progress {
        order: 10;
        flex: 1 1 100%;
        width: 100%;
        min-width: 0;
        margin-top: 2px;
      }
      .audio-menu,
      .audio-download {
        order: 20;
        flex: 1 1 calc(50% - 6px);
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .audio-menu-btn,
      .audio-download {
        width: 32px;
        height: 32px;
      }
      .results-table tbody tr.detail-row {
        display: block;
        background: transparent;
        border: none;
        box-shadow: none;
        padding: 0;
        margin: -8px 0 12px;
      }
      .results-table tbody tr.detail-row td {
        display: block;
        padding: 6px 4px 0;
        border-bottom: none;
        background: transparent !important;
      }
      .results-table tbody tr.detail-row td::before { content: ""; }
      .results-table tbody tr.detail-row .detail-card {
        border-top: none;
        border-radius: 0 0 18px 18px;
        padding: 14px;
        box-shadow: var(--shadow);
      }
      .results-table tbody tr.row-clickable.expanded {
        margin-bottom: 0;
        border-radius: 18px 18px 8px 8px;
      }
      .results-table tbody tr.row-clickable.expanded td:last-child { border-bottom: none; }
      .results-table tbody tr.detail-row .detail-grid {
        grid-template-columns: 1fr;
        gap: 8px;
      }
      .results-table tbody tr.detail-row .detail-item { font-size: 13px; }
      .results-table tbody tr.detail-row .detail-label { font-size: 10px; }
      .results-table tbody tr.detail-row .detail-block { padding: 10px 0; }
      .cv-table tbody tr td[data-label="Candidato"],
      .results-table tbody tr td[data-label="Candidato"] {
        order: -12;
        grid-template-columns: 1fr;
        align-items: flex-start;
        padding-top: 8px;
        padding-bottom: 10px;
      }
      .cv-table tbody tr td[data-label="Candidato"]::before,
      .results-table tbody tr td[data-label="Candidato"]::before { content: ""; }
      .results-table tbody tr td[data-label="Score"] { display: none; }
      .results-table tbody tr td[data-label="Fecha"] { order: -10; }
      .results-table tbody tr td[data-label="Local"] { order: -9; }
      .results-table tbody tr td[data-label="Posición"] { order: -8; }
      .results-table .candidate-wrap {
        justify-content: space-between;
        align-items: flex-start;
        gap: 10px;
      }
      .results-table .candidate-name {
        flex: 1 1 auto;
        min-width: 0;
        white-space: normal;
        overflow: visible;
        text-overflow: clip;
        word-break: break-word;
      }
      .results-table .candidate-score-pill {
        display: inline-flex;
        margin-left: 8px;
        flex: 0 0 auto;
      }
      .cv-table tbody tr td[data-label="Decisión"],
      .results-table tbody tr td[data-label="Decisión"],
      .cv-table tbody tr td[data-label="Acción"],
      .results-table tbody tr td[data-label="Acción"],
      .results-table tbody tr td[data-label="Audio"],
      .cv-table tbody tr td[data-label="CV"],
      .results-table tbody tr td[data-label="CV"] {
        grid-template-columns: 1fr;
        align-items: flex-start;
      }
      .action-stack { gap: 8px; }
      .action-stack > button,
      .action-stack > a {
        flex: 1 1 calc(50% - 6px);
        justify-content: center;
        text-align: center;
      }
      .decision-buttons { gap: 8px; }
      .decision-buttons .decision-btn {
        flex: 1 1 calc(33.333% - 6px);
        min-width: 0;
      }
      .results-table .audio-player {
        width: 100%;
        min-width: 0;
      }
      .results-table .audio-progress {
        flex: 1;
        min-width: 96px;
      }
      #cv-tabs, #results-tabs, #results-decision-tabs {
        display: flex;
        flex-wrap: nowrap;
        gap: 8px;
        overflow-x: auto;
        padding-bottom: 4px;
        -webkit-overflow-scrolling: touch;
        scrollbar-width: none;
      }
      #cv-tabs::-webkit-scrollbar,
      #results-tabs::-webkit-scrollbar,
      #results-decision-tabs::-webkit-scrollbar { display: none; }
      #cv-tabs .tab-pill,
      #results-tabs .tab-pill,
      #results-decision-tabs .tab-pill { flex: 0 0 auto; }
      .swipe-card {
        border-radius: 20px;
        padding: 16px;
        animation: swipe-pop 240ms ease-out, swipe-float 4.6s ease-in-out 320ms infinite;
      }
      .swipe-card:active { animation-play-state: paused; }
      .swipe-meta { font-weight: 700; }
      .swipe-section {
        border-top: none;
        padding-top: 4px;
        margin-top: 2px;
        gap: 8px;
      }
      .swipe-row {
        grid-template-columns: 1fr;
        gap: 2px;
        align-items: flex-start;
      }
      .swipe-label { font-size: 10px; opacity: 0.72; }
      .swipe-value { font-size: 14.25px; font-weight: 700; }
      .swipe-top { align-items: flex-start; }
    }
    @media (max-width: 640px) {
      body { font-size: 14px; }
      .content { padding: 16px; }
      .panel { padding: 16px; border-radius: 16px; }
      .panel-title { font-size: 16px; }
      .tab-pill { padding: 6px 10px; }
      .swipe-card { padding: 14px; border-radius: 18px; }
      .swipe-row { grid-template-columns: 1fr; }
      .swipe-title { font-size: 15px; }
      .swipe-avatar { width: 64px; height: 64px; border-radius: 16px; flex-basis: 64px; }
      th, td { padding: 8px 10px; font-size: 11.5px; }
      .audio-player { gap: 6px 8px; }
      .audio-time { font-size: 11px; }
      .detail-grid { grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
    }
    @media (max-width: 520px) {
      .brand-mark { font-size: 16px; }
      .brand-sub { font-size: 10px; }
      .nav-item { padding: 8px 10px; }
      .nav-label { font-size: 12px; }
      .brand-list { max-height: 200px; overflow-y: auto; }
      .icon-btn { width: 36px; height: 36px; }
      .btn-compact { padding: 6px 8px; }
      .candidate-cell { max-width: 180px; }
      .candidate-name { max-width: 140px; }
    }
  </style>
</head>
<body>
  <div id="login-screen" class="login-screen">
    <div class="login-card">
      <div class="login-title">HRBOT Console</div>
      <div class="login-sub">Elegí cómo entrar.</div>
      <div class="login-tabs">
        <button class="login-tab active" id="login-mode-admin" type="button">Admin key</button>
        <button class="login-tab" id="login-mode-viewer" type="button">User login</button>
      </div>
      <div id="login-admin-fields" class="login-fields">
        <div>
          <label>Clave</label>
          <input type="password" id="login-token" placeholder="ADMIN / YB key" />
        </div>
      </div>
      <div id="login-viewer-fields" class="login-fields" style="display:none;">
        <div>
          <label>Email</label>
          <input type="text" id="login-email" placeholder="user@empresa.com" />
        </div>
        <div>
          <label>Password</label>
          <input type="password" id="login-password" placeholder="********" />
        </div>
      </div>
      <div class="row inline" style="justify-content: space-between;">
        <button id="login-btn">Entrar</button>
        <span class="status" id="login-status"></span>
      </div>
    </div>
  </div>

  <div id="app" class="app" style="display:none;">
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-brand">
        <div class="brand-title">
          <div class="brand-mark">HRBOT</div>
          <div class="brand-sub">Hiring control center</div>
        </div>
        <button class="sidebar-toggle" id="sidebar-toggle" type="button" title="Minimizar menú">|||</button>
      </div>
      <nav class="nav">
        <button class="nav-item" id="nav-general" type="button" title="General">
          <span class="nav-icon">G</span>
          <span class="nav-label">General</span>
        </button>
        <button class="nav-item" id="nav-calls" type="button" title="Candidates">
          <span class="nav-icon">C</span>
          <span class="nav-label">Candidates</span>
          <span class="nav-badge" id="nav-calls-badge"></span>
        </button>
        <button class="nav-item" id="nav-interviews" type="button" title="Interviews">
          <span class="nav-icon">I</span>
          <span class="nav-label">Interviews</span>
          <span class="nav-badge" id="nav-interviews-badge"></span>
        </button>
        <button class="nav-item" id="nav-portal" type="button" title="Portal">
          <span class="nav-icon">P</span>
          <span class="nav-label">Portal</span>
        </button>
        <div class="nav-section-title">Restaurantes</div>
        <div id="brand-list" class="brand-list"></div>
        <button class="secondary nav-add" id="add-brand" type="button" title="Nuevo local">+ Nuevo local</button>
      </nav>
    </aside>
    <div id="sidebar-overlay" class="sidebar-overlay"></div>

    <section class="content">
      <div class="mobile-bar">
        <button class="secondary icon-btn" id="mobile-menu" type="button" aria-label="Menú">☰</button>
        <div class="mobile-title" id="mobile-title">HRBOT</div>
        <span></span>
      </div>
      <div class="content-header">
        <div>
          <div class="eyebrow" id="view-label">Configuración</div>
          <h1 id="view-title">General</h1>
        </div>
        <div class="header-actions">
          <input type="hidden" id="token" />
          <button class="secondary" id="load" type="button">Reload</button>
          <button id="save" type="button">Save</button>
          <button class="secondary" id="user-panel-toggle" type="button">Perfil</button>
          <button class="secondary" id="logout" type="button" style="display:none;">Salir</button>
        </div>
      </div>
      <div class="status-line"><span id="status"></span></div>

      <section id="general-view" class="view">
        <div class="panel" style="--delay:.05s;">
          <div class="panel-title">Mensajes base</div>
          <div class="panel-sub">Personalizá los openers y reglas globales (podés usar {name}, {brand}, {role}).</div>
          <div class="grid">
            <div>
              <label>Mensaje inicial ES</label>
              <textarea id="opener-es" placeholder="Hola {name}, te llamo por una entrevista de trabajo en {brand} para {role}. ¿Tenés un minuto para hablar?"></textarea>
            </div>
            <div>
              <label>Mensaje inicial EN</label>
              <textarea id="opener-en" placeholder="Hi {name}, I'm calling about your application for {role} at {brand}. Do you have a minute to talk?"></textarea>
            </div>
            <div>
              <label>Notas de idioma / reglas</label>
              <textarea id="lang-rules" placeholder="Ej: si responde en inglés, mantener toda la entrevista en inglés."></textarea>
            </div>
            <div>
              <label>Checklist obligatoria</label>
              <textarea id="must-ask" placeholder="Ej: zona/logística, disponibilidad, salario, prueba, permanencia en Miami, inglés si aplica."></textarea>
            </div>
          </div>
          <div class="divider"></div>
          <div class="panel-title">System prompt</div>
          <div class="panel-sub">Solo editable con clave ADMIN.</div>
          <div class="prompt-split">
            <div class="prompt-col">
              <textarea id="system-prompt" class="system-prompt" placeholder="Dejá vacío para usar el prompt por defecto."></textarea>
              <div class="small">Placeholders: {name}, {brand}, {spoken_role}, {address}, {english_required}, {lang_name}, {opener_es}, {opener_en}, {opener}, {specific_questions}, {cv_hint}, {brand_notes}, {role_notes}, {must_ask_line}, {lang_rules_line}, {late_closing_rule_line}, {custom_question}, {first_name_or_blank}.</div>
          <div class="prompt-tools compact" id="prompt-tools">
            <div class="small">Templates y versiones</div>
            <div class="prompt-tools-row">
              <input type="text" id="prompt-template-name" placeholder="Nombre del template" />
              <button class="secondary btn-compact" id="prompt-template-save" type="button">Guardar</button>
            </div>
            <div class="prompt-tools-row">
              <select id="prompt-template-select"></select>
              <button class="secondary btn-compact" id="prompt-template-restore" type="button">Restaurar</button>
              <button class="secondary btn-compact" id="prompt-template-delete" type="button">Eliminar</button>
              <select id="prompt-history-select"></select>
              <button class="secondary btn-compact" id="prompt-history-restore" type="button">Restaurar versión</button>
            </div>
          </div>
            </div>
            <div class="prompt-col prompt-side">
              <div class="prompt-assistant-card">
                <div class="panel-title">Asistente IA</div>
                <div class="panel-sub">Pedile cambios al prompt y se aplican automáticamente.</div>
                <textarea id="prompt-assistant-input" placeholder="Ej: agregá una pregunta sobre papeles, sin ser invasivo."></textarea>
                <div class="inline">
                  <button class="secondary" id="prompt-assistant-run" type="button">Aplicar sugerencia</button>
                  <span class="small" id="prompt-assistant-status"></span>
                </div>
                <div class="prompt-preview" id="prompt-assistant-preview" style="display:none;"></div>
              </div>
            </div>
          </div>
          <div class="divider"></div>
          <div class="panel-title">Bloque obligatorio (editable)</div>
          <div class="panel-sub">Estos textos se usan cuando corresponde (inglés requerido / cierre tarde). Podés dejar el default o personalizar.</div>
          <div class="grid">
            <div>
              <label>Inglés - nivel (ES)</label>
              <textarea id="english-level-es"></textarea>
            </div>
            <div>
              <label>Inglés - nivel (EN)</label>
              <textarea id="english-level-en"></textarea>
            </div>
            <div>
              <label>Pregunta en inglés (ES)</label>
              <textarea id="english-check-es"></textarea>
            </div>
            <div>
              <label>Pregunta en inglés (EN)</label>
              <textarea id="english-check-en"></textarea>
            </div>
            <div>
              <label>Cierre tarde (ES)</label>
              <textarea id="late-closing-es"></textarea>
            </div>
            <div>
              <label>Cierre tarde (EN)</label>
              <textarea id="late-closing-en"></textarea>
            </div>
          </div>
          <div class="divider"></div>
          <div class="panel-title">Runtime (se inyecta al ejecutar)</div>
          <div class="panel-sub">Este bloque se agrega automáticamente a cada llamada, además del checklist obligatorio. Úsalo para reglas operativas del momento.</div>
          <textarea id="runtime-instructions" placeholder="Ej: preguntá si puede cubrir turnos de cierre o si maneja café manual."></textarea>
          <div class="small">Placeholders útiles: {brand}, {spoken_role}, {address}, {name}.</div>
          <div class="divider"></div>
          <div class="panel-title">Grabación / Consentimiento</div>
          <div class="panel-sub">Texto leído antes de iniciar la entrevista y para confirmar grabación. Podés usar {opener}, {brand}, {spoken_role}, {name}.</div>
          <div class="grid">
            <div>
              <label>Intro grabación (ES)</label>
              <textarea id="recording-intro-es"></textarea>
            </div>
            <div>
              <label>Intro grabación (EN)</label>
              <textarea id="recording-intro-en"></textarea>
            </div>
            <div>
              <label>Consentimiento (ES)</label>
              <textarea id="recording-consent-es"></textarea>
            </div>
            <div>
              <label>Consentimiento (EN)</label>
              <textarea id="recording-consent-en"></textarea>
            </div>
            <div>
              <label>Confirmación (ES)</label>
              <textarea id="recording-confirm-es"></textarea>
            </div>
            <div>
              <label>Confirmación (EN)</label>
              <textarea id="recording-confirm-en"></textarea>
            </div>
            <div>
              <label>No respuesta / cierre (ES)</label>
              <textarea id="recording-no-response-es"></textarea>
            </div>
            <div>
              <label>No respuesta / cierre (EN)</label>
              <textarea id="recording-no-response-en"></textarea>
            </div>
            <div>
              <label>Rechazo a grabación (ES)</label>
              <textarea id="recording-decline-es"></textarea>
            </div>
            <div>
              <label>Rechazo a grabación (EN)</label>
              <textarea id="recording-decline-en"></textarea>
            </div>
          </div>
          <div class="inline" style="margin-top:12px;">
            <div style="flex:1; min-width:220px;">
              <label>Clave ADMIN</label>
              <input type="password" id="admin-token" placeholder="ADMIN" />
            </div>
            <div style="margin-top:20px;">
              <button class="secondary" id="admin-unlock" type="button">Unlock</button>
            </div>
            <span class="small" id="admin-status"></span>
          </div>
        </div>
        <div class="panel user-panel" id="users-panel" style="--delay:.07s;">
          <div class="user-hero">
            <div>
              <div class="user-kicker">Control de acceso</div>
              <div class="user-title">Usuarios</div>
              <div class="user-sub">Administrá accesos por rol y locales. Creá cuentas seguras para que cada persona vea solo lo que necesita.</div>
            </div>
            <div class="user-roles">
              <span class="role-pill admin">Admin</span>
              <span class="role-pill interviewer">Interviewer</span>
              <span class="role-pill viewer">Viewer</span>
            </div>
          </div>

          <div class="user-form-grid">
            <div class="user-card">
              <div class="user-card-title">Datos de acceso</div>
              <div class="user-card-sub">Email, clave y rol para la cuenta.</div>
              <div class="grid user-grid">
                <div>
                  <label>Email</label>
                  <input type="text" id="user-email" placeholder="usuario@empresa.com" />
                </div>
                <div>
                  <label>Password</label>
                  <input type="password" id="user-password" placeholder="********" />
                  <div class="small">En edición, dejalo vacío para mantener la clave actual.</div>
                </div>
                <div>
                  <label>Rol</label>
                  <select id="user-role">
                    <option value="admin">Admin</option>
                    <option value="interviewer">Interviewer</option>
                    <option value="viewer">Viewer</option>
                  </select>
                </div>
                <div>
                  <label>Activo</label>
                  <div class="check-row">
                    <input type="checkbox" id="user-active" checked />
                    <span class="small">Puede iniciar sesión.</span>
                  </div>
                </div>
              </div>
            </div>

            <div class="user-card">
              <div class="user-card-title">Permisos por local</div>
              <div class="user-card-sub">Seleccioná los locales a los que tendrá acceso.</div>
              <div id="user-brand-list" class="user-brand-list"></div>
              <div class="user-tip">Si no seleccionás ninguno, accede a todos.</div>
            </div>
          </div>

          <div class="user-footer">
            <div class="user-actions">
              <button id="user-save" type="button">Guardar usuario</button>
              <button class="secondary" id="user-clear" type="button">Limpiar</button>
            </div>
            <span class="user-status" id="user-status"></span>
          </div>

          <div class="divider"></div>
          <div class="user-list-head">
            <div class="user-list-title">Usuarios cargados</div>
          </div>
          <div class="table-wrapper">
            <table class="user-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Rol</th>
                  <th>Locales</th>
                  <th>Activo</th>
                  <th>Acción</th>
                </tr>
              </thead>
              <tbody id="user-table-body"></tbody>
            </table>
          </div>
        </div>
        <div class="panel" style="--delay:.08s;">
          <div class="panel-title">FAQ / Ayuda</div>
          <div class="panel-sub">Guía rápida y definiciones de cada sección y botón.</div>
          <div class="faq-list">
            <details class="faq-item">
              <summary>¿Qué hacen los botones Reload y Save?</summary>
              <div class="faq-body">
                Reload vuelve a cargar la configuración desde la base de datos y descarta cambios locales no guardados.
                Save guarda todo lo que editaste en esta pantalla (marcas, roles, preguntas, alias y textos base).
              </div>
            </details>
            <details class="faq-item">
              <summary>¿Qué es la Clave ADMIN y Unlock?</summary>
              <div class="faq-body">
                La clave ADMIN desbloquea la edición del System Prompt. Sin esa clave, el prompt queda en modo lectura.
                El resto de la configuración (marcas, roles, preguntas) se puede editar sin la clave.
              </div>
            </details>
            <details class="faq-item">
              <summary>System Prompt, Asistente IA y Templates</summary>
              <div class="faq-body">
                El System Prompt define el comportamiento principal del bot. El Asistente IA edita ese prompt automáticamente
                cuando le pedís cambios. Templates y versiones guardan snapshots del prompt para volver atrás rápido.
              </div>
            </details>
            <details class="faq-item">
              <summary>Bloque obligatorio (editable)</summary>
              <div class="faq-body">
                Es un bloque que se agrega automáticamente a cada llamada cuando corresponde (inglés requerido o cierre tarde).
                Podés editar los textos de inglés (nivel + pregunta) y cierre tarde desde General.
              </div>
            </details>
            <details class="faq-item">
              <summary>Runtime (se inyecta al ejecutar)</summary>
              <div class="faq-body">
                Es un bloque adicional que se agrega al final del prompt en cada llamada. Úsalo para reglas del momento
                (por ejemplo: “preguntá si puede cubrir turnos de cierre esta semana”).
              </div>
            </details>
            <details class="faq-item">
              <summary>Grabación / Consentimiento</summary>
              <div class="faq-body">
                Son los textos que el bot dice antes de empezar la entrevista para pedir permiso de grabación
                (intro, consentimiento, confirmación, rechazo y no respuesta).
              </div>
            </details>
            <details class="faq-item">
              <summary>Brand (clave) y Nombre para mostrar</summary>
              <div class="faq-body">
                Brand (clave) es el identificador interno. Se usa para matchear el local con pedidos, filtrar entrevistas y
                resolver direcciones. Nombre para mostrar es lo que ve el equipo en el menú y en los listados.
              </div>
            </details>
            <details class="faq-item">
              <summary>¿Para qué sirven Aliases (local y rol)?</summary>
              <div class="faq-body">
                Aliases son formas alternativas en las que el local o la posición pueden aparecer (ej: “yes cafe”, “yes pizza”).
                El bot los usa para detectar y unificar nombres, y evita duplicados en reportes.
              </div>
            </details>
            <details class="faq-item">
              <summary>Dirección, Logo y “Mostrar en menú”</summary>
              <div class="faq-body">
                Dirección se usa en el prompt cuando se menciona el local. Logo aparece en el menú lateral.
                Si desactivás “Mostrar en menú”, el local queda oculto del menú y filtros pero sigue en la configuración.
              </div>
            </details>
            <details class="faq-item">
              <summary>Rol (clave), Inglés requerido y Físico</summary>
              <div class="faq-body">
                Rol (clave) es el identificador interno del puesto. Inglés requerido fuerza preguntas de inglés.
                Físico indica si el trabajo es físicamente exigente y ajusta el prompt y preguntas.
              </div>
            </details>
            <details class="faq-item">
              <summary>Preguntas específicas y Notas de rol</summary>
              <div class="faq-body">
                Las preguntas específicas se agregan a la entrevista para ese rol.
                Notas de rol son contexto interno que el bot usa para guiar la conversación.
              </div>
            </details>
            <details class="faq-item">
              <summary>Preview instrucciones</summary>
              <div class="faq-body">
                Genera un prompt de ejemplo con datos ficticios para revisar cómo se verá la entrevista antes de llamar.
              </div>
            </details>
            <details class="faq-item">
              <summary>Sección Candidates (CVs)</summary>
              <div class="faq-body">
                Subís un CV (PDF o foto). El sistema hace OCR y completa nombre/teléfono si lo detecta.
                Guardar CV lo almacena sin llamar. Llamar inicia la entrevista con ese CV.
                Limpiar borra los datos cargados para empezar de cero.
              </div>
            </details>
            <details class="faq-item">
              <summary>CVs guardados y acciones</summary>
              <div class="faq-body">
                Podés filtrar por local o buscar por nombre/teléfono.
                “Ver CV” abre el PDF o la imagen del CV.
                “Llamar” inicia la primera llamada y “Volver a llamar” reintenta.
                “Ver entrevista” te lleva al listado de entrevistas filtrado por ese candidato.
              </div>
            </details>
            <details class="faq-item">
              <summary>Listado de Interviews</summary>
              <div class="faq-body">
                Filtrás por local, posición, recomendación y puntaje.
                El resumen muestra el resultado o, si la llamada fue incompleta,
                el estado (no contestó, colgó, no aceptó grabación, etc.).
                El audio tiene controles de velocidad.
              </div>
            </details>
          </div>
        </div>
      </section>

      <section id="calls-view" class="view" style="display:none;">
        <div class="panel" id="call-panel" style="--delay:.06s;">
          <div class="panel-title">Subir CVs y llamar</div>
          <div class="panel-sub">Adjuntá un CV (PDF o foto), completá datos y lanzá la llamada.</div>
          <div class="grid">
            <div>
              <label>Local</label>
              <select id="call-brand"></select>
            </div>
            <div>
              <label>Posición</label>
              <select id="call-role"></select>
            </div>
            <div>
              <label>Nombre candidato</label>
              <input type="text" id="call-name" placeholder="Nombre y apellido" />
            </div>
            <div>
              <label>Teléfono</label>
              <input type="text" id="call-phone" placeholder="+1 305..." />
            </div>
          </div>
          <div class="grid" style="margin-top:12px;">
            <div>
              <label>CV (PDF, imagen o TXT)</label>
              <div id="cv-drop" class="drop-zone">
                <div class="drop-icon">CV</div>
                <div>
                  <div><strong>Arrastrá el archivo</strong></div>
                  <div class="small">Lee PDF, imagen o TXT y usa OCR si hace falta.</div>
                </div>
                <input type="file" id="cv-file" class="drop-file" accept=".pdf,.txt,image/*" />
              </div>
              <div class="small" id="cv-status"></div>
            </div>
            <div>
              <label>CV extraído</label>
              <textarea id="call-cv-text" placeholder="Acá vas a ver el texto leído del CV."></textarea>
              <div class="small">Podés editar el texto antes de llamar.</div>
            </div>
          </div>
          <div class="inline" style="margin-top:12px;">
            <button class="secondary" id="cv-save-btn" type="button">Guardar CV</button>
            <button class="secondary" id="call-clear" type="button">Limpiar</button>
            <button id="call-btn" type="button">Llamar</button>
            <span class="small" id="call-status"></span>
          </div>
        </div>

        <div class="panel" id="cv-list-panel" style="--delay:.08s;">
      <div class="panel-title">CVs guardados</div>
      <div class="panel-sub">Podés guardar CVs sin llamar y usarlos después.</div>
          <div class="view-switch" id="cv-view-switch">
            <button type="button" data-mode="table" class="active">Tabla</button>
            <button type="button" data-mode="swipe">Swipe</button>
          </div>
          <div id="cv-filters" class="panel-filters">
            <div class="grid">
              <div>
                <label>Local</label>
                <select id="cv-filter-brand"></select>
              </div>
              <div>
                <label>Buscar</label>
                <input type="text" id="cv-filter-search" placeholder="Nombre o teléfono" />
              </div>
              <div style="display:flex; align-items:flex-end;">
                <button class="secondary" id="cv-refresh" type="button">Refresh</button>
              </div>
            </div>
            <div class="inline" id="cv-tabs" style="margin-top:8px;">
              <button class="tab-pill active" data-filter="no_calls" type="button">No llamados</button>
              <button class="tab-pill" data-filter="no_answer" type="button">No contestaron</button>
              <button class="tab-pill" data-filter="interviewed" type="button">Entrevistados</button>
              <button class="tab-pill" data-filter="all" type="button">Todos</button>
            </div>
          </div>
          <div class="table-wrapper" id="cv-table-wrapper" style="margin-top:10px;">
            <table class="cv-table">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Local</th>
                  <th>Posición</th>
                  <th>Candidato</th>
                  <th>Teléfono</th>
                  <th>Estado</th>
                  <th>Decisión</th>
                  <th>CV</th>
                  <th>Acción</th>
                </tr>
              </thead>
              <tbody id="cv-list-body"></tbody>
            </table>
          </div>
          <div class="swipe-view" id="cv-swipe-view" style="display:none;">
            <div class="swipe-meta">
              <div id="cv-swipe-count">0 / 0</div>
              <div class="swipe-hint">Deslizá para cambiar</div>
            </div>
            <div class="swipe-card" id="cv-swipe-card"></div>
            <div class="swipe-controls">
              <button class="secondary" type="button" id="cv-swipe-prev">Anterior</button>
              <button class="secondary" type="button" id="cv-swipe-next">Siguiente</button>
            </div>
          </div>
          <div class="small" id="cv-list-count" style="margin-top:8px;"></div>
        </div>
      </section>

      <section id="interviews-view" class="view" style="display:none;">
        <div class="panel" id="results-panel" style="--delay:.06s;">
          <div class="panel-title">Entrevistas</div>
          <div class="panel-sub">Listado general con filtros por local, posición y score.</div>
          <div class="view-switch" id="results-view-switch">
            <button type="button" data-mode="table" class="active">Tabla</button>
            <button type="button" data-mode="swipe">Swipe</button>
          </div>
          <div id="results-filters" class="panel-filters">
            <div class="grid">
              <div>
                <label>Local</label>
                <select id="results-brand"></select>
              </div>
              <div>
                <label>Posición</label>
                <select id="results-role"></select>
              </div>
              <div>
                <label>Recomendación</label>
                <select id="results-rec">
                  <option value="">Todas</option>
                  <option value="advance">Avanzar</option>
                  <option value="review">Revisar</option>
                  <option value="reject">No avanzar</option>
                </select>
              </div>
              <div>
                <label>Puntaje mín.</label>
                <input type="text" id="results-score-min" placeholder="0" />
              </div>
              <div>
                <label>Puntaje máx.</label>
                <input type="text" id="results-score-max" placeholder="100" />
              </div>
              <div>
                <label>Buscar</label>
                <div class="inline">
                  <input type="text" id="results-search" placeholder="Nombre o teléfono" />
                  <button class="secondary icon-btn" id="results-refresh" type="button" aria-label="Refresh" title="Refresh">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                      <polyline points="21 3 21 9 15 9" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
            <div class="inline" id="results-tabs" style="margin-top:8px;">
              <button class="tab-pill active" data-filter="completed" type="button">Completadas</button>
              <button class="tab-pill" data-filter="no_answer" type="button">No contestaron</button>
              <button class="tab-pill" data-filter="all" type="button">Todas</button>
            </div>
            <div class="inline" id="results-decision-tabs" style="margin-top:8px;">
              <button class="tab-pill active" data-decision="all" type="button">Todas</button>
              <button class="tab-pill" data-decision="approved" type="button">Aprobados</button>
              <button class="tab-pill" data-decision="maybe" type="button">Indecisos</button>
              <button class="tab-pill" data-decision="declined" type="button">Descartados</button>
            </div>
          </div>
          <div class="table-wrapper" id="results-table-wrapper" style="margin-top:14px;">
            <table class="results-table">
              <thead>
                <tr>
                  <th>Score</th>
                  <th>Fecha</th>
                  <th>Local</th>
                  <th>Posición</th>
                  <th>Candidato</th>
                  <th>Teléfono</th>
                  <th>Estado</th>
                  <th>Decisión</th>
                  <th>CV</th>
                  <th>Audio</th>
                  <th>Acción</th>
                </tr>
              </thead>
              <tbody id="results-body"></tbody>
            </table>
          </div>
          <div class="swipe-view" id="results-swipe-view" style="display:none;">
            <div class="swipe-meta">
              <div id="results-swipe-count">0 / 0</div>
              <div class="swipe-hint">Deslizá para cambiar</div>
            </div>
            <div class="swipe-card" id="results-swipe-card"></div>
            <div class="swipe-controls">
              <button class="secondary" type="button" id="results-swipe-prev">Anterior</button>
              <button class="secondary" type="button" id="results-swipe-next">Siguiente</button>
            </div>
          </div>
          <div class="small" id="results-count" style="margin-top:8px;"></div>
        </div>
      </section>

      <section id="portal-view" class="view" style="display:none;">
        <div class="panel" style="--delay:.06s;">
          <div class="panel-title">Portal de aplicaciones</div>
          <div class="panel-sub">Creá páginas públicas por restaurante, editá diseño y preguntas.</div>
          <div class="portal-layout">
            <div class="portal-sidebar">
              <div class="inline" style="justify-content: space-between;">
                <strong>Páginas</strong>
                <button class="secondary" id="portal-new" type="button">Nuevo</button>
              </div>
              <div class="portal-list" id="portal-list"></div>
            </div>
            <div class="portal-form">
              <div class="portal-section">
                <div class="portal-section-head">
                  <div>
                    <div class="portal-section-title">Información general</div>
                    <div class="portal-section-sub">Slug, marca, idioma y URL pública.</div>
                  </div>
                </div>
                <div class="grid">
                  <div>
                    <label>Slug</label>
                    <input type="text" id="portal-slug" placeholder="ej. mexi-cafe" />
                  </div>
                  <div>
                    <label>Brand</label>
                    <input type="text" id="portal-brand" placeholder="Ej. Mexi Cafe" />
                  </div>
                  <div>
                    <label>Idioma default</label>
                    <select id="portal-lang">
                      <option value="es">ES</option>
                      <option value="en">EN</option>
                    </select>
                  </div>
                  <div>
                    <label>Activo</label>
                    <select id="portal-active">
                      <option value="true">Sí</option>
                      <option value="false">No</option>
                    </select>
                  </div>
                  <div>
                  <label>URL público</label>
                  <div class="portal-url-row">
                    <input type="text" id="portal-url" readonly />
                    <button class="secondary" id="portal-copy-url" type="button">Copiar</button>
                    <button class="secondary" id="portal-open-url" type="button">Abrir</button>
                  </div>
                </div>
                </div>
              </div>

              <div class="portal-section">
                <div class="portal-section-head">
                  <div>
                    <div class="portal-section-title">Contenido</div>
                    <div class="portal-section-sub">Títulos, descripción y mensaje final.</div>
                  </div>
                </div>
                <div class="portal-subhead">Hero principal</div>
                <div class="grid">
                  <div>
                    <label>Título (ES)</label>
                    <input id="portal-title-es" type="text" />
                  </div>
                  <div>
                    <label>Título (EN)</label>
                    <input id="portal-title-en" type="text" />
                  </div>
                  <div>
                    <label>Descripción (ES)</label>
                    <textarea id="portal-desc-es"></textarea>
                  </div>
                  <div>
                    <label>Descripción (EN)</label>
                    <textarea id="portal-desc-en"></textarea>
                  </div>
                </div>
                <div class="portal-subhead">Sección "Inside the team"</div>
                <div class="grid">
                  <div>
                    <label>Título lateral (ES)</label>
                    <input id="portal-side-title-es" type="text" />
                  </div>
                  <div>
                    <label>Título lateral (EN)</label>
                    <input id="portal-side-title-en" type="text" />
                  </div>
                  <div>
                    <label>Texto lateral (ES)</label>
                    <textarea id="portal-side-text-es"></textarea>
                  </div>
                  <div>
                    <label>Texto lateral (EN)</label>
                    <textarea id="portal-side-text-en"></textarea>
                  </div>
                  <div>
                    <label>Nota lateral (ES)</label>
                    <input id="portal-side-note-es" type="text" />
                  </div>
                  <div>
                    <label>Nota lateral (EN)</label>
                    <input id="portal-side-note-en" type="text" />
                  </div>
                </div>
                <div class="portal-subhead">Mensaje final</div>
                <div class="grid">
                  <div>
                    <label>Gracias (ES)</label>
                    <input id="portal-thanks-es" type="text" />
                  </div>
                  <div>
                    <label>Gracias (EN)</label>
                    <input id="portal-thanks-en" type="text" />
                  </div>
                </div>
              </div>

              <div class="portal-section">
                <div class="portal-section-head">
                  <div>
                    <div class="portal-section-title">Diseño</div>
                    <div class="portal-section-sub">Tipografías y paleta de colores.</div>
                  </div>
                </div>
                <div class="portal-subhead">Tipografía</div>
                <div class="grid">
                  <div>
                    <label>Preset de fonts</label>
                    <select id="portal-font-preset">
                      <option value="">Personalizado</option>
                      <option value="fraunces-manrope">Fraunces + Manrope</option>
                      <option value="spacegrotesk-dmsans">Space Grotesk + DM Sans</option>
                      <option value="playfair-sourcesans">Playfair Display + Source Sans 3</option>
                      <option value="cormorant-worksans">Cormorant Garamond + Work Sans</option>
                      <option value="abril-nunito">Abril Fatface + Nunito</option>
                      <option value="bebas-assistant">Bebas Neue + Assistant</option>
                    </select>
                  </div>
                  <div>
                    <label>Font Heading</label>
                    <input id="portal-font-heading" type="text" list="portal-font-list" />
                  </div>
                  <div>
                    <label>Font Body</label>
                    <input id="portal-font-body" type="text" list="portal-font-list" />
                  </div>
                  <div>
                    <label>Font URL</label>
                    <input id="portal-font-url" type="text" />
                  </div>
                </div>
                <div class="portal-subhead">Colores</div>
                <div class="grid">
                  <div>
                    <label>Primary Color</label>
                    <div class="portal-color-row">
                      <input id="portal-color-primary" type="text" />
                      <input id="portal-color-primary-picker" type="color" />
                    </div>
                  </div>
                  <div>
                    <label>Accent Color</label>
                    <div class="portal-color-row">
                      <input id="portal-color-accent" type="text" />
                      <input id="portal-color-accent-picker" type="color" />
                    </div>
                  </div>
                  <div>
                    <label>Background</label>
                    <div class="portal-color-row">
                      <input id="portal-color-bg" type="text" />
                      <input id="portal-color-bg-picker" type="color" />
                    </div>
                  </div>
                  <div>
                    <label>Card</label>
                    <div class="portal-color-row">
                      <input id="portal-color-card" type="text" />
                      <input id="portal-color-card-picker" type="color" />
                    </div>
                  </div>
                  <div>
                    <label>Text</label>
                    <div class="portal-color-row">
                      <input id="portal-color-text" type="text" />
                      <input id="portal-color-text-picker" type="color" />
                    </div>
                  </div>
                  <div>
                    <label>Muted</label>
                    <div class="portal-color-row">
                      <input id="portal-color-muted" type="text" />
                      <input id="portal-color-muted-picker" type="color" />
                    </div>
                  </div>
                </div>
              </div>

              <datalist id="portal-font-list">
                <option value="Fraunces"></option>
                <option value="Manrope"></option>
                <option value="Space Grotesk"></option>
                <option value="DM Sans"></option>
                <option value="Playfair Display"></option>
                <option value="Source Sans 3"></option>
                <option value="Cormorant Garamond"></option>
                <option value="Work Sans"></option>
                <option value="Abril Fatface"></option>
                <option value="Nunito"></option>
                <option value="Bebas Neue"></option>
                <option value="Assistant"></option>
              </datalist>

              <div class="portal-section">
                <div class="portal-section-head">
                  <div>
                    <div class="portal-section-title">Preview</div>
                    <div class="portal-section-sub">Vista rápida de la página pública.</div>
                  </div>
                </div>
                <div class="portal-preview" id="portal-preview">
                  <div class="portal-preview-hero">
                    <div>
                      <div class="portal-preview-pill">Now hiring</div>
                      <div class="portal-preview-brand-row">
                        <img class="portal-preview-logo" id="portal-preview-logo" alt="Logo" />
                        <div id="portal-preview-brand"></div>
                      </div>
                      <div class="portal-preview-title" id="portal-preview-title"></div>
                      <div class="portal-preview-desc" id="portal-preview-desc"></div>
                    </div>
                    <div class="portal-preview-hero-image" id="portal-preview-hero">Hero image</div>
                  </div>
                  <div class="portal-preview-grid">
                    <div class="portal-preview-card">
                      <div class="portal-preview-card-title">Apply now</div>
                      <div class="portal-preview-field">
                        <div class="portal-preview-field-label" id="portal-preview-name-label"></div>
                        <div class="portal-preview-field-input"></div>
                      </div>
                      <div class="portal-preview-field">
                        <div class="portal-preview-field-label" id="portal-preview-email-label"></div>
                        <div class="portal-preview-field-input"></div>
                      </div>
                      <div class="portal-preview-field">
                        <div class="portal-preview-field-label" id="portal-preview-phone-label"></div>
                        <div class="portal-preview-field-input"></div>
                      </div>
                      <div class="portal-preview-field">
                        <div class="portal-preview-field-label" id="portal-preview-role-label"></div>
                        <div class="portal-preview-field-input"></div>
                      </div>
                      <div class="portal-preview-field" id="portal-preview-location-field">
                        <div class="portal-preview-field-label" id="portal-preview-location-label"></div>
                        <div class="portal-preview-field-input portal-preview-field-list" id="portal-preview-location-input"></div>
                      </div>
                      <button class="portal-preview-btn" id="portal-preview-btn" type="button">Enviar postulacion</button>
                    </div>
                  <div class="portal-preview-card">
                    <div class="portal-preview-card-title" id="portal-preview-side-title">Inside the team</div>
                    <div class="portal-preview-desc" id="portal-preview-side"></div>
                    <div class="portal-preview-note" id="portal-preview-side-note"></div>
                    <div class="portal-preview-gallery" id="portal-preview-gallery"></div>
                  </div>
                </div>
              </div>
              </div>

              <div class="portal-section">
                <div class="portal-section-head">
                  <div>
                    <div class="portal-section-title">Assets</div>
                    <div class="portal-section-sub">Logo, hero, favicon y galería.</div>
                  </div>
                </div>
                <div class="grid">
                  <div>
                    <label>Logo URL</label>
                    <input id="portal-logo-url" type="text" />
                    <input id="portal-logo-file" type="file" accept="image/*" />
                  </div>
                  <div>
                    <label>Hero URL</label>
                    <input id="portal-hero-url" type="text" />
                    <input id="portal-hero-file" type="file" accept="image/*" />
                  </div>
                  <div>
                    <label>Favicon URL</label>
                    <input id="portal-favicon-url" type="text" />
                    <input id="portal-favicon-file" type="file" accept="image/*,.ico" />
                    <div class="small">Recomendado: PNG 512x512.</div>
                  </div>
                  <div>
                    <label>Gallery URLs (una por línea)</label>
                    <textarea id="portal-gallery-urls"></textarea>
                    <input id="portal-gallery-files" type="file" accept="image/*" multiple />
                  </div>
                </div>
              </div>

              <div class="portal-section">
                <div class="portal-section-head">
                  <div>
                    <div class="portal-section-title">Campos base</div>
                    <div class="portal-section-sub">Campos obligatorios y etiquetas del formulario.</div>
                  </div>
                </div>
                <div class="portal-subhead">Datos del candidato</div>
                <div class="grid">
                  <div>
                    <label>Nombre (ES)</label>
                    <input id="portal-name-es" type="text" />
                  </div>
                  <div>
                    <label>Nombre (EN)</label>
                    <input id="portal-name-en" type="text" />
                  </div>
                  <div class="check-row">
                    <input id="portal-name-required" type="checkbox" />
                    <span class="small">Requerido</span>
                  </div>
                </div>
                <div class="grid">
                  <div>
                    <label>Email (ES)</label>
                    <input id="portal-email-es" type="text" />
                  </div>
                  <div>
                    <label>Email (EN)</label>
                    <input id="portal-email-en" type="text" />
                  </div>
                  <div class="check-row">
                    <input id="portal-email-required" type="checkbox" />
                    <span class="small">Requerido</span>
                  </div>
                </div>
                <div class="grid">
                  <div>
                    <label>Teléfono (ES)</label>
                    <input id="portal-phone-es" type="text" />
                  </div>
                  <div>
                    <label>Teléfono (EN)</label>
                    <input id="portal-phone-en" type="text" />
                  </div>
                  <div class="check-row">
                    <input id="portal-phone-required" type="checkbox" />
                    <span class="small">Requerido</span>
                  </div>
                </div>
                <div class="portal-subhead">Rol</div>
                <div class="grid">
                  <div>
                    <label>Rol (ES)</label>
                    <input id="portal-role-es" type="text" />
                  </div>
                  <div>
                    <label>Rol (EN)</label>
                    <input id="portal-role-en" type="text" />
                  </div>
                  <div class="check-row">
                    <input id="portal-role-required" type="checkbox" />
                    <span class="small">Requerido</span>
                  </div>
                </div>
                <div class="grid">
                  <div>
                    <label>Opciones de rol (una por línea)</label>
                    <textarea id="portal-role-options"></textarea>
                  </div>
                </div>
              </div>

              <div class="portal-section">
                <div class="portal-section-head">
                  <div>
                    <div class="portal-section-title">Locaciones</div>
                    <div class="portal-section-sub">Selector y estilo de locaciones.</div>
                  </div>
                </div>
                <div class="grid">
                  <div>
                    <label>Locaciones (ES)</label>
                    <input id="portal-location-es" type="text" />
                  </div>
                  <div>
                    <label>Locations (EN)</label>
                    <input id="portal-location-en" type="text" />
                  </div>
                  <div class="check-row">
                    <input id="portal-location-required" type="checkbox" />
                    <span class="small">Requerido</span>
                  </div>
                  <div>
                    <label>Estilo</label>
                    <select id="portal-location-layout">
                      <option value="cards">Tarjetas</option>
                      <option value="chips">Chips</option>
                      <option value="compact">Compacto</option>
                      <option value="maps">Mini mapas</option>
                    </select>
                  </div>
                </div>
                <div class="portal-location-options" id="portal-location-options"></div>
                <div class="small" style="margin-top:4px;">Elegí las locaciones que aparecen en el portal público.</div>
              </div>

              <div class="portal-section">
                <div class="portal-section-head">
                  <div>
                    <div class="portal-section-title">Roles por locación</div>
                    <div class="portal-section-sub">Personalizá los roles disponibles por local.</div>
                  </div>
                </div>
                <div id="portal-role-location-list" class="grid"></div>
              </div>

              <div class="portal-section">
                <div class="portal-section-head">
                  <div>
                    <div class="portal-section-title">CV y foto</div>
                    <div class="portal-section-sub">Etiquetas y obligatoriedad de archivos.</div>
                  </div>
                </div>
                <div class="grid">
                  <div>
                    <label>CV (ES)</label>
                    <input id="portal-resume-es" type="text" />
                  </div>
                  <div>
                    <label>CV (EN)</label>
                    <input id="portal-resume-en" type="text" />
                  </div>
                  <div class="check-row">
                    <input id="portal-resume-required" type="checkbox" />
                    <span class="small">CV requerido</span>
                  </div>
                </div>
                <div class="grid">
                  <div>
                    <label>Foto (ES)</label>
                    <input id="portal-photo-es" type="text" />
                  </div>
                  <div>
                    <label>Foto (EN)</label>
                    <input id="portal-photo-en" type="text" />
                  </div>
                  <div class="check-row">
                    <input id="portal-photo-required" type="checkbox" />
                    <span class="small">Foto requerida</span>
                  </div>
                </div>
              </div>

              <div class="portal-section">
                <div class="portal-section-head">
                  <div>
                    <div class="portal-section-title">Preguntas</div>
                    <div class="portal-section-sub">Sumá preguntas personalizadas.</div>
                  </div>
                </div>
                <div id="portal-question-list" class="grid"></div>
                <button class="secondary" id="portal-add-question" type="button">+ Pregunta</button>
              </div>

              <div class="portal-section">
                <div class="portal-section-head">
                  <div>
                    <div class="portal-section-title">Acciones</div>
                    <div class="portal-section-sub">Guardar o eliminar este portal.</div>
                  </div>
                </div>
                <div class="row inline">
                  <button id="portal-save" type="button">Guardar portal</button>
                  <button class="secondary" id="portal-delete" type="button">Eliminar</button>
                  <span class="status" id="portal-status"></span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="panel" style="--delay:.08s;">
          <div class="panel-title">Postulaciones</div>
          <div class="panel-sub">Listado de candidatos que aplicaron desde el portal.</div>
          <div class="grid">
            <div>
              <label>Página</label>
              <select id="portal-app-filter"></select>
            </div>
            <div>
              <label>Locación</label>
              <select id="portal-app-location-filter"></select>
            </div>
            <div>
              <label>Acciones</label>
              <div class="inline">
                <button class="secondary" id="portal-app-refresh" type="button">Refresh</button>
                <button class="secondary" id="portal-app-export" type="button">Export CSV</button>
              </div>
            </div>
          </div>
          <div class="table-wrapper" style="margin-top:10px;">
            <table class="portal-table">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Página</th>
                  <th>Locaciones</th>
                  <th>Nombre</th>
                  <th>Email</th>
                  <th>Teléfono</th>
                  <th>Rol</th>
                  <th>CV</th>
                  <th>Foto</th>
                  <th>Respuestas</th>
                </tr>
              </thead>
              <tbody id="portal-app-body"></tbody>
            </table>
          </div>
          <div class="small" id="portal-app-count" style="margin-top:8px;"></div>
        </div>
      </section>

      <section id="brand-view" class="view" style="display:none;">
        <div class="panel" style="--delay:.06s;">
          <div class="panel-title">Preview instrucciones</div>
          <div class="panel-sub">Generá el prompt real con datos de ejemplo.</div>
          <div class="grid">
            <div>
              <label>Local</label>
              <input type="text" id="preview-brand" placeholder="Ej. Yes! Cafe & Pizza (MiMo / 79th St)" />
            </div>
            <div>
              <label>Posición</label>
              <input type="text" id="preview-role" placeholder="Ej. Cook / Cashier / Pizzero" />
            </div>
            <div>
              <label>Nombre candidato</label>
              <input type="text" id="preview-applicant" placeholder="Ej. Rafael Soto" />
            </div>
            <div>
              <label>Dirección</label>
              <input type="text" id="preview-address" placeholder="Se completa si hay en config" />
            </div>
            <div>
              <label>Inglés requerido</label>
              <select id="preview-english">
                <option value="auto">Auto (según config)</option>
                <option value="yes">Sí</option>
                <option value="no">No</option>
              </select>
            </div>
            <div>
              <label>Idioma</label>
              <select id="preview-lang">
                <option value="es">Español</option>
                <option value="en">English</option>
              </select>
            </div>
          </div>
          <div class="row">
            <label>Resumen CV (opcional)</label>
            <textarea id="preview-cv" placeholder="Pegá acá un resumen de CV para ver cómo lo usa."></textarea>
          </div>
          <div class="inline" style="justify-content: space-between;">
            <button class="secondary" id="preview-generate" type="button">Generate preview</button>
            <span class="small" id="preview-status"></span>
          </div>
          <div class="row">
            <label>Prompt generado</label>
            <textarea id="preview-output" class="preview-output" readonly></textarea>
          </div>
        </div>

        <div id="brands"></div>

      </section>
    </section>
  </div>
  <div id="user-modal" class="cv-modal">
    <div class="cv-modal-card user-modal-card">
      <div class="user-modal-head">
        <div>
          <div class="panel-title">Usuario</div>
          <div class="panel-sub" id="user-subtitle">Perfil y preferencias.</div>
        </div>
        <button class="secondary" id="user-modal-close" type="button">Cerrar</button>
      </div>
      <div class="user-meta">
        <div class="user-avatar-lg" id="user-avatar-wrap">
          <img id="user-avatar-img" alt="Avatar" />
          <span id="user-avatar-fallback">U</span>
        </div>
        <div class="user-meta-text">
          <div id="user-email-text" style="font-weight:700;"></div>
          <div class="small" id="user-role-text"></div>
        </div>
      </div>
      <div class="grid">
        <div>
          <label>Nueva contraseña</label>
          <input type="password" id="user-password-new" placeholder="********" />
        </div>
        <div>
          <label>Confirmar contraseña</label>
          <input type="password" id="user-password-confirm" placeholder="********" />
        </div>
      </div>
      <div class="row">
        <label>Foto de perfil</label>
        <div class="inline">
          <input type="file" id="user-photo-input" accept="image/*" />
          <button class="secondary" id="user-photo-clear" type="button">Quitar foto</button>
        </div>
      </div>
      <div class="row inline">
        <button id="user-save-profile" type="button">Guardar cambios</button>
        <button class="secondary" id="user-logout" type="button">Salir</button>
        <span class="status" id="user-profile-status"></span>
      </div>
      <div class="divider"></div>
      <div class="panel-title">Notificaciones</div>
      <div class="panel-sub">Recibí avisos cuando entra una nueva postulación del portal.</div>
      <div class="grid">
        <div>
          <label>Estado</label>
          <div class="status" id="push-status">Cargando...</div>
          <div class="small" id="push-detail"></div>
        </div>
        <div>
          <label>Acciones</label>
          <div class="inline">
            <button id="push-enable" type="button">Activar notificaciones</button>
            <button class="secondary" id="push-disable" type="button">Desactivar</button>
          </div>
          <div class="small">El navegador pedirá permiso la primera vez.</div>
        </div>
      </div>
    </div>
  </div>
  <div id="cv-modal" class="cv-modal">
    <div class="cv-modal-card">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
        <div style="font-weight:700;">CV</div>
        <button class="secondary" id="cv-modal-close" type="button">Cerrar</button>
      </div>
      <textarea id="cv-modal-text" readonly></textarea>
    </div>
  </div>
  <div id="cv-question-modal" class="cv-modal">
    <div class="cv-modal-card">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
        <div style="font-weight:700;">Pregunta personalizada</div>
        <button class="secondary" id="cv-question-close" type="button">Cerrar</button>
      </div>
      <div class="small" style="margin:6px 0 8px;">Se integra de forma natural en la llamada (no al inicio).</div>
      <textarea id="cv-question-text" placeholder="Ej: ¿Tenés disponibilidad para turnos de cierre?"></textarea>
      <div class="inline" style="justify-content:flex-end; margin-top:10px;">
        <button class="secondary" id="cv-question-clear" type="button">Limpiar</button>
        <button id="cv-question-save" type="button">Guardar</button>
        <span class="small" id="cv-question-status"></span>
      </div>
    </div>
  </div>
  <div id="interview-modal" class="cv-modal">
    <div class="cv-modal-card">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
        <div style="font-weight:700;">Entrevista</div>
        <button class="secondary" id="interview-modal-close" type="button">Cerrar</button>
      </div>
      <textarea id="interview-modal-text" readonly></textarea>
    </div>
  </div>
  <div id="photo-modal" class="cv-modal">
    <div class="cv-modal-card photo-modal-card">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
        <div style="font-weight:700;">Foto</div>
        <button class="secondary" id="photo-modal-close" type="button">Cerrar</button>
      </div>
      <img id="photo-modal-img" alt="Foto del CV" />
    </div>
  </div>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
  <script>
    const appEl = document.getElementById('app');
    const loginScreenEl = document.getElementById('login-screen');
    const loginTokenEl = document.getElementById('login-token');
    const loginEmailEl = document.getElementById('login-email');
    const loginPasswordEl = document.getElementById('login-password');
    const loginModeAdminEl = document.getElementById('login-mode-admin');
    const loginModeViewerEl = document.getElementById('login-mode-viewer');
    const loginAdminFieldsEl = document.getElementById('login-admin-fields');
    const loginViewerFieldsEl = document.getElementById('login-viewer-fields');
    const loginBtnEl = document.getElementById('login-btn');
    const loginStatusEl = document.getElementById('login-status');
    const sidebarEl = document.getElementById('sidebar');
    const sidebarToggleEl = document.getElementById('sidebar-toggle');
    const sidebarOverlayEl = document.getElementById('sidebar-overlay');
    const mobileMenuEl = document.getElementById('mobile-menu');
    const mobileTitleEl = document.getElementById('mobile-title');
    const statusEl = document.getElementById('status');
    const tokenEl = document.getElementById('token');
    const navGeneralEl = document.getElementById('nav-general');
    const navCallsEl = document.getElementById('nav-calls');
    const navInterviewsEl = document.getElementById('nav-interviews');
    const navPortalEl = document.getElementById('nav-portal');
    const navCallsBadgeEl = document.getElementById('nav-calls-badge');
    const navInterviewsBadgeEl = document.getElementById('nav-interviews-badge');
    const brandListEl = document.getElementById('brand-list');
    const addBrandEl = document.getElementById('add-brand');
    const viewTitleEl = document.getElementById('view-title');
    const viewLabelEl = document.getElementById('view-label');
    const generalViewEl = document.getElementById('general-view');
    const callsViewEl = document.getElementById('calls-view');
    const interviewsViewEl = document.getElementById('interviews-view');
    const portalViewEl = document.getElementById('portal-view');
    const brandViewEl = document.getElementById('brand-view');
    const loadBtnEl = document.getElementById('load');
    const saveBtnEl = document.getElementById('save');
    const logoutBtnEl = document.getElementById('logout');
    const userPanelToggleEl = document.getElementById('user-panel-toggle');
    const userModalEl = document.getElementById('user-modal');
    const userModalCloseEl = document.getElementById('user-modal-close');
    const userEmailTextEl = document.getElementById('user-email-text');
    const userRoleTextEl = document.getElementById('user-role-text');
    const userAvatarWrapEl = document.getElementById('user-avatar-wrap');
    const userAvatarImgEl = document.getElementById('user-avatar-img');
    const userAvatarFallbackEl = document.getElementById('user-avatar-fallback');
    const userPasswordNewEl = document.getElementById('user-password-new');
    const userPasswordConfirmEl = document.getElementById('user-password-confirm');
    const userPhotoInputEl = document.getElementById('user-photo-input');
    const userPhotoClearEl = document.getElementById('user-photo-clear');
    const userSaveProfileEl = document.getElementById('user-save-profile');
    const userProfileStatusEl = document.getElementById('user-profile-status');
    const userLogoutEl = document.getElementById('user-logout');
    const portalListEl = document.getElementById('portal-list');
    const portalNewEl = document.getElementById('portal-new');
    const portalSaveEl = document.getElementById('portal-save');
    const portalDeleteEl = document.getElementById('portal-delete');
    const portalStatusEl = document.getElementById('portal-status');
    const portalSlugEl = document.getElementById('portal-slug');
    const portalBrandEl = document.getElementById('portal-brand');
    const portalLangEl = document.getElementById('portal-lang');
    const portalActiveEl = document.getElementById('portal-active');
    const portalUrlEl = document.getElementById('portal-url');
    const portalCopyUrlEl = document.getElementById('portal-copy-url');
    const portalOpenUrlEl = document.getElementById('portal-open-url');
    const portalTitleEsEl = document.getElementById('portal-title-es');
    const portalTitleEnEl = document.getElementById('portal-title-en');
    const portalDescEsEl = document.getElementById('portal-desc-es');
    const portalDescEnEl = document.getElementById('portal-desc-en');
    const portalSideTitleEsEl = document.getElementById('portal-side-title-es');
    const portalSideTitleEnEl = document.getElementById('portal-side-title-en');
    const portalSideTextEsEl = document.getElementById('portal-side-text-es');
    const portalSideTextEnEl = document.getElementById('portal-side-text-en');
    const portalSideNoteEsEl = document.getElementById('portal-side-note-es');
    const portalSideNoteEnEl = document.getElementById('portal-side-note-en');
    const portalThanksEsEl = document.getElementById('portal-thanks-es');
    const portalThanksEnEl = document.getElementById('portal-thanks-en');
    const portalFontHeadingEl = document.getElementById('portal-font-heading');
    const portalFontBodyEl = document.getElementById('portal-font-body');
    const portalFontUrlEl = document.getElementById('portal-font-url');
    const portalFontPresetEl = document.getElementById('portal-font-preset');
    const portalColorPrimaryEl = document.getElementById('portal-color-primary');
    const portalColorPrimaryPickerEl = document.getElementById('portal-color-primary-picker');
    const portalColorAccentEl = document.getElementById('portal-color-accent');
    const portalColorAccentPickerEl = document.getElementById('portal-color-accent-picker');
    const portalColorBgEl = document.getElementById('portal-color-bg');
    const portalColorBgPickerEl = document.getElementById('portal-color-bg-picker');
    const portalColorCardEl = document.getElementById('portal-color-card');
    const portalColorCardPickerEl = document.getElementById('portal-color-card-picker');
    const portalColorTextEl = document.getElementById('portal-color-text');
    const portalColorTextPickerEl = document.getElementById('portal-color-text-picker');
    const portalColorMutedEl = document.getElementById('portal-color-muted');
    const portalColorMutedPickerEl = document.getElementById('portal-color-muted-picker');
    const portalLogoUrlEl = document.getElementById('portal-logo-url');
    const portalLogoFileEl = document.getElementById('portal-logo-file');
    const portalHeroUrlEl = document.getElementById('portal-hero-url');
    const portalHeroFileEl = document.getElementById('portal-hero-file');
    const portalFaviconUrlEl = document.getElementById('portal-favicon-url');
    const portalFaviconFileEl = document.getElementById('portal-favicon-file');
    const portalGalleryUrlsEl = document.getElementById('portal-gallery-urls');
    const portalGalleryFilesEl = document.getElementById('portal-gallery-files');
    const portalNameEsEl = document.getElementById('portal-name-es');
    const portalNameEnEl = document.getElementById('portal-name-en');
    const portalNameReqEl = document.getElementById('portal-name-required');
    const portalEmailEsEl = document.getElementById('portal-email-es');
    const portalEmailEnEl = document.getElementById('portal-email-en');
    const portalEmailReqEl = document.getElementById('portal-email-required');
    const portalPhoneEsEl = document.getElementById('portal-phone-es');
    const portalPhoneEnEl = document.getElementById('portal-phone-en');
    const portalPhoneReqEl = document.getElementById('portal-phone-required');
    const portalRoleEsEl = document.getElementById('portal-role-es');
    const portalRoleEnEl = document.getElementById('portal-role-en');
    const portalRoleReqEl = document.getElementById('portal-role-required');
    const portalRoleOptionsEl = document.getElementById('portal-role-options');
    const portalLocationEsEl = document.getElementById('portal-location-es');
    const portalLocationEnEl = document.getElementById('portal-location-en');
    const portalLocationReqEl = document.getElementById('portal-location-required');
    const portalLocationOptionsEl = document.getElementById('portal-location-options');
    const portalLocationLayoutEl = document.getElementById('portal-location-layout');
    const portalRoleLocationListEl = document.getElementById('portal-role-location-list');
    const portalResumeEsEl = document.getElementById('portal-resume-es');
    const portalResumeEnEl = document.getElementById('portal-resume-en');
    const portalResumeReqEl = document.getElementById('portal-resume-required');
    const portalPhotoEsEl = document.getElementById('portal-photo-es');
    const portalPhotoEnEl = document.getElementById('portal-photo-en');
    const portalPhotoReqEl = document.getElementById('portal-photo-required');
    const portalQuestionListEl = document.getElementById('portal-question-list');
    const portalAddQuestionEl = document.getElementById('portal-add-question');
    const portalAppFilterEl = document.getElementById('portal-app-filter');
    const portalAppLocationFilterEl = document.getElementById('portal-app-location-filter');
    const portalAppRefreshEl = document.getElementById('portal-app-refresh');
    const portalAppExportEl = document.getElementById('portal-app-export');
    const portalAppCountEl = document.getElementById('portal-app-count');
    const portalAppBodyEl = document.getElementById('portal-app-body');
    const portalPreviewEl = document.getElementById('portal-preview');
    const portalPreviewLogoEl = document.getElementById('portal-preview-logo');
    const portalPreviewBrandEl = document.getElementById('portal-preview-brand');
    const portalPreviewTitleEl = document.getElementById('portal-preview-title');
    const portalPreviewDescEl = document.getElementById('portal-preview-desc');
    const portalPreviewHeroEl = document.getElementById('portal-preview-hero');
    const portalPreviewNameLabelEl = document.getElementById('portal-preview-name-label');
    const portalPreviewEmailLabelEl = document.getElementById('portal-preview-email-label');
    const portalPreviewPhoneLabelEl = document.getElementById('portal-preview-phone-label');
    const portalPreviewRoleLabelEl = document.getElementById('portal-preview-role-label');
    const portalPreviewBtnEl = document.getElementById('portal-preview-btn');
    const portalPreviewSideTitleEl = document.getElementById('portal-preview-side-title');
    const portalPreviewSideEl = document.getElementById('portal-preview-side');
    const portalPreviewSideNoteEl = document.getElementById('portal-preview-side-note');
    const portalPreviewGalleryEl = document.getElementById('portal-preview-gallery');
    const portalPreviewLocationFieldEl = document.getElementById('portal-preview-location-field');
    const portalPreviewLocationLabelEl = document.getElementById('portal-preview-location-label');
    const portalPreviewLocationInputEl = document.getElementById('portal-preview-location-input');
    const portalFormEl = document.querySelector('#portal-view .portal-form');
    const brandsEl = document.getElementById('brands');
    const openerEsEl = document.getElementById('opener-es');
    const openerEnEl = document.getElementById('opener-en');
    const langRulesEl = document.getElementById('lang-rules');
    const mustAskEl = document.getElementById('must-ask');
    const systemPromptEl = document.getElementById('system-prompt');
    const englishLevelEsEl = document.getElementById('english-level-es');
    const englishLevelEnEl = document.getElementById('english-level-en');
    const englishCheckEsEl = document.getElementById('english-check-es');
    const englishCheckEnEl = document.getElementById('english-check-en');
    const lateClosingEsEl = document.getElementById('late-closing-es');
    const lateClosingEnEl = document.getElementById('late-closing-en');
    const runtimeInstructionsEl = document.getElementById('runtime-instructions');
    const recordingIntroEsEl = document.getElementById('recording-intro-es');
    const recordingIntroEnEl = document.getElementById('recording-intro-en');
    const recordingConsentEsEl = document.getElementById('recording-consent-es');
    const recordingConsentEnEl = document.getElementById('recording-consent-en');
    const recordingConfirmEsEl = document.getElementById('recording-confirm-es');
    const recordingConfirmEnEl = document.getElementById('recording-confirm-en');
    const recordingNoResponseEsEl = document.getElementById('recording-no-response-es');
    const recordingNoResponseEnEl = document.getElementById('recording-no-response-en');
    const recordingDeclineEsEl = document.getElementById('recording-decline-es');
    const recordingDeclineEnEl = document.getElementById('recording-decline-en');
    const promptTemplateNameEl = document.getElementById('prompt-template-name');
    const promptTemplateSaveEl = document.getElementById('prompt-template-save');
    const promptTemplateSelectEl = document.getElementById('prompt-template-select');
    const promptTemplateRestoreEl = document.getElementById('prompt-template-restore');
    const promptTemplateDeleteEl = document.getElementById('prompt-template-delete');
    const promptHistorySelectEl = document.getElementById('prompt-history-select');
    const promptHistoryRestoreEl = document.getElementById('prompt-history-restore');
    const promptAssistInputEl = document.getElementById('prompt-assistant-input');
    const promptAssistRunEl = document.getElementById('prompt-assistant-run');
    const promptAssistStatusEl = document.getElementById('prompt-assistant-status');
    const promptAssistPreviewEl = document.getElementById('prompt-assistant-preview');
    const adminTokenEl = document.getElementById('admin-token');
    const adminUnlockEl = document.getElementById('admin-unlock');
    const adminStatusEl = document.getElementById('admin-status');
    const pushEnableEl = document.getElementById('push-enable');
    const pushDisableEl = document.getElementById('push-disable');
    const pushStatusEl = document.getElementById('push-status');
    const pushDetailEl = document.getElementById('push-detail');
    const previewBrandEl = document.getElementById('preview-brand');
    const previewRoleEl = document.getElementById('preview-role');
    const previewApplicantEl = document.getElementById('preview-applicant');
    const previewAddressEl = document.getElementById('preview-address');
    const previewEnglishEl = document.getElementById('preview-english');
    const previewLangEl = document.getElementById('preview-lang');
    const previewCvEl = document.getElementById('preview-cv');
    const previewOutputEl = document.getElementById('preview-output');
    const previewStatusEl = document.getElementById('preview-status');
    const usersPanelEl = document.getElementById('users-panel');
    const userEmailEl = document.getElementById('user-email');
    const userPasswordEl = document.getElementById('user-password');
    const userRoleEl = document.getElementById('user-role');
    const userActiveEl = document.getElementById('user-active');
    const userBrandListEl = document.getElementById('user-brand-list');
    const userSaveEl = document.getElementById('user-save');
    const userClearEl = document.getElementById('user-clear');
    const userStatusEl = document.getElementById('user-status');
    const userTableBodyEl = document.getElementById('user-table-body');
    const callBrandEl = document.getElementById('call-brand');
    const callRoleEl = document.getElementById('call-role');
    const callNameEl = document.getElementById('call-name');
    const callPhoneEl = document.getElementById('call-phone');
    const callCvTextEl = document.getElementById('call-cv-text');
    const callBtnEl = document.getElementById('call-btn');
    const callStatusEl = document.getElementById('call-status');
    const callPanelEl = document.getElementById('call-panel');
    const cvSaveBtnEl = document.getElementById('cv-save-btn');
    const callClearEl = document.getElementById('call-clear');
    const cvDropEl = document.getElementById('cv-drop');
    const cvFileEl = document.getElementById('cv-file');
    const cvStatusEl = document.getElementById('cv-status');
    const cvFilterBrandEl = document.getElementById('cv-filter-brand');
    const cvFilterSearchEl = document.getElementById('cv-filter-search');
    const cvRefreshEl = document.getElementById('cv-refresh');
    const cvTabsEl = document.getElementById('cv-tabs');
    const cvListBodyEl = document.getElementById('cv-list-body');
    const cvListCountEl = document.getElementById('cv-list-count');
    const cvViewSwitchEl = document.getElementById('cv-view-switch');
    const cvTableWrapperEl = document.getElementById('cv-table-wrapper');
    const cvSwipeViewEl = document.getElementById('cv-swipe-view');
    const cvSwipeCardEl = document.getElementById('cv-swipe-card');
    const cvSwipeCountEl = document.getElementById('cv-swipe-count');
    const cvSwipePrevEl = document.getElementById('cv-swipe-prev');
    const cvSwipeNextEl = document.getElementById('cv-swipe-next');
    const cvModalEl = document.getElementById('cv-modal');
    const cvModalTextEl = document.getElementById('cv-modal-text');
    const cvModalCloseEl = document.getElementById('cv-modal-close');
    const cvQuestionModalEl = document.getElementById('cv-question-modal');
    const cvQuestionTextEl = document.getElementById('cv-question-text');
    const cvQuestionSaveEl = document.getElementById('cv-question-save');
    const cvQuestionClearEl = document.getElementById('cv-question-clear');
    const cvQuestionCloseEl = document.getElementById('cv-question-close');
    const cvQuestionStatusEl = document.getElementById('cv-question-status');
    const interviewModalEl = document.getElementById('interview-modal');
    const interviewModalTextEl = document.getElementById('interview-modal-text');
    const interviewModalCloseEl = document.getElementById('interview-modal-close');
    const photoModalEl = document.getElementById('photo-modal');
    const photoModalImgEl = document.getElementById('photo-modal-img');
    const photoModalCloseEl = document.getElementById('photo-modal-close');
    const resultsBrandEl = document.getElementById('results-brand');
    const resultsRoleEl = document.getElementById('results-role');
    const resultsRecEl = document.getElementById('results-rec');
    const resultsScoreMinEl = document.getElementById('results-score-min');
    const resultsScoreMaxEl = document.getElementById('results-score-max');
    const resultsSearchEl = document.getElementById('results-search');
    const resultsRefreshEl = document.getElementById('results-refresh');
    const resultsTabsEl = document.getElementById('results-tabs');
    const resultsDecisionTabsEl = document.getElementById('results-decision-tabs');
    const resultsBodyEl = document.getElementById('results-body');
    const resultsCountEl = document.getElementById('results-count');
    const resultsViewSwitchEl = document.getElementById('results-view-switch');
    const resultsTableWrapperEl = document.getElementById('results-table-wrapper');
    const resultsSwipeViewEl = document.getElementById('results-swipe-view');
    const resultsSwipeCardEl = document.getElementById('results-swipe-card');
    const resultsSwipeCountEl = document.getElementById('results-swipe-count');
    const resultsSwipePrevEl = document.getElementById('results-swipe-prev');
    const resultsSwipeNextEl = document.getElementById('results-swipe-next');
    let state = { config: {} };
    let loginMode = 'admin';
    let authRole = 'admin';
    let authBrands = [];
    let authEmail = '';
    let adminToken = '';
    let systemPromptUnlocked = false;
    let systemPromptOriginal = '';
    let systemPromptDirty = false;
    let promptStore = { templates: [], history: [] };
    let pendingCvQuestionId = '';
    let lastLoadError = '';
    let activeView = 'general';
    let activeBrandKey = '';
    let suppressSidebarSync = false;
    let resultsTimer = null;
    let cvTimer = null;
    let cvActiveTimer = null;
    let badgeTimer = null;
    let cvPollUntil = 0;
    let cvFilterMode = 'no_calls';
    let resultsFilterMode = 'completed';
    let resultsDecisionMode = 'all';
    let lastCvRaw = [];
    let lastCvList = [];
    let lastResultsRaw = [];
    let lastResults = [];
    let lastCvFiltered = [];
    let lastResultsFiltered = [];
    let cvViewMode = 'table';
    let resultsViewMode = 'table';
    let cvSwipeIndex = 0;
    let resultsSwipeIndex = 0;
    let currentCvSource = '';
    let currentCvFileDataUrl = '';
    let currentCvPhotoDataUrl = '';
    let currentCvFileName = '';
    let currentCvFileType = '';
    let currentCvId = '';
    const photoThumbCache = new Map();
    let usersList = [];
    let editingUserId = '';
    let portalPages = [];
    let portalCurrent = null;
    let portalPendingUploads = { logo: null, hero: null, favicon: null, gallery: [] };
    let portalLastApps = [];
    let portalPendingSlug = '';
    let portalLoaded = false;
    let pendingPortalView = '';
    let currentUserProfile = null;
    let pendingUserPhotoDataUrl = '';
    let pendingUserPhotoName = '';
    let pendingUserPhotoClear = false;
    let candidatesBadgeItems = [];
    let interviewsBadgeItems = [];
    const CV_CHAR_LIMIT = 4000;
    const MAX_LOGO_SIZE = 600 * 1024;
    const MAX_PDF_PAGES = 8;
    const OCR_TEXT_THRESHOLD = 180;
    const OCR_MAX_PAGES = 3;
    const OCR_MAX_DIM = 1700;
    const OCR_JPEG_QUALITY = 0.82;
    const defaultSystemPrompt = ${JSON.stringify(DEFAULT_SYSTEM_PROMPT_TEMPLATE)};
    const defaultEnglishLevelQuestionEs = ${JSON.stringify(ENGLISH_LEVEL_QUESTION)};
    const defaultEnglishLevelQuestionEn = ${JSON.stringify(ENGLISH_LEVEL_QUESTION_EN)};
    const defaultEnglishCheckQuestion = ${JSON.stringify(ENGLISH_CHECK_QUESTION)};
    const defaultLateClosingQuestionEs = ${JSON.stringify(LATE_CLOSING_QUESTION_ES)};
    const defaultLateClosingQuestionEn = ${JSON.stringify(LATE_CLOSING_QUESTION_EN)};
    const defaultRecordingIntroEs = ${JSON.stringify(DEFAULT_RECORDING_INTRO_ES)};
    const defaultRecordingIntroEn = ${JSON.stringify(DEFAULT_RECORDING_INTRO_EN)};
    const defaultRecordingConsentEs = ${JSON.stringify(DEFAULT_RECORDING_CONSENT_ES)};
    const defaultRecordingConsentEn = ${JSON.stringify(DEFAULT_RECORDING_CONSENT_EN)};
    const defaultRecordingConfirmEs = ${JSON.stringify(DEFAULT_RECORDING_CONFIRM_ES)};
    const defaultRecordingConfirmEn = ${JSON.stringify(DEFAULT_RECORDING_CONFIRM_EN)};
    const defaultRecordingNoResponseEs = ${JSON.stringify(DEFAULT_RECORDING_NO_RESPONSE_ES)};
    const defaultRecordingNoResponseEn = ${JSON.stringify(DEFAULT_RECORDING_NO_RESPONSE_EN)};
    const defaultRecordingDeclineEs = ${JSON.stringify(DEFAULT_RECORDING_DECLINE_ES)};
    const defaultRecordingDeclineEn = ${JSON.stringify(DEFAULT_RECORDING_DECLINE_EN)};
    const defaults = {
      opener_es: "Hola {name}, te llamo por una entrevista de trabajo en {brand} para {role}. ¿Tenés un minuto para hablar?",
      opener_en: "Hi {name}, I'm calling about your application for {role} at {brand}. Do you have a minute to talk?",
      lang_rules: "Si responde en inglés, mantener toda la entrevista en inglés.",
      must_ask: "Zona/logística, disponibilidad, salario, prueba, permanencia en Miami, inglés si aplica.",
      system_prompt: defaultSystemPrompt,
      runtime_instructions: "",
      english_level_question_es: defaultEnglishLevelQuestionEs,
      english_level_question_en: defaultEnglishLevelQuestionEn,
      english_check_question_es: defaultEnglishCheckQuestion,
      english_check_question_en: defaultEnglishCheckQuestion,
      late_closing_question_es: defaultLateClosingQuestionEs,
      late_closing_question_en: defaultLateClosingQuestionEn,
      recording_intro_es: defaultRecordingIntroEs,
      recording_intro_en: defaultRecordingIntroEn,
      recording_consent_es: defaultRecordingConsentEs,
      recording_consent_en: defaultRecordingConsentEn,
      recording_confirm_es: defaultRecordingConfirmEs,
      recording_confirm_en: defaultRecordingConfirmEn,
      recording_no_response_es: defaultRecordingNoResponseEs,
      recording_no_response_en: defaultRecordingNoResponseEn,
      recording_decline_es: defaultRecordingDeclineEs,
      recording_decline_en: defaultRecordingDeclineEn
    };
    const OUTCOME_LABELS = {
      NO_ANSWER: "No contestó",
      DECLINED_RECORDING: "No aceptó la grabación",
      CONSENT_TIMEOUT: "No respondió al consentimiento de grabación",
      NO_SPEECH: "No emitió opinión",
      HUNG_UP: "El candidato colgó",
      CALL_DISCONNECTED: "Se desconectó la llamada",
      TRANSCRIPTION_FAILED: "No se pudo transcribir el audio"
    };
    const VIEW_CALLS = '__calls__';
    const VIEW_INTERVIEWS = '__interviews__';
    const VIEW_PORTAL = '__portal__';

    if (window.pdfjsLib) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    }

    function setStatus(msg) { statusEl.textContent = msg || ''; }
    function setPreviewStatus(msg) { previewStatusEl.textContent = msg || ''; }
    function setLoginStatus(msg) { loginStatusEl.textContent = msg || ''; }
    function setAdminStatus(msg) { adminStatusEl.textContent = msg || ''; }
    function setCallStatus(msg) { callStatusEl.textContent = msg || ''; }
    function setCvStatus(msg) { cvStatusEl.textContent = msg || ''; }
    function setUserStatus(msg) { if (userStatusEl) userStatusEl.textContent = msg || ''; }
    function setUserProfileStatus(msg, isError) {
      if (!userProfileStatusEl) return;
      userProfileStatusEl.textContent = msg || '';
      userProfileStatusEl.style.color = isError ? '#b42318' : 'var(--primary-dark)';
    }
    function setResultsCount(msg) { resultsCountEl.textContent = msg || ''; }
    function setCvListCount(msg) { cvListCountEl.textContent = msg || ''; }
    function setSystemPromptBaseline(value) {
      systemPromptOriginal = value || '';
      systemPromptDirty = false;
    }
    const SIDEBAR_STATE_KEY = 'hrbot_sidebar_collapsed';
    const AUTH_TOKEN_KEY = 'hrbot_auth_token';
    const AUTH_ROLE_KEY = 'hrbot_auth_role';
    const AUTH_BRANDS_KEY = 'hrbot_auth_brands';
    const AUTH_EMAIL_KEY = 'hrbot_auth_email';
    const CANDIDATES_SEEN_KEY = 'hrbot_candidates_seen_at';
    const INTERVIEWS_SEEN_KEY = 'hrbot_interviews_seen_at';
    const CV_VIEW_MODE_KEY = 'hrbot_cv_view_mode';
    const RESULTS_VIEW_MODE_KEY = 'hrbot_results_view_mode';

    function stopPolling() {
      if (resultsTimer) {
        clearTimeout(resultsTimer);
        resultsTimer = null;
      }
      if (cvTimer) {
        clearTimeout(cvTimer);
        cvTimer = null;
      }
      if (cvActiveTimer) {
        clearTimeout(cvActiveTimer);
        cvActiveTimer = null;
      }
      if (badgeTimer) {
        clearInterval(badgeTimer);
        badgeTimer = null;
      }
      cvPollUntil = 0;
    }

    function setLoggedInUI(isLoggedIn) {
      if (loginScreenEl) loginScreenEl.style.display = isLoggedIn ? 'none' : 'flex';
      if (appEl) appEl.style.display = isLoggedIn ? 'flex' : 'none';
      if (logoutBtnEl) logoutBtnEl.style.display = isLoggedIn ? '' : 'none';
      if (userPanelToggleEl) userPanelToggleEl.style.display = isLoggedIn ? '' : 'none';
      if (!isLoggedIn) {
        if (navCallsBadgeEl) {
          navCallsBadgeEl.textContent = '';
          navCallsBadgeEl.style.display = 'none';
        }
        if (navInterviewsBadgeEl) {
          navInterviewsBadgeEl.textContent = '';
          navInterviewsBadgeEl.style.display = 'none';
        }
      }
    }

    function clearAuthState() {
      tokenEl.value = '';
      adminToken = '';
      authRole = 'viewer';
      authBrands = [];
      authEmail = '';
      systemPromptUnlocked = false;
      systemPromptOriginal = '';
      systemPromptDirty = false;
      lockSystemPrompt();
      setAdminStatus('Bloqueado');
      setStatus('');
      setLoginStatus('');
      portalLoaded = false;
      portalPages = [];
      portalCurrent = null;
      portalPendingUploads = { logo: null, hero: null, favicon: null, gallery: [] };
      portalLastApps = [];
      portalPendingSlug = '';
      if (portalListEl) portalListEl.innerHTML = '';
      if (portalAppBodyEl) portalAppBodyEl.innerHTML = '';
      if (portalAppCountEl) portalAppCountEl.textContent = '';
      if (portalStatusEl) portalStatusEl.textContent = '';
      currentUserProfile = null;
      if (userEmailTextEl) userEmailTextEl.textContent = '';
      if (userRoleTextEl) userRoleTextEl.textContent = '';
      applyUserAvatar('', '');
      candidatesBadgeItems = [];
      interviewsBadgeItems = [];
      if (navCallsBadgeEl) {
        navCallsBadgeEl.textContent = '';
        navCallsBadgeEl.style.display = 'none';
      }
      if (navInterviewsBadgeEl) {
        navInterviewsBadgeEl.textContent = '';
        navInterviewsBadgeEl.style.display = 'none';
      }
      lastCvRaw = [];
      lastCvList = [];
      lastCvFiltered = [];
      lastResultsRaw = [];
      lastResults = [];
      lastResultsFiltered = [];
      cvSwipeIndex = 0;
      resultsSwipeIndex = 0;
      if (cvListBodyEl) cvListBodyEl.innerHTML = '';
      if (resultsBodyEl) resultsBodyEl.innerHTML = '';
      setCvListCount('');
      setResultsCount('');
      cvViewMode = 'table';
      resultsViewMode = 'table';
      applyCvViewMode('table', { persist: false });
      applyResultsViewMode('table', { persist: false });
      if (pushEnableEl) pushEnableEl.disabled = true;
      if (pushDisableEl) pushDisableEl.disabled = true;
      setPushStatus('Inactivo', 'Iniciá sesión para activar.');
    }

    function logout() {
      stopPolling();
      clearAuthState();
      closeUserModal();
      if (loginTokenEl) loginTokenEl.value = '';
      if (loginEmailEl) loginEmailEl.value = '';
      if (loginPasswordEl) loginPasswordEl.value = '';
      clearStoredAuth();
      setLoginMode('admin');
      setLoggedInUI(false);
    }

    function isMobileViewport() {
      return !!(window.matchMedia && window.matchMedia('(max-width: 980px)').matches);
    }

    function setSidebarCollapsed(collapsed, persist = true) {
      if (!sidebarEl) return;
      sidebarEl.classList.toggle('collapsed', collapsed);
      document.body.classList.toggle('sidebar-open', isMobileViewport() && !collapsed);
      if (sidebarToggleEl) {
        sidebarToggleEl.textContent = collapsed ? '>' : '|||';
        sidebarToggleEl.title = collapsed ? 'Expandir menú' : 'Minimizar menú';
      }
      if (persist) {
        try {
          localStorage.setItem(SIDEBAR_STATE_KEY, collapsed ? '1' : '0');
        } catch (err) {
          // ignore storage failures
        }
      }
    }

    function initSidebarState() {
      if (!sidebarEl) return;
      const isMobile = window.matchMedia && window.matchMedia('(max-width: 980px)').matches;
      if (isMobile) {
        let collapsed = true;
        try {
          const stored = localStorage.getItem(SIDEBAR_STATE_KEY);
          if (stored !== null) collapsed = stored === '1';
        } catch (err) {
          collapsed = true;
        }
        setSidebarCollapsed(collapsed, false);
        return;
      }
      let collapsed = false;
      try {
        collapsed = localStorage.getItem(SIDEBAR_STATE_KEY) === '1';
      } catch (err) {
        collapsed = false;
      }
      setSidebarCollapsed(collapsed, false);
    }

    function enableMobilePanelToggle(panelId, opts = {}) {
      const panel = document.getElementById(panelId);
      if (!panel || panel.classList.contains('has-mobile-toggle')) return;
      const title = panel.querySelector(':scope > .panel-title');
      const sub = panel.querySelector(':scope > .panel-sub');
      if (!title || !sub) return;
      const contentSelector = typeof opts.contentSelector === 'string' ? opts.contentSelector.trim() : '';
      const directChildren = Array.from(panel.children);
      const defaultChildren = directChildren.filter((child) => child !== title && child !== sub);
      let bodyChildren = [];
      if (contentSelector) {
        bodyChildren = directChildren.filter((child) => child.matches && child.matches(contentSelector));
      }
      if (!bodyChildren.length) {
        bodyChildren = defaultChildren;
      }
      if (!bodyChildren.length) return;
      const body = document.createElement('div');
      body.className = 'panel-body';
      const bodySet = new Set(bodyChildren);
      let anchor = null;
      const firstIdx = directChildren.indexOf(bodyChildren[0]);
      for (let i = firstIdx + 1; i < directChildren.length; i += 1) {
        const candidate = directChildren[i];
        if (!bodySet.has(candidate)) {
          anchor = candidate;
          break;
        }
      }
      bodyChildren.forEach((child) => {
        body.appendChild(child);
      });
      if (anchor) panel.insertBefore(body, anchor);
      else panel.appendChild(body);
      panel.classList.add('has-mobile-toggle');
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'panel-toggle secondary';
      sub.insertAdjacentElement('afterend', toggle);
      const media = window.matchMedia ? window.matchMedia('(max-width: 820px)') : null;
      const defaultCollapsed = opts.defaultCollapsed === true;
      const collapsedLabel = opts.collapsedLabel || 'Mostrar filtros';
      const expandedLabel = opts.expandedLabel || 'Ocultar filtros';
      const syncState = (forceCollapsed) => {
        const isMobile = media ? media.matches : false;
        if (!isMobile) {
          panel.classList.remove('mobile-collapsed');
          toggle.textContent = expandedLabel;
          toggle.setAttribute('aria-expanded', 'true');
          return;
        }
        const shouldCollapse = typeof forceCollapsed === 'boolean' ? forceCollapsed : defaultCollapsed;
        panel.classList.toggle('mobile-collapsed', shouldCollapse);
        const expanded = !panel.classList.contains('mobile-collapsed');
        toggle.textContent = expanded ? expandedLabel : collapsedLabel;
        toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      };
      toggle.addEventListener('click', () => {
        panel.classList.toggle('mobile-collapsed');
        const expanded = !panel.classList.contains('mobile-collapsed');
        toggle.textContent = expanded ? expandedLabel : collapsedLabel;
        toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      });
      if (media && media.addEventListener) {
        media.addEventListener('change', () => syncState(false));
      }
      syncState(defaultCollapsed && media && media.matches);
    }

    function clearCallForm() {
      callNameEl.value = '';
      callPhoneEl.value = '';
      callCvTextEl.value = '';
      currentCvSource = '';
      currentCvFileDataUrl = '';
      currentCvPhotoDataUrl = '';
      currentCvFileName = '';
      currentCvFileType = '';
      currentCvId = '';
      if (cvFileEl) cvFileEl.value = '';
      setCvStatus('');
      setCallStatus('');
    }

    function setLoginMode(mode) {
      loginMode = mode === 'viewer' ? 'viewer' : 'admin';
      loginModeAdminEl.classList.toggle('active', loginMode === 'admin');
      loginModeViewerEl.classList.toggle('active', loginMode === 'viewer');
      loginAdminFieldsEl.style.display = loginMode === 'admin' ? 'flex' : 'none';
      loginViewerFieldsEl.style.display = loginMode === 'viewer' ? 'flex' : 'none';
      setLoginStatus('');
    }

    function syncPortalToken() {
      if (!tokenEl || !tokenEl.value) return;
      try {
        localStorage.setItem('portalToken', tokenEl.value);
        localStorage.setItem(AUTH_TOKEN_KEY, tokenEl.value);
        localStorage.setItem(AUTH_ROLE_KEY, authRole || 'viewer');
        localStorage.setItem(AUTH_BRANDS_KEY, JSON.stringify(authBrands || []));
        if (authEmail) {
          localStorage.setItem(AUTH_EMAIL_KEY, authEmail);
        } else {
          localStorage.removeItem(AUTH_EMAIL_KEY);
        }
      } catch (err) {}
    }

    function clearStoredAuth() {
      try {
        localStorage.removeItem('portalToken');
        localStorage.removeItem(AUTH_TOKEN_KEY);
        localStorage.removeItem(AUTH_ROLE_KEY);
        localStorage.removeItem(AUTH_BRANDS_KEY);
        localStorage.removeItem(AUTH_EMAIL_KEY);
      } catch (err) {}
    }

    function applyRoleAccess() {
      const isAdmin = authRole === 'admin';
      const canWrite = authRole !== 'viewer';
      if (navGeneralEl) navGeneralEl.style.display = isAdmin ? '' : 'none';
      if (navPortalEl) navPortalEl.style.display = isAdmin ? '' : 'none';
      if (brandListEl) brandListEl.style.display = isAdmin ? '' : 'none';
      if (addBrandEl) addBrandEl.style.display = isAdmin ? '' : 'none';
      if (loadBtnEl) loadBtnEl.style.display = isAdmin ? '' : 'none';
      if (saveBtnEl) saveBtnEl.style.display = isAdmin ? '' : 'none';
      if (usersPanelEl) usersPanelEl.style.display = isAdmin ? 'block' : 'none';
      if (callPanelEl) callPanelEl.classList.toggle('readonly', !canWrite);
      if (callBtnEl) callBtnEl.disabled = !canWrite;
      if (cvSaveBtnEl) cvSaveBtnEl.disabled = !canWrite;
      if (callClearEl) callClearEl.disabled = !canWrite;
      if (cvFileEl) cvFileEl.disabled = !canWrite;
      if (!isAdmin && activeView === 'general') {
        setActiveView(VIEW_CALLS);
      }
    }

    function initialsFromEmail(email) {
      const value = (email || '').trim();
      if (!value) return 'U';
      const base = value.split('@')[0] || value;
      const parts = base.split(/[._\-\s]+/).filter(Boolean);
      if (!parts.length) return base.slice(0, 2).toUpperCase();
      if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }

    function applyUserAvatar(url, email) {
      if (!userAvatarWrapEl) return;
      const clean = (url || '').trim();
      const initials = initialsFromEmail(email);
      if (userAvatarFallbackEl) userAvatarFallbackEl.textContent = initials;
      if (clean) {
        userAvatarImgEl.src = clean;
        userAvatarWrapEl.classList.add('has-img');
      } else {
        userAvatarImgEl.removeAttribute('src');
        userAvatarWrapEl.classList.remove('has-img');
      }
    }

    async function loadMe() {
      if (!tokenEl || !tokenEl.value) return;
      try {
        const resp = await fetch('/admin/me', { headers: portalAuthHeaders() });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || 'me_failed');
        const user = data.user || {};
        currentUserProfile = user;
        const email = (user.email || '').trim();
        if (email && email !== authEmail) {
          authEmail = email;
          syncPortalToken();
        }
        if (email) {
          refreshViewModesFromStorage();
        }
        if (userEmailTextEl) userEmailTextEl.textContent = user.email || 'Admin';
        if (userRoleTextEl) userRoleTextEl.textContent = user.role ? ('Rol: ' + user.role) : '';
        applyUserAvatar(user.profile_photo_url || '', user.email || '');
        const canUpdate = data.can_update !== false;
        if (userSaveProfileEl) userSaveProfileEl.disabled = !canUpdate;
        if (userPhotoInputEl) userPhotoInputEl.disabled = !canUpdate;
        if (userPhotoClearEl) userPhotoClearEl.disabled = !canUpdate;
      } catch (err) {
        setUserProfileStatus('Error: ' + err.message, true);
      }
    }

    function openUserModal() {
      if (!userModalEl) return;
      userModalEl.style.display = 'flex';
      setUserProfileStatus('');
      pendingUserPhotoDataUrl = '';
      pendingUserPhotoName = '';
      pendingUserPhotoClear = false;
      if (userPasswordNewEl) userPasswordNewEl.value = '';
      if (userPasswordConfirmEl) userPasswordConfirmEl.value = '';
      if (userPhotoInputEl) userPhotoInputEl.value = '';
      loadMe();
      refreshPushStatus();
    }

    function closeUserModal() {
      if (!userModalEl) return;
      userModalEl.style.display = 'none';
    }

    async function saveUserProfile() {
      if (!tokenEl || !tokenEl.value) return;
      const password = (userPasswordNewEl && userPasswordNewEl.value || '').trim();
      const confirm = (userPasswordConfirmEl && userPasswordConfirmEl.value || '').trim();
      if (password || confirm) {
        if (password.length < 6) {
          setUserProfileStatus('La contraseña debe tener al menos 6 caracteres.', true);
          return;
        }
        if (password !== confirm) {
          setUserProfileStatus('Las contraseñas no coinciden.', true);
          return;
        }
      }
      const payload = {};
      if (password) payload.password = password;
      if (pendingUserPhotoClear) payload.profile_photo_clear = true;
      if (pendingUserPhotoDataUrl) {
        payload.profile_photo_data_url = pendingUserPhotoDataUrl;
        payload.profile_photo_file_name = pendingUserPhotoName || 'avatar';
      }
      if (!Object.keys(payload).length) {
        setUserProfileStatus('Sin cambios para guardar.');
        return;
      }
      setUserProfileStatus('Guardando...');
      try {
        const resp = await fetch('/admin/me', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...portalAuthHeaders() },
          body: JSON.stringify(payload)
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || 'profile_failed');
        if (data.user) {
          currentUserProfile = data.user;
          if (userEmailTextEl) userEmailTextEl.textContent = data.user.email || 'Admin';
          if (userRoleTextEl) userRoleTextEl.textContent = data.user.role ? ('Rol: ' + data.user.role) : '';
          applyUserAvatar(data.user.profile_photo_url || '', data.user.email || '');
        }
        pendingUserPhotoDataUrl = '';
        pendingUserPhotoName = '';
        pendingUserPhotoClear = false;
        if (userPhotoInputEl) userPhotoInputEl.value = '';
        if (userPasswordNewEl) userPasswordNewEl.value = '';
        if (userPasswordConfirmEl) userPasswordConfirmEl.value = '';
        setUserProfileStatus('Guardado.');
      } catch (err) {
        setUserProfileStatus('Error: ' + err.message, true);
      }
    }

    function listBrandsForUsers() {
      const cfg = state.config || {};
      const list = [];
      Object.keys(cfg).forEach((key) => {
        if (key === 'meta') return;
        const meta = cfg[key]?._meta || {};
        const display = (meta.displayName || key || '').trim();
        if (!key) return;
        list.push({ key, display: display || key });
      });
      return list.sort((a, b) => a.display.localeCompare(b.display));
    }

    function getSelectedUserBrands() {
      if (!userBrandListEl) return [];
      return Array.from(userBrandListEl.querySelectorAll('input[type="checkbox"]:checked'))
        .map((el) => el.value);
    }

    function renderUserBrandList(selected = []) {
      if (!userBrandListEl) return;
      const selectedSet = new Set((selected || []).map((val) => normalizeKeyUi(val)));
      userBrandListEl.innerHTML = '';
      const brands = listBrandsForUsers();
      if (!brands.length) {
        const empty = document.createElement('div');
        empty.className = 'small';
        empty.textContent = 'Sin locales cargados.';
        userBrandListEl.appendChild(empty);
        return;
      }
      brands.forEach((brand) => {
        const label = document.createElement('label');
        label.className = 'brand-check';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.value = brand.key;
        if (selectedSet.has(normalizeKeyUi(brand.key))) input.checked = true;
        const span = document.createElement('span');
        span.textContent = brand.display || brand.key;
        label.appendChild(input);
        label.appendChild(span);
        userBrandListEl.appendChild(label);
      });
    }

    function resetUserForm() {
      editingUserId = '';
      if (userEmailEl) userEmailEl.value = '';
      if (userPasswordEl) userPasswordEl.value = '';
      if (userRoleEl) userRoleEl.value = 'viewer';
      if (userActiveEl) userActiveEl.checked = true;
      renderUserBrandList([]);
      if (userSaveEl) userSaveEl.textContent = 'Guardar usuario';
      setUserStatus('');
    }

    function formatUserBrands(list = []) {
      if (!Array.isArray(list) || !list.length) return 'Todos';
      return list.map((key) => getBrandDisplayByKey(key) || key).join(', ');
    }

    function renderUsersTable(list) {
      if (!userTableBodyEl) return;
      userTableBodyEl.innerHTML = '';
      if (!Array.isArray(list) || !list.length) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 5;
        td.textContent = 'No hay usuarios todavía.';
        tr.appendChild(td);
        userTableBodyEl.appendChild(tr);
        return;
      }
      list.forEach((user) => {
        const tr = document.createElement('tr');
        const addCell = (value) => {
          const td = document.createElement('td');
          td.textContent = value || '—';
          tr.appendChild(td);
        };
        addCell(user.email || '');
        addCell(user.role || '');
        addCell(formatUserBrands(user.allowed_brands || []));
        addCell(user.active === false ? 'No' : 'Sí');
        const actionTd = document.createElement('td');
        const wrap = document.createElement('div');
        wrap.className = 'user-actions';
        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'secondary btn-compact';
        editBtn.textContent = 'Editar';
        editBtn.onclick = () => {
          editingUserId = user.id;
          if (userEmailEl) userEmailEl.value = user.email || '';
          if (userPasswordEl) userPasswordEl.value = '';
          if (userRoleEl) userRoleEl.value = user.role || 'viewer';
          if (userActiveEl) userActiveEl.checked = user.active !== false;
          renderUserBrandList(user.allowed_brands || []);
          if (userSaveEl) userSaveEl.textContent = 'Actualizar';
          setUserStatus('');
        };
        wrap.appendChild(editBtn);
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'secondary btn-compact';
        delBtn.textContent = 'Eliminar';
        delBtn.onclick = () => deleteUser(user.id);
        wrap.appendChild(delBtn);
        actionTd.appendChild(wrap);
        tr.appendChild(actionTd);
        userTableBodyEl.appendChild(tr);
      });
    }

    async function loadUsers() {
      if (!usersPanelEl || authRole !== 'admin') return;
      try {
        setUserStatus('Cargando...');
        const resp = await fetch('/admin/users', {
          headers: { Authorization: 'Bearer ' + tokenEl.value }
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || 'users failed');
        usersList = data.users || [];
        renderUsersTable(usersList);
        setUserStatus('');
      } catch (err) {
        setUserStatus('Error: ' + err.message);
      }
    }

    async function saveUser() {
      if (authRole !== 'admin') return;
      const email = (userEmailEl?.value || '').trim();
      const password = userPasswordEl?.value || '';
      const role = userRoleEl?.value || 'viewer';
      const active = userActiveEl?.checked !== false;
      const allowed_brands = getSelectedUserBrands();
      if (!email) {
        setUserStatus('Ingresá un email.');
        return;
      }
      if (!editingUserId && !password) {
        setUserStatus('Ingresá un password.');
        return;
      }
      const payload = { email, password, role, allowed_brands, active };
      setUserStatus('Guardando...');
      try {
        const url = editingUserId ? '/admin/users/' + encodeURIComponent(editingUserId) : '/admin/users';
        const method = editingUserId ? 'PUT' : 'POST';
        const resp = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokenEl.value },
          body: JSON.stringify(payload)
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || 'user save failed');
        resetUserForm();
        await loadUsers();
      } catch (err) {
        setUserStatus('Error: ' + err.message);
      }
    }

    async function deleteUser(id) {
      if (!id) return;
      if (!confirm('¿Seguro que querés eliminar este usuario?')) return;
      setUserStatus('Eliminando...');
      try {
        const resp = await fetch('/admin/users/' + encodeURIComponent(id), {
          method: 'DELETE',
          headers: { Authorization: 'Bearer ' + tokenEl.value }
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || 'user delete failed');
        if (editingUserId === id) resetUserForm();
        await loadUsers();
      } catch (err) {
        setUserStatus('Error: ' + err.message);
      }
    }

    function openCvModal(text) {
      if (!cvModalEl) return;
      cvModalTextEl.value = text || '';
      cvModalEl.style.display = 'flex';
    }

    function closeCvModal() {
      if (!cvModalEl) return;
      cvModalEl.style.display = 'none';
    }

    function setCvQuestionStatus(msg, isError) {
      if (!cvQuestionStatusEl) return;
      cvQuestionStatusEl.textContent = msg || '';
      cvQuestionStatusEl.style.color = isError ? '#b42318' : 'var(--primary-dark)';
    }

    function openCvQuestionModal(item) {
      if (!cvQuestionModalEl || !cvQuestionTextEl) return;
      pendingCvQuestionId = item?.id || (Array.isArray(item?.cvIds) ? item.cvIds[0] : '') || '';
      cvQuestionTextEl.value = item?.custom_question || '';
      setCvQuestionStatus('');
      cvQuestionModalEl.style.display = 'flex';
    }

    function closeCvQuestionModal() {
      if (!cvQuestionModalEl) return;
      cvQuestionModalEl.style.display = 'none';
      pendingCvQuestionId = '';
    }

    async function saveCvQuestion() {
      if (!pendingCvQuestionId) return;
      const question = (cvQuestionTextEl.value || '').trim();
      setCvQuestionStatus('Guardando...');
      try {
        const resp = await fetch('/admin/cv/question', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokenEl.value },
          body: JSON.stringify({ id: pendingCvQuestionId, question })
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || 'save_failed');
        lastCvRaw = lastCvRaw.map((c) => c.id === pendingCvQuestionId ? { ...c, custom_question: question } : c);
        setCvQuestionStatus('Guardado.');
        renderCvList(lastCvRaw);
      } catch (err) {
        setCvQuestionStatus('Error: ' + err.message, true);
      }
    }

    function openInterviewModal(call) {
      if (!interviewModalEl || !interviewModalTextEl) return;
      interviewModalTextEl.value = formatInterviewDetails(call || {});
      interviewModalEl.style.display = 'flex';
    }

    function closeInterviewModal() {
      if (!interviewModalEl) return;
      interviewModalEl.style.display = 'none';
    }

    function lockSystemPrompt() {
      systemPromptUnlocked = false;
      systemPromptEl.readOnly = true;
      systemPromptEl.classList.add('locked');
    }

    function unlockSystemPrompt() {
      systemPromptUnlocked = true;
      systemPromptEl.readOnly = false;
      systemPromptEl.classList.remove('locked');
    }

    function escapeHtml(value) {
      return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function setPromptAssistStatus(msg, isError) {
      if (!promptAssistStatusEl) return;
      promptAssistStatusEl.textContent = msg || '';
      promptAssistStatusEl.style.color = isError ? '#b42318' : 'var(--primary-dark)';
    }

    function renderPromptPreview(oldPrompt, newPrompt, addedLines = []) {
      if (!promptAssistPreviewEl) return;
      const oldSet = new Set(
        String(oldPrompt || '')
          .split(/\\r?\\n/)
          .map((l) => l.trim())
          .filter(Boolean)
      );
      const addedSet = new Set(
        Array.isArray(addedLines)
          ? addedLines.map((l) => String(l || '').trim()).filter(Boolean)
          : []
      );
      const lines = String(newPrompt || '').split(/\\r?\\n/);
      const html = lines.map((line) => {
        const norm = line.trim();
        const isAdded = addedSet.size
          ? addedSet.has(norm)
          : (!!norm && !oldSet.has(norm));
        const safe = escapeHtml(line);
        return isAdded ? '<mark>' + safe + '</mark>' : safe;
      }).join('\\n');
      promptAssistPreviewEl.innerHTML = html;
      promptAssistPreviewEl.style.display = html ? 'block' : 'none';
    }

    function renderPromptStore() {
      const templates = Array.isArray(promptStore.templates) ? promptStore.templates : [];
      const history = Array.isArray(promptStore.history) ? promptStore.history : [];
      if (promptTemplateSelectEl) {
        promptTemplateSelectEl.innerHTML = '';
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'Templates guardados';
        promptTemplateSelectEl.appendChild(opt);
        templates.forEach((t) => {
          const o = document.createElement('option');
          o.value = t.id;
          o.textContent = t.name || t.id;
          promptTemplateSelectEl.appendChild(o);
        });
      }
      if (promptHistorySelectEl) {
        promptHistorySelectEl.innerHTML = '';
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'Historial reciente';
        promptHistorySelectEl.appendChild(opt);
        history.forEach((h) => {
          const o = document.createElement('option');
          o.value = h.id;
          const stamp = h.created_at ? new Date(h.created_at).toLocaleString() : '';
          o.textContent = stamp || 'Versión';
          promptHistorySelectEl.appendChild(o);
        });
      }
    }

    async function loadPromptStore() {
      if (!adminToken) return;
      try {
        const resp = await fetch('/admin/system-prompt/store', {
          headers: { Authorization: 'Bearer ' + adminToken }
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || 'prompt_store_failed');
        promptStore = data.store || { templates: [], history: [] };
        renderPromptStore();
        if (data.source && adminStatusEl) {
          adminStatusEl.textContent = 'Admin OK · store: ' + data.source;
        }
      } catch (err) {
        console.error('prompt store failed', err);
      }
    }

    async function savePromptTemplate() {
      if (!adminToken || !promptTemplateNameEl) {
        setAdminStatus('Desbloqueá con ADMIN para guardar templates');
        return;
      }
      const name = (promptTemplateNameEl.value || '').trim();
      if (!name) {
        setAdminStatus('Ingresá un nombre para el template');
        return;
      }
      try {
        const resp = await fetch('/admin/system-prompt/templates', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + adminToken
          },
          body: JSON.stringify({ name, prompt: systemPromptEl.value || '' })
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || 'template_failed');
        promptTemplateNameEl.value = '';
        await loadPromptStore();
      } catch (err) {
        setAdminStatus('Error: ' + err.message);
      }
    }

    function restorePromptFromStore(id, kind) {
      if (!id) return;
      const list = kind === 'history' ? (promptStore.history || []) : (promptStore.templates || []);
      const found = list.find((t) => t.id === id);
      if (!found) return;
      systemPromptEl.value = found.prompt || '';
      systemPromptDirty = systemPromptEl.value !== systemPromptOriginal;
      renderPromptPreview('', found.prompt || '', []);
    }

    async function deletePromptTemplate(id) {
      if (!adminToken || !id) return;
      try {
        const resp = await fetch('/admin/system-prompt/templates/' + encodeURIComponent(id), {
          method: 'DELETE',
          headers: { Authorization: 'Bearer ' + adminToken }
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || 'template_delete_failed');
        await loadPromptStore();
      } catch (err) {
        setAdminStatus('Error: ' + err.message);
      }
    }

    async function runPromptAssistant() {
      if (!adminToken || !promptAssistInputEl) return;
      const instruction = (promptAssistInputEl.value || '').trim();
      if (!instruction) {
        setPromptAssistStatus('Escribí una instrucción.', true);
        return;
      }
      setPromptAssistStatus('Procesando...', false);
      try {
        const resp = await fetch('/admin/system-prompt/assist', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + adminToken
          },
          body: JSON.stringify({
            instruction,
            current_prompt: systemPromptEl.value || ''
          })
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.detail || data.error || 'assist_failed');
        const updated = data.updated_prompt || '';
        const oldPrompt = systemPromptEl.value || '';
        systemPromptEl.value = updated;
        systemPromptDirty = systemPromptEl.value !== systemPromptOriginal;
        renderPromptPreview(oldPrompt, updated, data.added_lines || []);
        setPromptAssistStatus(data.summary || 'Listo.', false);
      } catch (err) {
        setPromptAssistStatus('Error: ' + err.message, true);
      }
    }

    function getBrandLabel(wrapper) {
      const display = (wrapper.querySelector('.brand-display')?.value || '').trim();
      const key = (wrapper.querySelector('.brand-name')?.value || '').trim();
      const base = display || key || 'Logo';
      return base.slice(0, 2).toUpperCase();
    }

    function setLogoPreview(wrapper, dataUrl) {
      const preview = wrapper.querySelector('.logo-preview');
      const hidden = wrapper.querySelector('.brand-logo');
      if (!preview || !hidden) return;
      hidden.value = dataUrl || '';
      preview.innerHTML = '';
      if (dataUrl) {
        const img = document.createElement('img');
        img.src = dataUrl;
        img.alt = 'Logo';
        preview.appendChild(img);
      } else {
        const span = document.createElement('span');
        span.textContent = getBrandLabel(wrapper);
        preview.appendChild(span);
      }
    }

    function handleLogoFile(wrapper, file) {
      if (!file) return;
      if (!file.type.startsWith('image/')) {
        alert('Solo imágenes PNG/JPG.');
        return;
      }
      if (file.size > MAX_LOGO_SIZE) {
        alert('El logo es muy pesado. Máx 600KB.');
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        setLogoPreview(wrapper, reader.result);
        syncSidebar();
      };
      reader.readAsDataURL(file);
    }

    function brandTemplate(name = '') {
      const wrapper = document.createElement('div');
      wrapper.className = 'panel brand-card';
      wrapper.dataset.brandKey = name;
      wrapper.innerHTML = \`
        <div class="brand-header">
          <div>
            <div><strong class="brand-label"></strong></div>
            <div class="muted small">Clave: <span class="brand-key-label"></span></div>
          </div>
          <div class="inline">
            <button class="secondary portal-site" type="button">Crear sitio</button>
            <button class="secondary portal-group" type="button">Portal grupo</button>
            <button class="secondary add-role" type="button">+ Rol</button>
            <button class="secondary delete-brand" type="button">Eliminar</button>
          </div>
        </div>
        <div class="brand-meta">
          <div class="grid">
            <div>
              <label>Brand (clave)</label>
              <input type="text" class="brand-name" value="\${name}" placeholder="ej. campo / yes / mexi" />
              <div class="small">Se usa internamente para matchear.</div>
            </div>
            <div>
              <label>Nombre para mostrar</label>
              <input type="text" class="brand-display" placeholder="Ej. New Campo Argentino" />
            </div>
            <div>
              <label>Dirección</label>
              <input type="text" class="brand-address" placeholder="Ej. 6954 Collins Ave, Miami Beach, FL 33141, US" />
            </div>
            <div>
              <label>Aliases (coma separados)</label>
              <input type="text" class="brand-aliases" placeholder="campo, new campo argentino" />
            </div>
            <div>
              <label>Grupo</label>
              <input type="text" class="brand-group" placeholder="Ej. yes / mexi" />
            </div>
            <div>
              <label>Mostrar en menú</label>
              <div class="check-row">
                <input type="checkbox" class="brand-visible" checked />
                <span class="small">Visible en menú lateral y filtros.</span>
              </div>
            </div>
          </div>
          <div class="logo-row">
            <label>Logo</label>
            <div class="logo-drop">
              <input type="hidden" class="brand-logo" value="" />
              <div class="logo-preview"></div>
              <div>
                <div><strong>Arrastrá el logo</strong></div>
                <div class="small">PNG/JPG, máx 600KB.</div>
              </div>
              <input type="file" class="brand-logo-input" accept="image/*" />
              <button class="secondary logo-clear" type="button">Quitar</button>
            </div>
          </div>
        </div>
        <div class="roles"></div>
      \`;
      const rolesBox = wrapper.querySelector('.roles');
      const portalBtn = wrapper.querySelector('.portal-site');
      const portalGroupBtn = wrapper.querySelector('.portal-group');
      wrapper.querySelector('.add-role').onclick = () => {
        rolesBox.appendChild(roleTemplate());
        updateRoleOptions();
      };
      if (portalBtn) {
        portalBtn.onclick = (event) => {
          event.stopPropagation();
          openPortalForBrand(wrapper);
        };
      }
      if (portalGroupBtn) {
        portalGroupBtn.onclick = (event) => {
          event.stopPropagation();
          const group = (wrapper.querySelector('.brand-group')?.value || '').trim();
          if (!group) {
            setStatus('Falta el grupo para crear un portal general.');
            return;
          }
          openPortalForGroup(group);
        };
      }
      wrapper.querySelector('.delete-brand').onclick = () => {
        if (confirm('Eliminar este local?')) {
          const wasActive = wrapper.dataset.brandKey === activeBrandKey;
          wrapper.remove();
          syncSidebar();
          updateRoleOptions();
          if (wasActive) setActiveView('');
        }
      };
      const header = wrapper.querySelector('.brand-header');
      const label = wrapper.querySelector('.brand-label');
      const keyLabel = wrapper.querySelector('.brand-key-label');
      function updateLabels() {
        const prevKey = wrapper.dataset.brandKey || '';
        const key = (wrapper.querySelector('.brand-name').value || '').trim();
        const disp = (wrapper.querySelector('.brand-display').value || '').trim() || key || '(sin nombre)';
        wrapper.dataset.brandKey = key;
        label.textContent = disp;
        keyLabel.textContent = key || '(sin clave)';
        setLogoPreview(wrapper, wrapper.querySelector('.brand-logo').value || '');
        if (prevKey && activeBrandKey === prevKey && key && key !== prevKey) {
          activeBrandKey = key;
        }
        syncSidebar();
      }
      wrapper._updateLabels = updateLabels;
      header.onclick = () => {
        const meta = wrapper.querySelector('.brand-meta');
        const roles = wrapper.querySelector('.roles');
        const hidden = meta.style.display === 'none';
        meta.style.display = hidden ? '' : 'none';
        roles.style.display = hidden ? '' : 'none';
      };
      wrapper.querySelectorAll('.brand-name, .brand-display').forEach((el) => {
        el.addEventListener('input', updateLabels);
      });
      const logoDrop = wrapper.querySelector('.logo-drop');
      const logoInput = wrapper.querySelector('.brand-logo-input');
      const logoClear = wrapper.querySelector('.logo-clear');
      logoDrop.addEventListener('click', (event) => {
        if (event.target === logoClear) return;
        logoInput.click();
      });
      logoInput.addEventListener('change', (event) => {
        handleLogoFile(wrapper, event.target.files[0]);
      });
      logoDrop.addEventListener('dragover', (event) => {
        event.preventDefault();
        logoDrop.classList.add('drag');
      });
      logoDrop.addEventListener('dragleave', () => logoDrop.classList.remove('drag'));
      logoDrop.addEventListener('drop', (event) => {
        event.preventDefault();
        logoDrop.classList.remove('drag');
        handleLogoFile(wrapper, event.dataTransfer.files[0]);
      });
      logoClear.addEventListener('click', (event) => {
        event.stopPropagation();
        setLogoPreview(wrapper, '');
        syncSidebar();
      });
      updateLabels();
      return wrapper;
    }

    function roleTemplate(roleName = '', data = {}) {
      const card = document.createElement('div');
      card.className = 'role-card';
      const aliases = Array.isArray(data.aliases) ? data.aliases.join(', ') : '';
      const qs = Array.isArray(data.questions) && data.questions.length ? data.questions : [''];
      card.innerHTML = \`
        <div class="role-header">
          <div style="display:flex; align-items:center; gap:8px;">
            <span class="chevron">▼</span>
            <div>
              <strong class="role-label"></strong>
              <div class="muted small role-key-label"></div>
            </div>
          </div>
          <div class="inline">
            <span class="pill" style="background:\${data.englishRequired ? '#e4f1f2' : '#f3f0ea'}; color:\${data.englishRequired ? '#0f5563' : '#6a6f6b'};">EN</span>
            <span class="pill" style="background:\${data.physical ? '#f6dfd5' : '#f3f0ea'}; color:\${data.physical ? '#8a3f25' : '#6a6f6b'};">Físico</span>
            <button class="secondary remove-role" type="button">✕</button>
          </div>
        </div>
        <div class="role-body">
          <div class="grid">
            <div>
              <label>Role (clave)</label>
              <input type="text" class="role-name" value="\${roleName}" placeholder="Role (ej. server / runner)" />
              <div class="small">Usar el texto que llega en payload o alias.</div>
            </div>
            <div>
              <label>Nombre para mostrar</label>
              <input type="text" class="role-display" value="\${data.displayName || ''}" placeholder="Ej. server/runner" />
            </div>
          </div>
          <div class="inline">
            <label><input type="checkbox" class="chk-active" \${data.active === false ? '' : 'checked'} /> Activo</label>
            <label><input type="checkbox" class="chk-english" \${data.englishRequired ? 'checked' : ''} /> Requiere inglés</label>
            <label><input type="checkbox" class="chk-physical" \${data.physical ? 'checked' : ''} /> Rol físico</label>
          </div>
          <div>
            <label>Aliases (coma separados)</label>
            <input type="text" class="role-aliases" value="\${aliases}" placeholder="cajero, cashier, front" />
          </div>
          <div>
            <label>Notas</label>
            <textarea class="role-notes" placeholder="Contexto o aclaraciones">\${data.notes || ''}</textarea>
          </div>
          <div>
            <div class="inline" style="justify-content: space-between;">
              <label>Preguntas</label>
              <button class="secondary add-question" type="button">+ Add pregunta</button>
            </div>
            <div class="questions"></div>
          </div>
        </div>
      \`;
      const removeBtn = card.querySelector('.remove-role');
      removeBtn.onclick = () => {
        card.remove();
        updateRoleOptions();
      };
      const header = card.querySelector('.role-header');
      const chevron = header.querySelector('.chevron');
      const roleLabel = header.querySelector('.role-label');
      const roleKeyLabel = header.querySelector('.role-key-label');
      function updateRoleLabels() {
        const key = (card.querySelector('.role-name').value || '').trim() || '(sin rol)';
        const disp = (card.querySelector('.role-display').value || '').trim() || key;
        roleLabel.textContent = disp;
        roleKeyLabel.textContent = key;
        updateRoleOptions();
      }
      header.onclick = () => {
        const body = card.querySelector('.role-body');
        const hidden = body.style.display === 'none';
        body.style.display = hidden ? '' : 'none';
        chevron.textContent = hidden ? '▼' : '▶';
      };
      updateRoleLabels();
      card.querySelectorAll('.role-name, .role-display').forEach((el) => {
        el.addEventListener('input', updateRoleLabels);
      });
      const qBox = card.querySelector('.questions');
      function addQ(val = '') {
        const row = document.createElement('div');
        row.className = 'question';
        row.innerHTML = \`
          <input type="text" class="q-text" value="\${val}" placeholder="Pregunta abierta" />
          <button class="secondary btn-del-q" type="button">✕</button>
        \`;
        row.querySelector('.btn-del-q').onclick = () => row.remove();
        qBox.appendChild(row);
      }
      qs.forEach(addQ);
      card.querySelector('.add-question').onclick = () => addQ('');
      return card;
    }

    function getBrandCards() {
      return Array.from(brandsEl.querySelectorAll('.brand-card'));
    }

    function getBrandCardByKey(key) {
      return getBrandCards().find((card) => (card.dataset.brandKey || '') === key);
    }

    function getBrandDisplayByKey(key) {
      const card = getBrandCardByKey(key);
      if (!card) return key;
      const display = (card.querySelector('.brand-display')?.value || '').trim();
      return display || key;
    }

    function listBrandOptions() {
      return getBrandCards()
        .map((card) => {
          const key = (card.querySelector('.brand-name')?.value || '').trim();
          if (!key) return null;
          const visible = card.querySelector('.brand-visible')?.checked !== false;
          if (!visible) return null;
          const display = (card.querySelector('.brand-display')?.value || '').trim() || key;
          const logo = (card.querySelector('.brand-logo')?.value || '').trim();
          const group = (card.querySelector('.brand-group')?.value || '').trim();
          const address = (card.querySelector('.brand-address')?.value || '').trim();
          return { key, display, logo, group, address };
        })
        .filter(Boolean);
    }

    function listRolesForBrand(key) {
      const card = getBrandCardByKey(key);
      if (!card) return [];
      return Array.from(card.querySelectorAll('.role-card'))
        .map((roleCard) => {
          const roleKey = (roleCard.querySelector('.role-name')?.value || '').trim();
          if (!roleKey) return null;
          const display = (roleCard.querySelector('.role-display')?.value || '').trim() || roleKey;
          const aliasesRaw = (roleCard.querySelector('.role-aliases')?.value || '').trim();
          const aliases = aliasesRaw
            ? aliasesRaw.split(',').map((a) => a.trim()).filter(Boolean)
            : [];
          return { key: roleKey, display, aliases };
        })
        .filter(Boolean);
    }

    function toSlug(value) {
      return (value || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'portal';
    }

    function buildPortalPayloadFromBrand(wrapper) {
      const brandKey = (wrapper.querySelector('.brand-name')?.value || '').trim();
      const brandDisplay = (wrapper.querySelector('.brand-display')?.value || '').trim() || brandKey;
      const address = (wrapper.querySelector('.brand-address')?.value || '').trim();
      const logoDataUrl = (wrapper.querySelector('.brand-logo')?.value || '').trim();
      const slug = toSlug(brandKey || brandDisplay);
      const roles = listRolesForBrand(brandKey)
        .map((role) => role.display || role.key)
        .filter(Boolean);
      const roleOptions = roles.map((role) => ({ es: role, en: role }));
      const content = {
        title: {
          es: 'Trabaja en ' + (brandDisplay || 'el equipo'),
          en: 'Work at ' + (brandDisplay || 'our team')
        },
        description: {
          es: address ? ('Estamos en ' + address + '.') : 'Sumate al equipo.',
          en: address ? ('We are located at ' + address + '.') : 'Join the team.'
        },
        thankYou: { es: 'Gracias! Te contactamos pronto.', en: 'Thanks! We will contact you soon.' }
      };
      const fields = {
        name: { label: { es: 'Nombre completo', en: 'Full name' }, required: true },
        email: { label: { es: 'Email', en: 'Email' }, required: true },
        phone: { label: { es: 'Telefono', en: 'Phone' }, required: true },
        role: { label: { es: 'Puesto', en: 'Role' }, required: roleOptions.length > 0, options: roleOptions }
      };
      const payload = {
        slug,
        brand: brandDisplay || brandKey,
        active: true,
        localeDefault: 'es',
        content,
        fields,
        resume: { label: { es: 'CV (PDF)', en: 'Resume (PDF)' }, required: true },
        photo: { label: { es: 'Foto (opcional)', en: 'Photo (optional)' }, required: false },
        questions: []
      };
      if (logoDataUrl && !logoDataUrl.startsWith('data:')) {
        payload.assets = { logoUrl: logoDataUrl };
      }
      if (logoDataUrl && logoDataUrl.startsWith('data:')) {
        payload.logo_data_url = logoDataUrl;
        payload.logo_file_name = (slug || 'brand') + '_logo.png';
      }
      return payload;
    }

    function portalRoleOptionsFromBrandKey(brandKey) {
      return listRolesForBrand(brandKey)
        .map((role) => role.display || role.key)
        .filter(Boolean);
    }

    function buildPortalPayloadFromGroup(groupName) {
      const group = (groupName || '').trim();
      if (!group) return null;
      const norm = normalizeKeyUi(group);
      const brands = listBrandOptions().filter((brand) => normalizeKeyUi(brand.group || '') === norm);
      if (!brands.length) return null;
      const slug = toSlug(group);
      const locationOptions = brands.map((brand) => {
        const entry = {
          key: brand.key,
          label: { es: brand.display || brand.key, en: brand.display || brand.key }
        };
        if (brand.address) entry.address = brand.address;
        return entry;
      });
      const roleByLocation = {};
      const roleUnion = [];
      const roleSet = new Set();
      brands.forEach((brand) => {
        const roles = portalRoleOptionsFromBrandKey(brand.key);
        if (!roles.length) return;
        roleByLocation[brand.key] = roles.map((role) => ({ es: role, en: role }));
        roles.forEach((role) => {
          if (roleSet.has(role)) return;
          roleSet.add(role);
          roleUnion.push({ es: role, en: role });
        });
      });
      const content = {
        title: {
          es: 'Trabaja en ' + group,
          en: 'Work at ' + group
        },
        description: {
          es: 'Elegí la locación para aplicar.',
          en: 'Choose a location to apply.'
        },
        thankYou: { es: 'Gracias! Te contactamos pronto.', en: 'Thanks! We will contact you soon.' }
      };
      const fields = {
        name: { label: { es: 'Nombre completo', en: 'Full name' }, required: true },
        email: { label: { es: 'Email', en: 'Email' }, required: true },
        phone: { label: { es: 'Telefono', en: 'Phone' }, required: true },
        role: { label: { es: 'Puesto', en: 'Role' }, required: roleUnion.length > 0, options: roleUnion },
        locations: { label: { es: 'Locaciones', en: 'Locations' }, required: true, options: locationOptions },
        roleByLocation
      };
      const payload = {
        slug,
        brand: group,
        active: true,
        localeDefault: 'es',
        content,
        fields,
        resume: { label: { es: 'CV (PDF)', en: 'Resume (PDF)' }, required: true },
        photo: { label: { es: 'Foto (opcional)', en: 'Photo (optional)' }, required: false },
        questions: []
      };
      const logo = brands.find((brand) => brand.logo)?.logo || '';
      if (logo && !logo.startsWith('data:')) {
        payload.assets = { logoUrl: logo };
      }
      return payload;
    }

    async function openPortalForBrand(wrapper) {
      try {
        if (!tokenEl || !tokenEl.value) {
          setStatus('Necesitás autenticarte para crear el portal.');
          return;
        }
        const payload = buildPortalPayloadFromBrand(wrapper);
        if (!payload.slug) {
          setStatus('Falta la clave del local.');
          return;
        }
        setStatus('Creando portal...');
        const resp = await fetch('/admin/portal/pages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokenEl.value },
          body: JSON.stringify(payload)
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || 'portal_failed');
        syncPortalToken();
        const slug = (data.page && data.page.slug) || payload.slug;
        portalPendingSlug = slug;
        setStatus('Portal listo.');
        setActiveView(VIEW_PORTAL);
        ensurePortalLoaded(true);
      } catch (err) {
        setStatus('Error: ' + err.message);
      }
    }

    async function openPortalForGroup(groupName) {
      try {
        if (!tokenEl || !tokenEl.value) {
          setStatus('Necesitás autenticarte para crear el portal.');
          return;
        }
        const payload = buildPortalPayloadFromGroup(groupName);
        if (!payload) {
          setStatus('No hay locales para ese grupo.');
          return;
        }
        setStatus('Creando portal...');
        const resp = await fetch('/admin/portal/pages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokenEl.value },
          body: JSON.stringify(payload)
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || 'portal_failed');
        syncPortalToken();
        const slug = (data.page && data.page.slug) || payload.slug;
        portalPendingSlug = slug;
        setStatus('Portal listo.');
        setActiveView(VIEW_PORTAL);
        ensurePortalLoaded(true);
      } catch (err) {
        setStatus('Error: ' + err.message);
      }
    }

    function portalAuthHeaders() {
      const token = tokenEl && tokenEl.value ? tokenEl.value.trim() : '';
      if (!token) return {};
      if (token.startsWith('Bearer ')) return { Authorization: token };
      return { Authorization: 'Bearer ' + token };
    }

    function setPushStatus(status, detail) {
      if (!pushStatusEl) return;
      pushStatusEl.textContent = status || '';
      if (pushDetailEl) pushDetailEl.textContent = detail || '';
    }

    function pushSupported() {
      return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    }

    function urlBase64ToUint8Array(base64String) {
      const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
      const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
      const rawData = window.atob(base64);
      const outputArray = new Uint8Array(rawData.length);
      for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
      }
      return outputArray;
    }

    async function fetchPushConfig() {
      const resp = await fetch('/admin/push/public-key', { headers: portalAuthHeaders() });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || 'push_config_failed');
      return data;
    }

    async function getPushRegistration() {
      if (!pushSupported()) return null;
      const reg = await navigator.serviceWorker.getRegistration('/admin/');
      if (reg) return reg;
      return navigator.serviceWorker.register('/admin/sw.js', { scope: '/admin/' });
    }

    async function getPushSubscription() {
      const reg = await getPushRegistration();
      if (!reg) return null;
      return reg.pushManager.getSubscription();
    }

    async function refreshPushStatus() {
      if (!pushStatusEl) return;
      if (!pushSupported()) {
        setPushStatus('No disponible', 'Este navegador no soporta notificaciones.');
        if (pushEnableEl) pushEnableEl.disabled = true;
        if (pushDisableEl) pushDisableEl.disabled = true;
        return;
      }
      if (!tokenEl || !tokenEl.value) {
        setPushStatus('Inactivo', 'Iniciá sesión para activar.');
        if (pushEnableEl) pushEnableEl.disabled = true;
        if (pushDisableEl) pushDisableEl.disabled = true;
        return;
      }
      let config = null;
      try {
        config = await fetchPushConfig();
      } catch (err) {
        setPushStatus('Error', err.message || 'No se pudo cargar.');
        if (pushEnableEl) pushEnableEl.disabled = true;
        if (pushDisableEl) pushDisableEl.disabled = true;
        return;
      }
      if (!config.enabled) {
        setPushStatus('Deshabilitado', 'Faltan las llaves VAPID en el server.');
        if (pushEnableEl) pushEnableEl.disabled = true;
        if (pushDisableEl) pushDisableEl.disabled = true;
        return;
      }
      const permission = Notification.permission;
      const sub = await getPushSubscription();
      if (permission === 'denied') {
        setPushStatus('Bloqueadas', 'Habilitá notificaciones en el navegador.');
      } else if (sub) {
        setPushStatus('Activas');
      } else {
        setPushStatus('Inactivas');
      }
      if (pushEnableEl) pushEnableEl.disabled = permission === 'denied';
      if (pushDisableEl) pushDisableEl.disabled = !sub;
    }

    async function enablePush() {
      if (!pushSupported()) return;
      setPushStatus('Activando...');
      const config = await fetchPushConfig();
      if (!config.enabled || !config.publicKey) {
        setPushStatus('Deshabilitado');
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setPushStatus('Bloqueadas', 'Permiso denegado.');
        return;
      }
      const reg = await getPushRegistration();
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(config.publicKey)
      });
      await fetch('/admin/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...portalAuthHeaders() },
        body: JSON.stringify({ subscription: sub })
      });
      setPushStatus('Activas');
      if (pushDisableEl) pushDisableEl.disabled = false;
    }

    async function disablePush() {
      if (!pushSupported()) return;
      setPushStatus('Desactivando...');
      const sub = await getPushSubscription();
      if (sub) {
        await sub.unsubscribe();
        await fetch('/admin/push/unsubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...portalAuthHeaders() },
          body: JSON.stringify({ endpoint: sub.endpoint })
        });
      }
      setPushStatus('Inactivas');
      if (pushDisableEl) pushDisableEl.disabled = true;
    }

    function portalSetStatus(msg, isError) {
      if (!portalStatusEl) return;
      portalStatusEl.textContent = msg || '';
      portalStatusEl.style.color = isError ? '#b42318' : 'var(--primary-dark)';
    }

    function portalFileToDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('file_read_failed'));
        reader.readAsDataURL(file);
      });
    }

    const PORTAL_FONT_PRESETS = [
      {
        id: 'fraunces-manrope',
        heading: 'Fraunces',
        body: 'Manrope',
        url: 'https://fonts.googleapis.com/css2?family=Fraunces:wght@400;600;700&family=Manrope:wght@400;600;700&display=swap'
      },
      {
        id: 'spacegrotesk-dmsans',
        heading: 'Space Grotesk',
        body: 'DM Sans',
        url: 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&family=DM+Sans:wght@400;500;700&display=swap'
      },
      {
        id: 'playfair-sourcesans',
        heading: 'Playfair Display',
        body: 'Source Sans 3',
        url: 'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@500;700&family=Source+Sans+3:wght@400;600&display=swap'
      },
      {
        id: 'cormorant-worksans',
        heading: 'Cormorant Garamond',
        body: 'Work Sans',
        url: 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;700&family=Work+Sans:wght@400;600&display=swap'
      },
      {
        id: 'abril-nunito',
        heading: 'Abril Fatface',
        body: 'Nunito',
        url: 'https://fonts.googleapis.com/css2?family=Abril+Fatface&family=Nunito:wght@400;600;700&display=swap'
      },
      {
        id: 'bebas-assistant',
        heading: 'Bebas Neue',
        body: 'Assistant',
        url: 'https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Assistant:wght@400;600&display=swap'
      }
    ];
    let portalPreviewFontLink = null;

    function portalSetFontLink(url) {
      const value = (url || '').trim();
      if (!value) {
        if (portalPreviewFontLink) {
          portalPreviewFontLink.remove();
          portalPreviewFontLink = null;
        }
        return;
      }
      if (!portalPreviewFontLink) {
        portalPreviewFontLink = document.createElement('link');
        portalPreviewFontLink.id = 'portal-preview-font-link';
        portalPreviewFontLink.rel = 'stylesheet';
        document.head.appendChild(portalPreviewFontLink);
      }
      portalPreviewFontLink.href = value;
    }

    function portalNormalizeHex(value) {
      const raw = (value || '').trim();
      if (!raw) return '';
      const short = raw.match(/^#([0-9a-f]{3})$/i);
      if (short) {
        return '#' + short[1].split('').map((c) => c + c).join('');
      }
      const long = raw.match(/^#([0-9a-f]{6})$/i);
      if (long) return '#' + long[1].toLowerCase();
      return '';
    }

    function portalSyncColorPicker(textEl, pickerEl) {
      if (!textEl || !pickerEl) return;
      const normalized = portalNormalizeHex(textEl.value);
      if (normalized) pickerEl.value = normalized;
    }

    function portalBindColorPicker(textEl, pickerEl) {
      if (!textEl || !pickerEl) return;
      pickerEl.addEventListener('input', () => {
        textEl.value = pickerEl.value;
        portalSyncPreview();
      });
      textEl.addEventListener('input', () => {
        const normalized = portalNormalizeHex(textEl.value);
        if (normalized) pickerEl.value = normalized;
        portalSyncPreview();
      });
    }

    function portalMatchFontPreset() {
      if (!portalFontPresetEl) return;
      const heading = (portalFontHeadingEl && portalFontHeadingEl.value || '').trim();
      const body = (portalFontBodyEl && portalFontBodyEl.value || '').trim();
      const url = (portalFontUrlEl && portalFontUrlEl.value || '').trim();
      const match = PORTAL_FONT_PRESETS.find((preset) => {
        return preset.heading === heading && preset.body === body && preset.url === url;
      });
      portalFontPresetEl.value = match ? match.id : '';
    }

    function portalApplyFontPreset(id) {
      const preset = PORTAL_FONT_PRESETS.find((item) => item.id === id);
      if (!preset) return;
      portalSetVal(portalFontHeadingEl, preset.heading);
      portalSetVal(portalFontBodyEl, preset.body);
      portalSetVal(portalFontUrlEl, preset.url);
      portalSetFontLink(preset.url);
      portalSyncPreview();
    }

    function portalDefaultPage() {
      return {
        slug: '',
        brand: '',
        role: '',
        active: true,
        localeDefault: 'es',
        content: {
          title: { es: 'Trabaja con nosotros', en: 'Work with us' },
          description: { es: 'Sumate al equipo.', en: 'Join the team.' },
          thankYou: { es: 'Gracias! Te contactamos pronto.', en: 'Thanks! We will contact you soon.' },
          sideTitle: { es: 'Dentro del equipo', en: 'Inside the team' },
          sideText: { es: 'Ritmo rapido, crecimiento real, buena cultura.', en: 'Fast pace, real growth, strong culture.' },
          sideNote: { es: 'Turnos flexibles y entrenamiento.', en: 'Flexible shifts and training.' }
        },
        theme: {
          fontHeading: 'Fraunces',
          fontBody: 'Manrope',
          fontUrl: 'https://fonts.googleapis.com/css2?family=Fraunces:wght@400;600;700&family=Manrope:wght@400;600;700&display=swap',
          colorPrimary: '#c84c33',
          colorAccent: '#1f6f5c',
          colorBg: '#f6f2e9',
          colorCard: '#ffffff',
          colorText: '#241b13',
          colorMuted: '#6c5f57'
        },
        assets: { logoUrl: '', heroUrl: '', faviconUrl: '', gallery: [] },
        fields: {
          name: { label: { es: 'Nombre completo', en: 'Full name' }, required: true },
          email: { label: { es: 'Email', en: 'Email' }, required: true },
          phone: { label: { es: 'Telefono', en: 'Phone' }, required: true },
          role: { label: { es: 'Puesto', en: 'Role' }, required: false, options: [] },
          locations: { label: { es: 'Locaciones', en: 'Locations' }, required: false, options: [], layout: 'cards' },
          roleByLocation: {}
        },
        resume: { label: { es: 'CV (PDF)', en: 'Resume (PDF)' }, required: true },
        photo: { label: { es: 'Foto (opcional)', en: 'Photo (optional)' }, required: false },
        questions: []
      };
    }

    function portalApplyDefaults(page) {
      const base = portalDefaultPage();
      const raw = page || {};
      const content = raw.content || {};
      const theme = raw.theme || {};
      const assets = raw.assets || {};
      const fields = raw.fields || {};
      const nameField = fields.name || {};
      const emailField = fields.email || {};
      const phoneField = fields.phone || {};
      const roleField = fields.role || {};
      const locationField = fields.locations || {};
      const roleByLocationField = fields.roleByLocation || {};
      const resumeField = raw.resume || {};
      const photoField = raw.photo || {};

      const merged = {
        ...base,
        ...raw,
        content: {
          ...base.content,
          ...content,
          title: { ...base.content.title, ...(content.title || {}) },
          description: { ...base.content.description, ...(content.description || {}) },
          thankYou: { ...base.content.thankYou, ...(content.thankYou || {}) },
          sideTitle: { ...base.content.sideTitle, ...(content.sideTitle || {}) },
          sideText: { ...base.content.sideText, ...(content.sideText || {}) },
          sideNote: { ...base.content.sideNote, ...(content.sideNote || {}) }
        },
        theme: { ...base.theme, ...theme },
        assets: { ...base.assets, ...assets },
        fields: {
          ...base.fields,
          ...fields,
          name: { ...base.fields.name, ...nameField, label: { ...base.fields.name.label, ...(nameField.label || {}) } },
          email: { ...base.fields.email, ...emailField, label: { ...base.fields.email.label, ...(emailField.label || {}) } },
          phone: { ...base.fields.phone, ...phoneField, label: { ...base.fields.phone.label, ...(phoneField.label || {}) } },
          role: { ...base.fields.role, ...roleField, label: { ...base.fields.role.label, ...(roleField.label || {}) } },
          locations: { ...base.fields.locations, ...locationField, label: { ...base.fields.locations.label, ...(locationField.label || {}) } },
          roleByLocation: { ...(base.fields.roleByLocation || {}), ...roleByLocationField }
        },
        resume: { ...base.resume, ...resumeField, label: { ...base.resume.label, ...(resumeField.label || {}) } },
        photo: { ...base.photo, ...photoField, label: { ...base.photo.label, ...(photoField.label || {}) } },
        questions: Array.isArray(raw.questions) ? raw.questions : []
      };
      merged.fields.role.options = Array.isArray(merged.fields.role.options) ? merged.fields.role.options : [];
      merged.fields.locations.options = Array.isArray(merged.fields.locations.options) ? merged.fields.locations.options : [];
      merged.assets.gallery = Array.isArray(merged.assets.gallery) ? merged.assets.gallery : [];
      return merged;
    }

    function portalFindPageBySlug(slug) {
      return portalPages.find((page) => page.slug === slug) || null;
    }

    function portalRenderList() {
      if (!portalListEl) return;
      portalListEl.innerHTML = '';
      portalPages.forEach((page) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'portal-item' + ((portalCurrent && portalCurrent.slug === page.slug) ? ' active' : '');
        btn.textContent = page.brand || page.slug || 'Sin titulo';
        btn.onclick = () => portalSelectPage(page.slug);
        portalListEl.appendChild(btn);
      });
    }

    function portalRenderAppFilter() {
      if (!portalAppFilterEl) return;
      const prev = portalAppFilterEl.value;
      portalAppFilterEl.innerHTML = '';
      const allOpt = document.createElement('option');
      allOpt.value = '';
      allOpt.textContent = 'Todas';
      portalAppFilterEl.appendChild(allOpt);
      portalPages.forEach((page) => {
        const opt = document.createElement('option');
        opt.value = page.slug;
        opt.textContent = page.brand || page.slug || 'Sin titulo';
        portalAppFilterEl.appendChild(opt);
      });
      if (prev && portalPages.some((page) => page.slug === prev)) {
        portalAppFilterEl.value = prev;
      }
    }

    function portalCollectLocationFilterOptions() {
      const map = new Map();
      portalPages.forEach((page) => {
        const options = page?.fields?.locations?.options || [];
        options.forEach((opt) => {
          if (!opt) return;
          if (typeof opt === 'string') {
            map.set(opt, opt);
            return;
          }
          const key = opt.key || opt.value || '';
          if (!key) return;
          const label = opt.label
            ? (typeof opt.label === 'string' ? opt.label : (opt.label.es || opt.label.en || ''))
            : (opt.es || opt.en || key);
          map.set(key, label || key);
        });
      });
      return Array.from(map.entries()).map(([key, label]) => ({ key, label }));
    }

    function portalRenderLocationFilter() {
      if (!portalAppLocationFilterEl) return;
      const prev = portalAppLocationFilterEl.value;
      portalAppLocationFilterEl.innerHTML = '';
      const allOpt = document.createElement('option');
      allOpt.value = '';
      allOpt.textContent = 'Todas';
      portalAppLocationFilterEl.appendChild(allOpt);
      const options = portalCollectLocationFilterOptions();
      options.forEach((opt) => {
        const option = document.createElement('option');
        option.value = opt.key;
        option.textContent = opt.label || opt.key;
        portalAppLocationFilterEl.appendChild(option);
      });
      if (prev && options.some((opt) => opt.key === prev)) {
        portalAppLocationFilterEl.value = prev;
      } else {
        portalAppLocationFilterEl.value = '';
      }
    }

    function portalUpdateUrl() {
      if (!portalUrlEl || !portalSlugEl) return;
      const slug = (portalSlugEl.value || '').trim();
      if (!slug) {
        portalUrlEl.value = '';
        return;
      }
      const base = window.location.origin.replace(/\\/$/, '');
      portalUrlEl.value = base + '/apply/' + slug;
    }

    function portalSelectPage(slug) {
      const page = portalFindPageBySlug(slug);
      if (!page) return;
      portalCurrent = portalApplyDefaults(JSON.parse(JSON.stringify(page)));
      portalPendingUploads = { logo: null, hero: null, favicon: null, gallery: [] };
      portalFillForm();
      portalRenderList();
      portalUpdateUrl();
      if (portalAppFilterEl) {
        portalAppFilterEl.value = slug;
      }
      portalLoadApplications().catch(() => {});
    }

    function portalSetVal(el, value) {
      if (el) el.value = value || '';
    }

    function portalSetChecked(el, on) {
      if (el) el.checked = !!on;
    }

    function portalFillForm() {
      if (!portalCurrent) portalCurrent = portalApplyDefaults({});
      const page = portalApplyDefaults(portalCurrent);
      portalCurrent = page;
      portalSetVal(portalSlugEl, page.slug || '');
      portalSetVal(portalBrandEl, page.brand || '');
      if (portalLangEl) portalLangEl.value = page.localeDefault === 'en' ? 'en' : 'es';
      if (portalActiveEl) portalActiveEl.value = page.active === false ? 'false' : 'true';

      portalSetVal(portalTitleEsEl, page.content.title.es || '');
      portalSetVal(portalTitleEnEl, page.content.title.en || '');
      portalSetVal(portalDescEsEl, page.content.description.es || '');
      portalSetVal(portalDescEnEl, page.content.description.en || '');
      portalSetVal(portalSideTitleEsEl, page.content.sideTitle?.es || '');
      portalSetVal(portalSideTitleEnEl, page.content.sideTitle?.en || '');
      portalSetVal(portalSideTextEsEl, page.content.sideText?.es || '');
      portalSetVal(portalSideTextEnEl, page.content.sideText?.en || '');
      portalSetVal(portalSideNoteEsEl, page.content.sideNote?.es || '');
      portalSetVal(portalSideNoteEnEl, page.content.sideNote?.en || '');
      portalSetVal(portalThanksEsEl, page.content.thankYou.es || '');
      portalSetVal(portalThanksEnEl, page.content.thankYou.en || '');

      portalSetVal(portalFontHeadingEl, page.theme.fontHeading || '');
      portalSetVal(portalFontBodyEl, page.theme.fontBody || '');
      portalSetVal(portalFontUrlEl, page.theme.fontUrl || '');
      portalSetVal(portalColorPrimaryEl, page.theme.colorPrimary || '');
      portalSetVal(portalColorAccentEl, page.theme.colorAccent || '');
      portalSetVal(portalColorBgEl, page.theme.colorBg || '');
      portalSetVal(portalColorCardEl, page.theme.colorCard || '');
      portalSetVal(portalColorTextEl, page.theme.colorText || '');
      portalSetVal(portalColorMutedEl, page.theme.colorMuted || '');

      portalSetVal(portalLogoUrlEl, page.assets.logoUrl || '');
      portalSetVal(portalHeroUrlEl, page.assets.heroUrl || '');
      portalSetVal(portalFaviconUrlEl, page.assets.faviconUrl || '');
      portalSetVal(portalGalleryUrlsEl, (page.assets.gallery || []).join('\\n'));

      portalSetVal(portalNameEsEl, page.fields.name.label.es || '');
      portalSetVal(portalNameEnEl, page.fields.name.label.en || '');
      portalSetChecked(portalNameReqEl, page.fields.name.required !== false);

      portalSetVal(portalEmailEsEl, page.fields.email.label.es || '');
      portalSetVal(portalEmailEnEl, page.fields.email.label.en || '');
      portalSetChecked(portalEmailReqEl, page.fields.email.required !== false);

      portalSetVal(portalPhoneEsEl, page.fields.phone.label.es || '');
      portalSetVal(portalPhoneEnEl, page.fields.phone.label.en || '');
      portalSetChecked(portalPhoneReqEl, page.fields.phone.required !== false);

      portalSetVal(portalRoleEsEl, page.fields.role.label.es || '');
      portalSetVal(portalRoleEnEl, page.fields.role.label.en || '');
      portalSetChecked(portalRoleReqEl, !!page.fields.role.required);
      const roleOptions = (page.fields.role.options || []).map((opt) => {
        if (typeof opt === 'string') return opt;
        return opt.es || opt.en || opt.value || '';
      }).filter(Boolean);
      portalSetVal(portalRoleOptionsEl, roleOptions.join('\\n'));

      portalSetVal(portalLocationEsEl, page.fields.locations.label.es || '');
      portalSetVal(portalLocationEnEl, page.fields.locations.label.en || '');
      portalSetChecked(portalLocationReqEl, !!page.fields.locations.required);
      if (portalLocationLayoutEl) {
        portalLocationLayoutEl.value = page.fields.locations.layout || 'cards';
      }
      portalRenderLocationOptions();
      portalRenderRoleByLocation();

      portalSetVal(portalResumeEsEl, page.resume.label.es || '');
      portalSetVal(portalResumeEnEl, page.resume.label.en || '');
      portalSetChecked(portalResumeReqEl, !!page.resume.required);

      portalSetVal(portalPhotoEsEl, page.photo.label.es || '');
      portalSetVal(portalPhotoEnEl, page.photo.label.en || '');
      portalSetChecked(portalPhotoReqEl, !!page.photo.required);

      portalRenderQuestions();
      portalUpdateUrl();
      portalMatchFontPreset();
      portalSyncPreview();
    }

    function portalRenderQuestions() {
      if (!portalQuestionListEl) return;
      portalQuestionListEl.innerHTML = '';
      const questions = portalCurrent && Array.isArray(portalCurrent.questions) ? portalCurrent.questions : [];
      questions.forEach((q, idx) => {
        const wrap = document.createElement('div');
        wrap.className = 'portal-question';
        wrap.dataset.qid = q.id || ('q_' + Date.now() + '_' + idx);
        wrap.innerHTML = [
          '<div class="grid">',
          '  <div>',
          '    <label>Label (ES)</label>',
          '    <input data-q="label-es" />',
          '  </div>',
          '  <div>',
          '    <label>Label (EN)</label>',
          '    <input data-q="label-en" />',
          '  </div>',
          '  <div>',
          '    <label>Tipo</label>',
          '    <select data-q="type">',
          '      <option value="short">Texto corto</option>',
          '      <option value="long">Texto largo</option>',
          '      <option value="select">Opciones</option>',
          '      <option value="yesno">Si/No</option>',
          '    </select>',
          '  </div>',
          '  <div class="check-row">',
          '    <input type="checkbox" data-q="required" />',
          '    <span class="small">Requerida</span>',
          '  </div>',
          '</div>',
          '<div>',
          '  <label>Opciones (una por linea)</label>',
          '  <textarea data-q="options"></textarea>',
          '</div>',
          '<div class="inline">',
          '  <button class="secondary" data-q="remove" type="button">Eliminar</button>',
          '</div>'
        ].join('');
        wrap.querySelector('[data-q="label-es"]').value = (q.label && q.label.es) || '';
        wrap.querySelector('[data-q="label-en"]').value = (q.label && q.label.en) || '';
        wrap.querySelector('[data-q="type"]').value = q.type || 'short';
        wrap.querySelector('[data-q="required"]').checked = !!q.required;
        wrap.querySelector('[data-q="options"]').value = (q.options || []).map((opt) => {
          if (typeof opt === 'string') return opt;
          return opt.es || opt.en || '';
        }).join('\\n');
        wrap.querySelector('[data-q="remove"]').onclick = () => {
          wrap.remove();
          if (portalCurrent) {
            portalCurrent.questions = portalReadQuestions();
          }
        };
        portalQuestionListEl.appendChild(wrap);
      });
    }

    function portalReadLocationOptions() {
      if (!portalLocationOptionsEl) return [];
      const selected = [];
      portalLocationOptionsEl.querySelectorAll('input[type="checkbox"]').forEach((input) => {
        if (!input.checked) return;
        const key = input.dataset.key || input.value || '';
        if (!key) return;
        const label = input.dataset.label || key;
        const address = input.dataset.address || '';
        const entry = { key, label: { es: label, en: label } };
        if (address) entry.address = address;
        selected.push(entry);
      });
      return selected;
    }

    function portalRenderLocationOptions() {
      if (!portalLocationOptionsEl) return;
      const brands = listBrandOptions();
      const selectedKeys = new Set();
      const optionLabels = new Map();
      const optionAddresses = new Map();
      const currentOptions = portalCurrent && portalCurrent.fields && portalCurrent.fields.locations
        ? portalCurrent.fields.locations.options
        : null;
      if (Array.isArray(currentOptions)) {
        currentOptions.forEach((opt) => {
          const key = typeof opt === 'string' ? opt : (opt.key || opt.value || '');
          if (key) selectedKeys.add(key);
          if (key) {
            const label = typeof opt === 'string'
              ? opt
              : (opt.label && (opt.label.es || opt.label.en)) || opt.es || opt.en || key;
            optionLabels.set(key, label || key);
            if (opt && opt.address) {
              const addr = typeof opt.address === 'string'
                ? opt.address
                : (opt.address.es || opt.address.en || '');
              if (addr) optionAddresses.set(key, addr);
            }
          }
        });
      }
      portalLocationOptionsEl.innerHTML = '';
      if (!brands.length) {
        const empty = document.createElement('div');
        empty.className = 'small';
        empty.textContent = 'No hay locaciones disponibles.';
        portalLocationOptionsEl.appendChild(empty);
        return;
      }
      const knownKeys = new Set();
      brands.forEach((brand) => {
        knownKeys.add(brand.key);
        const label = document.createElement('label');
        label.className = 'portal-location-option';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.dataset.key = brand.key;
        input.dataset.label = brand.display || brand.key;
        if (brand.address) input.dataset.address = brand.address;
        if (selectedKeys.has(brand.key)) input.checked = true;
        input.addEventListener('change', () => {
          if (portalCurrent) {
            portalCurrent.fields.locations.options = portalReadLocationOptions();
          }
          portalSyncPreview();
        });
        label.appendChild(input);
        label.appendChild(document.createTextNode(brand.display || brand.key));
        portalLocationOptionsEl.appendChild(label);
      });
      optionLabels.forEach((labelText, key) => {
        if (knownKeys.has(key)) return;
        const label = document.createElement('label');
        label.className = 'portal-location-option';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.dataset.key = key;
        input.dataset.label = labelText || key;
        if (optionAddresses.has(key)) input.dataset.address = optionAddresses.get(key);
        input.checked = selectedKeys.has(key);
        input.addEventListener('change', () => {
          if (portalCurrent) {
            portalCurrent.fields.locations.options = portalReadLocationOptions();
          }
          portalSyncPreview();
        });
        label.appendChild(input);
        label.appendChild(document.createTextNode(labelText || key));
        portalLocationOptionsEl.appendChild(label);
      });
      portalRenderRoleByLocation();
    }

    function portalRenderRoleByLocation() {
      if (!portalRoleLocationListEl) return;
      portalRoleLocationListEl.innerHTML = '';
      const locations = portalReadLocationOptions();
      const roleMap = (portalCurrent && portalCurrent.fields && portalCurrent.fields.roleByLocation) ? portalCurrent.fields.roleByLocation : {};
      locations.forEach((loc) => {
        const key = loc.key || loc.value || '';
        if (!key) return;
        const labelText = (loc.label && (loc.label.es || loc.label.en)) || loc.label || key;
        let options = roleMap[key];
        if (!Array.isArray(options) || !options.length) {
          const defaults = portalRoleOptionsFromBrandKey(key);
          if (defaults.length) {
            options = defaults.map((val) => ({ es: val, en: val }));
          }
        }
        const lines = Array.isArray(options)
          ? options.map((opt) => {
            if (!opt) return '';
            if (typeof opt === 'string') return opt;
            return opt.es || opt.en || opt.value || opt.key || '';
          }).filter(Boolean).join('\\n')
          : '';
        const block = document.createElement('div');
        block.className = 'portal-question';
        block.innerHTML = [
          '<div style="font-weight:700;">' + labelText + '</div>',
          '<label class="small">Roles (una por linea)</label>',
          '<textarea data-role-location="' + key + '"></textarea>'
        ].join('');
        const textarea = block.querySelector('textarea');
        textarea.value = lines;
        textarea.addEventListener('input', () => {
          if (portalCurrent) {
            portalCurrent.fields.roleByLocation = portalReadRoleByLocation();
          }
        });
        portalRoleLocationListEl.appendChild(block);
      });
    }

    function portalReadRoleByLocation() {
      if (!portalRoleLocationListEl) return {};
      const result = {};
      portalRoleLocationListEl.querySelectorAll('textarea[data-role-location]').forEach((textarea) => {
        const key = textarea.dataset.roleLocation || '';
        if (!key) return;
        const values = (textarea.value || '').split(/\\n+/).map((v) => v.trim()).filter(Boolean);
        if (!values.length) return;
        result[key] = values.map((val) => ({ es: val, en: val }));
      });
      return result;
    }

    function portalReadQuestions() {
      if (!portalQuestionListEl) return [];
      const items = [];
      Array.from(portalQuestionListEl.children).forEach((wrap, idx) => {
        const labelEs = wrap.querySelector('[data-q="label-es"]').value.trim();
        const labelEn = wrap.querySelector('[data-q="label-en"]').value.trim();
        const type = wrap.querySelector('[data-q="type"]').value;
        const required = wrap.querySelector('[data-q="required"]').checked;
        const optionsRaw = wrap.querySelector('[data-q="options"]').value;
        const options = optionsRaw.split(/\\n+/).map((v) => v.trim()).filter(Boolean).map((v) => ({ es: v, en: v }));
        const id = wrap.dataset.qid || ('q_' + Date.now() + '_' + idx);
        items.push({
          id,
          label: { es: labelEs, en: labelEn },
          type,
          required,
          options: type === 'select' ? options : []
        });
      });
      return items;
    }

    function portalReadForm() {
      const data = portalDefaultPage();
      data.slug = (portalSlugEl && portalSlugEl.value || '').trim();
      data.brand = (portalBrandEl && portalBrandEl.value || '').trim();
      data.localeDefault = portalLangEl && portalLangEl.value === 'en' ? 'en' : 'es';
      data.active = portalActiveEl && portalActiveEl.value === 'false' ? false : true;

      data.content.title.es = (portalTitleEsEl && portalTitleEsEl.value || '').trim();
      data.content.title.en = (portalTitleEnEl && portalTitleEnEl.value || '').trim();
      data.content.description.es = (portalDescEsEl && portalDescEsEl.value || '').trim();
      data.content.description.en = (portalDescEnEl && portalDescEnEl.value || '').trim();
      data.content.sideTitle.es = (portalSideTitleEsEl && portalSideTitleEsEl.value || '').trim();
      data.content.sideTitle.en = (portalSideTitleEnEl && portalSideTitleEnEl.value || '').trim();
      data.content.sideText.es = (portalSideTextEsEl && portalSideTextEsEl.value || '').trim();
      data.content.sideText.en = (portalSideTextEnEl && portalSideTextEnEl.value || '').trim();
      data.content.sideNote.es = (portalSideNoteEsEl && portalSideNoteEsEl.value || '').trim();
      data.content.sideNote.en = (portalSideNoteEnEl && portalSideNoteEnEl.value || '').trim();
      data.content.thankYou.es = (portalThanksEsEl && portalThanksEsEl.value || '').trim();
      data.content.thankYou.en = (portalThanksEnEl && portalThanksEnEl.value || '').trim();

      data.theme.fontHeading = (portalFontHeadingEl && portalFontHeadingEl.value || '').trim();
      data.theme.fontBody = (portalFontBodyEl && portalFontBodyEl.value || '').trim();
      data.theme.fontUrl = (portalFontUrlEl && portalFontUrlEl.value || '').trim();
      data.theme.colorPrimary = (portalColorPrimaryEl && portalColorPrimaryEl.value || '').trim();
      data.theme.colorAccent = (portalColorAccentEl && portalColorAccentEl.value || '').trim();
      data.theme.colorBg = (portalColorBgEl && portalColorBgEl.value || '').trim();
      data.theme.colorCard = (portalColorCardEl && portalColorCardEl.value || '').trim();
      data.theme.colorText = (portalColorTextEl && portalColorTextEl.value || '').trim();
      data.theme.colorMuted = (portalColorMutedEl && portalColorMutedEl.value || '').trim();

      data.assets.logoUrl = (portalLogoUrlEl && portalLogoUrlEl.value || '').trim();
      data.assets.heroUrl = (portalHeroUrlEl && portalHeroUrlEl.value || '').trim();
      data.assets.faviconUrl = (portalFaviconUrlEl && portalFaviconUrlEl.value || '').trim();
      const galleryRaw = (portalGalleryUrlsEl && portalGalleryUrlsEl.value || '');
      data.assets.gallery = galleryRaw.split(/\\n+/).map((v) => v.trim()).filter(Boolean);

      data.fields.name = {
        label: {
          es: (portalNameEsEl && portalNameEsEl.value || '').trim(),
          en: (portalNameEnEl && portalNameEnEl.value || '').trim()
        },
        required: portalNameReqEl ? portalNameReqEl.checked : true
      };
      data.fields.email = {
        label: {
          es: (portalEmailEsEl && portalEmailEsEl.value || '').trim(),
          en: (portalEmailEnEl && portalEmailEnEl.value || '').trim()
        },
        required: portalEmailReqEl ? portalEmailReqEl.checked : true
      };
      data.fields.phone = {
        label: {
          es: (portalPhoneEsEl && portalPhoneEsEl.value || '').trim(),
          en: (portalPhoneEnEl && portalPhoneEnEl.value || '').trim()
        },
        required: portalPhoneReqEl ? portalPhoneReqEl.checked : true
      };
      const roleOptionsRaw = (portalRoleOptionsEl && portalRoleOptionsEl.value || '');
      const roleOptions = roleOptionsRaw.split(/\\n+/).map((v) => v.trim()).filter(Boolean).map((v) => ({ es: v, en: v }));
      data.fields.role = {
        label: {
          es: (portalRoleEsEl && portalRoleEsEl.value || '').trim(),
          en: (portalRoleEnEl && portalRoleEnEl.value || '').trim()
        },
        required: portalRoleReqEl ? portalRoleReqEl.checked : false,
        options: roleOptions
      };

      data.fields.locations = {
        label: {
          es: (portalLocationEsEl && portalLocationEsEl.value || '').trim(),
          en: (portalLocationEnEl && portalLocationEnEl.value || '').trim()
        },
        required: portalLocationReqEl ? portalLocationReqEl.checked : false,
        options: portalReadLocationOptions(),
        layout: portalLocationLayoutEl ? (portalLocationLayoutEl.value || 'cards') : 'cards'
      };
      data.fields.roleByLocation = portalReadRoleByLocation();

      data.resume = {
        label: {
          es: (portalResumeEsEl && portalResumeEsEl.value || '').trim(),
          en: (portalResumeEnEl && portalResumeEnEl.value || '').trim()
        },
        required: portalResumeReqEl ? portalResumeReqEl.checked : false
      };
      data.photo = {
        label: {
          es: (portalPhotoEsEl && portalPhotoEsEl.value || '').trim(),
          en: (portalPhotoEnEl && portalPhotoEnEl.value || '').trim()
        },
        required: portalPhotoReqEl ? portalPhotoReqEl.checked : false
      };

      data.questions = portalReadQuestions();
      return data;
    }

    function portalPreviewImage(kind) {
      if (kind === 'logo') {
        if (portalPendingUploads.logo && portalPendingUploads.logo.dataUrl) return portalPendingUploads.logo.dataUrl;
        return (portalLogoUrlEl && portalLogoUrlEl.value || '').trim();
      }
      if (kind === 'hero') {
        if (portalPendingUploads.hero && portalPendingUploads.hero.dataUrl) return portalPendingUploads.hero.dataUrl;
        return (portalHeroUrlEl && portalHeroUrlEl.value || '').trim();
      }
      return '';
    }

    function portalPreviewGalleryUrls() {
      if (portalPendingUploads.gallery && portalPendingUploads.gallery.length) {
        return portalPendingUploads.gallery.map((item) => item.dataUrl).filter(Boolean);
      }
      const raw = (portalGalleryUrlsEl && portalGalleryUrlsEl.value || '').trim();
      if (!raw) return [];
      return raw.split(/\\n+/).map((value) => value.trim()).filter(Boolean);
    }

    function portalSplitChips(value) {
      if (!value) return [];
      const normalized = String(value || '')
        .replace(/\\r/g, '\\n')
        .replace(/[•·]/g, '\\n');
      return normalized
        .split(/\\n+/)
        .map((part) => part.replace(/^[-–—\\s]+/, '').trim())
        .filter(Boolean);
    }

    function portalSyncPreview() {
      if (!portalPreviewEl) return;
      portalSyncColorPicker(portalColorPrimaryEl, portalColorPrimaryPickerEl);
      portalSyncColorPicker(portalColorAccentEl, portalColorAccentPickerEl);
      portalSyncColorPicker(portalColorBgEl, portalColorBgPickerEl);
      portalSyncColorPicker(portalColorCardEl, portalColorCardPickerEl);
      portalSyncColorPicker(portalColorTextEl, portalColorTextPickerEl);
      portalSyncColorPicker(portalColorMutedEl, portalColorMutedPickerEl);

      const brand = (portalBrandEl && portalBrandEl.value || '').trim() || (portalSlugEl && portalSlugEl.value || 'Restaurante');
      const title = (portalTitleEsEl && portalTitleEsEl.value || '').trim()
        || (portalTitleEnEl && portalTitleEnEl.value || '').trim()
        || ('Trabaja en ' + brand);
      const desc = (portalDescEsEl && portalDescEsEl.value || '').trim()
        || (portalDescEnEl && portalDescEnEl.value || '').trim()
        || 'Sumate al equipo.';
      const sideTitle = (portalSideTitleEsEl && portalSideTitleEsEl.value || '').trim()
        || (portalSideTitleEnEl && portalSideTitleEnEl.value || '').trim()
        || 'Inside the team';
      const sideText = (portalSideTextEsEl && portalSideTextEsEl.value || '').trim()
        || (portalSideTextEnEl && portalSideTextEnEl.value || '').trim()
        || 'Fast pace, real growth, strong culture.';
      const sideNote = (portalSideNoteEsEl && portalSideNoteEsEl.value || '').trim()
        || (portalSideNoteEnEl && portalSideNoteEnEl.value || '').trim()
        || 'Flexible shifts and training.';
      const nameLabel = (portalNameEsEl && portalNameEsEl.value || '').trim() || 'Nombre completo';
      const emailLabel = (portalEmailEsEl && portalEmailEsEl.value || '').trim() || 'Email';
      const phoneLabel = (portalPhoneEsEl && portalPhoneEsEl.value || '').trim() || 'Telefono';
      const roleLabel = (portalRoleEsEl && portalRoleEsEl.value || '').trim() || 'Puesto';
      const locationLabel = (portalLocationEsEl && portalLocationEsEl.value || '').trim()
        || (portalLocationEnEl && portalLocationEnEl.value || '').trim()
        || 'Locaciones';
      const locationLayout = (portalLocationLayoutEl && portalLocationLayoutEl.value || 'cards').trim() || 'cards';

      if (portalPreviewBrandEl) portalPreviewBrandEl.textContent = brand;
      if (portalPreviewTitleEl) portalPreviewTitleEl.textContent = title;
      if (portalPreviewDescEl) portalPreviewDescEl.textContent = desc;
      if (portalPreviewNameLabelEl) portalPreviewNameLabelEl.textContent = nameLabel;
      if (portalPreviewEmailLabelEl) portalPreviewEmailLabelEl.textContent = emailLabel;
      if (portalPreviewPhoneLabelEl) portalPreviewPhoneLabelEl.textContent = phoneLabel;
      if (portalPreviewRoleLabelEl) portalPreviewRoleLabelEl.textContent = roleLabel;
      if (portalPreviewLocationLabelEl) portalPreviewLocationLabelEl.textContent = locationLabel;
      if (portalPreviewSideTitleEl) portalPreviewSideTitleEl.textContent = sideTitle;
      if (portalPreviewSideEl) portalPreviewSideEl.textContent = sideText;
      if (portalPreviewSideNoteEl) {
        portalPreviewSideNoteEl.innerHTML = '';
        const chips = portalSplitChips(sideNote);
        if (chips.length) {
          chips.forEach((item) => {
            const chip = document.createElement('span');
            chip.className = 'portal-preview-chip';
            chip.textContent = item;
            portalPreviewSideNoteEl.appendChild(chip);
          });
          portalPreviewSideNoteEl.style.display = '';
        } else {
          portalPreviewSideNoteEl.style.display = 'none';
        }
      }

      const logoUrl = portalPreviewImage('logo');
      if (portalPreviewLogoEl) {
        if (logoUrl) {
          portalPreviewLogoEl.src = logoUrl;
          portalPreviewLogoEl.style.display = '';
        } else {
          portalPreviewLogoEl.removeAttribute('src');
          portalPreviewLogoEl.style.display = 'none';
        }
      }

      const heroUrl = portalPreviewImage('hero');
      if (portalPreviewHeroEl) {
        if (heroUrl) {
          portalPreviewHeroEl.style.backgroundImage = 'url(' + heroUrl + ')';
          portalPreviewHeroEl.textContent = '';
        } else {
          portalPreviewHeroEl.style.backgroundImage = 'none';
          portalPreviewHeroEl.textContent = 'Hero image';
        }
      }

      if (portalPreviewGalleryEl) {
        portalPreviewGalleryEl.innerHTML = '';
        const galleryUrls = portalPreviewGalleryUrls();
        if (galleryUrls.length) {
          galleryUrls.slice(0, 4).forEach((url) => {
            const img = document.createElement('img');
            img.src = url;
            img.alt = 'Gallery';
            portalPreviewGalleryEl.appendChild(img);
          });
        }
      }

      if (portalPreviewLocationInputEl && portalPreviewLocationFieldEl) {
        const locationOptions = portalReadLocationOptions();
        portalPreviewLocationInputEl.innerHTML = '';
        portalPreviewLocationInputEl.className = 'portal-preview-field-input portal-preview-field-list layout-' + locationLayout;
        if (locationOptions.length) {
          locationOptions.slice(0, 4).forEach((opt) => {
            let label = '';
            if (opt) {
              if (typeof opt.label === 'string') label = opt.label;
              else if (opt.label) label = opt.label.es || opt.label.en || '';
              if (!label) label = opt.key || opt.value || '';
            }
            if (!label) return;
            const chip = document.createElement('div');
            chip.className = 'portal-preview-chip';
            chip.textContent = label;
            portalPreviewLocationInputEl.appendChild(chip);
          });
          portalPreviewLocationFieldEl.style.display = '';
        } else {
          portalPreviewLocationFieldEl.style.display = 'none';
        }
      }

      const heading = (portalFontHeadingEl && portalFontHeadingEl.value || 'Fraunces').trim() || 'Fraunces';
      const body = (portalFontBodyEl && portalFontBodyEl.value || 'Manrope').trim() || 'Manrope';
      portalPreviewEl.style.setProperty('--p-heading', '"' + heading + '", serif');
      portalPreviewEl.style.setProperty('--p-body', '"' + body + '", sans-serif');

      const primary = portalNormalizeHex((portalColorPrimaryEl && portalColorPrimaryEl.value) || '') || '#c84c33';
      const accent = portalNormalizeHex((portalColorAccentEl && portalColorAccentEl.value) || '') || '#1f6f5c';
      const bg = portalNormalizeHex((portalColorBgEl && portalColorBgEl.value) || '') || '#f6f2e9';
      const card = portalNormalizeHex((portalColorCardEl && portalColorCardEl.value) || '') || '#ffffff';
      const text = portalNormalizeHex((portalColorTextEl && portalColorTextEl.value) || '') || '#241b13';
      const muted = portalNormalizeHex((portalColorMutedEl && portalColorMutedEl.value) || '') || '#6c5f57';

      portalPreviewEl.style.setProperty('--p-primary', primary);
      portalPreviewEl.style.setProperty('--p-accent', accent);
      portalPreviewEl.style.setProperty('--p-bg', bg);
      portalPreviewEl.style.setProperty('--p-card', card);
      portalPreviewEl.style.setProperty('--p-text', text);
      portalPreviewEl.style.setProperty('--p-muted', muted);

      if (portalFontUrlEl) {
        portalSetFontLink(portalFontUrlEl.value);
      }
    }

    function portalHandlePreviewSync(event) {
      if (event && event.target) {
        if (event.target === portalFontHeadingEl || event.target === portalFontBodyEl || event.target === portalFontUrlEl) {
          portalMatchFontPreset();
        }
      }
      portalSyncPreview();
    }

    function portalBuildAnswerText(app) {
      const page = portalFindPageBySlug(app.slug);
      if (!page || !Array.isArray(page.questions) || !app.answers) return '';
      return page.questions.map((q) => {
        const key = q && q.id ? q.id : '';
        if (!key) return '';
        const val = app.answers[key];
        if (!val) return '';
        const label = (q.label && (q.label.es || q.label.en)) || key;
        return label + ': ' + val;
      }).filter(Boolean).join('\\n');
    }

    function portalFormatLocationLabels(app) {
      const list = Array.isArray(app.locations) ? app.locations : [];
      if (!list.length) return '';
      return list.map((loc) => {
        if (!loc) return '';
        if (typeof loc === 'string') return loc;
        if (loc.label) {
          if (typeof loc.label === 'string') return loc.label;
          return loc.label.es || loc.label.en || loc.key || '';
        }
        return loc.key || '';
      }).filter(Boolean).join(', ');
    }

    function portalAddTextCell(row, text, className) {
      const td = document.createElement('td');
      if (className) td.className = className;
      td.textContent = text || '—';
      row.appendChild(td);
      return td;
    }

    function portalAddLinkCell(row, url, label) {
      const td = document.createElement('td');
      if (url) {
        const link = document.createElement('a');
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = label;
        td.appendChild(link);
      } else {
        td.textContent = '—';
      }
      row.appendChild(td);
      return td;
    }

    function resolveSeenKey(baseKey) {
      const suffix = (authEmail || '').trim().toLowerCase() || authRole || 'viewer';
      return baseKey + ':' + suffix;
    }

    function resolveUserScopedKey(baseKey) {
      return resolveSeenKey(baseKey);
    }

    function getSeenTimestamp(key) {
      try {
        const raw = localStorage.getItem(resolveSeenKey(key));
        return raw ? Number(raw) : 0;
      } catch (err) {
        return 0;
      }
    }

    function setSeenTimestamp(key, ts) {
      try {
        localStorage.setItem(resolveSeenKey(key), String(ts || Date.now()));
      } catch (err) {}
    }

    function loadViewMode(baseKey, fallback = 'table') {
      try {
        const raw = localStorage.getItem(resolveUserScopedKey(baseKey)) || '';
        return raw === 'swipe' ? 'swipe' : fallback;
      } catch (err) {
        return fallback;
      }
    }

    function saveViewMode(baseKey, mode) {
      try {
        localStorage.setItem(resolveUserScopedKey(baseKey), mode === 'swipe' ? 'swipe' : 'table');
      } catch (err) {}
    }

    function updateViewSwitch(el, mode) {
      if (!el) return;
      el.querySelectorAll('button[data-mode]').forEach((btn) => {
        const btnMode = btn.dataset.mode === 'swipe' ? 'swipe' : 'table';
        btn.classList.toggle('active', btnMode === mode);
      });
    }

    function isUnseenPortalItem(createdAt, source, lastSeen) {
      const created = createdAt ? new Date(createdAt).getTime() : 0;
      if (!created || created <= lastSeen) return false;
      return isPortalSource(source);
    }

    function applyCvViewMode(mode, { persist = true } = {}) {
      cvViewMode = mode === 'swipe' ? 'swipe' : 'table';
      if (persist) saveViewMode(CV_VIEW_MODE_KEY, cvViewMode);
      updateViewSwitch(cvViewSwitchEl, cvViewMode);
      if (cvTableWrapperEl) cvTableWrapperEl.style.display = cvViewMode === 'table' ? '' : 'none';
      if (cvSwipeViewEl) cvSwipeViewEl.style.display = cvViewMode === 'swipe' ? '' : 'none';
      if (cvViewMode === 'swipe') {
        renderCvSwipe();
      } else if (lastCvRaw.length) {
        renderCvList(lastCvRaw);
      }
    }

    function applyResultsViewMode(mode, { persist = true } = {}) {
      resultsViewMode = mode === 'swipe' ? 'swipe' : 'table';
      if (persist) saveViewMode(RESULTS_VIEW_MODE_KEY, resultsViewMode);
      updateViewSwitch(resultsViewSwitchEl, resultsViewMode);
      if (resultsTableWrapperEl) resultsTableWrapperEl.style.display = resultsViewMode === 'table' ? '' : 'none';
      if (resultsSwipeViewEl) resultsSwipeViewEl.style.display = resultsViewMode === 'swipe' ? '' : 'none';
      if (resultsViewMode === 'swipe') {
        renderResultsSwipe();
      } else if (lastResultsRaw.length) {
        renderResults(lastResultsRaw);
      }
    }

    function refreshViewModesFromStorage() {
      const cvMode = loadViewMode(CV_VIEW_MODE_KEY, 'table');
      const resultsMode = loadViewMode(RESULTS_VIEW_MODE_KEY, 'table');
      applyCvViewMode(cvMode, { persist: false });
      applyResultsViewMode(resultsMode, { persist: false });
    }

    function buildSwipeRow(label, value) {
      const row = document.createElement('div');
      row.className = 'swipe-row';
      const labelEl = document.createElement('div');
      labelEl.className = 'swipe-label';
      labelEl.textContent = label;
      row.appendChild(labelEl);
      const valueEl = document.createElement('div');
      valueEl.className = 'swipe-value';
      if (value instanceof Node) {
        valueEl.appendChild(value);
      } else {
        valueEl.textContent = value || '—';
      }
      row.appendChild(valueEl);
      return row;
    }

    function attachSwipeNavigation(el, onPrev, onNext) {
      if (!el || el._swipeBound) return;
      let startX = 0;
      let startY = 0;
      el.addEventListener('touchstart', (event) => {
        const touch = event.touches && event.touches[0];
        if (!touch) return;
        startX = touch.clientX;
        startY = touch.clientY;
      }, { passive: true });
      el.addEventListener('touchend', (event) => {
        const touch = event.changedTouches && event.changedTouches[0];
        if (!touch) return;
        const dx = touch.clientX - startX;
        const dy = touch.clientY - startY;
        if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy)) return;
        if (dx > 0) onPrev();
        else onNext();
      });
      el._swipeBound = true;
    }

    function renderCvSwipe() {
      if (!cvSwipeCardEl) return;
      const list = Array.isArray(lastCvFiltered) ? lastCvFiltered : [];
      const total = list.length;
      if (!total) {
        if (cvSwipeCountEl) cvSwipeCountEl.textContent = '0 / 0';
        cvSwipeCardEl.innerHTML = '<div class="swipe-empty">No hay candidates para este filtro.</div>';
        return;
      }
      if (cvSwipeIndex >= total) cvSwipeIndex = total - 1;
      if (cvSwipeIndex < 0) cvSwipeIndex = 0;
      const item = list[cvSwipeIndex];
      const lastSeen = getSeenTimestamp(CANDIDATES_SEEN_KEY);
      const isNew = isUnseenPortalItem(item.created_at, item.source, lastSeen);
      if (cvSwipeCountEl) cvSwipeCountEl.textContent = (cvSwipeIndex + 1) + ' / ' + total;

      const card = document.createElement('div');
      card.className = 'swipe-card' + (isNew ? ' is-new' : '');

      const top = document.createElement('div');
      top.className = 'swipe-top';
      const titleWrap = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'swipe-title';
      title.textContent = item.applicant || 'Sin nombre';
      titleWrap.appendChild(title);
      const brandLabel = item.brandKey ? getBrandDisplayByKey(item.brandKey) : (item.brand || '');
      const roleLabel = getRoleDisplayForBrand(item.brandKey || item.brand, item.role || item.roleKey || '');
      const sub = document.createElement('div');
      sub.className = 'swipe-sub';
      sub.textContent = [brandLabel, roleLabel].filter(Boolean).join(' • ');
      titleWrap.appendChild(sub);
      top.appendChild(titleWrap);
      if (item.cv_photo_url) {
        const avatar = document.createElement('img');
        avatar.src = item.cv_photo_url;
        avatar.alt = '';
        avatar.className = 'swipe-avatar';
        avatar.style.objectPosition = '50% 30%';
        attachAvatarHandlers(avatar, item.cv_photo_url);
        top.appendChild(avatar);
      }
      card.appendChild(top);

      const infoSection = document.createElement('div');
      infoSection.className = 'swipe-section';
      infoSection.appendChild(buildSwipeRow('Fecha', formatDate(item.created_at)));
      infoSection.appendChild(buildSwipeRow('Local', brandLabel));
      infoSection.appendChild(buildSwipeRow('Posición', roleLabel));
      infoSection.appendChild(buildSwipeRow('Teléfono', item.phone || '—'));
      const info = cvStatusInfo(item);
      infoSection.appendChild(buildSwipeRow('Estado', info.statusText || '—'));
      card.appendChild(infoSection);

      const decisionSection = document.createElement('div');
      decisionSection.className = 'swipe-section';
      const decisionWrap = document.createElement('div');
      decisionWrap.className = 'decision-buttons';
      const decisionOptions = [
        { key: 'approved', label: '✓', title: 'Aprobado' },
        { key: 'declined', label: '✕', title: 'Declinado' },
        { key: 'maybe', label: '?', title: 'Indeciso' }
      ];
      decisionOptions.forEach((opt) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'decision-btn ' + opt.key;
        btn.dataset.decision = opt.key;
        btn.textContent = opt.label;
        btn.title = opt.title;
        btn.setAttribute('aria-label', opt.title);
        btn.disabled = authRole === 'viewer';
        btn.onclick = async (event) => {
          event.stopPropagation();
          if (authRole === 'viewer') return;
        const ids = Array.isArray(item.cvIds) && item.cvIds.length
          ? item.cvIds
          : (item.id ? [item.id] : []);
        if (!ids.length) return;
          const next = item.decision === opt.key ? '' : opt.key;
          decisionWrap.classList.add('is-loading');
          try {
            const updated = await updateCvDecision(ids, next);
            item.decision = updated || '';
            renderCvList(lastCvRaw);
          } catch (err) {
            console.error('decision update failed', err);
            setCvListCount('Error: ' + err.message);
          } finally {
            decisionWrap.classList.remove('is-loading');
          }
        };
        decisionWrap.appendChild(btn);
      });
      setDecisionButtonsActive(decisionWrap, item.decision || '');
      decisionSection.appendChild(buildSwipeRow('Decisión', decisionWrap));
      card.appendChild(decisionSection);

      const actionSection = document.createElement('div');
      actionSection.className = 'swipe-section';
      const cvActions = document.createElement('div');
      cvActions.className = 'action-stack';
      if (item.cv_url) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'secondary btn-compact';
        btn.textContent = 'Ver CV';
        btn.onclick = () => window.open(item.cv_url, '_blank', 'noopener');
        cvActions.appendChild(btn);
      } else if (item.cv_text) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'secondary btn-compact';
        btn.textContent = 'Ver CV';
        btn.onclick = () => openCvModal(item.cv_text || '');
        cvActions.appendChild(btn);
      }
      const canWrite = authRole !== 'viewer';
      if (canWrite) {
        const callBtn = document.createElement('button');
        callBtn.type = 'button';
        callBtn.className = 'btn-compact';
        callBtn.textContent = info.hasCalls ? 'Volver a llamar' : 'Llamar';
        callBtn.onclick = () => {
          if (info.hasCalls) {
            const name = item.applicant ? item.applicant.trim() : '';
            const label = name || 'este candidato';
            if (!confirm('¿Seguro que querés volver a llamar a ' + label + '?')) return;
          }
          currentCvId = item.id || '';
          callBrandEl.value = item.brandKey || item.brand || '';
          updateCallRoleOptions(callBrandEl.value);
          const roleOptions = Array.from(callRoleEl.options || []).map((opt) => opt.value);
          if (item.role && roleOptions.includes(item.role)) {
            callRoleEl.value = item.role;
          } else if (item.roleKey && roleOptions.includes(item.roleKey)) {
            callRoleEl.value = item.roleKey;
          } else {
            callRoleEl.value = item.role || item.roleKey || '';
          }
          callNameEl.value = item.applicant || '';
          callPhoneEl.value = item.phone || '';
          callCvTextEl.value = item.cv_text || '';
          currentCvSource = item.source || '';
          placeCall({
            to: item.phone || '',
            brand: item.brandKey || item.brand || '',
            role: callRoleEl.value || item.role || item.roleKey || '',
            applicant: item.applicant || '',
            cv_summary: truncateText(item.cv_text || '', CV_CHAR_LIMIT),
            cv_text: item.cv_text || '',
            cv_id: item.id || (Array.isArray(item.cvIds) ? item.cvIds[0] : '') || '',
            custom_question: item.custom_question || ''
          });
        };
        cvActions.appendChild(callBtn);
        const qBtn = document.createElement('button');
        qBtn.type = 'button';
        qBtn.className = 'secondary btn-compact';
        qBtn.textContent = item.custom_question ? 'Pregunta ✓' : 'Pregunta';
        qBtn.onclick = () => openCvQuestionModal(item);
        cvActions.appendChild(qBtn);
      }
      if (info.hasCalls) {
        const viewBtn = document.createElement('button');
        viewBtn.type = 'button';
        viewBtn.className = 'secondary btn-compact';
        viewBtn.textContent = 'Ver entrevista';
        viewBtn.onclick = () => goToInterviewFromCv(item);
        cvActions.appendChild(viewBtn);
      }
      if (authRole === 'admin') {
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'secondary btn-compact icon-only';
        delBtn.textContent = '🗑';
        delBtn.title = 'Eliminar';
        delBtn.setAttribute('aria-label', 'Eliminar');
        delBtn.onclick = () => deleteCandidateGroup(item);
        cvActions.appendChild(delBtn);
      }
      actionSection.appendChild(buildSwipeRow('Acción', cvActions));
      card.appendChild(actionSection);

      cvSwipeCardEl.innerHTML = '';
      cvSwipeCardEl.appendChild(card);
      attachSwipeNavigation(card, () => {
        cvSwipeIndex = (cvSwipeIndex - 1 + total) % total;
        renderCvSwipe();
      }, () => {
        cvSwipeIndex = (cvSwipeIndex + 1) % total;
        renderCvSwipe();
      });
    }

    function renderResultsSwipe() {
      if (!resultsSwipeCardEl) return;
      const list = Array.isArray(lastResultsFiltered) ? lastResultsFiltered : [];
      const total = list.length;
      if (!total) {
        if (resultsSwipeCountEl) resultsSwipeCountEl.textContent = '0 / 0';
        resultsSwipeCardEl.innerHTML = '<div class="swipe-empty">No hay entrevistas para este filtro.</div>';
        return;
      }
      if (resultsSwipeIndex >= total) resultsSwipeIndex = total - 1;
      if (resultsSwipeIndex < 0) resultsSwipeIndex = 0;
      const call = list[resultsSwipeIndex];
      const lastSeen = getSeenTimestamp(INTERVIEWS_SEEN_KEY);
      const isNew = isUnseenPortalItem(call.created_at, call.source, lastSeen);
      if (resultsSwipeCountEl) resultsSwipeCountEl.textContent = (resultsSwipeIndex + 1) + ' / ' + total;

      const card = document.createElement('div');
      card.className = 'swipe-card' + (isNew ? ' is-new' : '');

      const top = document.createElement('div');
      top.className = 'swipe-top';
      const titleWrap = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'swipe-title';
      title.textContent = call.applicant || 'Sin nombre';
      titleWrap.appendChild(title);
      const brandLabel = call.brandKey ? getBrandDisplayByKey(call.brandKey) : (call.brand || '');
      const roleLabel = getRoleDisplayForBrand(call.brandKey || call.brand, call.role || call.roleKey || '');
      const sub = document.createElement('div');
      sub.className = 'swipe-sub';
      sub.textContent = [brandLabel, roleLabel].filter(Boolean).join(' • ');
      titleWrap.appendChild(sub);
      top.appendChild(titleWrap);
      const scoreWrap = document.createElement('div');
      scoreWrap.appendChild(scorePill(call.score));
      top.appendChild(scoreWrap);
      card.appendChild(top);

      const infoSection = document.createElement('div');
      infoSection.className = 'swipe-section';
      infoSection.appendChild(buildSwipeRow('Fecha', formatDate(call.created_at)));
      infoSection.appendChild(buildSwipeRow('Local', brandLabel));
      infoSection.appendChild(buildSwipeRow('Posición', roleLabel));
      infoSection.appendChild(buildSwipeRow('Teléfono', call.phone || '—'));
      infoSection.appendChild(buildSwipeRow('Estado', formatInterviewSummary(call)));
      card.appendChild(infoSection);

      const decisionSection = document.createElement('div');
      decisionSection.className = 'swipe-section';
      const decisionWrap = document.createElement('div');
      decisionWrap.className = 'decision-buttons';
      const decisionOptions = [
        { key: 'approved', label: '✓', title: 'Aprobado' },
        { key: 'declined', label: '✕', title: 'Descartado' },
        { key: 'maybe', label: '?', title: 'Indeciso' }
      ];
      const decisionIds = Array.isArray(call.cvIds) && call.cvIds.length
        ? call.cvIds
        : (call.cv_id || call.cvId ? [call.cv_id || call.cvId] : []);
      const canUpdateDecision = authRole !== 'viewer' && decisionIds.length;
      decisionOptions.forEach((opt) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'decision-btn ' + opt.key;
        btn.dataset.decision = opt.key;
        btn.textContent = opt.label;
        btn.title = opt.title;
        btn.setAttribute('aria-label', opt.title);
        btn.disabled = !canUpdateDecision;
        btn.onclick = async (event) => {
          event.stopPropagation();
          if (!canUpdateDecision) return;
          const next = call.decision === opt.key ? '' : opt.key;
          decisionWrap.classList.add('is-loading');
          try {
            const updated = await updateCvDecision(decisionIds, next);
            call.decision = updated || '';
            renderResults(lastResultsRaw);
          } catch (err) {
            console.error('decision update failed', err);
            setResultsCount('Error: ' + err.message);
          } finally {
            decisionWrap.classList.remove('is-loading');
          }
        };
        decisionWrap.appendChild(btn);
      });
      setDecisionButtonsActive(decisionWrap, call.decision || '');
      decisionSection.appendChild(buildSwipeRow('Decisión', decisionWrap));
      card.appendChild(decisionSection);

      const mediaSection = document.createElement('div');
      mediaSection.className = 'swipe-section';
      const mediaWrap = document.createElement('div');
      mediaWrap.className = 'action-stack';
      if (call.cv_url) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'secondary btn-compact';
        btn.textContent = 'Ver CV';
        btn.onclick = () => window.open(call.cv_url, '_blank', 'noopener');
        mediaWrap.appendChild(btn);
      }
      if (call.audio_url) {
        const downloadId = call.callId || (Array.isArray(call.callIds) ? call.callIds[0] : '');
        const downloadUrl = downloadId ? '/admin/calls/' + encodeURIComponent(downloadId) + '/audio' : call.audio_url;
        const downloadName = 'interview_' + (downloadId || 'audio') + '.mp3';
        mediaWrap.appendChild(buildAudioPlayer(call.audio_url, { downloadUrl, downloadName }));
      }
      mediaSection.appendChild(buildSwipeRow('Audio', mediaWrap));
      card.appendChild(mediaSection);

      const actionSection = document.createElement('div');
      actionSection.className = 'swipe-section';
      const actionWrap = document.createElement('div');
      actionWrap.className = 'action-stack';
      if (authRole === 'admin' && call.callId) {
        const waBtn = document.createElement('button');
        waBtn.type = 'button';
        waBtn.className = 'secondary btn-compact';
        waBtn.textContent = 'WhatsApp';
        waBtn.onclick = () => sendInterviewWhatsapp(call);
        actionWrap.appendChild(waBtn);
      }
      if (authRole === 'admin' && call.callId) {
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'secondary btn-compact icon-only';
        delBtn.textContent = '🗑';
        delBtn.title = 'Eliminar';
        delBtn.setAttribute('aria-label', 'Eliminar');
        delBtn.onclick = () => deleteInterviewGroup(call);
        actionWrap.appendChild(delBtn);
      }
      actionSection.appendChild(buildSwipeRow('Acción', actionWrap));
      card.appendChild(actionSection);

      resultsSwipeCardEl.innerHTML = '';
      resultsSwipeCardEl.appendChild(card);
      attachSwipeNavigation(card, () => {
        resultsSwipeIndex = (resultsSwipeIndex - 1 + total) % total;
        renderResultsSwipe();
      }, () => {
        resultsSwipeIndex = (resultsSwipeIndex + 1) % total;
        renderResultsSwipe();
      });
    }

    function updateBadge(el, count) {
      if (!el) return;
      if (count > 0) {
        el.textContent = count > 99 ? '99+' : String(count);
        el.style.display = 'inline-flex';
      } else {
        el.textContent = '';
        el.style.display = 'none';
      }
    }

    function isInterviewCompleted(call) {
      if (!call) return false;
      if (call.outcome === 'NO_ANSWER') return false;
      if (call.score !== null && call.score !== undefined) return true;
      if (call.summary && String(call.summary).trim()) return true;
      if (call.recommendation) return true;
      return false;
    }

    function isPortalSource(value) {
      return String(value || '').toLowerCase().trim().startsWith('portal:');
    }

    function computeCandidatesNewCount(list) {
      const items = Array.isArray(list) ? list : [];
      const lastSeen = getSeenTimestamp(CANDIDATES_SEEN_KEY);
      let count = 0;
      items.forEach((item) => {
        if (!isPortalSource(item.source)) return;
        const created = item.created_at ? new Date(item.created_at).getTime() : 0;
        if (!created || created <= lastSeen) return;
        count += 1;
      });
      return count;
    }

    function computeInterviewsNewCount(list) {
      const items = Array.isArray(list) ? list : [];
      const lastSeen = getSeenTimestamp(INTERVIEWS_SEEN_KEY);
      let count = 0;
      items.forEach((item) => {
        if (!isPortalSource(item.source)) return;
        const created = item.created_at ? new Date(item.created_at).getTime() : 0;
        if (!created || created <= lastSeen) return;
        if (!isInterviewCompleted(item)) return;
        count += 1;
      });
      return count;
    }

    function updateCandidatesBadge(list) {
      updateBadge(navCallsBadgeEl, computeCandidatesNewCount(list));
    }

    function updateInterviewsBadge(list) {
      updateBadge(navInterviewsBadgeEl, computeInterviewsNewCount(list));
    }

    function markCandidatesSeen(list) {
      const items = Array.isArray(list) ? list : [];
      const latest = items
        .filter((item) => isPortalSource(item.source))
        .map((item) => new Date(item.created_at || 0).getTime())
        .filter((t) => Number.isFinite(t) && t > 0)
        .sort((a, b) => b - a)[0];
      if (latest) setSeenTimestamp(CANDIDATES_SEEN_KEY, latest);
      updateCandidatesBadge(items);
    }

    function markInterviewsSeen(list) {
      const items = Array.isArray(list) ? list : [];
      const latest = items
        .filter((item) => isPortalSource(item.source))
        .filter((item) => isInterviewCompleted(item))
        .map((item) => new Date(item.created_at || 0).getTime())
        .filter((t) => Number.isFinite(t) && t > 0)
        .sort((a, b) => b - a)[0];
      if (latest) setSeenTimestamp(INTERVIEWS_SEEN_KEY, latest);
      updateInterviewsBadge(items);
    }

    async function fetchCandidatesBadge() {
      try {
        const resp = await fetch('/admin/cv?limit=200', { headers: portalAuthHeaders() });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) return;
        candidatesBadgeItems = Array.isArray(data.cvs) ? data.cvs : [];
        updateCandidatesBadge(candidatesBadgeItems);
      } catch (err) {}
    }

    async function fetchInterviewsBadge() {
      try {
        const resp = await fetch('/admin/calls?limit=200', { headers: portalAuthHeaders() });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) return;
        interviewsBadgeItems = Array.isArray(data.calls) ? data.calls : [];
        updateInterviewsBadge(interviewsBadgeItems);
      } catch (err) {}
    }

    function startBadgePolling() {
      if (badgeTimer) return;
      fetchCandidatesBadge().catch(() => {});
      fetchInterviewsBadge().catch(() => {});
      badgeTimer = setInterval(() => {
        fetchCandidatesBadge().catch(() => {});
        fetchInterviewsBadge().catch(() => {});
      }, 30000);
    }

    function portalRenderApplications(apps) {
      if (!portalAppBodyEl) return;
      const list = Array.isArray(apps) ? apps : [];
      portalLastApps = list.slice();
      portalAppBodyEl.innerHTML = '';
      if (portalAppCountEl) {
        portalAppCountEl.textContent = list.length ? (list.length + ' postulaciones') : 'Sin postulaciones';
      }
      list.forEach((app) => {
        const row = document.createElement('tr');
        const page = portalFindPageBySlug(app.slug);
        const pageLabel = (page && page.brand) || app.brand || app.slug || '';
        portalAddTextCell(row, formatDate(app.created_at), 'cell-compact');
        portalAddTextCell(row, pageLabel);
        portalAddTextCell(row, portalFormatLocationLabels(app));
        portalAddTextCell(row, app.name || '');
        portalAddTextCell(row, app.email || '');
        portalAddTextCell(row, app.phone || '');
        portalAddTextCell(row, app.role || '');
        portalAddLinkCell(row, app.resume_url || '', 'CV');
        portalAddLinkCell(row, app.photo_url || '', 'Foto');
        const answers = portalBuildAnswerText(app);
        portalAddTextCell(row, answers || '—', 'portal-answer');
        portalAppBodyEl.appendChild(row);
      });
    }

    function portalCsvEscape(value) {
      if (value === null || value === undefined) return '""';
      const str = String(value);
      return '"' + str.replace(/"/g, '""') + '"';
    }

    function portalSafeFileName(value) {
      return String(value || 'applications').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'applications';
    }

    function portalBuildCsv(apps) {
      const headers = ['Date', 'Page', 'Brand', 'Locations', 'Name', 'Email', 'Phone', 'Role', 'Resume', 'Photo', 'Answers'];
      const rows = [headers.map(portalCsvEscape).join(',')];
      (apps || []).forEach((app) => {
        const page = portalFindPageBySlug(app.slug);
        const pageLabel = app.slug || '';
        const brandLabel = (page && page.brand) || app.brand || '';
        const locationLabel = portalFormatLocationLabels(app);
        const answers = portalBuildAnswerText(app);
        rows.push([
          formatDate(app.created_at),
          pageLabel,
          brandLabel,
          locationLabel,
          app.name || '',
          app.email || '',
          app.phone || '',
          app.role || '',
          app.resume_url || '',
          app.photo_url || '',
          answers || ''
        ].map(portalCsvEscape).join(','));
      });
      return rows.join('\\r\\n');
    }

    function portalExportCsv() {
      const apps = Array.isArray(portalLastApps) ? portalLastApps : [];
      const csv = portalBuildCsv(apps);
      const slug = portalAppFilterEl ? portalAppFilterEl.value : '';
      const stamp = new Date().toISOString().slice(0, 10);
      const name = portalSafeFileName(slug || 'all') + '_' + stamp + '.csv';
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = name;
      document.body.appendChild(link);
      link.click();
      setTimeout(() => {
        URL.revokeObjectURL(link.href);
        link.remove();
      }, 0);
    }

    async function portalLoadApplications() {
      if (!portalAppBodyEl) return;
      const params = new URLSearchParams();
      const slug = portalAppFilterEl ? portalAppFilterEl.value : '';
      if (slug) params.set('slug', slug);
      const location = portalAppLocationFilterEl ? portalAppLocationFilterEl.value : '';
      if (location) params.set('location', location);
      const query = params.toString();
      const resp = await fetch('/admin/portal/applications' + (query ? ('?' + query) : ''), {
        headers: portalAuthHeaders()
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || 'load_failed');
      portalRenderApplications(data.applications || []);
    }

    async function portalLoadPages() {
      portalSetStatus('Cargando...');
      const resp = await fetch('/admin/portal/pages', { headers: portalAuthHeaders() });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || 'load_failed');
      portalPages = data.pages || [];
      portalRenderList();
      portalRenderAppFilter();
      portalRenderLocationFilter();
      if (!portalPages.length) {
        portalCurrent = portalDefaultPage();
        portalFillForm();
        portalRenderApplications([]);
        portalSetStatus('');
        return;
      }
      const target = portalPendingSlug || (portalCurrent && portalCurrent.slug) || (portalPages[0] && portalPages[0].slug);
      portalPendingSlug = '';
      if (target && portalPages.some((page) => page.slug === target)) {
        portalSelectPage(target);
      } else if (portalPages[0]) {
        portalSelectPage(portalPages[0].slug);
      }
      portalSetStatus('');
    }

    function ensurePortalLoaded(force) {
      if (!portalViewEl) return;
      if (portalLoaded && !force) return;
      portalLoaded = true;
      portalLoadPages().catch((err) => {
        portalLoaded = false;
        portalSetStatus('Error: ' + err.message, true);
      });
    }

    async function portalSavePage() {
      try {
        if (authRole === 'viewer') {
          portalSetStatus('Solo lectura.', true);
          return;
        }
        if (portalSlugEl) {
          portalSlugEl.value = toSlug(portalSlugEl.value || '');
          portalUpdateUrl();
        }
        const payload = portalReadForm();
        if (!payload.slug) {
          portalSetStatus('Falta el slug.', true);
          return;
        }
        if (portalPendingUploads.logo) {
          payload.logo_data_url = portalPendingUploads.logo.dataUrl;
          payload.logo_file_name = portalPendingUploads.logo.fileName;
        }
        if (portalPendingUploads.hero) {
          payload.hero_data_url = portalPendingUploads.hero.dataUrl;
          payload.hero_file_name = portalPendingUploads.hero.fileName;
        }
        if (portalPendingUploads.favicon) {
          payload.favicon_data_url = portalPendingUploads.favicon.dataUrl;
          payload.favicon_file_name = portalPendingUploads.favicon.fileName;
        }
        if (portalPendingUploads.gallery.length) {
          payload.gallery_data_urls = portalPendingUploads.gallery.map((g) => g.dataUrl);
          payload.gallery_file_names = portalPendingUploads.gallery.map((g) => g.fileName);
        }
        portalSetStatus('Guardando...');
        const resp = await fetch('/admin/portal/pages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...portalAuthHeaders() },
          body: JSON.stringify(payload)
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || 'save_failed');
        portalPendingUploads = { logo: null, hero: null, favicon: null, gallery: [] };
        portalPendingSlug = data.page && data.page.slug ? data.page.slug : payload.slug;
        await portalLoadPages();
        portalSetStatus('Guardado');
      } catch (err) {
        portalSetStatus('Error: ' + err.message, true);
      }
    }

    async function portalDeletePage() {
      if (!portalCurrent || !portalCurrent.slug) return;
      if (!confirm('Eliminar este portal?')) return;
      try {
        const resp = await fetch('/admin/portal/pages/' + encodeURIComponent(portalCurrent.slug), {
          method: 'DELETE',
          headers: portalAuthHeaders()
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || 'delete_failed');
        portalCurrent = null;
        portalPendingSlug = '';
        await portalLoadPages();
        portalSetStatus('Eliminado');
      } catch (err) {
        portalSetStatus('Error: ' + err.message, true);
      }
    }

    function normalizeKeyUi(value) {
      return (value || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
    }

    function getRoleDisplayForBrand(brandKey, roleKey) {
      if (!brandKey || !roleKey) return roleKey || '';
      const roles = listRolesForBrand(brandKey);
      const norm = normalizeKeyUi(roleKey);
      const matchKey = roles.find((r) => normalizeKeyUi(r.key) === norm);
      if (matchKey) return matchKey.display;
      const matchDisplay = roles.find((r) => normalizeKeyUi(r.display) === norm);
      if (matchDisplay) return matchDisplay.display;
      const matchAlias = roles.find((r) => (r.aliases || []).some((a) => normalizeKeyUi(a) === norm));
      if (matchAlias) return matchAlias.display;
      const token = norm.split(' ').filter(Boolean);
      if (token.length === 1) {
        const matches = roles.filter((r) => {
          const keyTokens = normalizeKeyUi(r.key).split(' ').filter(Boolean);
          const displayTokens = normalizeKeyUi(r.display).split(' ').filter(Boolean);
          return keyTokens.includes(token[0]) || displayTokens.includes(token[0]);
        });
        if (matches.length) {
          matches.sort((a, b) => String(b.display).length - String(a.display).length);
          return matches[0].display;
        }
      }
      return roleKey;
    }

    function syncSidebar() {
      if (suppressSidebarSync) return;
      const brandOptions = listBrandOptions();
      brandListEl.innerHTML = '';
      brandOptions.forEach((brand) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'nav-item';
        btn.dataset.brandKey = brand.key;
        btn.title = brand.display;
        const thumb = document.createElement('div');
        thumb.className = 'brand-thumb';
        if (brand.logo) {
          const img = document.createElement('img');
          img.src = brand.logo;
          img.alt = brand.display;
          thumb.appendChild(img);
        } else {
          thumb.textContent = brand.display.slice(0, 2).toUpperCase();
        }
        const label = document.createElement('div');
        label.className = 'nav-label';
        label.textContent = brand.display;
        btn.appendChild(thumb);
        btn.appendChild(label);
        btn.onclick = () => setActiveView(brand.key);
        brandListEl.appendChild(btn);
      });
      updateNavActive();
      updateCallBrandOptions();
      updateRoleOptions();
      portalRenderLocationOptions();
    }

    function updateNavActive() {
      navGeneralEl.classList.toggle('active', activeView === 'general');
      navCallsEl.classList.toggle('active', activeView === 'calls');
      navInterviewsEl.classList.toggle('active', activeView === 'interviews');
      if (navPortalEl) navPortalEl.classList.toggle('active', activeView === 'portal');
      brandListEl.querySelectorAll('.nav-item').forEach((btn) => {
        btn.classList.toggle('active', activeView === 'brand' && btn.dataset.brandKey === activeBrandKey);
      });
    }

    function setActiveView(key) {
      if (authRole !== 'admin' && key !== VIEW_CALLS && key !== VIEW_INTERVIEWS) {
        key = VIEW_CALLS;
      }
      if (key === VIEW_CALLS) {
        activeView = 'calls';
        activeBrandKey = '';
      } else if (key === VIEW_INTERVIEWS) {
        activeView = 'interviews';
        activeBrandKey = '';
      } else if (key === VIEW_PORTAL) {
        activeView = 'portal';
        activeBrandKey = '';
      } else if (key) {
        activeView = 'brand';
        activeBrandKey = key;
      } else {
        activeView = 'general';
        activeBrandKey = '';
      }
      generalViewEl.style.display = activeView === 'general' ? 'block' : 'none';
      callsViewEl.style.display = activeView === 'calls' ? 'block' : 'none';
      interviewsViewEl.style.display = activeView === 'interviews' ? 'block' : 'none';
      if (portalViewEl) portalViewEl.style.display = activeView === 'portal' ? 'block' : 'none';
      brandViewEl.style.display = activeView === 'brand' ? 'block' : 'none';
      getBrandCards().forEach((card) => {
        const show = activeView === 'brand' && card.dataset.brandKey === activeBrandKey;
        card.style.display = show ? '' : 'none';
      });
      if (activeView === 'brand') {
        viewTitleEl.textContent = getBrandDisplayByKey(activeBrandKey);
        viewLabelEl.textContent = 'Restaurante';
      } else if (activeView === 'calls') {
        viewTitleEl.textContent = 'Candidates';
        viewLabelEl.textContent = 'Llamadas';
      } else if (activeView === 'interviews') {
        viewTitleEl.textContent = 'Interviews';
        viewLabelEl.textContent = 'Listado';
      } else if (activeView === 'portal') {
        viewTitleEl.textContent = 'Portal';
        viewLabelEl.textContent = 'Aplicaciones';
      } else {
        viewTitleEl.textContent = 'General';
        viewLabelEl.textContent = 'Configuración';
      }
      if (mobileTitleEl) {
        mobileTitleEl.textContent = viewTitleEl.textContent || 'HRBOT';
      }
      updateNavActive();
      updateCallBrandOptions();
      updateRoleOptions();
      setPreviewDefaults(activeView === 'brand' ? activeBrandKey : '');
      if (activeView === 'interviews') {
        scheduleResultsLoad();
      }
      if (activeView === 'calls') {
        scheduleCvLoad();
      }
      if (activeView === 'calls' && lastCvRaw.length) {
        markCandidatesSeen(lastCvRaw);
      }
      if (activeView === 'interviews' && lastResultsRaw.length) {
        markInterviewsSeen(lastResultsRaw);
      }
      if (activeView === 'portal') {
        ensurePortalLoaded();
      }
      if (window.matchMedia && window.matchMedia('(max-width: 980px)').matches) {
        setSidebarCollapsed(true);
      }
    }

    function updateCallBrandOptions() {
      const options = listBrandOptions();
      const prev = callBrandEl.value;
      callBrandEl.innerHTML = '';
      options.forEach((opt) => {
        const option = document.createElement('option');
        option.value = opt.key;
        option.textContent = opt.display;
        callBrandEl.appendChild(option);
      });
      if (activeBrandKey && options.some((opt) => opt.key === activeBrandKey)) {
        callBrandEl.value = activeBrandKey;
      } else if (prev && options.some((opt) => opt.key === prev)) {
        callBrandEl.value = prev;
      } else if (options[0]) {
        callBrandEl.value = options[0].key;
      }
      updateCallRoleOptions(callBrandEl.value);
    }

    function updateCallRoleOptions(brandKey) {
      const roles = listRolesForBrand(brandKey);
      callRoleEl.innerHTML = '';
      roles.forEach((role) => {
        const opt = document.createElement('option');
        opt.value = role.key;
        opt.textContent = role.display;
        callRoleEl.appendChild(opt);
      });
    }

    function updateResultsBrandOptions() {
      const options = listBrandOptions();
      const prev = resultsBrandEl.value;
      resultsBrandEl.innerHTML = '<option value="">Todos</option>';
      options.forEach((opt) => {
        const option = document.createElement('option');
        option.value = opt.key;
        option.textContent = opt.display;
        resultsBrandEl.appendChild(option);
      });
      if (prev && options.some((opt) => opt.key === prev)) {
        resultsBrandEl.value = prev;
      } else {
        resultsBrandEl.value = '';
      }
      const cvPrev = cvFilterBrandEl.value;
      cvFilterBrandEl.innerHTML = '<option value="">Todos</option>';
      options.forEach((opt) => {
        const option = document.createElement('option');
        option.value = opt.key;
        option.textContent = opt.display;
        cvFilterBrandEl.appendChild(option);
      });
      if (cvPrev && options.some((opt) => opt.key === cvPrev)) {
        cvFilterBrandEl.value = cvPrev;
      } else {
        cvFilterBrandEl.value = '';
      }
    }

    function updateResultsRoleOptions() {
      const brandKey = resultsBrandEl.value || '';
      const prev = resultsRoleEl.value;
      const roles = brandKey ? listRolesForBrand(brandKey) : [];
      resultsRoleEl.innerHTML = '<option value="">Todas</option>';
      roles.forEach((role) => {
        const opt = document.createElement('option');
        opt.value = role.key;
        opt.textContent = role.display;
        resultsRoleEl.appendChild(opt);
      });
      if (prev && roles.some((role) => role.key === prev)) {
        resultsRoleEl.value = prev;
      } else {
        resultsRoleEl.value = '';
      }
    }

    function updateRoleOptions() {
      updateCallRoleOptions(callBrandEl.value || activeBrandKey);
      updateResultsBrandOptions();
      updateResultsRoleOptions();
    }

    function setPreviewDefaults(brandKey) {
      if (!brandKey) return;
      const card = getBrandCardByKey(brandKey);
      if (!card) return;
      previewBrandEl.value = getBrandDisplayByKey(brandKey);
      const roles = listRolesForBrand(brandKey);
      if (roles.length) previewRoleEl.value = roles[0].key;
      const addr = (card.querySelector('.brand-address')?.value || '').trim();
      if (addr) previewAddressEl.value = addr;
    }

    function renderConfig(cfg) {
      suppressSidebarSync = true;
      brandsEl.innerHTML = '';
      const meta = cfg?.meta || {};
      openerEsEl.value = typeof meta.opener_es === "string" && meta.opener_es.trim() ? meta.opener_es : defaults.opener_es;
      openerEnEl.value = typeof meta.opener_en === "string" && meta.opener_en.trim() ? meta.opener_en : defaults.opener_en;
      langRulesEl.value = typeof meta.lang_rules === "string" && meta.lang_rules.trim() ? meta.lang_rules : defaults.lang_rules;
      mustAskEl.value = typeof meta.must_ask === "string" && meta.must_ask.trim() ? meta.must_ask : defaults.must_ask;
      systemPromptEl.value = typeof meta.system_prompt === "string" && meta.system_prompt.trim() ? meta.system_prompt : defaults.system_prompt;
      if (runtimeInstructionsEl) {
        runtimeInstructionsEl.value = typeof meta.runtime_instructions === "string"
          ? meta.runtime_instructions
          : defaults.runtime_instructions;
      }
      if (englishLevelEsEl) englishLevelEsEl.value = typeof meta.english_level_question_es === "string" && meta.english_level_question_es.trim() ? meta.english_level_question_es : defaults.english_level_question_es;
      if (englishLevelEnEl) englishLevelEnEl.value = typeof meta.english_level_question_en === "string" && meta.english_level_question_en.trim() ? meta.english_level_question_en : defaults.english_level_question_en;
      if (englishCheckEsEl) englishCheckEsEl.value = typeof meta.english_check_question_es === "string" && meta.english_check_question_es.trim() ? meta.english_check_question_es : defaults.english_check_question_es;
      if (englishCheckEnEl) englishCheckEnEl.value = typeof meta.english_check_question_en === "string" && meta.english_check_question_en.trim() ? meta.english_check_question_en : defaults.english_check_question_en;
      if (lateClosingEsEl) lateClosingEsEl.value = typeof meta.late_closing_question_es === "string" && meta.late_closing_question_es.trim() ? meta.late_closing_question_es : defaults.late_closing_question_es;
      if (lateClosingEnEl) lateClosingEnEl.value = typeof meta.late_closing_question_en === "string" && meta.late_closing_question_en.trim() ? meta.late_closing_question_en : defaults.late_closing_question_en;
      if (recordingIntroEsEl) recordingIntroEsEl.value = typeof meta.recording_intro_es === "string" && meta.recording_intro_es.trim() ? meta.recording_intro_es : defaults.recording_intro_es;
      if (recordingIntroEnEl) recordingIntroEnEl.value = typeof meta.recording_intro_en === "string" && meta.recording_intro_en.trim() ? meta.recording_intro_en : defaults.recording_intro_en;
      if (recordingConsentEsEl) recordingConsentEsEl.value = typeof meta.recording_consent_es === "string" && meta.recording_consent_es.trim() ? meta.recording_consent_es : defaults.recording_consent_es;
      if (recordingConsentEnEl) recordingConsentEnEl.value = typeof meta.recording_consent_en === "string" && meta.recording_consent_en.trim() ? meta.recording_consent_en : defaults.recording_consent_en;
      if (recordingConfirmEsEl) recordingConfirmEsEl.value = typeof meta.recording_confirm_es === "string" && meta.recording_confirm_es.trim() ? meta.recording_confirm_es : defaults.recording_confirm_es;
      if (recordingConfirmEnEl) recordingConfirmEnEl.value = typeof meta.recording_confirm_en === "string" && meta.recording_confirm_en.trim() ? meta.recording_confirm_en : defaults.recording_confirm_en;
      if (recordingNoResponseEsEl) recordingNoResponseEsEl.value = typeof meta.recording_no_response_es === "string" && meta.recording_no_response_es.trim() ? meta.recording_no_response_es : defaults.recording_no_response_es;
      if (recordingNoResponseEnEl) recordingNoResponseEnEl.value = typeof meta.recording_no_response_en === "string" && meta.recording_no_response_en.trim() ? meta.recording_no_response_en : defaults.recording_no_response_en;
      if (recordingDeclineEsEl) recordingDeclineEsEl.value = typeof meta.recording_decline_es === "string" && meta.recording_decline_es.trim() ? meta.recording_decline_es : defaults.recording_decline_es;
      if (recordingDeclineEnEl) recordingDeclineEnEl.value = typeof meta.recording_decline_en === "string" && meta.recording_decline_en.trim() ? meta.recording_decline_en : defaults.recording_decline_en;
      setSystemPromptBaseline(systemPromptEl.value || '');
      if (!systemPromptUnlocked) {
        lockSystemPrompt();
        setAdminStatus('Bloqueado');
      }
      const brands = Object.keys(cfg || {}).filter((k) => k !== "meta");
      if (!brands.length) {
        brandsEl.appendChild(brandTemplate(''));
      } else {
        for (const brandKey of brands) {
          const bCard = brandTemplate(brandKey);
          const metaB = cfg[brandKey]?._meta || {};
          bCard.querySelector('.brand-display').value = metaB.displayName || '';
          bCard.querySelector('.brand-address').value = metaB.address || '';
          bCard.querySelector('.brand-aliases').value = Array.isArray(metaB.aliases) ? metaB.aliases.join(', ') : '';
          bCard.querySelector('.brand-logo').value = metaB.logo || '';
          const groupEl = bCard.querySelector('.brand-group');
          if (groupEl) groupEl.value = metaB.group || '';
          const visibleEl = bCard.querySelector('.brand-visible');
          if (visibleEl) visibleEl.checked = !metaB.hidden;
          setLogoPreview(bCard, metaB.logo || '');
          if (typeof bCard._updateLabels === "function") bCard._updateLabels();
          const rolesBox = bCard.querySelector('.roles');
          const roles = cfg[brandKey] || {};
          for (const roleName of Object.keys(roles)) {
            if (roleName === "_meta") continue;
            rolesBox.appendChild(roleTemplate(roleName, roles[roleName] || {}));
          }
          brandsEl.appendChild(bCard);
        }
      }
      suppressSidebarSync = false;
      syncSidebar();
      if (activeView === 'brand' && activeBrandKey && getBrandCardByKey(activeBrandKey)) {
        setActiveView(activeBrandKey);
      } else if (activeView === 'calls') {
        setActiveView(VIEW_CALLS);
      } else if (activeView === 'interviews') {
        setActiveView(VIEW_INTERVIEWS);
      } else {
        setActiveView('');
      }
      if (authRole === 'admin') {
        renderUserBrandList(getSelectedUserBrands());
        renderUsersTable(usersList);
      }
    }

    async function generatePreview() {
      setPreviewStatus('Generando...');
      if (previewOutputEl) previewOutputEl.value = '';
      try {
        const payload = {
          brand: previewBrandEl.value || '',
          role: previewRoleEl.value || '',
          applicant: previewApplicantEl.value || '',
          address: previewAddressEl.value || '',
          cv_summary: previewCvEl.value || '',
          lang: previewLangEl.value || 'es'
        };
        if (previewEnglishEl.value === 'yes') payload.englishRequired = true;
        if (previewEnglishEl.value === 'no') payload.englishRequired = false;

        const resp = await fetch('/admin/preview', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + tokenEl.value
          },
          body: JSON.stringify(payload)
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || 'preview failed');
        if (previewOutputEl) previewOutputEl.value = data.prompt || '';
        setPreviewStatus('OK');
      } catch (err) {
        setPreviewStatus('Error: ' + err.message);
      }
    }

    async function loadConfig() {
      setStatus('Loading...');
      try {
        const resp = await fetch('/admin/config', { headers: { Authorization: 'Bearer ' + tokenEl.value } });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'load failed');
        state.config = data.config || {};
        if (Array.isArray(data.allowed_brands)) {
          authBrands = data.allowed_brands;
        }
        renderConfig(state.config);
        if (authRole === 'admin') {
          renderUserBrandList(getSelectedUserBrands());
          loadUsers();
        }
        lastLoadError = '';
        setStatus('Loaded (' + (data.source || 'defaults') + ')');
        syncPortalToken();
        return true;
      } catch (err) {
        lastLoadError = err.message || '';
        setStatus('Error: ' + err.message);
        return false;
      }
    }

    function collectConfig() {
      const preservedPrompt = state?.config?.meta?.system_prompt || '';
      const cfg = {
        meta: {
          opener_es: openerEsEl.value || '',
          opener_en: openerEnEl.value || '',
          lang_rules: langRulesEl.value || '',
          must_ask: mustAskEl.value || '',
          system_prompt: systemPromptUnlocked ? (systemPromptEl.value || '') : preservedPrompt,
          runtime_instructions: runtimeInstructionsEl?.value || '',
          english_level_question_es: englishLevelEsEl?.value || '',
          english_level_question_en: englishLevelEnEl?.value || '',
          english_check_question_es: englishCheckEsEl?.value || '',
          english_check_question_en: englishCheckEnEl?.value || '',
          late_closing_question_es: lateClosingEsEl?.value || '',
          late_closing_question_en: lateClosingEnEl?.value || '',
          recording_intro_es: recordingIntroEsEl?.value || '',
          recording_intro_en: recordingIntroEnEl?.value || '',
          recording_consent_es: recordingConsentEsEl?.value || '',
          recording_consent_en: recordingConsentEnEl?.value || '',
          recording_confirm_es: recordingConfirmEsEl?.value || '',
          recording_confirm_en: recordingConfirmEnEl?.value || '',
          recording_no_response_es: recordingNoResponseEsEl?.value || '',
          recording_no_response_en: recordingNoResponseEnEl?.value || '',
          recording_decline_es: recordingDeclineEsEl?.value || '',
          recording_decline_en: recordingDeclineEnEl?.value || ''
        }
      };
      getBrandCards().forEach((bCard) => {
        const bName = (bCard.querySelector('.brand-name').value || '').trim();
        if (!bName) return;
        const roles = {};
        const metaB = {
          displayName: (bCard.querySelector('.brand-display').value || '').trim(),
          address: (bCard.querySelector('.brand-address').value || '').trim(),
          logo: (bCard.querySelector('.brand-logo').value || '').trim(),
          hidden: bCard.querySelector('.brand-visible')?.checked === false,
          group: (bCard.querySelector('.brand-group')?.value || '').trim(),
          aliases: (bCard.querySelector('.brand-aliases').value || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        };
        bCard.querySelectorAll('.role-card').forEach((rCard) => {
          const rName = (rCard.querySelector('.role-name').value || '').trim();
          if (!rName) return;
          const aliases = (rCard.querySelector('.role-aliases').value || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          const questions = Array.from(rCard.querySelectorAll('.q-text'))
            .map((q) => (q.value || '').trim())
            .filter(Boolean);
          roles[rName] = {
            active: rCard.querySelector('.chk-active').checked,
            englishRequired: rCard.querySelector('.chk-english').checked,
            physical: rCard.querySelector('.chk-physical').checked,
            aliases,
            displayName: (rCard.querySelector('.role-display').value || '').trim(),
            notes: (rCard.querySelector('.role-notes').value || '').trim(),
            questions
          };
        });
        roles._meta = metaB;
        cfg[bName] = roles;
      });
      return cfg;
    }

    async function saveSystemPrompt() {
      if (!systemPromptUnlocked || !adminToken) return;
      if (systemPromptDirty && !confirm('¿Guardar cambios del System Prompt?')) return;
      const body = JSON.stringify({ system_prompt: systemPromptEl.value || '' });
      const resp = await fetch('/admin/system-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adminToken },
        body
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || 'system prompt save failed');
      if (!state.config.meta) state.config.meta = {};
      state.config.meta.system_prompt = systemPromptEl.value || '';
      setSystemPromptBaseline(systemPromptEl.value || '');
      loadPromptStore();
    }

    async function saveConfig() {
      if (!confirm('¿Seguro que querés guardar estos cambios?')) return;
      setStatus('Saving...');
      try {
        const body = JSON.stringify(collectConfig(), null, 2);
        const resp = await fetch('/admin/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokenEl.value },
          body
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || 'save failed');
        if (systemPromptUnlocked) {
          await saveSystemPrompt();
        }
        setStatus('Saved' + (data.source ? ' (' + data.source + ')' : '') + '.');
      } catch (err) {
        setStatus('Error: ' + err.message);
      }
    }

    async function unlockAdmin() {
      const key = (adminTokenEl.value || '').trim();
      if (!key) {
        setAdminStatus('Ingresá la clave ADMIN');
        return;
      }
      setAdminStatus('Verificando...');
      try {
        const resp = await fetch('/admin/system-prompt', {
          headers: { Authorization: 'Bearer ' + key }
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || 'admin inválido');
        adminToken = key;
        unlockSystemPrompt();
        if (typeof data.system_prompt === "string" && data.system_prompt.trim()) {
          systemPromptEl.value = data.system_prompt;
        } else if (!systemPromptEl.value || !systemPromptEl.value.trim()) {
          systemPromptEl.value = defaults.system_prompt;
        }
        setSystemPromptBaseline(systemPromptEl.value || '');
        loadPromptStore();
        setAdminStatus('Admin OK');
      } catch (err) {
        setAdminStatus('Error: ' + err.message);
      }
    }

    function truncateText(text, limit) {
      if (!text) return '';
      if (text.length <= limit) return text;
      return text.slice(0, limit) + '...';
    }

    function cleanNameCandidate(raw) {
      if (!raw) return '';
      let name = raw.replace(/[\\t]+/g, ' ').replace(/\\s+/g, ' ').trim();
      name = name.replace(/\\([^\\)]*\\)/g, ' ').trim();
      name = name.replace(/\\s*\\|.*$/g, '').trim();
      name = name.replace(/\\b(email|correo|phone|tel|telefono|teléfono|address|direccion|dirección)\\b.*$/i, '').trim();
      name = name.replace(/[<>]/g, '').trim();
      name = name.replace(/[@0-9]/g, '').trim();
      name = name.replace(/\\s{2,}/g, ' ').trim();
      let parts = name.split(' ').filter(Boolean);
      const dropTokens = new Set([
        'perfil', 'profile', 'resume', 'cv', 'curriculum', 'resumen', 'objetivo', 'objective'
      ]);
      parts = parts.filter((p) => !dropTokens.has(p.toLowerCase()));
      if (parts.length > 4) return parts.slice(0, 4).join(' ');
      return parts.join(' ');
    }

    function isLikelyInvalidName(name) {
      if (!name) return true;
      const lower = name.toLowerCase();
      if (/[&/]/.test(name)) return true;
      if (/\\b(restaurant|restaurante|experience|experiencia|profile|perfil|skills|habilidades|education|educacion|objective|objetivo|summary|resumen|curriculum|cv|resume|miami|fl|server|bartender|cook|cashier|runner|manager|idioma|idiomas|language|languages|ubicacion|ubicación|location|telefono|teléfono|phone|correo|email|service|services|customer|food|kitchen|dishwasher|barista|host|hostess|waiter|waitress|driver|delivery|employee|employment|work|history|professional|assistant|supervisor)\\b/i.test(lower)) {
        return true;
      }
      if (/[0-9]/.test(name)) return true;
      return false;
    }

    function extractEmailFromCv(text) {
      if (!text) return '';
      const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/i);
      return match ? match[0] : '';
    }

    function deriveNameFromEmail(email) {
      if (!email) return '';
      const local = email.split('@')[0] || '';
      const cleaned = local.replace(/[^a-zA-Z._-]/g, '');
      const parts = cleaned.split(/[._-]+/).filter(Boolean);
      if (parts.length < 2) return '';
      if (parts.some((p) => p.length < 2)) return '';
      const name = parts.slice(0, 3).map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
      return name;
    }

    function extractNameFromCv(text) {
      if (!text) return '';
      const normalized = text.replace(/\\r/g, '\\n');
      const labelInlineRe = /\\b(?:name|nombre|candidate|applicant|nombre\\s+y\\s+apellido|apellido\\s+y\\s+nombre)\\b\\s*[:\\-]?\\s*([^\\n]+?)(?:\\bemail\\b|\\bcorreo\\b|\\bphone\\b|\\btel\\b|\\btelefono\\b|\\btel[ée]fono\\b|\\bdireccion\\b|\\bdirecci[oó]n\\b|\\baddress\\b|$)/i;
      const inlineMatch = normalized.match(labelInlineRe);
      if (inlineMatch && inlineMatch[1]) {
        const cleaned = cleanNameCandidate(inlineMatch[1]);
        if (cleaned.split(' ').length >= 2 && !isLikelyInvalidName(cleaned)) return cleaned;
      }
      const lines = normalized.split(/\\n+/).map((l) => l.trim()).filter(Boolean);
      const labelRe = /^(?:name|nombre|candidate|applicant|nombre\\s+y\\s+apellido|apellido\\s+y\\s+nombre)\\s*[:\\-]\\s*(.+)$/i;
      for (const line of lines) {
        const match = line.match(labelRe);
        if (match && match[1]) {
          const cleaned = cleanNameCandidate(match[1]);
          if (cleaned.split(' ').length >= 2 && !isLikelyInvalidName(cleaned)) return cleaned;
        }
      }
      const inlineRe = /\\b(?:name|nombre)\\s*[:\\-]\\s*([A-Za-zÁÉÍÓÚÑñ'.-]+\\s+[A-Za-zÁÉÍÓÚÑñ'.-]+(?:\\s+[A-Za-zÁÉÍÓÚÑñ'.-]+){0,2})/i;
      for (const line of lines) {
        const match = line.match(inlineRe);
        if (match && match[1]) {
          const cleaned = cleanNameCandidate(match[1]);
          if (cleaned.split(' ').length >= 2 && !isLikelyInvalidName(cleaned)) return cleaned;
        }
      }
      for (const line of lines.slice(0, 4)) {
        if (/@/.test(line)) continue;
        if (/\\d/.test(line)) continue;
        const cleaned = cleanNameCandidate(line);
        const parts = cleaned.split(' ').filter(Boolean);
        if (parts.length >= 2 && parts.length <= 4 && !isLikelyInvalidName(cleaned)) return cleaned;
      }
      const head = normalized.slice(0, 200);
      const stopIdx = head.search(/\\b(email|correo|phone|tel|telefono|tel[ée]fono|address|direccion|direcci[oó]n)\\b/i);
      const headSegment = stopIdx > 0 ? head.slice(0, stopIdx) : head;
      const headClean = headSegment
        .replace(/[^A-Za-zÁÉÍÓÚÑñ'.-\\s]/g, ' ')
        .replace(/\\s+/g, ' ')
        .trim();
      if (headClean) {
        const parts = headClean.split(' ').filter(Boolean);
        if (parts.length >= 2) {
          const candidate = parts.slice(0, 4).join(' ');
          if (!isLikelyInvalidName(candidate)) return candidate;
        }
      }
      const email = extractEmailFromCv(normalized);
      const derived = deriveNameFromEmail(email);
      if (derived && !isLikelyInvalidName(derived)) return derived;
      return '';
    }

    function formatPhoneForUi(raw) {
      const digits = String(raw || '').replace(/\\D/g, '');
      if (!digits) return '';
      if (digits.length === 10) return '+1' + digits;
      if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
      if (String(raw).trim().startsWith('+')) return '+' + digits;
      if (digits.length >= 12 && digits.length <= 15) return '+' + digits;
      return String(raw || '').trim();
    }

    function extractPhoneFromCv(text) {
      if (!text) return '';
      const candidates = [];
      const normalized = text.replace(/\\s+/g, ' ');
      const patterns = [
        /(?:\\+?\\d{1,3}[\\s().-]?)?(?:\\(?\\d{3}\\)?[\\s.-]?\\d{3}[\\s.-]?\\d{4})/g,
        /\\+?\\d[\\d\\s().-]{8,}\\d/g
      ];
      patterns.forEach((re) => {
        let match;
        while ((match = re.exec(normalized))) {
          const raw = match[0] || '';
          const digits = raw.replace(/\\D/g, '');
          if (digits.length < 10 || digits.length > 15) continue;
          candidates.push({ raw, index: match.index || 0 });
        }
      });
      if (!candidates.length) return '';
      candidates.sort((a, b) => a.index - b.index);
      return formatPhoneForUi(candidates[0].raw);
    }

    function maybeFillNameFromCv(text) {
      if (callNameEl.value && callNameEl.value.trim()) return;
      const name = extractNameFromCv(text || '');
      if (name) {
        callNameEl.value = name;
      }
    }

    function maybeFillPhoneFromCv(text) {
      if (callPhoneEl.value && callPhoneEl.value.trim()) return;
      const phone = extractPhoneFromCv(text || '');
      if (phone) {
        callPhoneEl.value = phone;
      }
    }

    function maybeFillContactFromCv(text) {
      maybeFillNameFromCv(text);
      maybeFillPhoneFromCv(text);
    }

    function needsContactOcr() {
      const name = (callNameEl.value || '').trim();
      const phone = (callPhoneEl.value || '').trim();
      if (!name || isLikelyInvalidName(name)) return true;
      if (!phone) return true;
      return false;
    }

    function applyAiContactResult(result = {}) {
      const currentName = (callNameEl.value || '').trim();
      const aiName = cleanNameCandidate(result.name || '');
      if ((!currentName || isLikelyInvalidName(currentName)) && aiName && !isLikelyInvalidName(aiName)) {
        callNameEl.value = aiName;
      }
      const aiPhone = formatPhoneForUi(result.phone || '');
      if (aiPhone && !callPhoneEl.value.trim()) {
        callPhoneEl.value = aiPhone;
      }
    }

    async function loadPdfDocument(file) {
      if (!window.pdfjsLib) throw new Error('PDF parser no disponible');
      const buffer = await file.arrayBuffer();
      return window.pdfjsLib.getDocument({ data: buffer }).promise;
    }

    async function extractPdfTextFromDoc(pdf) {
      const pages = Math.min(pdf.numPages || 0, MAX_PDF_PAGES);
      let text = '';
      for (let i = 1; i <= pages; i += 1) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const pageText = content.items.map((item) => item.str).join(' ');
        text += pageText + '\\n';
      }
      return text.trim();
    }

    async function renderPdfToImages(pdf, maxPages) {
      const pages = Math.min(pdf.numPages || 0, maxPages);
      const images = [];
      for (let i = 1; i <= pages; i += 1) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 1.4 });
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        images.push(canvas.toDataURL('image/jpeg', OCR_JPEG_QUALITY));
      }
      return images;
    }

    async function fileToDataUrl(file) {
      const bitmap = await createImageBitmap(file);
      const maxDim = Math.max(bitmap.width, bitmap.height);
      const scale = maxDim > OCR_MAX_DIM ? OCR_MAX_DIM / maxDim : 1;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', OCR_JPEG_QUALITY);
    }

    async function readFileAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result || '');
        reader.onerror = () => reject(new Error('No se pudo leer el archivo.'));
        reader.readAsDataURL(file);
      });
    }

    async function runOcr(images) {
      if (!tokenEl.value) throw new Error('Necesitás autenticarte para usar OCR.');
      const resp = await fetch('/admin/ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokenEl.value },
        body: JSON.stringify({ images })
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || 'ocr failed');
      return (data.text || '').trim();
    }

    async function runContactAi(text) {
      if (!tokenEl.value) throw new Error('Necesitás autenticarte para detectar contacto.');
      const payload = { text: (text || '').slice(0, 4000) };
      const resp = await fetch('/admin/extract-contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokenEl.value },
        body: JSON.stringify(payload)
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || 'contact extract failed');
      return {
        name: (data.name || '').toString(),
        phone: (data.phone || '').toString(),
        email: (data.email || '').toString()
      };
    }

    async function runFaceDetect(imageDataUrl) {
      if (!tokenEl.value) throw new Error('Necesitás autenticarte para detectar foto.');
      const resp = await fetch('/admin/face-detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokenEl.value },
        body: JSON.stringify({ image: imageDataUrl })
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || 'face detect failed');
      return data.face || null;
    }

    function clampValue(val, min, max) {
      return Math.min(max, Math.max(min, val));
    }

    function normalizeFaceBox(face) {
      if (!face) return null;
      const box = {
        left: clampValue(face.left || 0, 0, 1),
        top: clampValue(face.top || 0, 0, 1),
        width: clampValue(face.width || 0, 0, 1),
        height: clampValue(face.height || 0, 0, 1)
      };
      if (!box.width || !box.height) return null;
      const area = box.width * box.height;
      const aspect = box.width / box.height;
      if (box.width > 0.65 || box.height > 0.65 || area > 0.35) return null;
      if (box.width < 0.05 || box.height < 0.05 || area < 0.003) return null;
      if (!Number.isFinite(aspect) || aspect < 0.5 || aspect > 1.8) return null;
      return {
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        centerX: box.left + box.width / 2,
        centerY: box.top + box.height / 2
      };
    }

    async function downscaleDataUrl(dataUrl, maxDim = OCR_MAX_DIM) {
      if (!dataUrl) return '';
      const img = new Image();
      const loaded = new Promise((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('No se pudo cargar la imagen.'));
      });
      img.src = dataUrl;
      await loaded;
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (!w || !h) return dataUrl;
      const maxSide = Math.max(w, h);
      if (maxSide <= maxDim) return dataUrl;
      const scale = maxDim / maxSide;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.86);
    }

    async function cropPhotoThumbnail(imageDataUrl, box, maxSide = 360) {
      if (!imageDataUrl || !box) return '';
      const img = new Image();
      const loaded = new Promise((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('No se pudo cargar la imagen.'));
      });
      img.src = imageDataUrl;
      await loaded;
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (!w || !h) return '';
      const padX = 0.3;
      const padY = 0.6;
      const bw = box.width * w;
      const bh = box.height * h;
      const cx = (box.left + box.width / 2) * w;
      const cy = (box.top + box.height / 2) * h - (bh * 0.18);
      const sw = Math.min(w, bw * (1 + padX));
      const sh = Math.min(h, bh * (1 + padY));
      const sx = clampValue(cx - sw / 2, 0, w - sw);
      const sy = clampValue(cy - sh / 2, 0, h - sh);
      const scale = Math.min(1, maxSide / Math.max(sw, sh));
      const outW = Math.max(1, Math.round(sw * scale));
      const outH = Math.max(1, Math.round(sh * scale));
      const canvas = document.createElement('canvas');
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH);
      return canvas.toDataURL('image/jpeg', 0.86);
    }

    async function fetchPhotoDataUrl(url) {
      if (!url) return '';
      if (url.startsWith('data:')) return url;
      if (!tokenEl.value) throw new Error('Necesitás autenticarte para cargar la foto.');
      const resp = await fetch('/admin/cv-photo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokenEl.value },
        body: JSON.stringify({ url })
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || 'photo download failed');
      return data.data_url || '';
    }

    async function resolvePhotoThumb(url) {
      if (!url) return null;
      if (photoThumbCache.has(url)) return photoThumbCache.get(url);
      const task = (async () => {
        try {
          const dataUrl = await fetchPhotoDataUrl(url);
          if (!dataUrl) return null;
          const scaled = await downscaleDataUrl(dataUrl, OCR_MAX_DIM);
          const box = await runFaceDetect(scaled);
          const focus = normalizeFaceBox(box);
          if (!focus) return null;
          const thumb = await cropPhotoThumbnail(scaled, focus);
          if (!thumb) return null;
          return { thumb, focus };
        } catch (err) {
          console.error('[cv-face] detect failed', err);
          return null;
        }
      })();
      photoThumbCache.set(url, task);
      return task;
    }

    function applyFaceFocusToImg(imgEl, focus) {
      if (!imgEl) return;
      if (!focus || !Number.isFinite(focus.centerX) || !Number.isFinite(focus.centerY)) {
        imgEl.style.objectPosition = 'center';
        return;
      }
      const x = Math.round(clampValue(focus.centerX, 0, 1) * 100);
      const y = Math.round(clampValue(focus.centerY, 0, 1) * 100);
      imgEl.style.objectPosition = x + '% ' + y + '%';
    }

    function getFaceFocusFromEl(el) {
      if (!el) return null;
      const x = Number(el.dataset.faceX);
      const y = Number(el.dataset.faceY);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { centerX: x, centerY: y };
    }

    const photoTooltipEl = document.createElement('div');
    photoTooltipEl.className = 'photo-tooltip';
    const photoTooltipImg = document.createElement('img');
    photoTooltipImg.alt = 'Foto';
    photoTooltipEl.appendChild(photoTooltipImg);
    document.body.appendChild(photoTooltipEl);

    function positionPhotoTooltip(rect) {
      if (!rect) return;
      const pad = 12;
      const tipRect = photoTooltipEl.getBoundingClientRect();
      let left = rect.right + 10;
      if (left + tipRect.width + pad > window.innerWidth) {
        left = rect.left - tipRect.width - 10;
      }
      if (left < pad) left = pad;
      let top = rect.top;
      if (top + tipRect.height + pad > window.innerHeight) {
        top = window.innerHeight - tipRect.height - pad;
      }
      if (top < pad) top = pad;
      photoTooltipEl.style.left = left + 'px';
      photoTooltipEl.style.top = top + 'px';
    }

    function showPhotoTooltip(target, url) {
      if (!target || !url) return;
      applyFaceFocusToImg(photoTooltipImg, getFaceFocusFromEl(target));
      photoTooltipImg.src = url;
      photoTooltipEl.style.display = 'block';
      positionPhotoTooltip(target.getBoundingClientRect());
    }

    function hidePhotoTooltip() {
      photoTooltipEl.style.display = 'none';
    }

    function openPhotoModal(url) {
      if (!photoModalEl || !photoModalImgEl || !url) return;
      photoModalImgEl.src = url;
      photoModalImgEl.style.width = '';
      photoModalImgEl.style.height = '';
      photoModalImgEl.style.objectFit = 'contain';
      photoModalImgEl.style.objectPosition = 'center';
      photoModalEl.style.display = 'flex';
    }

    function closePhotoModal() {
      if (!photoModalEl || !photoModalImgEl) return;
      photoModalEl.style.display = 'none';
      photoModalImgEl.src = '';
      photoModalImgEl.style.width = '';
      photoModalImgEl.style.height = '';
      photoModalImgEl.style.objectFit = 'contain';
      photoModalImgEl.style.objectPosition = 'center';
    }

    function attachAvatarHandlers(avatar, url, focus) {
      if (!avatar || !url) return;
      avatar.tabIndex = 0;
      avatar.addEventListener('click', () => openPhotoModal(url));
      avatar.addEventListener('mouseenter', () => showPhotoTooltip(avatar, url));
      avatar.addEventListener('mouseleave', hidePhotoTooltip);
      avatar.addEventListener('focus', () => showPhotoTooltip(avatar, url));
      avatar.addEventListener('blur', hidePhotoTooltip);
      avatar.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') openPhotoModal(url);
      });
    }

    async function handleCvFile(file) {
      if (!file) return;
      currentCvSource = file.name || '';
      currentCvFileName = file.name || '';
      currentCvFileType = file.type || '';
      currentCvFileDataUrl = '';
      currentCvPhotoDataUrl = '';
      currentCvId = '';
      setCvStatus('Leyendo CV...');
      try {
        let text = '';
        let faceCandidates = [];
        if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
          const pdf = await loadPdfDocument(file);
          text = await extractPdfTextFromDoc(pdf);
          if (text.length < OCR_TEXT_THRESHOLD) {
            setCvStatus('PDF escaneado, aplicando OCR...');
            const images = await renderPdfToImages(pdf, OCR_MAX_PAGES);
            text = await runOcr(images);
            faceCandidates = images;
          } else {
            try {
              const images = await renderPdfToImages(pdf, Math.min(2, OCR_MAX_PAGES));
              faceCandidates = images;
            } catch (err) {
              console.error('[cv-face] render pdf failed', err);
            }
          }
          currentCvFileDataUrl = await readFileAsDataUrl(file);
        } else if (file.type.startsWith('image/')) {
          setCvStatus('Leyendo imagen con OCR...');
          const dataUrl = await fileToDataUrl(file);
          text = await runOcr([dataUrl]);
          currentCvFileDataUrl = dataUrl;
          faceCandidates = [dataUrl];
        } else if (file.type.startsWith('text/') || file.name.toLowerCase().endsWith('.txt')) {
          text = await file.text();
          currentCvFileDataUrl = '';
        } else {
          throw new Error('Formato no soportado (PDF, imagen o TXT).');
        }
        callCvTextEl.value = truncateText(text, CV_CHAR_LIMIT);
        maybeFillContactFromCv(callCvTextEl.value);
        if (needsContactOcr() && file.type === 'application/pdf') {
          setCvStatus('Buscando datos de contacto...');
          try {
            const pdf = await loadPdfDocument(file);
            const images = await renderPdfToImages(pdf, 1);
            const ocrText = await runOcr(images);
            maybeFillContactFromCv(ocrText);
          } catch (err) {
            console.error('[cv-contact] ocr fallback failed', err);
          }
        }
        if (needsContactOcr()) {
          setCvStatus('Detectando nombre con AI...');
          try {
            const ai = await runContactAi(callCvTextEl.value || text || '');
            applyAiContactResult(ai);
          } catch (err) {
            console.error('[cv-contact] ai failed', err);
          }
        }
        if (faceCandidates.length) {
          for (const candidate of faceCandidates) {
            try {
              const scaled = await downscaleDataUrl(candidate, OCR_MAX_DIM);
              const box = await runFaceDetect(scaled);
              if (!box) continue;
              const focus = normalizeFaceBox(box);
              if (!focus) continue;
              const thumb = await cropPhotoThumbnail(scaled, focus);
              if (thumb) {
                currentCvPhotoDataUrl = thumb;
                break;
              }
            } catch (err) {
              console.error('[cv-face] detect failed', err);
            }
          }
        }
        setCvStatus('CV listo (' + callCvTextEl.value.length + ' caracteres).');
      } catch (err) {
        setCvStatus('Error: ' + err.message);
      }
    }

    async function placeCall(payloadOverride = null) {
      if (authRole === 'viewer') {
        setCallStatus('Solo lectura.');
        return;
      }
      setCallStatus('Enviando llamada...');
      try {
        const basePayload = {
          to: callPhoneEl.value || '',
          brand: callBrandEl.value || '',
          role: callRoleEl.value || '',
          applicant: callNameEl.value || '',
          cv_summary: truncateText(callCvTextEl.value || '', CV_CHAR_LIMIT),
          cv_text: callCvTextEl.value || '',
          source: currentCvSource || ''
        };
        if (!basePayload.applicant.trim() || !basePayload.to.trim()) {
          maybeFillContactFromCv(basePayload.cv_text || basePayload.cv_summary || '');
          basePayload.applicant = callNameEl.value || basePayload.applicant;
          basePayload.to = callPhoneEl.value || basePayload.to;
        }
        if (!basePayload.applicant.trim()) {
          setCallStatus('Error: falta nombre y apellido.');
          return;
        }
        if (!basePayload.to.trim()) {
          setCallStatus('Error: falta teléfono.');
          return;
        }
        if (!basePayload.cv_summary) {
          setCallStatus('Error: falta CV.');
          return;
        }
        let cvId = payloadOverride?.cv_id || currentCvId || '';
        if (!cvId && basePayload.cv_text) {
          const saved = await saveCvEntry({ silent: true });
          if (saved && saved.id) {
            cvId = saved.id;
            currentCvId = saved.id;
          }
        }
        const payload = payloadOverride ? { ...basePayload, ...payloadOverride } : basePayload;
        if (cvId) payload.cv_id = cvId;
        if (!payload.cv_summary && payload.cv_text) {
          payload.cv_summary = truncateText(payload.cv_text, CV_CHAR_LIMIT);
        }
        const resp = await fetch('/call', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokenEl.value },
          body: JSON.stringify(payload)
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || 'call failed');
        setCallStatus('Llamada encolada: ' + (data.callId || data.status || 'OK'));
        cvPollUntil = Date.now() + 120000;
        scheduleResultsLoad();
        scheduleCvLoad();
      } catch (err) {
        setCallStatus('Error: ' + err.message);
      }
    }

    function formatDate(value) {
      if (!value) return '—';
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return value;
      return d.toLocaleString();
    }

    function buildDateCell(value) {
      const td = document.createElement('td');
      if (!value) {
        td.textContent = '—';
        return td;
      }
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) {
        td.textContent = value;
        return td;
      }
      const dateText = d.toLocaleDateString();
      const timeText = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const stack = document.createElement('div');
      stack.className = 'date-stack';
      const dateLine = document.createElement('div');
      dateLine.className = 'date-main';
      dateLine.textContent = dateText;
      const timeLine = document.createElement('div');
      timeLine.className = 'date-sub';
      timeLine.textContent = timeText;
      stack.appendChild(dateLine);
      stack.appendChild(timeLine);
      td.appendChild(stack);
      return td;
    }

    function formatAudioTime(seconds) {
      const total = Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds) : 0;
      const mins = Math.floor(total / 60);
      const secs = Math.floor(total % 60);
      return mins + ":" + String(secs).padStart(2, "0");
    }

    async function downloadAudio(url, filename) {
      if (!url) return;
      try {
        const headers = {};
        if (url.startsWith('/') && tokenEl.value) {
          headers.Authorization = 'Bearer ' + tokenEl.value;
        }
        const resp = await fetch(url, { headers });
        if (!resp.ok) throw new Error('download failed');
        const contentType = resp.headers.get('content-type') || '';
        let ext = '';
        if (contentType.includes('wav')) ext = 'wav';
        else if (contentType.includes('mpeg')) ext = 'mp3';
        const blob = await resp.blob();
        const objectUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = filename || ('audio' + (ext ? '.' + ext : ''));
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      } catch (err) {
        window.open(url, '_blank');
      }
    }

    function buildAudioPlayer(url, opts = {}) {
      const downloadUrl = opts.downloadUrl || url;
      const downloadName = opts.downloadName || 'audio.mp3';
      const wrap = document.createElement('div');
      wrap.className = 'audio-player';
      const audio = document.createElement('audio');
      audio.className = 'audio-hidden';
      audio.src = url;
      audio.preload = 'metadata';

      const playBtn = document.createElement('button');
      playBtn.type = 'button';
      playBtn.className = 'audio-play';
      playBtn.textContent = '▶';

      const progress = document.createElement('input');
      progress.type = 'range';
      progress.className = 'audio-progress';
      progress.min = '0';
      progress.max = '100';
      progress.step = '0.1';
      progress.value = '0';

      const time = document.createElement('span');
      time.className = 'audio-time';
      time.textContent = '0:00 / 0:00';

      const menu = document.createElement('div');
      menu.className = 'audio-menu';
      const menuBtn = document.createElement('button');
      menuBtn.type = 'button';
      menuBtn.className = 'audio-menu-btn';
      menuBtn.textContent = '⋯';
      const menuList = document.createElement('div');
      menuList.className = 'audio-speed-menu';
      const speeds = [1, 1.25, 1.5, 1.75, 2];
      speeds.forEach((speed) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = speed + 'x';
        btn.onclick = (event) => {
          event.stopPropagation();
          audio.playbackRate = speed;
          menu.classList.remove('open');
          menu.classList.remove('open-up');
        };
        menuList.appendChild(btn);
      });
      menuBtn.onclick = (event) => {
        event.stopPropagation();
        const isOpen = menu.classList.contains('open');
        document.querySelectorAll('.audio-menu.open').forEach((other) => {
          if (other !== menu) {
            other.classList.remove('open');
            other.classList.remove('open-up');
          }
        });
        if (isOpen) {
          menu.classList.remove('open');
          menu.classList.remove('open-up');
          return;
        }
        menu.classList.add('open');
        menu.classList.remove('open-up');
        const wrapper = menu.closest('.table-wrapper');
        if (wrapper) {
          const wrapperRect = wrapper.getBoundingClientRect();
          const menuRect = menuList.getBoundingClientRect();
          const btnRect = menu.getBoundingClientRect();
          const spaceBelow = wrapperRect.bottom - btnRect.bottom;
          const spaceAbove = btnRect.top - wrapperRect.top;
          if (spaceBelow < menuRect.height + 8 && spaceAbove >= menuRect.height + 8) {
            menu.classList.add('open-up');
          } else if (spaceBelow < menuRect.height + 8 && spaceAbove > spaceBelow) {
            menu.classList.add('open-up');
          }
        }
      };
      menu.appendChild(menuBtn);
      menu.appendChild(menuList);

      const downloadBtn = document.createElement('button');
      downloadBtn.type = 'button';
      downloadBtn.className = 'audio-download';
      downloadBtn.textContent = '⬇';
      downloadBtn.title = 'Descargar audio';
      downloadBtn.setAttribute('aria-label', 'Descargar audio');
      downloadBtn.disabled = !downloadUrl;
      downloadBtn.onclick = (event) => {
        event.stopPropagation();
        downloadAudio(downloadUrl || url, downloadName);
      };

      playBtn.onclick = (event) => {
        event.stopPropagation();
        if (audio.paused) {
          audio.play().catch(() => {});
        } else {
          audio.pause();
        }
      };

      audio.addEventListener('play', () => { playBtn.textContent = '❚❚'; });
      audio.addEventListener('pause', () => { playBtn.textContent = '▶'; });
      audio.addEventListener('ended', () => { playBtn.textContent = '▶'; });

      const updateProgress = () => {
        const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
        const current = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
        const pct = duration ? (current / duration) * 100 : 0;
        progress.value = String(pct);
        time.textContent = formatAudioTime(current) + ' / ' + formatAudioTime(duration);
      };
      audio.addEventListener('timeupdate', updateProgress);
      audio.addEventListener('loadedmetadata', updateProgress);

      progress.addEventListener('input', (event) => {
        event.stopPropagation();
        const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
        if (!duration) return;
        const pct = Number(progress.value) / 100;
        audio.currentTime = duration * pct;
      });

      wrap.appendChild(playBtn);
      wrap.appendChild(progress);
      wrap.appendChild(time);
      wrap.appendChild(downloadBtn);
      wrap.appendChild(menu);
      wrap.appendChild(audio);
      return wrap;
    }

    function outcomeText(outcome, detail) {
      const label = OUTCOME_LABELS[outcome] || '';
      const cleanDetail = (detail || '').trim();
      if (label) return label;
      if (cleanDetail) return cleanDetail;
      return '';
    }

    function formatInterviewSummary(call) {
      if (call.summary && call.summary.trim()) return call.summary;
      const status = outcomeText(call.outcome, call.outcome_detail);
      if (call.outcome === 'NO_ANSWER' && call.attempts > 1) {
        return status
          ? status + " (" + call.attempts + " intentos)"
          : "No contestó (" + call.attempts + " intentos)";
      }
      return status || '—';
    }

    function addDetailItem(grid, label, value) {
      if (value === undefined || value === null || value === '') return;
      const item = document.createElement('div');
      item.className = 'detail-item';
      const lab = document.createElement('div');
      lab.className = 'detail-label';
      lab.textContent = label;
      const val = document.createElement('div');
      val.className = 'detail-value';
      val.textContent = value;
      item.appendChild(lab);
      item.appendChild(val);
      grid.appendChild(item);
    }

    function addDetailBlock(container, label, value) {
      if (!value) return;
      const block = document.createElement('div');
      block.className = 'detail-block';
      const title = document.createElement('div');
      title.className = 'detail-label';
      title.textContent = label;
      const body = document.createElement('div');
      body.textContent = value;
      block.appendChild(title);
      block.appendChild(body);
      container.appendChild(block);
    }

    function buildInterviewDetailCard(call) {
      const card = document.createElement('div');
      card.className = 'detail-card';
      const grid = document.createElement('div');
      grid.className = 'detail-grid';
      const brandLabel = call.brandKey ? getBrandDisplayByKey(call.brandKey) : (call.brand || '');
      const roleLabel = getRoleDisplayForBrand(call.brandKey || call.brand, call.role || call.roleKey || '');
      const statusText = formatInterviewSummary(call);
      const stay = call.stay_plan ? (call.stay_detail ? call.stay_plan + ' (' + call.stay_detail + ')' : call.stay_plan) : '';
      const englishLabel = call.english_detail ? (call.english + ' (' + call.english_detail + ')') : (call.english || '');

      const head = document.createElement('div');
      head.className = 'detail-head';
      const headLeft = document.createElement('div');
      headLeft.className = 'detail-head-left';
      const nameEl = document.createElement('div');
      nameEl.className = 'detail-name';
      nameEl.textContent = call.applicant || '—';
      const metaEl = document.createElement('div');
      metaEl.className = 'detail-meta';
      const metaParts = [brandLabel, roleLabel, formatDate(call.created_at)].filter(Boolean);
      metaEl.textContent = metaParts.join(' • ');
      headLeft.appendChild(nameEl);
      headLeft.appendChild(metaEl);
      const headRight = document.createElement('div');
      headRight.className = 'detail-head-right';
      const statusEl = document.createElement('div');
      statusEl.className = 'detail-status';
      statusEl.textContent = statusText || '—';
      const scoreEl = scorePill(call.score);
      scoreEl.classList.add('detail-score');
      headRight.appendChild(statusEl);
      headRight.appendChild(scoreEl);
      head.appendChild(headLeft);
      head.appendChild(headRight);
      card.appendChild(head);
      card.appendChild(grid);

      addDetailItem(grid, 'Local', brandLabel);
      addDetailItem(grid, 'Posición', roleLabel);
      addDetailItem(grid, 'Teléfono', call.phone || '');
      if (call.outcome === 'NO_ANSWER' && call.attempts > 1) {
        addDetailItem(grid, 'Intentos', String(call.attempts));
      }
      addDetailItem(grid, 'Recomendación', recommendationLabel(call.recommendation));
      addDetailItem(grid, 'Calidez', call.warmth !== null && call.warmth !== undefined ? String(call.warmth) : '');
      addDetailItem(grid, 'Fluidez', call.fluency !== null && call.fluency !== undefined ? String(call.fluency) : '');
      addDetailItem(grid, 'Inglés', englishLabel);
      addDetailItem(grid, 'Zona', call.area || '');
      addDetailItem(grid, 'Disponibilidad', call.availability || '');
      addDetailItem(grid, 'Se queda en EE.UU.', stay || '');
      addDetailItem(grid, 'Expectativa salarial', call.salary || '');

      addDetailBlock(card, 'Experiencia', call.experience || '');
      addDetailBlock(card, 'Resumen', call.summary || '');

      const actions = document.createElement('div');
      actions.className = 'detail-actions';
      if (call.cv_url) {
        const cvLink = document.createElement('a');
        cvLink.href = call.cv_url;
        cvLink.target = '_blank';
        cvLink.rel = 'noopener';
        cvLink.textContent = 'Abrir CV';
        cvLink.className = 'secondary btn-compact';
        cvLink.style.textDecoration = 'none';
        actions.appendChild(cvLink);
      }
      if (call.audio_url) {
        const downloadId = call.callId || (Array.isArray(call.callIds) ? call.callIds[0] : '');
        const downloadUrl = downloadId ? '/admin/calls/' + encodeURIComponent(downloadId) + '/audio' : call.audio_url;
        const downloadName = 'interview_' + (downloadId || 'audio') + '.mp3';
        actions.appendChild(buildAudioPlayer(call.audio_url, { downloadUrl, downloadName }));
      }
      if (authRole === 'admin' && call.callId) {
        const waBtn = document.createElement('button');
        waBtn.type = 'button';
        waBtn.className = 'secondary btn-compact';
        waBtn.textContent = 'WhatsApp';
        waBtn.onclick = (event) => {
          event.stopPropagation();
          sendInterviewWhatsapp(call);
        };
        actions.appendChild(waBtn);
      }
      if (actions.children.length) {
        card.appendChild(actions);
      }
      return card;
    }

    function toggleInterviewDetailsRow(tr, call) {
      if (!tr || !resultsBodyEl) return;
      const existing = tr.nextElementSibling;
      if (existing && existing.classList.contains('detail-row')) {
        existing.remove();
        tr.classList.remove('expanded');
        return;
      }
      resultsBodyEl.querySelectorAll('tr.detail-row').forEach((row) => row.remove());
      resultsBodyEl.querySelectorAll('tr.row-clickable.expanded').forEach((row) => row.classList.remove('expanded'));
      const detailTr = document.createElement('tr');
      detailTr.className = 'detail-row';
      const detailTd = document.createElement('td');
      const colCount = resultsBodyEl.closest('table')?.querySelectorAll('thead th').length || 8;
      detailTd.colSpan = colCount;
      detailTd.appendChild(buildInterviewDetailCard(call));
      detailTr.appendChild(detailTd);
      tr.after(detailTr);
      tr.classList.add('expanded');
    }

    function formatInterviewDetails(call) {
      if (!call || typeof call !== 'object') return '';
      const lines = [];
      const push = (label, value) => {
        if (value === undefined || value === null || value === '') return;
        lines.push(label + ': ' + value);
      };
      const outcome = outcomeText(call.outcome, call.outcome_detail);
      push('Local', call.brand || '');
      push('Posición', call.role || '');
      push('Candidato', call.applicant || '');
      push('Teléfono', call.phone || '');
      push('Fecha', formatDate(call.created_at));
      push('Resultado', outcome || '');
      if (call.attempts && call.outcome === 'NO_ANSWER') {
        push('Intentos', call.attempts);
      }
      push('Recomendación', recommendationLabel(call.recommendation));
      push('Score', call.score !== null && call.score !== undefined ? call.score : '');
      push('Calidez', call.warmth !== null && call.warmth !== undefined ? call.warmth : '');
      push('Fluidez', call.fluency !== null && call.fluency !== undefined ? call.fluency : '');
      if (call.english_detail) {
        push('Inglés', call.english + ' (' + call.english_detail + ')');
      } else {
        push('Inglés', call.english || '');
      }
      push('Experiencia', call.experience || '');
      push('Zona', call.area || '');
      push('Disponibilidad', call.availability || '');
      push('Expectativa salarial', call.salary || '');
      if (call.stay_plan) {
        push('Se queda en EE.UU.', call.stay_detail ? call.stay_plan + ' (' + call.stay_detail + ')' : call.stay_plan);
      }
      if (call.summary) {
        lines.push('');
        lines.push('Resumen:');
        lines.push(call.summary);
      }
      if (call.cv_url) {
        lines.push('');
        lines.push('CV archivo: ' + call.cv_url);
      }
      if (call.cv_text) {
        lines.push('');
        lines.push('CV texto:');
        lines.push(call.cv_text);
      }
      if (call.audio_url) {
        lines.push('');
        lines.push('Audio: ' + call.audio_url);
      }
      return lines.join('\\n');
    }

    function cvStatusInfo(item) {
      const statusLabel = outcomeText(item.last_outcome, item.last_outcome_detail);
      const hasCalls = Number(item.call_count || 0) > 0 || !!statusLabel || !!item.last_call_at;
      const isNoAnswer = item.last_outcome === 'NO_ANSWER';
      const attempts = Number(item.call_count || 0);
      let statusText = !hasCalls ? 'Sin llamadas' : (statusLabel || 'Entrevista realizada');
      let statusClass = '';
      const inCall = !!item.active_call;
      if (inCall) {
        statusText = 'Llamada en curso';
        statusClass = 'status-live';
      }
      if (!inCall && isNoAnswer && attempts > 1) {
        statusText = statusText + " (" + attempts + " intentos)";
      }
      const category = inCall ? 'in_call' : (!hasCalls ? 'no_calls' : (isNoAnswer ? 'no_answer' : 'interviewed'));
      return { hasCalls, isNoAnswer, statusText, statusClass, category, attempts, inCall };
    }

    function recommendationBadge(rec) {
      const span = document.createElement('span');
      span.className = 'badge ' + (rec || 'review');
      const dot = document.createElement('span');
      dot.className = 'dot';
      span.appendChild(dot);
      const label = document.createElement('span');
      if (rec === 'advance') label.textContent = 'Avanzar';
      else if (rec === 'reject') label.textContent = 'No avanzar';
      else label.textContent = 'Revisar';
      span.appendChild(label);
      return span;
    }

    function recommendationLabel(rec) {
      if (rec === 'advance') return 'Avanzar';
      if (rec === 'reject') return 'No avanzar';
      if (rec === 'review') return 'Revisar';
      return rec || '';
    }

    function scorePill(score) {
      const span = document.createElement('span');
      span.className = 'score-pill';
      if (typeof score !== 'number') {
        span.textContent = '—';
        span.classList.add('score-mid');
        return span;
      }
      const clamped = Math.max(0, Math.min(100, Number(score)));
      span.textContent = Math.round(clamped);
      const hue = Math.round((clamped / 100) * 120);
      span.style.background = "hsl(" + hue + " 70% 88%)";
      span.style.color = "hsl(" + hue + " 55% 30%)";
      return span;
    }

    function normalizePhoneKey(phone) {
      return String(phone || '').replace(/\D/g, '');
    }

    function buildCallGroupKey(call) {
      const brandKey = (call.brandKey || call.brand || '').toLowerCase().trim();
      const roleKey = (call.roleKey || call.role || '').toLowerCase().trim();
      const phone = normalizePhoneKey(call.phone || '');
      const applicant = (call.applicant || '').toLowerCase().trim();
      if (call.cv_id) return "cv:" + call.cv_id;
      if (phone) return "p:" + brandKey + "|" + roleKey + "|" + phone;
      return "a:" + brandKey + "|" + roleKey + "|" + applicant;
    }

    function groupCalls(calls) {
      const map = new Map();
      (calls || []).forEach((call) => {
        const key = buildCallGroupKey(call);
        const createdAt = call.created_at ? new Date(call.created_at).getTime() : 0;
        let entry = map.get(key);
        if (!entry) {
          entry = {
            ...call,
            attempts: 0,
            noAnswerAttempts: 0,
            callIds: [],
            cvIds: [],
            decision: call.decision || '',
            _latestAt: createdAt
          };
          map.set(key, entry);
        }
        entry.attempts += 1;
        if (call.outcome === 'NO_ANSWER') entry.noAnswerAttempts += 1;
        if (call.callId) entry.callIds.push(call.callId);
        const cvId = call.cv_id || call.cvId || '';
        if (cvId && !entry.cvIds.includes(cvId)) entry.cvIds.push(cvId);
        if (!entry.source && call.source) entry.source = call.source;
        if (!entry.cv_url && call.cv_url) entry.cv_url = call.cv_url;
        if (!entry.cv_text && call.cv_text) entry.cv_text = call.cv_text;
        if (!entry.cv_id && call.cv_id) entry.cv_id = call.cv_id;
        const prevSource = entry.source || '';
        const prevCvUrl = entry.cv_url || '';
        const prevCvText = entry.cv_text || '';
        const prevCvId = entry.cv_id || '';
        if (!entry._latestAt || createdAt >= entry._latestAt) {
          Object.assign(entry, call);
          entry._latestAt = createdAt;
          if (!entry.source && prevSource) entry.source = prevSource;
          if (!entry.cv_url && prevCvUrl) entry.cv_url = prevCvUrl;
          if (!entry.cv_text && prevCvText) entry.cv_text = prevCvText;
          if (!entry.cv_id && prevCvId) entry.cv_id = prevCvId;
        } else {
          if (!entry.source && prevSource) entry.source = prevSource;
          if (!entry.cv_url && prevCvUrl) entry.cv_url = prevCvUrl;
          if (!entry.cv_text && prevCvText) entry.cv_text = prevCvText;
          if (!entry.cv_id && prevCvId) entry.cv_id = prevCvId;
        }
        if (!entry.decision && call.decision) {
          entry.decision = call.decision;
        }
      });
      return Array.from(map.values());
    }

    function buildCvGroupKey(item) {
      const brandKey = (item.brandKey || item.brand || '').toLowerCase().trim();
      const roleKey = (item.roleKey || item.role || '').toLowerCase().trim();
      const phone = normalizePhoneKey(item.phone || '');
      const applicant = (item.applicant || '').toLowerCase().trim();
      if (phone) return "p:" + brandKey + "|" + roleKey + "|" + phone;
      return "a:" + brandKey + "|" + roleKey + "|" + applicant;
    }

    function groupCandidates(list) {
      const map = new Map();
      (list || []).forEach((item) => {
        const key = buildCvGroupKey(item);
        const createdAt = item.created_at ? new Date(item.created_at).getTime() : 0;
        const lastCallAt = item.last_call_at ? new Date(item.last_call_at).getTime() : 0;
        let entry = map.get(key);
        if (!entry) {
          entry = {
            ...item,
            custom_question: item.custom_question || "",
            cvIds: [],
            call_count: Number(item.call_count || 0),
            active_call: !!item.active_call,
            active_call_status: item.active_call_status || '',
            _latestAt: createdAt,
            _lastCallAt: lastCallAt
          };
          map.set(key, entry);
        }
        if (item.id) entry.cvIds.push(item.id);
        entry.call_count = Math.max(entry.call_count || 0, Number(item.call_count || 0));
        if (!entry._latestAt || createdAt >= entry._latestAt) {
          entry._latestAt = createdAt;
          entry.brand = item.brand;
          entry.brandKey = item.brandKey;
          entry.role = item.role;
          entry.roleKey = item.roleKey;
          entry.applicant = item.applicant;
          entry.phone = item.phone;
          entry.cv_text = item.cv_text;
          entry.cv_url = item.cv_url;
          entry.cv_photo_url = item.cv_photo_url;
          entry.custom_question = item.custom_question || entry.custom_question || "";
          entry.decision = item.decision || entry.decision || "";
          entry.created_at = item.created_at;
          entry.source = item.source;
        }
        if (!entry.decision && item.decision) {
          entry.decision = item.decision;
        }
        if (!entry.custom_question && item.custom_question) {
          entry.custom_question = item.custom_question;
        }
        if (item.active_call) {
          entry.active_call = true;
          entry.active_call_status = item.active_call_status || entry.active_call_status;
        }
        if (lastCallAt && (!entry._lastCallAt || lastCallAt >= entry._lastCallAt)) {
          entry._lastCallAt = lastCallAt;
          entry.last_call_at = item.last_call_at;
          entry.last_outcome = item.last_outcome;
          entry.last_outcome_detail = item.last_outcome_detail;
          entry.last_audio_url = item.last_audio_url;
          entry.last_call_sid = item.last_call_sid;
        }
      });
      return Array.from(map.values());
    }

    const summaryTooltipEl = document.createElement('div');
    summaryTooltipEl.className = 'summary-tooltip';
    document.body.appendChild(summaryTooltipEl);

    function positionSummaryTooltip(rect) {
      if (!rect) return;
      const pad = 12;
      const tipRect = summaryTooltipEl.getBoundingClientRect();
      let left = rect.left;
      if (left + tipRect.width + pad > window.innerWidth) {
        left = window.innerWidth - tipRect.width - pad;
      }
      if (left < pad) left = pad;
      let top = rect.bottom + 8;
      if (top + tipRect.height + pad > window.innerHeight) {
        top = rect.top - tipRect.height - 8;
      }
      if (top < pad) top = pad;
      summaryTooltipEl.style.left = Math.round(left) + "px";
      summaryTooltipEl.style.top = Math.round(top) + "px";
    }

    function showSummaryTooltip(target, text) {
      if (!text || text === '—') return;
      summaryTooltipEl.textContent = text;
      summaryTooltipEl.classList.add('visible');
      positionSummaryTooltip(target.getBoundingClientRect());
    }

    function hideSummaryTooltip() {
      summaryTooltipEl.classList.remove('visible');
    }

    window.addEventListener('scroll', hideSummaryTooltip, true);
    window.addEventListener('resize', hideSummaryTooltip);
    window.addEventListener('click', () => {
      document.querySelectorAll('.audio-menu.open, .audio-menu.open-up').forEach((menu) => {
        menu.classList.remove('open');
        menu.classList.remove('open-up');
      });
    });

    async function deleteInterview(callId) {
      if (!callId) return;
      if (!confirm('¿Seguro que querés borrar esta entrevista?')) return;
      try {
        const resp = await fetch('/admin/calls/' + encodeURIComponent(callId), {
          method: 'DELETE',
          headers: { Authorization: 'Bearer ' + tokenEl.value }
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || 'delete failed');
        loadResults();
      } catch (err) {
        alert('Error: ' + err.message);
      }
    }

    async function deleteInterviewGroup(call) {
      const ids = Array.isArray(call?.callIds) ? call.callIds.filter(Boolean) : [];
      const primaryId = call?.callId || '';
      const list = ids.length ? ids : (primaryId ? [primaryId] : []);
      if (!list.length) return;
      if (!confirm('¿Seguro que querés borrar esta entrevista?')) return;
      try {
        for (const id of list) {
          const resp = await fetch('/admin/calls/' + encodeURIComponent(id), {
            method: 'DELETE',
            headers: { Authorization: 'Bearer ' + tokenEl.value }
          });
          if (!resp.ok) {
            const data = await resp.json().catch(() => ({}));
            throw new Error(data.error || 'delete failed');
          }
        }
        loadResults();
      } catch (err) {
        alert('Error: ' + err.message);
      }
    }

    async function sendInterviewWhatsapp(call) {
      const callId = call?.callId || '';
      if (!callId) return;
      setStatus('Enviando entrevista por WhatsApp...');
      try {
        const resp = await fetch('/admin/calls/' + encodeURIComponent(callId) + '/whatsapp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokenEl.value }
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || 'whatsapp failed');
        setStatus('Entrevista enviada por WhatsApp.');
      } catch (err) {
        setStatus('Error: ' + err.message);
      } finally {
        setTimeout(() => {
          if (statusEl.textContent.startsWith('Entrevista enviada') || statusEl.textContent.startsWith('Enviando')) {
            setStatus('');
          }
        }, 3000);
      }
    }

    async function deleteCandidate(cvId) {
      if (!cvId) return;
      if (!confirm('¿Seguro que querés borrar este candidato?')) return;
      try {
        const resp = await fetch('/admin/cv/' + encodeURIComponent(cvId), {
          method: 'DELETE',
          headers: { Authorization: 'Bearer ' + tokenEl.value }
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || 'delete failed');
        loadCvList();
      } catch (err) {
        alert('Error: ' + err.message);
      }
    }

    async function deleteCandidateGroup(item) {
      const ids = Array.isArray(item?.cvIds) ? item.cvIds.filter(Boolean) : [];
      const primaryId = item?.id || '';
      const list = ids.length ? ids : (primaryId ? [primaryId] : []);
      if (!list.length) return;
      if (!confirm('¿Seguro que querés borrar este candidato?')) return;
      try {
        for (const id of list) {
          const resp = await fetch('/admin/cv/' + encodeURIComponent(id), {
            method: 'DELETE',
            headers: { Authorization: 'Bearer ' + tokenEl.value }
          });
          if (!resp.ok) {
            const data = await resp.json().catch(() => ({}));
            throw new Error(data.error || 'delete failed');
          }
        }
        loadCvList();
      } catch (err) {
        alert('Error: ' + err.message);
      }
    }

    function renderResults(calls) {
      const raw = Array.isArray(calls) ? calls : [];
      lastResultsRaw = raw;
      const grouped = groupCalls(raw);
      lastResults = grouped;
      const lastSeen = getSeenTimestamp(INTERVIEWS_SEEN_KEY);
      const filtered = grouped.filter((call) => {
        if (resultsFilterMode === 'no_answer') return call.outcome === 'NO_ANSWER';
        if (resultsFilterMode === 'completed') return call.outcome !== 'NO_ANSWER';
        return true;
      }).filter((call) => {
        if (resultsDecisionMode === 'approved') return call.decision === 'approved';
        if (resultsDecisionMode === 'declined') return call.decision === 'declined';
        if (resultsDecisionMode === 'maybe') return call.decision === 'maybe';
        return true;
      });
      lastResultsFiltered = filtered.slice();
      resultsBodyEl.innerHTML = '';
      filtered.forEach((call) => {
        const tr = document.createElement('tr');
        const created = call.created_at ? new Date(call.created_at).getTime() : 0;
        if (created && created > lastSeen && isPortalSource(call.source)) {
          tr.classList.add('is-new');
        }
        tr.classList.add('row-clickable');
        tr.addEventListener('click', (event) => {
          if (event.target.closest('button, a, audio, input, .audio-player')) return;
          toggleInterviewDetailsRow(tr, call);
        });
        const addCell = (value, label, className, title) => {
          const td = document.createElement('td');
          td.textContent = value || '—';
          td.dataset.label = label || '';
          if (className) td.className = className;
          if (title) td.title = title;
          tr.appendChild(td);
        };
        const scoreTd = document.createElement('td');
        scoreTd.dataset.label = 'Score';
        scoreTd.appendChild(scorePill(call.score));
        tr.appendChild(scoreTd);
        const dateTd = buildDateCell(call.created_at);
        dateTd.dataset.label = 'Fecha';
        tr.appendChild(dateTd);
        const brandLabel = call.brandKey ? getBrandDisplayByKey(call.brandKey) : (call.brand || '');
        addCell(brandLabel, 'Local', 'cell-compact', brandLabel);
        const roleLabel = getRoleDisplayForBrand(call.brandKey || call.brand, call.role || call.roleKey || '');
        addCell(roleLabel, 'Posición', 'cell-compact', roleLabel);
        const candidateTd = document.createElement('td');
        candidateTd.className = 'candidate-cell';
        candidateTd.dataset.label = 'Candidato';
        const candidateWrap = document.createElement('div');
        candidateWrap.className = 'candidate-wrap';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'candidate-name';
        nameSpan.textContent = call.applicant || '—';
        if (call.applicant) nameSpan.title = call.applicant;
        candidateWrap.appendChild(nameSpan);
        const scoreMini = scorePill(call.score);
        scoreMini.classList.add('candidate-score-pill');
        candidateWrap.appendChild(scoreMini);
        candidateTd.appendChild(candidateWrap);
        tr.appendChild(candidateTd);
        addCell(call.phone, 'Teléfono');
        const statusText = formatInterviewSummary(call);
        const statusTd = document.createElement('td');
        statusTd.dataset.label = 'Estado';
        const statusDiv = document.createElement('div');
        statusDiv.className = 'summary-cell';
        statusDiv.textContent = statusText;
        if (statusText && statusText !== '—') {
          statusDiv.addEventListener('mouseenter', () => showSummaryTooltip(statusDiv, statusText));
          statusDiv.addEventListener('mouseleave', hideSummaryTooltip);
        }
        statusTd.appendChild(statusDiv);
        tr.appendChild(statusTd);
        const decisionTd = document.createElement('td');
        decisionTd.className = 'decision-cell';
        decisionTd.dataset.label = 'Decisión';
        const decisionWrap = document.createElement('div');
        decisionWrap.className = 'decision-buttons';
        const decisionOptions = [
          { key: 'approved', label: '✓', title: 'Aprobado' },
          { key: 'declined', label: '✕', title: 'Descartado' },
          { key: 'maybe', label: '?', title: 'Indeciso' }
        ];
        const decisionIds = Array.isArray(call.cvIds) && call.cvIds.length
          ? call.cvIds
          : (call.cv_id || call.cvId ? [call.cv_id || call.cvId] : []);
        const canUpdateDecision = authRole !== 'viewer' && decisionIds.length;
        decisionOptions.forEach((opt) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'decision-btn ' + opt.key;
          btn.dataset.decision = opt.key;
          btn.textContent = opt.label;
          btn.title = opt.title;
          btn.setAttribute('aria-label', opt.title);
          btn.disabled = !canUpdateDecision;
          btn.onclick = async (event) => {
            event.stopPropagation();
            if (!canUpdateDecision) return;
            const next = call.decision === opt.key ? '' : opt.key;
            decisionWrap.classList.add('is-loading');
            try {
              const updated = await updateCvDecision(decisionIds, next);
              call.decision = updated || '';
              setDecisionButtonsActive(decisionWrap, call.decision);
              if (resultsDecisionMode !== 'all') loadResults();
            } catch (err) {
              console.error('decision update failed', err);
              setResultsCount('Error: ' + err.message);
            } finally {
              decisionWrap.classList.remove('is-loading');
            }
          };
          decisionWrap.appendChild(btn);
        });
        setDecisionButtonsActive(decisionWrap, call.decision || '');
        decisionTd.appendChild(decisionWrap);
        tr.appendChild(decisionTd);
        const cvTd = document.createElement('td');
        cvTd.dataset.label = 'CV';
        if (call.cv_url) {
          const wrap = document.createElement('div');
          wrap.className = 'action-stack';
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'secondary btn-compact';
          btn.textContent = 'Ver CV';
          btn.onclick = () => {
            window.open(call.cv_url, '_blank', 'noopener');
          };
          wrap.appendChild(btn);
          cvTd.appendChild(wrap);
        } else {
          cvTd.textContent = '—';
        }
        tr.appendChild(cvTd);
        const audioTd = document.createElement('td');
        audioTd.dataset.label = 'Audio';
        if (call.audio_url) {
          const downloadId = call.callId || (Array.isArray(call.callIds) ? call.callIds[0] : '');
          const downloadUrl = downloadId ? '/admin/calls/' + encodeURIComponent(downloadId) + '/audio' : call.audio_url;
          const downloadName = 'interview_' + (downloadId || 'audio') + '.mp3';
          audioTd.appendChild(buildAudioPlayer(call.audio_url, { downloadUrl, downloadName }));
        } else {
          audioTd.textContent = '—';
        }
        tr.appendChild(audioTd);
        const actionTd = document.createElement('td');
        actionTd.dataset.label = 'Acción';
        const actionWrap = document.createElement('div');
        actionWrap.className = 'action-stack';
        if (authRole === 'admin' && call.callId) {
          const waBtn = document.createElement('button');
          waBtn.type = 'button';
          waBtn.className = 'secondary btn-compact';
          waBtn.textContent = 'WhatsApp';
          waBtn.onclick = (event) => {
            event.stopPropagation();
            sendInterviewWhatsapp(call);
          };
          actionWrap.appendChild(waBtn);
        }
        if (authRole === 'admin' && call.callId) {
          const delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.className = 'secondary btn-compact icon-only';
          delBtn.textContent = '🗑';
          delBtn.title = 'Eliminar';
          delBtn.setAttribute('aria-label', 'Eliminar');
          delBtn.onclick = () => deleteInterviewGroup(call);
          actionWrap.appendChild(delBtn);
        }
        if (!actionWrap.children.length) {
          actionTd.textContent = '—';
        } else {
          actionTd.appendChild(actionWrap);
        }
        tr.appendChild(actionTd);
        resultsBodyEl.appendChild(tr);
      });
      const total = lastResults.length;
      const shown = filtered.length;
      if (!total) {
        setResultsCount('Sin llamadas todavía.');
      } else if (shown === total) {
        setResultsCount(shown + ' llamadas');
      } else {
        setResultsCount(shown + ' de ' + total + ' llamadas');
      }
      updateInterviewsBadge(raw);
      if (activeView === 'interviews') {
        markInterviewsSeen(raw);
      }
      if (resultsViewMode === 'swipe') {
        renderResultsSwipe();
      }
    }

    async function loadResults() {
      try {
        const params = new URLSearchParams();
        if (resultsBrandEl.value) params.set('brand', resultsBrandEl.value);
        if (resultsRoleEl.value) params.set('role', resultsRoleEl.value);
        if (resultsRecEl.value) params.set('recommendation', resultsRecEl.value);
        if (resultsScoreMinEl.value) params.set('minScore', resultsScoreMinEl.value);
        if (resultsScoreMaxEl.value) params.set('maxScore', resultsScoreMaxEl.value);
        if (resultsSearchEl.value) params.set('q', resultsSearchEl.value);
        const resp = await fetch('/admin/calls?' + params.toString(), {
          headers: { Authorization: 'Bearer ' + tokenEl.value }
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || 'calls failed');
        renderResults(data.calls || []);
      } catch (err) {
        setResultsCount('Error: ' + err.message);
      }
    }

    function scheduleResultsLoad() {
      if (activeView !== 'interviews') return;
      if (resultsTimer) clearTimeout(resultsTimer);
      resultsTimer = setTimeout(loadResults, 300);
    }

    function scheduleCvLoad() {
      if (activeView !== 'calls') return;
      if (cvTimer) clearTimeout(cvTimer);
      cvTimer = setTimeout(loadCvList, 300);
    }

    function goToInterviewFromCv(item) {
      setActiveView(VIEW_INTERVIEWS);
      if (item.brandKey) {
        const hasBrand = Array.from(resultsBrandEl.options || []).some((opt) => opt.value === item.brandKey);
        if (hasBrand) resultsBrandEl.value = item.brandKey;
      }
      updateResultsRoleOptions();
      if (item.roleKey) {
        const hasRole = Array.from(resultsRoleEl.options || []).some((opt) => opt.value === item.roleKey);
        if (hasRole) resultsRoleEl.value = item.roleKey;
      }
      resultsSearchEl.value = item.phone || item.applicant || '';
      loadResults();
    }

    function setDecisionButtonsActive(container, decision) {
      if (!container) return;
      container.querySelectorAll('.decision-btn').forEach((btn) => {
        const key = btn.dataset.decision || '';
        btn.classList.toggle('active', key === decision);
      });
    }

    async function updateCvDecision(ids, decision) {
      const payload = { ids, decision };
      const resp = await fetch('/admin/cv/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokenEl.value },
        body: JSON.stringify(payload)
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || 'status_update_failed');
      return data.decision || decision || '';
    }

    function renderCvList(list) {
      const raw = Array.isArray(list) ? list : [];
      lastCvRaw = raw;
      const grouped = groupCandidates(raw);
      lastCvList = grouped;
      const lastSeen = getSeenTimestamp(CANDIDATES_SEEN_KEY);
      const filtered = grouped.filter((item) => {
        const info = cvStatusInfo(item);
        if (info.inCall) return true;
        if (cvFilterMode === 'no_calls') return info.category === 'no_calls';
        if (cvFilterMode === 'no_answer') return info.category === 'no_answer';
        if (cvFilterMode === 'interviewed') return info.category === 'interviewed';
        return true;
      });
      lastCvFiltered = filtered.slice();
      cvListBodyEl.innerHTML = '';
      let hasActiveCall = false;
      filtered.forEach((item) => {
        const tr = document.createElement('tr');
        const created = item.created_at ? new Date(item.created_at).getTime() : 0;
        if (created && created > lastSeen && isPortalSource(item.source)) {
          tr.classList.add('is-new');
        }
        const addCell = (value, label, className, title) => {
          const td = document.createElement('td');
          td.textContent = value || '—';
          td.dataset.label = label || '';
          if (className) td.className = className;
          if (title) td.title = title;
          tr.appendChild(td);
        };
        const dateTd = buildDateCell(item.created_at);
        dateTd.classList.add('cell-compact');
        dateTd.title = formatDate(item.created_at);
        dateTd.dataset.label = 'Fecha';
        tr.appendChild(dateTd);
        const brandLabel = item.brandKey ? getBrandDisplayByKey(item.brandKey) : (item.brand || '');
        const roleLabel = getRoleDisplayForBrand(item.brandKey || item.brand, item.role || item.roleKey || '');
        addCell(brandLabel, 'Local', 'cell-compact', brandLabel);
        addCell(roleLabel, 'Posición', 'cell-compact', roleLabel);
        const candidateTd = document.createElement('td');
        candidateTd.className = 'candidate-cell';
        candidateTd.dataset.label = 'Candidato';
        const candidateWrap = document.createElement('div');
        candidateWrap.className = 'candidate-wrap';
        if (item.cv_photo_url) {
          const avatar = document.createElement('img');
          avatar.alt = '';
          avatar.loading = 'lazy';
          avatar.className = 'candidate-avatar';
          avatar.style.visibility = 'hidden';
          avatar.onerror = () => avatar.remove();
          const photoUrl = item.cv_photo_url;
          avatar.src = photoUrl;
          avatar.style.objectPosition = '50% 30%';
          avatar.style.visibility = 'visible';
          attachAvatarHandlers(avatar, photoUrl);
          candidateWrap.appendChild(avatar);
        }
        const nameSpan = document.createElement('span');
        nameSpan.className = 'candidate-name';
        nameSpan.textContent = item.applicant || '—';
        if (item.applicant) nameSpan.title = item.applicant;
        candidateWrap.appendChild(nameSpan);
        candidateTd.appendChild(candidateWrap);
        tr.appendChild(candidateTd);
        addCell(item.phone || '', 'Teléfono');
        const info = cvStatusInfo(item);
        if (info.inCall) {
          tr.classList.add('call-active');
          hasActiveCall = true;
        }
        const statusText = info.statusText || '';
        const statusTd = document.createElement('td');
        statusTd.className = 'cv-status ' + (info.statusClass || '');
        statusTd.textContent = statusText || '—';
        if (statusText) statusTd.title = statusText;
        statusTd.dataset.label = 'Estado';
        tr.appendChild(statusTd);
        const decisionTd = document.createElement('td');
        decisionTd.className = 'decision-cell';
        decisionTd.dataset.label = 'Decisión';
        const decisionWrap = document.createElement('div');
        decisionWrap.className = 'decision-buttons';
        const decisionOptions = [
          { key: 'approved', label: '✓', title: 'Aprobado' },
          { key: 'declined', label: '✕', title: 'Declinado' },
          { key: 'maybe', label: '?', title: 'Indeciso' }
        ];
        decisionOptions.forEach((opt) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'decision-btn ' + opt.key;
          btn.dataset.decision = opt.key;
          btn.textContent = opt.label;
          btn.title = opt.title;
          btn.setAttribute('aria-label', opt.title);
          btn.disabled = authRole === 'viewer';
          btn.onclick = async (event) => {
            event.stopPropagation();
            if (authRole === 'viewer') return;
            const ids = Array.isArray(item.cvIds) && item.cvIds.length
              ? item.cvIds
              : (item.id ? [item.id] : []);
            if (!ids.length) return;
            const next = item.decision === opt.key ? '' : opt.key;
            decisionWrap.classList.add('is-loading');
            try {
              const updated = await updateCvDecision(ids, next);
              item.decision = updated || '';
              setDecisionButtonsActive(decisionWrap, item.decision);
            } catch (err) {
              console.error('decision update failed', err);
              setCvListCount('Error: ' + err.message);
            } finally {
              decisionWrap.classList.remove('is-loading');
            }
          };
          decisionWrap.appendChild(btn);
        });
        setDecisionButtonsActive(decisionWrap, item.decision || '');
        decisionTd.appendChild(decisionWrap);
        tr.appendChild(decisionTd);
        const cvTd = document.createElement('td');
        cvTd.dataset.label = 'CV';
        if (item.cv_url) {
          const wrap = document.createElement('div');
          wrap.className = 'inline';
          const link = document.createElement('a');
          link.href = item.cv_url;
          link.target = '_blank';
          link.rel = 'noopener';
          link.textContent = 'Ver CV';
          link.className = 'secondary';
          link.style.textDecoration = 'none';
          link.style.padding = '8px 12px';
          link.style.borderRadius = '10px';
          link.style.border = '1px solid var(--border)';
          wrap.appendChild(link);
          cvTd.appendChild(wrap);
        } else if (item.cv_text) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'secondary btn-compact';
          btn.textContent = 'Ver CV';
          btn.onclick = () => openCvModal(item.cv_text || '');
          cvTd.appendChild(btn);
        } else {
          cvTd.textContent = '—';
        }
        tr.appendChild(cvTd);
        const actionTd = document.createElement('td');
        actionTd.className = 'action-cell';
        actionTd.dataset.label = 'Acción';
        const actionWrap = document.createElement('div');
        actionWrap.className = 'action-stack';
        const canWrite = authRole !== 'viewer';
        if (canWrite) {
          const callBtn = document.createElement('button');
          callBtn.type = 'button';
          callBtn.className = 'btn-compact';
          callBtn.textContent = info.hasCalls ? 'Volver a llamar' : 'Llamar';
          callBtn.onclick = () => {
            if (info.hasCalls) {
              const name = item.applicant ? item.applicant.trim() : '';
              const label = name || 'este candidato';
              if (!confirm('¿Seguro que querés volver a llamar a ' + label + '?')) return;
            }
            currentCvId = item.id || '';
            callBrandEl.value = item.brandKey || item.brand || '';
            updateCallRoleOptions(callBrandEl.value);
            const roleOptions = Array.from(callRoleEl.options || []).map((opt) => opt.value);
            if (item.role && roleOptions.includes(item.role)) {
              callRoleEl.value = item.role;
            } else if (item.roleKey && roleOptions.includes(item.roleKey)) {
              callRoleEl.value = item.roleKey;
            } else {
              callRoleEl.value = item.role || item.roleKey || '';
            }
            callNameEl.value = item.applicant || '';
            callPhoneEl.value = item.phone || '';
            callCvTextEl.value = item.cv_text || '';
            currentCvSource = item.source || '';
            placeCall({
              to: item.phone || '',
              brand: item.brandKey || item.brand || '',
              role: callRoleEl.value || item.role || item.roleKey || '',
              applicant: item.applicant || '',
              cv_summary: truncateText(item.cv_text || '', CV_CHAR_LIMIT),
              cv_text: item.cv_text || '',
              cv_id: item.id || (Array.isArray(item.cvIds) ? item.cvIds[0] : '') || '',
              custom_question: item.custom_question || ''
            });
          };
          actionWrap.appendChild(callBtn);
          const qBtn = document.createElement('button');
          qBtn.type = 'button';
          qBtn.className = 'secondary btn-compact';
          qBtn.textContent = item.custom_question ? 'Pregunta ✓' : 'Pregunta';
          qBtn.onclick = () => openCvQuestionModal(item);
          actionWrap.appendChild(qBtn);
        }
        if (info.hasCalls) {
          const viewBtn = document.createElement('button');
          viewBtn.type = 'button';
          viewBtn.className = 'secondary btn-compact';
          viewBtn.textContent = 'Ver entrevista';
          viewBtn.onclick = () => goToInterviewFromCv(item);
          actionWrap.appendChild(viewBtn);
        }
        if (authRole === 'admin') {
          const delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.className = 'secondary btn-compact icon-only';
          delBtn.textContent = '🗑';
          delBtn.title = 'Eliminar';
          delBtn.setAttribute('aria-label', 'Eliminar');
          delBtn.onclick = () => deleteCandidateGroup(item);
          actionWrap.appendChild(delBtn);
        }
        if (actionWrap.children.length) {
          actionTd.appendChild(actionWrap);
        } else {
          actionTd.textContent = '—';
        }
        tr.appendChild(actionTd);
        cvListBodyEl.appendChild(tr);
      });
      if (cvActiveTimer) {
        clearTimeout(cvActiveTimer);
        cvActiveTimer = null;
      }
      if (hasActiveCall) {
        cvPollUntil = Date.now() + 120000;
      }
      if (activeView === 'calls' && (hasActiveCall || Date.now() < cvPollUntil)) {
        cvActiveTimer = setTimeout(() => {
          cvActiveTimer = null;
          loadCvList();
        }, 5000);
      }
      const total = lastCvList.length;
      const shown = filtered.length;
      if (!total) {
        setCvListCount('Sin candidates guardados.');
      } else if (shown === total) {
        setCvListCount(shown + ' Candidates');
      } else {
        setCvListCount(shown + ' de ' + total + ' Candidates');
      }
      updateCandidatesBadge(raw);
      if (activeView === 'calls') {
        markCandidatesSeen(raw);
      }
      if (cvViewMode === 'swipe') {
        renderCvSwipe();
      }
    }

    async function loadCvList() {
      try {
        const params = new URLSearchParams();
        if (cvFilterBrandEl.value) params.set('brand', cvFilterBrandEl.value);
        if (cvFilterSearchEl.value) params.set('q', cvFilterSearchEl.value);
        const resp = await fetch('/admin/cv?' + params.toString(), {
          headers: { Authorization: 'Bearer ' + tokenEl.value }
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || 'cv failed');
        renderCvList(data.cvs || []);
      } catch (err) {
        setCvListCount('Error: ' + err.message);
      }
    }

    async function saveCvEntry({ silent } = {}) {
      if (authRole === 'viewer') {
        if (!silent) setCallStatus('Solo lectura.');
        return null;
      }
      if (!silent) setCallStatus('Guardando CV...');
      const payload = {
        brand: callBrandEl.value || '',
        role: callRoleEl.value || '',
        applicant: callNameEl.value || '',
        phone: callPhoneEl.value || '',
        cv_text: callCvTextEl.value || '',
        source: currentCvSource || '',
        cv_file_data_url: currentCvFileDataUrl || '',
        cv_file_name: currentCvFileName || '',
        cv_photo_data_url: currentCvPhotoDataUrl || ''
      };
      if (!payload.applicant.trim() || !payload.phone.trim()) {
        maybeFillContactFromCv(payload.cv_text || '');
        payload.applicant = callNameEl.value || payload.applicant;
        payload.phone = callPhoneEl.value || payload.phone;
      }
      if (!payload.applicant.trim()) {
        if (!silent) setCallStatus('Error: falta nombre y apellido.');
        return null;
      }
      if (!payload.cv_text.trim()) {
        if (!silent) setCallStatus('Error: falta CV.');
        return null;
      }
      const resp = await fetch('/admin/cv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokenEl.value },
        body: JSON.stringify(payload)
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || 'cv save failed');
      return data.cv || null;
    }

    async function saveCv() {
      try {
        const entry = await saveCvEntry({ silent: false });
        if (!entry) return;
        currentCvId = entry.id || '';
        setCallStatus('CV guardado.');
        loadCvList();
      } catch (err) {
        setCallStatus('Error: ' + err.message);
      }
    }

    async function restoreSession() {
      let storedToken = '';
      let storedRole = '';
      let storedBrands = [];
      let storedEmail = '';
      try {
        storedToken = localStorage.getItem(AUTH_TOKEN_KEY) || localStorage.getItem('portalToken') || '';
        storedRole = localStorage.getItem(AUTH_ROLE_KEY) || '';
        const rawBrands = localStorage.getItem(AUTH_BRANDS_KEY) || '[]';
        storedBrands = JSON.parse(rawBrands);
        storedEmail = localStorage.getItem(AUTH_EMAIL_KEY) || '';
      } catch (err) {
        storedToken = '';
        storedRole = '';
        storedBrands = [];
        storedEmail = '';
      }
      if (!storedToken) return false;
      tokenEl.value = storedToken;
      authRole = storedRole || 'viewer';
      authBrands = Array.isArray(storedBrands) ? storedBrands : [];
      authEmail = storedEmail || '';
      const ok = await loadConfig();
      if (!ok) {
        clearAuthState();
        clearStoredAuth();
        setLoggedInUI(false);
        return false;
      }
      setLoggedInUI(true);
      applyRoleAccess();
      if (authRole === 'admin') loadUsers();
      setActiveView(VIEW_CALLS);
      refreshPushStatus();
      loadMe();
      startBadgePolling();
      return true;
    }

    async function login() {
      if (loginMode === 'viewer') {
        const email = (loginEmailEl.value || '').trim();
        const password = loginPasswordEl.value || '';
        if (!email || !password) {
          setLoginStatus('Ingresá email y password');
          return;
        }
        setLoginStatus('Verificando...');
        try {
          const resp = await fetch('/admin/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
          });
          const data = await resp.json().catch(() => ({}));
          if (!resp.ok) throw new Error(data.error || 'login failed');
          tokenEl.value = data.token || '';
          authRole = data.role || 'viewer';
          authBrands = data.allowed_brands || data.allowedBrands || [];
          authEmail = email;
          const ok = await loadConfig();
          if (!ok) throw new Error(lastLoadError || 'load failed');
          setLoginStatus('');
          setLoggedInUI(true);
          syncPortalToken();
          applyRoleAccess();
          if (authRole === 'admin') loadUsers();
          setActiveView(VIEW_CALLS);
          refreshPushStatus();
          loadMe();
          startBadgePolling();
        } catch (err) {
          setLoginStatus('Error: ' + err.message);
        }
        return;
      }

      const key = (loginTokenEl.value || '').trim();
      if (!key) {
        setLoginStatus('Ingresá la clave');
        return;
      }
      setLoginStatus('Verificando...');
      tokenEl.value = key;
      authRole = 'admin';
      authBrands = [];
      authEmail = '';
      const ok = await loadConfig();
      if (ok) {
        setLoginStatus('');
        setLoggedInUI(true);
        syncPortalToken();
        applyRoleAccess();
        loadUsers();
        refreshPushStatus();
        loadMe();
        startBadgePolling();
        if (pendingPortalView === VIEW_PORTAL) {
          pendingPortalView = '';
          setActiveView(VIEW_PORTAL);
          ensurePortalLoaded(true);
        }
      } else {
        setLoginStatus(lastLoadError ? 'Error: ' + lastLoadError : 'Clave inválida');
      }
    }

    loadBtnEl.onclick = loadConfig;
    saveBtnEl.onclick = saveConfig;
    addBrandEl.onclick = () => {
      brandsEl.appendChild(brandTemplate(''));
      syncSidebar();
    };
    document.getElementById('preview-generate').onclick = generatePreview;
    adminUnlockEl.onclick = unlockAdmin;
    if (systemPromptEl) {
      systemPromptEl.addEventListener('input', () => {
        systemPromptDirty = systemPromptEl.value !== systemPromptOriginal;
      });
    }
    if (promptTemplateSaveEl) promptTemplateSaveEl.onclick = savePromptTemplate;
    if (promptTemplateRestoreEl) {
      promptTemplateRestoreEl.onclick = () => restorePromptFromStore(promptTemplateSelectEl?.value || '', 'template');
    }
    if (promptTemplateDeleteEl) {
      promptTemplateDeleteEl.onclick = () => deletePromptTemplate(promptTemplateSelectEl?.value || '');
    }
    if (promptHistoryRestoreEl) {
      promptHistoryRestoreEl.onclick = () => restorePromptFromStore(promptHistorySelectEl?.value || '', 'history');
    }
    if (promptAssistRunEl) promptAssistRunEl.onclick = runPromptAssistant;
    loginModeAdminEl.onclick = () => setLoginMode('admin');
    loginModeViewerEl.onclick = () => setLoginMode('viewer');
    loginBtnEl.onclick = login;
    if (userPanelToggleEl) userPanelToggleEl.onclick = openUserModal;
    if (userModalCloseEl) userModalCloseEl.onclick = closeUserModal;
    if (userModalEl) {
      userModalEl.addEventListener('click', (event) => {
        if (event.target === userModalEl) closeUserModal();
      });
    }
    if (userSaveProfileEl) userSaveProfileEl.onclick = saveUserProfile;
    if (userLogoutEl) userLogoutEl.onclick = logout;
    if (userPhotoInputEl) {
      userPhotoInputEl.addEventListener('change', async () => {
        const file = userPhotoInputEl.files && userPhotoInputEl.files[0];
        if (!file) return;
        try {
          const dataUrl = await portalFileToDataUrl(file);
          pendingUserPhotoDataUrl = dataUrl;
          pendingUserPhotoName = file.name || 'avatar';
          pendingUserPhotoClear = false;
          applyUserAvatar(dataUrl, currentUserProfile?.email || '');
        } catch (err) {
          setUserProfileStatus('No se pudo leer la foto.', true);
        }
      });
    }
    if (userPhotoClearEl) {
      userPhotoClearEl.onclick = () => {
        pendingUserPhotoDataUrl = '';
        pendingUserPhotoName = '';
        pendingUserPhotoClear = true;
        applyUserAvatar('', currentUserProfile?.email || '');
      };
    }
    if (pushEnableEl) {
      pushEnableEl.onclick = () => {
        enablePush().catch((err) => setPushStatus('Error', err.message));
      };
    }
    if (pushDisableEl) {
      pushDisableEl.onclick = () => {
        disablePush().catch((err) => setPushStatus('Error', err.message));
      };
    }
    if (userSaveEl) userSaveEl.onclick = saveUser;
    if (userClearEl) userClearEl.onclick = resetUserForm;
    if (logoutBtnEl) logoutBtnEl.onclick = logout;
    loginTokenEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') login();
    });
    loginEmailEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') login();
    });
    loginPasswordEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') login();
    });
    if (sidebarToggleEl && sidebarEl) {
      sidebarToggleEl.onclick = () => {
        setSidebarCollapsed(!sidebarEl.classList.contains('collapsed'));
      };
    }
    if (mobileMenuEl && sidebarEl) {
      mobileMenuEl.onclick = () => {
        setSidebarCollapsed(!sidebarEl.classList.contains('collapsed'));
      };
    }
    if (sidebarOverlayEl) {
      sidebarOverlayEl.addEventListener('click', () => {
        setSidebarCollapsed(true);
      });
    }
    navGeneralEl.onclick = () => setActiveView('');
    navCallsEl.onclick = () => setActiveView(VIEW_CALLS);
    navInterviewsEl.onclick = () => setActiveView(VIEW_INTERVIEWS);
    if (navPortalEl) navPortalEl.onclick = () => setActiveView(VIEW_PORTAL);
    if (portalNewEl) {
      portalNewEl.onclick = () => {
        portalCurrent = portalDefaultPage();
        portalPendingUploads = { logo: null, hero: null, favicon: null, gallery: [] };
        portalFillForm();
        portalRenderList();
        portalSetStatus('');
      };
    }
    if (portalSaveEl) portalSaveEl.onclick = portalSavePage;
    if (portalDeleteEl) portalDeleteEl.onclick = portalDeletePage;
    if (portalAddQuestionEl) {
      portalAddQuestionEl.onclick = () => {
        if (!portalCurrent) portalCurrent = portalDefaultPage();
        portalCurrent.questions = portalReadQuestions();
        portalCurrent.questions.push({
          id: 'q_' + Date.now(),
          label: { es: '', en: '' },
          type: 'short',
          required: false,
          options: []
        });
        portalRenderQuestions();
      };
    }
    if (portalSlugEl) {
      portalSlugEl.addEventListener('input', portalUpdateUrl);
      portalSlugEl.addEventListener('blur', () => {
        portalSlugEl.value = toSlug(portalSlugEl.value || '');
        portalUpdateUrl();
      });
    }
    if (portalCopyUrlEl) {
      portalCopyUrlEl.onclick = async () => {
        const url = portalUrlEl ? portalUrlEl.value : '';
        if (!url) return;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(url);
          } else {
            portalUrlEl.select();
            document.execCommand('copy');
            portalUrlEl.setSelectionRange(0, 0);
          }
          portalSetStatus('URL copiada');
        } catch (err) {
          portalSetStatus('No se pudo copiar', true);
        }
      };
    }
    if (portalOpenUrlEl) {
      portalOpenUrlEl.onclick = () => {
        const url = (portalUrlEl && portalUrlEl.value || '').trim();
        if (!url) return;
        window.open(url, '_blank', 'noopener');
      };
    }
    if (portalUrlEl) {
      portalUrlEl.addEventListener('click', () => {
        const url = (portalUrlEl.value || '').trim();
        if (!url) return;
        window.open(url, '_blank', 'noopener');
      });
    }
    if (portalFontPresetEl) {
      portalFontPresetEl.addEventListener('change', () => {
        const presetId = portalFontPresetEl.value || '';
        if (presetId) {
          portalApplyFontPreset(presetId);
        } else {
          portalSyncPreview();
        }
      });
    }
    portalBindColorPicker(portalColorPrimaryEl, portalColorPrimaryPickerEl);
    portalBindColorPicker(portalColorAccentEl, portalColorAccentPickerEl);
    portalBindColorPicker(portalColorBgEl, portalColorBgPickerEl);
    portalBindColorPicker(portalColorCardEl, portalColorCardPickerEl);
    portalBindColorPicker(portalColorTextEl, portalColorTextPickerEl);
    portalBindColorPicker(portalColorMutedEl, portalColorMutedPickerEl);
    if (portalFormEl) {
      portalFormEl.addEventListener('input', portalHandlePreviewSync);
      portalFormEl.addEventListener('change', portalHandlePreviewSync);
    }
    if (portalLogoFileEl) {
      portalLogoFileEl.addEventListener('change', async (event) => {
        const file = event.target.files && event.target.files[0];
        if (!file) return;
        try {
          const dataUrl = await portalFileToDataUrl(file);
          portalPendingUploads.logo = { dataUrl, fileName: file.name };
          portalSetStatus('Logo listo');
          portalSyncPreview();
        } catch (err) {
          portalSetStatus('Error cargando logo', true);
        }
      });
    }
    if (portalHeroFileEl) {
      portalHeroFileEl.addEventListener('change', async (event) => {
        const file = event.target.files && event.target.files[0];
        if (!file) return;
        try {
          const dataUrl = await portalFileToDataUrl(file);
          portalPendingUploads.hero = { dataUrl, fileName: file.name };
          portalSetStatus('Hero listo');
          portalSyncPreview();
        } catch (err) {
          portalSetStatus('Error cargando hero', true);
        }
      });
    }
    if (portalFaviconFileEl) {
      portalFaviconFileEl.addEventListener('change', async (event) => {
        const file = event.target.files && event.target.files[0];
        if (!file) return;
        try {
          const dataUrl = await portalFileToDataUrl(file);
          portalPendingUploads.favicon = { dataUrl, fileName: file.name };
          portalSetStatus('Favicon listo');
        } catch (err) {
          portalSetStatus('Error cargando favicon', true);
        }
      });
    }
    if (portalGalleryFilesEl) {
      portalGalleryFilesEl.addEventListener('change', async (event) => {
        const files = Array.from(event.target.files || []);
        if (!files.length) return;
        try {
          const out = [];
          for (const file of files) {
            const dataUrl = await portalFileToDataUrl(file);
            out.push({ dataUrl, fileName: file.name });
          }
          portalPendingUploads.gallery = out;
          portalSetStatus('Galeria lista');
          portalSyncPreview();
        } catch (err) {
          portalSetStatus('Error cargando galeria', true);
        }
      });
    }
    if (portalAppFilterEl) {
      portalAppFilterEl.addEventListener('change', () => {
        portalLoadApplications().catch(() => {});
      });
    }
    if (portalAppLocationFilterEl) {
      portalAppLocationFilterEl.addEventListener('change', () => {
        portalLoadApplications().catch(() => {});
      });
    }
    if (portalAppRefreshEl) {
      portalAppRefreshEl.onclick = () => {
        portalLoadApplications().catch(() => {});
      };
    }
    if (portalAppExportEl) {
      portalAppExportEl.onclick = () => {
        try {
          portalExportCsv();
        } catch (err) {
          portalSetStatus('Error: ' + err.message, true);
        }
      };
    }
    callBrandEl.addEventListener('change', () => updateCallRoleOptions(callBrandEl.value));
    callBrandEl.addEventListener('change', () => { currentCvId = ''; });
    callRoleEl.addEventListener('change', () => { currentCvId = ''; });
    callNameEl.addEventListener('input', () => { currentCvId = ''; });
    if (usersPanelEl) resetUserForm();
    callPhoneEl.addEventListener('input', () => { currentCvId = ''; });
    callBtnEl.onclick = placeCall;
    callClearEl.onclick = clearCallForm;
    cvSaveBtnEl.onclick = saveCv;
    resultsRefreshEl.onclick = loadResults;
    resultsBrandEl.addEventListener('change', () => {
      updateResultsRoleOptions();
      scheduleResultsLoad();
    });
    [resultsRoleEl, resultsRecEl, resultsScoreMinEl, resultsScoreMaxEl].forEach((el) => {
      el.addEventListener('change', scheduleResultsLoad);
    });
    resultsSearchEl.addEventListener('input', scheduleResultsLoad);
    cvRefreshEl.onclick = loadCvList;
    cvFilterBrandEl.addEventListener('change', scheduleCvLoad);
    cvFilterSearchEl.addEventListener('input', scheduleCvLoad);
    if (cvTabsEl) {
      cvTabsEl.querySelectorAll('button').forEach((btn) => {
        btn.onclick = () => {
          cvFilterMode = btn.dataset.filter || 'all';
          cvTabsEl.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
          renderCvList(lastCvRaw);
        };
      });
    }
    if (resultsTabsEl) {
      resultsTabsEl.querySelectorAll('button').forEach((btn) => {
        btn.onclick = () => {
          resultsFilterMode = btn.dataset.filter || 'all';
          resultsTabsEl.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
          renderResults(lastResultsRaw);
        };
      });
    }
    if (resultsDecisionTabsEl) {
      resultsDecisionTabsEl.querySelectorAll('button').forEach((btn) => {
        btn.onclick = () => {
          resultsDecisionMode = btn.dataset.decision || 'all';
          resultsDecisionTabsEl.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
          renderResults(lastResultsRaw);
        };
      });
    }
    if (cvViewSwitchEl) {
      cvViewSwitchEl.querySelectorAll('button[data-mode]').forEach((btn) => {
        btn.onclick = () => applyCvViewMode(btn.dataset.mode || 'table');
      });
    }
    if (resultsViewSwitchEl) {
      resultsViewSwitchEl.querySelectorAll('button[data-mode]').forEach((btn) => {
        btn.onclick = () => applyResultsViewMode(btn.dataset.mode || 'table');
      });
    }
    if (cvSwipePrevEl) {
      cvSwipePrevEl.onclick = () => {
        const total = lastCvFiltered.length;
        if (!total) return;
        cvSwipeIndex = (cvSwipeIndex - 1 + total) % total;
        renderCvSwipe();
      };
    }
    if (cvSwipeNextEl) {
      cvSwipeNextEl.onclick = () => {
        const total = lastCvFiltered.length;
        if (!total) return;
        cvSwipeIndex = (cvSwipeIndex + 1) % total;
        renderCvSwipe();
      };
    }
    if (resultsSwipePrevEl) {
      resultsSwipePrevEl.onclick = () => {
        const total = lastResultsFiltered.length;
        if (!total) return;
        resultsSwipeIndex = (resultsSwipeIndex - 1 + total) % total;
        renderResultsSwipe();
      };
    }
    if (resultsSwipeNextEl) {
      resultsSwipeNextEl.onclick = () => {
        const total = lastResultsFiltered.length;
        if (!total) return;
        resultsSwipeIndex = (resultsSwipeIndex + 1) % total;
        renderResultsSwipe();
      };
    }
    cvDropEl.addEventListener('click', () => cvFileEl.click());
    cvFileEl.addEventListener('change', (event) => handleCvFile(event.target.files[0]));
    cvDropEl.addEventListener('dragover', (event) => {
      event.preventDefault();
      cvDropEl.classList.add('drag');
    });
    cvDropEl.addEventListener('dragleave', () => cvDropEl.classList.remove('drag'));
    cvDropEl.addEventListener('drop', (event) => {
      event.preventDefault();
      cvDropEl.classList.remove('drag');
      handleCvFile(event.dataTransfer.files[0]);
    });
    callCvTextEl.addEventListener('input', () => {
      currentCvId = '';
    });
    callCvTextEl.addEventListener('blur', () => {
      if (!callNameEl.value || !callNameEl.value.trim()) {
        maybeFillContactFromCv(callCvTextEl.value || '');
      }
    });
    cvModalCloseEl.addEventListener('click', closeCvModal);
    cvModalEl.addEventListener('click', (event) => {
      if (event.target === cvModalEl) closeCvModal();
    });
    if (cvQuestionCloseEl) cvQuestionCloseEl.addEventListener('click', closeCvQuestionModal);
    if (cvQuestionClearEl) cvQuestionClearEl.addEventListener('click', () => {
      if (cvQuestionTextEl) cvQuestionTextEl.value = '';
    });
    if (cvQuestionSaveEl) cvQuestionSaveEl.addEventListener('click', saveCvQuestion);
    if (cvQuestionModalEl) {
      cvQuestionModalEl.addEventListener('click', (event) => {
        if (event.target === cvQuestionModalEl) closeCvQuestionModal();
      });
    }
    if (interviewModalCloseEl) {
      interviewModalCloseEl.addEventListener('click', closeInterviewModal);
    }
    if (interviewModalEl) {
      interviewModalEl.addEventListener('click', (event) => {
        if (event.target === interviewModalEl) closeInterviewModal();
      });
    }
    if (photoModalCloseEl) {
      photoModalCloseEl.addEventListener('click', closePhotoModal);
    }
    if (photoModalEl) {
      photoModalEl.addEventListener('click', (event) => {
        if (event.target === photoModalEl) closePhotoModal();
      });
    }
    let urlParams = null;
    try {
      urlParams = new URLSearchParams(window.location.search);
    } catch (err) {}
    if (urlParams) {
      const viewParam = urlParams.get('view');
      if (viewParam === 'portal') pendingPortalView = VIEW_PORTAL;
      const slugParam = urlParams.get('slug');
      if (slugParam) portalPendingSlug = toSlug(slugParam);
    }
    const urlToken = urlParams ? urlParams.get('token') : '';
    let autoLoginUsed = false;
    if (urlToken) {
      setLoginMode('admin');
      loginTokenEl.value = urlToken;
      login();
      autoLoginUsed = true;
    }
    setLoginMode('admin');
    lockSystemPrompt();
    setAdminStatus('Bloqueado');
    enableMobilePanelToggle('call-panel', {
      defaultCollapsed: true,
      collapsedLabel: 'Mostrar carga CV',
      expandedLabel: 'Ocultar carga CV'
    });
    enableMobilePanelToggle('cv-list-panel', {
      defaultCollapsed: false,
      contentSelector: '#cv-filters',
      collapsedLabel: 'Mostrar filtros',
      expandedLabel: 'Ocultar filtros'
    });
    enableMobilePanelToggle('results-panel', {
      defaultCollapsed: true,
      contentSelector: '#results-filters',
      collapsedLabel: 'Mostrar filtros',
      expandedLabel: 'Ocultar filtros'
    });
    refreshViewModesFromStorage();
    initSidebarState();
    refreshPushStatus();
    if (!autoLoginUsed) {
      restoreSession();
    }
    if (window.matchMedia) {
      const mq = window.matchMedia('(max-width: 980px)');
      if (mq.addEventListener) {
        mq.addEventListener('change', initSidebarState);
      }
    }
  </script>
</body>
</html>
  `);
});

app.get("/health", (req, res) => res.status(200).send("ok"));

app.get("/r/:token", (req, res) => {
  const entry = tokens.get(req.params.token);
  if (!entry || entry.expiresAt < Date.now()) {
    return res.status(404).send("not found");
  }
  if (entry.path) {
    return fs.createReadStream(entry.path)
      .on("error", () => res.status(404).send("not found"))
      .pipe(res.type("audio/mpeg"));
  }
  if (entry.callSid) {
    fetchCallRecording(entry.callSid)
      .then((recording) => {
        if (!recording || !recording.audio_data) {
          res.status(404).send("not found");
          return;
        }
        res.type(recording.content_type || "audio/mpeg");
        res.send(recording.audio_data);
      })
      .catch(() => res.status(404).send("not found"));
    return;
  }
  return res.status(404).send("not found");
});

// Hard-stop path for no-answer/voicemail before opening streams
async function hardStopNoAnswer({ callSid, to, brand, role, applicant, reason }) {
  const toNorm = normalizePhone(to);
  if (!toNorm) return;
  const tracked = callSid ? callsByCallSid.get(callSid) : null;
  if (callSid && noAnswerSentBySid.has(callSid)) {
    if (tracked) deactivateActiveCall(tracked);
    return;
  }
  const call = tracked || {
    callSid: callSid || null,
    to: toNorm,
    from: null,
    brand: brand || DEFAULT_BRAND,
    role: role || DEFAULT_ROLE,
    spokenRole: displayRole(role || DEFAULT_ROLE, brand),
    applicant: applicant || "",
    englishRequired: roleNeedsEnglish(roleKey(role || DEFAULT_ROLE), brand),
    address: resolveAddress(brand || DEFAULT_BRAND, null),
    userSpoke: false,
    hangupTimer: null
  };
  if (callSid) call.callSid = callSid;
  if (toNorm) call.to = toNorm;
  if (brand) call.brand = brand;
  if (role) call.role = role;
  if (applicant) call.applicant = applicant;
  call.spokenRole = displayRole(call.role || DEFAULT_ROLE, call.brand || DEFAULT_BRAND);
  call.englishRequired = roleNeedsEnglish(roleKey(call.role || DEFAULT_ROLE), call.brand || DEFAULT_BRAND);
  if (!call.address) call.address = resolveAddress(call.brand || DEFAULT_BRAND, null);
  await markNoAnswer(call, reason || "no_answer");
}

app.post("/voice", (req, res) => {
  const token = String(req.query?.token || "").trim();
  const entry = token ? voiceCtxByToken.get(token) : null;
  const payload = entry?.payload || {};
  if (!entry) {
    return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
  }

  const answeredBy = String(req.body?.AnsweredBy || "").toLowerCase();
  const callSid = req.body?.CallSid || "";
  const to = normalizePhone(req.body?.To || payload.to || "");
  const brand = payload.brand || DEFAULT_BRAND;
  const brandDisplay = resolveBrandDisplay(brand);
  const role = payload.role || DEFAULT_ROLE;
  const englishRequired = resolveEnglishRequired(brand, role, payload || {});
  const address = resolveAddress(brand, payload.address || null);
  const applicant = payload.applicant || "";
  const cv_summary = payload.cv_summary || "";
  const resume_url = payload.resume_url || "";
  const lang = (req.query?.lang || "es").toString();

  console.log("[voice] request", { callSid, to, answeredBy, brand, role });

  // AMD: if not human, hang up and send SMS
  if (answeredBy && answeredBy !== "human") {
    setImmediate(() => {
      hardStopNoAnswer({
        callSid,
        to,
        brand,
        role,
        applicant,
        reason: `amd:${answeredBy}`
      }).catch((e) => console.error("[voice] hardStopNoAnswer failed", e));
    });

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup/>
</Response>`;
    return res.type("text/xml").send(twiml);
  }

  // Human: pedir consentimiento antes de abrir el stream
  const consentParams = new URLSearchParams({
    token,
    attempt: "1",
    lang: "es"
  }).toString();
  const recVarsEs = buildRecordingVars({ brand, role, applicant, lang: "es" });
  const introLine = getRecordingCopy("es", "recording_intro", DEFAULT_RECORDING_INTRO_ES, recVarsEs);
  const consentLine = getRecordingCopy("es", "recording_consent", DEFAULT_RECORDING_CONSENT_ES, recVarsEs);
  const noResponseLine = getRecordingCopy("es", "recording_no_response", DEFAULT_RECORDING_NO_RESPONSE_ES, recVarsEs);
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="es-US" voice="Polly.Lupe-Neural">${xmlEscapeAttr(introLine)}</Say>
  <Gather input="speech dtmf" action="${xmlEscapeAttr(`${PUBLIC_BASE_URL}/consent?${consentParams}`)}" method="POST" timeout="6" speechTimeout="auto" language="es-US" hints="si, sí, no, yes, sure, ok, de acuerdo, 1, 2, english">
    <Say language="es-US" voice="Polly.Lupe-Neural">${xmlEscapeAttr(consentLine)}</Say>
  </Gather>
  <Say language="es-US" voice="Polly.Lupe-Neural">${xmlEscapeAttr(noResponseLine)}</Say>
  <Hangup/>
</Response>`;

  return res.type("text/xml").send(twiml);
});

function normalizeConsentSpeech(s) {
  if (!s) return "";
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function isConsentYes({ speech, digits }) {
  const d = (digits || "").trim();
  if (d === "1") return true;
  const norm = normalizeConsentSpeech(speech);
  return /\b(si|sí|ok|dale|de acuerdo|yes|sure)\b/.test(norm);
}

function isConsentNo({ speech, digits }) {
  const d = (digits || "").trim();
  if (d === "2") return true;
  const norm = normalizeConsentSpeech(speech);
  return /\b(no|prefiero no|no gracias|don'?t|do not)\b/.test(norm);
}

app.post("/consent", express.urlencoded({ extended: false }), async (req, res) => {
  const token = String(req.query?.token || "").trim();
  const attempt = Number(req.query?.attempt || "1");
  const lang = (req.query?.lang || "es").toString();
  const speech = req.body?.SpeechResult || "";
  const digits = req.body?.Digits || "";
  const entry = token ? voiceCtxByToken.get(token) : null;
  if (!entry) {
    return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
  }
  const payload = entry.payload || {};
  const callSid = req.body?.CallSid || "";
  const to = normalizePhone(req.body?.To || payload.to || "");

  const yes = isConsentYes({ speech, digits });
  const no = isConsentNo({ speech, digits });
  const wantsEnglish = /\benglish\b/.test(normalizeConsentSpeech(speech)) || /\bingles\b/.test(normalizeConsentSpeech(speech));

  if (wantsEnglish && !yes && !no) {
    const consentParams = new URLSearchParams({ token, attempt: String(attempt + 1), lang: "en" }).toString();
    const recVarsEn = buildRecordingVars({ brand: payload.brand || DEFAULT_BRAND, role: payload.role || DEFAULT_ROLE, applicant: payload.applicant || "", lang: "en" });
    const introLine = getRecordingCopy("en", "recording_intro", DEFAULT_RECORDING_INTRO_EN, recVarsEn);
    const consentLine = getRecordingCopy("en", "recording_consent", DEFAULT_RECORDING_CONSENT_EN, recVarsEn);
    const noResponseLine = getRecordingCopy("en", "recording_no_response", DEFAULT_RECORDING_NO_RESPONSE_EN, recVarsEn);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="en-US" voice="Polly.Joanna-Neural">${xmlEscapeAttr(introLine)}</Say>
  <Gather input="speech dtmf" action="${xmlEscapeAttr(`${PUBLIC_BASE_URL}/consent?${consentParams}`)}" method="POST" timeout="6" speechTimeout="auto" language="en-US" hints="yes, no, 1, 2, sure, ok">
    <Say language="en-US" voice="Polly.Joanna-Neural">${xmlEscapeAttr(consentLine)}</Say>
  </Gather>
  <Say language="en-US" voice="Polly.Joanna-Neural">${xmlEscapeAttr(noResponseLine)}</Say>
  <Hangup/>
</Response>`;
    return res.type("text/xml").send(twiml);
  }

  if (yes) {
    voiceCtxByToken.delete(token);
    const wsUrl = xmlEscapeAttr(`${toWss(PUBLIC_BASE_URL)}/media-stream`);
    const paramTags = [
      { name: "to", value: payload.to },
      { name: "brand", value: payload.brand },
      { name: "role", value: payload.role },
      { name: "english", value: payload.englishRequired },
      { name: "address", value: payload.address },
      { name: "applicant", value: payload.applicant },
      { name: "cv_summary", value: payload.cv_summary },
      { name: "cv_id", value: payload.cv_id },
      { name: "resume_url", value: payload.resume_url },
      { name: "custom_question", value: payload.custom_question || payload.customQuestion },
      { name: "lang", value: lang }
    ]
      .filter(p => p.value !== undefined && p.value !== null && `${p.value}` !== "")
      .map(p => `      <Parameter name="${xmlEscapeAttr(p.name)}" value="${xmlEscapeAttr(p.value)}" />`)
      .join("\n");

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="${lang === "en" ? "en-US" : "es-US"}" voice="${lang === "en" ? "Polly.Joanna-Neural" : "Polly.Lupe-Neural"}">Perfecto, arrancamos.</Say>
  <Connect>
    <Stream url="${wsUrl}">
${paramTags}
    </Stream>
  </Connect>
</Response>`;
    return res.type("text/xml").send(twiml);
  }

  if (no || attempt >= 2) {
    voiceCtxByToken.delete(token);
    const alreadySent = callSid && noAnswerSentBySid.has(callSid);
    if (!alreadySent) {
      const call = buildCallFromPayload(payload, { callSid, to });
      setOutcome(call, no ? "DECLINED_RECORDING" : "CONSENT_TIMEOUT");
      call.incomplete = true;
      call.scoring = null;
      try {
        await sendWhatsappReport(call);
        call.whatsappSent = true;
      } catch (err) {
        console.error("[consent] whatsapp failed", err);
      }
      recordCallHistory(call);
      if (callSid) noAnswerSentBySid.set(callSid, Date.now() + CALL_TTL_MS);
    }
    const es = lang !== "en";
    const recVars = buildRecordingVars({ brand: payload.brand || DEFAULT_BRAND, role: payload.role || DEFAULT_ROLE, applicant: payload.applicant || "", lang: es ? "es" : "en" });
    const declineLine = getRecordingCopy(es ? "es" : "en", "recording_decline", es ? DEFAULT_RECORDING_DECLINE_ES : DEFAULT_RECORDING_DECLINE_EN, recVars);
    const twiml = es
      ? `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="es-US" voice="Polly.Lupe-Neural">${xmlEscapeAttr(declineLine)}</Say>
  <Hangup/>
</Response>`
      : `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="en-US" voice="Polly.Joanna-Neural">${xmlEscapeAttr(declineLine)}</Say>
  <Hangup/>
</Response>`;
    return res.type("text/xml").send(twiml);
  }

  const consentParams = new URLSearchParams({ token, attempt: String(attempt + 1), lang }).toString();
  const es = lang !== "en";
  const recVars = buildRecordingVars({ brand: payload.brand || DEFAULT_BRAND, role: payload.role || DEFAULT_ROLE, applicant: payload.applicant || "", lang: es ? "es" : "en" });
  const confirmLine = getRecordingCopy(es ? "es" : "en", "recording_confirm", es ? DEFAULT_RECORDING_CONFIRM_ES : DEFAULT_RECORDING_CONFIRM_EN, recVars);
  const noResponseLine = getRecordingCopy(es ? "es" : "en", "recording_no_response", es ? DEFAULT_RECORDING_NO_RESPONSE_ES : DEFAULT_RECORDING_NO_RESPONSE_EN, recVars);
  const twiml = es
    ? `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech dtmf" action="${xmlEscapeAttr(`${PUBLIC_BASE_URL}/consent?${consentParams}`)}" method="POST" timeout="5">
    <Say language="es-US" voice="Polly.Lupe-Neural">${xmlEscapeAttr(confirmLine)}</Say>
  </Gather>
  <Say language="es-US" voice="Polly.Lupe-Neural">${xmlEscapeAttr(noResponseLine)}</Say>
  <Hangup/>
</Response>`
    : `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech dtmf" action="${xmlEscapeAttr(`${PUBLIC_BASE_URL}/consent?${consentParams}`)}" method="POST" timeout="5">
    <Say language="en-US" voice="Polly.Joanna-Neural">${xmlEscapeAttr(confirmLine)}</Say>
  </Gather>
  <Say language="en-US" voice="Polly.Joanna-Neural">${xmlEscapeAttr(noResponseLine)}</Say>
  <Hangup/>
</Response>`;
  return res.type("text/xml").send(twiml);
});

app.post("/sms-inbound", express.urlencoded({ extended: false }), async (req, res) => {
  const from = (req.body?.From || "").trim();
  const body = (req.body?.Body || "").trim().toLowerCase();
  const last = lastCallByNumber.get(from);

  function twiml(msg) {
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${xmlEscapeAttr(msg)}</Message></Response>`;
  }

  if (!from) {
    return res.type("text/xml").send(twiml("No tengo tu número."));
  }
  if (!last) {
    return res.type("text/xml").send(twiml("No encuentro tu última solicitud. Decime el puesto y te llamamos."));
  }

  if (/^(si|sí|yes|call|llama|llamar)/i.test(body)) {
    try {
      await placeOutboundCall(last.payload);
      return res.type("text/xml").send(twiml("Te llamamos ahora."));
    } catch (err) {
      console.error("[sms-inbound] recall failed", err);
      return res.type("text/xml").send(twiml("No pude llamar ahora. Lo intentamos de nuevo."));
    }
  }

  return res.type("text/xml").send(twiml("Recibido. Si querés que te llamemos, responde SI."));
});

app.post("/call-status", express.urlencoded({ extended: false }), async (req, res) => {
  res.status(200).end();
  try {
    const status = (req.body?.CallStatus || "").toLowerCase();
    const to = normalizePhone((req.body?.To || "").trim());
    const callSid = req.body?.CallSid;
    const answeredBy = (req.body?.AnsweredBy || "").toLowerCase();
    if (!status || !to) return;
    const call = callsByCallSid.get(callSid) || {
      callSid,
      brand: DEFAULT_BRAND,
      role: DEFAULT_ROLE,
      spokenRole: displayRole(DEFAULT_ROLE, DEFAULT_BRAND),
      to,
      applicant: "",
      englishRequired: DEFAULT_ENGLISH_REQUIRED,
      address: resolveAddress(DEFAULT_BRAND, null),
      userSpoke: false,
      outcome: null,
      noAnswerReason: null
    };

    if (answeredBy) call.answeredBy = answeredBy;
    call.callStatus = status || call.callStatus || "";
    const statusNoAnswer = ["busy", "no-answer", "failed", "canceled"].includes(status);
    const amdMachine = answeredBy && answeredBy.includes("machine");
    const amdHuman = answeredBy && answeredBy.includes("human");

    // If AMD says human, do nothing special
    if (amdHuman) return;

    if (statusNoAnswer || amdMachine) {
      await markNoAnswer(call, amdMachine ? "voicemail" : `status_${status}`);
      return;
    }

    if (status === "completed") {
      const durationSec = Number(req.body?.CallDuration);
      if (Number.isFinite(durationSec) && durationSec > 0) {
        call.durationSec = durationSec;
      }
      call.expiresAt = Date.now() + CALL_TTL_MS;
      if (call.finalizeTimer) clearTimeout(call.finalizeTimer);
      call.finalizeTimer = setTimeout(async () => {
        if (call.recordingPath || call.recordingToken || call.audioUrl) return;
        call.incomplete = true;
        if (!call.noTranscriptReason) {
          call.noTranscriptReason = "No se recibió grabación de la llamada.";
        }
        inferIncompleteOutcome(call);
        try {
          await sendWhatsappReport(call);
          call.whatsappSent = true;
        } catch (err) {
          console.error("[call-status] whatsapp failed", err);
        }
        recordCallHistory(call);
      }, 120000);
    }
  } catch (err) {
    console.error("[call-status] error", err);
  }
});

app.post("/call", requireWrite, async (req, res) => {
  try {
    const body = req.body || {};
    const {
      to,
      brand = DEFAULT_BRAND,
      role = DEFAULT_ROLE,
      address,
      applicant = "",
      cv_summary = "",
      cv_text = "",
      cv_id: cvIdRaw = "",
      resume_url = "",
      from = TWILIO_VOICE_FROM
    } = body;
    let customQuestion = (body.custom_question || body.customQuestion || "").toString().trim();

    const cvSummary = (cv_summary || cv_text || "").trim();
    let cvId = cvIdRaw || "";

    const roleClean = sanitizeRole(role);
    const toNorm = normalizePhone(to);
    const fromNorm = normalizePhone(from);

    const englishReqBool = resolveEnglishRequired(brand, roleClean, body);
    const allowedBrands = Array.isArray(req.allowedBrands) ? req.allowedBrands : [];
    if (allowedBrands.length && !isBrandAllowed(allowedBrands, brand)) {
      return res.status(403).json({ error: "brand_not_allowed" });
    }

    console.log("[/call] inbound", {
      to: toNorm,
      from: fromNorm,
      brand,
      role: roleClean,
      englishRequired: englishReqBool,
      address: address || resolveAddress(brand, null),
      applicant,
      cvId,
      cvLen: cvSummary.length
    });

    if (!toNorm || !fromNorm) {
      return res.status(400).json({ error: "missing to/from" });
    }
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !PUBLIC_BASE_URL) {
      return res.status(500).json({ error: "twilio or base url not configured" });
    }

    const resolvedAddress = address || resolveAddress(brand, null);

    if (!customQuestion && cvId) {
      const fromMem = cvStoreById.get(cvId);
      if (fromMem?.custom_question) {
        customQuestion = fromMem.custom_question;
      } else if (dbPool) {
        try {
          const resp = await dbQuery("SELECT custom_question FROM cvs WHERE id = $1 LIMIT 1", [cvId]);
          const row = resp?.rows?.[0];
          if (row?.custom_question) customQuestion = row.custom_question;
        } catch {}
      }
    }

    if (cvId && resume_url) {
      const cvEntry = buildCvEntry({
        id: cvId,
        brand,
        role: roleClean,
        applicant,
        phone: toNorm,
        cv_text: cv_text || cvSummary,
        resume_url,
        custom_question: customQuestion
      });
      recordCvEntry(cvEntry);
    }
    if (!cvId && cvSummary && dbPool) {
      const cvEntry = buildCvEntry({
        brand,
        role: roleClean,
        applicant,
        phone: toNorm,
        cv_text: cv_text || cvSummary,
        resume_url,
        custom_question: customQuestion
      });
      recordCvEntry(cvEntry);
      cvId = cvEntry.id;
    }

    // Guarda payload para posible recall
    lastCallByNumber.set(toNorm, {
      payload: {
        to: toNorm,
        from: fromNorm,
        brand,
        role: roleClean,
        englishRequired: englishReqBool ? "1" : "0",
        address: resolvedAddress,
        applicant,
        cv_summary: cvSummary,
        cv_id: cvId,
        resume_url,
        custom_question: customQuestion
      },
      expiresAt: Date.now() + CALL_TTL_MS
    });

    const voiceToken = randomToken();
    voiceCtxByToken.set(voiceToken, {
      payload: {
        to: toNorm,
        from: fromNorm,
        brand,
        role: roleClean,
        englishRequired: englishReqBool ? "1" : "0",
        address: resolvedAddress,
        applicant,
        cv_summary: cvSummary,
        cv_id: cvId,
        resume_url,
        custom_question: customQuestion
      },
      expiresAt: Date.now() + CALL_TTL_MS
    });

    const params = new URLSearchParams();
    params.append("To", toNorm);
    params.append("From", fromNorm);
    params.append("Url", `${PUBLIC_BASE_URL}/voice?token=${voiceToken}`);
    params.append("Method", "POST");
    params.append("StatusCallback", `${PUBLIC_BASE_URL}/call-status`);
    params.append("StatusCallbackEvent", "initiated ringing answered completed");
    params.append("StatusCallbackMethod", "POST");
    params.append("MachineDetection", "Enable");
    params.append("MachineDetectionTimeout", "10");

    const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${base64Auth(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)}`
      },
      body: params
    });
    const data = await resp.json();
    if (!resp.ok) {
      console.error("[/call] twilio_call_failed", resp.status, data);
      return res.status(500).json({ error: "twilio_call_failed", detail: data });
    }
    console.log("[/call] queued", { sid: data.sid, status: data.status });
    if (data.sid) {
      const call = buildCallFromPayload(
        {
          to: toNorm,
          brand,
          role: roleClean,
          englishRequired: englishReqBool ? "1" : "0",
          address: resolvedAddress,
          applicant,
          cv_summary: cvSummary,
          cv_id: cvId,
          resume_url,
          custom_question: customQuestion
        },
        { callSid: data.sid, to: toNorm }
      );
      call.from = fromNorm;
      call.expiresAt = Date.now() + CALL_TTL_MS;
      call.callStatus = data.status || "queued";
      callsByCallSid.set(data.sid, call);
    }
    return res.json({ callId: data.sid, status: data.status });
  } catch (err) {
    console.error("[/call] error", err);
    return res.status(500).json({ error: "internal_error" });
  }
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/media-stream" });

wss.on("connection", (twilioWs, req) => {
  console.log("[media-stream] raw url", req.url);
  const url = new URL(req.url, "http://localhost");

  // Defaults from query params (for legacy) — will be overridden by streamParams if present
  let to = url.searchParams.get("to") || "";
  let brand = url.searchParams.get("brand") || DEFAULT_BRAND;
  let role = url.searchParams.get("role") || DEFAULT_ROLE;
  let englishRequired = parseEnglishRequired(url.searchParams.get("english"));
  let address = resolveAddress(brand, url.searchParams.get("address"));
  let applicant = url.searchParams.get("applicant") || "";
  let cvSummary = url.searchParams.get("cv_summary") || "";
  let cvId = url.searchParams.get("cv_id") || "";
  let resumeUrl = url.searchParams.get("resume_url") || "";
  let spokenRole = displayRole(role, brand);

  console.log("[media-stream] connect", {
    brand,
    role,
    applicant: applicant || "(none)",
    cvLen: cvSummary.length,
    englishRequired,
    address
  });

  const call = {
    streamSid: null,
    callSid: null,
    brand,
    to,
    role,
    spokenRole,
    englishRequired,
    address,
    applicant,
    cvSummary,
    cvText: cvSummary,
    cvId,
    customQuestion: "",
    resumeUrl,
    from: null,
    recordingStarted: false,
    transcriptText: "",
    scoring: null,
    recordingPath: null,
    recordingToken: null,
    whatsappSent: false,
    audioUrl: "",
    cvUrl: "",
    outcome: null,
    noAnswerReason: null,
    outcome: null,
    startedAt: Date.now(),
    durationSec: null,
    twilioReady: false,
    openaiReady: false,
    started: false,
    pendingAudio: [],
    responseInFlight: false,
    heardSpeech: false,
    userSpoke: false,
    lastCommitId: null,
    transcript: [],
    incomplete: false,
    lang: "es"
  };
  call.hangupTimer = null;
  call.answeredBy = null;
  call.speechByteCount = 0;
  call.speechStartedAt = null;

  call.expiresAt = Date.now() + CALL_TTL_MS;
  // Hold by temporary stream key until Twilio sends real streamSid
  const tempKey = `temp-${crypto.randomUUID()}`;
  callsByStream.set(tempKey, call);

function record(kind, payload) {
  call.transcript.push({ at: Date.now(), kind, ...payload });
}

record("context", { brand, role, spokenRole, englishRequired, address, applicant, cvSummary, resumeUrl });

const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL_REALTIME)}`,
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
  );

  function sendAudioToTwilio(deltaB64) {
    if (!call.streamSid) {
      if (call.pendingAudio.length < 600) call.pendingAudio.push(deltaB64);
      return;
    }
    const buf = Buffer.from(deltaB64, "base64");
    const frame = 160;
    for (let i = 0; i < buf.length; i += frame) {
      const chunk = buf.subarray(i, i + frame);
      twilioWs.send(JSON.stringify({
        event: "media",
        streamSid: call.streamSid,
        media: { payload: chunk.toString("base64") }
      }));
    }
  }

  function flushAudio() {
    if (!call.streamSid) return;
    for (const d of call.pendingAudio) sendAudioToTwilio(d);
    call.pendingAudio = [];
  }

  function sendSessionUpdate() {
    openaiWs.send(JSON.stringify({
      type: "session.update",
      session: {
        type: "realtime",
        model: OPENAI_MODEL_REALTIME,
        output_modalities: ["audio"],
        instructions: buildInstructions(call),
        audio: {
          input: {
            format: { type: "audio/pcmu" },
            turn_detection: {
              type: "server_vad",
              create_response: false,
              interrupt_response: true,
              // Hacerlo menos sensible a ruido ambiente
              threshold: 0.95,
              prefix_padding_ms: 500,
              silence_duration_ms: 1700
            }
          },
          output: {
            format: { type: "audio/pcmu" },
            voice: VOICE
          }
        }
      }
    }));
  }

  function sendSessionUpdateSafe() {
    if (openaiWs.readyState === WebSocket.OPEN) {
      sendSessionUpdate();
    } else {
      setTimeout(sendSessionUpdateSafe, 50);
    }
  }

  function kickoff() {
    if (call.started) return;
    if (!call.twilioReady || !call.openaiReady) return;
    call.started = true;
    flushAudio();
    const firstName = (call.applicant || "").split(/\s+/)[0] || "";
    const spokenRole = call.spokenRole || displayRole(call.role || "", call.brand);
    const openerLine = buildMetaOpener({
      brand: call.brand || DEFAULT_BRAND,
      role: call.role || DEFAULT_ROLE,
      applicant: call.applicant || "",
      lang: call.lang === "en" ? "en" : "es"
    });
    const introAfterYes =
      call.lang === "en"
        ? `Great. You applied for ${spokenRole}. Can you tell me about your experience in this position?`
        : `Perfecto, aplicaste para ${spokenRole}. ¿Podés contarme un poco tu experiencia en esta posición?`;
    setTimeout(() => {
      if (call.heardSpeech || call.responseInFlight) return;
      openaiWs.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: `
INSTRUCCIONES PARA VOS (no las digas):
- Primer turno: decí solo el opener, sin agregar "claro", "sí", "tengo tiempo" ni responder tu propia pregunta.
- Cuando el candidato confirme que puede hablar, tu siguiente turno debe ser: "${introAfterYes}"
- No actúes como candidato. Vos preguntás y esperás.
- Si hay silencio/ruido, esperá la respuesta; no rellenes.

DECÍ ESTO Y CALLATE:
"${openerLine}"
`.trim()
          }]
        }
      }));
      if (!call.responseInFlight) {
        openaiWs.send(JSON.stringify({ type: "response.create" }));
        call.responseInFlight = true;
      }
    }, 80);
  }

  openaiWs.on("open", () => sendSessionUpdateSafe());

  openaiWs.on("message", (raw) => {
    let evt;
    try { evt = JSON.parse(raw.toString()); } catch { return; }

    if (evt.type === "session.updated") {
      call.openaiReady = true;
      kickoff();
      return;
    }

    if (evt.type === "input_audio_buffer.speech_started") {
      call.heardSpeech = true;
      call.userSpoke = true;
      call.speechByteCount = 0;
      call.speechStartedAt = Date.now();
      if (call.hangupTimer) {
        clearTimeout(call.hangupTimer);
        call.hangupTimer = null;
      }
      record("speech_started", {});
      if (call.responseInFlight) {
        try { openaiWs.send(JSON.stringify({ type: "response.cancel" })); } catch {}
      }
      if (call.streamSid) {
        try { twilioWs.send(JSON.stringify({ event: "clear", streamSid: call.streamSid })); } catch {}
      }
      call.responseInFlight = false;
      return;
    }

    if ((evt.type === "response.output_audio.delta" || evt.type === "response.audio.delta") && evt.delta) {
      sendAudioToTwilio(evt.delta);
      return;
    }

    if (evt.type === "input_audio_buffer.committed") {
      const hadSpeechFlag = call.heardSpeech;
      call.heardSpeech = false;

      const minBytes = 800; // ~0.1s de audio (160-byte frames)
      const minDurationMs = 120;
      const speechDurationMs = call.speechStartedAt ? Date.now() - call.speechStartedAt : 0;
      if (hadSpeechFlag && call.speechByteCount < minBytes && speechDurationMs < minDurationMs) {
        // Ignore tiny bursts/noise only when VAD actually flagged speech
        call.userSpoke = false;
        call.speechByteCount = 0;
        call.speechStartedAt = null;
        return;
      }

      call.userSpoke = true;
      call.speechByteCount = 0;
      call.speechStartedAt = null;

      const commitId = evt.item_id || null;
      if (commitId && commitId === call.lastCommitId) return;
      call.lastCommitId = commitId;
      record("turn_committed", { commitId });

      if (!call.responseInFlight) {
        openaiWs.send(JSON.stringify({ type: "response.create" }));
        call.responseInFlight = true;
      }
      return;
    }

    if (evt.type === "response.done") {
      call.responseInFlight = false;
      return;
    }

    if (evt.type === "error") {
      if (evt.error?.code === "response_cancel_not_active") return;
      console.error("[OpenAI] error", evt);
    }
  });

  twilioWs.on("message", (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }

    if (data.event === "start") {
      call.streamSid = data.start?.streamSid || null;
      call.callSid = data.start?.callSid || null;
      call.from = data.start?.from || data.start?.callFrom || data.start?.caller || null;

      // Prefer Stream Parameter payloads (Twilio may pass them as streamParams, stream_params, parameters, or customParameters)
      const sp = data.start?.streamParams
        || data.start?.stream_params
        || data.start?.parameters
        || data.start?.customParameters
        || {};
      if (Object.keys(sp).length) {
        console.log("[media-stream] start params", sp);
      } else {
        console.warn("[media-stream] no params on start; using defaults");
      }
      if (Object.keys(sp).length) {
        to = sp.to || to;
        brand = sp.brand || brand;
        role = sanitizeRole(sp.role || role);
        if (sp.english !== undefined) englishRequired = parseEnglishRequired(sp.english);
        address = resolveAddress(brand, sp.address || address);
        applicant = sp.applicant || applicant;
        cvSummary = sp.cv_summary || cvSummary;
        cvId = sp.cv_id || cvId;
        resumeUrl = sp.resume_url || resumeUrl;
        call.customQuestion = sp.custom_question || sp.customQuestion || call.customQuestion || "";
        spokenRole = displayRole(role, brand);
        call.lang = sp.lang || call.lang || "es";
      }

      call.twilioReady = true;
      call.brand = brand;
      call.to = to;
      call.role = role;
      call.spokenRole = spokenRole;
      call.englishRequired = parseEnglishRequired(englishRequired);
      call.address = address;
      call.applicant = applicant;
      call.cvSummary = cvSummary;
      call.cvText = call.cvText || cvSummary;
      call.cvId = cvId;
      call.resumeUrl = resumeUrl;
      sendSessionUpdateSafe();

      console.log("[media-stream] connect", {
        brand: call.brand,
        role: call.role,
        applicant: call.applicant || "(none)",
        cvLen: (call.cvSummary || "").length,
        englishRequired: call.englishRequired,
        address: call.address
      });

      // Hang up if no user speech within 15s (voicemail/ghost)
      if (!call.hangupTimer) {
        call.hangupTimer = setTimeout(() => {
          if (!call.userSpoke) {
            console.log("[hangup] no user speech detected; hanging up");
            markNoSpeech(call, "timeout_no_speech").catch(err => console.error("[no-speech] failed", err));
          }
        }, 15000);
      }

      record("twilio_start", { streamSid: call.streamSid, callSid: call.callSid });
      // re-key maps now that streamSid/callSid are known
      callsByStream.delete(tempKey);
      if (call.streamSid) callsByStream.set(call.streamSid, call);
      if (call.callSid) {
        const tracked = callsByCallSid.get(call.callSid);
        if (tracked && tracked !== call) {
          if (!call.callStatus) call.callStatus = tracked.callStatus || tracked.status || "";
          if (!call.status) call.status = tracked.status || tracked.callStatus || "";
          if (!call.outcome) call.outcome = tracked.outcome || null;
          if (!call.outcome_detail) call.outcome_detail = tracked.outcome_detail || "";
          if (!call.startedAt && tracked.startedAt) call.startedAt = tracked.startedAt;
          if (!call.customQuestion && tracked.customQuestion) call.customQuestion = tracked.customQuestion;
          if (tracked.expiresAt) call.expiresAt = Math.max(call.expiresAt || 0, tracked.expiresAt);
        }
        if (!call.callStatus) call.callStatus = "in-progress";
        callsByCallSid.set(call.callSid, call);
        call.expiresAt = Date.now() + CALL_TTL_MS;
        if (AUTO_RECORD) {
          startRecording(call).catch((err) => console.error("[recording start] failed", err));
        }
      }
      kickoff();
      flushAudio();
      return;
    }

    if (data.event === "media") {
      const payload = data.media?.payload;
      if (payload && openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: payload }));
      }
      if (payload && call.heardSpeech) {
        try {
          const rawLen = Buffer.from(payload, "base64").length;
          call.speechByteCount += rawLen;
        } catch {}
      }
      return;
    }

    if (data.event === "stop") {
      record("twilio_stop", {});
      try { openaiWs.close(); } catch {}
      try { twilioWs.close(); } catch {}
    }
  });

  twilioWs.on("close", () => {
    call.durationSec = Math.round((Date.now() - call.startedAt) / 1000);
    if (!call.userSpoke) {
      markNoSpeech(call, "closed_no_speech").catch(err => console.error("[no-speech] failed", err));
    }
    // maybeSendNoAnswerSms is now handled via markNoAnswer / call-status
    try { if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close(); } catch {}
    call.expiresAt = Date.now() + CALL_TTL_MS;
  });
});

// --- Recording status webhook ---
app.post("/recording-status", async (req, res) => {
  res.status(204).end(); // Twilio expects quick ack
  const recordingUrl = req.body?.RecordingUrl;
  const recordingSid = req.body?.RecordingSid;
  const callSid = req.body?.CallSid;
  if (!recordingUrl || !recordingSid || !callSid) {
    console.error("[recording-status] missing fields", req.body);
    return;
  }
  const call = callsByCallSid.get(callSid) || { brand: DEFAULT_BRAND, role: DEFAULT_ROLE, englishRequired: DEFAULT_ENGLISH_REQUIRED, address: resolveAddress(DEFAULT_BRAND, null), callSid };
  call.expiresAt = Date.now() + CALL_TTL_MS;
  try {
    await handleRecordingStatus(call, { recordingUrl, recordingSid });
  } catch (err) {
    console.error("[recording-status] failed", err);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on ${PORT}`);
});

// --- helpers for recording/scoring/whatsapp ---
async function handleRecordingStatus(call, { recordingUrl, recordingSid }) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    console.error("[recording] missing Twilio credentials, skipping download");
    return;
  }
  if (call.finalizeTimer) {
    clearTimeout(call.finalizeTimer);
    call.finalizeTimer = null;
  }
  const dest = path.join(recordingsDir, `${recordingSid}.mp3`);
  await downloadRecordingWithRetry(`${recordingUrl}.mp3`, dest);
  let storedInDb = false;
  try {
    const stats = await fs.promises.stat(dest);
    const sid = call.callSid || recordingSid;
    let body = null;
    const loadBody = async () => {
      if (!body) body = await fs.promises.readFile(dest);
      return body;
    };
    if (spacesEnabled && stats.size <= AUDIO_UPLOAD_MAX_BYTES) {
      try {
        const key = `audio/${sid || recordingSid}.mp3`;
        const buf = await loadBody();
        await uploadToSpaces({ key, body: buf, contentType: "audio/mpeg" });
        call.audioUrl = key;
      } catch (err) {
        console.error("[recording] spaces upload failed", err);
      }
    }
    if (dbPool && stats.size <= DB_AUDIO_MAX_BYTES && sid) {
      try {
        const buf = await loadBody();
        await upsertCallRecording(sid, buf, "audio/mpeg");
        storedInDb = true;
      } catch (err) {
        console.error("[recording] db save failed", err);
      }
    }
  } catch (err) {
    console.error("[recording] post-download handling failed", err);
  }
  if (!call.audioUrl && storedInDb) {
    const sid = call.callSid || recordingSid;
    if (sid) call.audioUrl = `db:${sid}`;
  }
  const token = randomToken();
  tokens.set(token, { path: dest, callSid: call.callSid || recordingSid, expiresAt: Date.now() + TOKEN_TTL_MS });
  call.recordingPath = dest;
  call.recordingToken = token;
  call.expiresAt = Date.now() + CALL_TTL_MS;
  await maybeScoreAndSend(call);
}

async function downloadRecordingWithRetry(url, dest, attempts = 5) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const size = await downloadRecording(url, dest);
      if (size < 1024) throw new Error(`downloaded recording too small (${size} bytes)`);
      return;
    } catch (err) {
      lastErr = err;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

async function downloadRecording(url, dest) {
  const resp = await fetch(url, {
    headers: {
      Authorization: `Basic ${base64Auth(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)}`
    }
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`download failed ${resp.status} ${text}`);
  }
  const arrayBuf = await resp.arrayBuffer();
  await fs.promises.writeFile(dest, Buffer.from(arrayBuf));
  const stats = await fs.promises.stat(dest);
  console.log(`[recording] downloaded ${dest} size=${stats.size} bytes`);
  return stats.size;
}

async function startRecording(call) {
  if (!call.callSid || call.recordingStarted) return;
  call.recordingStarted = true;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    console.error("[recording start] missing Twilio credentials");
    return;
  }
  const params = new URLSearchParams();
  params.append("RecordingStatusCallback", `${PUBLIC_BASE_URL}/recording-status`);
  params.append("RecordingStatusCallbackMethod", "POST");
  params.append("RecordingChannels", "mono");
  params.append("RecordingTrack", "both");
  params.append("Trim", "trim-silence");

  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${call.callSid}/Recordings.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${base64Auth(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)}`
    },
    body: params
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`recording start failed ${resp.status} ${text}`);
  }
}

async function transcribeAudio(filePath) {
  try {
    const stats = await fs.promises.stat(filePath);
    console.log(`[transcription] file size=${stats.size} path=${filePath}`);
  } catch (err) {
    console.error("[transcription] cannot stat file", err);
  }
  const audioBuf = await fs.promises.readFile(filePath);
  const form = new FormData();
  form.append("file", new Blob([audioBuf]), path.basename(filePath));
  form.append("model", "whisper-1");
  const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`transcription failed ${resp.status} ${text}`);
  }
  const dataJson = await resp.json();
  return dataJson.text || "";
}

function buildScoringPrompt(call, transcriptText) {
  return `
Sos un asistente que evalúa entrevistas para restaurantes. Devolvé JSON estricto con este shape:
{
  "score_0_100": 0-100,
  "recommendation": "advance" | "review" | "reject",
  "summary": "1-2 líneas",
  "key_points": ["..."],
  "red_flags": ["..."],
  "extracted": {
    "area": "texto",
    "availability": "texto",
    "salary_expectation": "texto",
    "english_level": "none|basic|conversational|fluent|unknown",
    "english_detail": "texto breve sobre si se pudo comunicar y cómo sonó",
    "experience": "texto breve",
    "mobility": "yes|no|unknown",
    "stay_plan": "permanent|temporary|unknown",
    "stay_detail": "texto breve (ej: 'temporal 3 meses' o 'vive en Miami')",
    "warmth_score": 0-10,
    "fluency_score": 0-10,
    "warmth_note": "texto breve",
    "fluency_note": "texto breve"
  }
}
Contexto fijo:
- Restaurante: ${call.brand}
- Puesto: ${call.role}
- Dirección: ${call.address}
- Inglés requerido: ${call.englishRequired ? "sí" : "no"}

Transcript completo (usa esto para extraer datos):
${transcriptText || "(vacío)"}

Reglas para el análisis:
 - NO inventes datos. Si algo no está claro en el transcript, marcá "unknown" o "no informado". No asumas zona, salario, experiencia, permanencia en Miami/EE.UU. ni inglés si no se dijo. Si un dato no se mencionó, dejalo vacío/unknown y baja el score.
 - Permanencia: si dice que está temporal, intenta capturar cuánto tiempo (ej. “3 meses”). Si no dice nada, stay_plan=unknown.
- Calidez = amabilidad/cercanía en el trato; bajá el score si el candidato suena seco o cortante.
- Fluidez = claridad y continuidad al expresarse (no es inglés); bajá si se traba, responde en monosílabos o cuesta entender su disponibilidad/experiencia.
- Inglés: detalla si pudo o no comunicarse en inglés y cómo sonó (acento/claridad). Si la entrevista fue mayormente en inglés y se comunicó bien, marcá english_level al menos "conversational" o "fluent". Si dijo "no hablo español" pero habló en inglés, NO pongas basic.
Si la entrevista no aporta datos claros, devolvé recommendation="review", score <= 30, y marcá todos los campos dudosos como "unknown". Red_flags puede ser vacío. Usa español neutro en summary y key_points.`;
}

async function scoreTranscript(call, transcriptText) {
  const prompt = buildScoringPrompt(call, transcriptText);
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL_SCORING,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Devolvé solo JSON válido. Nada de texto fuera del JSON." },
        { role: "user", content: prompt }
      ]
    })
  });
  if (!resp.ok) throw new Error(`scoring failed ${resp.status}`);
  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content || "{}";
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function formatDuration(sec) {
  if (!sec || Number.isNaN(sec)) return "n/d";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")} min`;
}

function scoreValue(scoring) {
  if (!scoring) return null;
  const raw = scoring.score_0_100;
  if (typeof raw === "number") return raw;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

function buildCallHistoryEntry(call) {
  if (!call) return null;
  const scoring = call.scoring;
  const ex = scoring?.extracted || {};
  const createdAt = call.startedAt ? new Date(call.startedAt).toISOString() : new Date().toISOString();
  const brandDisplay = resolveBrandDisplay(call.brand || DEFAULT_BRAND);
  const roleDisplay = call.spokenRole || displayRole(call.role || DEFAULT_ROLE, call.brand || DEFAULT_BRAND);
  return {
    callId: call.callSid || null,
    brand: brandDisplay,
    brandKey: brandKey(call.brand || brandDisplay),
    role: roleDisplay,
    roleKey: roleKey(call.role || roleDisplay),
    applicant: call.applicant || "",
    phone: call.to || call.from || "",
    score: scoreValue(scoring),
    recommendation: scoring?.recommendation || null,
    summary: scoring?.summary || "",
    warmth: typeof ex.warmth_score === "number" ? ex.warmth_score : null,
    fluency: typeof ex.fluency_score === "number" ? ex.fluency_score : null,
    english: ex.english_level || "",
    english_detail: ex.english_detail || "",
    experience: ex.experience || "",
    area: ex.area || "",
    availability: ex.availability || "",
    salary: ex.salary_expectation || "",
    trial: ex.trial_date || ex.trial_availability || "",
    stay_plan: ex.stay_plan || "",
    stay_detail: ex.stay_detail || "",
    mobility: ex.mobility || "",
    outcome: call.outcome || null,
    outcome_detail: call.noTranscriptReason || call.noAnswerReason || "",
    duration_sec: typeof call.durationSec === "number" ? call.durationSec : null,
    created_at: createdAt,
    audio_url: call.audioUrl || (call.recordingToken ? `${PUBLIC_BASE_URL}/r/${call.recordingToken}` : ""),
    english_required: !!call.englishRequired,
    cv_id: call.cvId || "",
    cv_text: call.cvText || call.cvSummary || "",
    cv_url: call.cvUrl || ""
  };
}

function recordCallHistory(call) {
  const entry = buildCallHistoryEntry(call);
  if (!entry) return;
  call.callStatus = "completed";
  const key = entry.callId || `${entry.phone || "na"}:${entry.created_at}`;
  const existing = callHistoryByKey.get(key);
  if (existing) {
    Object.assign(existing, entry);
    scheduleCallHistorySave();
    if (dbPool) {
      upsertCallDb(existing).catch((err) => console.error("[call-history] db upsert failed", err));
    }
    return;
  }
  entry._key = key;
  callHistory.unshift(entry);
  callHistoryByKey.set(key, entry);
  if (callHistory.length > MAX_CALL_HISTORY) {
    const removed = callHistory.pop();
    if (removed && removed._key) callHistoryByKey.delete(removed._key);
  }
  scheduleCallHistorySave();
  if (dbPool) {
    upsertCallDb(entry).catch((err) => console.error("[call-history] db upsert failed", err));
  }
}

function buildCvEntry(payload = {}) {
  const createdAt = new Date().toISOString();
  const brand = payload.brand || DEFAULT_BRAND;
  const role = payload.role || DEFAULT_ROLE;
  const applicant = (payload.applicant || "").trim();
  const phone = normalizePhone(payload.phone || payload.to || "");
  const cvText = (payload.cv_text || payload.cv_summary || "").trim();
  const source = (payload.source || payload.file_name || "").trim();
  const id = payload.id || randomToken();
  const cvUrl = payload.cv_url || payload.resume_url || payload.resumeUrl || "";
  const cvPhotoUrl = payload.cv_photo_url || "";
  const customQuestion = (payload.custom_question || payload.customQuestion || "").toString().trim();
  const decision = (payload.decision || payload.status || "").toString().trim();
  return {
    id,
    created_at: createdAt,
    brand,
    brandKey: brandKey(brand),
    role,
    roleKey: roleKey(role),
    applicant,
    phone,
    cv_text: cvText,
    cv_len: cvText.length,
    cv_url: cvUrl,
    cv_photo_url: cvPhotoUrl,
    custom_question: customQuestion,
    decision,
    source
  };
}

function recordCvEntry(entry) {
  if (!entry || !entry.id) return;
  const existing = cvStoreById.get(entry.id);
  if (existing) {
    const next = { ...entry };
    if (!next.custom_question && existing.custom_question) {
      next.custom_question = existing.custom_question;
    }
    Object.assign(existing, next);
    scheduleCvStoreSave();
    if (dbPool) {
      upsertCvDb(existing).catch((err) => console.error("[cv-store] db upsert failed", err));
    }
    return;
  }
  cvStore.unshift(entry);
  cvStoreById.set(entry.id, entry);
  if (cvStore.length > MAX_CV_STORE) {
    const removed = cvStore.pop();
    if (removed && removed.id) cvStoreById.delete(removed.id);
  }
  scheduleCvStoreSave();
  if (dbPool) {
    upsertCvDb(entry).catch((err) => console.error("[cv-store] db upsert failed", err));
  }
}

async function upsertCvDb(entry) {
  if (!dbPool || !entry) return;
  const sql = `
    INSERT INTO cvs (
      id, created_at, brand, brand_key, role, role_key, applicant, phone,
      cv_text, cv_url, cv_photo_url, custom_question, decision, source
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14
    )
    ON CONFLICT (id) DO UPDATE SET
      brand = EXCLUDED.brand,
      brand_key = EXCLUDED.brand_key,
      role = EXCLUDED.role,
      role_key = EXCLUDED.role_key,
      applicant = EXCLUDED.applicant,
      phone = EXCLUDED.phone,
      cv_text = EXCLUDED.cv_text,
      cv_url = EXCLUDED.cv_url,
      cv_photo_url = EXCLUDED.cv_photo_url,
      custom_question = EXCLUDED.custom_question,
      decision = EXCLUDED.decision,
      source = EXCLUDED.source
  `;
  const values = [
    entry.id,
    entry.created_at || new Date().toISOString(),
    entry.brand || "",
    entry.brandKey || "",
    entry.role || "",
    entry.roleKey || "",
    entry.applicant || "",
    entry.phone || "",
    entry.cv_text || "",
    entry.cv_url || "",
    entry.cv_photo_url || "",
    entry.custom_question || "",
    entry.decision || "",
    entry.source || ""
  ];
  await dbQuery(sql, values);
}

async function upsertCallDb(entry) {
  if (!dbPool || !entry) return;
  const callId = entry.callId || entry._key || randomToken();
  const sql = `
    INSERT INTO calls (
      call_sid, created_at, brand, brand_key, role, role_key, applicant, phone,
      score, recommendation, summary, warmth, fluency, english, english_detail,
      experience, area, availability, salary, trial, stay_plan, stay_detail,
      mobility, outcome, outcome_detail, duration_sec, audio_url,
      english_required, cv_id, cv_text, cv_url
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,
      $9,$10,$11,$12,$13,$14,$15,
      $16,$17,$18,$19,$20,$21,$22,
      $23,$24,$25,$26,$27,
      $28,$29,$30,$31
    )
    ON CONFLICT (call_sid) DO UPDATE SET
      brand = EXCLUDED.brand,
      brand_key = EXCLUDED.brand_key,
      role = EXCLUDED.role,
      role_key = EXCLUDED.role_key,
      applicant = EXCLUDED.applicant,
      phone = EXCLUDED.phone,
      score = EXCLUDED.score,
      recommendation = EXCLUDED.recommendation,
      summary = EXCLUDED.summary,
      warmth = EXCLUDED.warmth,
      fluency = EXCLUDED.fluency,
      english = EXCLUDED.english,
      english_detail = EXCLUDED.english_detail,
      experience = EXCLUDED.experience,
      area = EXCLUDED.area,
      availability = EXCLUDED.availability,
      salary = EXCLUDED.salary,
      trial = EXCLUDED.trial,
      stay_plan = EXCLUDED.stay_plan,
      stay_detail = EXCLUDED.stay_detail,
      mobility = EXCLUDED.mobility,
      outcome = EXCLUDED.outcome,
      outcome_detail = EXCLUDED.outcome_detail,
      duration_sec = EXCLUDED.duration_sec,
      audio_url = EXCLUDED.audio_url,
      english_required = EXCLUDED.english_required,
      cv_id = EXCLUDED.cv_id,
      cv_text = EXCLUDED.cv_text,
      cv_url = EXCLUDED.cv_url
  `;
  const values = [
    callId,
    entry.created_at || new Date().toISOString(),
    entry.brand || "",
    entry.brandKey || "",
    entry.role || "",
    entry.roleKey || "",
    entry.applicant || "",
    entry.phone || "",
    entry.score !== null && entry.score !== undefined ? entry.score : null,
    entry.recommendation || null,
    entry.summary || "",
    entry.warmth !== null && entry.warmth !== undefined ? entry.warmth : null,
    entry.fluency !== null && entry.fluency !== undefined ? entry.fluency : null,
    entry.english || "",
    entry.english_detail || "",
    entry.experience || "",
    entry.area || "",
    entry.availability || "",
    entry.salary || "",
    entry.trial || "",
    entry.stay_plan || "",
    entry.stay_detail || "",
    entry.mobility || "",
    entry.outcome || "",
    entry.outcome_detail || "",
    entry.duration_sec !== null && entry.duration_sec !== undefined ? entry.duration_sec : null,
    entry.audio_url || "",
    entry.english_required ? true : false,
    entry.cv_id || "",
    entry.cv_text || "",
    entry.cv_url || ""
  ];
  await dbQuery(sql, values);
}

async function upsertCallRecording(callSid, buffer, contentType = "audio/mpeg") {
  if (!dbPool || !callSid || !buffer) return false;
  const sql = `
    INSERT INTO call_recordings (
      call_sid, created_at, updated_at, content_type, byte_size, audio_data
    ) VALUES (
      $1, NOW(), NOW(), $2, $3, $4
    )
    ON CONFLICT (call_sid) DO UPDATE SET
      updated_at = NOW(),
      content_type = EXCLUDED.content_type,
      byte_size = EXCLUDED.byte_size,
      audio_data = EXCLUDED.audio_data
  `;
  const values = [callSid, contentType || "audio/mpeg", buffer.length, buffer];
  await dbQuery(sql, values);
  return true;
}

async function fetchCallRecording(callSid) {
  if (!dbPool || !callSid) return null;
  const result = await dbQuery(
    "SELECT content_type, audio_data, byte_size FROM call_recordings WHERE call_sid = $1",
    [callSid]
  );
  return result?.rows?.[0] || null;
}

async function fetchCallsFromDb({ brandParam, roleParam, recParam, qParam, minScore, maxScore, limit, allowedBrands }) {
  if (!dbPool) return [];
  const where = [];
  const values = [];
  if (Array.isArray(allowedBrands) && allowedBrands.length) {
    values.push(allowedBrands);
    where.push(`c.brand_key = ANY($${values.length})`);
  }
  if (brandParam) {
    values.push(brandKey(brandParam));
    where.push(`c.brand_key = $${values.length}`);
  }
  if (roleParam) {
    values.push(normalizeKey(roleParam));
    where.push(`c.role_key = $${values.length}`);
  }
  if (recParam) {
    values.push(recParam);
    where.push(`LOWER(c.recommendation) = $${values.length}`);
  }
  if (!Number.isNaN(minScore)) {
    values.push(minScore);
    where.push(`c.score >= $${values.length}`);
  }
  if (!Number.isNaN(maxScore)) {
    values.push(maxScore);
    where.push(`c.score <= $${values.length}`);
  }
  if (qParam) {
    values.push(`%${qParam}%`);
    where.push(`(LOWER(c.applicant) LIKE $${values.length} OR c.phone LIKE $${values.length})`);
  }
  values.push(limit);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `
    SELECT
      c.call_sid,
      c.created_at,
      c.brand,
      c.brand_key,
      c.role,
      c.role_key,
      c.applicant,
      c.phone,
      c.score,
      c.recommendation,
      c.summary,
      c.warmth,
      c.fluency,
      c.english,
      c.english_detail,
      c.experience,
      c.area,
      c.availability,
      c.salary,
      c.trial,
      c.stay_plan,
      c.stay_detail,
      c.mobility,
      c.outcome,
      c.outcome_detail,
      c.duration_sec,
      c.audio_url,
      c.english_required,
      c.cv_id,
      COALESCE(c.cv_text, cv.cv_text) AS cv_text,
      COALESCE(c.cv_url, cv.cv_url) AS cv_url,
      COALESCE(cv.decision, '') AS decision,
      COALESCE(cv.source, '') AS source,
      COALESCE(c.applicant, cv.applicant) AS applicant_resolved,
      COALESCE(c.phone, cv.phone) AS phone_resolved
    FROM calls c
    LEFT JOIN cvs cv ON c.cv_id = cv.id
    ${whereSql}
    ORDER BY c.created_at DESC
    LIMIT $${values.length}
  `;
  const result = await dbQuery(sql, values);
  const rows = result?.rows || [];
  const mapped = [];
  for (const row of rows) {
    const audioUrl = await resolveStoredUrl(row.audio_url || "");
    const cvUrl = await resolveStoredUrl(row.cv_url || "");
    mapped.push({
      callId: row.call_sid,
      brand: row.brand || "",
      brandKey: row.brand_key || "",
      role: row.role || "",
      roleKey: row.role_key || "",
      applicant: row.applicant_resolved || row.applicant || "",
      phone: row.phone_resolved || row.phone || "",
      score: row.score !== null ? Number(row.score) : null,
      recommendation: row.recommendation || null,
      summary: row.summary || "",
      warmth: row.warmth !== null ? Number(row.warmth) : null,
      fluency: row.fluency !== null ? Number(row.fluency) : null,
      english: row.english || "",
      english_detail: row.english_detail || "",
      experience: row.experience || "",
      area: row.area || "",
      availability: row.availability || "",
      salary: row.salary || "",
      trial: row.trial || "",
      stay_plan: row.stay_plan || "",
      stay_detail: row.stay_detail || "",
      mobility: row.mobility || "",
      outcome: row.outcome || "",
      outcome_detail: row.outcome_detail || "",
      duration_sec: row.duration_sec !== null ? Number(row.duration_sec) : null,
      created_at: row.created_at ? new Date(row.created_at).toISOString() : "",
      audio_url: audioUrl || "",
      english_required: !!row.english_required,
      cv_id: row.cv_id || "",
      decision: row.decision || "",
      source: row.source || "",
      cv_text: row.cv_text || "",
      cv_url: cvUrl || ""
    });
  }
  return mapped;
}

async function fetchCallById(callId) {
  if (!dbPool || !callId) return null;
  const sql = `
    SELECT
      c.call_sid,
      c.created_at,
      c.brand,
      c.brand_key,
      c.role,
      c.role_key,
      c.applicant,
      c.phone,
      c.score,
      c.recommendation,
      c.summary,
      c.warmth,
      c.fluency,
      c.english,
      c.english_detail,
      c.experience,
      c.area,
      c.availability,
      c.salary,
      c.trial,
      c.stay_plan,
      c.stay_detail,
      c.mobility,
      c.outcome,
      c.outcome_detail,
      c.duration_sec,
      c.audio_url,
      c.english_required,
      c.cv_id,
      COALESCE(c.cv_text, cv.cv_text) AS cv_text,
      COALESCE(c.cv_url, cv.cv_url) AS cv_url,
      COALESCE(cv.decision, '') AS decision,
      COALESCE(cv.source, '') AS source,
      COALESCE(c.applicant, cv.applicant) AS applicant_resolved,
      COALESCE(c.phone, cv.phone) AS phone_resolved
    FROM calls c
    LEFT JOIN cvs cv ON c.cv_id = cv.id
    WHERE c.call_sid = $1
    LIMIT 1
  `;
  const result = await dbQuery(sql, [callId]);
  const row = result?.rows?.[0];
  if (!row) return null;
  const audioUrl = await resolveStoredUrl(row.audio_url || "");
  const cvUrl = await resolveStoredUrl(row.cv_url || "");
  return {
    callId: row.call_sid,
    brand: row.brand || "",
    brandKey: row.brand_key || "",
    role: row.role || "",
    roleKey: row.role_key || "",
    applicant: row.applicant_resolved || row.applicant || "",
    phone: row.phone_resolved || row.phone || "",
    score: row.score !== null ? Number(row.score) : null,
    recommendation: row.recommendation || null,
    summary: row.summary || "",
    warmth: row.warmth !== null ? Number(row.warmth) : null,
    fluency: row.fluency !== null ? Number(row.fluency) : null,
    english: row.english || "",
    english_detail: row.english_detail || "",
    experience: row.experience || "",
    area: row.area || "",
    availability: row.availability || "",
    salary: row.salary || "",
    trial: row.trial || "",
    stay_plan: row.stay_plan || "",
    stay_detail: row.stay_detail || "",
    mobility: row.mobility || "",
    outcome: row.outcome || "",
    outcome_detail: row.outcome_detail || "",
    duration_sec: row.duration_sec !== null ? Number(row.duration_sec) : null,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : "",
    audio_url: audioUrl || "",
    english_required: !!row.english_required,
    cv_id: row.cv_id || "",
    decision: row.decision || "",
    source: row.source || "",
    cv_text: row.cv_text || "",
    cv_url: cvUrl || ""
  };
}

async function fetchCvUrlById(cvId) {
  if (!dbPool || !cvId) return "";
  const result = await dbQuery("SELECT cv_url FROM cvs WHERE id = $1 LIMIT 1", [cvId]);
  const row = result?.rows?.[0];
  if (!row || !row.cv_url) return "";
  return resolveStoredUrl(row.cv_url, 24 * 60 * 60);
}

async function fetchCvFromDb({ brandParam, roleParam, qParam, limit, allowedBrands }) {
  if (!dbPool) return [];
  const where = [];
  const values = [];
  let allowedIndex = 0;
  if (Array.isArray(allowedBrands) && allowedBrands.length) {
    values.push(allowedBrands);
    allowedIndex = values.length;
    where.push(`c.brand_key = ANY($${values.length})`);
  }
  if (brandParam) {
    values.push(brandKey(brandParam));
    where.push(`c.brand_key = $${values.length}`);
  }
  if (roleParam) {
    values.push(normalizeKey(roleParam));
    where.push(`c.role_key = $${values.length}`);
  }
  if (qParam) {
    values.push(`%${qParam}%`);
    where.push(`(LOWER(c.applicant) LIKE $${values.length} OR c.phone LIKE $${values.length})`);
  }
  values.push(limit);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const callBrandFilter = allowedIndex ? ` AND brand_key = ANY($${allowedIndex})` : "";
  const sql = `
    WITH stats AS (
      SELECT
        cv_id,
        COUNT(*)::int AS call_count,
        MAX(created_at) AS last_call_at,
        (ARRAY_AGG(outcome ORDER BY created_at DESC))[1] AS last_outcome,
        (ARRAY_AGG(outcome_detail ORDER BY created_at DESC))[1] AS last_outcome_detail,
        (ARRAY_AGG(audio_url ORDER BY created_at DESC))[1] AS last_audio_url,
        (ARRAY_AGG(call_sid ORDER BY created_at DESC))[1] AS last_call_sid
      FROM calls
      WHERE cv_id IS NOT NULL AND cv_id <> ''${callBrandFilter}
      GROUP BY cv_id
    ),
    stats_phone AS (
      SELECT
        phone,
        brand_key,
        COUNT(*)::int AS call_count,
        MAX(created_at) AS last_call_at,
        (ARRAY_AGG(outcome ORDER BY created_at DESC))[1] AS last_outcome,
        (ARRAY_AGG(outcome_detail ORDER BY created_at DESC))[1] AS last_outcome_detail,
        (ARRAY_AGG(audio_url ORDER BY created_at DESC))[1] AS last_audio_url,
        (ARRAY_AGG(call_sid ORDER BY created_at DESC))[1] AS last_call_sid
      FROM calls
      WHERE phone IS NOT NULL AND phone <> ''${callBrandFilter}
      GROUP BY phone, brand_key
    )
    SELECT
      c.id, c.created_at, c.brand, c.brand_key, c.role, c.role_key, c.applicant, c.phone, c.cv_text, c.cv_url, c.cv_photo_url, c.custom_question, c.decision, c.source,
      COALESCE(s.call_count, sp.call_count) AS call_count,
      COALESCE(s.last_call_at, sp.last_call_at) AS last_call_at,
      COALESCE(s.last_outcome, sp.last_outcome) AS last_outcome,
      COALESCE(s.last_outcome_detail, sp.last_outcome_detail) AS last_outcome_detail,
      COALESCE(s.last_audio_url, sp.last_audio_url) AS last_audio_url,
      COALESCE(s.last_call_sid, sp.last_call_sid) AS last_call_sid
    FROM cvs c
    LEFT JOIN stats s ON s.cv_id = c.id
    LEFT JOIN stats_phone sp ON sp.phone = c.phone AND sp.brand_key = c.brand_key AND s.cv_id IS NULL
    ${whereSql}
    ORDER BY c.created_at DESC
    LIMIT $${values.length}
  `;
  const result = await dbQuery(sql, values);
  const rows = result?.rows || [];
  const mapped = [];
  for (const row of rows) {
    const cvUrl = await resolveStoredUrl(row.cv_url || "");
    const cvPhotoUrl = await resolveStoredUrl(row.cv_photo_url || "");
    const lastAudioUrl = await resolveStoredUrl(row.last_audio_url || "");
    mapped.push({
      id: row.id,
      created_at: row.created_at ? new Date(row.created_at).toISOString() : "",
      brand: row.brand || "",
      brandKey: row.brand_key || "",
      role: row.role || "",
      roleKey: row.role_key || "",
      applicant: row.applicant || "",
      phone: row.phone || "",
      cv_text: row.cv_text || "",
      cv_url: cvUrl || "",
      cv_photo_url: cvPhotoUrl || "",
      custom_question: row.custom_question || "",
      decision: row.decision || "",
      source: row.source || "",
      call_count: row.call_count !== null && row.call_count !== undefined ? Number(row.call_count) : 0,
      last_call_at: row.last_call_at ? new Date(row.last_call_at).toISOString() : "",
      last_outcome: row.last_outcome || "",
      last_outcome_detail: row.last_outcome_detail || "",
      last_audio_url: lastAudioUrl || "",
      last_call_sid: row.last_call_sid || ""
    });
  }
  return mapped;
}

function formatWhatsapp(scoring, call, opts = {}) {
  const note = opts.note || "";
  const ex = scoring?.extracted || {};
  const rec = scoring?.recommendation || "review";
  const recText = rec === "advance" ? "Avanzar" : rec === "reject" ? "No avanzar" : "Revisar";
  const recIcon = rec === "advance" ? "🟢" : rec === "reject" ? "⛔" : "🟡";
  const scoreVal = scoring?.score_0_100 ?? "n/d";
  const warmth = typeof ex.warmth_score === "number" ? `${ex.warmth_score}/10` : "n/d";
  const fluency = typeof ex.fluency_score === "number" ? `${ex.fluency_score}/10` : "n/d";
  const applicant = call.applicant || "No informado";
  const tel = call.to || call.from || "No informado";
  const role = call.spokenRole || displayRole(call.role || "", call.brand);
  const area = ex.area || "No informada";
  const duration = formatDuration(call.durationSec);
  const englishLevel = ex.english_level || "No informado";
  const englishDetail = ex.english_detail ? `\n${ex.english_detail}` : "";
  const mobility = ex.mobility || "No informada";
  const availability = ex.availability || "No informada";
  const salary = ex.salary_expectation || "No informada";
  const experience = ex.experience || "No informada";
  const trial = ex.trial_date || ex.trial_availability || "No informada";
  const stayPlan = ex.stay_plan || "No informado";
  const stayDetail = ex.stay_detail ? ` (${ex.stay_detail})` : "";

  if (!scoring) {
    const outcome = outcomeLabel(call?.outcome) || note || "Entrevista incompleta";
    const detail = note && note !== outcome ? note : "";
    return [
      `⚠️ *ENTREVISTA INCOMPLETA – ${call.brand.toUpperCase()}*`,
      ``,
      `- *CANDIDATO:* ${applicant}`,
      `- *PUESTO:* ${role}`,
      `- *RESULTADO:* ${outcome}`,
      detail ? `- *DETALLE:* ${detail}` : "",
      call.callSid ? `\`callId: ${call.callSid}\`` : "",
      duration ? `\`DURACIÓN: ${duration}\`` : ""
    ].filter(Boolean).join("\n");
  }

  const reds = (scoring.red_flags || []).filter(Boolean).slice(0, 3);

  return [
    `*ENTREVISTA – ${call.brand.toUpperCase()}*`,
    ``,
    `- *CANDIDATO:* ${applicant}`,
    `- *PUESTO:* ${role}`,
    `- *UBICACIÓN:* ${area}`,
    `- *SCORE:* ${scoreVal} / 100 ⭐`,
    `- *RECOMENDACIÓN:* ${recText.toUpperCase()} ${recIcon}`,
    ``,
    `*RESUMEN*`,
    scoring.summary ? `${scoring.summary}` : "No disponible.",
    ``,
    `- *CALIDEZ:* ${warmth}${ex.warmth_note ? ` - ${ex.warmth_note}` : ""}`,
    `- *FLUIDEZ:* ${fluency}${ex.fluency_note ? ` - ${ex.fluency_note}` : ""}`,
    ``,
    `✅ CHECKLIST`,
    `- *ZONA:* ${area}`,
    `- *MOVILIDAD:* ${mobility}`,
    `- *DISPONIBILIDAD:* ${availability}`,
    `- *PRETENSIÓN SALARIAL:* ${salary}`,
    `- *ESTADÍA:* ${stayPlan}${stayDetail}`,
    `- *PRUEBA:* ${trial}`,
    `- *INGLÉS:* ${englishLevel}${englishDetail ? ` - ${englishDetail.trim()}` : ""}`,
    ``,
    `*EXPERIENCIA:* ${experience ? `${experience}` : "No informada"}`,
    reds.length ? `- 🚩 *RED FLAGS:* ${reds.join(" · ")}` : "",
    call.callSid ? `\`callId: ${call.callSid}\`` : "",
    duration ? `\`DURACIÓN: ${duration}\`` : ""
  ].filter(Boolean).join("\n");
}

function buildScoringFromCall(call) {
  if (!call) return null;
  const hasScore = call.score !== null && call.score !== undefined;
  const hasData = !!call.summary || hasScore || !!call.recommendation;
  if (!hasData) return null;
  return {
    score_0_100: hasScore ? call.score : "n/d",
    recommendation: call.recommendation || "review",
    summary: call.summary || "",
    extracted: {
      warmth_score: call.warmth,
      fluency_score: call.fluency,
      english_level: call.english || "",
      english_detail: call.english_detail || "",
      experience: call.experience || "",
      area: call.area || "",
      availability: call.availability || "",
      salary_expectation: call.salary || "",
      trial_date: call.trial || "",
      stay_plan: call.stay_plan || "",
      stay_detail: call.stay_detail || "",
      mobility: call.mobility || ""
    }
  };
}

function hydrateCallForWhatsapp(call) {
  if (!call) return null;
  const hydrated = { ...call };
  hydrated.callSid = hydrated.callSid || hydrated.callId || hydrated.call_sid || "";
  hydrated.durationSec = hydrated.durationSec || hydrated.duration_sec || null;
  hydrated.audioUrl = hydrated.audioUrl || hydrated.audio_url || "";
  if (!hydrated.spokenRole) {
    hydrated.spokenRole = displayRole(hydrated.role || "", hydrated.brand || "");
  }
  return hydrated;
}

async function sendWhatsappMessage({ body, mediaUrl }) {
  if (!WHATSAPP_FROM || !WHATSAPP_TO || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    throw new Error("missing whatsapp credentials/from/to");
  }
  const params = new URLSearchParams();
  params.append("From", WHATSAPP_FROM);
  params.append("To", WHATSAPP_TO);
  if (body) params.append("Body", body);
  if (mediaUrl) params.append("MediaUrl", mediaUrl);
  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${base64Auth(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)}`
    },
    body: params
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`whatsapp send failed ${resp.status} ${text}`);
  }
  const data = await resp.json();
  console.log("[whatsapp] sent", { sid: data.sid, hasMedia: !!mediaUrl });
}

async function getCallAudioMediaUrl(call) {
  if (!call) return "";
  const audioKey = call.audioUrl || call.audio_url || "";
  if (audioKey) {
    return resolveStoredUrl(audioKey, 24 * 60 * 60);
  }
  if (call.recordingToken) {
    return `${PUBLIC_BASE_URL}/r/${call.recordingToken}`;
  }
  return "";
}

async function getCallCvMediaUrl(call) {
  if (!call) return "";
  const cvUrl = call.cvUrl || call.cv_url || call.resumeUrl || call.resume_url || "";
  if (!cvUrl) return "";
  return resolveStoredUrl(cvUrl, 24 * 60 * 60);
}

async function placeOutboundCall(payload) {
  const data = payload || {};
  const {
    to,
    from = TWILIO_VOICE_FROM,
    brand = DEFAULT_BRAND,
    role = DEFAULT_ROLE,
    address,
    applicant = "",
    cv_summary = "",
    cv_text = "",
    cv_id: cvIdRaw = "",
    resume_url = ""
  } = data;
  const cvSummary = (cv_summary || cv_text || "").trim();
  let cvId = cvIdRaw || "";

  const toNorm = normalizePhone(to);
  const fromNorm = normalizePhone(from);
  const roleClean = sanitizeRole(role);
  const englishReqBool = resolveEnglishRequired(brand, roleClean, data);

  if (!toNorm || !fromNorm) throw new Error("missing to/from");
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !PUBLIC_BASE_URL) {
    throw new Error("twilio or base url not configured");
  }

  const resolvedAddress = address || resolveAddress(brand, null);
  if (cvId && resume_url) {
    const cvEntry = buildCvEntry({
      id: cvId,
      brand,
      role: roleClean,
      applicant,
      phone: toNorm,
      cv_text: cv_text || cvSummary,
      resume_url
    });
    recordCvEntry(cvEntry);
  }
  if (!cvId && cvSummary && dbPool) {
    const cvEntry = buildCvEntry({
      brand,
      role: roleClean,
      applicant,
      phone: toNorm,
      cv_text: cv_text || cvSummary,
      resume_url
    });
    recordCvEntry(cvEntry);
    cvId = cvEntry.id;
  }
  const voiceToken = randomToken();
  voiceCtxByToken.set(voiceToken, {
    payload: {
      to: toNorm,
      from: fromNorm,
      brand,
      role: roleClean,
      englishRequired: englishReqBool ? "1" : "0",
      address: resolvedAddress,
      applicant,
      cv_summary: cvSummary,
      cv_id: cvId,
      resume_url
    },
    expiresAt: Date.now() + CALL_TTL_MS
  });

  const params = new URLSearchParams();
  params.append("To", toNorm);
  params.append("From", fromNorm);
  params.append("Url", `${PUBLIC_BASE_URL}/voice?token=${voiceToken}`);
  params.append("Method", "POST");
  params.append("StatusCallback", `${PUBLIC_BASE_URL}/call-status`);
  params.append("StatusCallbackEvent", "initiated ringing answered completed");
  params.append("StatusCallbackMethod", "POST");
  params.append("MachineDetection", "Enable");
  params.append("MachineDetectionTimeout", "10");

  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${base64Auth(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)}`
    },
    body: params
  });
  const respData = await resp.json();
  if (!resp.ok) {
    console.error("[placeOutboundCall] twilio_call_failed", resp.status, respData);
    throw new Error("twilio_call_failed");
  }
  console.log("[placeOutboundCall] queued", { sid: respData.sid, status: respData.status });
  if (respData.sid) {
    const call = buildCallFromPayload(
      {
        to: toNorm,
        brand,
        role: roleClean,
        englishRequired: englishReqBool ? "1" : "0",
        address: resolvedAddress,
        applicant,
        cv_summary: cvSummary,
        cv_id: cvId,
        resume_url
      },
      { callSid: respData.sid, to: toNorm }
    );
    call.from = fromNorm;
    call.expiresAt = Date.now() + CALL_TTL_MS;
    call.callStatus = respData.status || "queued";
    callsByCallSid.set(respData.sid, call);
  }
  return respData;
}

async function sendSms(to, body) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_SMS_FROM) {
    throw new Error("missing sms credentials/from");
  }
  const toNorm = normalizePhone(to);
  const fromNorm = normalizePhone(TWILIO_SMS_FROM);
  if (!toNorm || !fromNorm) {
    throw new Error(`invalid to/from for sms to=${to} from=${TWILIO_SMS_FROM}`);
  }
  const params = new URLSearchParams();
  params.append("To", toNorm);
  params.append("From", fromNorm);
  params.append("Body", body);
  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${base64Auth(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)}`
    },
    body: params
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`sms send failed ${resp.status} ${text}`);
  }
  const data = await resp.json();
  console.log("[sms] sent", { sid: data.sid, to: toNorm });
}

async function hangupCall(call) {
  if (!call?.callSid) return;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return;
  const params = new URLSearchParams();
  params.append("Status", "completed");
  try {
    const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${call.callSid}.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${base64Auth(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)}` },
      body: params
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.error("[hangup] failed", resp.status, text);
    } else {
      console.log("[hangup] completed call", call.callSid);
    }
  } catch (err) {
    console.error("[hangup] error", err);
  }
}

function syncTrackedCall(call) {
  if (!call?.callSid) return call;
  const tracked = callsByCallSid.get(call.callSid);
  if (tracked && tracked !== call) {
    Object.assign(tracked, call);
    return tracked;
  }
  return call;
}

function deactivateActiveCall(call) {
  if (!call?.callSid) return;
  const tracked = callsByCallSid.get(call.callSid);
  const target = tracked || call;
  if (isActiveCallStatus(target.callStatus)) {
    target.callStatus = "completed";
  }
}

async function markNoAnswer(call, reason) {
  try {
    if (!call) return;
    call = syncTrackedCall(call);
    if (call.callSid && noAnswerSentBySid.has(call.callSid)) {
      deactivateActiveCall(call);
      return;
    }
    setOutcome(call, "NO_ANSWER", outcomeLabel("NO_ANSWER"));
    call.noAnswerReason = reason || "No contestó";
    call.incomplete = true;
    call.scoring = null;
    call.whatsappSent = false;
    call.callStatus = "completed";
    call.expiresAt = Date.now() + CALL_TTL_MS;
    if (call.hangupTimer) {
      clearTimeout(call.hangupTimer);
      call.hangupTimer = null;
    }
    await hangupCall(call);
    const smsMsg = `📵 Candidato no contestó: ${call.applicant || "Candidato"} | ${call.brand} | ${call.spokenRole || displayRole(call.role, call.brand)} | callId: ${call.callSid || "n/a"}`;
    const toNumber = call.to || call.from;
    if (toNumber) {
      await sendSms(toNumber, smsMsg);
    }
    try {
      await sendWhatsappReport(call);
      call.whatsappSent = true;
    } catch (err) {
      console.error("[no-answer] whatsapp failed", err);
    }
    recordCallHistory(call);
    if (call.callSid) noAnswerSentBySid.set(call.callSid, Date.now() + CALL_TTL_MS);
  } catch (err) {
    console.error("[no-answer] error", err);
  }
}

async function markNoSpeech(call, reason) {
  try {
    if (!call) return;
    call = syncTrackedCall(call);
    if (call.callSid && noAnswerSentBySid.has(call.callSid)) {
      deactivateActiveCall(call);
      return;
    }
    setOutcome(call, "NO_SPEECH", outcomeLabel("NO_SPEECH"));
    call.noAnswerReason = reason || "No emitió opinión";
    call.incomplete = true;
    call.scoring = null;
    call.whatsappSent = false;
    call.callStatus = "completed";
    call.expiresAt = Date.now() + CALL_TTL_MS;
    if (call.hangupTimer) {
      clearTimeout(call.hangupTimer);
      call.hangupTimer = null;
    }
    await hangupCall(call);
    try {
      await sendWhatsappReport(call);
      call.whatsappSent = true;
    } catch (err) {
      console.error("[no-speech] whatsapp failed", err);
    }
    recordCallHistory(call);
    if (call.callSid) noAnswerSentBySid.set(call.callSid, Date.now() + CALL_TTL_MS);
  } catch (err) {
    console.error("[no-speech] error", err);
  }
}


async function sendWhatsappReport(call, opts = {}) {
  if (call.whatsappSent && !opts.force) return;
  const note = call.noTranscriptReason || "";
  const scoring = call.scoring || buildScoringFromCall(call);
  const cvId = call.cvId || call.cv_id || "";
  if (!call.cvUrl && !call.cv_url && cvId) {
    try {
      const dbCvUrl = await fetchCvUrlById(cvId);
      if (dbCvUrl) {
        call.cvUrl = dbCvUrl;
        call.cv_url = dbCvUrl;
      }
    } catch (err) {
      console.error("[whatsapp] failed fetching cv url", err);
    }
  }
  try {
    const cvUrl = await getCallCvMediaUrl(call);
    if (cvUrl) {
      try {
        await sendWhatsappMessage({ mediaUrl: cvUrl });
      } catch (err) {
        console.error("[whatsapp] failed sending cv", err);
        try {
          await sendWhatsappMessage({ body: `CV: ${cvUrl}` });
        } catch (err2) {
          console.error("[whatsapp] failed sending cv link", err2);
        }
      }
    }
  } catch (err) {
    console.error("[whatsapp] failed sending cv", err);
  }
  await sleep(1500);
  try {
    await sendWhatsappMessage({ body: formatWhatsapp(scoring, call, { note }) });
  } catch (err) {
    console.error("[whatsapp] failed sending text", err);
    return;
  }
  await sleep(1000);
  try {
    const mediaUrl = await getCallAudioMediaUrl(call);
    if (mediaUrl) {
      await sendWhatsappMessage({ mediaUrl });
    }
  } catch (err) {
    console.error("[whatsapp] failed sending audio", err);
  }
}

async function maybeScoreAndSend(call) {
  if (call.whatsappSent) return;
  if (call.outcome === "NO_ANSWER") {
    return;
  }
  if (call.incomplete) {
    await sendWhatsappReport(call);
    recordCallHistory(call);
    return;
  }
  let transcriptText = call.transcriptText || "";
  if (!transcriptText && call.recordingPath) {
    try {
      transcriptText = await transcribeAudio(call.recordingPath);
      call.transcriptText = transcriptText;
    } catch (err) {
      console.error("[transcription] failed", err);
      setOutcome(call, "TRANSCRIPTION_FAILED", outcomeLabel("TRANSCRIPTION_FAILED"));
    }
  }
  const words = (transcriptText || "").trim().split(/\s+/).filter(Boolean).length;
  if (!transcriptText || transcriptText.trim().length < 30 || words < 8) {
    call.scoring = null;
    inferIncompleteOutcome(call);
    if (!call.noTranscriptReason) {
      call.noTranscriptReason = "No se pudo usar el audio (muy corto o inaudible).";
    }
    console.warn("[scoring] skipped: transcript unusable");
  } else {
    try {
      call.scoring = await scoreTranscript(call, transcriptText);
    } catch (err) {
      console.error("[scoring] failed", err);
    }
  }
  if (call.scoring && !call.pushNotified) {
    try {
      await notifyInterviewCompleted({ call, scoring: call.scoring });
      call.pushNotified = true;
    } catch (err) {
      console.error("[push] interview notify failed", err);
    }
  }
  try {
    await sendWhatsappReport(call);
    call.whatsappSent = true;
    call.expiresAt = Date.now() + CALL_TTL_MS;
  } catch (err) {
    console.error("[whatsapp] failed", err);
  }
  recordCallHistory(call);
}

async function sendIncomplete(call, reason) {
  try {
    call.incomplete = true;
    call.noTranscriptReason = reason || "Entrevista incompleta: el candidato no contestó.";
    call.scoring = null;
    await sendWhatsappReport(call);
    recordCallHistory(call);
  } catch (err) {
    console.error("[whatsapp incomplete] failed", err);
  }
}

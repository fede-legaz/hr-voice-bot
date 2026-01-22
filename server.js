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
const AUDIO_UPLOAD_MAX_BYTES = Number(process.env.AUDIO_UPLOAD_MAX_BYTES) || 25 * 1024 * 1024;
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

if (!PUBLIC_BASE_URL) { console.error("Missing PUBLIC_BASE_URL"); process.exit(1); }
if (!OPENAI_API_KEY) { console.error("Missing OPENAI_API_KEY"); process.exit(1); }

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
const ENGLISH_CHECK_QUESTION = "Can you describe your last job and what you did day to day?";
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
  const k = roleKey(role);
  if (roleConfig) {
    // try to find displayName (prefer brand-specific)
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
        if (norm === k || aliases.includes(k)) {
          if (entry?.displayName) return entry.displayName;
          break;
        }
      }
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

function withLateClosingQuestion(questions, brandK, brandName, roleK, langPref) {
  const list = Array.isArray(questions) ? [...questions] : [];
  if (!needsLateClosingQuestion(brandK, brandName, roleK)) return list;
  const question = langPref === "en" ? LATE_CLOSING_QUESTION_EN : LATE_CLOSING_QUESTION_ES;
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

function withEnglishRequiredQuestions(questions, needsEnglish) {
  const list = Array.isArray(questions) ? [...questions] : [];
  if (!needsEnglish) return list;
  const hasLevel = list.some((q) => normalizeKey(q || "").includes("ingles"));
  const hasEnglishQuestion = list.some((q) => {
    const norm = normalizeKey(q || "");
    return norm.includes("can you")
      || norm.includes("in english")
      || norm.includes("describe your last job");
  });
  if (!hasLevel) list.push(ENGLISH_LEVEL_QUESTION);
  if (!hasEnglishQuestion) list.push(ENGLISH_CHECK_QUESTION);
  return list;
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

function buildInstructions(ctx) {
  const metaCfg = roleConfig?.meta || {};
  const brandDisplay = resolveBrandDisplay(ctx.brand);
  const applyTemplate = (tpl) => {
    if (!tpl) return "";
    return String(tpl)
      .replace(/{name}/gi, (ctx.applicant || "").split(/\s+/)[0] || "")
      .replace(/{brand}/gi, brandDisplay)
      .replace(/{role}/gi, ctx.spokenRole || displayRole(ctx.role, ctx.brand));
  };
  const openerEs = applyTemplate(metaCfg.opener_es) || `Hola${(ctx.applicant || "").split(/\s+/)[0] ? " " + (ctx.applicant || "").split(/\s+/)[0] : ""}, te llamo por una entrevista de trabajo en ${brandDisplay}. ¿Tenés un minuto para hablar?`;
  const openerEn = applyTemplate(metaCfg.opener_en) || `Hi ${(ctx.applicant || "").split(/\s+/)[0] || "there"}, I'm calling about your application for ${ctx.spokenRole || displayRole(ctx.role, ctx.brand)} at ${brandDisplay}. Do you have a minute to talk?`;
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
  const lateClosingQuestion = langPref === "en" ? LATE_CLOSING_QUESTION_EN : LATE_CLOSING_QUESTION_ES;
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
  const withLateClosing = withLateClosingQuestion(baseQs, bKey, ctx.brand, rKey, langPref);
  const specificQs = withEnglishRequiredQuestions(withLateClosing, needsEnglish);
  const promptTemplate = (metaCfg.system_prompt || "").trim() || DEFAULT_SYSTEM_PROMPT_TEMPLATE;
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
    specific_questions_inline: specificQs.join("; ")
  };
  return renderPromptTemplate(promptTemplate, promptVars).trim();
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
    resumeUrl: payload?.resume_url || "",
    recordingStarted: false,
    transcriptText: "",
    scoring: null,
    recordingPath: null,
    recordingToken: null,
    whatsappSent: false,
    audioUrl: payload?.audio_url || "",
    cvUrl: payload?.cv_url || "",
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

function collectActiveCalls() {
  const byCv = new Map();
  const byPhone = new Map();
  const now = Date.now();
  for (const call of callsByCallSid.values()) {
    if (!call) continue;
    if (call.expiresAt && call.expiresAt < now) continue;
    const status = normalizeCallStatus(call.callStatus || call.status);
    if (!isActiveCallStatus(status)) continue;
    const cvId = call.cvId || call.cv_id || "";
    if (cvId) byCv.set(cvId, status);
    const phone = normalizePhone(call.to || call.phone || "");
    const bKey = brandKey(call.brand || "");
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
const tokens = new Map(); // token -> { path, expiresAt }
const voiceCtxByToken = new Map(); // token -> { payload, expiresAt }
const viewerSessions = new Map(); // token -> { email, expiresAt }
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
const ACTIVE_CALL_STATUSES = new Set(["queued", "initiated", "ringing", "answered", "in-progress", "in progress"]);
let roleConfig = null;
let roleConfigSource = "defaults";
const recordingsDir = path.join("/tmp", "recordings");
fs.mkdirSync(recordingsDir, { recursive: true });
const rolesConfigPath = path.join(__dirname, "config", "roles.json");
const ROLE_CONFIG_DB_KEY = "roles_config";
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
  for (const [k, v] of viewerSessions.entries()) {
    if (v.expiresAt && v.expiresAt < now) viewerSessions.delete(k);
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

function extractBearerToken(authHeader) {
  if (!authHeader) return "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function isConfigAuth(authHeader) {
  if (!CONFIG_TOKEN) return false;
  return authHeader === `Bearer ${CONFIG_TOKEN}`;
}

function createViewerSession(email) {
  const token = randomToken();
  viewerSessions.set(token, { email, expiresAt: Date.now() + VIEWER_SESSION_TTL_MS });
  return token;
}

function isViewerAuth(authHeader) {
  const token = extractBearerToken(authHeader);
  if (!token) return false;
  const session = viewerSessions.get(token);
  if (!session) return false;
  if (session.expiresAt && session.expiresAt < Date.now()) {
    viewerSessions.delete(token);
    return false;
  }
  return true;
}

function requireConfig(req, res, next) {
  if (!CONFIG_TOKEN) return res.status(403).json({ error: "config token not set" });
  const auth = req.headers.authorization || "";
  if (!isConfigAuth(auth)) return res.status(401).json({ error: "unauthorized" });
  next();
}

function requireConfigOrViewer(req, res, next) {
  const auth = req.headers.authorization || "";
  if (isConfigAuth(auth) || isViewerAuth(auth)) return next();
  if (!CONFIG_TOKEN && !VIEWER_EMAIL) {
    return res.status(403).json({ error: "auth not configured" });
  }
  return res.status(401).json({ error: "unauthorized" });
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
        source TEXT
      );
    `);
    await dbPool.query(`ALTER TABLE cvs ADD COLUMN IF NOT EXISTS cv_photo_url TEXT;`);
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

app.post("/admin/login", (req, res) => {
  if (!VIEWER_EMAIL || !VIEWER_PASSWORD) {
    return res.status(403).json({ error: "viewer login disabled" });
  }
  const email = (req.body?.email || "").trim().toLowerCase();
  const password = req.body?.password || "";
  if (email !== VIEWER_EMAIL.toLowerCase() || password !== VIEWER_PASSWORD) {
    return res.status(401).json({ error: "invalid_credentials" });
  }
  const token = createViewerSession(email);
  return res.json({ ok: true, token, role: "viewer" });
});

// Config endpoints (protect with CALL_BEARER_TOKEN)
app.get("/admin/config", requireConfigOrViewer, async (req, res) => {
  if (dbPool) {
    await loadRoleConfigFromDb();
  }
  if (!roleConfig) return res.json({ config: null, source: "defaults" });
  return res.json({ config: roleConfig, source: roleConfigSource || "file" });
});

app.post("/admin/config", requireConfig, async (req, res) => {
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

app.post("/admin/preview", requireConfig, (req, res) => {
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
    return res.json({ ok: true });
  } catch (err) {
    console.error("[admin/system-prompt] failed", err);
    return res.status(400).json({ error: "system_prompt_failed", detail: err.message });
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

  if (dbPool) {
    try {
      const calls = await fetchCallsFromDb({ brandParam, roleParam, recParam, qParam, minScore, maxScore, limit });
      return res.json({ ok: true, calls });
    } catch (err) {
      console.error("[admin/calls] db failed", err);
    }
  }

  let list = callHistory.slice();
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
          audio_url: audioUrl || entry.audio_url || "",
          cv_url: cvUrl || entry.cv_url || cvEntry.cv_url || ""
        });
        continue;
      }
    }
    const audioUrl = await resolveStoredUrl(entry.audio_url || "");
    const cvUrl = await resolveStoredUrl(entry.cv_url || "");
    results.push({ ...entry, audio_url: audioUrl || entry.audio_url || "", cv_url: cvUrl || entry.cv_url || "" });
  }
  return res.json({ ok: true, calls: results });
});

app.delete("/admin/calls/:callId", requireConfig, async (req, res) => {
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

app.get("/admin/cv", requireConfigOrViewer, async (req, res) => {
  const brandParam = (req.query?.brand || "").toString();
  const roleParam = (req.query?.role || "").toString();
  const qParam = (req.query?.q || "").toString().toLowerCase();
  const limit = Math.min(Number(req.query?.limit) || 200, 500);

  if (dbPool) {
    try {
      const cvs = await fetchCvFromDb({ brandParam, roleParam, qParam, limit });
      const activeIndex = collectActiveCalls();
      const withActive = cvs.map((entry) => attachActiveCall(entry, activeIndex));
      return res.json({ ok: true, cvs: withActive });
    } catch (err) {
      console.error("[admin/cv] db failed", err);
    }
  }

  let list = cvStore.slice();
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
  for (const call of callHistory) {
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

  const activeIndex = collectActiveCalls();
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

app.post("/admin/cv", requireConfigOrViewer, async (req, res) => {
  try {
    const body = req.body || {};
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
      if (parsed && spacesEnabled) {
        const ext = path.extname(fileName || "") || (parsed.mime === "application/pdf" ? ".pdf" : ".bin");
        const key = `cvs/${id}/${sanitizeFilename(path.basename(fileName || `cv${ext}`))}`;
        await uploadToSpaces({ key, body: parsed.buffer, contentType: parsed.mime });
        cvUrl = key;
      }
    }
    if (photoDataUrl) {
      const size = estimateDataUrlBytes(photoDataUrl);
      if (size > CV_PHOTO_MAX_BYTES) {
        return res.status(400).json({ error: "cv_photo_too_large" });
      }
      const parsed = parseDataUrl(photoDataUrl);
      if (parsed && spacesEnabled) {
        const ext = parsed.mime === "image/png" ? ".png" : ".jpg";
        const key = `cvs/${id}/photo${ext}`;
        await uploadToSpaces({ key, body: parsed.buffer, contentType: parsed.mime });
        cvPhotoUrl = key;
      }
    }
    const entry = buildCvEntry(body);
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

app.delete("/admin/cv/:id", requireConfig, async (req, res) => {
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

app.post("/admin/ocr", requireConfigOrViewer, async (req, res) => {
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
          "Detecta el rostro humano principal en la imagen. " +
          "Respondé SOLO JSON con left, top, width, height normalizados (0-1). " +
          "Si no hay rostro, devolvé {}."
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

app.post("/admin/extract-contact", requireConfigOrViewer, async (req, res) => {
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
  <title>HRBOT Console</title>
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
    textarea.locked { background: #f2f0ea; color: #6b7280; }
    .table-wrapper {
      border: 1px solid var(--border);
      border-radius: 16px;
      overflow: auto;
      max-height: 540px;
      background: #fff;
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
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 180px;
    }
    .candidate-avatar {
      width: 32px;
      height: 32px;
      border-radius: 10px;
      object-fit: cover;
      border: 1px solid var(--border);
      background: #efe6d8;
    }
    .candidate-name { font-weight: 600; }
    .call-active td { background: rgba(27, 122, 140, 0.12) !important; }
    .status-live { color: #0f5563; font-weight: 700; }
    .detail-row td {
      background: #fbf7f0;
      padding: 14px 16px;
    }
    .detail-card {
      border: 1px solid var(--border);
      border-radius: 14px;
      background: #fff;
      padding: 12px;
      box-shadow: var(--shadow);
    }
    .detail-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 10px 14px;
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
      border: 1px solid var(--border);
      background: #fbfaf6;
      border-radius: 12px;
      padding: 10px 12px;
      white-space: pre-wrap;
      font-size: 12px;
      line-height: 1.45;
      color: #2f3e36;
    }
    .detail-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .audio-wrap { display: flex; align-items: center; gap: 8px; }
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
    table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
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
    .login-title { font-size: 22px; font-weight: 700; font-family: "Space Grotesk", sans-serif; }
    .login-sub { color: var(--muted); font-size: 14px; }
    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @media (max-width: 980px) {
      .app { flex-direction: column; }
      .sidebar { width: 100%; flex-basis: auto; }
      .sidebar.collapsed {
        width: 100%;
        flex-basis: auto;
        padding: 24px;
        align-items: stretch;
      }
      .sidebar.collapsed .brand-title,
      .sidebar.collapsed .nav-label,
      .sidebar.collapsed .nav-section-title,
      .sidebar.collapsed .nav-add { display: block; }
      .sidebar.collapsed .nav { align-items: stretch; }
      .content { padding: 20px; }
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
        </button>
        <button class="nav-item" id="nav-interviews" type="button" title="Interviews">
          <span class="nav-icon">I</span>
          <span class="nav-label">Interviews</span>
        </button>
        <div class="nav-section-title">Restaurantes</div>
        <div id="brand-list" class="brand-list"></div>
        <button class="secondary nav-add" id="add-brand" type="button" title="Nuevo local">+ Nuevo local</button>
      </nav>
    </aside>

    <section class="content">
      <div class="content-header">
        <div>
          <div class="eyebrow" id="view-label">Configuración</div>
          <h1 id="view-title">General</h1>
        </div>
        <div class="header-actions">
          <input type="hidden" id="token" />
          <button class="secondary" id="load" type="button">Reload</button>
          <button id="save" type="button">Save</button>
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
          <textarea id="system-prompt" class="system-prompt" placeholder="Dejá vacío para usar el prompt por defecto."></textarea>
          <div class="small">Placeholders: {name}, {brand}, {spoken_role}, {address}, {english_required}, {lang_name}, {opener_es}, {opener_en}, {specific_questions}, {cv_hint}, {brand_notes}, {role_notes}, {must_ask_line}, {lang_rules_line}, {late_closing_rule_line}, {first_name_or_blank}.</div>
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
          <div class="table-wrapper" style="margin-top:10px;">
            <table>
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Local</th>
                  <th>Posición</th>
                  <th>Candidato</th>
                  <th>Teléfono</th>
                  <th>Estado</th>
                  <th>CV</th>
                  <th>Acción</th>
                </tr>
              </thead>
              <tbody id="cv-list-body"></tbody>
            </table>
          </div>
          <div class="small" id="cv-list-count" style="margin-top:8px;"></div>
        </div>
      </section>

      <section id="interviews-view" class="view" style="display:none;">
        <div class="panel" id="results-panel" style="--delay:.06s;">
          <div class="panel-title">Entrevistas</div>
          <div class="panel-sub">Listado general con filtros por local, posición y score.</div>
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
          <div class="table-wrapper" style="margin-top:14px;">
            <table>
              <thead>
                <tr>
                  <th>Score</th>
                  <th>Fecha</th>
                  <th>Local</th>
                  <th>Posición</th>
                  <th>Candidato</th>
                  <th>Teléfono</th>
                  <th>Estado</th>
                  <th>CV</th>
                  <th>Audio</th>
                  <th>Acción</th>
                </tr>
              </thead>
              <tbody id="results-body"></tbody>
            </table>
          </div>
          <div class="small" id="results-count" style="margin-top:8px;"></div>
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
  <div id="cv-modal" class="cv-modal">
    <div class="cv-modal-card">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
        <div style="font-weight:700;">CV</div>
        <button class="secondary" id="cv-modal-close" type="button">Cerrar</button>
      </div>
      <textarea id="cv-modal-text" readonly></textarea>
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
    const statusEl = document.getElementById('status');
    const tokenEl = document.getElementById('token');
    const navGeneralEl = document.getElementById('nav-general');
    const navCallsEl = document.getElementById('nav-calls');
    const navInterviewsEl = document.getElementById('nav-interviews');
    const brandListEl = document.getElementById('brand-list');
    const addBrandEl = document.getElementById('add-brand');
    const viewTitleEl = document.getElementById('view-title');
    const viewLabelEl = document.getElementById('view-label');
    const generalViewEl = document.getElementById('general-view');
    const callsViewEl = document.getElementById('calls-view');
    const interviewsViewEl = document.getElementById('interviews-view');
    const brandViewEl = document.getElementById('brand-view');
    const loadBtnEl = document.getElementById('load');
    const saveBtnEl = document.getElementById('save');
    const brandsEl = document.getElementById('brands');
    const openerEsEl = document.getElementById('opener-es');
    const openerEnEl = document.getElementById('opener-en');
    const langRulesEl = document.getElementById('lang-rules');
    const mustAskEl = document.getElementById('must-ask');
    const systemPromptEl = document.getElementById('system-prompt');
    const adminTokenEl = document.getElementById('admin-token');
    const adminUnlockEl = document.getElementById('admin-unlock');
    const adminStatusEl = document.getElementById('admin-status');
    const previewBrandEl = document.getElementById('preview-brand');
    const previewRoleEl = document.getElementById('preview-role');
    const previewApplicantEl = document.getElementById('preview-applicant');
    const previewAddressEl = document.getElementById('preview-address');
    const previewEnglishEl = document.getElementById('preview-english');
    const previewLangEl = document.getElementById('preview-lang');
    const previewCvEl = document.getElementById('preview-cv');
    const previewOutputEl = document.getElementById('preview-output');
    const previewStatusEl = document.getElementById('preview-status');
    const callBrandEl = document.getElementById('call-brand');
    const callRoleEl = document.getElementById('call-role');
    const callNameEl = document.getElementById('call-name');
    const callPhoneEl = document.getElementById('call-phone');
    const callCvTextEl = document.getElementById('call-cv-text');
    const callBtnEl = document.getElementById('call-btn');
    const callStatusEl = document.getElementById('call-status');
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
    const cvModalEl = document.getElementById('cv-modal');
    const cvModalTextEl = document.getElementById('cv-modal-text');
    const cvModalCloseEl = document.getElementById('cv-modal-close');
    const interviewModalEl = document.getElementById('interview-modal');
    const interviewModalTextEl = document.getElementById('interview-modal-text');
    const interviewModalCloseEl = document.getElementById('interview-modal-close');
    const resultsBrandEl = document.getElementById('results-brand');
    const resultsRoleEl = document.getElementById('results-role');
    const resultsRecEl = document.getElementById('results-rec');
    const resultsScoreMinEl = document.getElementById('results-score-min');
    const resultsScoreMaxEl = document.getElementById('results-score-max');
    const resultsSearchEl = document.getElementById('results-search');
    const resultsRefreshEl = document.getElementById('results-refresh');
    const resultsTabsEl = document.getElementById('results-tabs');
    const resultsBodyEl = document.getElementById('results-body');
    const resultsCountEl = document.getElementById('results-count');
    let state = { config: {} };
    let loginMode = 'admin';
    let authRole = 'admin';
    let adminToken = '';
    let systemPromptUnlocked = false;
    let lastLoadError = '';
    let activeView = 'general';
    let activeBrandKey = '';
    let suppressSidebarSync = false;
    let resultsTimer = null;
    let cvTimer = null;
    let cvActiveTimer = null;
    let cvFilterMode = 'no_calls';
    let resultsFilterMode = 'completed';
    let lastCvList = [];
    let lastResults = [];
    let currentCvSource = '';
    let currentCvFileDataUrl = '';
    let currentCvPhotoDataUrl = '';
    let currentCvFileName = '';
    let currentCvFileType = '';
    let currentCvId = '';
    const CV_CHAR_LIMIT = 4000;
    const MAX_LOGO_SIZE = 600 * 1024;
    const MAX_PDF_PAGES = 8;
    const OCR_TEXT_THRESHOLD = 180;
    const OCR_MAX_PAGES = 3;
    const OCR_MAX_DIM = 1700;
    const OCR_JPEG_QUALITY = 0.82;
    const defaultSystemPrompt = ${JSON.stringify(DEFAULT_SYSTEM_PROMPT_TEMPLATE)};
    const defaults = {
      opener_es: "Hola {name}, te llamo por una entrevista de trabajo en {brand} para {role}. ¿Tenés un minuto para hablar?",
      opener_en: "Hi {name}, I'm calling about your application for {role} at {brand}. Do you have a minute to talk?",
      lang_rules: "Si responde en inglés, mantener toda la entrevista en inglés.",
      must_ask: "Zona/logística, disponibilidad, salario, prueba, permanencia en Miami, inglés si aplica.",
      system_prompt: defaultSystemPrompt
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

    if (window.pdfjsLib) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    }

    function setStatus(msg) { statusEl.textContent = msg || ''; }
    function setPreviewStatus(msg) { previewStatusEl.textContent = msg || ''; }
    function setLoginStatus(msg) { loginStatusEl.textContent = msg || ''; }
    function setAdminStatus(msg) { adminStatusEl.textContent = msg || ''; }
    function setCallStatus(msg) { callStatusEl.textContent = msg || ''; }
    function setCvStatus(msg) { cvStatusEl.textContent = msg || ''; }
    function setResultsCount(msg) { resultsCountEl.textContent = msg || ''; }
    function setCvListCount(msg) { cvListCountEl.textContent = msg || ''; }
    const SIDEBAR_STATE_KEY = 'hrbot_sidebar_collapsed';

    function setSidebarCollapsed(collapsed, persist = true) {
      if (!sidebarEl) return;
      sidebarEl.classList.toggle('collapsed', collapsed);
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
        setSidebarCollapsed(false, false);
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

    function applyRoleAccess() {
      const isViewer = authRole === 'viewer';
      if (navGeneralEl) navGeneralEl.style.display = isViewer ? 'none' : '';
      if (brandListEl) brandListEl.style.display = isViewer ? 'none' : '';
      if (addBrandEl) addBrandEl.style.display = isViewer ? 'none' : '';
      if (loadBtnEl) loadBtnEl.style.display = isViewer ? 'none' : '';
      if (saveBtnEl) saveBtnEl.style.display = isViewer ? 'none' : '';
      if (isViewer && activeView === 'general') {
        setActiveView(VIEW_CALLS);
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
      wrapper.querySelector('.add-role').onclick = () => {
        rolesBox.appendChild(roleTemplate());
        updateRoleOptions();
      };
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
          return { key, display, logo };
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
          return { key: roleKey, display };
        })
        .filter(Boolean);
    }

    function getRoleDisplayForBrand(brandKey, roleKey) {
      if (!brandKey || !roleKey) return roleKey || '';
      const roles = listRolesForBrand(brandKey);
      const match = roles.find((r) => r.key === roleKey);
      return match ? match.display : roleKey;
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
    }

    function updateNavActive() {
      navGeneralEl.classList.toggle('active', activeView === 'general');
      navCallsEl.classList.toggle('active', activeView === 'calls');
      navInterviewsEl.classList.toggle('active', activeView === 'interviews');
      brandListEl.querySelectorAll('.nav-item').forEach((btn) => {
        btn.classList.toggle('active', activeView === 'brand' && btn.dataset.brandKey === activeBrandKey);
      });
    }

    function setActiveView(key) {
      if (authRole === 'viewer' && key !== VIEW_CALLS && key !== VIEW_INTERVIEWS) {
        key = VIEW_CALLS;
      }
      if (key === VIEW_CALLS) {
        activeView = 'calls';
        activeBrandKey = '';
      } else if (key === VIEW_INTERVIEWS) {
        activeView = 'interviews';
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
      } else {
        viewTitleEl.textContent = 'General';
        viewLabelEl.textContent = 'Configuración';
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
        renderConfig(state.config);
        lastLoadError = '';
        setStatus('Loaded (' + (data.source || 'defaults') + ')');
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
          system_prompt: systemPromptUnlocked ? (systemPromptEl.value || '') : preservedPrompt
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
        if (typeof data.system_prompt === "string") {
          systemPromptEl.value = data.system_prompt;
        }
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
      if (/\\b(restaurant|restaurante|experience|experiencia|profile|perfil|skills|habilidades|education|educacion|objective|objetivo|summary|resumen|curriculum|cv|resume|miami|fl|server|bartender|cook|cashier|runner|manager|idioma|idiomas|language|languages|ubicacion|ubicación|location|telefono|teléfono|phone|correo|email)\\b/i.test(lower)) {
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

    async function cropFaceThumbnail(imageDataUrl, face) {
      if (!imageDataUrl || !face) return '';
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
      const box = {
        left: clampValue(face.left || 0, 0, 1),
        top: clampValue(face.top || 0, 0, 1),
        width: clampValue(face.width || 0, 0, 1),
        height: clampValue(face.height || 0, 0, 1)
      };
      if (!box.width || !box.height) return '';
      const centerX = (box.left + box.width / 2) * w;
      const centerY = (box.top + box.height / 2) * h;
      const baseSize = Math.max(box.width * w, box.height * h) * 1.35;
      const minSize = Math.min(w, h, 140);
      const cropSize = clampValue(baseSize, minSize, Math.min(w, h));
      const sx = clampValue(centerX - cropSize / 2, 0, w - cropSize);
      const sy = clampValue(centerY - cropSize / 2, 0, h - cropSize);
      const canvas = document.createElement('canvas');
      const outSize = 160;
      canvas.width = outSize;
      canvas.height = outSize;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, sx, sy, cropSize, cropSize, 0, 0, outSize, outSize);
      return canvas.toDataURL('image/jpeg', 0.86);
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
        let faceImage = '';
        if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
          const pdf = await loadPdfDocument(file);
          text = await extractPdfTextFromDoc(pdf);
          if (text.length < OCR_TEXT_THRESHOLD) {
            setCvStatus('PDF escaneado, aplicando OCR...');
            const images = await renderPdfToImages(pdf, OCR_MAX_PAGES);
            text = await runOcr(images);
            faceImage = images[0] || '';
          } else {
            try {
              const images = await renderPdfToImages(pdf, 1);
              faceImage = images[0] || '';
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
          faceImage = dataUrl;
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
        if (faceImage) {
          try {
            const face = await runFaceDetect(faceImage);
            if (face) {
              const thumb = await cropFaceThumbnail(faceImage, face);
              if (thumb) currentCvPhotoDataUrl = thumb;
            }
          } catch (err) {
            console.error('[cv-face] detect failed', err);
          }
        }
        setCvStatus('CV listo (' + callCvTextEl.value.length + ' caracteres).');
      } catch (err) {
        setCvStatus('Error: ' + err.message);
      }
    }

    async function placeCall(payloadOverride = null) {
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
      card.appendChild(grid);
      const brandLabel = call.brandKey ? getBrandDisplayByKey(call.brandKey) : (call.brand || '');
      const roleLabel = call.roleKey ? getRoleDisplayForBrand(call.brandKey || call.brand, call.roleKey) : (call.role || '');
      const statusText = formatInterviewSummary(call);
      const stay = call.stay_plan ? (call.stay_detail ? call.stay_plan + ' (' + call.stay_detail + ')' : call.stay_plan) : '';
      const englishLabel = call.english_detail ? (call.english + ' (' + call.english_detail + ')') : (call.english || '');

      addDetailItem(grid, 'Local', brandLabel);
      addDetailItem(grid, 'Posición', roleLabel);
      addDetailItem(grid, 'Candidato', call.applicant || '');
      addDetailItem(grid, 'Teléfono', call.phone || '');
      addDetailItem(grid, 'Fecha', formatDate(call.created_at));
      addDetailItem(grid, 'Estado', statusText);
      if (call.outcome === 'NO_ANSWER' && call.attempts > 1) {
        addDetailItem(grid, 'Intentos', String(call.attempts));
      }
      addDetailItem(grid, 'Recomendación', recommendationLabel(call.recommendation));
      addDetailItem(grid, 'Score', call.score !== null && call.score !== undefined ? String(Math.round(call.score)) : '');
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
        const audioLink = document.createElement('a');
        audioLink.href = call.audio_url;
        audioLink.target = '_blank';
        audioLink.rel = 'noopener';
        audioLink.textContent = 'Audio';
        audioLink.className = 'secondary btn-compact';
        audioLink.style.textDecoration = 'none';
        actions.appendChild(audioLink);
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
            _latestAt: createdAt
          };
          map.set(key, entry);
        }
        entry.attempts += 1;
        if (call.outcome === 'NO_ANSWER') entry.noAnswerAttempts += 1;
        if (call.callId) entry.callIds.push(call.callId);
        if (!entry._latestAt || createdAt >= entry._latestAt) {
          Object.assign(entry, call);
          entry._latestAt = createdAt;
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
          entry.created_at = item.created_at;
          entry.source = item.source;
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
      const grouped = groupCalls(Array.isArray(calls) ? calls : []);
      lastResults = grouped;
      const filtered = grouped.filter((call) => {
        if (resultsFilterMode === 'no_answer') return call.outcome === 'NO_ANSWER';
        if (resultsFilterMode === 'completed') return call.outcome !== 'NO_ANSWER';
        return true;
      });
      resultsBodyEl.innerHTML = '';
      filtered.forEach((call) => {
        const tr = document.createElement('tr');
        tr.classList.add('row-clickable');
        tr.addEventListener('click', (event) => {
          if (event.target.closest('button, a, audio')) return;
          toggleInterviewDetailsRow(tr, call);
        });
        const addCell = (value, className, title) => {
          const td = document.createElement('td');
          td.textContent = value || '—';
          if (className) td.className = className;
          if (title) td.title = title;
          tr.appendChild(td);
        };
        addCell(formatDate(call.created_at));
        const brandLabel = call.brandKey ? getBrandDisplayByKey(call.brandKey) : (call.brand || '');
        addCell(brandLabel, 'cell-compact', brandLabel);
        const roleLabel = call.roleKey ? getRoleDisplayForBrand(call.brandKey || call.brand, call.roleKey) : (call.role || '');
        addCell(roleLabel, 'cell-compact', roleLabel);
        addCell(call.applicant);
        addCell(call.phone);
        const statusText = formatInterviewSummary(call);
        const statusTd = document.createElement('td');
        const statusDiv = document.createElement('div');
        statusDiv.className = 'summary-cell';
        statusDiv.textContent = statusText;
        if (statusText && statusText !== '—') {
          statusDiv.addEventListener('mouseenter', () => showSummaryTooltip(statusDiv, statusText));
          statusDiv.addEventListener('mouseleave', hideSummaryTooltip);
        }
        statusTd.appendChild(statusDiv);
        tr.appendChild(statusTd);
        const cvTd = document.createElement('td');
        if (call.cv_url) {
          const wrap = document.createElement('div');
          wrap.className = 'action-stack';
          const link = document.createElement('a');
          link.href = call.cv_url;
          link.target = '_blank';
          link.rel = 'noopener';
          link.textContent = 'Ver CV';
          link.className = 'secondary btn-compact';
          link.style.textDecoration = 'none';
          wrap.appendChild(link);
          cvTd.appendChild(wrap);
        } else {
          cvTd.textContent = '—';
        }
        tr.appendChild(cvTd);
        const actionTd = document.createElement('td');
        const actionWrap = document.createElement('div');
        actionWrap.className = 'action-stack';
        if (call.audio_url) {
          const audioLink = document.createElement('a');
          audioLink.href = call.audio_url;
          audioLink.target = '_blank';
          audioLink.rel = 'noopener';
          audioLink.textContent = 'Audio';
          audioLink.className = 'secondary btn-compact';
          audioLink.style.textDecoration = 'none';
          actionWrap.appendChild(audioLink);
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

    function renderCvList(list) {
      const grouped = groupCandidates(Array.isArray(list) ? list : []);
      lastCvList = grouped;
      const filtered = grouped.filter((item) => {
        const info = cvStatusInfo(item);
        if (info.inCall) return true;
        if (cvFilterMode === 'no_calls') return info.category === 'no_calls';
        if (cvFilterMode === 'no_answer') return info.category === 'no_answer';
        if (cvFilterMode === 'interviewed') return info.category === 'interviewed';
        return true;
      });
      cvListBodyEl.innerHTML = '';
      let hasActiveCall = false;
      filtered.forEach((item) => {
        const tr = document.createElement('tr');
        const addCell = (value, className) => {
          const td = document.createElement('td');
          td.textContent = value || '—';
          if (className) td.className = className;
          tr.appendChild(td);
        };
        addCell(formatDate(item.created_at));
        const brandLabel = item.brandKey ? getBrandDisplayByKey(item.brandKey) : (item.brand || '');
        const roleLabel = item.roleKey ? getRoleDisplayForBrand(item.brandKey || item.brand, item.roleKey) : (item.role || '');
        addCell(brandLabel);
        addCell(roleLabel);
        const candidateTd = document.createElement('td');
        candidateTd.className = 'candidate-cell';
        if (item.cv_photo_url) {
          const avatar = document.createElement('img');
          avatar.src = item.cv_photo_url;
          avatar.alt = '';
          avatar.loading = 'lazy';
          avatar.className = 'candidate-avatar';
          candidateTd.appendChild(avatar);
        }
        const nameSpan = document.createElement('span');
        nameSpan.className = 'candidate-name';
        nameSpan.textContent = item.applicant || '—';
        candidateTd.appendChild(nameSpan);
        tr.appendChild(candidateTd);
        addCell(item.phone || '');
        const info = cvStatusInfo(item);
        if (info.inCall) {
          tr.classList.add('call-active');
          hasActiveCall = true;
        }
        addCell(info.statusText, info.statusClass);
        const cvTd = document.createElement('td');
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
        } else {
          cvTd.textContent = '—';
        }
        tr.appendChild(cvTd);
        const actionTd = document.createElement('td');
        const actionWrap = document.createElement('div');
        actionWrap.className = 'action-stack';
        const callBtn = document.createElement('button');
        callBtn.type = 'button';
        callBtn.className = 'btn-compact';
        callBtn.textContent = info.hasCalls ? 'Volver a llamar' : 'Llamar';
        callBtn.onclick = () => {
          currentCvId = item.id || '';
          callBrandEl.value = item.brandKey || item.brand || '';
          updateCallRoleOptions(callBrandEl.value);
          callRoleEl.value = item.roleKey || item.role || '';
          callNameEl.value = item.applicant || '';
          callPhoneEl.value = item.phone || '';
          callCvTextEl.value = item.cv_text || '';
          currentCvSource = item.source || '';
          placeCall({
            to: item.phone || '',
            brand: item.brandKey || item.brand || '',
            role: item.roleKey || item.role || '',
            applicant: item.applicant || '',
            cv_summary: truncateText(item.cv_text || '', CV_CHAR_LIMIT),
            cv_text: item.cv_text || '',
            cv_id: item.id || ''
          });
        };
        actionWrap.appendChild(callBtn);
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
        actionTd.appendChild(actionWrap);
        tr.appendChild(actionTd);
        cvListBodyEl.appendChild(tr);
      });
      if (cvActiveTimer) {
        clearTimeout(cvActiveTimer);
        cvActiveTimer = null;
      }
      if (hasActiveCall && activeView === 'calls') {
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
          const ok = await loadConfig();
          if (!ok) throw new Error(lastLoadError || 'load failed');
          setLoginStatus('');
          loginScreenEl.style.display = 'none';
          appEl.style.display = 'flex';
          applyRoleAccess();
          setActiveView(VIEW_CALLS);
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
      const ok = await loadConfig();
      if (ok) {
        setLoginStatus('');
        loginScreenEl.style.display = 'none';
        appEl.style.display = 'flex';
        applyRoleAccess();
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
    loginModeAdminEl.onclick = () => setLoginMode('admin');
    loginModeViewerEl.onclick = () => setLoginMode('viewer');
    loginBtnEl.onclick = login;
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
    navGeneralEl.onclick = () => setActiveView('');
    navCallsEl.onclick = () => setActiveView(VIEW_CALLS);
    navInterviewsEl.onclick = () => setActiveView(VIEW_INTERVIEWS);
    callBrandEl.addEventListener('change', () => updateCallRoleOptions(callBrandEl.value));
    callBrandEl.addEventListener('change', () => { currentCvId = ''; });
    callRoleEl.addEventListener('change', () => { currentCvId = ''; });
    callNameEl.addEventListener('input', () => { currentCvId = ''; });
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
          renderCvList(lastCvList);
        };
      });
    }
    if (resultsTabsEl) {
      resultsTabsEl.querySelectorAll('button').forEach((btn) => {
        btn.onclick = () => {
          resultsFilterMode = btn.dataset.filter || 'all';
          resultsTabsEl.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
          renderResults(lastResults);
        };
      });
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
    if (interviewModalCloseEl) {
      interviewModalCloseEl.addEventListener('click', closeInterviewModal);
    }
    if (interviewModalEl) {
      interviewModalEl.addEventListener('click', (event) => {
        if (event.target === interviewModalEl) closeInterviewModal();
      });
    }
    const urlToken = new URLSearchParams(window.location.search).get('token');
    if (urlToken) {
      setLoginMode('admin');
      loginTokenEl.value = urlToken;
      login();
    }
    setLoginMode('admin');
    lockSystemPrompt();
    setAdminStatus('Bloqueado');
    initSidebarState();
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
  fs.createReadStream(entry.path)
    .on("error", () => res.status(404).send("not found"))
    .pipe(res.type("audio/mpeg"));
});

// Hard-stop path for no-answer/voicemail before opening streams
async function hardStopNoAnswer({ callSid, to, brand, role, applicant, reason }) {
  const toNorm = normalizePhone(to);
  if (!toNorm) return;
  if (callSid && noAnswerSentBySid.has(callSid)) return;
  const call = {
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
  const introName = (applicant || "").split(/\s+/)[0] || "allí";
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="es-US" voice="Polly.Lupe-Neural">Hola ${xmlEscapeAttr(introName)}, te llamo por una entrevista de trabajo en ${xmlEscapeAttr(brandDisplay)} para ${xmlEscapeAttr(displayRole(role, brand))}. Soy Mariana. Si preferís en inglés, decí English.</Say>
  <Gather input="speech dtmf" action="${xmlEscapeAttr(`${PUBLIC_BASE_URL}/consent?${consentParams}`)}" method="POST" timeout="6" speechTimeout="auto" language="es-US" hints="si, sí, no, yes, sure, ok, de acuerdo, 1, 2, english">
    <Say language="es-US" voice="Polly.Lupe-Neural">Para compartir el resultado con el equipo, ¿te parece bien que grabemos esta llamada? Decí sí o no. También podés presionar 1 para sí o 2 para no.</Say>
  </Gather>
  <Say language="es-US" voice="Polly.Lupe-Neural">No te escuché, gracias por tu tiempo. Que tengas un buen día.</Say>
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
    const introName = (payload.applicant || "").split(/\s+/)[0] || "there";
    const brandDisplay = resolveBrandDisplay(payload.brand || DEFAULT_BRAND);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="en-US" voice="Polly.Joanna-Neural">Hi ${xmlEscapeAttr(introName)}, I'm Mariana from ${xmlEscapeAttr(brandDisplay)}. I'm calling about your application for ${xmlEscapeAttr(displayRole(payload.role || DEFAULT_ROLE, payload.brand || DEFAULT_BRAND))}.</Say>
  <Gather input="speech dtmf" action="${xmlEscapeAttr(`${PUBLIC_BASE_URL}/consent?${consentParams}`)}" method="POST" timeout="6" speechTimeout="auto" language="en-US" hints="yes, no, 1, 2, sure, ok">
    <Say language="en-US" voice="Polly.Joanna-Neural">To share the result with the team, is it okay if we record this call? Say yes or no. Or press 1 for yes, 2 for no.</Say>
  </Gather>
  <Say language="en-US" voice="Polly.Joanna-Neural">I didn't catch that. Thanks for your time.</Say>
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
    const twiml = es
      ? `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="es-US" voice="Polly.Lupe-Neural">Perfecto, no hay problema. Gracias por tu tiempo. Que tengas un buen día.</Say>
  <Hangup/>
</Response>`
      : `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="en-US" voice="Polly.Joanna-Neural">Understood, no problem. Thanks for your time. Goodbye.</Say>
  <Hangup/>
</Response>`;
    return res.type("text/xml").send(twiml);
  }

  const consentParams = new URLSearchParams({ token, attempt: String(attempt + 1), lang }).toString();
  const es = lang !== "en";
  const twiml = es
    ? `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech dtmf" action="${xmlEscapeAttr(`${PUBLIC_BASE_URL}/consent?${consentParams}`)}" method="POST" timeout="5">
    <Say language="es-US" voice="Polly.Lupe-Neural">Para confirmar: ¿sí o no a grabar la llamada? También podés presionar 1 para sí, o 2 para no.</Say>
  </Gather>
  <Say language="es-US" voice="Polly.Lupe-Neural">No te escuché, gracias por tu tiempo.</Say>
  <Hangup/>
</Response>`
    : `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech dtmf" action="${xmlEscapeAttr(`${PUBLIC_BASE_URL}/consent?${consentParams}`)}" method="POST" timeout="5">
    <Say language="en-US" voice="Polly.Joanna-Neural">To confirm: yes or no to recording? You can also press 1 for yes or 2 for no.</Say>
  </Gather>
  <Say language="en-US" voice="Polly.Joanna-Neural">I didn't catch that. Thanks for your time.</Say>
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

app.post("/call", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    const authed = isConfigAuth(authHeader) || isViewerAuth(authHeader);
    if (!authed) {
      if (!CALL_BEARER_TOKEN && !VIEWER_EMAIL) {
        return res.status(403).json({ error: "auth not configured" });
      }
      return res.status(401).json({ error: "unauthorized" });
    }

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

    const cvSummary = (cv_summary || cv_text || "").trim();
    let cvId = cvIdRaw || "";

    const roleClean = sanitizeRole(role);
    const toNorm = normalizePhone(to);
    const fromNorm = normalizePhone(from);

    const englishReqBool = resolveEnglishRequired(brand, roleClean, body);

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

    if (!cvId && cvSummary && dbPool) {
      const cvEntry = buildCvEntry({
        brand,
        role: roleClean,
        applicant,
        phone: toNorm,
        cv_text: cv_text || cvSummary
      });
      recordCvEntry(cvEntry);
      cvId = cvEntry.id;
    }

    // Guarda payload para posible recall
    lastCallByNumber.set(toNorm, {
      payload: { to: toNorm, from: fromNorm, brand, role: roleClean, englishRequired: englishReqBool ? "1" : "0", address: resolvedAddress, applicant, cv_summary: cvSummary, cv_id: cvId, resume_url },
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
          resume_url
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
    const openerLine =
      call.lang === "en"
        ? (firstName
            ? `Hi ${firstName}, I'm calling you about an interview for ${spokenRole} at ${call.brand}. Do you have a minute to talk?`
            : `Hi, I'm calling you about an interview for ${spokenRole} at ${call.brand}. Do you have a minute to talk?`)
        : (firstName
            ? `Hola ${firstName}, te llamo por una entrevista de trabajo en ${call.brand} para ${spokenRole}. ¿Tenés un minuto para hablar?`
            : `Hola, te llamo por una entrevista de trabajo en ${call.brand} para ${spokenRole}. ¿Tenés un minuto para hablar?`);
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
  try {
    const stats = await fs.promises.stat(dest);
    if (spacesEnabled && stats.size <= AUDIO_UPLOAD_MAX_BYTES) {
      const key = `audio/${call.callSid || recordingSid}.mp3`;
      const body = await fs.promises.readFile(dest);
      await uploadToSpaces({ key, body, contentType: "audio/mpeg" });
      call.audioUrl = key;
    }
  } catch (err) {
    console.error("[recording] spaces upload failed", err);
  }
  const token = randomToken();
  tokens.set(token, { path: dest, expiresAt: Date.now() + TOKEN_TTL_MS });
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
  const cvUrl = payload.cv_url || "";
  const cvPhotoUrl = payload.cv_photo_url || "";
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
    source
  };
}

function recordCvEntry(entry) {
  if (!entry || !entry.id) return;
  const existing = cvStoreById.get(entry.id);
  if (existing) {
    Object.assign(existing, entry);
    scheduleCvStoreSave();
    if (dbPool) {
      upsertCvDb(entry).catch((err) => console.error("[cv-store] db upsert failed", err));
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
      cv_text, cv_url, cv_photo_url, source
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
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

async function fetchCallsFromDb({ brandParam, roleParam, recParam, qParam, minScore, maxScore, limit }) {
  if (!dbPool) return [];
  const where = [];
  const values = [];
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
      cv_text: row.cv_text || "",
      cv_url: cvUrl || ""
    });
  }
  return mapped;
}

async function fetchCvFromDb({ brandParam, roleParam, qParam, limit }) {
  if (!dbPool) return [];
  const where = [];
  const values = [];
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
      WHERE cv_id IS NOT NULL AND cv_id <> ''
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
      WHERE phone IS NOT NULL AND phone <> ''
      GROUP BY phone, brand_key
    )
    SELECT
      c.id, c.created_at, c.brand, c.brand_key, c.role, c.role_key, c.applicant, c.phone, c.cv_text, c.cv_url, c.cv_photo_url, c.source,
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
  if (call.audioUrl) {
    return resolveStoredUrl(call.audioUrl, 24 * 60 * 60);
  }
  if (call.recordingToken) {
    return `${PUBLIC_BASE_URL}/r/${call.recordingToken}`;
  }
  return "";
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
  if (!cvId && cvSummary && dbPool) {
    const cvEntry = buildCvEntry({
      brand,
      role: roleClean,
      applicant,
      phone: toNorm,
      cv_text: cv_text || cvSummary
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

async function markNoAnswer(call, reason) {
  try {
    if (!call) return;
    if (call.callSid && noAnswerSentBySid.has(call.callSid)) return;
    setOutcome(call, "NO_ANSWER", outcomeLabel("NO_ANSWER"));
    call.noAnswerReason = reason || "No contestó";
    call.incomplete = true;
    call.scoring = null;
    call.whatsappSent = false;
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
    if (call.callSid && noAnswerSentBySid.has(call.callSid)) return;
    setOutcome(call, "NO_SPEECH", outcomeLabel("NO_SPEECH"));
    call.noAnswerReason = reason || "No emitió opinión";
    call.incomplete = true;
    call.scoring = null;
    call.whatsappSent = false;
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


async function sendWhatsappReport(call) {
  if (call.whatsappSent) return;
  const note = call.noTranscriptReason || "";
  try {
    await sendWhatsappMessage({ body: formatWhatsapp(call.scoring, call, { note }) });
  } catch (err) {
    console.error("[whatsapp] failed sending text", err);
    return;
  }
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

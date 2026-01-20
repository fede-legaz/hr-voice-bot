"use strict";

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const OPENAI_MODEL_REALTIME = process.env.OPENAI_MODEL_REALTIME || process.env.OPENAI_MODEL || "gpt-4o-mini-realtime-preview-2024-12-17";
const OPENAI_MODEL_SCORING = process.env.OPENAI_MODEL_SCORING || "gpt-4o-mini";
const OPENAI_MODEL_OCR = process.env.OPENAI_MODEL_OCR || "gpt-4o-mini";
const OCR_MAX_IMAGES = Number(process.env.OCR_MAX_IMAGES) || 3;
const OCR_MAX_IMAGE_BYTES = Number(process.env.OCR_MAX_IMAGE_BYTES) || 2 * 1024 * 1024;
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
    outcome: null,
    noTranscriptReason: null,
    incomplete: true,
    startedAt: Date.now(),
    durationSec: null
  };
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
let roleConfig = null;
const recordingsDir = path.join("/tmp", "recordings");
fs.mkdirSync(recordingsDir, { recursive: true });
const rolesConfigPath = path.join(__dirname, "config", "roles.json");

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
}
setInterval(cleanup, 5 * 60 * 1000).unref();

function randomToken() {
  return crypto.randomBytes(16).toString("hex");
}

function loadRoleConfig() {
  try {
    const raw = fs.readFileSync(rolesConfigPath, "utf8");
    roleConfig = JSON.parse(raw);
    console.log("[config] roles.json loaded");
  } catch (err) {
    console.error("[config] failed to load roles.json, using defaults", err.message);
    roleConfig = null;
  }
}
loadRoleConfig();

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

function requireConfig(req, res, next) {
  if (!CONFIG_TOKEN) return res.status(403).json({ error: "config token not set" });
  const auth = req.headers.authorization || "";
  const expected = `Bearer ${CONFIG_TOKEN}`;
  if (auth !== expected) return res.status(401).json({ error: "unauthorized" });
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

const app = express();
app.use(express.json({ limit: "12mb" }));
app.use(express.urlencoded({ extended: false }));

// Config endpoints (protect with CALL_BEARER_TOKEN)
app.get("/admin/config", requireConfig, (req, res) => {
  if (!roleConfig) return res.json({ config: null, source: "defaults" });
  return res.json({ config: roleConfig, source: "file" });
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
    const normalized = JSON.stringify(parsed, null, 2);
    await fs.promises.writeFile(rolesConfigPath, normalized, "utf8");
    roleConfig = parsed;
    return res.json({ ok: true });
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
    const serialized = JSON.stringify(roleConfig, null, 2);
    await fs.promises.writeFile(rolesConfigPath, serialized, "utf8");
    return res.json({ ok: true });
  } catch (err) {
    console.error("[admin/system-prompt] failed", err);
    return res.status(400).json({ error: "system_prompt_failed", detail: err.message });
  }
});

app.get("/admin/calls", requireConfig, (req, res) => {
  const brandParam = (req.query?.brand || "").toString();
  const roleParam = (req.query?.role || "").toString();
  const recParam = (req.query?.recommendation || "").toString().toLowerCase();
  const qParam = (req.query?.q || "").toString().toLowerCase();
  const minScore = Number(req.query?.minScore);
  const maxScore = Number(req.query?.maxScore);
  const limit = Math.min(Number(req.query?.limit) || 200, 500);

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

  const results = list.slice(0, limit).map((entry) => {
    if (!entry) return entry;
    if ((!entry.cv_text || !entry.cv_text.trim()) && entry.cv_id) {
      const cvEntry = cvStoreById.get(entry.cv_id);
      if (cvEntry) {
        return {
          ...entry,
          cv_text: cvEntry.cv_text || "",
          applicant: entry.applicant || cvEntry.applicant || "",
          phone: entry.phone || cvEntry.phone || ""
        };
      }
    }
    return entry;
  });
  return res.json({ ok: true, calls: results });
});

app.get("/admin/cv", requireConfig, (req, res) => {
  const brandParam = (req.query?.brand || "").toString();
  const roleParam = (req.query?.role || "").toString();
  const qParam = (req.query?.q || "").toString().toLowerCase();
  const limit = Math.min(Number(req.query?.limit) || 200, 500);

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

  return res.json({ ok: true, cvs: list.slice(0, limit) });
});

app.post("/admin/cv", requireConfig, (req, res) => {
  try {
    const body = req.body || {};
    const entry = buildCvEntry(body);
    if (!entry.cv_text) {
      return res.status(400).json({ error: "missing_cv_text" });
    }
    recordCvEntry(entry);
    return res.json({ ok: true, cv: entry });
  } catch (err) {
    console.error("[admin/cv] failed", err);
    return res.status(400).json({ error: "cv_failed", detail: err.message });
  }
});

app.post("/admin/ocr", requireConfig, async (req, res) => {
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
      --primary: #1e6d5c;
      --primary-dark: #13443b;
      --accent: #f4a261;
      --ink: #1b1b1b;
      --muted: #6a6f6b;
      --border: #e4dac8;
      --shadow: 0 12px 30px rgba(30, 45, 40, 0.12);
      --glow: 0 0 0 2px rgba(30, 109, 92, 0.12);
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
        linear-gradient(120deg, rgba(30, 109, 92, 0.05), rgba(255, 255, 255, 0));
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
      box-shadow: 0 10px 20px rgba(30, 109, 92, 0.2);
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
      background: linear-gradient(165deg, #0f3f35 0%, #1e6d5c 60%, #2b8a73 100%);
      color: #f8f3ea;
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    .sidebar-brand { display: flex; flex-direction: column; gap: 4px; }
    .brand-mark { font-size: 20px; font-weight: 700; letter-spacing: 2px; text-transform: uppercase; }
    .brand-sub { font-size: 12px; color: rgba(248, 243, 234, 0.7); }
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
    }
    .nav-item.active {
      background: rgba(255, 255, 255, 0.15);
      border-color: rgba(255, 255, 255, 0.35);
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
    .pill { padding: 4px 10px; border-radius: 999px; background: #e7efe9; color: #1f4d3f; font-weight: 600; font-size: 11px; }
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
      background: rgba(30, 109, 92, 0.12);
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
    .audio-wrap { display: flex; align-items: center; gap: 8px; }
    .audio-speed {
      padding: 6px 8px;
      border-radius: 10px;
      border: 1px solid var(--border);
      font-size: 12px;
      background: #fff;
    }
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
    .score-pill {
      padding: 4px 8px;
      border-radius: 999px;
      font-weight: 700;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 44px;
    }
    .score-high { background: rgba(30, 109, 92, 0.18); color: #155346; }
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
    .badge.advance { background: rgba(30, 109, 92, 0.16); color: #155346; }
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
      .sidebar { width: 100%; }
      .content { padding: 20px; }
    }
  </style>
</head>
<body>
  <div id="login-screen" class="login-screen">
    <div class="login-card">
      <div class="login-title">HRBOT Admin</div>
      <div class="login-sub">Ingresá tu clave para abrir la consola.</div>
      <div class="row">
        <label>Clave</label>
        <input type="password" id="login-token" placeholder="YB key" />
      </div>
      <div class="row inline" style="justify-content: space-between;">
        <button id="login-btn">Entrar</button>
        <span class="status" id="login-status"></span>
      </div>
    </div>
  </div>

  <div id="app" class="app" style="display:none;">
    <aside class="sidebar">
      <div class="sidebar-brand">
        <div class="brand-mark">HRBOT</div>
        <div class="brand-sub">Hiring control center</div>
      </div>
      <nav class="nav">
        <button class="nav-item" id="nav-general" type="button">General</button>
        <button class="nav-item" id="nav-calls" type="button">CVs</button>
        <button class="nav-item" id="nav-interviews" type="button">Entrevistas</button>
        <div class="nav-section-title">Restaurantes</div>
        <div id="brand-list" class="brand-list"></div>
        <button class="secondary nav-add" id="add-brand" type="button">+ Nuevo local</button>
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
          <div class="table-wrapper" style="margin-top:14px;">
            <table>
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Local</th>
                  <th>Posición</th>
                  <th>Candidato</th>
                  <th>Teléfono</th>
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
              <input type="text" id="results-search" placeholder="Nombre o teléfono" />
            </div>
            <div style="display:flex; align-items:flex-end;">
              <button class="secondary" id="results-refresh" type="button">Refresh</button>
            </div>
          </div>
          <div class="table-wrapper" style="margin-top:14px;">
            <table>
              <thead>
                <tr>
                  <th>Score</th>
                  <th>Local</th>
                  <th>Candidato</th>
                  <th>Posición</th>
                  <th>Calidez</th>
                  <th>Fluidez</th>
                  <th>Inglés</th>
                  <th>Experiencia</th>
                  <th>Zona</th>
                  <th>Disponibilidad</th>
                  <th>Se queda en EE.UU.</th>
                  <th>Expectativa salarial</th>
                  <th>Resumen</th>
                  <th>CV</th>
                  <th>Teléfono</th>
                  <th>Fecha</th>
                  <th>Audio</th>
                  <th>Nivel</th>
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
  <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
  <script>
    const appEl = document.getElementById('app');
    const loginScreenEl = document.getElementById('login-screen');
    const loginTokenEl = document.getElementById('login-token');
    const loginBtnEl = document.getElementById('login-btn');
    const loginStatusEl = document.getElementById('login-status');
    const statusEl = document.getElementById('status');
    const tokenEl = document.getElementById('token');
    const navGeneralEl = document.getElementById('nav-general');
    const navCallsEl = document.getElementById('nav-calls');
    const navInterviewsEl = document.getElementById('nav-interviews');
    const brandListEl = document.getElementById('brand-list');
    const viewTitleEl = document.getElementById('view-title');
    const viewLabelEl = document.getElementById('view-label');
    const generalViewEl = document.getElementById('general-view');
    const callsViewEl = document.getElementById('calls-view');
    const interviewsViewEl = document.getElementById('interviews-view');
    const brandViewEl = document.getElementById('brand-view');
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
    const cvDropEl = document.getElementById('cv-drop');
    const cvFileEl = document.getElementById('cv-file');
    const cvStatusEl = document.getElementById('cv-status');
    const cvFilterBrandEl = document.getElementById('cv-filter-brand');
    const cvFilterSearchEl = document.getElementById('cv-filter-search');
    const cvRefreshEl = document.getElementById('cv-refresh');
    const cvListBodyEl = document.getElementById('cv-list-body');
    const cvListCountEl = document.getElementById('cv-list-count');
    const cvModalEl = document.getElementById('cv-modal');
    const cvModalTextEl = document.getElementById('cv-modal-text');
    const cvModalCloseEl = document.getElementById('cv-modal-close');
    const resultsBrandEl = document.getElementById('results-brand');
    const resultsRoleEl = document.getElementById('results-role');
    const resultsRecEl = document.getElementById('results-rec');
    const resultsScoreMinEl = document.getElementById('results-score-min');
    const resultsScoreMaxEl = document.getElementById('results-score-max');
    const resultsSearchEl = document.getElementById('results-search');
    const resultsRefreshEl = document.getElementById('results-refresh');
    const resultsBodyEl = document.getElementById('results-body');
    const resultsCountEl = document.getElementById('results-count');
    let state = { config: {} };
    let adminToken = '';
    let systemPromptUnlocked = false;
    let lastLoadError = '';
    let activeView = 'general';
    let activeBrandKey = '';
    let suppressSidebarSync = false;
    let resultsTimer = null;
    let cvTimer = null;
    let currentCvSource = '';
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

    function openCvModal(text) {
      if (!cvModalEl) return;
      cvModalTextEl.value = text || '';
      cvModalEl.style.display = 'flex';
    }

    function closeCvModal() {
      if (!cvModalEl) return;
      cvModalEl.style.display = 'none';
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
            <span class="pill" style="background:\${data.englishRequired ? '#dbeae3' : '#f3f0ea'}; color:\${data.englishRequired ? '#155346' : '#6a6f6b'};">EN</span>
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
        viewTitleEl.textContent = 'CVs';
        viewLabelEl.textContent = 'Llamadas';
      } else if (activeView === 'interviews') {
        viewTitleEl.textContent = 'Entrevistas';
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
        setStatus('Saved.');
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
      let name = raw.replace(/[\t]+/g, ' ').replace(/\s+/g, ' ').trim();
      name = name.replace(/\b(email|correo|phone|tel|telefono|teléfono|address|direccion|dirección)\b.*$/i, '').trim();
      name = name.replace(/[<>]/g, '').trim();
      name = name.replace(/[@0-9]/g, '').trim();
      name = name.replace(/\s{2,}/g, ' ').trim();
      const parts = name.split(' ').filter(Boolean);
      if (parts.length > 4) return parts.slice(0, 4).join(' ');
      return name;
    }

    function extractNameFromCv(text) {
      if (!text) return '';
      const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
      const labelRe = /^(?:name|nombre|candidate|applicant)\s*[:\-]\s*(.+)$/i;
      for (const line of lines) {
        const match = line.match(labelRe);
        if (match && match[1]) {
          const cleaned = cleanNameCandidate(match[1]);
          if (cleaned.split(' ').length >= 2) return cleaned;
        }
      }
      const inlineRe = /\b(?:name|nombre)\s*[:\-]\s*([A-Za-zÁÉÍÓÚÑñ'.-]+\s+[A-Za-zÁÉÍÓÚÑñ'.-]+(?:\s+[A-Za-zÁÉÍÓÚÑñ'.-]+){0,2})/i;
      for (const line of lines) {
        const match = line.match(inlineRe);
        if (match && match[1]) {
          const cleaned = cleanNameCandidate(match[1]);
          if (cleaned.split(' ').length >= 2) return cleaned;
        }
      }
      for (const line of lines.slice(0, 4)) {
        if (/@/.test(line)) continue;
        if (/\d/.test(line)) continue;
        const cleaned = cleanNameCandidate(line);
        const parts = cleaned.split(' ').filter(Boolean);
        if (parts.length >= 2 && parts.length <= 4) return cleaned;
      }
      return '';
    }

    function maybeFillNameFromCv(text) {
      if (callNameEl.value && callNameEl.value.trim()) return;
      const name = extractNameFromCv(text || '');
      if (name) {
        callNameEl.value = name;
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

    async function handleCvFile(file) {
      if (!file) return;
      currentCvSource = file.name || '';
      setCvStatus('Leyendo CV...');
      try {
        let text = '';
        if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
          const pdf = await loadPdfDocument(file);
          text = await extractPdfTextFromDoc(pdf);
          if (text.length < OCR_TEXT_THRESHOLD) {
            setCvStatus('PDF escaneado, aplicando OCR...');
            const images = await renderPdfToImages(pdf, OCR_MAX_PAGES);
            text = await runOcr(images);
          }
        } else if (file.type.startsWith('image/')) {
          setCvStatus('Leyendo imagen con OCR...');
          const dataUrl = await fileToDataUrl(file);
          text = await runOcr([dataUrl]);
        } else if (file.type.startsWith('text/') || file.name.toLowerCase().endsWith('.txt')) {
          text = await file.text();
        } else {
          throw new Error('Formato no soportado (PDF, imagen o TXT).');
        }
        callCvTextEl.value = truncateText(text, CV_CHAR_LIMIT);
        maybeFillNameFromCv(callCvTextEl.value);
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
        if (!basePayload.applicant.trim()) {
          maybeFillNameFromCv(basePayload.cv_text || basePayload.cv_summary || '');
          basePayload.applicant = callNameEl.value || '';
        }
        if (!basePayload.applicant.trim()) {
          setCallStatus('Error: falta nombre y apellido.');
          return;
        }
        if (!basePayload.cv_summary) {
          setCallStatus('Error: falta CV.');
          return;
        }
        const payload = payloadOverride ? { ...basePayload, ...payloadOverride } : basePayload;
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

    function scorePill(score) {
      const span = document.createElement('span');
      span.className = 'score-pill';
      if (typeof score !== 'number') {
        span.textContent = '—';
        span.classList.add('score-mid');
        return span;
      }
      span.textContent = Math.round(score);
      if (score >= 80) span.classList.add('score-high');
      else if (score >= 60) span.classList.add('score-mid');
      else span.classList.add('score-low');
      return span;
    }

    function renderResults(calls) {
      resultsBodyEl.innerHTML = '';
      calls.forEach((call) => {
        const tr = document.createElement('tr');
        const addCell = (value) => {
          const td = document.createElement('td');
          td.textContent = value || '—';
          tr.appendChild(td);
        };
        const scoreCell = document.createElement('td');
        scoreCell.appendChild(scorePill(call.score));
        tr.appendChild(scoreCell);
        addCell(call.brand);
        addCell(call.applicant);
        addCell(call.role);
        addCell(call.warmth !== null && call.warmth !== undefined ? String(call.warmth) : '—');
        addCell(call.fluency !== null && call.fluency !== undefined ? String(call.fluency) : '—');
        addCell(call.english || '—');
        addCell(call.experience);
        addCell(call.area);
        addCell(call.availability);
        const stay = call.stay_plan ? (call.stay_detail ? call.stay_plan + ' (' + call.stay_detail + ')' : call.stay_plan) : '—';
        addCell(stay);
        addCell(call.salary);
        addCell(call.summary || call.outcome_detail || '—');
        const cvTd = document.createElement('td');
        if (call.cv_text) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'secondary';
          btn.textContent = 'Ver CV';
          btn.onclick = () => openCvModal(call.cv_text || '');
          cvTd.appendChild(btn);
        } else {
          cvTd.textContent = '—';
        }
        tr.appendChild(cvTd);
        addCell(call.phone);
        addCell(formatDate(call.created_at));
        const audioTd = document.createElement('td');
        if (call.audio_url) {
          const wrap = document.createElement('div');
          wrap.className = 'audio-wrap';
          const audio = document.createElement('audio');
          audio.controls = true;
          audio.preload = 'none';
          audio.src = call.audio_url;
          const speed = document.createElement('select');
          speed.className = 'audio-speed';
          [
            { label: '1x', value: '1' },
            { label: '1.25x', value: '1.25' },
            { label: '1.5x', value: '1.5' },
            { label: '1.75x', value: '1.75' },
            { label: '2x', value: '2' }
          ].forEach((opt) => {
            const option = document.createElement('option');
            option.value = opt.value;
            option.textContent = opt.label;
            speed.appendChild(option);
          });
          speed.value = '1';
          speed.addEventListener('change', () => {
            const rate = Number(speed.value);
            audio.playbackRate = Number.isFinite(rate) ? rate : 1;
          });
          wrap.appendChild(audio);
          wrap.appendChild(speed);
          audioTd.appendChild(wrap);
        } else {
          audioTd.textContent = '—';
        }
        tr.appendChild(audioTd);
        const recTd = document.createElement('td');
        recTd.appendChild(recommendationBadge(call.recommendation || 'review'));
        tr.appendChild(recTd);
        resultsBodyEl.appendChild(tr);
      });
      setResultsCount(calls.length ? calls.length + ' llamadas' : 'Sin llamadas todavía.');
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

    function renderCvList(list) {
      cvListBodyEl.innerHTML = '';
      list.forEach((item) => {
        const tr = document.createElement('tr');
        const addCell = (value) => {
          const td = document.createElement('td');
          td.textContent = value || '—';
          tr.appendChild(td);
        };
        addCell(formatDate(item.created_at));
        const brandLabel = item.brandKey ? getBrandDisplayByKey(item.brandKey) : (item.brand || '');
        const roleLabel = item.roleKey ? getRoleDisplayForBrand(item.brandKey || item.brand, item.roleKey) : (item.role || '');
        addCell(brandLabel);
        addCell(roleLabel);
        addCell(item.applicant || '');
        addCell(item.phone || '');
        const cvTd = document.createElement('td');
        if (item.cv_text) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'secondary';
          btn.textContent = 'Ver CV';
          btn.onclick = () => openCvModal(item.cv_text || '');
          cvTd.appendChild(btn);
        } else {
          cvTd.textContent = '—';
        }
        tr.appendChild(cvTd);
        const actionTd = document.createElement('td');
        const callBtn = document.createElement('button');
        callBtn.type = 'button';
        callBtn.textContent = 'Llamar';
        callBtn.onclick = () => {
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
        actionTd.appendChild(callBtn);
        tr.appendChild(actionTd);
        cvListBodyEl.appendChild(tr);
      });
      setCvListCount(list.length ? list.length + ' CVs' : 'Sin CVs guardados.');
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

    async function saveCv() {
      setCallStatus('Guardando CV...');
      try {
        const payload = {
          brand: callBrandEl.value || '',
          role: callRoleEl.value || '',
          applicant: callNameEl.value || '',
          phone: callPhoneEl.value || '',
          cv_text: callCvTextEl.value || '',
          source: currentCvSource || ''
        };
        if (!payload.applicant.trim()) {
          maybeFillNameFromCv(payload.cv_text || '');
          payload.applicant = callNameEl.value || '';
        }
        if (!payload.applicant.trim()) {
          setCallStatus('Error: falta nombre y apellido.');
          return;
        }
        if (!payload.cv_text.trim()) {
          setCallStatus('Error: falta CV.');
          return;
        }
        const resp = await fetch('/admin/cv', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokenEl.value },
          body: JSON.stringify(payload)
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || 'cv save failed');
        setCallStatus('CV guardado.');
        loadCvList();
      } catch (err) {
        setCallStatus('Error: ' + err.message);
      }
    }

    async function login() {
      const key = (loginTokenEl.value || '').trim();
      if (!key) {
        setLoginStatus('Ingresá la clave');
        return;
      }
      setLoginStatus('Verificando...');
      tokenEl.value = key;
      const ok = await loadConfig();
      if (ok) {
        setLoginStatus('');
        loginScreenEl.style.display = 'none';
        appEl.style.display = 'flex';
      } else {
        setLoginStatus(lastLoadError ? 'Error: ' + lastLoadError : 'Clave inválida');
      }
    }

    document.getElementById('load').onclick = loadConfig;
    document.getElementById('save').onclick = saveConfig;
    document.getElementById('add-brand').onclick = () => {
      brandsEl.appendChild(brandTemplate(''));
      syncSidebar();
    };
    document.getElementById('preview-generate').onclick = generatePreview;
    adminUnlockEl.onclick = unlockAdmin;
    loginBtnEl.onclick = login;
    loginTokenEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') login();
    });
    navGeneralEl.onclick = () => setActiveView('');
    navCallsEl.onclick = () => setActiveView(VIEW_CALLS);
    navInterviewsEl.onclick = () => setActiveView(VIEW_INTERVIEWS);
    callBrandEl.addEventListener('change', () => updateCallRoleOptions(callBrandEl.value));
    callBtnEl.onclick = placeCall;
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
    callCvTextEl.addEventListener('blur', () => {
      if (!callNameEl.value || !callNameEl.value.trim()) {
        maybeFillNameFromCv(callCvTextEl.value || '');
      }
    });
    cvModalCloseEl.addEventListener('click', closeCvModal);
    cvModalEl.addEventListener('click', (event) => {
      if (event.target === cvModalEl) closeCvModal();
    });
    const urlToken = new URLSearchParams(window.location.search).get('token');
    if (urlToken) {
      loginTokenEl.value = urlToken;
      login();
    }
    lockSystemPrompt();
    setAdminStatus('Bloqueado');
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
    const statusNoAnswer = ["busy", "no-answer", "failed", "canceled"].includes(status);
    const amdMachine = answeredBy && answeredBy.includes("machine");
    const amdHuman = answeredBy && answeredBy.includes("human");

    // If AMD says human, do nothing special
    if (amdHuman) return;

    if (statusNoAnswer || amdMachine) {
      await markNoAnswer(call, amdMachine ? "voicemail" : `status_${status}`);
      return;
    }
  } catch (err) {
    console.error("[call-status] error", err);
  }
});

app.post("/call", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    const expected = `Bearer ${CALL_BEARER_TOKEN}`;
    if (!CALL_BEARER_TOKEN || authHeader !== expected) {
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
      cv_id = "",
      resume_url = "",
      from = TWILIO_VOICE_FROM
    } = body;

    const cvSummary = (cv_summary || cv_text || "").trim();

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
      cvId: cv_id || "",
      cvLen: cvSummary.length
    });

    if (!toNorm || !fromNorm) {
      return res.status(400).json({ error: "missing to/from" });
    }
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !PUBLIC_BASE_URL) {
      return res.status(500).json({ error: "twilio or base url not configured" });
    }

    const resolvedAddress = address || resolveAddress(brand, null);

    // Guarda payload para posible recall
    lastCallByNumber.set(toNorm, {
      payload: { to: toNorm, from: fromNorm, brand, role: roleClean, englishRequired: englishReqBool ? "1" : "0", address: resolvedAddress, applicant, cv_summary: cvSummary, cv_id, resume_url },
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
        cv_id,
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
          cv_id,
          resume_url
        },
        { callSid: data.sid, to: toNorm }
      );
      call.from = fromNorm;
      call.expiresAt = Date.now() + CALL_TTL_MS;
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
  const dest = path.join(recordingsDir, `${recordingSid}.mp3`);
  await downloadRecordingWithRetry(`${recordingUrl}.mp3`, dest);
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
    audio_url: call.recordingToken ? `${PUBLIC_BASE_URL}/r/${call.recordingToken}` : "",
    english_required: !!call.englishRequired,
    cv_id: call.cvId || "",
    cv_text: call.cvText || call.cvSummary || ""
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
    source
  };
}

function recordCvEntry(entry) {
  if (!entry || !entry.id) return;
  const existing = cvStoreById.get(entry.id);
  if (existing) {
    Object.assign(existing, entry);
    scheduleCvStoreSave();
    return;
  }
  cvStore.unshift(entry);
  cvStoreById.set(entry.id, entry);
  if (cvStore.length > MAX_CV_STORE) {
    const removed = cvStore.pop();
    if (removed && removed.id) cvStoreById.delete(removed.id);
  }
  scheduleCvStoreSave();
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
    cv_id = "",
    resume_url = ""
  } = data;
  const cvSummary = (cv_summary || cv_text || "").trim();

  const toNorm = normalizePhone(to);
  const fromNorm = normalizePhone(from);
  const roleClean = sanitizeRole(role);
  const englishReqBool = resolveEnglishRequired(brand, roleClean, data);

  if (!toNorm || !fromNorm) throw new Error("missing to/from");
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !PUBLIC_BASE_URL) {
    throw new Error("twilio or base url not configured");
  }

  const resolvedAddress = address || resolveAddress(brand, null);
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
      cv_id,
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
  if (call.recordingToken) {
    try {
      await sendWhatsappMessage({ mediaUrl: `${PUBLIC_BASE_URL}/r/${call.recordingToken}` });
    } catch (err) {
      console.error("[whatsapp] failed sending audio", err);
    }
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

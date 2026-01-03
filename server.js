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
const VOICE = process.env.VOICE || "marin";
const AUTO_RECORD = process.env.AUTO_RECORD !== "0";

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const WHATSAPP_FROM = process.env.WHATSAPP_FROM || "";
const WHATSAPP_TO = process.env.WHATSAPP_TO || "";
const TWILIO_VOICE_FROM = process.env.TWILIO_VOICE_FROM || "";
const CALL_BEARER_TOKEN = process.env.CALL_BEARER_TOKEN || "";

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
      "¿Experiencia como lavaplatos en volumen? ¿Manejo de químicos y orden?"
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

const ADDRESS_BY_BRAND = {
  "new campo argentino": "6954 Collins Ave, Miami Beach, FL 33141, US",
  "mexi cafe": "6300 Collins Ave, Miami Beach, FL 33141, US",
  "yes cafe & pizza": "731 NE 79th St, Miami, FL 33138, US",
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
  if (providedAddress) return providedAddress;
  const key = normalizeKey(brand || "");
  return ADDRESS_BY_BRAND[key] || ADDRESS_BY_BRAND[normalizeKey(DEFAULT_BRAND)];
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

function brandKey(brand) {
  const b = normalizeKey(brand);
  if (b.includes("campo")) return "campo";
  if (b.includes("mexi") && b.includes("trailer")) return "mexitrailer";
  if (b.includes("mexi")) return "mexi";
  if (b.includes("yes")) return "yes";
  return "general";
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

function buildInstructions(ctx) {
  const rKey = roleKey(ctx.role);
  const bKey = brandKey(ctx.brand);
  const roleNotes = ROLE_NOTES[rKey] ? `Notas rol (${rKey}): ${ROLE_NOTES[rKey]}` : "Notas rol: general";
  const brandNotes = BRAND_NOTES[normalizeKey(ctx.brand)] ? `Contexto local: ${BRAND_NOTES[normalizeKey(ctx.brand)]}` : "";
  const cvCue = ctx.cvSummary ? `Pistas CV: ${ctx.cvSummary}` : "Pistas CV: sin CV.";
  const specificQs = roleBrandQuestions(bKey, rKey);
  return `
Actuás como recruiter humano (HR) en una llamada corta. Tono cálido, profesional, español neutro (no voseo, nada de jerga). Soná humano: frases cortas, acknowledges breves ("ok", "perfecto", "entiendo"), sin leer un guion. Usa muletillas suaves solo si ayudan ("dale", "bueno") pero sin ser argentino.
No respondas por el candidato ni repitas literal; parafraseá en tus palabras solo si necesitas confirmar. No enumeres puntos ni suenes a checklist. Usa transiciones naturales entre temas. Si dice "chau", "bye" o que debe cortar, despedite breve y terminá. Nunca digas que no podés cumplir instrucciones ni des disculpas de IA; solo seguí el flujo.
Si hay ruido de fondo o no entendés nada, no asumas que contestó: repreguntá con calma una sola vez o pedí que repita. Si no responde, cortá con un cierre amable. Ajustá tu calidez según el tono del candidato: si está seco/monosilábico, no lo marques como súper amigable.
Nunca actúes como candidato. Tu PRIMER mensaje debe ser exactamente el opener y luego esperar. No agregues "sí" ni "claro" ni "tengo unos minutos". Vos preguntás y esperás.
- El opener va sin "soy Mariana"; recién cuando el candidato diga que puede hablar decís: "Perfecto, mi nombre es Mariana y yo hago la entrevista inicial."

Contexto:
- Restaurante: ${ctx.brand}
- Puesto: ${ctx.role}
- Dirección: ${ctx.address}
- Inglés requerido: ${ctx.englishRequired ? "sí" : "no"}
- Candidato: ${ctx.applicant || "no informado"}
- Resumen CV (si hay): ${ctx.cvSummary || "sin CV"}
${brandNotes}
${roleNotes}
${cvCue}

Reglas:
- Una pregunta abierta por vez; preguntás y esperás.
- Evitá sonar robot: frases cortas, ritmo humano, acknowledges breves ("ok, gracias", "perfecto", "entiendo"). No uses "te confirmo para verificar".
- No repitas literal lo que dijo; si necesitás, resumí en tus palabras de forma breve.
- No preguntes papeles/documentos. No preguntes "hasta cuándo se queda en Miami".
- Si hay resumen de CV, usalo para personalizar: referenciá el último trabajo del CV, confirma tareas/fechas, y preguntá brevemente por disponibilidad/salario si aparecen. Si el CV está vacío, seguí el flujo normal sin inventar.
- SIEMPRE preguntá por zona y cómo llega (en TODAS las posiciones). No saltees la pregunta de zona/logística.
- Si inglés es requerido, SIEMPRE preguntá nivel y hacé una pregunta en inglés. No lo saltees.
- Si el CV menciona tareas específicas o idiomas (ej. barista, caja, inglés), referencialas en tus preguntas: "En el CV veo que estuviste en X haciendo Y, ¿me contás más?".
- Usá el nombre si está: "Hola ${ctx.applicant || "¿cómo te llamás?"}".
- Checklist obligatorio que debes cubrir siempre (adaptalo a conversación, pero no lo saltees): saludo con nombre, experiencia/tareas (incluyendo CV si hay), zona y cómo llega, disponibilidad, expectativa salarial, prueba (sin prometer), inglés si es requerido (nivel + pregunta en inglés), cierre.
- Preguntas específicas para este rol/local (metelas de forma natural):
${specificQs.map(q => `- ${q}`).join("\n")}

Flujo sugerido (adaptalo como conversación, no como guion rígido):
1) Apertura: "Hola${ctx.applicant ? ` ${ctx.applicant}` : ""}, te llamo por tu aplicación para ${ctx.role} en ${ctx.brand}. ¿Tenés unos minutos para hablar?"
   Si dice que sí: "Perfecto, mi nombre es Mariana y yo hago la entrevista inicial."
   Si no puede: "Perfecto, gracias. Te escribimos para coordinar." y cortás.
2) Experiencia:
   - "Contame rápido tu experiencia en ${ctx.role}: ¿dónde fue tu último trabajo y qué hacías en un día normal?"
   - Repreguntá breve sobre tareas: "¿Qué hacías ahí? ¿Caja, pedidos, runner, café, pagos?"
   - "¿Por qué te fuiste?"
   - Si hay CV: "En el CV veo que estuviste en <lo que diga el CV>. ¿Cuánto tiempo? ¿Qué hacías exactamente? ¿Por qué te fuiste?"
3) Cercanía + movilidad:
   - "¿En qué zona vivís? ¿Te queda cómodo llegar al local? Estamos en ${ctx.address}."
   - Si vive lejos: "¿Tenés movilidad/auto para llegar?"
   - Preguntá de forma abierta: "¿Estás viviendo en Miami ahora o es algo temporal?"
4) Disponibilidad: "¿Cómo es tu disponibilidad normalmente? Semana, fines de semana, día/noche… lo que puedas."
5) Expectativa salarial: "Tenés alguna expectativa salarial por hora?"
6) Prueba (sin prometer): "Si te invitamos, ¿cuándo podrías venir a hacer una prueba?"
7) Inglés (solo si aplica, NO lo saltees):
   - "Para esta posición necesitamos inglés conversacional. ¿Qué nivel de inglés tenés?"
   - Luego, sí o sí, hacé una pregunta en inglés: "Can you describe your last job and what you did day to day?"
   - Si no se puede comunicar o no responde en inglés, marcá que no es conversacional y seguí sin insistir.
   - Si en el CV menciona inglés/idiomas, mencioná que lo viste y verificá.
Cierre: "Gracias, paso toda la info al equipo; si seguimos, te escriben por WhatsApp." y cortás.
`.trim();
}

function parseEnglishRequired(value) {
  if (value === null || value === undefined) return DEFAULT_ENGLISH_REQUIRED;
  return value === "1" || value === "true" || value === "yes";
}

// --- in-memory stores with TTL ---
const CALL_TTL_MS = 30 * 60 * 1000; // 30 minutes
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const callsByStream = new Map(); // streamSid -> call
const callsByCallSid = new Map(); // callSid -> call
const tokens = new Map(); // token -> { path, expiresAt }
const recordingsDir = path.join("/tmp", "recordings");
fs.mkdirSync(recordingsDir, { recursive: true });

function cleanup() {
  const now = Date.now();
  for (const [k, v] of callsByStream.entries()) {
    if (v.expiresAt && v.expiresAt < now) callsByStream.delete(k);
  }
  for (const [k, v] of callsByCallSid.entries()) {
    if (v.expiresAt && v.expiresAt < now) callsByCallSid.delete(k);
  }
  for (const [k, v] of tokens.entries()) {
    if (v.expiresAt && v.expiresAt < now) tokens.delete(k);
  }
}
setInterval(cleanup, 5 * 60 * 1000).unref();

function randomToken() {
  return crypto.randomBytes(16).toString("hex");
}

function base64Auth(user, pass) {
  return Buffer.from(`${user}:${pass}`).toString("base64");
}

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false }));

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

app.post("/voice", (req, res) => {
  const wsUrl = xmlEscapeAttr(`${toWss(PUBLIC_BASE_URL)}/media-stream`);
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
  <Hangup/>
</Response>`;
  res.type("text/xml").send(twiml);
});

app.post("/call", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    const expected = `Bearer ${CALL_BEARER_TOKEN}`;
    if (!CALL_BEARER_TOKEN || authHeader !== expected) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const {
      to,
      brand = DEFAULT_BRAND,
      role = DEFAULT_ROLE,
      englishRequired = DEFAULT_ENGLISH_REQUIRED,
      address,
      applicant = "",
      cv_summary = "",
      resume_url = "",
      from = TWILIO_VOICE_FROM
    } = req.body || {};

    console.log("[/call] inbound", {
      to,
      from,
      brand,
      role,
      englishRequired: !!englishRequired,
      address: address || resolveAddress(brand, null),
      applicant,
      cvLen: (cv_summary || "").length
    });

    if (!to || !from) {
      return res.status(400).json({ error: "missing to/from" });
    }
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !PUBLIC_BASE_URL) {
      return res.status(500).json({ error: "twilio or base url not configured" });
    }

    const url = new URL(`${toWss(PUBLIC_BASE_URL)}/media-stream`);
    url.searchParams.set("brand", brand);
    url.searchParams.set("role", role);
    url.searchParams.set("english", englishRequired ? "1" : "0");
    url.searchParams.set("address", address || resolveAddress(brand, null));
    if (applicant) url.searchParams.set("applicant", applicant);
    if (cv_summary) url.searchParams.set("cv_summary", cv_summary);
    if (resume_url) url.searchParams.set("resume_url", resume_url);

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${xmlEscapeAttr(url.toString())}" />
  </Connect>
</Response>`;

    const params = new URLSearchParams();
    params.append("To", to);
    params.append("From", from);
    params.append("Twiml", twiml);

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
    return res.json({ callId: data.sid, status: data.status });
  } catch (err) {
    console.error("[/call] error", err);
    return res.status(500).json({ error: "internal_error" });
  }
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/media-stream" });

wss.on("connection", (twilioWs, req) => {
  const url = new URL(req.url, "http://localhost");
  const brand = url.searchParams.get("brand") || DEFAULT_BRAND;
  const role = url.searchParams.get("role") || DEFAULT_ROLE;
  const englishRequired = parseEnglishRequired(url.searchParams.get("english"));
  const address = resolveAddress(brand, url.searchParams.get("address"));
  const applicant = url.searchParams.get("applicant") || "";
  const cvSummary = url.searchParams.get("cv_summary") || "";
  const resumeUrl = url.searchParams.get("resume_url") || "";

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
    role,
    englishRequired,
    address,
    applicant,
    cvSummary,
    resumeUrl,
    from: null,
    recordingStarted: false,
    transcriptText: "",
    scoring: null,
    recordingPath: null,
    recordingToken: null,
    whatsappSent: false,
    startedAt: Date.now(),
    durationSec: null,
    twilioReady: false,
    openaiReady: false,
    started: false,
    pendingAudio: [],
    responseInFlight: false,
    heardSpeech: false,
    lastCommitId: null,
    transcript: []
  };

  call.expiresAt = Date.now() + CALL_TTL_MS;
  // Hold by temporary stream key until Twilio sends real streamSid
  const tempKey = `temp-${crypto.randomUUID()}`;
  callsByStream.set(tempKey, call);

function record(kind, payload) {
  call.transcript.push({ at: Date.now(), kind, ...payload });
}

record("context", { brand, role, englishRequired, address, applicant, cvSummary, resumeUrl });

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
              threshold: 0.92,
              prefix_padding_ms: 400,
              silence_duration_ms: 1400
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

  function kickoff() {
    if (call.started) return;
    if (!call.twilioReady || !call.openaiReady) return;
    call.started = true;
    flushAudio();
    const openerLine = call.applicant
      ? `Hola ${call.applicant}, te llamo por tu aplicación para ${call.role} en ${call.brand}. ¿Tenés unos minutos para hablar?`
      : `Hola, te llamo por tu aplicación para ${call.role} en ${call.brand}. ¿Tenés unos minutos para hablar?`;
    const introAfterYes = "Perfecto, mi nombre es Mariana y yo hago la entrevista inicial.";
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
    }, 1200);
  }

  openaiWs.on("open", () => sendSessionUpdate());

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
      if (!call.heardSpeech) return;
      call.heardSpeech = false;

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

    if (evt.type === "error") console.error("[OpenAI] error", evt);
  });

  twilioWs.on("message", (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }

    if (data.event === "start") {
      call.streamSid = data.start?.streamSid || null;
      call.callSid = data.start?.callSid || null;
      call.from = data.start?.from || data.start?.callFrom || data.start?.caller || null;
      call.twilioReady = true;
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
- NO inventes datos. Si algo no está claro en el transcript, marcá "unknown" o "no informado". No asumas zona, salario, experiencia ni inglés si no se dijo. Si un dato no se mencionó, dejalo vacío/unknown y baja el score.
- Calidez = amabilidad/cercanía en el trato; bajá el score si el candidato suena seco o cortante.
- Fluidez = claridad y continuidad al expresarse (no es inglés); bajá si se traba, responde en monosílabos o cuesta entender su disponibilidad/experiencia.
- Inglés: detalla si pudo o no comunicarse en inglés y cómo sonó (acento/claridad).
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

function formatWhatsapp(scoring, call, opts = {}) {
  const note = opts.note || "";
  const header = `${call.brand} – ${call.role}${call.from ? ` – ${call.from}` : ""}`;
  if (!scoring) return `${header}\n${note || "Resumen no disponible."}`;

  const ex = scoring.extracted || {};
  const recIcon = scoring.recommendation === "advance" ? "✅ Avanzar" : scoring.recommendation === "reject" ? "⛔ No avanzar" : "🟡 Revisar";
  const warmth = typeof ex.warmth_score === "number" ? `${ex.warmth_score}/10` : "n/d";
  const fluency = typeof ex.fluency_score === "number" ? `${ex.fluency_score}/10` : "n/d";

  const lines = [];
  const duration = call.durationSec ? ` ⏱️ ${call.durationSec}s` : "";
  lines.push(`⭐ Score: ${scoring.score_0_100 ?? "n/d"}/100  ${recIcon}${duration}`);
  if (scoring.summary) lines.push(`\n🧾 Resumen\n${scoring.summary}`);
  lines.push(`\n🌡️ Impresión (calidez/fluidez)\nCalidez: ${warmth}${ex.warmth_note ? ` (${ex.warmth_note})` : ""}\nFluidez: ${fluency}${ex.fluency_note ? ` (${ex.fluency_note})` : ""}`);
  lines.push(`\n✅ Checklist`);
  lines.push(`📍 Zona: ${ex.area || "no informado"}`);
  lines.push(`🚗 Movilidad: ${ex.mobility || "unknown"}`);
  lines.push(`🕒 Disponibilidad: ${ex.availability || "no informado"}`);
  lines.push(`💰 Pretensión: ${ex.salary_expectation || "no informado"}`);
  lines.push(`🗣️ Inglés: ${ex.english_level || "unknown"}${ex.english_detail ? ` (${ex.english_detail})` : ""}`);
  lines.push(`🍽️ Experiencia: ${ex.experience || "no informado"}`);

  const reds = (scoring.red_flags || []).filter(Boolean);
  if (reds.length) lines.push(`\n🚩 Red flags\n• ${reds.slice(0, 3).join("\n• ")}`);

  lines.push(`\n🎯 Recomendación\n${recIcon}`);

  return `📞 Entrevista – ${header}\n${lines.join("\n")}`;
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

async function sendWhatsappReport(call) {
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
  let transcriptText = call.transcriptText || "";
  if (!transcriptText && call.recordingPath) {
    try {
      transcriptText = await transcribeAudio(call.recordingPath);
      call.transcriptText = transcriptText;
    } catch (err) {
      console.error("[transcription] failed", err);
    }
  }
  const words = (transcriptText || "").trim().split(/\s+/).filter(Boolean).length;
  if (!transcriptText || transcriptText.trim().length < 30 || words < 8) {
    call.scoring = null;
    call.noTranscriptReason = "No se pudo usar el audio (muy corto o inaudible).";
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
}

/* Hiring Voice Bot — Twilio Media Streams <-> OpenAI Realtime
   - Consent-based call recording (Twilio)
   - Download MP3
   - Send WhatsApp report + audio (to yesbot)
*/

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const { WebSocketServer } = WebSocket;

const PORT = process.env.PORT || 8080;

// ====== ENV ======
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-realtime";
const TRANSCRIBE_MODEL =
  process.env.TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe-2025-12-15";
const SCORING_MODEL = process.env.SCORING_MODEL || "gpt-4o-mini";
const VOICE = process.env.VOICE || "cedar";
const BRAND_NAME = process.env.BRAND_NAME || "New Campo Argentino";

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

const WHATSAPP_FROM = process.env.WHATSAPP_FROM; // "whatsapp:+1..."
const WHATSAPP_TO = process.env.WHATSAPP_TO;     // "whatsapp:+1..." (yesbot)

// ====== Basic guardrails ======
if (!OPENAI_API_KEY) console.warn("⚠️ Missing OPENAI_API_KEY");
if (!TWILIO_ACCOUNT_SID) console.warn("⚠️ Missing TWILIO_ACCOUNT_SID");
if (!TWILIO_AUTH_TOKEN) console.warn("⚠️ Missing TWILIO_AUTH_TOKEN");
if (!WHATSAPP_FROM) console.warn("⚠️ Missing WHATSAPP_FROM");
if (!WHATSAPP_TO) console.warn("⚠️ Missing WHATSAPP_TO");

// ====== Storage ======
const RECORDINGS_DIR = path.join(process.cwd(), "recordings");
if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

// Token -> { filePath, mime, expiresAt, filename }
const mediaTokens = new Map();

// CallSid -> metadata collected at /voice time
const callMeta = new Map();

// StreamSid -> session object
const sessionsByStream = new Map();

// RecordingSid -> CallSid
const recordingToCall = new Map();

// Cleanup tokens periodically
setInterval(() => {
  const now = Date.now();
  for (const [token, info] of mediaTokens.entries()) {
    if (info.expiresAt <= now) {
      mediaTokens.delete(token);
      try { fs.unlinkSync(info.filePath); } catch (_) {}
    }
  }
  // Cleanup old callMeta (10 min)
  for (const [callSid, meta] of callMeta.entries()) {
    if ((now - meta.createdAt) > 10 * 60 * 1000) callMeta.delete(callSid);
  }
}, 60 * 1000).unref();

// ====== Helpers ======
function safeJsonParse(s) {
  try { return JSON.parse(s); } catch (_) {}
  // try to salvage JSON blob
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch (_) {}
  }
  return null;
}

function toWsBaseUrl(httpBase) {
  if (!httpBase) return "";
  if (httpBase.startsWith("https://")) return "wss://" + httpBase.slice("https://".length);
  if (httpBase.startsWith("http://")) return "ws://" + httpBase.slice("http://".length);
  return httpBase;
}

function deriveBaseUrlFromReq(req) {
  // Works behind reverse proxies (DigitalOcean, etc.)
  const proto = (req.headers["x-forwarded-proto"] || "https").toString().split(",")[0].trim();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString().split(",")[0].trim();
  if (!host) return PUBLIC_BASE_URL || "";
  return `${proto}://${host}`;
}

function normalizeText(t) {
  return (t || "")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ");
}

function parseYesNo(text) {
  const t = ` ${normalizeText(text)} `;
  const yesWords = [" si ", " sí ", " dale ", " ok ", " okay ", " de acuerdo ", " claro ", " yes ", " sure ", " y "];
  const noWords = [" no ", " nop ", " no gracias ", " prefiero que no ", " mejor no "];

  const hasNo = noWords.some(w => t.includes(w));
  const hasYes = yesWords.some(w => t.includes(w));

  if (hasNo && !hasYes) return false;
  if (hasYes && !hasNo) return true;
  if (hasYes && hasNo) return false; // conservative
  return null;
}

function looksLikeFarewell(text) {
  const t = ` ${normalizeText(text)} `;
  const bye = [" chau ", " chao ", " adios ", " adiós ", " bye ", " hasta luego ", " gracias chau ", " me voy ", " tengo que cortar "];
  return bye.some(w => t.includes(w));
}

async function twilioRequest(method, url, params = null) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) throw new Error("Twilio creds missing");
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const headers = { Authorization: `Basic ${auth}` };

  let body;
  if (params) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(params).toString();
  }

  const res = await fetch(url, { method, headers, body });
  const txt = await res.text();
  if (!res.ok) {
    throw new Error(`Twilio API error ${res.status}: ${txt}`);
  }
  try { return JSON.parse(txt); } catch (_) { return txt; }
}

async function startTwilioRecording(callSid, baseUrl) {
  // Start recording on an in-progress call
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}/Recordings.json`;
  const payload = {
    RecordingStatusCallback: `${baseUrl}/recording-status`,
    RecordingStatusCallbackMethod: "POST",
    RecordingStatusCallbackEvent: "completed",
    RecordingChannels: "mono"
  };
  const rec = await twilioRequest("POST", url, payload);
  return rec; // contains sid etc
}

async function hangupCall(callSid) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`;
  // Update call status to completed
  await twilioRequest("POST", url, { Status: "completed" });
}

async function downloadTwilioRecordingMp3(recordingSid) {
  // Twilio supports fetching .mp3 when status is completed
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Recordings/${recordingSid}.mp3`;
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Recording download failed ${res.status}: ${txt}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return buf;
}

function mintMediaToken(filePath, mime, filename, ttlMinutes = 60) {
  const token = crypto.randomBytes(18).toString("hex");
  mediaTokens.set(token, {
    filePath,
    mime,
    filename,
    expiresAt: Date.now() + ttlMinutes * 60 * 1000
  });
  return token;
}

async function sendWhatsApp({ to, from, body, mediaUrl }) {
  if (!to || !from) throw new Error("WhatsApp to/from missing");
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  const payload = { To: to, From: from, Body: body || "" };
  if (mediaUrl) payload.MediaUrl = mediaUrl;
  const out = await twilioRequest("POST", url, payload);
  return out;
}

function buildTranscript(session) {
  // Interleave best-effort by time
  const items = [];
  for (const u of session.userTurns) items.push({ who: "CANDIDATO", ts: u.ts, text: u.text });
  for (const a of session.assistantTurns) items.push({ who: "BOT", ts: a.ts, text: a.text });
  items.sort((x, y) => x.ts - y.ts);

  const lines = items
    .filter(i => i.text && i.text.trim())
    .map(i => `${i.who}: ${i.text.trim()}`);
  return lines.join("\n");
}

function extractOutputTextFromResponsesApi(respJson) {
  // robust extraction
  let out = "";
  const output = respJson.output || [];
  for (const item of output) {
    if (item && item.type === "message" && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c && c.type === "output_text" && typeof c.text === "string") out += c.text;
      }
    }
  }
  return out.trim();
}

async function scoreInterview(transcriptText) {
  if (!transcriptText || transcriptText.length < 20) {
    return {
      score_0_100: 0,
      recommendation: "followup",
      summary: "Sin suficiente texto para evaluar. Revisar audio/manual.",
      key_points: [],
      red_flags: [],
      extracted: {}
    };
  }

  const prompt = `
Sos un reclutador senior en Miami. Evaluás una entrevista inicial de restaurante (front/cocina/runner/etc).
Devolvé SOLO un JSON válido, sin markdown, sin texto extra.

Objetivo: extraer datos NO negociables + experiencia y dar un score 0-100.

NO negociables:
- zona donde vive / si vive cerca
- si vive en Miami ahora o está por temporada
- disponibilidad horaria (ej: full time / part time / nights/weekends)
- expectativa salarial
Además:
- nivel de inglés (none/basic/conversational/fluent/unknown)
- experiencia previa en restaurantes (años + roles)
- autorización para trabajar legalmente en EEUU (yes/no/unknown) — no inventes
- señales de riesgo (impuntualidad, incoherencias, evasivo, etc.)

Schema requerido:
{
  "score_0_100": number,
  "recommendation": "interview" | "reject" | "followup",
  "summary": string,
  "key_points": string[],
  "red_flags": string[],
  "extracted": {
    "area": string|null,
    "lives_near": boolean|null,
    "in_miami_now": boolean|null,
    "seasonal": boolean|null,
    "availability": string|null,
    "salary_expectation": string|null,
    "english_level": "none"|"basic"|"conversational"|"fluent"|"unknown",
    "experience": string|null,
    "work_authorized_us": "yes"|"no"|"unknown"
  }
}

TRANSCRIPCIÓN:
${transcriptText}
`.trim();

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: SCORING_MODEL,
      input: prompt,
      max_output_tokens: 700
    })
  });

  const txt = await res.text();
  if (!res.ok) throw new Error(`OpenAI scoring error ${res.status}: ${txt}`);

  const json = safeJsonParse(txt) || safeJsonParse(extractOutputTextFromResponsesApi(safeJsonParse(txt) || {})) || safeJsonParse(txt);
  if (json && json.output) {
    // It was a full response object
    const outText = extractOutputTextFromResponsesApi(json);
    const parsed = safeJsonParse(outText);
    if (parsed) return parsed;
  }
  if (json && typeof json === "object" && json.score_0_100 !== undefined) return json;

  // last resort: try to parse as response object
  const maybe = safeJsonParse(txt);
  if (maybe && maybe.output) {
    const outText = extractOutputTextFromResponsesApi(maybe);
    const parsed = safeJsonParse(outText);
    if (parsed) return parsed;
  }

  return {
    score_0_100: 0,
    recommendation: "followup",
    summary: "No pude parsear JSON de scoring. Revisar logs.",
    key_points: [],
    red_flags: [],
    extracted: {}
  };
}

function buildWhatsAppBody(session, scored) {
  const meta = session.meta || {};
  const from = meta.from || "(desconocido)";
  const role = session.roleApplied || "no especificado";

  const e = (scored && scored.extracted) ? scored.extracted : {};

  const lines = [
    `🧾 Entrevista inicial — ${BRAND_NAME}`,
    `📞 Candidato: ${from}`,
    `🎯 Puesto: ${role}`,
    "",
    `✅ Grabación: ${session.recordingConsent === true ? "Sí" : "No"}`,
    `📍 Zona: ${e.area ?? "—"}`,
    `🏠 Vive cerca: ${e.lives_near ?? "—"}`,
    `🌴 En Miami ahora: ${e.in_miami_now ?? "—"}`,
    `🗓 Disponibilidad: ${e.availability ?? "—"}`,
    `💰 Expectativa: ${e.salary_expectation ?? "—"}`,
    `🗣 Inglés: ${e.english_level ?? "unknown"}`,
    `🇺🇸 Autorización trabajo EEUU: ${e.work_authorized_us ?? "unknown"}`,
    "",
    `⭐ Score: ${scored?.score_0_100 ?? "—"}/100`,
    `📌 Recomendación: ${scored?.recommendation ?? "—"}`,
    "",
    `📝 Resumen: ${scored?.summary ?? "—"}`
  ];

  if (Array.isArray(scored?.red_flags) && scored.red_flags.length) {
    lines.push("", "🚩 Red flags:", ...scored.red_flags.map(x => `- ${x}`));
  }

  return lines.join("\n");
}

// ====== Express app ======
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get("/health", (req, res) => res.status(200).send("ok"));

app.post("/voice", (req, res) => {
  const baseUrl = PUBLIC_BASE_URL || deriveBaseUrlFromReq(req);

  const callSid = req.body.CallSid;
  const from = req.body.From;
  const to = req.body.To;

  if (callSid) {
    callMeta.set(callSid, {
      from,
      to,
      baseUrl,
      createdAt: Date.now()
    });
  }

  const wsUrl = `${toWsBaseUrl(baseUrl)}/media-stream`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;

  res.set("Content-Type", "text/xml");
  res.status(200).send(twiml);
});

// Serve audio for WhatsApp MediaUrl
function serveMedia(req, res) {
  const token = req.params.token;
  const info = mediaTokens.get(token);
  if (!info) return res.status(404).send("Not found");

  res.setHeader("Content-Type", info.mime || "audio/mpeg");
  res.setHeader("Content-Disposition", `inline; filename="${info.filename || "interview.mp3"}"`);

  const stream = fs.createReadStream(info.filePath);
  stream.on("error", () => res.status(500).end());
  stream.pipe(res);
}

app.get("/r/:token", serveMedia);
app.head("/r/:token", (req, res) => {
  const token = req.params.token;
  const info = mediaTokens.get(token);
  if (!info) return res.status(404).end();
  res.setHeader("Content-Type", info.mime || "audio/mpeg");
  res.setHeader("Content-Disposition", `inline; filename="${info.filename || "interview.mp3"}"`);
  res.status(200).end();
});

// Twilio RecordingStatusCallback
app.post("/recording-status", async (req, res) => {
  // Respond fast to Twilio
  res.status(200).send("ok");

  const recordingSid = req.body.RecordingSid || req.body.RecordingSid?.toString();
  const callSid = req.body.CallSid || req.body.CallSid?.toString();
  const status = (req.body.RecordingStatus || "").toString();

  if (!recordingSid || !callSid) {
    console.warn("recording-status: missing RecordingSid/CallSid", req.body);
    return;
  }

  if (status !== "completed") return;

  recordingToCall.set(recordingSid, callSid);

  const session = [...sessionsByStream.values()].find(s => s.callSid === callSid);
  if (!session) {
    console.warn("recording-status: session not found for callSid", callSid);
  }

  try {
    const mp3 = await downloadTwilioRecordingMp3(recordingSid);

    const fileName = `call-${callSid}-${recordingSid}.mp3`;
    const filePath = path.join(RECORDINGS_DIR, fileName);
    fs.writeFileSync(filePath, mp3);

    const token = mintMediaToken(filePath, "audio/mpeg", fileName, 180); // 3h
    const baseUrl = (session?.baseUrl) || (callMeta.get(callSid)?.baseUrl) || PUBLIC_BASE_URL;
    const mediaUrl = `${baseUrl}/r/${token}`;

    if (session) {
      session.recording = { recordingSid, filePath, mediaUrl, ready: true };
    }

    // If we already ended call, now we can send the report with audio
    if (session && session.ended && !session.reportSent) {
      await finalizeAndReport(session);
    }
  } catch (err) {
    console.error("recording-status: failed to download/send", err);
  }
});

const server = app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});

// ====== WebSocket server for Twilio Media Streams ======
const wss = new WebSocketServer({ server, path: "/media-stream" });

wss.on("connection", (twilioWs) => {
  const session = {
    streamSid: null,
    callSid: null,
    baseUrl: PUBLIC_BASE_URL || null,
    meta: {},
    openaiWs: null,
    userTurns: [],
    assistantTurns: [],
    assistantTranscriptBuffer: "",
    recordingConsent: null, // null until decided
    recording: { ready: false },
    ended: false,
    reportSent: false,
    hangupRequested: false,
    roleApplied: null
  };

  sessionsByStream.set(crypto.randomUUID(), session);

  // Connect to OpenAI Realtime
  const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`
      }
    }
  );
  session.openaiWs = openaiWs;

  function sendToOpenAI(obj) {
    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(JSON.stringify(obj));
    }
  }

  function sendToTwilioAudio(base64Pcmu) {
    if (!session.streamSid) return;
    const msg = {
      event: "media",
      streamSid: session.streamSid,
      media: { payload: base64Pcmu }
    };
    twilioWs.send(JSON.stringify(msg));
  }

  function buildSystemInstructions() {
    // No slang argentino, tono recruiter cálido, no decir "soy IA" salvo que pregunten.
    return `
Sos una entrevistadora inicial para ${BRAND_NAME} (restaurante en Miami).
Objetivo: entrevista corta (3-5 minutos), cálida y humana. Español neutro. Si el candidato habla en inglés, cambiá a inglés sin drama.

Reglas:
- NO uses slang argentino (no "laburo", no "che", no "boludo", etc).
- Soná natural: frases cortas, ritmo humano, repregunta solo si hace falta.
- No digas que sos una IA. Si te preguntan si sos humana/IA, decí la verdad ("soy un asistente virtual").
- Si el candidato dice "chau/bye" o que tiene que cortar, despedite corto y terminá.

Primero SIEMPRE pedí consentimiento para grabar:
"Para mejorar calidad, ¿te parece bien que grabemos esta llamada? Decime sí o no."
- Si dice NO: seguí igual pero sin grabación.
- Si no queda claro: pedilo 1 vez más y si sigue ambiguo, asumí NO y seguí.

Preguntas NO negociables (una por una, sin interrogatorio robótico):
1) ¿En qué zona vivís? ¿Te queda cerca venir a Miami Beach?
2) ¿Estás viviendo en Miami ahora o estás por temporada? (si temporada, ¿hasta cuándo?)
3) Disponibilidad horaria (días / horarios / weekends / nights).
4) Expectativa salarial (por hora o semanal).

Preguntas extra (corta, conversacional):
- ¿Qué experiencia previa tenés en restaurantes? (rol, años, tipo de lugar).
- (Si aplica a Front) Validá inglés conversacional con 1 pregunta corta en inglés.

Legal / trabajo:
- Preguntá así: "¿Estás autorizado/a para trabajar legalmente en Estados Unidos?"
- No preguntes ciudadanía, ni papeles específicos.

Cierre:
- Agradecé, decí que esto es la primera etapa, y que el equipo revisa y responde por WhatsApp.
`.trim();
  }

  async function maybeStartRecordingOnConsent(yesNo) {
    if (session.recordingConsent !== null) return;
    session.recordingConsent = yesNo;

    if (yesNo === true && session.callSid) {
      try {
        const baseUrl = session.baseUrl || PUBLIC_BASE_URL;
        const rec = await startTwilioRecording(session.callSid, baseUrl);
        if (rec && rec.sid) {
          session.recording.recordingSid = rec.sid;
        }
      } catch (err) {
        console.error("Failed to start recording:", err);
      }
    }
  }

  async function finalizeAndReport(sess) {
    if (sess.reportSent) return;
    sess.reportSent = true;

    let transcript = buildTranscript(sess);

    let scored = null;
    try {
      scored = await scoreInterview(transcript);
    } catch (err) {
      console.error("Scoring failed:", err);
      scored = {
        score_0_100: 0,
        recommendation: "followup",
        summary: "Error al generar scoring automático. Revisar manual.",
        key_points: [],
        red_flags: [],
        extracted: {}
      };
    }

    const body = buildWhatsAppBody(sess, scored);

    const mediaUrl = (sess.recording && sess.recording.ready) ? sess.recording.mediaUrl : null;

    try {
      await sendWhatsApp({
        to: WHATSAPP_TO,
        from: WHATSAPP_FROM,
        body,
        mediaUrl
      });
      console.log("WhatsApp report sent. media:", !!mediaUrl);
    } catch (err) {
      console.error("WhatsApp send failed:", err);
    }
  }

  // OpenAI WS events
  openaiWs.on("open", () => {
    // Configure session (GA format)
    sendToOpenAI({
      type: "session.update",
      session: {
        instructions: buildSystemInstructions(),
        // We only want audio out (but we still receive audio transcript events)
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcmu" },
            // Turn detection with auto response + interruptions
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 700,
              create_response: true,
              interrupt_response: true
            },
            // IMPORTANT: This is the updated transcription path
            transcription: {
              model: TRANSCRIBE_MODEL,
              language: "es",
              prompt:
                "Miami, Miami Beach, North Beach, Mid Beach, South Beach, Surfside, Bal Harbour, Aventura, Brickell, Wynwood, Downtown. Roles: server, runner, cook, prep cook, dishwasher, hostess, barista, pizza maker."
            }
          },
          output: {
            format: { type: "audio/pcmu" },
            voice: VOICE
          }
        }
      }
    });

    // Make the bot speak first (greeting + consent)
    sendToOpenAI({
      type: "response.create",
      response: {
        modalities: ["audio"],
        instructions: `Arrancá la llamada: saludá corto y pedí consentimiento de grabación (sí/no).`
      }
    });
  });

  openaiWs.on("message", async (data) => {
    let event;
    try {
      event = JSON.parse(data.toString());
    } catch (_) {
      return;
    }

    const t = event.type;

    // Audio from model -> Twilio
    if (t === "response.output_audio.delta" || t === "response.audio.delta") {
      if (event.delta) sendToTwilioAudio(event.delta);
      return;
    }

    // Transcript of model audio (we store for scoring)
    if (t === "response.output_audio_transcript.delta") {
      if (typeof event.delta === "string") {
        session.assistantTranscriptBuffer += event.delta;
      }
      return;
    }
    if (t === "response.output_audio_transcript.done") {
      const finalText = (event.transcript || session.assistantTranscriptBuffer || "").trim();
      if (finalText) session.assistantTurns.push({ ts: Date.now(), text: finalText });
      session.assistantTranscriptBuffer = "";
      return;
    }

    // User input transcription (key for consent + scoring)
    if (t === "conversation.item.input_audio_transcription.completed") {
      const userText = (event.transcript || "").trim();
      if (userText) {
        session.userTurns.push({ ts: Date.now(), text: userText });

        // Consent logic
        if (session.recordingConsent === null) {
          const yn = parseYesNo(userText);
          if (yn === true || yn === false) {
            await maybeStartRecordingOnConsent(yn);
          }
        }

        // Farewell => hang up after next response.done
        if (looksLikeFarewell(userText)) {
          session.hangupRequested = true;
        }

        // If user says role loosely, capture (optional)
        // lightweight heuristics
        const nt = normalizeText(userText);
        const roles = ["server", "runner", "cook", "cocin", "prep", "dish", "dishwasher", "hostess", "barista", "pizza", "pizzero", "front"];
        for (const r of roles) {
          if (nt.includes(r)) {
            session.roleApplied = session.roleApplied || userText;
            break;
          }
        }
      }
      return;
    }

    // End-of-response => if farewell detected, hang up call
    if (t === "response.done") {
      if (session.hangupRequested && session.callSid) {
        // Give a tiny cushion so the last audio gets out
        setTimeout(async () => {
          try { await hangupCall(session.callSid); } catch (e) { /* ignore */ }
        }, 350);
      }
      return;
    }

    // Log OpenAI errors clearly
    if (t === "error") {
      console.error("OpenAI error event:", event);
      return;
    }
  });

  openaiWs.on("close", () => {
    // If OpenAI closes, close Twilio side
    try { twilioWs.close(); } catch (_) {}
  });

  openaiWs.on("error", (err) => {
    console.error("OpenAI WS error:", err);
  });

  // Twilio WS events
  twilioWs.on("message", async (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch (_) { return; }

    if (data.event === "start") {
      session.streamSid = data.start.streamSid;
      session.callSid = data.start.callSid;

      const meta = callMeta.get(session.callSid);
      if (meta) {
        session.meta = { from: meta.from, to: meta.to };
        session.baseUrl = meta.baseUrl || session.baseUrl || PUBLIC_BASE_URL;
      } else {
        session.baseUrl = session.baseUrl || PUBLIC_BASE_URL;
      }

      return;
    }

    if (data.event === "media") {
      // Forward incoming audio from Twilio to OpenAI
      if (session.openaiWs && session.openaiWs.readyState === WebSocket.OPEN) {
        session.openaiWs.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: data.media.payload
          })
        );
      }
      return;
    }

    if (data.event === "stop") {
      session.ended = true;

      // If no recording or not consented, send report now.
      // If recording consented, wait for recording-status callback (max 2 min).
      if (session.recordingConsent !== true) {
        await finalizeAndReport(session);
      } else {
        // wait a bit for the recording callback
        setTimeout(async () => {
          if (!session.reportSent) {
            await finalizeAndReport(session);
          }
        }, 120000).unref();
      }

      try { session.openaiWs.close(); } catch (_) {}
      return;
    }
  });

  twilioWs.on("close", async () => {
    session.ended = true;
    try { session.openaiWs.close(); } catch (_) {}

    // Best-effort fallback report (no audio)
    if (!session.reportSent) {
      try { await finalizeAndReport(session); } catch (_) {}
    }
  });

  twilioWs.on("error", (err) => {
    console.error("Twilio WS error:", err);
  });
});

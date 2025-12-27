/* server.js - Twilio <Connect><Stream> <-> OpenAI Realtime + Recording -> WhatsApp
   Fixes:
   - No "silent call": waits for Twilio start(streamSid) + OpenAI session.updated before greeting
   - Buffers audio until streamSid exists
   - Barge-in: Twilio clear + OpenAI response.cancel on speech_started
   - Recording consent via tool-calling (no fragile realtime transcription config)
*/

require("dotenv").config();

const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const twilio = require("twilio");
const WebSocket = require("ws");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 8080);

// REQUIRED
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, ""); // e.g. https://your-app.ondigitalocean.app
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// OPTIONAL / RECOMMENDED
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-realtime";
const OPENAI_VOICE = process.env.OPENAI_VOICE || "marin"; // OpenAI recommends marin/cedar for best quality  [oai_citation:2‡OpenAI Platform](https://platform.openai.com/docs/guides/realtime-conversations)
const TEMPERATURE = Number(process.env.TEMPERATURE || 0.7);

// Twilio (required for recording + WhatsApp)
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

// WhatsApp via Twilio
const WHATSAPP_FROM = process.env.WHATSAPP_FROM; // e.g. "whatsapp:+14155238886" (sandbox) or your WA-enabled number
const WHATSAPP_TO = process.env.WHATSAPP_TO;     // e.g. "whatsapp:+17866450967" (your yesbot)

function must(name, val) {
  if (!val) throw new Error(`Missing env var: ${name}`);
}

must("PUBLIC_BASE_URL", PUBLIC_BASE_URL);
must("OPENAI_API_KEY", OPENAI_API_KEY);

// Twilio client only if credentials exist (so the voice bot can still run without WhatsApp)
const hasTwilio = !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN);
const twilioClient = hasTwilio ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

const app = express();
app.use(express.urlencoded({ extended: false })); // Twilio webhooks are form-encoded
app.use(express.json());

// --- In-memory stores (OK for low volume tests) ---
const sessionsByConn = new Map();     // wsConnection -> session
const sessionsByCallSid = new Map();  // callSid -> session
const recordingsByToken = new Map();  // token -> { filePath, mime, expiresAt }

// Cleanup old recordings (best-effort)
setInterval(() => {
  const now = Date.now();
  for (const [token, rec] of recordingsByToken.entries()) {
    if (rec.expiresAt <= now) {
      try { fs.unlinkSync(rec.filePath); } catch {}
      recordingsByToken.delete(token);
    }
  }
}, 60_000).unref();

function toWsUrl(httpUrl) {
  if (httpUrl.startsWith("https://")) return "wss://" + httpUrl.slice("https://".length);
  if (httpUrl.startsWith("http://")) return "ws://" + httpUrl.slice("http://".length);
  return httpUrl;
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function basicAuthHeader(user, pass) {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

function mintToken() {
  return crypto.randomBytes(16).toString("hex");
}

function nowIso() {
  return new Date().toISOString();
}

// ---------- TwiML: incoming call webhook ----------
app.post("/voice", (req, res) => {
  // IMPORTANT: bidirectional stream uses <Connect><Stream>  [oai_citation:3‡Twilio](https://www.twilio.com/docs/voice/media-streams)
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  const connect = twiml.connect();
  connect.stream({
    url: `${toWsUrl(PUBLIC_BASE_URL)}/media-stream`,
    track: "inbound_track",
  });

  // Once our server closes the websocket, Twilio continues and hangs up.
  twiml.hangup();

  res.type("text/xml").send(twiml.toString());
});

// Serve recording files for WhatsApp mediaUrl (public, random token)
app.get("/r/:token", (req, res) => {
  const rec = recordingsByToken.get(req.params.token);
  if (!rec) return res.status(404).send("Not found");
  res.setHeader("Content-Type", rec.mime);
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(rec.filePath);
});

// Recording status callback from Twilio
app.post("/recording-status", async (req, res) => {
  // Respond fast, process async
  res.status(200).send("ok");

  if (!hasTwilio) return;

  const callSid = req.body.CallSid;
  const recordingSid = req.body.RecordingSid;
  const recordingUrl = req.body.RecordingUrl; // usually without extension
  const status = (req.body.RecordingStatus || "").toLowerCase();

  if (!callSid || !recordingSid || !recordingUrl) return;
  if (status && status !== "completed") return;

  const session = sessionsByCallSid.get(callSid);

  try {
    const mp3Path = path.join(os.tmpdir(), `call_${callSid}_${recordingSid}.mp3`);
    await downloadTwilioRecordingMp3WithRetry(recordingUrl, mp3Path);

    const token = mintToken();
    recordingsByToken.set(token, {
      filePath: mp3Path,
      mime: "audio/mpeg",
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    const mediaUrl = `${PUBLIC_BASE_URL}/r/${token}`;

    // Build a compact report
    const summary = session?.candidateSummary || null;
    const scoreLine = summary?.score_0_10 != null ? `Score: ${summary.score_0_10}/10` : "Score: (pendiente)";
    const roleLine = summary?.role ? `Puesto: ${summary.role}` : "";
    const localLine = summary?.local ? `Local: ${summary.local}` : "";
    const payLine = summary?.salary_expectation ? `Expectativa: ${summary.salary_expectation}` : "";
    const availLine = summary?.availability ? `Disponibilidad: ${summary.availability}` : "";
    const areaLine = summary?.location_area ? `Zona: ${summary.location_area}` : "";
    const engLine = summary?.english_level ? `Inglés: ${summary.english_level}` : "";

    const header = `Entrevista telefónica (${nowIso()})`;
    const body =
      [header, localLine, roleLine, areaLine, availLine, payLine, engLine, scoreLine, summary?.notes ? `Notas: ${summary.notes}` : ""]
        .filter(Boolean)
        .join("\n");

    // Send WhatsApp (to yesbot), with audio attached
    if (WHATSAPP_FROM && WHATSAPP_TO) {
      await twilioClient.messages.create({
        from: WHATSAPP_FROM,
        to: WHATSAPP_TO,
        body,
        mediaUrl: [mediaUrl],
      });
      console.log(`[WA] Sent report + audio to ${WHATSAPP_TO} (callSid=${callSid})`);
    } else {
      console.log("[WA] WHATSAPP_FROM/WHATSAPP_TO not set. Audio URL:", mediaUrl);
    }
  } catch (err) {
    console.error("[Recording] Failed to process recording:", err);
  }
});

// ----------- Health ----------
app.get("/health", (req, res) => res.json({ ok: true }));

// ---------- HTTP + WS server ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/media-stream" });

// ----------- OpenAI system prompt (neutral Spanish, no slang) -----------
const SYSTEM_MESSAGE = `
Sos "Mariana", entrevistadora inicial para restaurantes en Miami Beach.
Objetivo: entrevista corta (3-5 min), cálida y humana, sin sonar robótica.

Reglas de conversación:
- Habla en español neutro (sin modismos argentinos tipo "laburo").
- 1 pregunta por vez. Después de preguntar, callate y esperá la respuesta.
- No repitas lo mismo en loop. Si no entendés, pedí repetir UNA sola vez y seguí.
- No digas que sos IA.
- Si la persona dice "chau", "gracias", "no me interesa", o se quiere ir: despedite y llamá a end_call.
- Si la persona no puede hablar ahora: pedí un horario para volver a llamar, guardalo en notes, y end_call.

Flujo:
1) Saludo breve: "Hola, te llamo por tu postulación. ¿Preferís seguir en español o en inglés?"
2) "¿Tenés 3 minutos para una entrevista rápida ahora?"
3) Consentimiento de grabación (legal y simple):
   "Para compartir el resultado con el equipo, ¿autorizás que esta llamada se grabe? Podés decir 'sí' o 'no'."
   Cuando detectes la respuesta, llamá a set_recording_consent(consented: true/false).

4) Preguntas no negociables (obligatorias):
   - Zona donde vive / si vive cerca del local
   - Si está viviendo en Miami o es por temporada (y hasta cuándo)
   - Disponibilidad horaria
   - Expectativa salarial (por hora)

5) Extra (muy importante):
   - Experiencia previa en el puesto (años, tipo de lugares)
   - Para roles de atención al público: validar inglés conversacional (preguntar si puede atender en inglés y pedir una mini frase/ejemplo).
   - Pregunta legal correcta (sin detalles): "¿Estás autorizado/a para trabajar en Estados Unidos? (sí/no)"

Cierre:
- Agradecé, decí que el equipo revisa y que lo contactan.
- Antes de cortar, llamá a submit_candidate_summary con los datos.
- Luego llamá a end_call.

Formato de submit_candidate_summary:
- local (si lo mencionó)
- role (si lo mencionó)
- location_area
- in_miami_or_season (texto corto)
- availability
- salary_expectation
- english_level
- work_authorization (yes/no/unsure)
- notes (corto, útil)
- score_0_10 (0-10)
`;

const TOOLS = [
  {
    type: "function",
    name: "set_recording_consent",
    description: "Set recording consent (true/false) when the candidate answers the recording question.",
    parameters: {
      type: "object",
      properties: {
        consented: { type: "boolean" },
      },
      required: ["consented"],
    },
  },
  {
    type: "function",
    name: "submit_candidate_summary",
    description: "Submit a structured summary of the candidate interview for WhatsApp report + scoring.",
    parameters: {
      type: "object",
      properties: {
        local: { type: "string" },
        role: { type: "string" },
        location_area: { type: "string" },
        in_miami_or_season: { type: "string" },
        availability: { type: "string" },
        salary_expectation: { type: "string" },
        english_level: { type: "string" },
        work_authorization: { type: "string", enum: ["yes", "no", "unsure"] },
        notes: { type: "string" },
        score_0_10: { type: "number" },
      },
      required: ["location_area", "availability", "salary_expectation", "score_0_10"],
    },
  },
  {
    type: "function",
    name: "end_call",
    description: "End the call now.",
    parameters: { type: "object", properties: {} },
  },
];

// ----------- WS: Twilio <-> OpenAI -----------
wss.on("connection", (twilioConn) => {
  console.log("[TwilioWS] connected");

  const session = {
    createdAt: Date.now(),
    streamSid: null,
    callSid: null,
    twilioConn,
    openaiWs: null,

    twilioReady: false,
    openaiReady: false,
    greeted: false,

    pendingAudioDeltas: [],
    lastClearAt: 0,

    recordingConsent: null,
    recordingStarted: false,

    candidateSummary: null,
  };

  sessionsByConn.set(twilioConn, session);

  // Connect to OpenAI Realtime
  const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}&temperature=${encodeURIComponent(TEMPERATURE)}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
    }
  );
  session.openaiWs = openaiWs;

  function sendToTwilioAudio(deltaBase64) {
    // Twilio requires audio/x-mulaw 8000, base64, no headers  [oai_citation:4‡Twilio](https://www.twilio.com/docs/voice/media-streams/websocket-messages)
    if (!session.streamSid) {
      // Buffer until we have streamSid
      if (session.pendingAudioDeltas.length < 400) session.pendingAudioDeltas.push(deltaBase64);
      return;
    }
    const payload = Buffer.from(deltaBase64, "base64").toString("base64"); // normalize base64 like Twilio's sample  [oai_citation:5‡Twilio](https://www.twilio.com/en-us/blog/voice-ai-assistant-openai-realtime-api-node)
    session.twilioConn.send(
      JSON.stringify({
        event: "media",
        streamSid: session.streamSid,
        media: { payload },
      })
    );
  }

  function flushPendingAudio() {
    if (!session.streamSid) return;
    if (!session.pendingAudioDeltas.length) return;
    for (const d of session.pendingAudioDeltas) sendToTwilioAudio(d);
    session.pendingAudioDeltas = [];
  }

  async function startRecordingIfNeeded() {
    if (!hasTwilio) return;
    if (!session.callSid) return;
    if (session.recordingStarted) return;
    if (session.recordingConsent !== true) return;

    try {
      session.recordingStarted = true;
      // Start call recording; status callback will send audio to WhatsApp
      await twilioClient.calls(session.callSid).recordings.create({
        recordingStatusCallback: `${PUBLIC_BASE_URL}/recording-status`,
        recordingStatusCallbackEvent: ["completed"],
      });
      console.log(`[Recording] started (callSid=${session.callSid})`);
    } catch (e) {
      console.error("[Recording] start failed:", e);
      session.recordingStarted = false;
    }
  }

  function maybeGreet() {
    if (session.greeted) return;
    if (!session.twilioReady) return;
    if (!session.openaiReady) return;

    session.greeted = true;
    flushPendingAudio();

    // Kick off conversation (text input -> audio output)
    const kickoff = {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Arrancá la entrevista ahora siguiendo el flujo. Recordá: 1 pregunta por vez y esperá la respuesta.",
          },
        ],
      },
    };

    openaiWs.send(JSON.stringify(kickoff));
    openaiWs.send(JSON.stringify({ type: "response.create" }));
    console.log("[Flow] greeted");
  }

  function sendSessionUpdate() {
    // Note: This matches the pattern used in Twilio's Realtime + Media Streams guide (pcmu).  [oai_citation:6‡Twilio](https://www.twilio.com/en-us/blog/voice-ai-assistant-openai-realtime-api-node)
    const sessionUpdate = {
      type: "session.update",
      session: {
        type: "realtime",
        model: OPENAI_MODEL,
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcmu" },
            turn_detection: {
              type: "server_vad",
              create_response: true,
              interrupt_response: true,
            },
          },
          output: {
            format: { type: "audio/pcmu" },
            voice: OPENAI_VOICE,
          },
        },
        instructions: SYSTEM_MESSAGE,
        tools: TOOLS,
        tool_choice: "auto",
      },
    };
    openaiWs.send(JSON.stringify(sessionUpdate));
  }

  function sendToolOutput(callId, outputObj) {
    openaiWs.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify(outputObj || {}),
        },
      })
    );
    // Let the model continue
    openaiWs.send(JSON.stringify({ type: "response.create" }));
  }

  async function handleFunctionCall(item) {
    const name = item.name;
    const callId = item.call_id || item.callId;
    const args = safeJsonParse(item.arguments) || {};

    if (!name || !callId) return;

    if (name === "set_recording_consent") {
      session.recordingConsent = !!args.consented;
      console.log("[Tool] set_recording_consent =", session.recordingConsent);
      sendToolOutput(callId, { ok: true, consented: session.recordingConsent });

      if (session.recordingConsent === true) {
        await startRecordingIfNeeded();
      }
      return;
    }

    if (name === "submit_candidate_summary") {
      session.candidateSummary = args;
      console.log("[Tool] submit_candidate_summary", args);
      sendToolOutput(callId, { ok: true });

      // If no recording consent, we can still send a text-only WhatsApp report now
      if (hasTwilio && WHATSAPP_FROM && WHATSAPP_TO && session.recordingConsent === false) {
        const body =
          [
            `Entrevista (sin grabación) (${nowIso()})`,
            args.local ? `Local: ${args.local}` : "",
            args.role ? `Puesto: ${args.role}` : "",
            args.location_area ? `Zona: ${args.location_area}` : "",
            args.availability ? `Disponibilidad: ${args.availability}` : "",
            args.salary_expectation ? `Expectativa: ${args.salary_expectation}` : "",
            args.english_level ? `Inglés: ${args.english_level}` : "",
            args.work_authorization ? `Work authorization: ${args.work_authorization}` : "",
            args.score_0_10 != null ? `Score: ${args.score_0_10}/10` : "",
            args.notes ? `Notas: ${args.notes}` : "",
          ]
            .filter(Boolean)
            .join("\n");

        try {
          await twilioClient.messages.create({
            from: WHATSAPP_FROM,
            to: WHATSAPP_TO,
            body,
          });
          console.log("[WA] Sent text-only report (no recording).");
        } catch (e) {
          console.error("[WA] Failed to send text-only report:", e);
        }
      }

      return;
    }

    if (name === "end_call") {
      console.log("[Tool] end_call");
      sendToolOutput(callId, { ok: true });

      // Hard hangup to avoid “chau” but call never ends
      try {
        if (hasTwilio && session.callSid) {
          await twilioClient.calls(session.callSid).update({ status: "completed" });
        } else {
          // fallback: close stream
          twilioConn.close();
        }
      } catch (e) {
        console.error("[Call] hangup failed:", e);
        try { twilioConn.close(); } catch {}
      }
      return;
    }

    // Unknown tool
    sendToolOutput(callId, { ok: false, error: "unknown_tool" });
  }

  // OpenAI socket lifecycle
  openaiWs.on("open", () => {
    console.log("[OpenAIWS] connected");
    // Tiny delay improves stability (same tactic used in Twilio examples)  [oai_citation:7‡Twilio](https://www.twilio.com/en-us/blog/voice-ai-assistant-openai-realtime-api-node)
    setTimeout(sendSessionUpdate, 250);
  });

  openaiWs.on("message", async (raw) => {
    let evt;
    try {
      evt = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (evt.type === "session.updated") {
      session.openaiReady = true;
      maybeGreet();
      return;
    }

    // Barge-in: when user starts speaking, cancel current assistant output + clear Twilio buffer
    if (evt.type === "input_audio_buffer.speech_started") {
      const now = Date.now();
      if (session.streamSid && now - session.lastClearAt > 400) {
        session.lastClearAt = now;
        try {
          twilioConn.send(JSON.stringify({ event: "clear", streamSid: session.streamSid }));
        } catch {}
        try {
          openaiWs.send(JSON.stringify({ type: "response.cancel" }));
        } catch {}
      }
      return;
    }

    // Audio back to Twilio
    if ((evt.type === "response.output_audio.delta" || evt.type === "response.audio.delta") && evt.delta) {
      sendToTwilioAudio(evt.delta);
      return;
    }

    // Tool calling results arrive in response.done output items  [oai_citation:8‡OpenAI Platform](https://platform.openai.com/docs/guides/realtime-conversations)
    if (evt.type === "response.done" && evt.response?.output?.length) {
      for (const out of evt.response.output) {
        if (out?.type === "function_call") {
          await handleFunctionCall(out);
        }
      }
      return;
    }

    // If you want more observability, uncomment:
    // if (evt.type && evt.type.startsWith("error")) console.error("[OpenAI] error event", evt);
  });

  openaiWs.on("error", (e) => console.error("[OpenAIWS] error", e));
  openaiWs.on("close", () => console.log("[OpenAIWS] closed"));

  // Twilio -> server messages
  twilioConn.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      return;
    }

    if (data.event === "start") {
      session.streamSid = data.start?.streamSid || null;
      session.callSid = data.start?.callSid || null;
      session.twilioReady = true;

      if (session.callSid) sessionsByCallSid.set(session.callSid, session);

      console.log("[TwilioWS] start", { streamSid: session.streamSid, callSid: session.callSid });
      maybeGreet();
      flushPendingAudio();
      return;
    }

    if (data.event === "media") {
      // Send caller audio to OpenAI
      if (openaiWs.readyState === WebSocket.OPEN && data.media?.payload) {
        openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: data.media.payload }));
      }
      return;
    }

    if (data.event === "stop") {
      console.log("[TwilioWS] stop");
      try { twilioConn.close(); } catch {}
      return;
    }
  });

  twilioConn.on("close", () => {
    sessionsByConn.delete(twilioConn);
    if (session.callSid) sessionsByCallSid.delete(session.callSid);
    try { if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close(); } catch {}
    console.log("[TwilioWS] closed");
  });
});

// ---- Download recording from Twilio (with auth + retry) ----
async function downloadTwilioRecordingMp3WithRetry(recordingUrlNoExt, destPath) {
  if (!hasTwilio) throw new Error("Twilio creds missing");

  const url = `${recordingUrlNoExt}.mp3`;
  const auth = basicAuthHeader(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

  const attempts = 10;
  let lastErr = null;

  for (let i = 1; i <= attempts; i++) {
    try {
      const resp = await fetch(url, { headers: { Authorization: auth } });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);

      const buf = Buffer.from(await resp.arrayBuffer());
      // Guardrail: avoid writing tiny/empty files
      if (buf.length < 10_000) throw new Error(`Recording too small (${buf.length} bytes), not ready yet`);

      fs.writeFileSync(destPath, buf);
      console.log(`[Recording] downloaded mp3 (${buf.length} bytes) attempt ${i}`);
      return;
    } catch (e) {
      lastErr = e;
      // wait a bit, Twilio sometimes needs time to finalize
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  throw lastErr || new Error("Failed to download recording");
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on ${PORT}`);
});

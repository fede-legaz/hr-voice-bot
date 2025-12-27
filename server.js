"use strict";

const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-realtime";
const VOICE = process.env.VOICE || "cedar";

if (!PUBLIC_BASE_URL) { console.error("Missing PUBLIC_BASE_URL"); process.exit(1); }
if (!OPENAI_API_KEY) { console.error("Missing OPENAI_API_KEY"); process.exit(1); }

function toWss(httpUrl) {
  if (httpUrl.startsWith("https://")) return "wss://" + httpUrl.slice("https://".length);
  if (httpUrl.startsWith("http://")) return "ws://" + httpUrl.slice("http://".length);
  return httpUrl;
}

function normalize(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

const ADDRESSES = {
  "New Campo Argentino": "6954 Collins Ave, Miami Beach, FL 33141",
  "Mexi Cafe": "6300 Collins Ave, Miami Beach, FL 33141",
  "Yes Cafe & Pizza": "731 NE 79th St, Miami, FL 33138",
  "Yes! Cafe – Miami Beach": "601 71st St, Miami Beach, FL 33141",
  "Mexi Trailer": "731 NE 79th St, Miami, FL 33138"
};

function getAddress(brand) {
  return ADDRESSES[brand] || ADDRESSES["New Campo Argentino"];
}

// Defaults
const DEFAULT_BRAND = "New Campo Argentino";
const DEFAULT_ROLE = "Server/Runner";
const DEFAULT_ENGLISH_REQUIRED = true;

// ---- SINGLE app instance ----
const app = express();
app.use(express.urlencoded({ extended: false }));

app.get("/health", (req, res) => res.status(200).send("ok"));

app.post("/voice", (req, res) => {
  const wsUrl = `${toWss(PUBLIC_BASE_URL)}/media-stream`;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
  <Hangup/>
</Response>`;
  res.type("text/xml").send(twiml);
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/media-stream" });

wss.on("connection", (twilioWs, req) => {
  const url = new URL(req.url, "http://localhost");
  const brand = url.searchParams.get("brand") || DEFAULT_BRAND;
  const role = url.searchParams.get("role") || DEFAULT_ROLE;
  const englishRequired = (url.searchParams.get("english") || (DEFAULT_ENGLISH_REQUIRED ? "1" : "0")) === "1";
  const address = url.searchParams.get("address") || getAddress(brand);

  const state = {
    streamSid: null,
    callSid: null,
    twilioReady: false,
    openaiReady: false,
    started: false,
    pendingAudio: [],
    responseInFlight: false,
    heardSpeech: false,
    lastCommitId: null,
    brand,
    role,
    englishRequired,
    address,
  };

  const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`,
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
  );

  function sendAudioToTwilio(deltaB64) {
    if (!state.streamSid) {
      if (state.pendingAudio.length < 600) state.pendingAudio.push(deltaB64);
      return;
    }
    const buf = Buffer.from(deltaB64, "base64");
    const frame = 160;
    for (let i = 0; i < buf.length; i += frame) {
      const chunk = buf.subarray(i, i + frame);
      twilioWs.send(JSON.stringify({
        event: "media",
        streamSid: state.streamSid,
        media: { payload: chunk.toString("base64") }
      }));
    }
  }

  function flushAudio() {
    if (!state.streamSid) return;
    for (const d of state.pendingAudio) sendAudioToTwilio(d);
    state.pendingAudio = [];
  }

  function sessionUpdate() {
    openaiWs.send(JSON.stringify({
      type: "session.update",
      session: {
        type: "realtime",
        model: OPENAI_MODEL,
        output_modalities: ["audio"],
        instructions: `
Actuás como recruiter humano (HR) haciendo una llamada corta.
Tono: cálido, profesional, español neutro. Evitá listas de sí/no.

Contexto fijo:
- Restaurante: ${state.brand}
- Puesto: ${state.role}
- Dirección: ${state.address}
- Inglés requerido: ${state.englishRequired ? "sí" : "no"}

Reglas:
- 1 pregunta por vez. Preguntás y te callás.
- No te respondas sola.
- Si el candidato dice que tiene que cortar: despedite breve y terminá.
- No preguntes "hasta cuándo se queda en Miami". No preguntes papeles.

Flujo (conversación, no checklist):
1) Inicio: "Hola, soy Mariana, te llamo de ${state.brand}. Te llamo por tu aplicación para ${state.role}. ¿Te viene bien hablar 3 minutos ahora?"
2) Experiencia (2 preguntas abiertas):
   - "Contame tu experiencia en ${state.role}: ¿dónde fue tu último trabajo y qué hacías en un día normal?"
   - "¿Por qué te fuiste?"
3) Logística (una pregunta abierta):
   - "¿En qué zona vivís y cómo es tu disponibilidad esta semana y fines de semana? ¿Día/noche?"
   Si vive lejos: "¿Tenés movilidad/auto para llegar?"
   Si no conoce: "Estamos en ${state.address}."
   Si es temporal: solo "¿Estás viviendo en Miami ahora o es algo temporal?"
4) Salario:
   - "¿En qué número estás pensando por hora, más o menos?"
5) Prueba:
   - "¿Cuándo podrías venir a hacer una prueba?"
6) Inglés (solo si aplica):
   - "What did you do in your last job?"
   Si no entiende: "Can you tell me your availability in English?"
   Si falla: seguí sin insistir.
7) Cierre: agradecé y decí que lo contactan por WhatsApp.
`.trim(),
        audio: {
          input: {
            format: { type: "audio/pcmu" },
            turn_detection: {
              type: "server_vad",
              create_response: false,
              interrupt_response: true,
              threshold: 0.70,
              prefix_padding_ms: 200,
              silence_duration_ms: 900
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
    if (state.started) return;
    if (!state.twilioReady || !state.openaiReady) return;

    state.started = true;
    flushAudio();

    openaiWs.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text:
            `Decí EXACTO esto y después callate: ` +
            `"Hola, soy Mariana, te llamo de ${state.brand}. Te llamo por tu aplicación para ${state.role}. ` +
            `¿Te viene bien hablar 3 minutos ahora?"`
        }]
      }
    }));

    openaiWs.send(JSON.stringify({ type: "response.create" }));
    state.responseInFlight = true;
  }

  openaiWs.on("open", () => sessionUpdate());

  openaiWs.on("message", (raw) => {
    let evt;
    try { evt = JSON.parse(raw.toString()); } catch { return; }

    if (evt.type === "session.updated") {
      state.openaiReady = true;
      kickoff();
      return;
    }

    if (evt.type === "input_audio_buffer.speech_started") {
      state.heardSpeech = true;
      try { openaiWs.send(JSON.stringify({ type: "response.cancel" })); } catch {}
      if (state.streamSid) {
        try { twilioWs.send(JSON.stringify({ event: "clear", streamSid: state.streamSid })); } catch {}
      }
      state.responseInFlight = false;
      return;
    }

    if ((evt.type === "response.output_audio.delta" || evt.type === "response.audio.delta") && evt.delta) {
      sendAudioToTwilio(evt.delta);
      return;
    }

    if (evt.type === "input_audio_buffer.committed") {
      if (!state.heardSpeech) return;
      state.heardSpeech = false;

      const commitId = evt.item_id || null;
      if (commitId && commitId === state.lastCommitId) return;
      state.lastCommitId = commitId;

      if (!state.responseInFlight) {
        openaiWs.send(JSON.stringify({ type: "response.create" }));
        state.responseInFlight = true;
      }
      return;
    }

    if (evt.type === "response.done") {
      state.responseInFlight = false;
      return;
    }

    if (evt.type === "error") console.error("[OpenAI] error", evt);
  });

  twilioWs.on("message", (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }

    if (data.event === "start") {
      state.streamSid = data.start?.streamSid || null;
      state.callSid = data.start?.callSid || null;
      state.twilioReady = true;
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
      try { openaiWs.close(); } catch {}
      try { twilioWs.close(); } catch {}
    }
  });

  twilioWs.on("close", () => {
    try { if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close(); } catch {}
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on ${PORT}`);
});

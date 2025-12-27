"use strict";

const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT || 8080);

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, ""); // https://xxx.ondigitalocean.app
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-realtime";
const VOICE = process.env.VOICE || "marin";

// Default (si no pasás nada por URL)
const DEFAULT_BRAND = "New Campo Argentino";
const DEFAULT_ROLE = "Server/Runner";
const DEFAULT_ENGLISH_REQUIRED = true;

if (!PUBLIC_BASE_URL) { console.error("Missing PUBLIC_BASE_URL"); process.exit(1); }
if (!OPENAI_API_KEY) { console.error("Missing OPENAI_API_KEY"); process.exit(1); }

function toWss(httpUrl) {
  if (httpUrl.startsWith("https://")) return "wss://" + httpUrl.slice("https://".length);
  if (httpUrl.startsWith("http://")) return "ws://" + httpUrl.slice("http://".length);
  return httpUrl;
}

// Direcciones
const ADDRESSES = {
  "New Campo Argentino": "6954 Collins Ave, Miami Beach, FL 33141, US",
  "Mexi Cafe": "6300 Collins Ave, Miami Beach, FL 33141, US",
  "Yes Cafe & Pizza": "731 NE 79th St, Miami, FL 33138",
  "Yes! Cafe – Miami Beach": "601 71st St, Miami Beach, FL 33141",
  "Mexi Trailer": "731 NE 79th St, Miami, FL 33138"
};

function getBrandAddress(brand) {
  return ADDRESSES[brand] || ADDRESSES["New Campo Argentino"];
}

function normalize(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}
function isGoodbye(text) {
  const t = " " + normalize(text) + " ";
  return (
    t.includes(" chau ") || t.includes(" chao ") || t.includes(" adios ") || t.includes(" hasta luego ") ||
    t.includes(" bye ") || t.includes(" me voy ") || t.includes(" tengo que cortar ") || t.includes(" corto ")
  );
}

const app = express();
app.use(express.urlencoded({ extended: false }));

app.get("/health", (req, res) => res.status(200).send("ok"));

// Incoming call webhook
app.post("/voice", (req, res) => {
  const wsUrl = `${toWss(PUBLIC_BASE_URL)}/media-stream`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="es-US">Conectando.</Say>
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
  // Permite que después selecciones brand/role desde el caller (YesBot) usando querystring
  // Ej: wss://.../media-stream?brand=Mexi%20Cafe&role=Front&english=1
  const url = new URL(req.url, "http://localhost");
  const brand = url.searchParams.get("brand") || DEFAULT_BRAND;
  const role = url.searchParams.get("role") || DEFAULT_ROLE;
  const englishRequired = (url.searchParams.get("english") || (DEFAULT_ENGLISH_REQUIRED ? "1" : "0")) === "1";
  const address = url.searchParams.get("address") || getBrandAddress(brand);

  const state = {
    streamSid: null,
    callSid: null,
    twilioReady: false,
    openaiReady: false,
    started: false,
    pendingAudio: [],
    responseInFlight: false,
    lastUserCommitId: null,

    // Anti-ruido: solo respondemos si hubo speech_started real
    heardSpeech: false,

    // Context
    brand,
    role,
    englishRequired,
    address,
  };

  console.log("[WS] connect", { brand, role, englishRequired, address });

  const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`,
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
  );

  function sendAudioToTwilio(deltaB64) {
    if (!state.streamSid) {
      if (state.pendingAudio.length < 500) state.pendingAudio.push(deltaB64);
      return;
    }
    const buf = Buffer.from(deltaB64, "base64");
    const frame = 160; // 20ms @ 8k mulaw
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
Sos Mariana, entrevistadora inicial para ${state.brand}. Tono cálido y humano.
Idioma: español neutro (LatAm). NO slang argentino (“laburo”), NO voseo (“vivís”).
1 pregunta por vez. Preguntás y te callás. No te respondas sola.
No repitas en loop: si no entendés, pedí repetir SOLO una vez y seguí.
Si la persona dice chau/bye o quiere cortar, despedite y terminá.

IMPORTANTE: Ya sabemos el puesto y el restaurante. NO preguntes “¿para qué puesto aplicaste?”.
Contexto fijo:
- Restaurante/Local: ${state.brand}
- Puesto: ${state.role}
- Dirección (si no lo conoce): ${state.address}
- Inglés requerido: ${state.englishRequired ? "sí" : "no"}

FLUJO EXACTO (en este orden):
1) Experiencia previa en el rubro/posición:
   - “¿Cuánta experiencia tenés en ${state.role}?”
   - “¿Dónde fue tu último trabajo?”
   - “¿Por qué te fuiste?”
(1 pregunta por vez)

2) Cercanía:
   - “¿Vivís cerca del local?”
   - Si dice que NO: “¿Tenés movilidad/auto para llegar?”
   - Si NO conoce el local: decile la dirección ${state.address}

3) Miami vs temporada:
   - “¿Estás viviendo en Miami ahora o estás por temporada?”
   - Si temporada: “¿Hasta cuándo te quedás?”

4) Disponibilidad:
   - “¿Podés trabajar fines de semana?”
   - “¿Día/noche?”
   - “¿Qué días y horarios te vienen bien?”

5) Prueba:
   - “¿Cuándo podrías venir a hacer una prueba?”

6) Inglés (solo si inglés requerido):
   - Preguntá en inglés: “What did you do in your last job?”
   - Si no entiende: “Can you tell me your availability in English?”
   - Si sigue sin entender: anotá “english not conversational” y seguí.

Evitar pregunta de papeles. NO preguntes nada de documentos.

CIERRE:
- Agradecé y decí que el equipo revisa y responde por WhatsApp.
`.trim(),
        audio: {
          input: {
            format: { type: "audio/pcmu" },
            turn_detection: {
              type: "server_vad",
              create_response: false,         // clave: no habla solo
              interrupt_response: true,
              threshold: 0.65,                // más duro contra ruido
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

    // Frase como la querías vos
    openaiWs.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text:
            `Decí EXACTO esto y después callate: ` +
            `"Hola, soy Mariana, te hablo de ${state.brand}. Te llamo por tu aplicación para ${state.role}. ` +
            `¿Tenés 3 minutos para una entrevista rápida ahora?"`
        }]
      }
    }));

    openaiWs.send(JSON.stringify({ type: "response.create" }));
    state.responseInFlight = true;
    console.log("[Flow] kickoff");
  }

  openaiWs.on("open", () => {
    console.log("[OpenAI] connected");
    sessionUpdate();
  });

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

      // barge-in
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

    // SOLO responder cuando hubo speech real + committed
    if (evt.type === "input_audio_buffer.committed") {
      if (!state.heardSpeech) return;      // ruido: ignorar
      state.heardSpeech = false;

      const itemId = evt.item_id || null;
      if (itemId && itemId === state.lastUserCommitId) return;
      state.lastUserCommitId = itemId;

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

    if (evt.type === "error") {
      console.error("[OpenAI] error", evt);
    }
  });

  openaiWs.on("close", () => console.log("[OpenAI] closed"));
  openaiWs.on("error", (e) => console.error("[OpenAI] ws error", e));

  twilioWs.on("message", (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }

    if (data.event === "start") {
      state.streamSid = data.start?.streamSid || null;
      state.callSid = data.start?.callSid || null;
      state.twilioReady = true;
      console.log("[Twilio] start", { streamSid: state.streamSid, callSid: state.callSid });
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
      console.log("[Twilio] stop");
      try { openaiWs.close(); } catch {}
      try { twilioWs.close(); } catch {}
    }
  });

  twilioWs.on("close", () => {
    console.log("[Twilio] closed");
    try { if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close(); } catch {}
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on ${PORT}`);
});

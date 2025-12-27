"use strict";

const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT || 8080);

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-realtime";
const VOICE = process.env.VOICE || "marin";
const BRAND = process.env.BRAND_NAME || "New Campo Argentino";

if (!PUBLIC_BASE_URL) {
  console.error("Missing PUBLIC_BASE_URL (https://TU-APP.ondigitalocean.app)");
  process.exit(1);
}
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}

function toWss(httpUrl) {
  if (httpUrl.startsWith("https://")) return "wss://" + httpUrl.slice("https://".length);
  if (httpUrl.startsWith("http://")) return "ws://" + httpUrl.slice("http://".length);
  return httpUrl;
}

const app = express();
app.use(express.urlencoded({ extended: false }));

app.get("/health", (req, res) => res.status(200).send("ok"));

app.post("/voice", (req, res) => {
  const wsUrl = `${toWss(PUBLIC_BASE_URL)}/media-stream`;

  // Dejamos el Say de debug corto (podés sacarlo después)
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

wss.on("connection", (twilioWs) => {
  console.log("[TwilioWS] connected");

  const state = {
    streamSid: null,
    callSid: null,
    twilioReady: false,

    openaiReady: false,
    started: false,

    pendingAudioDeltas: [],
    // anti-loop
    responseInFlight: false,
    lastUserCommitId: null,
  };

  const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`,
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
  );

  function sendAudioToTwilio(deltaB64) {
    if (!state.streamSid) {
      if (state.pendingAudioDeltas.length < 400) state.pendingAudioDeltas.push(deltaB64);
      return;
    }

    // Twilio recibe audio mulaw 8k en frames cortos; chunk 160 bytes (20ms)
    const buf = Buffer.from(deltaB64, "base64");
    const frame = 160;
    for (let i = 0; i < buf.length; i += frame) {
      const chunk = buf.subarray(i, i + frame);
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid: state.streamSid,
          media: { payload: chunk.toString("base64") },
        })
      );
    }
  }

  function flushAudio() {
    if (!state.streamSid) return;
    for (const d of state.pendingAudioDeltas) sendAudioToTwilio(d);
    state.pendingAudioDeltas = [];
  }

  function sessionUpdate() {
    // KEY: create_response = false -> el modelo NO responde solo.
    // Nosotros disparamos response.create cuando llega input_audio_buffer.committed  [oai_citation:2‡OpenAI Platform](https://platform.openai.com/docs/api-reference/realtime-server-events)
    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          model: OPENAI_MODEL,
          output_modalities: ["audio"],
          instructions: `
Sos Mariana. Hablás en español neutro (LatAm), sin slang argentino (no "laburo", no "che", no voseo).
Tono cálido y humano. 1 pregunta por vez. No repitas en loop.
Si el candidato dice "chau/bye", despedite corto.

Guion inicial EXACTO:
"Hola, soy Mariana, te hablo de ${BRAND}. Te llamo por tu aplicación. ¿Tenés 3 minutos para una entrevista rápida ahora?"
Si dice sí: empezá con las preguntas.
Si dice no: decí "Perfecto, gracias. Te escribimos para coordinar." y cerrá.

Preguntas (orden):
1) ¿Para qué puesto aplicaste? (Server/Runner, Hostess, Dishwasher, Front, Cook, Prep Cook, Pizzero, Trailer)
2) Experiencia previa: años + último lugar + tarea principal
3) Zona donde vive + si vive en Miami fijo o por temporada (y hasta cuándo)
4) Disponibilidad
5) Salario por hora
6) Inglés conversacional si rol es atención (Front/Server/Hostess)
7) Legal: "¿Estás autorizado/a para trabajar en Estados Unidos?" (sí/no)
`.trim(),
          audio: {
            input: {
              format: { type: "audio/pcmu" },
              turn_detection: {
                type: "server_vad",
                // IMPORTANTE:
                create_response: false,
                interrupt_response: true,
                threshold: 0.5,
                prefix_padding_ms: 250,
                silence_duration_ms: 600,
              },
            },
            output: {
              format: { type: "audio/pcmu" },
              voice: VOICE,
            },
          },
        },
      })
    );
  }

  function startKickoff() {
    if (state.started) return;
    if (!state.twilioReady || !state.openaiReady) return;

    state.started = true;
    flushAudio();

    // Forzamos el primer turno con el texto exacto que te gustaba
    openaiWs.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                `Arrancá YA con la frase exacta: ` +
                `"Hola, soy Mariana, te hablo de ${BRAND}. Te llamo por tu aplicación. ¿Tenés 3 minutos para una entrevista rápida ahora?" ` +
                `Después CALLATE y esperá respuesta.`,
            },
          ],
        },
      })
    );

    openaiWs.send(JSON.stringify({ type: "response.create" }));
    state.responseInFlight = true;

    console.log("[Flow] kickoff sent");
  }

  openaiWs.on("open", () => {
    console.log("[OpenAIWS] connected");
    sessionUpdate();
  });

  openaiWs.on("message", (raw) => {
    let evt;
    try { evt = JSON.parse(raw.toString()); } catch { return; }

    if (evt.type === "session.updated") {
      state.openaiReady = true;
      startKickoff();
      return;
    }

    // Barge-in: si el usuario habla, cancelamos la respuesta y limpiamos buffer en Twilio
    if (evt.type === "input_audio_buffer.speech_started") {
      try { openaiWs.send(JSON.stringify({ type: "response.cancel" })); } catch {}
      if (state.streamSid) {
        try { twilioWs.send(JSON.stringify({ event: "clear", streamSid: state.streamSid })); } catch {}
      }
      state.responseInFlight = false;
      return;
    }

    // AUDIO OUT
    if ((evt.type === "response.output_audio.delta" || evt.type === "response.audio.delta") && evt.delta) {
      sendAudioToTwilio(evt.delta);
      return;
    }

    // Cuando el input del usuario se “commitea” (terminó de hablar),
    // recién ahí pedimos una respuesta.  [oai_citation:3‡OpenAI Platform](https://platform.openai.com/docs/api-reference/realtime-server-events)
    if (evt.type === "input_audio_buffer.committed") {
      const itemId = evt.item_id || null;
      if (itemId && itemId === state.lastUserCommitId) return; // dedupe
      state.lastUserCommitId = itemId;

      if (!state.responseInFlight) {
        openaiWs.send(JSON.stringify({ type: "response.create" }));
        state.responseInFlight = true;
        console.log("[Flow] response.create (user committed)");
      }
      return;
    }

    // Cuando termina una respuesta, liberamos
    if (evt.type === "response.done") {
      state.responseInFlight = false;
      return;
    }

    if (evt.type === "error") {
      console.error("[OpenAIWS] error:", evt);
    }
  });

  openaiWs.on("error", (e) => console.error("[OpenAIWS] error", e));
  openaiWs.on("close", () => console.log("[OpenAIWS] closed"));

  // Twilio WS -> audio in
  twilioWs.on("message", (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }

    if (data.event === "start") {
      state.streamSid = data.start?.streamSid || null;
      state.callSid = data.start?.callSid || null;
      state.twilioReady = true;
      console.log("[TwilioWS] start", { streamSid: state.streamSid, callSid: state.callSid });

      startKickoff();
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
      console.log("[TwilioWS] stop");
      try { openaiWs.close(); } catch {}
      try { twilioWs.close(); } catch {}
    }
  });

  twilioWs.on("close", () => {
    console.log("[TwilioWS] closed");
    try { if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close(); } catch {}
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on ${PORT}`);
});

"use strict";

const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, ""); // https://...
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-realtime";
const VOICE = process.env.VOICE || "marin"; // mejor calidad: marin o cedar  [oai_citation:1‡OpenAI Platform](https://platform.openai.com/docs/guides/realtime-conversations)

if (!PUBLIC_BASE_URL) {
  console.error("FALTA PUBLIC_BASE_URL");
  process.exit(1);
}
if (!OPENAI_API_KEY) {
  console.error("FALTA OPENAI_API_KEY");
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
  // Twilio <Connect><Stream> = bidireccional  [oai_citation:2‡Twilio](https://www.twilio.com/docs/voice/twiml/stream)
  // Twilio SOLO acepta wss  [oai_citation:3‡Twilio](https://www.twilio.com/docs/voice/twiml/stream)
  const wsUrl = `${toWss(PUBLIC_BASE_URL)}/media-stream`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <!-- Debug audible: si no escuchás esto, no estás pegando a /voice -->
  <Say language="es-US">Conectando la entrevista.</Say>
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
  const sess = {
    streamSid: null,
    callSid: null,
    twilioReady: false,
    openaiReady: false,
    started: false,
    pendingAudio: [] // OpenAI audio deltas antes del streamSid
  };

  console.log("[TwilioWS] connected");

  // Conexión a OpenAI Realtime (WebSocket)
  const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`,
    {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }
    }
  );

  function sendAudioToTwilio(deltaB64) {
    if (!sess.streamSid) {
      if (sess.pendingAudio.length < 400) sess.pendingAudio.push(deltaB64);
      return;
    }

    // Twilio espera mensajes "media" con payload base64 mu-law  [oai_citation:4‡Twilio](https://www.twilio.com/docs/voice/media-streams/websocket-messages)
    // Para compat total, partimos en frames de 160 bytes (~20ms en 8k mu-law)
    const buf = Buffer.from(deltaB64, "base64");
    const frameSize = 160;

    for (let i = 0; i < buf.length; i += frameSize) {
      const chunk = buf.subarray(i, i + frameSize);
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid: sess.streamSid,
          media: { payload: chunk.toString("base64") }
        })
      );
    }
  }

  function flushPendingAudio() {
    if (!sess.streamSid) return;
    if (!sess.pendingAudio.length) return;
    for (const d of sess.pendingAudio) sendAudioToTwilio(d);
    sess.pendingAudio = [];
  }

  function maybeStart() {
    if (sess.started) return;
    if (!sess.twilioReady) return;
    if (!sess.openaiReady) return;

    sess.started = true;
    flushPendingAudio();

    // Forzamos a que hable primero (no esperamos al usuario)
    openaiWs.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Saludá cálido y empezá la entrevista en español. 1 pregunta por vez." }
          ]
        }
      })
    );
    openaiWs.send(JSON.stringify({ type: "response.create" }));

    console.log("[Flow] started (AI should speak now)");
  }

  openaiWs.on("open", () => {
    console.log("[OpenAIWS] connected");

    // session.update con formato recomendado (audio/pcmu para Twilio)  [oai_citation:5‡OpenAI Platform](https://platform.openai.com/docs/guides/realtime-conversations)
    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          model: OPENAI_MODEL,
          output_modalities: ["audio"],
          audio: {
            input: {
              format: { type: "audio/pcmu" },
              turn_detection: { type: "semantic_vad" }
            },
            output: {
              format: { type: "audio/pcmu" },
              voice: VOICE
            }
          },
          instructions:
            "Sos entrevistadora inicial para restaurante en Miami Beach. Español neutro, cálida, 1 pregunta por vez."
        }
      })
    );
  });

  openaiWs.on("message", (raw) => {
    let evt;
    try { evt = JSON.parse(raw.toString()); } catch { return; }

    if (evt.type === "session.updated") {
      console.log("[OpenAIWS] session.updated");
      sess.openaiReady = true;
      maybeStart();
      return;
    }

    // OpenAI: el audio real viene en response.output_audio.delta  [oai_citation:6‡OpenAI Platform](https://platform.openai.com/docs/guides/realtime-conversations)
    if ((evt.type === "response.output_audio.delta" || evt.type === "response.audio.delta") && evt.delta) {
      sendAudioToTwilio(evt.delta);
      return;
    }

    if (evt.type === "error") {
      console.error("[OpenAIWS] ERROR:", evt);
    }
  });

  openaiWs.on("close", () => console.log("[OpenAIWS] closed"));
  openaiWs.on("error", (e) => console.error("[OpenAIWS] error", e));

  twilioWs.on("message", (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }

    if (data.event === "connected") {
      console.log("[TwilioWS] connected event", data);
      return;
    }

    if (data.event === "start") {
      sess.streamSid = data.start?.streamSid;
      sess.callSid = data.start?.callSid;
      sess.twilioReady = true;
      console.log("[TwilioWS] start", { streamSid: sess.streamSid, callSid: sess.callSid });
      maybeStart();
      flushPendingAudio();
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
      return;
    }
  });

  twilioWs.on("close", () => {
    console.log("[TwilioWS] closed");
    try { if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close(); } catch {}
  });

  twilioWs.on("error", (e) => console.error("[TwilioWS] error", e));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on ${PORT}`);
});

import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const {
  OPENAI_API_KEY,
  OPENAI_REALTIME_MODEL = "gpt-realtime",
  OPENAI_VOICE = "marin",
  PUBLIC_BASE_URL,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  PORT = 3000,
} = process.env;

if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

const SYSTEM_MESSAGE = `
Eres “Mariana”, asistente virtual del equipo de selección de New Campo Argentino.
Objetivo: hacer una pre-entrevista breve, cálida y conversacional (no robótica).
Idioma: español neutro (LatAm/Miami). Usa “tú” o “usted”, pero NO uses voseo (“vivís”, “laburás”) ni slang argentino (“laburo”, “che”, etc).
Si el candidato habla en inglés, cambia a inglés sin drama.

TRANSPARENCIA:
- Al inicio preséntate como “asistente virtual automatizado del equipo de selección”.
- NO digas “IA” o “inteligencia artificial” salvo que el candidato pregunte.

ESTILO:
- 1 pregunta por vez.
- Reconoce la respuesta (1 frase) y avanza.
- Si no entiendes, repregunta SOLO una vez con otras palabras.
- No repitas en loop la misma pregunta.
- No traduzcas nombres propios/barrios (ej: “North Beach” se repite tal cual).

PREGUNTAS CLAVE (screening):
1) Zona donde vive / qué tan cerca le queda el local.
2) ¿Está viviendo en Miami ahora? ¿Es temporada o se quedará? ¿Hasta cuándo?
3) Disponibilidad horaria (días y rangos).
4) Expectativa salarial (por hora).
5) Experiencia previa relevante (1-2 preguntas cortas).
6) Si es rol de atención al público: nivel de inglés conversacional.
7) Pregunta de autorización laboral (forma neutral):
   “Para cumplir con el proceso de contratación: ¿estás autorizado/a para trabajar en Estados Unidos?”
   NO pedir documentos, NO preguntar nacionalidad.

CIERRE:
- Si el candidato dice “chau / bye / tengo que cortar / no puedo ahora”: responde breve, agradece y termina.
- No te quedes colgado esperando indefinidamente.
`.trim();

// Health check
app.get("/", (req, res) => res.send("ok"));

// Twilio Voice webhook -> connect stream to our WS
app.post("/voice", (req, res) => {
  const host =
    (PUBLIC_BASE_URL ? PUBLIC_BASE_URL.replace(/^https?:\/\//, "") : req.headers.host) || req.headers.host;

  const wsUrl = `wss://${host}/media-stream`;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`.trim();

  res.type("text/xml").send(twiml);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/media-stream" });

function looksLikeGoodbye(text) {
  const t = (text || "").toLowerCase();
  if (!t) return false;

  const patterns = [
    /\bchau\b/,
    /\badios\b/,
    /\badiós\b/,
    /\bhasta luego\b/,
    /\bhasta mañana\b/,
    /\bbye\b/,
    /\bgoodbye\b/,
    /\bme voy\b/,
    /\btengo que cortar\b/,
    /\bcorto\b/,
    /\bcuelgo\b/,
    /\bno puedo ahora\b/,
    /\bno puedo hablar\b/,
  ];
  return patterns.some((p) => p.test(t));
}

async function hangupViaTwilio(callSid) {
  if (!callSid) return;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    console.error("Missing TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN (can't hang up programmatically).");
    return;
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`;
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const body = new URLSearchParams({ Status: "completed" });

  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!r.ok) {
    const txt = await r.text();
    console.error("Twilio hangup failed:", r.status, txt);
  }
}

wss.on("connection", (twilioWs) => {
  let streamSid = null;
  let callSid = null;

  let pendingHangup = false;
  let hangupMarkSent = false;

  const openAiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
    }
  );

  const sendToOpenAI = (obj) => {
    if (openAiWs.readyState === WebSocket.OPEN) openAiWs.send(JSON.stringify(obj));
  };

  const sendToTwilio = (obj) => {
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.send(JSON.stringify(obj));
  };

  const configureSession = () => {
    sendToOpenAI({
      type: "session.update",
      session: {
        type: "realtime",
        model: OPENAI_REALTIME_MODEL,
        output_modalities: ["audio"],

        // Enables user-audio transcript events for logic like hangup detection.
        // Note: transcription is "rough guidance", not perfect.  [oai_citation:6‡OpenAI](https://platform.openai.com/docs/api-reference/realtime-beta-sessions)
        input_audio_transcription: {
          model: "whisper-1",
          language: "es",
          prompt:
            "Spanish (Latin America). Keep proper nouns as-is (e.g., North Beach, South Beach). No Argentine voseo.",
        },

        audio: {
          input: {
            format: { type: "audio/pcmu" },
            turn_detection: {
              type: "semantic_vad",
              create_response: true,
              interrupt_response: true,
            },
          },
          output: {
            format: { type: "audio/pcmu" },
            voice: OPENAI_VOICE,
            speed: 1.0,
          },
        },
        instructions: SYSTEM_MESSAGE,
      },
    });

    // Force a warm first turn (otherwise it waits for user speech)
    sendToOpenAI({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              "Start now with a short warm greeting in neutral Spanish. Present as an automated virtual hiring assistant (do NOT say 'IA' unless asked). Say you're calling because they applied to New Campo Argentino, and ask if they have 2-3 minutes right now.",
          },
        ],
      },
    });
    sendToOpenAI({ type: "response.create" });
  };

  openAiWs.on("open", () => configureSession());

  openAiWs.on("message", (raw) => {
    let evt;
    try {
      evt = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Barge-in: if user starts talking, cut assistant audio buffer
    if (evt.type === "input_audio_buffer.speech_started" && streamSid) {
      sendToTwilio({ event: "clear", streamSid }); // clears buffered audio  [oai_citation:7‡Twilio](https://www.twilio.com/docs/voice/media-streams/websocket-messages)
      sendToOpenAI({ type: "response.cancel" });
      hangupMarkSent = false; // reset in case we were ending
    }

    // User transcript event -> detect goodbye
    if (evt.type === "conversation.item.input_audio_transcription.completed") {
      if (looksLikeGoodbye(evt.transcript)) {
        pendingHangup = true;
      }
    }

    // Forward model audio to Twilio
    if (evt.type === "response.output_audio.delta" && evt.delta && streamSid) {
      sendToTwilio({
        event: "media",
        streamSid,
        media: { payload: evt.delta },
      });
    }

    // When the model finishes speaking AND we want to end, send a mark.
    // When Twilio returns that mark, we hang up.
    if (evt.type === "response.output_audio.done" && pendingHangup && streamSid && !hangupMarkSent) {
      hangupMarkSent = true;
      sendToTwilio({
        event: "mark",
        streamSid,
        mark: { name: "hangup" },
      });
    }

    if (evt.type === "error") {
      console.error("OpenAI error:", evt);
    }
  });

  twilioWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid;
      callSid = msg.start?.callSid;
      return;
    }

    if (msg.event === "media") {
      if (msg.media?.payload && openAiWs.readyState === WebSocket.OPEN) {
        sendToOpenAI({ type: "input_audio_buffer.append", audio: msg.media.payload });
      }
      return;
    }

    if (msg.event === "mark" && msg.mark?.name === "hangup") {
      hangupViaTwilio(callSid)
        .catch((e) => console.error("Hangup error:", e))
        .finally(() => {
          try {
            twilioWs.close();
          } catch {}
          try {
            openAiWs.close();
          } catch {}
        });
      return;
    }

    if (msg.event === "stop") {
      try {
        openAiWs.close();
      } catch {}
    }
  });

  twilioWs.on("close", () => {
    try {
      openAiWs.close();
    } catch {}
  });
});

server.listen(PORT, () => console.log(`Server listening on ${PORT}`));

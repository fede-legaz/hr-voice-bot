import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const PORT = process.env.PORT || 3000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("Falta OPENAI_API_KEY en variables de entorno.");
  process.exit(1);
}

const MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime";
const VOICE = process.env.OPENAI_VOICE || "marin"; // probá: marin o cedar
const BRAND = process.env.BRAND || "New Campo Argentino";

// Prompt “operativo”: humano, corto, sin loops, con checklist
const SYSTEM_MESSAGE = `
Sos la entrevistadora inicial (voz IA) para ${BRAND}. Tu objetivo es un screening corto (3–4 minutos) y humano.
IMPORTANTE:
- Al inicio, revelá que sos un asistente virtual con voz de IA (sin hacerlo pesado).
- Hacé UNA pregunta a la vez. No repitas preguntas.
- Si algo no se entiende, pedí aclaración SOLO una vez y seguí.
- Evitá “te confirmo para verificar”; en vez de eso, usá confirmaciones naturales (1 frase).
- Si el candidato habla inglés, podés seguir en inglés.
- Si el rol es customer-facing (Front/Server/Hostess), validá inglés conversacional con 2 preguntas cortas en inglés.

Checklist NO negociable (sí o sí obtener):
1) Zona donde vive / si vive cerca.
2) Si vive en Miami o viene por temporada (y por cuánto).
3) Disponibilidad horaria (días + turnos, y cuándo puede empezar).
4) Expectativa salarial (por hora o semanal, lo que diga).

También preguntá:
- Experiencia previa en el rubro y en el puesto (último lugar, cuánto tiempo, tareas).
- Si tiene papeles para trabajar (preguntalo de manera simple, sin interrogatorio).

Estilo de voz:
- Cálida, natural, como recruiter humana.
- Frases cortas, ritmo normal. Nada robótico.

Cierre:
- Si encaja: decir que el equipo lo contacta por WhatsApp para siguiente paso.
- Si no encaja: agradecer y cerrar amable.
`;

const app = express();
app.use(express.urlencoded({ extended: false }));

app.get("/", (_, res) => res.status(200).send("OK"));

/**
 * Twilio Voice webhook: devuelve TwiML para abrir Media Stream bidireccional
 */
app.post("/voice", (req, res) => {
  const streamUrl = getWebSocketUrl(req);

  // No usamos <Say> para evitar TTS robótico de Twilio.
  // El saludo lo hace OpenAI apenas se abre la sesión.
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(streamUrl)}" />
  </Connect>
</Response>`;

  res.type("text/xml").send(twiml);
});

const server = http.createServer(app);

/**
 * WebSocket server para Twilio Media Streams
 */
const wss = new WebSocketServer({ server, path: "/media-stream" });

wss.on("connection", (twilioWs) => {
  let streamSid = null;
  let callSid = null;
  let greetingSent = false;

  const openAiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
    }
  );

  function sendSessionUpdate() {
    // Formato audio para telefonía Twilio: PCMU (G.711 u-law).
    // La propia guía de Twilio recomienda session.update con audio/pcmu para compatibilidad.  [oai_citation:6‡Twilio](https://www.twilio.com/en-us/blog/voice-ai-assistant-openai-realtime-api-node)
    const sessionUpdate = {
      type: "session.update",
      session: {
        type: "realtime",
        model: MODEL,
        output_modalities: ["audio"],
        instructions: SYSTEM_MESSAGE,
        audio: {
          input: {
            format: { type: "audio/pcmu" },
            turn_detection: {
              type: "server_vad",
              threshold: 0.6,
              prefix_padding_ms: 300,
              silence_duration_ms: 350,
              create_response: true,
              interrupt_response: true,
            },
          },
          output: {
            format: { type: "audio/pcmu" },
            voice: VOICE,
            speed: 1.0,
          },
        },
      },
    };

    openAiWs.send(JSON.stringify(sessionUpdate));
  }

  function startGreeting() {
    if (greetingSent) return;
    greetingSent = true;

    // Forzamos que el bot hable primero.
    // OJO: el tipo correcto es input_text (no "text") — ese fue tu 400.  [oai_citation:7‡OpenAI Platform](https://platform.openai.com/docs/api-reference/realtime-client-events)
    openAiWs.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                `Arrancá la llamada AHORA. Hacé un saludo corto en español, ` +
                `decí que sos un asistente virtual de IA de entrevistas de ${BRAND}, ` +
                `preguntá si tiene 3 minutos, y si sí, empezá con: ` +
                `"¿En qué zona vivís? ¿Te queda cerca el local?" ` +
                `Luego seguí con el checklist sin sonar robótica.`,
            },
          ],
        },
      })
    );

    openAiWs.send(JSON.stringify({ type: "response.create" }));
  }

  openAiWs.on("open", () => {
    // Mini delay para evitar race conditions de handshake.
    setTimeout(sendSessionUpdate, 250);
  });

  openAiWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Barge-in real: si el usuario empieza a hablar, cortamos audio del bot.
    if (msg.type === "input_audio_buffer.speech_started") {
      // Este evento existe específicamente para interrumpir playback.  [oai_citation:8‡OpenAI Platform](https://platform.openai.com/docs/api-reference/realtime-server-events)
      if (streamSid) {
        // Twilio "clear" limpia audio buffer y frena playback al instante.  [oai_citation:9‡Twilio](https://www.twilio.com/docs/voice/media-streams/websocket-messages)
        twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
      }
      // Cancelamos la respuesta en curso del modelo
      openAiWs.send(JSON.stringify({ type: "response.cancel" }));
      return;
    }

    if (msg.type === "session.updated") {
      // Ya está configurada la sesión => arrancamos saludo.
      startGreeting();
      return;
    }

    // Audio que sale del modelo (chunks base64)
    if (msg.type === "response.output_audio.delta" && msg.delta && streamSid) {
      // Enviamos audio a Twilio para que lo reproduzca
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: msg.delta },
        })
      );
      return;
    }

    if (msg.type === "error") {
      console.error("OpenAI error:", msg.error);
      return;
    }
  });

  openAiWs.on("error", (err) => {
    console.error("OpenAI WS error:", err);
  });

  openAiWs.on("close", () => {
    // Si OpenAI cierra, cerramos Twilio también.
    try {
      twilioWs.close();
    } catch {}
  });

  twilioWs.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (data.event) {
      case "start":
        streamSid = data.start.streamSid;
        callSid = data.start.callSid;
        console.log("Twilio stream started:", { streamSid, callSid });
        break;

      case "media":
        // Forward de audio entrante a OpenAI
        if (openAiWs.readyState === WebSocket.OPEN && data.media?.payload) {
          openAiWs.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: data.media.payload,
            })
          );
        }
        break;

      case "stop":
        console.log("Twilio stream stopped:", { streamSid, callSid });
        try {
          openAiWs.close();
        } catch {}
        break;

      default:
        // connected, mark, etc.
        break;
    }
  });

  twilioWs.on("close", () => {
    try {
      openAiWs.close();
    } catch {}
  });

  twilioWs.on("error", (err) => {
    console.error("Twilio WS error:", err);
  });
});

server.listen(PORT, () => {
  console.log(`Server escuchando en puerto ${PORT}`);
});

function getWebSocketUrl(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  const wsProto = proto === "https" ? "wss" : "ws";
  return `${wsProto}://${host}/media-stream`;
}

function escapeXml(unsafe) {
  return String(unsafe)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

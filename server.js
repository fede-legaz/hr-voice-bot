import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import twilio from "twilio";
import crypto from "crypto";

const {
  OPENAI_API_KEY,
  PUBLIC_BASE_URL,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  PORT = 3000,
  OPENAI_REALTIME_MODEL = "gpt-realtime-2025-08-28",
  OPENAI_VOICE = "marin",
} = process.env;

if (!OPENAI_API_KEY) {
  console.error("Falta OPENAI_API_KEY en variables de entorno.");
  process.exit(1);
}
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
  console.error("Faltan TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN en variables de entorno.");
  process.exit(1);
}

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

/**
 * Nota: Para Twilio Media Streams, el output debe ser PCMU (mulaw).
 * En Realtime API, configuramos audio.output.format = audio/pcmu.  [oai_citation:2‡OpenAI Platform](https://platform.openai.com/docs/guides/realtime-conversations)
 */
const SYSTEM_MESSAGE = `
Sos una entrevistadora telefónica cálida, profesional y eficiente del equipo de contratación de New Campo Argentino (Miami).
NO digas que sos una IA. NO digas "modelo", "bot" ni "inteligencia artificial".
Hablá en español neutro (sin jerga regional). Si la persona habla en inglés, respondé en inglés.

OBJETIVO:
Hacer una entrevista inicial breve (3-5 minutos), 1 pregunta por vez, estilo conversacional.
Regla de oro: cuando hacés una pregunta, TERMINÁS tu turno ahí y esperás la respuesta. No encadenes preguntas.

GATE DE INICIO (CRÍTICO):
- En el primer turno SOLO: saludo + contexto + pregunta de permiso:
  "¿Te viene bien hablar 3 minutos ahora?"
- No avances con nada más hasta escuchar un "sí" claro.

SI DICE QUE NO / ESTÁ OCUPADO:
- Decí algo corto, amable, sin insistir, y cerrá:
  "Perfecto, gracias. Te dejamos este contacto y coordinamos por mensaje. Buen día."
- Luego despedite y finalizá la llamada.

PREGUNTAS NO NEGOCIABLES (cuando ya aceptó hablar):
1) Zona donde vive / cercanía al local.
2) Si está viviendo en Miami o es por temporada (y por cuánto tiempo).
3) Disponibilidad horaria (días y horarios).
4) Expectativa salarial (por hora).
5) Inglés conversacional si aplica a atención al público.
6) Experiencia previa en el rubro (rol similar, cuánto tiempo, último lugar).

PREGUNTA “LEGAL” (sin pedir papeles):
- En vez de "¿tenés papeles?", preguntá:
  "¿Estás autorizado/a para trabajar en Estados Unidos para cualquier empleador?"
  y opcional:
  "¿Vas a necesitar patrocinio (sponsorship) ahora o en el futuro?"

CALIDAD:
- Si entendés algo razonable, seguí. No repreguntes en loop.
- Solo pedí repetición si realmente no se entendió, y máximo 1 vez por pregunta.
- Si la persona dice "chau", "adiós", "bye", "no me llames", agradecé y cerrá la llamada.
`.trim();

/**
 * Twilio webhook: cuando llaman al número, Twilio pega acá y le devolvemos TwiML
 */
app.post("/voice", (req, res) => {
  const wsUrl = getWebSocketUrl(req);
  const twiml = new twilio.twiml.VoiceResponse();

  // Conecta el audio de la llamada a nuestro WebSocket
  const connect = twiml.connect();
  connect.stream({ url: wsUrl });

  res.type("text/xml").send(twiml.toString());
});

app.get("/health", (req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/media-stream" });

wss.on("connection", (twilioWs, req) => {
  let streamSid = null;
  let callSid = null;

  // Estado de turnos
  let greeted = false;
  let phase = "consent"; // "consent" -> "interview" -> "ending"
  let lastTranscriptItemId = null;

  // Control de respuestas (porque create_response = false)
  let aiBusy = false;
  let queuedResponse = null;

  // Para cortar audio cuando el usuario interrumpe (barge-in)
  let lastAssistantAudioAt = 0;

  // Para colgar correctamente
  let pendingHangup = false;
  let hangupMarkSent = false;
  let hangupTimer = null;

  const openAiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  function sendToOpenAI(payload) {
    if (openAiWs.readyState === WebSocket.OPEN) {
      openAiWs.send(JSON.stringify(payload));
    }
  }

  function requestResponse(instructionsOverride = null) {
    const payload =
      instructionsOverride && instructionsOverride.trim().length
        ? {
            type: "response.create",
            response: {
              instructions: instructionsOverride,
            },
          }
        : { type: "response.create" };

    if (aiBusy) {
      queuedResponse = payload;
      return;
    }
    aiBusy = true;
    sendToOpenAI(payload);
  }

  function flushQueuedResponseIfAny() {
    if (!queuedResponse) return;
    const payload = queuedResponse;
    queuedResponse = null;
    aiBusy = true;
    sendToOpenAI(payload);
  }

  function normalize(s) {
    return (s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim();
  }

  function isGoodbye(text) {
    const t = normalize(text);
    return (
      t.includes("chau") ||
      t.includes("chao") ||
      t.includes("adios") ||
      t.includes("nos vemos") ||
      t === "bye" ||
      t.includes("bye ") ||
      t.includes("goodbye") ||
      t.includes("hasta luego") ||
      t.includes("hasta la proxima") ||
      t.includes("me tengo que ir") ||
      t.includes("corto") ||
      t.includes("cuelgo") ||
      t.includes("no me llames")
    );
  }

  function classifyConsent(text) {
    const t = normalize(text);

    // NO / ocupado / después
    if (
      t.includes("ahora no") ||
      t.includes("no puedo") ||
      t.includes("ocupad") ||
      t.includes("despues") ||
      t.includes("mas tarde") ||
      t.includes("luego") ||
      t.includes("otro momento") ||
      t.includes("cant") ||
      t.includes("can't") ||
      t.includes("later") ||
      t === "no"
    ) {
      return "no";
    }

    // SI / ok / dale
    if (
      t === "si" ||
      t === "sí" ||
      t.includes("si ") ||
      t.includes("dale") ||
      t.includes("ok") ||
      t.includes("okay") ||
      t.includes("claro") ||
      t.includes("perfecto") ||
      t.includes("yes") ||
      t.includes("sure") ||
      t.includes("i can") ||
      t.includes("go ahead") ||
      t.includes("tengo tiempo") ||
      t.includes("puedo")
    ) {
      return "yes";
    }

    return "unknown";
  }

  function scheduleHangupFallback() {
    // Si por algún motivo no llega el mark de Twilio, cortamos igual.
    if (hangupTimer) clearTimeout(hangupTimer);
    hangupTimer = setTimeout(async () => {
      if (!callSid) return;
      try {
        await twilioClient.calls(callSid).update({ status: "completed" });
      } catch (e) {
        // no-op
      }
    }, 6000);
  }

  function hangupNow() {
    if (!callSid) return;
    twilioClient.calls(callSid).update({ status: "completed" }).catch(() => {});
  }

  function configureSession() {
    sendToOpenAI({
      type: "session.update",
      session: {
        type: "realtime",
        output_modalities: ["audio"],
        instructions: SYSTEM_MESSAGE,
        max_output_tokens: 300,
        audio: {
          input: {
            format: { type: "audio/pcmu" }, // Twilio inbound
            transcription: {
              // Para detectar "sí/no/chau" con buena calidad en ES/EN
              model: "gpt-4o-mini-transcribe",
              language: "es",
            },
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 450,
              idle_timeout_ms: null,
              create_response: false, // CLAVE: el modelo NO responde solo.  [oai_citation:3‡OpenAI Platform](https://platform.openai.com/docs/api-reference/realtime-server-events)
              interrupt_response: true,
            },
          },
          output: {
            format: { type: "audio/pcmu" }, // Twilio outbound  [oai_citation:4‡OpenAI Platform](https://platform.openai.com/docs/guides/realtime-conversations)
            voice: OPENAI_VOICE,
          },
        },
      },
    });
  }

  function startConsentGreeting() {
    // Turno 1: SOLO pedir permiso y callarse.
    requestResponse(
      `Decí un saludo corto y profesional y pedí permiso para hablar 3 minutos.
NO hagas ninguna otra pregunta.
Frase sugerida: "Hola, te llamo de New Campo Argentino por tu solicitud. ¿Te viene bien hablar 3 minutos ahora?"`
    );
  }

  function handleConsentTranscript(transcript) {
    if (isGoodbye(transcript)) {
      phase = "ending";
      pendingHangup = true;
      requestResponse(`Decí: "Perfecto, gracias. Que tengas un buen día." y terminá.`);
      return;
    }

    const c = classifyConsent(transcript);
    if (c === "yes") {
      phase = "interview";
      requestResponse(
        `Agradecé en una frase y hacé SOLO la primera pregunta del screening:
"Gracias. Para empezar: ¿en qué zona vivís en Miami?"`
      );
      return;
    }

    if (c === "no") {
      phase = "ending";
      pendingHangup = true;
      requestResponse(
        `Decí algo corto y amable, sin insistir, y cerrá:
"Perfecto, gracias. Coordinamos por mensaje. Buen día."`
      );
      return;
    }

    // unknown
    requestResponse(
      `Repetí SOLO la pregunta de permiso, muy clara:
"¿Te viene bien hablar 3 minutos ahora? Podés decir sí o no."`
    );
  }

  // ---- Twilio WS inbound ----
  twilioWs.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg);
    } catch {
      return;
    }

    if (data.event === "start") {
      streamSid = data.start?.streamSid;
      callSid = data.start?.callSid;
      return;
    }

    if (data.event === "media") {
      // Inbound audio base64 (mulaw)
      const audio = data.media?.payload;
      if (audio) {
        sendToOpenAI({ type: "input_audio_buffer.append", audio });
      }
      return;
    }

    if (data.event === "mark") {
      // Mark del stream: útil para colgar "post-audio"
      if (data.mark?.name === "hangup") {
        hangupNow();
      }
      return;
    }

    if (data.event === "stop") {
      // El caller cortó
      try {
        openAiWs.close();
      } catch {}
      return;
    }
  });

  twilioWs.on("close", () => {
    try {
      openAiWs.close();
    } catch {}
    if (hangupTimer) clearTimeout(hangupTimer);
  });

  // ---- OpenAI WS ----
  openAiWs.on("open", () => {
    configureSession();
  });

  openAiWs.on("message", (raw) => {
    let ev;
    try {
      ev = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Cuando la sesión está lista, saludamos una sola vez
    if (ev.type === "session.updated" && !greeted) {
      greeted = true;
      startConsentGreeting();
      return;
    }

    // Estado de respuesta
    if (ev.type === "response.created") {
      aiBusy = true;
    }
    if (ev.type === "response.done") {
      aiBusy = false;
      flushQueuedResponseIfAny();
    }

    // Barge-in: si el usuario empieza a hablar, cortamos el audio del bot
    if (ev.type === "input_audio_buffer.speech_started") {
      // Cortar playback en Twilio (clear) + cancelar respuesta en OpenAI
      sendToOpenAI({ type: "response.cancel" }); //  [oai_citation:5‡OpenAI Platform](https://platform.openai.com/docs/api-reference/realtime-client-events)
      if (streamSid) {
        twilioWs.send(JSON.stringify({ event: "clear", streamSid })); //  [oai_citation:6‡Twilio](https://www.twilio.com/docs/voice/media-streams/websocket-messages?utm_source=chatgpt.com)
      }
      return;
    }

    // Transcripción final del usuario (la usamos como trigger para responder)
    if (ev.type === "conversation.item.input_audio_transcription.completed") {
      // Dedupe por item_id
      if (ev.item_id && ev.item_id === lastTranscriptItemId) return;
      lastTranscriptItemId = ev.item_id;

      const transcript = (ev.transcript || "").trim();
      if (!transcript) return;

      // Si el usuario se despide en cualquier momento, cerramos.
      if (isGoodbye(transcript)) {
        phase = "ending";
        pendingHangup = true;
        requestResponse(`Decí: "Perfecto, gracias. Que tengas un buen día." y terminá.`);
        return;
      }

      // Gate de consentimiento
      if (phase === "consent") {
        handleConsentTranscript(transcript);
        return;
      }

      // Ya en entrevista: dejamos que el modelo maneje conversacionalmente,
      // pero como create_response=false, nosotros disparamos la respuesta en cada turno.
      requestResponse(null);
      return;
    }

    // Audio de salida hacia Twilio
    if (ev.type === "response.output_audio.delta" && ev.delta && streamSid) {
      lastAssistantAudioAt = Date.now();
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: ev.delta },
        })
      );
      return;
    }

    if (ev.type === "response.output_audio.done") {
      // Si estamos cerrando, mandamos mark para colgar cuando termine de sonar.
      if (pendingHangup && streamSid && !hangupMarkSent) {
        hangupMarkSent = true;
        twilioWs.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "hangup" } })); //  [oai_citation:7‡Twilio](https://www.twilio.com/docs/voice/media-streams/websocket-messages?utm_source=chatgpt.com)
        scheduleHangupFallback();
      }
      return;
    }

    // Log de errores
    if (ev.type === "error") {
      console.error("OpenAI error event:", ev);
      // Liberar aiBusy por si quedó trabado
      aiBusy = false;
      flushQueuedResponseIfAny();
      return;
    }
  });

  openAiWs.on("close", () => {
    // no-op
  });

  openAiWs.on("error", (err) => {
    console.error("OpenAI WS error:", err);
  });
});

server.listen(PORT, () => {
  console.log(`Servidor listo en http://localhost:${PORT}`);
});

function getWebSocketUrl(req) {
  // Si estás en producción, seteá PUBLIC_BASE_URL=https://TU-DOMINIO
  // Si no, intentamos inferir del request (a veces Twilio manda host correcto).
  const base =
    PUBLIC_BASE_URL ||
    `${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host}`;

  // Twilio necesita wss://
  return base.replace(/^http/, "ws") + "/media-stream";
}

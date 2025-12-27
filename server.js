import express from "express";
import bodyParser from "body-parser";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// --- Static audio hosting ---
const AUDIO_DIR = path.join(process.cwd(), "audio");
fs.mkdirSync(AUDIO_DIR, { recursive: true });
app.use("/audio", express.static(AUDIO_DIR));

// --- Env ---
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

let BASE_URL = process.env.BASE_URL; // opcional; si no está, se autodetecta

// --- Simple in-memory sessions (MVP) ---
const sessions = new Map(); // CallSid -> session state

function getSession(callSid) {
  if (!sessions.has(callSid)) {
    sessions.set(callSid, {
      brand: "New Campo Argentino",
      language: "es",
      asked: [],
      data: {
        zona: null,
        residencia: null,
        disponibilidad: null,
        salario: null
      },
      last_bot: null,
      created_at: Date.now()
    });
  }
  return sessions.get(callSid);
}

// --- Helpers ---
function autodetectBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

function getResponsesOutputText(respJson) {
  // Compatible con distintas variantes de Responses API
  if (respJson?.output_text) return respJson.output_text;

  const out = respJson?.output;
  if (!Array.isArray(out)) return "";

  let s = "";
  for (const item of out) {
    const content = item?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c?.type === "output_text" && typeof c?.text === "string") s += c.text;
    }
  }
  return s;
}

function twimlPlayAndGather(playUrl, actionUrl, lang = "es-US") {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${playUrl}</Play>
  <Gather input="speech" language="${lang}" timeout="10" speechTimeout="auto"
          action="${actionUrl}" method="POST"/>
</Response>`;
}

function twimlPlayOnly(playUrl) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Play>${playUrl}</Play></Response>`;
}

// --- ElevenLabs TTS -> MP3 file served from /audio ---
async function ttsToMp3(text) {
  if (!ELEVEN_KEY || !VOICE_ID) {
    throw new Error("Missing ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID");
  }

  const id = crypto.randomBytes(10).toString("hex");
  const outPath = path.join(AUDIO_DIR, `${id}.mp3`);

  const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_KEY,
      "Content-Type": "application/json",
      "Accept": "audio/mpeg"
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        // más natural para llamadas
        stability: 0.30,
        similarity_boost: 0.85
      }
    })
  });

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`ElevenLabs error: ${resp.status} ${t}`);
  }

  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(outPath, buf);

  return `${BASE_URL}/audio/${id}.mp3`;
}

// --- OpenAI "brain": returns JSON with say/update/done ---
const FALLBACK_LINE = "Perdón, se me cortó un segundo. ¿Me repetís dónde vivís y qué disponibilidad tenés?";
const MAX_AI_FAILS = 2;

function scriptedNext(session) {
  // Fallback por estado: pregunta lo que falta, 1-2 preguntas cortas
  const d = session.data;
  if (!d.zona) {
    return { say: "Dale. ¿En qué zona vivís? ¿Vivís cerca del local?", update: {}, done: false };
  }
  if (!d.residencia) {
    return { say: "Perfecto. ¿Estás viviendo en Miami permanente o por temporada?", update: {}, done: false };
  }
  if (!d.disponibilidad) {
    return { say: "Bien. ¿Qué días y horarios podés trabajar?", update: {}, done: false };
  }
  if (!d.salario) {
    return { say: "Última: ¿cuál es tu expectativa salarial por hora? Decime un número.", update: {}, done: false };
  }
  return { say: "Listo, gracias. Con esta info seguimos el proceso y te contactamos.", update: {}, done: true };
}

async function decideNext(session, userText) {
  if (!OPENAI_KEY) throw new Error("Missing OPENAI_API_KEY");
  session.aiFails = session.aiFails || 0;

  const sys = `
Sos Mariana, entrevistadora inicial por teléfono para restaurantes en Miami.
Objetivo: obtener y confirmar:
- zona/cercanía
- Miami permanente o temporada
- disponibilidad (días/horarios)
- salario por hora (número)
Reglas:
- máximo 2 preguntas cortas por turno
- si es vago, repreguntá para concretar
- tono cálido, humano, frases cortas
Salida: SOLO JSON:
{"say": "...", "update":{"zona":null|string,"residencia":null|string,"disponibilidad":null|string,"salario":null|string}, "done": boolean}
No inventes datos.
`.trim();

  const userPrompt =
`Marca: ${session.brand}
Datos actuales: ${JSON.stringify(session.data)}
Último mensaje de Mariana: ${session.last_bot || "N/A"}
Texto del candidato: ${userText || ""}`;

  const payload = {
    model: OPENAI_MODEL,
    input: [
      { role: "system", content: [{ type: "input_text", text: sys }] },
      { role: "user", content: [{ type: "input_text", text: userPrompt }] }
    ],
    text: { format: { type: "json_object" } }
  };

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!resp.ok) {
    session.aiFails += 1;
    return session.aiFails >= MAX_AI_FAILS ? scriptedNext(session) : { say: FALLBACK_LINE, update: {}, done: false };
  }

  const data = await resp.json();
  const out = getResponsesOutputText(data);

  let obj;
  try {
    obj = JSON.parse(out);
  } catch {
    session.aiFails += 1;
    return session.aiFails >= MAX_AI_FAILS ? scriptedNext(session) : { say: FALLBACK_LINE, update: {}, done: false };
  }

  // Si el modelo devuelve el fallback repetido, cortamos loop
  const say = String(obj.say || "");
  if (say.trim() === FALLBACK_LINE.trim()) {
    session.aiFails += 1;
    return session.aiFails >= MAX_AI_FAILS ? scriptedNext(session) : { say: FALLBACK_LINE, update: {}, done: false };
  }

  // Reset si fue bien
  session.aiFails = 0;

  obj.update = obj.update || {};
  obj.done = Boolean(obj.done);
  obj.say = say.slice(0, 900);

  return obj;
}

// --- Main Twilio webhook ---
app.post("/voice", async (req, res) => {
  // set BASE_URL if missing
  if (!BASE_URL) BASE_URL = autodetectBaseUrl(req);

  const callSid = req.body.CallSid || "no-call-sid";
  const session = getSession(callSid);

  const speech = (req.body.SpeechResult || "").trim();

  try {
    // Intro (first turn) - no IA yet
    if (!session.last_bot) {
      const intro =
        "Hola, ¿cómo estás? Soy Mariana. Te llamo porque aplicaste para trabajar en New Campo Argentino. " +
        "¿Tenes dos minutitos para hablar ahora?";
      session.last_bot = intro;
      session.asked.push("intro");

      const url = await ttsToMp3(intro);
      return res.type("text/xml").send(twimlPlayAndGather(url, "/voice", "es-US"));
    }

    // If user said nothing
    if (!speech) {
      const rep = "Perdón, no te escuché bien. ¿Me lo repetís, porfa?";
      session.last_bot = rep;
      const url = await ttsToMp3(rep);
      return res.type("text/xml").send(twimlPlayAndGather(url, "/voice", "es-US"));
    }

    // IA step
    const next = await decideNext(session, speech);

    // Update extracted fields
    for (const k of ["zona", "residencia", "disponibilidad", "salario"]) {
      const v = next.update?.[k];
      if (typeof v === "string" && v.trim().length > 0) session.data[k] = v.trim();
    }

    // crude asked tracking
    const s = (next.say || "").toLowerCase();
    if (s.includes("zona") || s.includes("viv")) session.asked.push("zona");
    if (s.includes("perman") || s.includes("tempor")) session.asked.push("residencia");
    if (s.includes("horar") || s.includes("días") || s.includes("dias")) session.asked.push("disponibilidad");
    if (s.includes("salar") || s.includes("por hora")) session.asked.push("salario");

    session.last_bot = next.say;

    const url = await ttsToMp3(next.say);

    if (next.done) {
      sessions.delete(callSid);
      return res.type("text/xml").send(twimlPlayOnly(url));
    }

    return res.type("text/xml").send(twimlPlayAndGather(url, "/voice", "es-US"));
  } catch (e) {
    console.error(e);
    return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>Hubo un error técnico. Intentá más tarde.</Say></Response>`);
  }
});

// Health check
app.get("/health", (_, res) => res.status(200).send("ok"));

app.listen(process.env.PORT || 3000, () => console.log("running"));

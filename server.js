import express from "express";
import bodyParser from "body-parser";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const AUDIO_DIR = path.join(process.cwd(), "audio");
fs.mkdirSync(AUDIO_DIR, { recursive: true });
app.use("/audio", express.static(AUDIO_DIR));

const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

let BASE_URL = process.env.BASE_URL; // DO te da URL pública, si no se setea lo autodetectamos

// --- Sesiones (MVP) ---
const sessions = new Map(); // CallSid -> state

function getSession(callSid) {
  if (!sessions.has(callSid)) {
    sessions.set(callSid, {
      brand: "New Campo Argentino",
      role: null, // después lo conectamos
      language: "es",
      asked: [],
      data: {
        zona: null,
        residencia: null,
        disponibilidad: null,
        salario: null,
        ingles_ok: null
      },
      last_bot: null,
      started_at: Date.now()
    });
  }
  return sessions.get(callSid);
}

// --- ElevenLabs TTS ---
async function ttsToMp3(text) {
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
        // más natural para teléfono
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

// --- TwiML ---
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

// --- OpenAI “cerebro” ---
async function decideNext(session, userText) {
  const sys = `
Sos Mariana, entrevistadora inicial por teléfono para restaurantes en Miami.
Objetivo: en 5-7 minutos obtener y confirmar:
- zona/cercanía
- vive en Miami permanente o temporada (y cuánto tiempo si temporada)
- disponibilidad (días/horarios)
- expectativa salarial por hora (número)
Reglas:
- Hacé máximo 2 preguntas cortas por turno.
- Si el candidato es vago ("depende", "cuando pueda"), repreguntá para concretar.
- Confirmá datos con frases humanas ("ok, entonces...").
- Tono cálido, humano, cero robot.
Salida: respondé SOLO JSON válido con esta forma:
{
  "say": "texto que Mariana va a decir ahora (puede incluir confirmación + 1-2 preguntas)",
  "update": { "zona": string|null, "residencia": string|null, "disponibilidad": string|null, "salario": string|null },
  "done": boolean
}
No inventes datos. Si no hay algo, dejalo null en update.
`;

  const payload = {
    model: OPENAI_MODEL,
    input: [
      {
        role: "system",
        content: [{ type: "text", text: sys.trim() }]
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
`Contexto:
- Marca: ${session.brand}
- Datos actuales: ${JSON.stringify(session.data)}
- Preguntas ya hechas: ${JSON.stringify(session.asked)}
- Último mensaje de Mariana: ${session.last_bot || "N/A"}

Texto del candidato (transcripción):
${userText || ""}

Decidí el próximo paso.`
          }
        ]
      }
    ],
    // Pedimos JSON “duro”
    response_format: { type: "json_object" }
  };

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`OpenAI error: ${resp.status} ${t}`);
  }

  const data = await resp.json();
  const text = data.output_text;

  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    // fallback ultra simple si el modelo devuelve algo raro
    obj = {
      say: "Perdón, se me cortó un segundo. ¿Me repetís dónde vivís y qué disponibilidad tenés?",
      update: { zona: null, residencia: null, disponibilidad: null, salario: null },
      done: false
    };
  }

  // saneo básico
  obj.update = obj.update || {};
  obj.done = Boolean(obj.done);
  obj.say = String(obj.say || "").slice(0, 800);

  return obj;
}

// --- Route principal Twilio ---
app.post("/voice", async (req, res) => {
  // autodetect BASE_URL si no está seteada
  if (!BASE_URL) {
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    BASE_URL = `${proto}://${host}`;
  }

  const callSid = req.body.CallSid || "no-call-sid";
  const session = getSession(callSid);

  // Twilio STT
  const speech = (req.body.SpeechResult || "").trim();

  try {
    // Primer contacto: intro (sin IA)
    if (!session.last_bot) {
      const intro =
        "Hola, ¿cómo estás? Soy Mariana. Te llamo porque aplicaste para trabajar en New Campo Argentino. " +
        "¿Te viene bien hablar dos minutitos ahora? Si no, lo hacemos más tarde, cero problema.";
      session.last_bot = intro;
      session.asked.push("intro");

      const url = await ttsToMp3(intro);
      return res.type("text/xml").send(twimlPlayAndGather(url, "/voice", "es-US"));
    }

    // Si no dijo nada, pedimos repetir sin gastar IA
    if (!speech) {
      const rep = "Perdón, no te escuché bien. ¿Me repetís eso, porfa?";
      session.last_bot = rep;
      const url = await ttsToMp3(rep);
      return res.type("text/xml").send(twimlPlayAndGather(url, "/voice", "es-US"));
    }

    // IA decide el próximo paso (semi-dios)
    const next = await decideNext(session, speech);

    // Actualiza datos extraídos
    for (const k of ["zona", "residencia", "disponibilidad", "salario"]) {
      const v = next.update?.[k];
      if (v && typeof v === "string" && v.trim().length > 0) session.data[k] = v.trim();
    }

    // Track de “qué ya preguntamos” (simple)
    // si el bot menciona palabras clave, lo marcamos
    const sayLower = (next.say || "").toLowerCase();
    if (sayLower.includes("zona") || sayLower.includes("viv")) session.asked.push("zona");
    if (sayLower.includes("perman") || sayLower.includes("tempor")) session.asked.push("residencia");
    if (sayLower.includes("horar") || sayLower.includes("días") || sayLower.includes("dias")) session.asked.push("disponibilidad");
    if (sayLower.includes("salar") || sayLower.includes("por hora")) session.asked.push("salario");

    session.last_bot = next.say;

    const url = await ttsToMp3(next.say);

    if (next.done) {
      sessions.delete(callSid);
      return res.type("text/xml").send(twimlPlayOnly(url));
    }

    return res.type("text/xml").send(twimlPlayAndGather(url, "/voice", "es-US"));
  } catch (e) {
    // Para debug: mirá Runtime Logs en DO
    console.error(e);
    return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>Hubo un error técnico. Intentá más tarde.</Say></Response>`);
  }
});

app.get("/health", (_, res) => res.status(200).send("ok"));
app.listen(process.env.PORT || 3000, () => console.log("running"));

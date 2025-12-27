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
let BASE_URL = process.env.BASE_URL; // lo seteamos en DO

const sessions = new Map();
const MAX_RETRIES = 2;

function getSession(callSid) {
  if (!sessions.has(callSid)) sessions.set(callSid, { step: "intro", retries: {} });
  return sessions.get(callSid);
}

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
      voice_settings: { stability: 0.45, similarity_boost: 0.8 }
    })
  });

  if (!resp.ok) throw new Error(`ElevenLabs error: ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(outPath, buf);

  return `${BASE_URL}/audio/${id}.mp3`;
}

function twimlPlayAndGather(playUrl, actionUrl, lang = "es-US") {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${playUrl}</Play>
  <Gather input="speech" language="${lang}" timeout="8" speechTimeout="auto"
          action="${actionUrl}" method="POST"/>
</Response>`;
}
function twimlPlayOnly(playUrl) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Play>${playUrl}</Play></Response>`;
}

function isVague(text) {
  if (!text) return true;
  const t = text.toLowerCase();
  const vague = ["depende", "no sé", "nose", "cuando pueda", "cualquiera", "más o menos", "nada", "mmm", "eh"];
  return t.length < 3 || vague.some(v => t.includes(v));
}
function extractHourlyWage(text) {
  if (!text) return null;
  const m = text.replace(",", ".").match(/(\d{2}(\.\d{1,2})?)/);
  return m ? Number(m[1]) : null;
}
function incRetry(session, step) {
  session.retries[step] = (session.retries[step] || 0) + 1;
  return session.retries[step];
}

app.post("/voice", async (req, res) => {
  if (!BASE_URL) {
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    BASE_URL = `${proto}://${host}`;
  }

  const callSid = req.body.CallSid || "no-call-sid";
  const session = getSession(callSid);
  const step = req.query.step || session.step;
  const speech = (req.body.SpeechResult || "").trim();

  const next = (s) => {
    const order = ["intro", "zona", "residencia", "disponibilidad", "salario", "cierre"];
    const i = Math.max(0, order.indexOf(s));
    return order[Math.min(order.length - 1, i + 1)];
  };

  try {
    const reprompt = async (message, sameStep) => {
      const r = incRetry(session, sameStep);
      const url = await ttsToMp3(r <= MAX_RETRIES ? message : "Ok, sigamos.");
      const go = r <= MAX_RETRIES ? sameStep : next(sameStep);
      session.step = go;
      return res.type("text/xml").send(twimlPlayAndGather(url, `/voice?step=${go}`));
    };

    if (step === "intro") {
      session.step = "zona";
      const url = await ttsToMp3(
        "Hola, ¿cómo estás? Te llamo porque aplicaste para trabajar en New Campo Argentino. " +
        "Mi nombre es Mariana y hago la primera entrevista. ¿Tenés unos minutos ahora? Prometo ser breve."
      );
      return res.type("text/xml").send(twimlPlayAndGather(url, "/voice?step=zona"));
    }

    if (step === "zona") {
      if (isVague(speech)) return reprompt("Perdón, no te escuché bien. ¿En qué zona vivís y si vivís cerca del local?", "zona");
      session.step = "residencia";
      const url = await ttsToMp3("Perfecto. ¿Estás viviendo en Miami permanente o estás por temporada?");
      return res.type("text/xml").send(twimlPlayAndGather(url, "/voice?step=residencia"));
    }

    if (step === "residencia") {
      if (isVague(speech)) return reprompt("¿Me confirmás si estás en Miami fijo o por temporada?", "residencia");
      session.step = "disponibilidad";
      const url = await ttsToMp3("Gracias. ¿Qué días y horarios podés trabajar?");
      return res.type("text/xml").send(twimlPlayAndGather(url, "/voice?step=disponibilidad"));
    }

    if (step === "disponibilidad") {
      if (isVague(speech)) return reprompt("Para que quede claro: ¿qué días y en qué horarios exactos podés trabajar?", "disponibilidad");
      session.step = "salario";
      const url = await ttsToMp3("Perfecto. ¿Cuál es tu expectativa salarial por hora?");
      return res.type("text/xml").send(twimlPlayAndGather(url, "/voice?step=salario"));
    }

    if (step === "salario") {
      const wage = extractHourlyWage(speech);
      if (!wage) return reprompt("¿Me decís un número por hora? Por ejemplo: 18, 20, 22.", "salario");
      const url = await ttsToMp3("Listo. Gracias por tu tiempo. Con esta información seguimos el proceso y te contactamos.");
      sessions.delete(callSid);
      return res.type("text/xml").send(twimlPlayOnly(url));
    }

    const url = await ttsToMp3("Gracias. Seguimos el proceso y te contactamos.");
    sessions.delete(callSid);
    return res.type("text/xml").send(twimlPlayOnly(url));
  } catch {
    return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>Hubo un error técnico. Intentá más tarde.</Say></Response>`);
  }
});

app.get("/health", (_, res) => res.status(200).send("ok"));
app.listen(process.env.PORT || 3000, () => console.log("running"));

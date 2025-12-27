import express from "express";
import bodyParser from "body-parser";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const BUILD_ID = "conversational-v5";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// ---------- ENV ----------
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

let BASE_URL = process.env.BASE_URL || "";

// ---------- AUDIO ----------
const AUDIO_DIR = path.join(process.cwd(), "audio");
fs.mkdirSync(AUDIO_DIR, { recursive: true });

// Twilio <Play> supports audio/ulaw. We'll serve raw ulaw files with that mime type.  [oai_citation:5‡Twilio](https://www.twilio.com/docs/voice/twiml/play?utm_source=chatgpt.com)
app.get("/audio/:file", (req, res) => {
  const file = req.params.file || "";
  if (!/^[a-f0-9]{20}\.ulaw$/.test(file)) return res.status(404).send("not found");
  const fp = path.join(AUDIO_DIR, file);
  if (!fs.existsSync(fp)) return res.status(404).send("not found");
  res.setHeader("Content-Type", "audio/ulaw");
  return res.sendFile(fp);
});

// ---------- DEBUG ----------
app.get("/version", (_, res) => res.status(200).send(BUILD_ID));
app.get("/health", (_, res) => res.status(200).send("ok"));

// ---------- HELPERS ----------
function autodetectBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

function norm(s) { return (s || "").toLowerCase().trim(); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function isPositive(text) {
  const t = norm(text);
  return /^(si|sí|dale|ok|okay|claro|de una|por supuesto)\b/.test(t) || /(tengo tiempo|podemos|ahora sí|ahora si)/.test(t);
}
function isNegative(text) {
  const t = norm(text);
  return /^(no)\b/.test(t) || /(ahora no|no puedo|ocupad|más tarde|luego|después|mañana)/.test(t);
}

function looksEnglish(text) {
  const t = (text || "").toLowerCase();
  const hits = ["i ", "my ", "have ", "worked", "years", "customer", "service", "experience", "restaurant", "orders", "coffee", "thank you"]
    .filter(w => t.includes(w)).length;
  return hits >= 2;
}

// Twilio <Gather> hints improves recognition.  [oai_citation:6‡Twilio](https://www.twilio.com/docs/voice/twiml/gather?utm_source=chatgpt.com)
const SPEECH_HINTS = [
  "Miami", "Miami Beach", "North Beach", "South Beach", "Mid Beach",
  "Aventura", "Sunny Isles", "Hallandale", "Hialeah", "Doral", "Kendall",
  "Brickell", "Wynwood", "Downtown", "Coral Gables", "Westchester",
  "Collins", "71st", "79th"
].join(",");

function twimlPlayAndGather(playUrl, lang = "es-US") {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${playUrl}</Play>
  <Gather input="speech"
          language="${lang}"
          timeout="10"
          speechTimeout="auto"
          hints="${SPEECH_HINTS}"
          action="/voice"
          method="POST"/>
</Response>`;
}

function twimlPlayOnly(playUrl) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Play>${playUrl}</Play></Response>`;
}

// ---------- ElevenLabs TTS (ulaw_8000 is supported output_format)  [oai_citation:7‡ElevenLabs](https://elevenlabs.io/docs/api-reference/text-to-speech/convert/llms.txt) ----------
async function ttsToUlaw(text, previousText = null, languageCode = "es") {
  if (!ELEVEN_KEY || !VOICE_ID) throw new Error("Missing ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID");
  if (!BASE_URL) throw new Error("BASE_URL missing");

  const id = crypto.randomBytes(10).toString("hex");
  const filename = `${id}.ulaw`;
  const outPath = path.join(AUDIO_DIR, filename);

  // optimize_streaming_latency exists; higher values reduce latency at a quality cost. We'll keep it 0 for quality.  [oai_citation:8‡ElevenLabs](https://elevenlabs.io/docs/api-reference/text-to-speech/convert/llms.txt)
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=ulaw_8000&optimize_streaming_latency=0`;

  const body = {
    text,
    model_id: "eleven_multilingual_v2",
    language_code: languageCode, // ISO 639-1 is supported  [oai_citation:9‡ElevenLabs](https://elevenlabs.io/docs/api-reference/text-to-speech/convert/llms.txt)
    voice_settings: {
      // Lower stability = more emotional range; style exaggerates style.  [oai_citation:10‡ElevenLabs](https://elevenlabs.io/docs/api-reference/text-to-speech/convert/llms.txt)
      stability: 0.18,
      similarity_boost: 0.90,
      style: 0.22,
      speed: 0.98,
      use_speaker_boost: true
    }
  };

  // improves continuity across turns  [oai_citation:11‡ElevenLabs](https://elevenlabs.io/docs/api-reference/text-to-speech/convert/llms.txt)
  if (previousText) body.previous_text = previousText;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "xi-api-key": ELEVEN_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`ElevenLabs error: ${resp.status} ${t}`);
  }

  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(outPath, buf);

  return `${BASE_URL}/audio/${filename}`;
}

// ---------- OpenAI JSON extraction (Responses API) ----------
function getResponsesOutputText(respJson) {
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

async function openaiExtractJSON(system, user) {
  if (!OPENAI_KEY) return null;

  const payload = {
    model: OPENAI_MODEL,
    input: [
      { role: "system", content: [{ type: "input_text", text: system }] },
      { role: "user", content: [{ type: "input_text", text: user }] }
    ],
    // JSON mode for Responses uses text.format  [oai_citation:12‡OpenAI Platform](https://platform.openai.com/docs/guides/structured-outputs?utm_source=chatgpt.com)
    text: { format: { type: "json_object" } },
    temperature: 0.2,
    max_output_tokens: 250
  };

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!resp.ok) return null;

  const json = await resp.json();
  const out = getResponsesOutputText(json);
  try { return JSON.parse(out); } catch { return null; }
}

// ---------- Role helpers ----------
function parseRole(text) {
  const t = norm(text);
  if (/(pizza|pizzero|pizza maker)/.test(t)) return "Pizzero";
  if (/(dish|lavaplat|dishwasher)/.test(t)) return "Dishwasher";
  if (/(host|hostess|recepci|anfitr)/.test(t)) return "Hostess";
  if (/(server|runner|meser|camarer)/.test(t)) return "Server/Runner";
  if (/(prep|preparaci)/.test(t)) return "Prep Cook";
  if (/(cook|cocin|line cook|cocina)/.test(t)) return "Cook";
  if (/(front|atenci|barista|caja|café|cafe|jug)/.test(t)) return "Front";
  if (/(trailer)/.test(t)) return "Trailer";
  return null;
}
function isFOH(role) { return ["Front", "Server/Runner", "Hostess"].includes(role); }

// normalize zone for internal storage only (we never repeat it out loud)
function normalizeZone(z) {
  if (!z) return z;
  const t = norm(z);
  if (t.includes("norte beach") || t.includes("north beach")) return "North Beach";
  if (t.includes("south beach") || t.includes("sur beach")) return "South Beach";
  if (t.includes("mid beach")) return "Mid Beach";
  return z.trim();
}

// ---------- Copy (human) ----------
function intro(session) {
  const brand = session.brand;
  const name = session.name ? ` ${session.name}` : "";
  return `Hola${name}, ¿cómo estás? Soy Mariana. Te llamo por tu aplicación a ${brand}. ¿Podés hablar 4 minutitos ahora?`;
}
function askRole() {
  return pick([
    "Perfecto. ¿Para qué puesto aplicaste?",
    "Dale. ¿Qué puesto estás buscando?"
  ]);
}
function askExperience(role) {
  const r = role && role !== "Unknown" ? `de ${role}` : "en restaurantes";
  return pick([
    `Buenísimo. Contame rápido: ¿hace cuánto estás en el rubro ${r}? ¿y dónde fue tu último laburo?`,
    `Ok. ¿Cuántos años de experiencia tenés ${r}? ¿y en qué lugar trabajaste último?`
  ]);
}
function askRoleSpecific(role) {
  if (role === "Cook" || role === "Prep Cook") return pick([
    "En cocina, ¿qué manejás mejor: plancha, parrilla, freidora, producción?",
    "¿Qué estación te queda más cómoda en cocina?"
  ]);
  if (role === "Pizzero") return pick([
    "Para pizza: ¿hacés masa y armado, o más horneado y despacho?",
    "¿Qué tipo de pizza hacías y con qué horno trabajaste?"
  ]);
  if (role === "Front") return pick([
    "En front: ¿te manejás con café, caja y tomar órdenes?",
    "¿Tenés experiencia con café o jugos, y cobrando en caja?"
  ]);
  if (role === "Server/Runner") return pick([
    "En salón: ¿más server, runner o los dos?",
    "¿Con volumen te sentís cómodo?"
  ]);
  if (role === "Hostess") return pick([
    "¿Te manejás recibiendo gente y organizando mesas?",
    "¿Tenés experiencia con listas y ritmo de entrada/salida?"
  ]);
  if (role === "Dishwasher") return pick([
    "¿Tenés experiencia en dishwasher con volumen?",
    "¿Te sentís cómodo con ritmo rápido y limpieza de cocina?"
  ]);
  return "Perfecto. ¿Qué hacías normalmente en tu último trabajo?";
}
function askEnglish() {
  return pick([
    "Te hago una en inglés, re corta: en una frase, contame tu última experiencia en restaurantes.",
    "Rápido en inglés: decime una frase sobre tu experiencia atendiendo clientes."
  ]);
}
function askLogistics() {
  return pick([
    "Bien. ¿En qué zona vivís? ¿Y estás en Miami fijo o por temporada?",
    "Para ubicarte: ¿en qué zona estás viviendo? ¿Fijo en Miami o temporal?"
  ]);
}
function askSeasonEnd() {
  return pick([
    "Perfecto. ¿Hasta cuándo te quedás más o menos?",
    "¿Hasta qué fecha pensás quedarte?"
  ]);
}
function askAvailSalary() {
  return pick([
    "Dale. ¿Qué días y horarios podés trabajar? ¿Y cuánto por hora estás buscando?",
    "Ok. ¿Cómo es tu disponibilidad? ¿Y por hora… en qué número estás?"
  ]);
}
function askStart() {
  return pick([
    "Y ya cierro: ¿cuándo podrías empezar?",
    "Última: ¿cuándo arrancarías?"
  ]);
}
function close() {
  return pick([
    "Listo. Gracias por tu tiempo. Te escribimos por WhatsApp con el próximo paso.",
    "Perfecto, gracias. Quedamos en contacto por WhatsApp."
  ]);
}

// ---------- Sessions ----------
const sessions = new Map();

function createSession(callSid, req) {
  return {
    brand: (req.query.brand || "New Campo Argentino").toString(),
    role: (req.query.role || "").toString() || null,
    name: (req.query.name || "").toString() || null,

    step: "start",
    turns: 0,
    attempts: {
      consent: 0,
      role: 0,
      experience: 0,
      english: 0,
      logistics: 0,
      season_end: 0,
      avail_salary: 0
    },
    data: {
      role: null,
      years_exp: null,
      last_job: null,
      tasks: null,
      english_ok: null,
      english_sample: null,
      zona: null,
      residencia: null,        // "permanente" | "temporada"
      temporada_hasta: null,
      disponibilidad: null,
      salario: null,
      start_date: null
    },
    last_bot: null
  };
}

function getSession(callSid, req) {
  if (!sessions.has(callSid)) sessions.set(callSid, createSession(callSid, req));
  return sessions.get(callSid);
}

// ---------- Main ----------
app.post("/voice", async (req, res) => {
  if (!BASE_URL) BASE_URL = autodetectBaseUrl(req);

  const callSid = req.body.CallSid || "no-call-sid";
  const session = getSession(callSid, req);

  const speech = (req.body.SpeechResult || "").trim();
  session.turns += 1;

  // Hard stop to prevent endless loops
  if (session.turns > 14) {
    const u = await ttsToUlaw("Perfecto. Gracias por tu tiempo. Te contactamos después.", session.last_bot, "es");
    sessions.delete(callSid);
    return res.type("text/xml").send(twimlPlayOnly(u));
  }

  try {
    // START
    if (session.step === "start") {
      const txt = intro(session);
      const u = await ttsToUlaw(txt, session.last_bot, "es");
      session.last_bot = txt;
      session.step = "consent";
      return res.type("text/xml").send(twimlPlayAndGather(u, "es-US"));
    }

    // no speech
    if (!speech) {
      const txt = pick(["Perdón, no te escuché. ¿Me repetís?", "Se cortó un poquito. ¿Me lo decís de nuevo?"]);
      const u = await ttsToUlaw(txt, session.last_bot, "es");
      session.last_bot = txt;
      return res.type("text/xml").send(twimlPlayAndGather(u, "es-US"));
    }

    // CONSENT
    if (session.step === "consent") {
      if (isNegative(speech)) {
        const txt = "Dale, cero problema. Te escribimos para coordinar. Gracias.";
        const u = await ttsToUlaw(txt, session.last_bot, "es");
        sessions.delete(callSid);
        return res.type("text/xml").send(twimlPlayOnly(u));
      }
      session.step = session.role ? "experience" : "role";
      const txt = session.step === "role" ? askRole() : askExperience(session.role);
      const u = await ttsToUlaw(txt, session.last_bot, "es");
      session.last_bot = txt;
      return res.type("text/xml").send(twimlPlayAndGather(u, "es-US"));
    }

    // ROLE
    if (session.step === "role") {
      let r = parseRole(speech);
      if (!r && OPENAI_KEY) {
        const system = `Return ONLY JSON: {"role": "Front"|"Cook"|"Prep Cook"|"Pizzero"|"Server/Runner"|"Hostess"|"Dishwasher"|"Trailer"|null}`;
        const user = `Candidate said: "${speech}"`;
        const out = await openaiExtractJSON(system, user);
        if (out?.role) r = out.role;
      }
      if (r) session.role = r;
      if (!session.role) {
        session.attempts.role += 1;
        if (session.attempts.role < 2) {
          const txt = "¿Qué puesto sería? Por ejemplo: server, cook, prep, front, hostess, dishwasher o pizzero.";
          const u = await ttsToUlaw(txt, session.last_bot, "es");
          session.last_bot = txt;
          return res.type("text/xml").send(twimlPlayAndGather(u, "es-US"));
        }
        session.role = "Unknown";
      }
      session.step = "experience";
      const txt = askExperience(session.role);
      const u = await ttsToUlaw(txt, session.last_bot, "es");
      session.last_bot = txt;
      return res.type("text/xml").send(twimlPlayAndGather(u, "es-US"));
    }

    // EXPERIENCE
    if (session.step === "experience") {
      if (OPENAI_KEY) {
        const system = `
Output ONLY JSON:
{"years_exp": string|null, "last_job": string|null}
Rules:
- years_exp: number string like "2","5" if present.
- last_job: keep proper nouns as-is (do NOT translate).
`.trim();
        const user = `Role: ${session.role}\nCandidate: "${speech}"`;
        const out = await openaiExtractJSON(system, user);
        if (out?.years_exp && !session.data.years_exp) session.data.years_exp = String(out.years_exp).trim();
        if (out?.last_job && !session.data.last_job) session.data.last_job = String(out.last_job).trim();
      }
      if (!session.data.years_exp) {
        const m = speech.match(/(\d{1,2})\s*(años|anos|years)/i);
        if (m) session.data.years_exp = m[1];
      }
      if (!session.data.years_exp && !session.data.last_job) {
        session.attempts.experience += 1;
        if (session.attempts.experience < 2) {
          const txt = "Dale. ¿Cuántos años de experiencia tenés? ¿y dónde fue tu último laburo?";
          const u = await ttsToUlaw(txt, session.last_bot, "es");
          session.last_bot = txt;
          return res.type("text/xml").send(twimlPlayAndGather(u, "es-US"));
        }
      }
      session.step = "tasks";
      const txt = askRoleSpecific(session.role);
      const u = await ttsToUlaw(txt, session.last_bot, "es");
      session.last_bot = txt;
      return res.type("text/xml").send(twimlPlayAndGather(u, "es-US"));
    }

    // TASKS
    if (session.step === "tasks") {
      if (!session.data.tasks) session.data.tasks = speech;

      if (isFOH(session.role)) {
        session.step = "english";
        const txt = askEnglish();
        const u = await ttsToUlaw(txt, session.last_bot, "en");
        session.last_bot = txt;
        return res.type("text/xml").send(twimlPlayAndGather(u, "en-US"));
      } else {
        session.step = "logistics";
        const txt = askLogistics();
        const u = await ttsToUlaw(txt, session.last_bot, "es");
        session.last_bot = txt;
        return res.type("text/xml").send(twimlPlayAndGather(u, "es-US"));
      }
    }

    // ENGLISH
    if (session.step === "english") {
      session.data.english_sample = speech;
      session.data.english_ok = looksEnglish(speech);
      session.step = "logistics";
      const txt = askLogistics();
      const u = await ttsToUlaw(txt, session.last_bot, "es");
      session.last_bot = txt;
      return res.type("text/xml").send(twimlPlayAndGather(u, "es-US"));
    }

    // LOGISTICS (zona + residencia)
    if (session.step === "logistics") {
      if (OPENAI_KEY) {
        const system = `
Output ONLY JSON:
{"zona": string|null, "residencia": "permanente"|"temporada"|null}
Rules:
- Keep place names as-is, do NOT translate.
- If vague, null.
`.trim();
        const user = `Candidate: "${speech}"`;
        const out = await openaiExtractJSON(system, user);
        if (out?.zona && !session.data.zona) session.data.zona = normalizeZone(String(out.zona));
        if ((out?.residencia === "permanente" || out?.residencia === "temporada") && !session.data.residencia) {
          session.data.residencia = out.residencia;
        }
      }

      // heuristics backup
      if (!session.data.zona && speech.length >= 4) session.data.zona = normalizeZone(speech);
      const t = norm(speech);
      if (!session.data.residencia) {
        if (/(permanente|fijo|estable|vivo acá|resido)/.test(t)) session.data.residencia = "permanente";
        if (/(temporada|por un tiempo|unos meses|de visita|vacaciones|snowbird)/.test(t)) session.data.residencia = "temporada";
      }

      const missingZona = !session.data.zona;
      const missingRes = !session.data.residencia;

      if (missingZona || missingRes) {
        session.attempts.logistics += 1;
        if (session.attempts.logistics < 2) {
          const txt = missingZona && missingRes
            ? "Perdón, rapidito: ¿en qué zona vivís? ¿y estás fijo en Miami o por temporada?"
            : (missingZona ? "¿En qué zona vivís?" : "¿Estás fijo en Miami o por temporada?");
          const u = await ttsToUlaw(txt, session.last_bot, "es");
          session.last_bot = txt;
          return res.type("text/xml").send(twimlPlayAndGather(u, "es-US"));
        }
      }

      if (session.data.residencia === "temporada" && !session.data.temporada_hasta) {
        session.step = "season_end";
        const txt = askSeasonEnd();
        const u = await ttsToUlaw(txt, session.last_bot, "es");
        session.last_bot = txt;
        return res.type("text/xml").send(twimlPlayAndGather(u, "es-US"));
      }

      session.step = "avail_salary";
      const txt = askAvailSalary();
      const u = await ttsToUlaw(txt, session.last_bot, "es");
      session.last_bot = txt;
      return res.type("text/xml").send(twimlPlayAndGather(u, "es-US"));
    }

    // SEASON END
    if (session.step === "season_end") {
      if (OPENAI_KEY) {
        const system = `Return ONLY JSON: {"temporada_hasta": string|null}`;
        const user = `Candidate: "${speech}"`;
        const out = await openaiExtractJSON(system, user);
        if (out?.temporada_hasta && !session.data.temporada_hasta) session.data.temporada_hasta = String(out.temporada_hasta).trim();
      }
      if (!session.data.temporada_hasta) session.data.temporada_hasta = speech;

      session.step = "avail_salary";
      const txt = askAvailSalary();
      const u = await ttsToUlaw(txt, session.last_bot, "es");
      session.last_bot = txt;
      return res.type("text/xml").send(twimlPlayAndGather(u, "es-US"));
    }

    // AVAIL + SALARY
    if (session.step === "avail_salary") {
      if (OPENAI_KEY) {
        const system = `
Output ONLY JSON:
{"disponibilidad": string|null, "salario": string|null}
Rules:
- salario must be a number like "18" or "20.5", else null.
- disponibilidad: days/hours.
`.trim();
        const user = `Candidate: "${speech}"`;
        const out = await openaiExtractJSON(system, user);
        if (out?.disponibilidad && !session.data.disponibilidad) session.data.disponibilidad = String(out.disponibilidad).trim();
        if (out?.salario && !session.data.salario) {
          const m = String(out.salario).replace(",", ".").match(/(\d{2}(\.\d{1,2})?)/);
          if (m) session.data.salario = m[1];
        }
      }

      if (!session.data.salario) {
        const m = speech.replace(",", ".").match(/(\d{2}(\.\d{1,2})?)/);
        if (m) session.data.salario = m[1];
      }
      if (!session.data.disponibilidad && speech.length >= 6) session.data.disponibilidad = speech;

      const missingDisp = !session.data.disponibilidad;
      const missingSal = !session.data.salario;

      if (missingDisp || missingSal) {
        session.attempts.avail_salary += 1;
        if (session.attempts.avail_salary < 2) {
          const txt = missingDisp && missingSal
            ? "Perdón, para dejarlo claro: ¿qué disponibilidad tenés? ¿y cuánto por hora?"
            : (missingDisp ? "¿Qué disponibilidad tenés? Días y horarios." : "¿Cuánto por hora estás buscando? Un número.");
          const u = await ttsToUlaw(txt, session.last_bot, "es");
          session.last_bot = txt;
          return res.type("text/xml").send(twimlPlayAndGather(u, "es-US"));
        }
      }

      // close with start date
      session.step = "start";
      const txt = askStart();
      const u = await ttsToUlaw(txt, session.last_bot, "es");
      session.last_bot = txt;
      return res.type("text/xml").send(twimlPlayAndGather(u, "es-US"));
    }

    // START DATE
    if (session.step === "start") {
      session.data.start_date = speech;
      const txt = close();
      const u = await ttsToUlaw(txt, session.last_bot, "es");
      sessions.delete(callSid);
      return res.type("text/xml").send(twimlPlayOnly(u));
    }

    // default close
    const u = await ttsToUlaw("Perfecto, gracias. Te contactamos.", session.last_bot, "es");
    sessions.delete(callSid);
    return res.type("text/xml").send(twimlPlayOnly(u));
  } catch (e) {
    console.error("VOICE ERROR:", e);
    return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>Hubo un error técnico. Intentá más tarde.</Say></Response>`);
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("running", BUILD_ID);
});

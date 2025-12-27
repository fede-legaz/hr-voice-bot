import express from "express";
import bodyParser from "body-parser";
import fs from "fs";
import path from "path";
import crypto from "crypto";

// -------------------- App --------------------
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// -------------------- Static audio --------------------
const AUDIO_DIR = path.join(process.cwd(), "audio");
fs.mkdirSync(AUDIO_DIR, { recursive: true });
app.use("/audio", express.static(AUDIO_DIR));

// -------------------- ENV --------------------
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

let BASE_URL = process.env.BASE_URL || "";

// -------------------- Config --------------------
const SLOT_ORDER = ["zona", "residencia", "disponibilidad", "salario"];
const MAX_ATTEMPTS_PER_SLOT = 2;     // máximo repreguntas por dato
const MAX_CONFIRM_ATTEMPTS = 1;      // confirmación final 1 vez
const MAX_TURNS = 14;                // kill switch para evitar loops por cualquier bug

// Speech hints para Twilio (mejora transcripción de zonas)
const SPEECH_HINTS_ES = [
  "Miami", "Miami Beach", "North Beach", "South Beach", "Mid Beach",
  "Aventura", "Sunny Isles", "Hallandale", "Hialeah", "Doral", "Kendall",
  "Westchester", "Coral Gables", "Brickell", "Wynwood", "Downtown",
  "Collins", "71st", "79th", "Flagler", "Little Havana"
].join(",");

// -------------------- Sessions (in-memory MVP) --------------------
const sessions = new Map(); // CallSid -> session

function now() { return Date.now(); }
function choose(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function createSession(callSid, req) {
  const brand = (req.query.brand || "New Campo Argentino").toString();
  const role = (req.query.role || "").toString() || null;
  const name = (req.query.name || "").toString() || null;

  return {
    brand,
    role,
    name,

    stage: "intro", // intro -> availability -> collect -> confirm -> done
    slot: "zona",
    attempts: { zona: 0, residencia: 0, disponibilidad: 0, salario: 0, confirm: 0, noinput: 0 },

    data: {
      zona: null,
      residencia: null,        // "permanente" | "temporada" | null
      temporada_hasta: null,   // texto libre opcional
      disponibilidad: null,
      salario: null            // texto/número
    },

    last_bot: null,
    turns: 0,
    created_at: now()
  };
}

function getSession(callSid, req) {
  if (!sessions.has(callSid)) sessions.set(callSid, createSession(callSid, req));
  return sessions.get(callSid);
}

// -------------------- Base URL autodetect --------------------
function autodetectBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

// -------------------- TwiML --------------------
function twimlPlayAndGather(playUrl, actionUrl, lang = "es-US") {
  // hints: mejora zona/places
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${playUrl}</Play>
  <Gather input="speech"
          language="${lang}"
          timeout="10"
          speechTimeout="auto"
          hints="${SPEECH_HINTS_ES}"
          action="${actionUrl}"
          method="POST"/>
</Response>`;
}

function twimlPlayOnly(playUrl) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Play>${playUrl}</Play></Response>`;
}

// -------------------- ElevenLabs TTS --------------------
async function ttsToMp3(text) {
  if (!ELEVEN_KEY || !VOICE_ID) throw new Error("Missing ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID");

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
        // Ajustes para que suene MENOS “locutora/robot” en teléfono
        stability: 0.25,
        similarity_boost: 0.88,
        // si tu cuenta lo soporta, ayuda un poco:
        use_speaker_boost: true
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

// -------------------- Utility: detect yes/no --------------------
function norm(s) { return (s || "").toLowerCase().trim(); }

function isPositive(text) {
  const t = norm(text);
  return /^(si|sí|dale|ok|okay|claro|de una|por supuesto|sure|yes)\b/.test(t) ||
         /(puedo|hablemos|tengo tiempo|ahora si|ahora sí)/.test(t);
}
function isNegative(text) {
  const t = norm(text);
  return /(ahora no|no puedo|ocupad|en un rato|más tarde|luego|después|mañana|busy|can't|cannot|later)/.test(t) ||
         /^(no)\b/.test(t);
}
function isVague(text) {
  const t = norm(text);
  if (!t || t.length < 3) return true;
  if (/^(si|sí|no|ok|okay|dale|ajá|aja)\b$/.test(t)) return true;
  if (/(depende|cualquiera|cuando pueda|no se|no sé|más o menos|da igual)/.test(t)) return true;
  return false;
}

// -------------------- Heuristic extraction (fast) --------------------
function extractHeuristic(text) {
  const t = norm(text);
  const out = {
    zona: null,
    residencia: null,
    temporada_hasta: null,
    disponibilidad: null,
    salario: null
  };

  // salario (buscar números razonables)
  {
    const cleaned = (text || "").replace(",", ".");
    const m = cleaned.match(/(\d{2}(\.\d{1,2})?)/); // 18, 20, 22.5
    if (m) {
      const n = Number(m[1]);
      if (n >= 10 && n <= 80) out.salario = `${m[1]}`;
    }
  }

  // residencia
  if (/(permanente|fijo|estable|me mud|vivo acá|vivo aqui|vivo aquí|resido)/.test(t)) out.residencia = "permanente";
  if (/(temporada|por un tiempo|unos meses|vacaciones|de visita|snowbird)/.test(t)) out.residencia = "temporada";
  // “hasta X”
  const hasta = (text || "").match(/hasta\s+([a-zA-ZñÑáéíóúÁÉÍÓÚ0-9 ]{3,20})/i);
  if (hasta) out.temporada_hasta = hasta[1].trim();

  // disponibilidad (días/horarios)
  if (/(lun|mar|mie|mié|jue|vie|sab|sáb|dom|lunes|martes|miércoles|jueves|viernes|sábado|domingo|weekend|fin de semana|am|pm|\d{1,2}(:\d{2})?)/.test(t)) {
    if (!isVague(text)) out.disponibilidad = (text || "").trim();
  }

  // zona (lugares comunes / “vivo en X”)
  if (/(miami|beach|north|south|mid|aventura|sunny|hialeah|doral|kendall|brickell|wynwood|downtown|coral gables|westchester|little havana|collins|71st|79th)/.test(t)) {
    if (!isVague(text)) out.zona = (text || "").trim();
  }
  if (/(vivo en|estoy en|soy de)/.test(t) && !isVague(text)) out.zona = out.zona || (text || "").trim();

  return out;
}

// -------------------- OpenAI output text reader --------------------
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

// -------------------- AI extraction (only extract, NO decision) --------------------
async function extractWithAI(session, userText) {
  if (!OPENAI_KEY) return null;

  const sys = `
Extraés información de una respuesta de un candidato por teléfono.
Devolvés SOLO JSON válido con estas claves exactas:
{
  "zona": string|null,
  "residencia": "permanente"|"temporada"|null,
  "temporada_hasta": string|null,
  "disponibilidad": string|null,
  "salario": string|null
}
Reglas:
- No inventes. Solo completá si está implícito o explícito.
- "salario" tiene que ser un número (ej "20" o "22.5"). Si no hay número, null.
- "zona" puede ser barrio/ciudad/zona (ej "North Beach", "Hialeah", etc). Si es vago, null.
- Si dice "temporada", y menciona hasta cuándo, ponelo en temporada_hasta.
`.trim();

  const userPrompt =
`Marca: ${session.brand}
Rol: ${session.role || "N/A"}
Datos ya capturados: ${JSON.stringify(session.data)}
Texto del candidato: ${userText || ""}`;

  const payload = {
    model: OPENAI_MODEL,
    input: [
      { role: "system", content: [{ type: "input_text", text: sys }] },
      { role: "user", content: [{ type: "input_text", text: userPrompt }] }
    ],
    text: { format: { type: "json_object" } },
    temperature: 0.2,
    max_output_tokens: 250
  };

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!resp.ok) return null;

  const data = await resp.json();
  const out = getResponsesOutputText(data);

  try {
    const obj = JSON.parse(out);
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

// -------------------- Slot engine --------------------
function slotFilled(session, slot) {
  const d = session.data;
  if (slot === "zona") return !!d.zona;
  if (slot === "residencia") return !!d.residencia;
  if (slot === "disponibilidad") return !!d.disponibilidad;
  if (slot === "salario") return !!d.salario;
  return false;
}

function advanceToNextSlot(session) {
  for (const s of SLOT_ORDER) {
    if (!slotFilled(session, s) && session.attempts[s] < MAX_ATTEMPTS_PER_SLOT) {
      session.slot = s;
      return;
    }
  }
  session.slot = null; // ya no hay slots pendientes o ya excedió intentos
}

function applyUpdates(session, updates, allowOverwrite = false) {
  if (!updates || typeof updates !== "object") return;
  const d = session.data;

  const setIf = (key, val) => {
    if (val === undefined || val === null) return;
    const v = String(val).trim();
    if (!v) return;
    if (isVague(v)) return;
    if (allowOverwrite || !d[key]) d[key] = v;
  };

  // zona
  if (updates.zona) setIf("zona", updates.zona);

  // residencia
  if (updates.residencia === "permanente" || updates.residencia === "temporada") {
    if (allowOverwrite || !d.residencia) d.residencia = updates.residencia;
  }

  // temporada_hasta
  if (updates.temporada_hasta) {
    const v = String(updates.temporada_hasta).trim();
    if (v && (allowOverwrite || !d.temporada_hasta)) d.temporada_hasta = v;
  }

  // disponibilidad
  if (updates.disponibilidad) setIf("disponibilidad", updates.disponibilidad);

  // salario
  if (updates.salario) {
    const cleaned = String(updates.salario).replace(",", ".").trim();
    const m = cleaned.match(/(\d{2}(\.\d{1,2})?)/);
    if (m) {
      const n = Number(m[1]);
      if (n >= 10 && n <= 80) {
        if (allowOverwrite || !d.salario) d.salario = m[1];
      }
    }
  }
}

function ackText() {
  return choose([
    "Perfecto.",
    "Dale, anotado.",
    "Buenísimo.",
    "Genial, gracias."
  ]);
}

function askForSlot(session) {
  const d = session.data;
  const slot = session.slot;

  if (slot === "zona") {
    return choose([
      "Para ubicarte rápido: ¿en qué zona vivís? ¿Te queda cómodo venir al local?",
      "Rápido y fácil: ¿en qué zona estás viviendo ahora? ¿Te queda cerca el restaurante?"
    ]);
  }

  if (slot === "residencia") {
    // Si ya dijo temporada pero no dijo hasta cuándo, hacemos UNA repregunta suave.
    if (d.residencia === "temporada" && !d.temporada_hasta && session.attempts.residencia === 0) {
      return "Perfecto. ¿Estás acá por temporada, no? ¿Hasta cuándo pensás quedarte más o menos?";
    }
    return choose([
      "Gracias. ¿Estás viviendo en Miami fijo, o estás acá por una temporada?",
      "¿Estás instalado en Miami o es algo temporal por un tiempo?"
    ]);
  }

  if (slot === "disponibilidad") {
    return choose([
      "¿Qué días y horarios podés trabajar? Si podés, decímelo bien concreto.",
      "¿Cómo es tu disponibilidad? Días y horarios, así tal cual."
    ]);
  }

  if (slot === "salario") {
    return choose([
      "Y para cerrar: ¿cuánto estás buscando por hora, más o menos? Decime un número.",
      "Última: ¿cuál es tu expectativa salarial por hora? Un número y listo."
    ]);
  }

  return "Perfecto.";
}

function residenciaToHuman(d) {
  if (d.residencia === "permanente") return "vivís en Miami fijo";
  if (d.residencia === "temporada") {
    if (d.temporada_hasta) return `estás por temporada (hasta ${d.temporada_hasta})`;
    return "estás por temporada";
  }
  return null;
}

function buildConfirm(session) {
  const d = session.data;
  const parts = [];

  if (d.zona) parts.push(`vivís por ${d.zona}`);
  const r = residenciaToHuman(d);
  if (r) parts.push(r);
  if (d.disponibilidad) parts.push(`tu disponibilidad es: ${d.disponibilidad}`);
  if (d.salario) parts.push(`y buscás ${d.salario} por hora`);

  if (parts.length === 0) {
    return "Perfecto. Gracias por tu tiempo. Con esta info seguimos el proceso y te contactamos.";
  }

  return `Perfecto. Te confirmo para asegurarme que lo anoté bien: ${parts.join(", ")}. ¿Está bien así?`;
}

function buildClosing() {
  return choose([
    "Listo, gracias. Con esto seguimos el proceso y te contactamos.",
    "Perfecto, gracias por tu tiempo. Te contactamos con los próximos pasos.",
    "Buenísimo. Gracias, y quedamos en contacto."
  ]);
}

// -------------------- Main Twilio webhook --------------------
app.post("/voice", async (req, res) => {
  if (!BASE_URL) BASE_URL = autodetectBaseUrl(req);

  const callSid = req.body.CallSid || "no-call-sid";
  const session = getSession(callSid, req);

  const speech = (req.body.SpeechResult || "").trim();

  // Anti-loop global
  session.turns += 1;
  if (session.turns > MAX_TURNS) {
    const url = await ttsToMp3("Dale, perfecto. Gracias por tu tiempo. Te contacto por los próximos pasos.");
    sessions.delete(callSid);
    return res.type("text/xml").send(twimlPlayOnly(url));
  }

  try {
    // --------------- Stage: intro (first turn) ---------------
    if (session.stage === "intro") {
      const intro =
        `Hola, ¿cómo estás? Soy Mariana. Te llamo porque aplicaste para ${session.brand}. ` +
        "¿Te viene bien hablar dos minutitos ahora?";
      session.last_bot = intro;
      session.stage = "availability";

      const url = await ttsToMp3(intro);
      return res.type("text/xml").send(twimlPlayAndGather(url, "/voice", "es-US"));
    }

    // --------------- No input handling ---------------
    if (!speech) {
      session.attempts.noinput += 1;
      if (session.attempts.noinput >= 2) {
        const url = await ttsToMp3("No te escucho bien. No pasa nada, lo dejamos acá y te contactamos después. Gracias.");
        sessions.delete(callSid);
        return res.type("text/xml").send(twimlPlayOnly(url));
      }
      const url = await ttsToMp3("Perdón, se escuchó bajito. ¿Me lo repetís, porfa?");
      return res.type("text/xml").send(twimlPlayAndGather(url, "/voice", "es-US"));
    }

    // --------------- Stage: availability ---------------
    if (session.stage === "availability") {
      if (isNegative(speech)) {
        const url = await ttsToMp3("Dale, cero problema. No te robo tiempo. Te contacto para coordinar. Gracias.");
        sessions.delete(callSid);
        return res.type("text/xml").send(twimlPlayOnly(url));
      }

      // si es positivo o ambiguo, avanzamos igual
      session.stage = "collect";
      session.slot = "zona";

      const msg = `${ackText()} ${askForSlot(session)}`;
      session.last_bot = msg;

      const url = await ttsToMp3(msg);
      return res.type("text/xml").send(twimlPlayAndGather(url, "/voice", "es-US"));
    }

    // --------------- Stage: collect ---------------
    if (session.stage === "collect") {
      // 1) heurística
      const h = extractHeuristic(speech);
      applyUpdates(session, h, false);

      // 2) IA extractor (solo para mejorar “entender”)
      // Solo llamamos IA si todavía falta algo importante o si el slot actual sigue vacío
      const before = JSON.stringify(session.data);
      const slotBefore = session.slot;

      const needAI =
        (slotBefore && !slotFilled(session, slotBefore)) ||
        (!session.data.zona || !session.data.residencia || !session.data.disponibilidad || !session.data.salario);

      if (needAI) {
        const ai = await extractWithAI(session, speech);
        if (ai) applyUpdates(session, ai, false);
      }

      // 3) Avance controlado del slot (sin loops)
      const slot = session.slot;

      if (slot && slotFilled(session, slot)) {
        // completó el slot que buscábamos: avanzar
        session.attempts[slot] = 0; // reset por prolijidad
      } else if (slot) {
        // no completó el slot: contar intento
        session.attempts[slot] += 1;
      }

      // recalcular próximo slot pendiente
      advanceToNextSlot(session);

      // Si ya no queda nada por pedir -> confirmación final
      if (!session.slot) {
        session.stage = "confirm";
        const confirm = buildConfirm(session);
        session.last_bot = confirm;

        const url = await ttsToMp3(confirm);
        return res.type("text/xml").send(twimlPlayAndGather(url, "/voice", "es-US"));
      }

      // Si este slot ya excedió intentos, NO lo repreguntamos: avanzamos al siguiente automáticamente
      // (advanceToNextSlot ya lo hace, pero aquí hacemos el mensaje humano)
      const msg = `${ackText()} ${askForSlot(session)}`;
      session.last_bot = msg;

      const url = await ttsToMp3(msg);
      return res.type("text/xml").send(twimlPlayAndGather(url, "/voice", "es-US"));
    }

    // --------------- Stage: confirm ---------------
    if (session.stage === "confirm") {
      if (isPositive(speech)) {
        const closing = buildClosing();
        const url = await ttsToMp3(closing);
        sessions.delete(callSid);
        return res.type("text/xml").send(twimlPlayOnly(url));
      }

      // Si dice “no”, intentamos capturar corrección UNA vez y cerrar
      session.attempts.confirm += 1;

      // Aplicamos extracción PERO permitimos overwrite (correcciones)
      const h = extractHeuristic(speech);
      applyUpdates(session, h, true);
      const ai = await extractWithAI(session, speech);
      if (ai) applyUpdates(session, ai, true);

      if (session.attempts.confirm <= MAX_CONFIRM_ATTEMPTS) {
        const confirm2 = buildConfirm(session);
        session.last_bot = confirm2;

        const url = await ttsToMp3(confirm2);
        return res.type("text/xml").send(twimlPlayAndGather(url, "/voice", "es-US"));
      }

      const closing = buildClosing();
      const url = await ttsToMp3(closing);
      sessions.delete(callSid);
      return res.type("text/xml").send(twimlPlayOnly(url));
    }

    // fallback (no debería llegar)
    const url = await ttsToMp3(buildClosing());
    sessions.delete(callSid);
    return res.type("text/xml").send(twimlPlayOnly(url));
  } catch (e) {
    console.error("VOICE ERROR:", e);
    return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>Hubo un error técnico. Intentá más tarde.</Say></Response>`);
  }
});

// Health check
app.get("/health", (_, res) => res.status(200).send("ok"));

app.listen(process.env.PORT || 3000, () => console.log("running"));

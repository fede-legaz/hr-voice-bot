"use strict";

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const { createPortalStore } = require("./store");
const { renderApplyPage } = require("./templates");
const { renderCareersPage } = require("./careers-template");
const {
  randomToken,
  safeSlug,
  parseDataUrl,
  sanitizeFilename,
  normalizePhone,
  truncateText
} = require("./utils");

const RESUME_MIME = new Set([
  "application/pdf",
  "text/plain",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
]);
const IMAGE_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/x-icon",
  "image/vnd.microsoft.icon"
]);

const SCREENING_CALL_DELAY_MS = Math.max(0, Number(process.env.SCREENING_CALL_DELAY_MS || 30000) || 30000);
const SCREENING_OFFER_TTL_MS = 30 * 60 * 1000;

const APPLY_CODE_LENGTH = Math.max(4, Math.min(10, Number(process.env.APPLY_CODE_LENGTH || 6) || 6));

const MIME_EXT = {
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/x-icon": ".ico",
  "image/vnd.microsoft.icon": ".ico"
};

function ensureDir(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }
}

function resolveUploadsBaseUrl(value) {
  if (!value) return "/uploads";
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function extForMime(mime, fallbackName) {
  const known = MIME_EXT[mime];
  if (known) return known;
  const fallback = path.extname(fallbackName || "");
  if (fallback) return fallback.toLowerCase();
  return ".bin";
}

function generateApplicationCode(length = APPLY_CODE_LENGTH) {
  const size = Math.max(4, Math.min(10, Number(length) || 6));
  let out = "";
  for (let i = 0; i < size; i += 1) {
    out += String(crypto.randomInt(0, 10));
  }
  return out;
}

async function saveBufferFile({ uploadsDir, relDir, fileName, buffer, contentType, uploadToSpaces, publicUploadsBaseUrl }) {
  const safeName = sanitizeFilename(fileName || "file");
  const relPath = path.posix.join(relDir, safeName);
  if (uploadToSpaces) {
    await uploadToSpaces({ key: relPath, body: buffer, contentType });
    const url = publicUploadsBaseUrl ? `${publicUploadsBaseUrl}/${relPath}` : relPath;
    return { fullPath: "", relPath, url };
  }
  const fullDir = path.join(uploadsDir, relDir);
  ensureDir(fullDir);
  const fullPath = path.join(fullDir, safeName);
  await fs.promises.writeFile(fullPath, buffer);
  const url = publicUploadsBaseUrl ? `${publicUploadsBaseUrl}/${relPath}` : relPath;
  return { fullPath, relPath, url };
}

async function saveDataUrlFile({ dataUrl, uploadsDir, relDir, fileName, maxBytes, allowedMime, uploadToSpaces, publicUploadsBaseUrl }) {
  if (!dataUrl) return null;
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) throw new Error("invalid_data_url");
  if (allowedMime && !allowedMime.has(parsed.mime)) {
    throw new Error("unsupported_file_type");
  }
  if (maxBytes && parsed.buffer.length > maxBytes) {
    throw new Error("file_too_large");
  }
  const ext = extForMime(parsed.mime, fileName);
  const safeName = sanitizeFilename(path.basename(fileName || "file")) || "file";
  const finalName = safeName.endsWith(ext) ? safeName : safeName + ext;
  return saveBufferFile({
    uploadsDir,
    relDir,
    fileName: finalName,
    buffer: parsed.buffer,
    contentType: parsed.mime,
    uploadToSpaces,
    publicUploadsBaseUrl
  });
}

function buildCvText(app, page) {
  const lines = [];
  if (app.name) lines.push(`Name: ${app.name}`);
  if (app.email) lines.push(`Email: ${app.email}`);
  if (app.phone) lines.push(`Phone: ${app.phone}`);
  const roleLabels = [];
  if (Array.isArray(app.roles)) {
    app.roles.forEach((role) => {
      if (!role) return;
      if (typeof role === "string") {
        roleLabels.push(role);
        return;
      }
      const label = role.label || role.key || role.value || "";
      if (typeof label === "string" && label) {
        roleLabels.push(label);
        return;
      }
      if (label && typeof label === "object") {
        const text = label.es || label.en || "";
        if (text) roleLabels.push(text);
      }
    });
  } else if (app.answers && Array.isArray(app.answers.__roles)) {
    app.answers.__roles.forEach((role) => {
      if (!role) return;
      if (typeof role === "string") {
        roleLabels.push(role);
        return;
      }
      const label = role.label || role.key || role.value || "";
      if (typeof label === "string" && label) {
        roleLabels.push(label);
        return;
      }
      if (label && typeof label === "object") {
        const text = label.es || label.en || "";
        if (text) roleLabels.push(text);
      }
    });
  }
  if (roleLabels.length) {
    lines.push(`Roles: ${roleLabels.join(", ")}`);
  } else if (app.role) {
    lines.push(`Role: ${app.role}`);
  }
  if (Array.isArray(app.locations) && app.locations.length) {
    const labels = app.locations.map((loc) => loc.label || loc.key || "").filter(Boolean);
    if (labels.length) lines.push(`Locations: ${labels.join(", ")}`);
  }
  if (app.answers?.__referred === "yes") {
    lines.push(`Referred by: ${app.answers.__referred_by || "unknown"}`);
  } else if (app.answers?.__referred === "no") {
    lines.push("Referred by: nobody");
  }
  if (page && Array.isArray(page.questions)) {
    lines.push("Answers:");
    page.questions.forEach((q) => {
      const key = q?.id || "";
      if (!key) return;
      const label = q?.label?.en || q?.label?.es || key;
      const value = app.answers ? app.answers[key] : "";
      if (value) lines.push(`- ${label}: ${value}`);
    });
  }
  return truncateText(lines.join("\n"), 2000);
}

function buildPreferenceQuestion({ locations, roles, lang }) {
  const locationLabels = Array.isArray(locations)
    ? locations.map((loc) => {
      if (!loc) return "";
      if (typeof loc === "string") return loc;
      if (loc.label) {
        if (typeof loc.label === "string") return loc.label;
        return loc.label.es || loc.label.en || loc.key || "";
      }
      return loc.key || "";
    }).filter(Boolean)
    : [];
  const roleLabels = Array.isArray(roles)
    ? roles.map((role) => {
      if (!role) return "";
      if (typeof role === "string") return role;
      if (role.label) {
        if (typeof role.label === "string") return role.label;
        return role.label.es || role.label.en || role.key || "";
      }
      return role.key || "";
    }).filter(Boolean)
    : [];
  const needsLocation = locationLabels.length > 1;
  const needsRole = roleLabels.length > 1;
  if (!needsLocation && !needsRole) return "";
  const locList = locationLabels.join(", ");
  const roleList = roleLabels.join(", ");
  if (lang === "en") {
    if (needsLocation && needsRole) {
      return [
        `From the locations you selected (${locList}), which one works best for you?`,
        `From the positions (${roleList}), which do you prefer and have more experience in?`
      ].join("\n");
    }
    if (needsLocation) {
      return `From the locations you selected (${locList}), which one works best for you?`;
    }
    return `You selected multiple positions (${roleList}). Which do you prefer and have more experience in?`;
  }
  if (needsLocation && needsRole) {
    return [
      `De las locaciones que elegiste (${locList}), ¿cuál te queda mejor?`,
      `De los puestos (${roleList}), ¿cuál preferís y en cuál tenés más experiencia?`
    ].join("\n");
  }
  if (needsLocation) {
    return `De las locaciones que elegiste (${locList}), ¿cuál te queda mejor?`;
  }
  return `Elegiste varios puestos (${roleList}). ¿Cuál preferís y en cuál tenés más experiencia?`;
}

function normalizePortalSourceKey(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function resolvePortalTrackingSource(body = {}, answers = {}) {
  const direct = String(
    body.source
    || body.src
    || body.utm_source
    || answers.__utm?.source
    || answers.__utm?.utm_source
    || answers.__utm?.ref
    || ""
  ).trim();
  return normalizePortalSourceKey(direct);
}

function createPortalRouter(options = {}) {
  const router = express.Router();
  const store = createPortalStore({
    dataDir: options.dataDir,
    pagesPath: options.pagesPath,
    appsPath: options.appsPath,
    logger: options.logger,
    dbPool: options.dbPool
  });

  const uploadsDir = options.uploadsDir || path.join(process.cwd(), "data", "uploads");
  const uploadsBaseUrl = resolveUploadsBaseUrl(options.uploadsBaseUrl || "/uploads");
  const publicUploadsBaseUrl = resolveUploadsBaseUrl(options.publicUploadsBaseUrl || uploadsBaseUrl);
  const resumeMaxBytes = options.resumeMaxBytes || 8 * 1024 * 1024;
  const photoMaxBytes = options.photoMaxBytes || 2 * 1024 * 1024;
  const logger = options.logger || console;
  const requireAdmin = options.requireAdmin || ((req, res, next) => next());
  const requireWrite = options.requireWrite || requireAdmin;
  const requireAdminPage = options.requireAdminPage || null;
  const saveCvEntry = typeof options.saveCvEntry === "function" ? options.saveCvEntry : null;
  const notifyOnApplication = typeof options.notifyOnApplication === "function" ? options.notifyOnApplication : null;
  const uploadToSpaces = typeof options.uploadToSpaces === "function" ? options.uploadToSpaces : null;
  const useSpacesUploads = !!(uploadToSpaces && /^https?:\/\//i.test(publicUploadsBaseUrl));
  const contactPhone = String(options.contactPhone || "").trim();
  const contactName = String(options.contactName || "").trim();
  const publicBaseUrl = String(options.publicBaseUrl || "").replace(/\/+$/, "");
  const placeScreeningCall = typeof options.placeScreeningCall === "function" ? options.placeScreeningCall : null;
  const screeningDelayMs = Math.max(0, Number(options.screeningDelayMs ?? SCREENING_CALL_DELAY_MS) || 0);
  const pendingScreening = new Map();
  const careersConfigPath = options.careersConfigPath || path.join(__dirname, "..", "config", "careers.json");
  const getRoleConfig = typeof options.getRoleConfig === "function" ? options.getRoleConfig : () => null;

  function purgePendingScreening() {
    const now = Date.now();
    for (const [key, entry] of pendingScreening.entries()) {
      if (!entry || entry.expiresAt <= now) pendingScreening.delete(key);
    }
  }

  function resolvePortalPublicBaseUrl(req) {
    const forwardedHost = String(req?.get?.("x-forwarded-host") || "").split(",")[0].trim();
    const host = forwardedHost || String(req?.get?.("host") || "").split(",")[0].trim();
    const proto = String(req?.get?.("x-forwarded-proto") || req?.protocol || "").split(",")[0].trim() || "https";
    if (host && !/^(localhost|127(?:\.\d{1,3}){3})(:\d+)?$/i.test(host)) {
      return `${proto}://${host}`.replace(/\/+$/, "");
    }
    return publicBaseUrl;
  }

  function buildPortalJoinUrl(slug, baseUrl = publicBaseUrl) {
    const key = safeSlug(slug);
    if (!key) return baseUrl ? `${baseUrl}/join` : "/join";
    const path = `/join/${encodeURIComponent(key)}`;
    return baseUrl ? `${baseUrl}${path}` : path;
  }

  function buildPortalSourceJoinUrl(slug, sourceKey, baseUrl = publicBaseUrl) {
    const key = normalizePortalSourceKey(sourceKey);
    if (!key) return buildPortalJoinUrl(slug, baseUrl);
    return `${buildPortalJoinUrl(slug, baseUrl)}/${encodeURIComponent(key)}`;
  }

  async function decoratePortalPageLinks(page, req) {
    if (!page || typeof page !== "object") return page;
    const slug = safeSlug(page.slug || page.brand || "page");
    const resolvedBaseUrl = resolvePortalPublicBaseUrl(req);
    const publicUrl = buildPortalJoinUrl(slug, resolvedBaseUrl);
    const sources = Array.isArray(page.sources) ? page.sources : [];
    const decoratedSources = sources.map((source) => {
      if (!source || typeof source !== "object") return source;
      const longUrl = buildPortalSourceJoinUrl(slug, source.key || "", resolvedBaseUrl);
      return {
        ...source,
        long_url: longUrl,
        short_url: longUrl
      };
    });
    return {
      ...page,
      public_url: publicUrl,
      public_short_url: publicUrl,
      sources: decoratedSources
    };
  }

  function buildTrackingDefaults(sourceKey) {
    const key = normalizePortalSourceKey(sourceKey);
    if (!key) return null;
    return {
      src: key,
      source: key,
      utm_source: key
    };
  }

  async function sendPortalPage(req, res, opts = {}) {
    const slug = safeSlug(req.params.slug);
    const page = await store.getPage(slug);
    if (!page || page.active === false) {
      return res.status(404).send("not_found");
    }
    const resolvedContactName = String(page.contactName || page.contact?.name || contactName || "").trim();
    const payload = {
      ...page,
      slug,
      limits: { resumeMaxBytes, photoMaxBytes },
      contactPhone,
      contactName: resolvedContactName || contactName || ""
    };
    const trackingDefaults = buildTrackingDefaults(opts.sourceKey || req.params?.sourceKey || "");
    if (trackingDefaults) payload.trackingDefaults = trackingDefaults;
    return res.type("text/html").send(renderApplyPage(payload));
  }

  // Parses and validates a submission for one portal page. Throws Error(code) on invalid input; no side effects.
  function prepareSubmission({ page, body, requireQuestions = true, locationLabels = null }) {
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim();
    const phone = normalizePhone(String(body.phone || "").trim());
    const roleField = page.fields?.role || {};
    const roleByLocation = page.fields?.roleByLocation || {};
    const roleOptions = Array.isArray(roleField.options) ? roleField.options : [];
    const roleMap = new Map();
    const addRoleOption = (opt) => {
      if (!opt) return;
      if (typeof opt === "string") {
        roleMap.set(opt, opt);
        return;
      }
      const key = opt.key || opt.value || "";
      if (!key) return;
      const labelObj = opt.label || opt;
      const label = typeof labelObj === "string"
        ? labelObj
        : (labelObj.es || labelObj.en || "");
      roleMap.set(String(key), label || String(key));
    };
    roleOptions.forEach(addRoleOption);
    Object.values(roleByLocation || {}).forEach((list) => {
      if (!Array.isArray(list)) return;
      list.forEach(addRoleOption);
    });
    const rawRoles = Array.isArray(body.roles)
      ? body.roles
      : (body.roles ? [body.roles] : []);
    const roleValues = rawRoles.length ? rawRoles : (body.role ? [body.role] : []);
    const roles = [];
    roleValues.forEach((val) => {
      const key = String(val || "").trim();
      if (!key) return;
      if (roles.some((r) => r.key === key)) return;
      const label = roleMap.get(key) || key;
      roles.push({ key, label });
    });
    const role = roles.length
      ? roles[0].key
      : String(body.role || page.role || "").trim();
    const consent = body.consent === true || body.consent === "true" || body.consent === "on" || body.consent === 1;
    const locationField = page.fields?.locations || {};
    const rawLocations = Array.isArray(body.locations)
      ? body.locations
      : (body.locations ? [body.locations] : []);
    const locations = [];
    const locationOptions = Array.isArray(locationField.options) ? locationField.options : [];
    const locationMap = new Map();
    locationOptions.forEach((opt) => {
      if (!opt) return;
      if (typeof opt === "string") {
        locationMap.set(opt, opt);
        return;
      }
      const key = opt.key || opt.value || "";
      if (!key) return;
      const labelObj = opt.label || opt;
      const label = typeof labelObj === "string"
        ? labelObj
        : (labelObj.es || labelObj.en || "");
      locationMap.set(String(key), label || String(key));
    });
    rawLocations.forEach((val) => {
      const key = String(val || "").trim();
      if (!key) return;
      const label = locationMap.get(key) || locationLabels?.[key] || key;
      if (!locations.some((loc) => loc.key === key)) {
        locations.push({ key, label });
      }
    });
    const rawAnswers = body.answers && typeof body.answers === "object" ? body.answers : {};
    const answers = {};
    const trackingSource = resolvePortalTrackingSource(body, rawAnswers);

    if (!name) throw new Error("missing_name");
    if (!consent) throw new Error("missing_consent");
    if (page.fields?.email?.required !== false && !/.+@.+\..+/.test(email)) {
      throw new Error("invalid_email");
    }
    if (page.fields?.phone?.required !== false && phone.length < 7) {
      throw new Error("invalid_phone");
    }
    if (locationField.required && locations.length === 0) {
      throw new Error("missing_location");
    }
    if (roleField.required && !role) {
      throw new Error("missing_role");
    }

    if (requireQuestions) {
      for (const q of page.questions || []) {
        if (!q || !q.required) continue;
        const val = rawAnswers[q.id];
        if (!val) throw new Error("missing_answer");
      }
    }
    (page.questions || []).forEach((q) => {
      if (!q || !q.id) return;
      const val = rawAnswers[q.id];
      answers[q.id] = typeof val === "string" ? val.trim() : String(val || "").trim();
    });
    if (rawAnswers.__utm && typeof rawAnswers.__utm === "object") {
      answers.__utm = {
        ...rawAnswers.__utm,
        ...(trackingSource ? { source: trackingSource, utm_source: rawAnswers.__utm.utm_source || trackingSource } : {})
      };
    } else if (trackingSource) {
      answers.__utm = { source: trackingSource, utm_source: trackingSource };
    }
    if (roles.length) {
      answers.__roles = roles;
    }
    const referred = rawAnswers.__referred === "yes" ? "yes" : (rawAnswers.__referred === "no" ? "no" : "");
    const referredBy = referred === "yes" ? String(rawAnswers.__referred_by || "").trim().slice(0, 120) : "";
    if (referred === "yes" && !referredBy) {
      throw new Error("missing_referrer_name");
    }
    if (referred) {
      answers.__referred = referred;
      answers.__referred_by = referredBy;
    }
    const langPref = body.lang === "en" ? "en" : "es";
    return { name, email, phone, role, roles, consent, locations, answers, trackingSource, langPref };
  }

  async function saveSubmissionFiles({ body, relDir, appId, resumeRequired }) {
    const resumeDataUrl = body.resume_data_url || "";
    const resumeFileName = body.resume_file_name || "";
    const photoDataUrl = body.photo_data_url || "";
    const photoFileName = body.photo_file_name || "";
    let resumeUrl = "";
    let photoUrl = "";
    if (resumeRequired && !resumeDataUrl) {
      throw new Error("resume_required");
    }
    if (resumeDataUrl) {
      const saved = await saveDataUrlFile({
        dataUrl: resumeDataUrl,
        uploadsDir,
        relDir,
        fileName: resumeFileName || `resume_${appId}.pdf`,
        maxBytes: resumeMaxBytes,
        allowedMime: RESUME_MIME,
        uploadToSpaces: useSpacesUploads ? uploadToSpaces : null,
        publicUploadsBaseUrl
      });
      if (saved) resumeUrl = saved.url || `${publicUploadsBaseUrl}/${saved.relPath}`;
    }
    if (photoDataUrl) {
      const saved = await saveDataUrlFile({
        dataUrl: photoDataUrl,
        uploadsDir,
        relDir,
        fileName: photoFileName || `photo_${appId}.jpg`,
        maxBytes: photoMaxBytes,
        allowedMime: IMAGE_MIME,
        uploadToSpaces: useSpacesUploads ? uploadToSpaces : null,
        publicUploadsBaseUrl
      });
      if (saved) photoUrl = saved.url || `${publicUploadsBaseUrl}/${saved.relPath}`;
    }
    return { resumeUrl, photoUrl };
  }

  // Records the application, the CV entry and the push notification; registers the screening offer when allowed.
  async function commitSubmission({
    page,
    slug,
    prepared,
    appId,
    applicationCode,
    resumeUrl,
    photoUrl,
    createdAt,
    offerScreening = true,
    customQuestionLocations = null,
    customQuestionRoles = null,
    sourcePrefix = ""
  }) {
    const { name, email, phone, role, roles, consent, locations, answers, trackingSource, langPref } = prepared;
    const customQuestion = buildPreferenceQuestion({
      locations: customQuestionLocations || locations,
      roles: customQuestionRoles || roles,
      lang: langPref
    });
    const customQuestionMode = customQuestion ? "ai" : "";
    const finalAnswers = { ...answers, apply_code: applicationCode, __apply_code: applicationCode };

    const application = {
      id: appId,
      slug,
      brand: page.brand || "",
      source: trackingSource || "",
      role,
      roles,
      name,
      email,
      phone,
      application_code: applicationCode,
      consent,
      answers: finalAnswers,
      locations,
      resume_url: resumeUrl,
      photo_url: photoUrl,
      created_at: createdAt || new Date().toISOString()
    };

    await store.recordApplication(application);

    const cvText = buildCvText(application, page);
    const primaryLocation = locations[0] || {};
    const cvBrand = locations.length === 1
      ? (primaryLocation.key || primaryLocation.label || page.brand || "")
      : (page.brand || primaryLocation.key || primaryLocation.label || "");
    const sourceBase = sourcePrefix || `portal:${slug}`;
    const cvSource = trackingSource ? `${sourceBase}:${trackingSource}` : sourceBase;
    let cvId = "";
    if (saveCvEntry) {
      const savedCv = await saveCvEntry({
        brand: cvBrand,
        role: role || "",
        applicant: name,
        phone,
        cv_text: cvText,
        cv_url: resumeUrl,
        cv_photo_url: photoUrl,
        source: cvSource,
        custom_question: customQuestion,
        custom_question_mode: customQuestionMode
      });
      cvId = String(savedCv?.id || "");
    }

    const screeningAvailable = !!(offerScreening && placeScreeningCall && phone && phone.length >= 7 && page.screening?.enabled !== false);
    if (screeningAvailable) {
      purgePendingScreening();
      pendingScreening.set(appId, {
        slug,
        requestedAt: 0,
        expiresAt: Date.now() + SCREENING_OFFER_TTL_MS,
        payload: {
          to: phone,
          brand: cvBrand,
          role: role || "",
          applicant: name,
          cv_summary: cvText,
          cv_text: cvText,
          cv_id: cvId,
          resume_url: resumeUrl,
          source: cvSource,
          custom_question: customQuestion,
          custom_question_mode: customQuestionMode
        }
      });
    }

    if (notifyOnApplication) {
      Promise.resolve(notifyOnApplication({ application, page })).catch((err) => {
        logger.error("[portal] notify failed", err?.message || err);
      });
    }

    return { application, screeningAvailable };
  }

  router.use(uploadsBaseUrl, express.static(uploadsDir, { fallthrough: true }));

  router.get("/apply/:slug", async (req, res) => {
    return sendPortalPage(req, res);
  });

  router.get("/join/:slug", async (req, res) => {
    return sendPortalPage(req, res);
  });

  router.get("/join/:slug/:sourceKey", async (req, res) => {
    return sendPortalPage(req, res, { sourceKey: req.params.sourceKey });
  });

  router.get("/apply/:slug/config", async (req, res) => {
    const slug = safeSlug(req.params.slug);
    const page = await store.getPage(slug);
    if (!page || page.active === false) {
      return res.status(404).json({ error: "not_found" });
    }
    const resolvedContactName = String(page.contactName || page.contact?.name || contactName || "").trim();
    const payload = {
      ...page,
      slug,
      limits: { resumeMaxBytes, photoMaxBytes },
      contactPhone,
      contactName: resolvedContactName || contactName || ""
    };
    res.json({ ok: true, page: payload });
  });

  router.post("/apply/:slug/submit", async (req, res) => {
    try {
      const slug = safeSlug(req.params.slug);
      const page = await store.getPage(slug);
      if (!page || page.active === false) {
        return res.status(404).json({ error: "not_found" });
      }

      const body = req.body || {};
      const prepared = prepareSubmission({ page, body });
      const appId = randomToken(10);
      const applicationCode = generateApplicationCode();
      const { resumeUrl, photoUrl } = await saveSubmissionFiles({
        body,
        relDir: path.posix.join("portal-apps", slug, appId),
        appId,
        resumeRequired: !!page.resume?.required
      });
      const { screeningAvailable } = await commitSubmission({
        page,
        slug,
        prepared,
        appId,
        applicationCode,
        resumeUrl,
        photoUrl
      });

      return res.json({
        ok: true,
        application_id: appId,
        application_code: applicationCode,
        screening_available: screeningAvailable,
        screening_delay_seconds: Math.round(screeningDelayMs / 1000)
      });
    } catch (err) {
      logger.error("[portal] submit failed", err.message);
      return res.status(400).json({ error: err.message || "submit_failed" });
    }
  });

  function loadCareersConfig() {
    try {
      const raw = fs.readFileSync(careersConfigPath, "utf8");
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (err) {
      logger.error("[portal] careers config unreadable", err?.message || err);
      return null;
    }
  }

  function careersOptionValue(opt) {
    if (!opt) return "";
    if (typeof opt === "string") return opt;
    return String(opt.key || opt.value || opt.es || opt.en || "").trim();
  }

  function careersOptionLabel(opt) {
    if (!opt) return { es: "", en: "" };
    if (typeof opt === "string") return { es: opt, en: opt };
    const src = opt.label || opt;
    if (typeof src === "string") return { es: src, en: src };
    const value = careersOptionValue(opt);
    return { es: src.es || src.en || value, en: src.en || src.es || value };
  }

  function normalizeRoleKey(value) {
    return String(value || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  // Finds the interview-config entry (roles_config[brand][role]) for a portal role, matching key, display name or alias.
  function findRoleConfigEntry(roleConfig, brandKey, roleValue) {
    const brand = roleConfig && typeof roleConfig === "object" ? roleConfig[brandKey] : null;
    if (!brand || typeof brand !== "object") return null;
    const target = normalizeRoleKey(roleValue);
    if (!target) return null;
    for (const [key, entry] of Object.entries(brand)) {
      if (key === "_meta" || !entry || typeof entry !== "object") continue;
      const names = [key, entry.displayName, ...(Array.isArray(entry.aliases) ? entry.aliases : [])].map(normalizeRoleKey);
      if (names.includes(target)) return entry;
    }
    return null;
  }

  function splitRequirementLines(value) {
    return String(value || "")
      .split(/\r?\n/)
      .map((line) => line.replace(/^[\s\-•·*]+/, "").trim())
      .filter(Boolean)
      .slice(0, 8);
  }

  // Builds the multi-location portal data from config/careers.json plus each brand's live portal page.
  async function buildCareersPayload() {
    const config = loadCareersConfig();
    if (!config || !Array.isArray(config.locations)) return null;
    const roleConfig = getRoleConfig();
    const pageCache = new Map();
    const getPageCached = async (slug) => {
      if (!pageCache.has(slug)) pageCache.set(slug, await store.getPage(slug));
      return pageCache.get(slug);
    };
    const locations = [];
    const teams = [];
    for (const loc of config.locations) {
      if (!loc || !loc.key || !loc.page) continue;
      const slug = safeSlug(loc.page);
      const page = await getPageCached(slug);
      if (!page || page.active === false) continue;
      const key = String(loc.key).trim();
      // Locations switched off with "Portal de empleo" in the admin brand card stay off the portal.
      if (roleConfig?.[key]?._meta?.portalHidden === true) continue;
      const pageLocations = Array.isArray(page.fields?.locations?.options) ? page.fields.locations.options : [];
      const pageLoc = pageLocations.find((opt) => opt && careersOptionValue(opt) === key) || null;
      const byLocation = page.fields?.roleByLocation?.[key];
      const roleList = Array.isArray(byLocation) && byLocation.length
        ? byLocation
        : (Array.isArray(page.fields?.role?.options) ? page.fields.role.options : []);
      const roles = [];
      roleList.forEach((opt) => {
        const value = careersOptionValue(opt);
        if (!value || roles.some((r) => r.value === value)) return;
        const cfg = findRoleConfigEntry(roleConfig, key, value) || {};
        // Closed roles are left out, which also makes /careers/submit reject them.
        if (cfg.portalClosed === true) return;
        const reqEs = splitRequirementLines(cfg.portalRequirements?.es);
        const reqEn = splitRequirementLines(cfg.portalRequirements?.en);
        roles.push({
          value,
          label: careersOptionLabel(opt),
          urgent: cfg.portalUrgent === true,
          english: typeof cfg.englishRequired === "boolean" ? cfg.englishRequired : null,
          physical: cfg.physical === true,
          requirements: { es: reqEs.length ? reqEs : reqEn, en: reqEn.length ? reqEn : reqEs }
        });
      });
      if (!roles.length) continue;
      const gallery = Array.isArray(page.assets?.gallery) ? page.assets.gallery.filter(Boolean) : [];
      locations.push({
        key,
        page: slug,
        brand: page.brand || "",
        name: loc.name || careersOptionLabel(pageLoc).es || page.brand || key,
        tagline: loc.tagline || null,
        area: loc.area || "",
        address: loc.address || (typeof pageLoc?.address === "string" ? pageLoc.address : ""),
        lat: Number(loc.lat),
        lng: Number(loc.lng),
        color: loc.color || page.theme?.colorPrimary || "",
        logoUrl: loc.badgeUrl || page.assets?.logoUrl || "",
        logoRound: !!loc.badgeRound,
        heroUrl: loc.heroUrl || page.assets?.heroUrl || gallery[0] || "",
        resumeRequired: !!page.resume?.required,
        roles
      });
      if (!teams.some((team) => team.page === slug)) {
        teams.push({
          page: slug,
          brand: page.brand || "",
          logoUrl: loc.badgeUrl || page.assets?.logoUrl || "",
          logoRound: !!loc.badgeRound,
          color: loc.color || "",
          photos: [page.assets?.heroUrl, ...gallery].filter(Boolean)
        });
      }
    }
    return {
      brand: config.brand || "",
      title: config.title || null,
      headline: config.headline || null,
      intro: config.intro || null,
      logoUrl: config.logoUrl || "",
      benefits: Array.isArray(config.benefits) ? config.benefits : [],
      locations,
      teams,
      contactPhone,
      contactName,
      limits: { resumeMaxBytes, photoMaxBytes }
    };
  }

  async function sendCareersPage(req, res) {
    const payload = await buildCareersPayload();
    if (!payload || !payload.locations.length) return res.status(404).send("not_found");
    return res.type("text/html").send(renderCareersPage(payload));
  }

  // Brand assets that live in the repo (e.g. the Yes! logo) rather than in uploaded portal pages.
  router.use("/careers/assets", express.static(path.join(__dirname, "assets"), { maxAge: "7d", fallthrough: false }));

  router.get(["/careers", "/trabaja", "/jobs"], (req, res) => {
    sendCareersPage(req, res).catch((err) => {
      logger.error("[portal] careers page failed", err?.message || err);
      res.status(500).send("error");
    });
  });

  // Root of the jobs domain shows the portal to browsers only, so non-HTML probes keep their current 404.
  router.get("/", (req, res, next) => {
    if (!String(req.get("accept") || "").includes("text/html")) return next();
    sendCareersPage(req, res).catch(next);
  });

  router.post("/careers/submit", async (req, res) => {
    try {
      const payload = await buildCareersPayload();
      if (!payload) return res.status(404).json({ error: "not_found" });
      const body = req.body || {};
      const locationByKey = new Map(payload.locations.map((loc) => [loc.key, loc]));
      const rawSelections = Array.isArray(body.selections) ? body.selections : [];
      const selections = [];
      rawSelections.forEach((sel) => {
        const key = String(sel?.location || "").trim();
        const loc = locationByKey.get(key);
        if (!loc || selections.some((s) => s.loc.key === key)) return;
        const allowed = new Set(loc.roles.map((r) => r.value));
        const roles = (Array.isArray(sel.roles) ? sel.roles : [])
          .map((r) => String(r || "").trim())
          .filter((r, idx, arr) => r && allowed.has(r) && arr.indexOf(r) === idx);
        selections.push({ loc, roles });
      });
      if (!selections.length) return res.status(400).json({ error: "missing_location" });
      if (selections.some((s) => !s.roles.length)) return res.status(400).json({ error: "missing_role" });

      // One application per brand page so each brand's managers, push alerts and filters keep working as today.
      const groups = [];
      selections.forEach((sel) => {
        let group = groups.find((g) => g.slug === sel.loc.page);
        if (!group) {
          group = { slug: sel.loc.page, selections: [] };
          groups.push(group);
        }
        group.selections.push(sel);
      });

      // Always tag as "careers" so the admin can tell this portal apart; a link tag (?src=craigslist) becomes "careers-craigslist".
      const linkSource = resolvePortalTrackingSource(body, body.answers || {});
      const trackedBody = { ...body, source: linkSource ? `careers-${linkSource}`.slice(0, 80) : "careers" };
      const locationLabels = {};
      payload.locations.forEach((loc) => { locationLabels[loc.key] = loc.name; });

      const prepared = [];
      for (const group of groups) {
        const page = await store.getPage(group.slug);
        if (!page || page.active === false) return res.status(400).json({ error: "invalid_location" });
        const roles = [];
        group.selections.forEach((sel) => sel.roles.forEach((r) => { if (!roles.includes(r)) roles.push(r); }));
        const groupBody = {
          ...trackedBody,
          locations: group.selections.map((sel) => sel.loc.key),
          roles,
          role: roles[0]
        };
        prepared.push({
          group,
          page,
          data: prepareSubmission({ page, body: groupBody, requireQuestions: false, locationLabels })
        });
      }

      const primaryAppId = randomToken(10);
      const applicationCode = generateApplicationCode();
      const { resumeUrl, photoUrl } = await saveSubmissionFiles({
        body,
        relDir: path.posix.join("portal-apps", "careers", primaryAppId),
        appId: primaryAppId,
        resumeRequired: selections.some((sel) => sel.loc.resumeRequired)
      });

      const allLocations = selections.map((sel) => ({ key: sel.loc.key, label: sel.loc.name }));
      const allRoles = [];
      selections.forEach((sel) => sel.roles.forEach((r) => { if (!allRoles.some((x) => x.key === r)) allRoles.push({ key: r, label: r }); }));
      const now = Date.now();
      let screeningAvailable = false;
      // Record the secondary brands first so the primary application is the newest one for inbound code lookups.
      for (let i = prepared.length - 1; i >= 0; i -= 1) {
        const item = prepared[i];
        const isPrimary = i === 0;
        const result = await commitSubmission({
          page: item.page,
          slug: item.group.slug,
          prepared: item.data,
          appId: isPrimary ? primaryAppId : randomToken(10),
          applicationCode,
          resumeUrl,
          photoUrl,
          createdAt: new Date(now - i).toISOString(),
          offerScreening: isPrimary,
          customQuestionLocations: isPrimary ? allLocations : null,
          customQuestionRoles: isPrimary ? allRoles : null
        });
        if (isPrimary) screeningAvailable = result.screeningAvailable;
      }

      return res.json({
        ok: true,
        application_id: primaryAppId,
        application_code: applicationCode,
        screening_slug: prepared[0].group.slug,
        screening_available: screeningAvailable,
        screening_delay_seconds: Math.round(screeningDelayMs / 1000)
      });
    } catch (err) {
      logger.error("[portal] careers submit failed", err.message);
      return res.status(400).json({ error: err.message || "submit_failed" });
    }
  });

  router.post("/apply/:slug/screening-call", async (req, res) => {
    try {
      const slug = safeSlug(req.params.slug);
      const appId = String(req.body?.application_id || "").trim();
      if (!appId) return res.status(400).json({ error: "missing_application_id" });
      purgePendingScreening();
      const entry = pendingScreening.get(appId);
      if (!entry || entry.slug !== slug) {
        return res.status(404).json({ error: "screening_not_available" });
      }
      if (!placeScreeningCall) {
        return res.status(503).json({ error: "screening_disabled" });
      }
      if (entry.requestedAt) {
        return res.json({ ok: true, already_requested: true, delay_seconds: Math.round(screeningDelayMs / 1000) });
      }
      entry.requestedAt = Date.now();
      const payload = { ...entry.payload };
      logger.log(`[portal] screening call scheduled in ${Math.round(screeningDelayMs / 1000)}s`, { app: appId, to: payload.to, brand: payload.brand });
      setTimeout(() => {
        Promise.resolve(placeScreeningCall(payload))
          .then(() => {
            pendingScreening.delete(appId);
          })
          .catch((err) => {
            logger.error("[portal] screening call failed", err?.message || err);
          });
      }, screeningDelayMs);
      return res.json({ ok: true, delay_seconds: Math.round(screeningDelayMs / 1000) });
    } catch (err) {
      logger.error("[portal] screening call request failed", err.message);
      return res.status(400).json({ error: err.message || "screening_failed" });
    }
  });

  router.get("/admin/portal", (req, res, next) => {
    const redirectToUi = () => {
      const params = new URLSearchParams(req.query || {});
      params.set("view", "portal");
      const query = params.toString();
      res.redirect(query ? `/admin/ui?${query}` : "/admin/ui?view=portal");
    };
    if (requireAdminPage) {
      return requireAdminPage(req, res, redirectToUi);
    }
    redirectToUi();
  });

  router.get("/admin/portal/pages", requireWrite, async (req, res) => {
    const pagesRaw = await store.listPages();
    const pages = await Promise.all((pagesRaw || []).map((page) => decoratePortalPageLinks(page, req)));
    return res.json({ ok: true, pages });
  });

  router.post("/admin/portal/pages", requireWrite, async (req, res) => {
    try {
      const body = req.body || {};
      const slug = safeSlug(body.slug || body.brand || "page");

      const page = {
        slug,
        brand: String(body.brand || "").trim(),
        contactName: String(body.contactName || body.contact_name || "").trim(),
        role: String(body.role || "").trim(),
        active: body.active !== false && String(body.active) !== "false",
        localeDefault: body.localeDefault === "en" ? "en" : "es",
        content: body.content || {},
        theme: body.theme || {},
        fields: body.fields || {},
        resume: body.resume || {},
        photo: body.photo || {},
        questions: Array.isArray(body.questions) ? body.questions : [],
        assets: body.assets || {},
        sources: Array.isArray(body.sources) ? body.sources : []
      };

      page.questions = page.questions.map((q, idx) => {
        const type = ["short", "long", "select", "yesno"].includes(q.type) ? q.type : "short";
        const label = q.label && typeof q.label === "object" ? q.label : { es: String(q.label || ""), en: String(q.label || "") };
        return {
          id: q.id || `q_${Date.now()}_${idx}`,
          label,
          type,
          required: !!q.required,
          options: Array.isArray(q.options) ? q.options : []
        };
      });

      const uploads = {
        logo: { dataUrl: body.logo_data_url, fileName: body.logo_file_name || "logo" },
        hero: { dataUrl: body.hero_data_url, fileName: body.hero_file_name || "hero" },
        favicon: { dataUrl: body.favicon_data_url, fileName: body.favicon_file_name || "favicon" },
        gallery: {
          dataUrls: Array.isArray(body.gallery_data_urls) ? body.gallery_data_urls : [],
          fileNames: Array.isArray(body.gallery_file_names) ? body.gallery_file_names : []
        }
      };

      const assetsDir = path.posix.join("portal-assets", slug);
      if (uploads.logo.dataUrl) {
        const saved = await saveDataUrlFile({
          dataUrl: uploads.logo.dataUrl,
          uploadsDir,
          relDir: assetsDir,
          fileName: uploads.logo.fileName,
          maxBytes: photoMaxBytes,
          allowedMime: IMAGE_MIME,
          uploadToSpaces: useSpacesUploads ? uploadToSpaces : null,
          publicUploadsBaseUrl
        });
        if (saved) page.assets.logoUrl = saved.url || `${publicUploadsBaseUrl}/${saved.relPath}`;
      }
      if (uploads.hero.dataUrl) {
        const saved = await saveDataUrlFile({
          dataUrl: uploads.hero.dataUrl,
          uploadsDir,
          relDir: assetsDir,
          fileName: uploads.hero.fileName,
          maxBytes: photoMaxBytes,
          allowedMime: IMAGE_MIME,
          uploadToSpaces: useSpacesUploads ? uploadToSpaces : null,
          publicUploadsBaseUrl
        });
        if (saved) page.assets.heroUrl = saved.url || `${publicUploadsBaseUrl}/${saved.relPath}`;
      }
      if (uploads.favicon.dataUrl) {
        const saved = await saveDataUrlFile({
          dataUrl: uploads.favicon.dataUrl,
          uploadsDir,
          relDir: assetsDir,
          fileName: uploads.favicon.fileName,
          maxBytes: photoMaxBytes,
          allowedMime: IMAGE_MIME,
          uploadToSpaces: useSpacesUploads ? uploadToSpaces : null,
          publicUploadsBaseUrl
        });
        if (saved) page.assets.faviconUrl = saved.url || `${publicUploadsBaseUrl}/${saved.relPath}`;
      }
      if (uploads.gallery.dataUrls.length) {
        const galleryUrls = Array.isArray(page.assets.gallery) ? page.assets.gallery.slice() : [];
        for (let i = 0; i < uploads.gallery.dataUrls.length; i += 1) {
          const dataUrl = uploads.gallery.dataUrls[i];
          const name = uploads.gallery.fileNames[i] || `gallery_${i}`;
          const saved = await saveDataUrlFile({
            dataUrl,
            uploadsDir,
            relDir: assetsDir,
            fileName: name,
            maxBytes: photoMaxBytes,
            allowedMime: IMAGE_MIME,
            uploadToSpaces: useSpacesUploads ? uploadToSpaces : null,
            publicUploadsBaseUrl
          });
          if (saved) galleryUrls.push(saved.url || `${publicUploadsBaseUrl}/${saved.relPath}`);
        }
        page.assets.gallery = galleryUrls;
      }

      const saved = await store.upsertPage(page);
      const decorated = await decoratePortalPageLinks(saved, req);
      return res.json({ ok: true, page: decorated });
    } catch (err) {
      logger.error("[portal] save page failed", err.message);
      return res.status(400).json({ error: err.message || "save_failed" });
    }
  });

  router.post("/admin/portal/pages/:slug/sources", requireWrite, async (req, res) => {
    try {
      const slug = safeSlug(req.params.slug || req.body?.slug || "");
      if (!slug) return res.status(400).json({ error: "missing_slug" });
      const current = await store.getPage(slug);
      if (!current) return res.status(404).json({ error: "not_found" });
      const sources = Array.isArray(req.body?.sources) ? req.body.sources : [];
      const saved = await store.upsertPage({
        ...current,
        sources
      });
      const decorated = await decoratePortalPageLinks(saved, req);
      return res.json({ ok: true, page: decorated });
    } catch (err) {
      logger.error("[portal] save sources failed", err.message);
      return res.status(400).json({ error: err.message || "save_sources_failed" });
    }
  });

  router.delete("/admin/portal/pages/:slug", requireWrite, async (req, res) => {
    const slug = safeSlug(req.params.slug);
    const ok = await store.deletePage(slug);
    if (!ok) return res.status(404).json({ error: "not_found" });
    return res.json({ ok: true });
  });

  router.get("/admin/portal/applications", requireWrite, async (req, res) => {
    const slug = req.query?.slug || "";
    const location = req.query?.location || "";
    const applications = await store.listApplications({ slug, location });
    return res.json({ ok: true, applications });
  });

  return router;
}

module.exports = { createPortalRouter };

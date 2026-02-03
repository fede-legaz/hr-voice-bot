"use strict";

const path = require("path");
const fs = require("fs");
const express = require("express");
const { createPortalStore } = require("./store");
const { renderApplyPage } = require("./templates");
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
      return `From the locations you selected (${locList}), which one works best for you? And from the positions (${roleList}), which do you prefer and have more experience in?`;
    }
    if (needsLocation) {
      return `From the locations you selected (${locList}), which one works best for you?`;
    }
    return `You selected multiple positions (${roleList}). Which do you prefer and have more experience in?`;
  }
  if (needsLocation && needsRole) {
    return `De las locaciones que elegiste (${locList}), ¿cuál te queda mejor? Y de los puestos (${roleList}), ¿cuál preferís y en cuál tenés más experiencia?`;
  }
  if (needsLocation) {
    return `De las locaciones que elegiste (${locList}), ¿cuál te queda mejor?`;
  }
  return `Elegiste varios puestos (${roleList}). ¿Cuál preferís y en cuál tenés más experiencia?`;
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

  router.use(uploadsBaseUrl, express.static(uploadsDir, { fallthrough: true }));

  router.get("/apply/:slug", async (req, res) => {
    const slug = safeSlug(req.params.slug);
    const page = await store.getPage(slug);
    if (!page || page.active === false) {
      return res.status(404).send("not_found");
    }
    const payload = {
      ...page,
      slug,
      limits: { resumeMaxBytes, photoMaxBytes },
      contactPhone,
      contactName
    };
    res.type("text/html").send(renderApplyPage(payload));
  });

  router.get("/apply/:slug/config", async (req, res) => {
    const slug = safeSlug(req.params.slug);
    const page = await store.getPage(slug);
    if (!page || page.active === false) {
      return res.status(404).json({ error: "not_found" });
    }
    const payload = {
      ...page,
      slug,
      limits: { resumeMaxBytes, photoMaxBytes },
      contactPhone,
      contactName
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
      const name = String(body.name || "").trim();
      const email = String(body.email || "").trim();
      const phoneRaw = String(body.phone || "").trim();
      const phone = normalizePhone(phoneRaw);
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
        const label = locationMap.get(key) || key;
        if (!locations.some((loc) => loc.key === key)) {
          locations.push({ key, label });
        }
      });
      const rawAnswers = body.answers && typeof body.answers === "object" ? body.answers : {};
      const answers = {};

      if (!name) return res.status(400).json({ error: "missing_name" });
      if (!consent) return res.status(400).json({ error: "missing_consent" });
      if (page.fields?.email?.required !== false && !/.+@.+\..+/.test(email)) {
        return res.status(400).json({ error: "invalid_email" });
      }
      if (page.fields?.phone?.required !== false && phone.length < 7) {
        return res.status(400).json({ error: "invalid_phone" });
      }
      if (locationField.required && locations.length === 0) {
        return res.status(400).json({ error: "missing_location" });
      }
      if (roleField.required && !role) {
        return res.status(400).json({ error: "missing_role" });
      }

      for (const q of page.questions || []) {
        if (!q || !q.required) continue;
        const val = rawAnswers[q.id];
        if (!val) return res.status(400).json({ error: "missing_answer" });
      }
      (page.questions || []).forEach((q) => {
        if (!q || !q.id) return;
        const val = rawAnswers[q.id];
        answers[q.id] = typeof val === "string" ? val.trim() : String(val || "").trim();
      });
      if (roles.length) {
        answers.__roles = roles;
      }
      const langPref = body.lang === "en" ? "en" : "es";
      const customQuestion = buildPreferenceQuestion({ locations, roles, lang: langPref });
      const customQuestionMode = customQuestion ? "exact" : "";

      const appId = randomToken(10);
      const appDir = path.posix.join("portal-apps", slug, appId);
      let resumeUrl = "";
      let photoUrl = "";

      const resumeDataUrl = body.resume_data_url || "";
      const resumeFileName = body.resume_file_name || "";
      const photoDataUrl = body.photo_data_url || "";
      const photoFileName = body.photo_file_name || "";

      if (page.resume?.required && !resumeDataUrl) {
        return res.status(400).json({ error: "resume_required" });
      }

      if (resumeDataUrl) {
        const saved = await saveDataUrlFile({
          dataUrl: resumeDataUrl,
          uploadsDir,
          relDir: appDir,
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
          relDir: appDir,
          fileName: photoFileName || `photo_${appId}.jpg`,
          maxBytes: photoMaxBytes,
          allowedMime: IMAGE_MIME,
          uploadToSpaces: useSpacesUploads ? uploadToSpaces : null,
          publicUploadsBaseUrl
        });
        if (saved) photoUrl = saved.url || `${publicUploadsBaseUrl}/${saved.relPath}`;
      }

      const application = {
        id: appId,
        slug,
        brand: page.brand || "",
        role,
        roles,
        name,
        email,
        phone,
        consent,
        answers,
        locations,
        resume_url: resumeUrl,
        photo_url: photoUrl,
        created_at: new Date().toISOString()
      };

      await store.recordApplication(application);

      if (saveCvEntry) {
        const cvText = buildCvText(application, page);
        const primaryLocation = locations[0] || {};
        const cvBrand = locations.length === 1
          ? (primaryLocation.key || primaryLocation.label || page.brand || "")
          : (page.brand || primaryLocation.key || primaryLocation.label || "");
        await saveCvEntry({
          brand: cvBrand,
          role: role || "",
          applicant: name,
          phone,
          cv_text: cvText,
          cv_url: resumeUrl,
          cv_photo_url: photoUrl,
          source: `portal:${slug}`,
          custom_question: customQuestion,
          custom_question_mode: customQuestionMode
        });
      }

      if (notifyOnApplication) {
        Promise.resolve(notifyOnApplication({ application, page })).catch((err) => {
          logger.error("[portal] notify failed", err?.message || err);
        });
      }

      return res.json({ ok: true, application_id: appId });
    } catch (err) {
      logger.error("[portal] submit failed", err.message);
      return res.status(400).json({ error: err.message || "submit_failed" });
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
    const pages = await store.listPages();
    return res.json({ ok: true, pages });
  });

  router.post("/admin/portal/pages", requireWrite, async (req, res) => {
    try {
      const body = req.body || {};
      const slug = safeSlug(body.slug || body.brand || "page");

      const page = {
        slug,
        brand: String(body.brand || "").trim(),
        role: String(body.role || "").trim(),
        active: body.active !== false && String(body.active) !== "false",
        localeDefault: body.localeDefault === "en" ? "en" : "es",
        content: body.content || {},
        theme: body.theme || {},
        fields: body.fields || {},
        resume: body.resume || {},
        photo: body.photo || {},
        questions: Array.isArray(body.questions) ? body.questions : [],
        assets: body.assets || {}
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
      return res.json({ ok: true, page: saved });
    } catch (err) {
      logger.error("[portal] save page failed", err.message);
      return res.status(400).json({ error: err.message || "save_failed" });
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

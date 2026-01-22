"use strict";

const path = require("path");
const fs = require("fs");
const express = require("express");
const { createPortalStore } = require("./store");
const { renderApplyPage, renderAdminPage } = require("./templates");
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
  "image/gif"
]);

const MIME_EXT = {
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif"
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

async function saveBufferFile({ uploadsDir, relDir, fileName, buffer }) {
  const safeName = sanitizeFilename(fileName || "file");
  const fullDir = path.join(uploadsDir, relDir);
  ensureDir(fullDir);
  const fullPath = path.join(fullDir, safeName);
  await fs.promises.writeFile(fullPath, buffer);
  const relPath = path.posix.join(relDir, safeName);
  return { fullPath, relPath };
}

async function saveDataUrlFile({ dataUrl, uploadsDir, relDir, fileName, maxBytes, allowedMime }) {
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
  return saveBufferFile({ uploadsDir, relDir, fileName: finalName, buffer: parsed.buffer });
}

function buildCvText(app, page) {
  const lines = [];
  if (app.name) lines.push(`Name: ${app.name}`);
  if (app.email) lines.push(`Email: ${app.email}`);
  if (app.phone) lines.push(`Phone: ${app.phone}`);
  if (app.role) lines.push(`Role: ${app.role}`);
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

function createPortalRouter(options = {}) {
  const router = express.Router();
  const store = createPortalStore({
    dataDir: options.dataDir,
    pagesPath: options.pagesPath,
    appsPath: options.appsPath,
    logger: options.logger
  });

  const uploadsDir = options.uploadsDir || path.join(process.cwd(), "data", "uploads");
  const uploadsBaseUrl = resolveUploadsBaseUrl(options.uploadsBaseUrl || "/uploads");
  const resumeMaxBytes = options.resumeMaxBytes || 8 * 1024 * 1024;
  const photoMaxBytes = options.photoMaxBytes || 2 * 1024 * 1024;
  const logger = options.logger || console;
  const requireAdmin = options.requireAdmin || ((req, res, next) => next());
  const requireWrite = options.requireWrite || requireAdmin;
  const saveCvEntry = typeof options.saveCvEntry === "function" ? options.saveCvEntry : null;

  router.use(uploadsBaseUrl, express.static(uploadsDir, { fallthrough: true }));

  router.get("/apply/:slug", (req, res) => {
    const slug = safeSlug(req.params.slug);
    const page = store.getPage(slug);
    if (!page || page.active === false) {
      return res.status(404).send("not_found");
    }
    const payload = {
      ...page,
      slug,
      limits: { resumeMaxBytes, photoMaxBytes }
    };
    res.type("text/html").send(renderApplyPage(payload));
  });

  router.get("/apply/:slug/config", (req, res) => {
    const slug = safeSlug(req.params.slug);
    const page = store.getPage(slug);
    if (!page || page.active === false) {
      return res.status(404).json({ error: "not_found" });
    }
    const payload = {
      ...page,
      slug,
      limits: { resumeMaxBytes, photoMaxBytes }
    };
    res.json({ ok: true, page: payload });
  });

  router.post("/apply/:slug/submit", async (req, res) => {
    try {
      const slug = safeSlug(req.params.slug);
      const page = store.getPage(slug);
      if (!page || page.active === false) {
        return res.status(404).json({ error: "not_found" });
      }

      const body = req.body || {};
      const name = String(body.name || "").trim();
      const email = String(body.email || "").trim();
      const phoneRaw = String(body.phone || "").trim();
      const phone = normalizePhone(phoneRaw);
      const role = String(body.role || page.role || "").trim();
      const rawAnswers = body.answers && typeof body.answers === "object" ? body.answers : {};
      const answers = {};

      if (!name) return res.status(400).json({ error: "missing_name" });
      if (page.fields?.email?.required !== false && !/.+@.+\..+/.test(email)) {
        return res.status(400).json({ error: "invalid_email" });
      }
      if (page.fields?.phone?.required !== false && phone.length < 7) {
        return res.status(400).json({ error: "invalid_phone" });
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
          allowedMime: RESUME_MIME
        });
        if (saved) resumeUrl = `${uploadsBaseUrl}/${saved.relPath}`;
      }

      if (photoDataUrl) {
        const saved = await saveDataUrlFile({
          dataUrl: photoDataUrl,
          uploadsDir,
          relDir: appDir,
          fileName: photoFileName || `photo_${appId}.jpg`,
          maxBytes: photoMaxBytes,
          allowedMime: IMAGE_MIME
        });
        if (saved) photoUrl = `${uploadsBaseUrl}/${saved.relPath}`;
      }

      const application = {
        id: appId,
        slug,
        brand: page.brand || "",
        role,
        name,
        email,
        phone,
        answers,
        resume_url: resumeUrl,
        photo_url: photoUrl,
        created_at: new Date().toISOString()
      };

      await store.recordApplication(application);

      if (saveCvEntry) {
        const cvText = buildCvText(application, page);
        await saveCvEntry({
          brand: page.brand || "",
          role: role || "",
          applicant: name,
          phone,
          cv_text: cvText,
          cv_url: resumeUrl,
          cv_photo_url: photoUrl,
          source: `portal:${slug}`
        });
      }

      return res.json({ ok: true, application_id: appId });
    } catch (err) {
      logger.error("[portal] submit failed", err.message);
      return res.status(400).json({ error: err.message || "submit_failed" });
    }
  });

  router.get("/admin/portal", requireAdmin, (req, res) => {
    res.type("text/html").send(renderAdminPage({ title: "Portal Admin" }));
  });

  router.get("/admin/portal/pages", requireWrite, (req, res) => {
    return res.json({ ok: true, pages: store.listPages() });
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
          allowedMime: IMAGE_MIME
        });
        if (saved) page.assets.logoUrl = `${uploadsBaseUrl}/${saved.relPath}`;
      }
      if (uploads.hero.dataUrl) {
        const saved = await saveDataUrlFile({
          dataUrl: uploads.hero.dataUrl,
          uploadsDir,
          relDir: assetsDir,
          fileName: uploads.hero.fileName,
          maxBytes: photoMaxBytes,
          allowedMime: IMAGE_MIME
        });
        if (saved) page.assets.heroUrl = `${uploadsBaseUrl}/${saved.relPath}`;
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
            allowedMime: IMAGE_MIME
          });
          if (saved) galleryUrls.push(`${uploadsBaseUrl}/${saved.relPath}`);
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

  router.get("/admin/portal/applications", requireWrite, (req, res) => {
    const slug = req.query?.slug || "";
    return res.json({ ok: true, applications: store.listApplications({ slug }) });
  });

  return router;
}

module.exports = { createPortalRouter };

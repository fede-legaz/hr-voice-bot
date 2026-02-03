"use strict";

const fs = require("fs");
const path = require("path");
const { randomToken, safeSlug } = require("./utils");

function ensureDirForFile(filePath) {
  if (!filePath) return;
  const dir = path.dirname(filePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    if (err.code !== "EEXIST") {
      throw err;
    }
  }
}

async function writeJsonAtomic(filePath, data) {
  ensureDirForFile(filePath);
  const tmpPath = `${filePath}.tmp`;
  const payload = JSON.stringify(data, null, 2);
  await fs.promises.writeFile(tmpPath, payload, "utf8");
  await fs.promises.rename(tmpPath, filePath);
}

function readJsonSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

function appMatchesLocation(app, location) {
  if (!location) return true;
  const target = String(location || "").trim();
  if (!target) return true;
  const list = Array.isArray(app.locations) ? app.locations : [];
  return list.some((loc) => {
    if (!loc) return false;
    if (typeof loc === "string") return loc === target;
    if (loc.key && loc.key === target) return true;
    if (loc.label) {
      if (typeof loc.label === "string" && loc.label === target) return true;
      if (loc.label.es === target || loc.label.en === target) return true;
    }
    return false;
  });
}

function filterApplicationsByLocation(list, location) {
  if (!location) return list;
  return list.filter((app) => appMatchesLocation(app, location));
}

function createPortalStore(options = {}) {
  if (options.dbPool) {
    return createPortalStoreDb(options);
  }
  const dataDir = options.dataDir || path.join(process.cwd(), "data");
  const pagesPath = options.pagesPath || path.join(dataDir, "portal-pages.json");
  const appsPath = options.appsPath || path.join(dataDir, "portal-applications.json");
  const logger = options.logger || console;

  const state = {
    pages: [],
    pagesBySlug: new Map(),
    apps: [],
    appsById: new Map()
  };

  function hydratePages(list) {
    state.pages = [];
    state.pagesBySlug.clear();
    if (!Array.isArray(list)) return;
    list.forEach((page) => {
      if (!page || typeof page !== "object") return;
      const slug = safeSlug(page.slug || page.brand || "page");
      const now = new Date().toISOString();
      const entry = {
        id: page.id || randomToken(8),
        slug,
        brand: page.brand || "",
        role: page.role || "",
        active: page.active !== false,
        localeDefault: page.localeDefault || "es",
        theme: page.theme || {},
        content: page.content || {},
        fields: page.fields || {},
        resume: page.resume || {},
        photo: page.photo || {},
        questions: Array.isArray(page.questions) ? page.questions : [],
        assets: page.assets || {},
        created_at: page.created_at || now,
        updated_at: page.updated_at || now
      };
      state.pages.push(entry);
      state.pagesBySlug.set(slug, entry);
    });
  }

  function hydrateApps(list) {
    state.apps = [];
    state.appsById.clear();
    if (!Array.isArray(list)) return;
    list.forEach((app) => {
      if (!app || typeof app !== "object") return;
      const entry = { ...app };
      if (!entry.id) entry.id = randomToken(8);
      if (!entry.created_at) entry.created_at = new Date().toISOString();
      state.apps.push(entry);
      state.appsById.set(entry.id, entry);
    });
  }

  function load() {
    try {
      hydratePages(readJsonSafe(pagesPath) || []);
    } catch (err) {
      logger.error("[portal] failed to load pages", err.message);
    }
    try {
      hydrateApps(readJsonSafe(appsPath) || []);
    } catch (err) {
      logger.error("[portal] failed to load applications", err.message);
    }
  }

  async function savePages() {
    await writeJsonAtomic(pagesPath, state.pages);
  }

  async function saveApps() {
    await writeJsonAtomic(appsPath, state.apps);
  }

  function listPages() {
    return state.pages.slice();
  }

  function getPage(slug) {
    return state.pagesBySlug.get(safeSlug(slug));
  }

  async function upsertPage(page) {
    const slug = safeSlug(page.slug || page.brand || "page");
    const now = new Date().toISOString();
    const existing = state.pagesBySlug.get(slug);
    if (existing) {
      Object.assign(existing, page, { slug, updated_at: now });
    } else {
      const entry = {
        id: page.id || randomToken(8),
        slug,
        created_at: now,
        updated_at: now,
        ...page
      };
      state.pages.unshift(entry);
      state.pagesBySlug.set(slug, entry);
    }
    await savePages();
    return state.pagesBySlug.get(slug);
  }

  async function deletePage(slug) {
    const key = safeSlug(slug);
    const existing = state.pagesBySlug.get(key);
    if (!existing) return false;
    state.pages = state.pages.filter((p) => p.slug !== key);
    state.pagesBySlug.delete(key);
    await savePages();
    return true;
  }

  async function recordApplication(app) {
    const entry = {
      id: app.id || randomToken(8),
      created_at: app.created_at || new Date().toISOString(),
      application_code: app.application_code || app.answers?.apply_code || app.answers?.__apply_code || "",
      ...app
    };
    state.apps.unshift(entry);
    state.appsById.set(entry.id, entry);
    if (state.apps.length > 2000) {
      const removed = state.apps.pop();
      if (removed && removed.id) state.appsById.delete(removed.id);
    }
    await saveApps();
    return entry;
  }

  function listApplications(filters = {}) {
    const slug = filters.slug ? safeSlug(filters.slug) : "";
    const location = filters.location ? String(filters.location) : "";
    const list = !slug
      ? state.apps.slice()
      : state.apps.filter((app) => safeSlug(app.slug) === slug);
    return filterApplicationsByLocation(list, location);
  }

  load();

  return {
    listPages,
    getPage,
    upsertPage,
    deletePage,
    recordApplication,
    listApplications
  };
}

  function createPortalStoreDb(options = {}) {
    const dbPool = options.dbPool;
    const logger = options.logger || console;

    function toIso(value) {
    if (!value) return null;
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  }

  function ensureJsonValue(value, fallback) {
    if (value === undefined || value === null) {
      return JSON.stringify(fallback);
    }
    if (typeof value === "string") {
      try {
        JSON.parse(value);
        return value;
      } catch {
        return JSON.stringify(fallback);
      }
    }
    return JSON.stringify(value);
  }

  function mapPageRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      slug: row.slug,
      brand: row.brand || "",
      role: row.role || "",
      active: row.active !== false,
      localeDefault: row.locale_default || "es",
      theme: row.theme || {},
      content: row.content || {},
      fields: row.fields || {},
      resume: row.resume || {},
      photo: row.photo || {},
      questions: Array.isArray(row.questions) ? row.questions : [],
      assets: row.assets || {},
      created_at: toIso(row.created_at) || toIso(new Date()),
      updated_at: toIso(row.updated_at) || toIso(new Date())
    };
  }

  function mapAppRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      slug: row.slug,
      brand: row.brand || "",
      role: row.role || "",
      name: row.name || "",
      email: row.email || "",
      phone: row.phone || "",
      application_code: row.application_code || "",
      consent: !!row.consent,
      answers: row.answers || {},
      resume_url: row.resume_url || "",
      photo_url: row.photo_url || "",
      locations: row.locations || [],
      created_at: toIso(row.created_at) || toIso(new Date())
    };
  }

  async function listPages() {
    try {
      const resp = await dbPool.query(
        `
        SELECT id, slug, brand, role, active, locale_default, content, theme, fields, resume, photo, questions, assets, created_at, updated_at
        FROM portal_pages
        ORDER BY updated_at DESC
      `
      );
      return (resp.rows || []).map(mapPageRow).filter(Boolean);
    } catch (err) {
      logger.error("[portal] failed to list pages", err.message);
      return [];
    }
  }

  async function getPage(slug) {
    const key = safeSlug(slug);
    if (!key) return null;
    try {
      const resp = await dbPool.query(
        `
        SELECT id, slug, brand, role, active, locale_default, content, theme, fields, resume, photo, questions, assets, created_at, updated_at
        FROM portal_pages
        WHERE slug = $1
        LIMIT 1
      `,
        [key]
      );
      return mapPageRow(resp.rows?.[0]) || null;
    } catch (err) {
      logger.error("[portal] failed to get page", err.message);
      return null;
    }
  }

  async function upsertPage(page) {
    const slug = safeSlug(page.slug || page.brand || "page");
    const id = page.id || randomToken(8);
    const payload = {
      slug,
      id,
      brand: page.brand || "",
      role: page.role || "",
      active: page.active !== false,
      localeDefault: page.localeDefault === "en" ? "en" : "es",
      content: page.content || {},
      theme: page.theme || {},
      fields: page.fields || {},
      resume: page.resume || {},
      photo: page.photo || {},
      questions: Array.isArray(page.questions) ? page.questions : [],
      assets: page.assets || {}
    };
    try {
      const resp = await dbPool.query(
        `
        INSERT INTO portal_pages (
          id, slug, brand, role, active, locale_default,
          content, theme, fields, resume, photo, questions, assets,
          created_at, updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11, $12, $13,
          NOW(), NOW()
        )
        ON CONFLICT (slug) DO UPDATE
        SET brand = EXCLUDED.brand,
            role = EXCLUDED.role,
            active = EXCLUDED.active,
            locale_default = EXCLUDED.locale_default,
            content = EXCLUDED.content,
            theme = EXCLUDED.theme,
            fields = EXCLUDED.fields,
            resume = EXCLUDED.resume,
            photo = EXCLUDED.photo,
            questions = EXCLUDED.questions,
            assets = EXCLUDED.assets,
            updated_at = NOW()
        RETURNING id, slug, brand, role, active, locale_default, content, theme, fields, resume, photo, questions, assets, created_at, updated_at
      `,
        [
          payload.id,
          payload.slug,
          payload.brand,
          payload.role,
          payload.active,
          payload.localeDefault,
          ensureJsonValue(payload.content, {}),
          ensureJsonValue(payload.theme, {}),
          ensureJsonValue(payload.fields, {}),
          ensureJsonValue(payload.resume, {}),
          ensureJsonValue(payload.photo, {}),
          ensureJsonValue(payload.questions, []),
          ensureJsonValue(payload.assets, {})
        ]
      );
      return mapPageRow(resp.rows?.[0]) || null;
    } catch (err) {
      logger.error("[portal] failed to upsert page", err.message);
      throw err;
    }
  }

  async function deletePage(slug) {
    const key = safeSlug(slug);
    if (!key) return false;
    try {
      const resp = await dbPool.query("DELETE FROM portal_pages WHERE slug = $1", [key]);
      return (resp.rowCount || 0) > 0;
    } catch (err) {
      logger.error("[portal] failed to delete page", err.message);
      return false;
    }
  }

  async function recordApplication(app) {
    const entry = {
      id: app.id || randomToken(10),
      slug: safeSlug(app.slug || ""),
      brand: app.brand || "",
      role: app.role || "",
      name: app.name || "",
      email: app.email || "",
      phone: app.phone || "",
      application_code: app.application_code || app.answers?.apply_code || app.answers?.__apply_code || "",
      consent: !!app.consent,
      answers: app.answers || {},
      resume_url: app.resume_url || "",
      photo_url: app.photo_url || "",
      locations: Array.isArray(app.locations) ? app.locations : []
    };
    try {
      const resp = await dbPool.query(
        `
        INSERT INTO portal_applications (
          id, slug, brand, role, name, email, phone, application_code, consent, answers, resume_url, photo_url, locations
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING id, slug, brand, role, name, email, phone, application_code, consent, answers, resume_url, photo_url, locations, created_at
      `,
        [
          entry.id,
          entry.slug,
          entry.brand,
          entry.role,
          entry.name,
          entry.email,
          entry.phone,
          entry.application_code,
          entry.consent,
          ensureJsonValue(entry.answers, {}),
          entry.resume_url,
          entry.photo_url,
          ensureJsonValue(entry.locations, [])
        ]
      );
      return mapAppRow(resp.rows?.[0]) || entry;
    } catch (err) {
      logger.error("[portal] failed to record application", err.message);
      throw err;
    }
  }

  async function listApplications(filters = {}) {
    const slug = filters.slug ? safeSlug(filters.slug) : "";
    const location = filters.location ? String(filters.location) : "";
    try {
      if (!slug) {
        const resp = await dbPool.query(
          `
          SELECT id, slug, brand, role, name, email, phone, application_code, consent, answers, resume_url, photo_url, locations, created_at
          FROM portal_applications
          ORDER BY created_at DESC
        `
        );
        const list = (resp.rows || []).map(mapAppRow).filter(Boolean);
        return filterApplicationsByLocation(list, location);
      }
      const resp = await dbPool.query(
        `
        SELECT id, slug, brand, role, name, email, phone, application_code, consent, answers, resume_url, photo_url, locations, created_at
        FROM portal_applications
        WHERE slug = $1
        ORDER BY created_at DESC
      `,
        [slug]
      );
      const list = (resp.rows || []).map(mapAppRow).filter(Boolean);
      return filterApplicationsByLocation(list, location);
    } catch (err) {
      logger.error("[portal] failed to list applications", err.message);
      return [];
    }
  }

  return {
    listPages,
    getPage,
    upsertPage,
    deletePage,
    recordApplication,
    listApplications
  };
}

module.exports = { createPortalStore };

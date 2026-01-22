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

function createPortalStore(options = {}) {
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
    if (!slug) return state.apps.slice();
    return state.apps.filter((app) => safeSlug(app.slug) === slug);
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

module.exports = { createPortalStore };

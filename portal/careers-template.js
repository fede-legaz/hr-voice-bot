"use strict";

const fs = require("fs");
const path = require("path");
const { safeJsonStringify, escapeHtml } = require("./utils");

// The page markup lives in careers-page.html so its client script can be written without template-literal escaping.
const PAGE_SOURCE = fs.readFileSync(path.join(__dirname, "careers-page.html"), "utf8");

// seo (optional) comes from portal/seo.js buildPageSeo: title, description, extra head tags and server-rendered sections.
function renderCareersPage(data, seo = null) {
  const fallbackTitle = data.scope
    ? (data.title?.es || data.brand || "")
    : [data.title?.es || "Trabajá con nosotros", data.brand].filter(Boolean).join(" · ");
  const title = escapeHtml(seo?.title || fallbackTitle);
  const description = escapeHtml(seo?.description || data.intro?.es || "");
  const favicon = escapeHtml(data.logoUrl || "");
  // Plain function replacements so "$" in data is never treated as a replacement pattern.
  const pieces = {
    __PAGE_TITLE__: title,
    __PAGE_DESCRIPTION__: description,
    __FAVICON_URL__: favicon,
    __SEO_HEAD__: seo?.head || "",
    __SEO_TOP__: seo?.top || "",
    __SEO_BODY__: seo?.body || "",
    __CAREERS_DATA__: safeJsonStringify(data)
  };
  return PAGE_SOURCE.replace(/__(PAGE_TITLE|PAGE_DESCRIPTION|FAVICON_URL|SEO_HEAD|SEO_TOP|SEO_BODY|CAREERS_DATA)__/g, (m) => pieces[m]);
}

module.exports = { renderCareersPage };

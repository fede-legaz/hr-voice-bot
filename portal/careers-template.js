"use strict";

const fs = require("fs");
const path = require("path");
const { safeJsonStringify, escapeHtml } = require("./utils");

// The page markup lives in careers-page.html so its client script can be written without template-literal escaping.
const PAGE_SOURCE = fs.readFileSync(path.join(__dirname, "careers-page.html"), "utf8");

function renderCareersPage(data) {
  const title = escapeHtml(
    [data.title?.es || "Trabajá con nosotros", data.brand].filter(Boolean).join(" · ")
  );
  const description = escapeHtml(data.intro?.es || "");
  const favicon = escapeHtml(data.logoUrl || "");
  return PAGE_SOURCE
    .split("__PAGE_TITLE__").join(title)
    .split("__PAGE_DESCRIPTION__").join(description)
    .split("__FAVICON_URL__").join(favicon)
    .split("__CAREERS_DATA__").join(safeJsonStringify(data));
}

module.exports = { renderCareersPage };

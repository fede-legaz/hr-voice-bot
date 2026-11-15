"use strict";

// SEO for the public job portal: per-job pages for Google for Jobs (JobPosting), meta/Open Graph tags,
// crawlable (no-JS) job lists and FAQ for search engines and AI assistants, plus robots.txt, sitemap.xml and llms.txt.

const { escapeHtml } = require("./utils");

// Search-friendly titles and O*NET codes for the role keys used by the bot and the admin.
const ROLE_INFO = {
  "cook": { es: "Cocinero/a", en: "Line Cook", onet: "35-2014.00" },
  "prep cook": { es: "Prep cook", en: "Prep Cook", onet: "35-2021.00" },
  "front / cashier": { es: "Caja / Front", en: "Cashier / Front Counter", onet: "41-2011.00" },
  "dishwasher": { es: "Lavaplatos", en: "Dishwasher", onet: "35-9021.00" },
  "hostess": { es: "Hostess", en: "Host / Hostess", onet: "35-9031.00" },
  "server / runner": { es: "Server / Runner", en: "Server / Food Runner", onet: "35-3031.00" },
  "pizzero": { es: "Pizzero/a", en: "Pizza Maker", onet: "35-2014.00" },
  "food truck": { es: "Food truck", en: "Food Truck Crew", onet: "35-3023.00" },
  "mantenimiento": { es: "Mantenimiento", en: "Maintenance Worker", onet: "49-9071.00" },
  "barista": { es: "Barista", en: "Barista", onet: "35-3023.01" }
};

const JOB_VALID_DAYS = 30;

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function titleCase(value) {
  return String(value || "").replace(/\b\w/g, (c) => c.toUpperCase());
}

function roleInfo(role) {
  const key = String(role?.value || "").toLowerCase().trim();
  const known = ROLE_INFO[key];
  const label = role?.label || {};
  const es = known?.es || label.es || titleCase(role?.value);
  const en = known?.en || label.en || titleCase(role?.value);
  return { es, en, onet: known?.onet || "", slug: slugify(en) || slugify(role?.value) };
}

// "Prep Cook" / "Prep cook" or "Barista" / "Barista": no need to show both.
function sameName(info) {
  const a = String(info.en || "").toLowerCase();
  const b = String(info.es || "").toLowerCase();
  return a === b || a.includes(b) || b.includes(a);
}

function locationSlug(loc) {
  return slugify(loc?.name || loc?.key);
}

function jobPath(loc, role) {
  return `/jobs/${locationSlug(loc)}/${roleInfo(role).slug}`;
}

// "6954 Collins Ave, Miami Beach, FL 33141" -> PostalAddress parts.
function parseAddress(address) {
  const parts = String(address || "").split(",").map((p) => p.trim()).filter(Boolean);
  const out = { street: parts[0] || "", city: "", region: "FL", postal: "" };
  if (parts.length >= 3) {
    out.city = parts[parts.length - 2];
    const m = parts[parts.length - 1].match(/^([A-Za-z]{2})\s*(\d{5})?/);
    if (m) {
      out.region = m[1].toUpperCase();
      out.postal = m[2] || "";
    }
  } else if (parts.length === 2) {
    out.city = parts[1];
  }
  return out;
}

function absUrl(baseUrl, url) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `${baseUrl}${value.startsWith("/") ? "" : "/"}${value}`;
}

function ogImageUrl(baseUrl, url) {
  const abs = absUrl(baseUrl, url);
  if (!abs) return "";
  if (!/^https?:\/\//i.test(abs) || /localhost|127\.0\.0\.1/.test(abs)) return abs;
  return `https://wsrv.nl/?url=${encodeURIComponent(abs)}&w=1200&h=630&fit=cover&output=jpg&q=82`;
}

function isoDate(value, fallback) {
  const d = value ? new Date(value) : null;
  if (d && !Number.isNaN(d.getTime())) return d.toISOString();
  return fallback || new Date().toISOString();
}

function listText(items, lang) {
  const list = items.filter(Boolean);
  if (list.length <= 1) return list.join("");
  const last = list[list.length - 1];
  return `${list.slice(0, -1).join(", ")} ${lang === "es" ? "y" : "and"} ${last}`;
}

function cityOf(loc) {
  return parseAddress(loc.address).city || "Miami Beach";
}

// Every open job that should be advertised: locations hidden from /careers are not pushed to Google.
function collectJobs(payload) {
  const jobs = [];
  (payload?.locations || []).forEach((loc) => {
    if (loc.portalHidden) return;
    (loc.roles || []).forEach((role) => {
      jobs.push({ loc, role, info: roleInfo(role), path: jobPath(loc, role) });
    });
  });
  return jobs;
}

function requirementLines(role, lang) {
  const lines = (role.requirements?.[lang] || []).slice();
  if (role.english === true) lines.push(lang === "es" ? "Inglés requerido" : "English required");
  if (role.english === false) lines.push(lang === "es" ? "No hace falta inglés" : "No English needed");
  if (role.physical) lines.push(lang === "es" ? "Rol físico, de pie durante el turno" : "Physical role, on your feet during the shift");
  return lines;
}

function benefitLines(payload, lang) {
  return (payload?.benefits || []).map((b) => b?.[lang] || b?.en || b?.es || "").filter(Boolean);
}

function jobSummary(job, lang) {
  const { loc, info } = job;
  const tagline = loc.tagline?.[lang] || "";
  const where = [loc.area, cityOf(loc)].filter((v, i, arr) => v && arr.indexOf(v) === i).join(", ");
  if (lang === "es") {
    return `${loc.name}${tagline ? ` (${tagline})` : ""} busca ${info.es} en ${where}, Florida. Postulate online en 2 minutos y te contactamos rápido por teléfono o SMS, en español o en inglés.`;
  }
  return `${loc.name}${tagline ? ` (${tagline})` : ""} is hiring a ${info.en} in ${where}, Florida. Apply online in 2 minutes and we get back to you fast by phone or text, in English or Spanish.`;
}

function jobDescriptionHtml(job, payload, baseUrl) {
  const section = (lang) => {
    const reqs = requirementLines(job.role, lang);
    const perks = benefitLines(payload, lang);
    const h = (en, es) => (lang === "es" ? es : en);
    return [
      `<p>${escapeHtml(jobSummary(job, lang))}</p>`,
      job.role.urgent ? `<p><strong>${h("Urgent hiring: fast interview and quick start.", "Contratación urgente: entrevista rápida e inicio inmediato.")}</strong></p>` : "",
      `<p><strong>${h("Location", "Ubicación")}:</strong> ${escapeHtml(job.loc.address || job.loc.area || "")}</p>`,
      reqs.length ? `<p><strong>${h("Requirements", "Requisitos")}:</strong></p><ul>${reqs.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>` : "",
      perks.length ? `<p><strong>${h("Benefits", "Beneficios")}:</strong></p><ul>${perks.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>` : "",
      `<p><strong>${h("How to apply", "Cómo postularte")}:</strong> ${h(
        `Apply online at ${baseUrl}${job.path}. It takes 2 minutes and you can do your first interview by phone right away.`,
        `Postulate online en ${baseUrl}${job.path}. Te toma 2 minutos y podés hacer la primera entrevista por teléfono en el momento.`
      )}</p>`
    ].join("");
  };
  return `${section("en")}<p><strong>En español</strong></p>${section("es")}`;
}

function jobPostingLd(job, payload, baseUrl) {
  const { loc, role, info } = job;
  const addr = parseAddress(loc.address);
  const now = Date.now();
  const ld = {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: sameName(info) ? info.en : `${info.en} / ${info.es}`,
    description: jobDescriptionHtml(job, payload, baseUrl),
    identifier: { "@type": "PropertyValue", name: loc.name, value: `${loc.key}-${info.slug}` },
    datePosted: isoDate(loc.updatedAt, new Date(now).toISOString()).slice(0, 10),
    validThrough: new Date(now + JOB_VALID_DAYS * 86400000).toISOString(),
    employmentType: ["FULL_TIME", "PART_TIME"],
    hiringOrganization: {
      "@type": "Organization",
      name: loc.name,
      sameAs: `${baseUrl}/join/${loc.page}`,
      ...(loc.logoUrl ? { logo: absUrl(baseUrl, loc.logoUrl) } : {})
    },
    jobLocation: {
      "@type": "Place",
      address: {
        "@type": "PostalAddress",
        streetAddress: addr.street,
        addressLocality: addr.city || "Miami Beach",
        addressRegion: addr.region || "FL",
        ...(addr.postal ? { postalCode: addr.postal } : {}),
        addressCountry: "US"
      },
      ...(Number.isFinite(loc.lat) && Number.isFinite(loc.lng)
        ? { geo: { "@type": "GeoCoordinates", latitude: loc.lat, longitude: loc.lng } }
        : {})
    },
    directApply: true,
    industry: "Restaurants",
    url: `${baseUrl}${job.path}`
  };
  if (info.onet) ld.occupationalCategory = info.onet;
  const perks = benefitLines(payload, "en");
  if (perks.length) ld.jobBenefits = perks.join(", ");
  const reqs = requirementLines(role, "en");
  if (reqs.length) ld.qualifications = reqs.join(". ");
  if (role.english === true) ld.skills = "English";
  if (loc.heroUrl) ld.image = absUrl(baseUrl, loc.heroUrl);
  return ld;
}

function restaurantLd(loc, baseUrl) {
  const addr = parseAddress(loc.address);
  return {
    "@type": "Restaurant",
    name: loc.name,
    ...(loc.heroUrl ? { image: absUrl(baseUrl, loc.heroUrl) } : {}),
    ...(loc.logoUrl ? { logo: absUrl(baseUrl, loc.logoUrl) } : {}),
    address: {
      "@type": "PostalAddress",
      streetAddress: addr.street,
      addressLocality: addr.city || "Miami Beach",
      addressRegion: addr.region || "FL",
      ...(addr.postal ? { postalCode: addr.postal } : {}),
      addressCountry: "US"
    },
    ...(Number.isFinite(loc.lat) && Number.isFinite(loc.lng)
      ? { geo: { "@type": "GeoCoordinates", latitude: loc.lat, longitude: loc.lng } }
      : {})
  };
}

function uniqueRoleNames(jobs, lang) {
  const seen = [];
  jobs.forEach((j) => {
    const name = lang === "es" ? j.info.es : j.info.en;
    if (!seen.includes(name)) seen.push(name);
  });
  return seen;
}

// Questions people (and AI assistants) ask before applying, answered with live data.
function buildFaq(payload, jobs, kind) {
  const locs = (payload.locations || []).filter((l) => !l.portalHidden);
  const many = locs.length > 1;
  const urgent = jobs.filter((j) => j.role.urgent);
  const noEnglish = jobs.filter((j) => j.role.english === false);
  const where = (lang) => locs.map((l) => `${l.name} (${l.address || l.area})`).join(lang === "es" ? "; " : "; ");
  const faq = {
    en: [
      {
        q: "How do I apply?",
        a: `Fill out the short form on this page: ${many ? "pick one or more locations, " : ""}choose the positions you want and leave your name, phone and email. It takes about 2 minutes. We contact you by phone or text, and you can do your first interview by phone right away.`
      },
      {
        q: "What jobs are open right now?",
        a: `${listText(uniqueRoleNames(jobs, "en"), "en")}.${urgent.length ? ` Hiring urgently: ${listText(urgent.map((j) => `${j.info.en} at ${j.loc.name}`), "en")}.` : ""}`
      },
      {
        q: "Do I need to speak English?",
        a: `Not for every job. Each position says whether English is required${noEnglish.length ? ` (for example, ${listText(uniqueRoleNames(noEnglish, "en").slice(0, 3), "en")} do not require it)` : ""}. We interview in English or Spanish.`
      },
      { q: many ? "Where are the restaurants?" : "Where is the restaurant?", a: `${where("en")}.` },
      {
        q: "Do I need experience?",
        a: "Not always. Each job lists its requirements, and we train you from day one."
      },
      {
        q: "What benefits do you offer?",
        a: `${listText(benefitLines(payload, "en"), "en")}.`
      }
    ],
    es: [
      {
        q: "¿Cómo me postulo?",
        a: `Completá el formulario corto de esta página: ${many ? "elegí uno o más locales, " : ""}marcá los puestos que te interesan y dejanos tu nombre, teléfono y email. Toma unos 2 minutos. Te contactamos por teléfono o SMS, y podés hacer la primera entrevista por teléfono en el momento.`
      },
      {
        q: "¿Qué puestos hay abiertos ahora?",
        a: `${listText(uniqueRoleNames(jobs, "es"), "es")}.${urgent.length ? ` Contratando urgente: ${listText(urgent.map((j) => `${j.info.es} en ${j.loc.name}`), "es")}.` : ""}`
      },
      {
        q: "¿Necesito hablar inglés?",
        a: `No para todos los puestos. Cada puesto indica si requiere inglés${noEnglish.length ? ` (por ejemplo, ${listText(uniqueRoleNames(noEnglish, "es").slice(0, 3), "es")} no lo requieren)` : ""}. Hacemos la entrevista en español o en inglés.`
      },
      { q: many ? "¿Dónde están los restaurantes?" : "¿Dónde queda el restaurante?", a: `${where("es")}.` },
      {
        q: "¿Necesito experiencia?",
        a: "No siempre. Cada puesto muestra sus requisitos y te entrenamos desde el primer día."
      },
      {
        q: "¿Qué beneficios tienen?",
        a: `${listText(benefitLines(payload, "es"), "es")}.`
      }
    ]
  };
  if (kind === "home" && many) {
    faq.en.push({ q: "Can I apply to several restaurants at once?", a: "Yes. With one application you can pick several locations and several positions at each one." });
    faq.es.push({ q: "¿Puedo postularme a varios locales a la vez?", a: "Sí. Con una sola postulación elegís varios locales y varios puestos en cada uno." });
  }
  // Drop answers that ended up empty (e.g. no benefits configured).
  ["en", "es"].forEach((lang) => { faq[lang] = faq[lang].filter((item) => item.a && item.a !== "."); });
  return faq;
}

function faqLd(faq) {
  return {
    "@type": "FAQPage",
    mainEntity: faq.en.concat(faq.es).map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: item.a }
    }))
  };
}

function jsonLdTag(obj) {
  // Escape "<" so a value can never close the script tag.
  return `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, "\\u003c")}</script>`;
}

function langBlock(lang, html) {
  return `<div class="seo-l" lang="${lang}">${html}</div>`;
}

function jobsListHtml(jobs, baseUrl, kind, brandName) {
  const byLoc = [];
  jobs.forEach((job) => {
    let group = byLoc.find((g) => g.loc.key === job.loc.key);
    if (!group) {
      group = { loc: job.loc, jobs: [] };
      byLoc.push(group);
    }
    group.jobs.push(job);
  });
  const render = (lang) => {
    const h = (en, es) => (lang === "es" ? es : en);
    const cards = byLoc.map((g) => {
      const items = g.jobs
        .slice()
        .sort((a, b) => (b.role.urgent ? 1 : 0) - (a.role.urgent ? 1 : 0))
        .map((j) => `<li><a href="${escapeHtml(j.path)}">${escapeHtml(lang === "es" ? j.info.es : j.info.en)}</a>${j.role.urgent ? `<span class="seo-hot">${h("Urgent", "Urgente")}</span>` : ""}</li>`)
        .join("");
      return `<article class="seo-card"><h3>${escapeHtml(g.loc.name)}</h3><p class="seo-addr">${escapeHtml(g.loc.address || g.loc.area || "")}</p><ul class="seo-jobs">${items}</ul></article>`;
    }).join("");
    const title = kind === "home"
      ? h("Restaurant jobs in Miami Beach", "Trabajo en restaurantes en Miami Beach")
      : h(`Jobs at ${brandName || byLoc[0]?.loc?.name || ""}`, `Empleos en ${brandName || byLoc[0]?.loc?.name || ""}`);
    const more = kind === "home" ? "" : `<p class="seo-more"><a href="/">${h("See jobs at every Yes! restaurant", "Ver empleos en todos los locales Yes!")}</a></p>`;
    return `<p class="kicker">${h("All open jobs", "Todos los empleos")}</p><h2>${escapeHtml(title)}</h2><div class="seo-grid">${cards}</div>${more}`;
  };
  return langBlock("en", render("en")) + langBlock("es", render("es"));
}

function faqHtml(faq) {
  const render = (lang) => {
    const items = faq[lang].map((item) => `<details class="seo-faq"><summary>${escapeHtml(item.q)}</summary><p>${escapeHtml(item.a)}</p></details>`).join("");
    return `<p class="kicker">${lang === "es" ? "Preguntas frecuentes" : "FAQ"}</p><h2>${lang === "es" ? "Antes de postularte" : "Before you apply"}</h2><div class="seo-faqs">${items}</div>`;
  };
  return langBlock("en", render("en")) + langBlock("es", render("es"));
}

// Server-rendered job detail shown above the hero on /jobs/:location/:role.
function focusHtml(job, payload) {
  const render = (lang) => {
    const h = (en, es) => (lang === "es" ? es : en);
    const reqs = requirementLines(job.role, lang);
    const title = lang === "es" ? job.info.es : job.info.en;
    return `<nav class="seo-crumbs" aria-label="Breadcrumb"><a href="/">${h("Jobs", "Empleos")}</a><span>/</span><a href="/join/${escapeHtml(job.loc.page)}">${escapeHtml(job.loc.name)}</a><span>/</span><b>${escapeHtml(title)}</b></nav>` +
      `<div class="seo-focus-card${job.role.urgent ? " hot" : ""}">` +
      (job.role.urgent ? `<span class="seo-flag">${h("Urgent · hiring now", "Urgente · buscamos ya")}</span>` : "") +
      `<h1>${escapeHtml(title)} <span>${h("at", "en")} ${escapeHtml(job.loc.name)}</span></h1>` +
      `<p class="seo-addr">${escapeHtml(job.loc.address || job.loc.area || "")}</p>` +
      `<p>${escapeHtml(jobSummary(job, lang))}</p>` +
      (reqs.length ? `<ul class="seo-reqs">${reqs.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>` : "") +
      `<a class="btn ${job.role.urgent ? "btn-hot" : "btn-accent"}" href="#postulate">${h("Apply for this job", "Postularme a este puesto")}</a>` +
      `</div>`;
  };
  return `<section class="seo-focus"><div class="wrap">${langBlock("en", render("en"))}${langBlock("es", render("es"))}</div></section>`;
}

function clip(text, max) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1).replace(/[\s,.;:]+\S*$/, "")}…` : s;
}

/**
 * Builds the SEO pieces for one portal page.
 * kind: "home" (/), "brand" (/join/:slug) or "job" (/jobs/:location/:role, with focusJob).
 */
function buildPageSeo({ kind, payload, baseUrl, path, focusJob = null, gone = false }) {
  const jobs = collectJobs(payload);
  const locs = (payload.locations || []).filter((l) => !l.portalHidden);
  const canonical = `${baseUrl}${path}`;
  const roleNamesEn = uniqueRoleNames(jobs, "en");
  const roleNamesEs = uniqueRoleNames(jobs, "es");
  const urgentCount = jobs.filter((j) => j.role.urgent).length;
  const hiring = urgentCount ? "Hiring now" : "Now hiring";
  let title;
  let description;
  let image = locs[0]?.heroUrl || (payload.teams?.[0]?.photos || [])[0] || "";

  if (kind === "job" && focusJob) {
    const { info, loc } = focusJob;
    const city = cityOf(loc);
    title = `${focusJob.role.urgent ? "Urgent: " : ""}${info.en} Job${!sameName(info) ? ` (${info.es})` : ""} – ${loc.name}, ${city} FL | Apply now`;
    description = clip(`${loc.name} is hiring a ${info.en} in ${city}, FL. Apply in 2 minutes, fast phone interview, English or Spanish. Buscamos ${info.es}: postulate ya.`, 300);
    image = loc.heroUrl || image;
  } else if (kind === "brand") {
    const name = payload.brand || locs[0]?.name || "";
    const city = locs[0] ? cityOf(locs[0]) : "Miami Beach";
    title = `Jobs at ${name}, ${city} FL – ${hiring}: ${clip(listText(roleNamesEn.slice(0, 3), "en"), 60)} | Trabajo`;
    description = clip(`${hiring} at ${name}: ${listText(roleNamesEn, "en")}. Apply in 2 minutes, English or Spanish. Trabajo en ${name}: ${listText(roleNamesEs.slice(0, 4), "es")}.`, 300);
  } else {
    title = `Restaurant Jobs in Miami Beach – ${hiring}: ${clip(listText(roleNamesEn.slice(0, 3), "en"), 60)} | ${payload.brand || "Yes! Restaurants"}`;
    description = clip(`${payload.brand || "Yes! Restaurants"} is hiring at ${locs.length} restaurants in Miami Beach and MiMo: ${listText(roleNamesEn, "en")}. One 2-minute application, English or Spanish. Trabajo en restaurantes en Miami Beach.`, 300);
  }

  const faq = buildFaq(payload, jobs, kind);
  const ld = [];
  const graph = [];
  const orgName = payload.brand || "Yes! Restaurants";
  if (kind === "home") {
    graph.push({ "@type": "Organization", name: orgName, url: `${baseUrl}/`, ...(payload.logoUrl ? { logo: absUrl(baseUrl, payload.logoUrl) } : {}) });
    graph.push({ "@type": "WebSite", name: `${orgName} Jobs`, url: `${baseUrl}/`, inLanguage: ["en", "es"] });
  }
  if (kind !== "job") {
    locs.forEach((loc) => graph.push(restaurantLd(loc, baseUrl)));
    graph.push({
      "@type": "ItemList",
      name: kind === "home" ? `${orgName} open jobs` : `${payload.brand} open jobs`,
      itemListElement: jobs.map((j, idx) => ({ "@type": "ListItem", position: idx + 1, url: `${baseUrl}${j.path}`, name: `${j.info.en} – ${j.loc.name}` }))
    });
  }
  const crumbs = [{ name: "Jobs", url: `${baseUrl}/` }];
  if (kind === "brand") crumbs.push({ name: payload.brand, url: canonical });
  if (kind === "job" && focusJob) {
    crumbs.push({ name: focusJob.loc.name, url: `${baseUrl}/join/${focusJob.loc.page}` });
    crumbs.push({ name: focusJob.info.en, url: canonical });
  }
  if (crumbs.length > 1) {
    graph.push({
      "@type": "BreadcrumbList",
      itemListElement: crumbs.map((c, idx) => ({ "@type": "ListItem", position: idx + 1, name: c.name, item: c.url }))
    });
  }
  graph.push(faqLd(faq));
  ld.push({ "@context": "https://schema.org", "@graph": graph });
  if (kind === "job" && focusJob && !gone) ld.push(jobPostingLd(focusJob, payload, baseUrl));

  const ogImage = ogImageUrl(baseUrl, image);
  const head = [
    `<link rel="canonical" href="${escapeHtml(canonical)}" />`,
    gone ? `<meta name="robots" content="noindex, follow" />` : `<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${escapeHtml(`${orgName} Jobs`)}" />`,
    `<meta property="og:url" content="${escapeHtml(canonical)}" />`,
    `<meta property="og:locale" content="en_US" />`,
    `<meta property="og:locale:alternate" content="es_US" />`,
    ogImage ? `<meta property="og:image" content="${escapeHtml(ogImage)}" />` : "",
    ogImage ? `<meta property="og:image:width" content="1200" /><meta property="og:image:height" content="630" />` : "",
    `<meta name="twitter:card" content="${ogImage ? "summary_large_image" : "summary"}" />`,
    `<meta name="twitter:title" content="${escapeHtml(title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(description)}" />`,
    ogImage ? `<meta name="twitter:image" content="${escapeHtml(ogImage)}" />` : "",
    `<meta name="geo.region" content="US-FL" />`,
    `<meta name="geo.placename" content="Miami Beach" />`,
    `<link rel="alternate" type="text/plain" href="/llms.txt" title="LLM-readable job list" />`,
    ...ld.map(jsonLdTag)
  ].filter(Boolean).join("\n  ");

  const body = `<section class="block seo-block" id="empleos"><div class="wrap">${jobsListHtml(jobs, baseUrl, kind, payload.brand)}</div></section>` +
    `<section class="block alt seo-block" id="faq"><div class="wrap">${faqHtml(faq)}</div></section>`;

  return {
    title,
    description,
    head,
    top: kind === "job" && focusJob ? focusHtml(focusJob, payload) : "",
    body
  };
}

function robotsTxt(baseUrl) {
  const blocked = ["/admin", "/openclaw", "/onboard", "/r/", "/uploads/", "/apply/", "/careers/submit"];
  // AI crawlers are named one by one: a crawler that matches its own group ignores the "*" group.
  const agents = [
    "*", "Googlebot", "Bingbot", "GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-SearchBot",
    "Claude-User", "PerplexityBot", "Perplexity-User", "Google-Extended", "Applebot", "Applebot-Extended",
    "Meta-ExternalAgent", "DuckAssistBot", "CCBot"
  ];
  const rules = ["Allow: /", ...blocked.map((p) => `Disallow: ${p}`)].join("\n");
  return agents.map((a) => `User-agent: ${a}\n${rules}`).join("\n\n") + `\n\nSitemap: ${baseUrl}/sitemap.xml\n`;
}

function sitemapXml(baseUrl, entries) {
  const urls = entries.map((e) =>
    `  <url><loc>${escapeHtml(`${baseUrl}${e.path}`)}</loc>${e.lastmod ? `<lastmod>${e.lastmod.slice(0, 10)}</lastmod>` : ""}<changefreq>${e.changefreq || "daily"}</changefreq><priority>${e.priority || "0.8"}</priority></url>`
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

// Plain-text summary for AI assistants (llmstxt.org format), bilingual.
function llmsTxt(baseUrl, payload) {
  const jobs = collectJobs(payload);
  const locs = (payload.locations || []).filter((l) => !l.portalHidden);
  const brand = payload.brand || "Yes! Restaurants";
  const lines = [
    `# ${brand} – Restaurant jobs in Miami Beach, FL`,
    "",
    `> ${brand} is hiring at ${locs.length} restaurants in Miami Beach and MiMo (Miami, Florida). Candidates apply online in about 2 minutes at ${baseUrl}/ , in English or Spanish, and can do the first interview by phone right away. / ${brand} está contratando en ${locs.length} restaurantes de Miami Beach y MiMo. Postulación online en 2 minutos, en español o en inglés.`,
    "",
    "## How to apply / Cómo postularse",
    "",
    `- Apply here (all locations, one application): ${baseUrl}/`,
    "- Pick one or more locations and positions, then leave name, phone and email. Some locations ask for a resume.",
    "- We reach out by phone or SMS. English is not required for every position.",
    ""
  ];
  locs.forEach((loc) => {
    lines.push(`## ${loc.name}`);
    lines.push("");
    if (loc.tagline?.en) lines.push(`${loc.tagline.en}. Address: ${loc.address || loc.area}. Apply: ${baseUrl}/join/${loc.page}`);
    else lines.push(`Address: ${loc.address || loc.area}. Apply: ${baseUrl}/join/${loc.page}`);
    lines.push("");
    jobs.filter((j) => j.loc.key === loc.key).forEach((j) => {
      const reqs = requirementLines(j.role, "en");
      lines.push(`- [${j.info.en}${!sameName(j.info) ? ` (${j.info.es})` : ""}](${baseUrl}${j.path})${j.role.urgent ? " – URGENT, hiring now" : ""}${reqs.length ? `: ${reqs.join("; ")}` : ""}`);
    });
    lines.push("");
  });
  const perks = benefitLines(payload, "en");
  if (perks.length) {
    lines.push("## Benefits / Beneficios", "");
    perks.forEach((p) => lines.push(`- ${p}`));
    lines.push("");
  }
  lines.push(`Updated: ${new Date().toISOString().slice(0, 10)}`, "");
  return lines.join("\n");
}

module.exports = {
  buildPageSeo,
  collectJobs,
  jobPath,
  locationSlug,
  roleInfo,
  robotsTxt,
  sitemapXml,
  llmsTxt
};

"use strict";

const { safeJsonStringify, escapeHtml } = require("./utils");

function renderApplyPage(page, options = {}) {
  const pageJson = safeJsonStringify(page);
  const titleText =
    (page.content && (page.content.title?.es || page.content.title?.en || page.content.title)) ||
    page.brand ||
    "Apply";
  const title = escapeHtml(titleText);
  const fontUrl = escapeHtml(page.theme?.fontUrl || "");
  const fontHeading = escapeHtml(page.theme?.fontHeading || "Fraunces");
  const fontBody = escapeHtml(page.theme?.fontBody || "Manrope");
  const faviconUrl = escapeHtml(page.assets?.faviconUrl || "");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  ${faviconUrl ? '<link rel="icon" href="' + faviconUrl + '" />' : ""}
  ${fontUrl ? '<link rel="stylesheet" href="' + fontUrl + '" />' : ""}
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400;600;700&family=Manrope:wght@400;600;700&display=swap" />
  <style>
    :root {
      --bg: #f6f2e9;
      --card: #ffffff;
      --text: #241b13;
      --muted: #6c5f57;
      --primary: #c84c33;
      --primary-rgb: 200, 76, 51;
      --accent: #1f6f5c;
      --accent-rgb: 31, 111, 92;
      --ring: rgba(200, 76, 51, 0.25);
      --shadow: 0 18px 40px rgba(36, 27, 19, 0.15);
      --font-heading: '${fontHeading}', 'Fraunces', serif;
      --font-body: '${fontBody}', 'Manrope', sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: var(--font-body);
      color: var(--text);
      background-color: var(--bg);
      background-image:
        radial-gradient(circle at 10% 10%, rgba(var(--primary-rgb), 0.08), transparent 45%),
        radial-gradient(circle at 90% 20%, rgba(var(--accent-rgb), 0.12), transparent 45%);
      min-height: 100vh;
    }
    .page {
      max-width: 1100px;
      margin: 0 auto;
      padding: 32px 20px 64px;
      display: grid;
      gap: 24px;
    }
    .hero {
      position: relative;
      padding: 28px;
      border-radius: 28px;
      background: var(--card);
      box-shadow: var(--shadow);
      overflow: hidden;
      display: grid;
      gap: 24px;
      grid-template-columns: minmax(0, 1.1fr) minmax(0, 0.9fr);
      align-items: center;
    }
    .hero::after {
      content: "";
      position: absolute;
      inset: auto -30% -40% auto;
      width: 260px;
      height: 260px;
      background: radial-gradient(circle, rgba(200,76,51,0.12), transparent 70%);
      transform: rotate(12deg);
    }
    .hero-card {
      position: relative;
      z-index: 1;
      display: grid;
      gap: 12px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      border-radius: 999px;
      background: rgba(31,111,92,0.12);
      color: var(--accent);
      font-weight: 600;
      letter-spacing: 0.02em;
      text-transform: uppercase;
      font-size: 12px;
    }
    .brand-row {
      display: flex;
      align-items: center;
      gap: 12px;
      font-weight: 600;
      color: var(--muted);
    }
    .brand-logo {
      width: 48px;
      height: 48px;
      border-radius: 16px;
      object-fit: cover;
      background: #f0e7dd;
    }
    h1 {
      font-family: var(--font-heading);
      font-size: clamp(28px, 4vw, 46px);
      margin: 0;
      line-height: 1.05;
    }
    .hero p {
      margin: 0;
      color: var(--muted);
      font-size: 16px;
    }
    .hero-media {
      position: relative;
      border-radius: 22px;
      overflow: hidden;
      height: clamp(220px, 30vw, 360px);
      background: linear-gradient(135deg, rgba(200,76,51,0.18), rgba(31,111,92,0.18));
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .hero-media img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .lang-toggle {
      display: inline-flex;
      border-radius: 999px;
      background: rgba(36,27,19,0.06);
      padding: 4px;
      gap: 4px;
    }
    .lang-toggle button {
      border: none;
      background: transparent;
      padding: 6px 12px;
      border-radius: 999px;
      font-weight: 600;
      cursor: pointer;
      color: var(--muted);
    }
    .lang-toggle button.active {
      background: var(--card);
      color: var(--text);
      box-shadow: 0 6px 14px rgba(0,0,0,0.08);
    }
    .grid {
      display: grid;
      gap: 18px;
      grid-template-columns: minmax(0, 1.1fr) minmax(0, 0.9fr);
      align-items: start;
    }
    .card {
      background: var(--card);
      border-radius: 24px;
      box-shadow: var(--shadow);
      padding: 24px;
    }
    .form-grid {
      display: grid;
      gap: 16px;
    }
    label {
      display: block;
      font-weight: 600;
      margin-bottom: 8px;
    }
    input, select, textarea {
      width: 100%;
      padding: 12px 14px;
      border-radius: 14px;
      border: 1px solid rgba(36,27,19,0.15);
      background: #fff;
      font-size: 15px;
      font-family: var(--font-body);
      transition: border 0.2s ease, box-shadow 0.2s ease;
    }
    textarea { min-height: 110px; resize: vertical; }
    input:focus, select:focus, textarea:focus {
      outline: none;
      border-color: var(--primary);
      box-shadow: 0 0 0 4px var(--ring);
    }
    .row { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
    .row > .field-span { grid-column: 1 / -1; }
    .multi-options {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
    }
    .multi-options.layout-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .multi-options.layout-compact {
      grid-template-columns: 1fr;
      gap: 6px;
    }
    .multi-options.layout-maps {
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 14px;
    }
    .multi-option {
      display: flex;
      align-items: center;
      gap: 10px;
      border: 1px solid rgba(36,27,19,0.12);
      border-radius: 16px;
      padding: 12px 14px;
      background: #fff;
      cursor: pointer;
      font-weight: 600;
      color: var(--text);
      transition: border-color 0.2s ease, box-shadow 0.2s ease, transform 0.2s ease, background 0.2s ease;
    }
    .multi-options.layout-chips .multi-option {
      border-radius: 999px;
      padding: 8px 12px;
      font-size: 13px;
    }
    .multi-options.layout-compact .multi-option {
      border-radius: 12px;
      padding: 8px 10px;
      font-size: 13px;
    }
    .multi-options.layout-maps .multi-option {
      flex-direction: column;
      align-items: stretch;
      gap: 10px;
    }
    .multi-option:hover {
      border-color: var(--primary);
      box-shadow: 0 10px 20px rgba(36,27,19,0.12);
      transform: translateY(-1px);
    }
    .multi-option.is-checked {
      border-color: var(--primary);
      background: rgba(200,76,51,0.08);
      box-shadow: 0 0 0 3px var(--ring);
    }
    .multi-option input {
      width: 18px;
      height: 18px;
      accent-color: var(--primary);
    }
    .multi-option-content {
      display: grid;
      gap: 4px;
      min-width: 0;
    }
    .multi-option-name { font-weight: 600; }
    .multi-option-address {
      font-size: 12px;
      color: var(--muted);
    }
    .multi-option-map {
      display: none;
      width: 100%;
      height: 68px;
      border-radius: 14px;
      background: linear-gradient(135deg, rgba(200,76,51,0.18), rgba(31,111,92,0.14));
      position: relative;
      overflow: hidden;
    }
    .multi-option-map::after {
      content: "";
      position: absolute;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--primary);
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      box-shadow: 0 0 0 6px rgba(200,76,51,0.18);
    }
    .multi-options.layout-maps .multi-option-map { display: block; }
    .multi-options.layout-chips .multi-option-address,
    .multi-options.layout-compact .multi-option-address { display: none; }
    .hint { color: var(--muted); font-size: 13px; }
    .submit-btn {
      background: var(--primary);
      color: white;
      border: none;
      padding: 14px 18px;
      border-radius: 999px;
      font-weight: 700;
      letter-spacing: 0.02em;
      cursor: pointer;
      font-size: 15px;
      transition: transform 0.2s ease, box-shadow 0.2s ease;
    }
    .submit-btn:hover { transform: translateY(-2px); box-shadow: 0 12px 20px rgba(200,76,51,0.3); }
    .submit-btn:disabled { opacity: 0.6; cursor: not-allowed; box-shadow: none; transform: none; }
    .consent {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 12px 14px;
      border-radius: 14px;
      background: rgba(31,111,92,0.06);
      border: 1px solid rgba(31,111,92,0.16);
      font-size: 13px;
      color: var(--text);
      line-height: 1.45;
    }
    .consent input {
      width: 18px;
      height: 18px;
      margin-top: 2px;
      accent-color: var(--primary);
    }
    .gallery { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); }
    .gallery img { width: 100%; height: 120px; object-fit: cover; border-radius: 16px; }
    .status { font-weight: 600; margin-top: 10px; }
    .status.error { color: #b42318; }
    .status.ok { color: #1f6f5c; }
    .status-note {
      margin-top: 8px;
      font-size: 13px;
      color: var(--muted);
      line-height: 1.5;
    }
    .status-note a {
      color: var(--primary);
      font-weight: 600;
      text-decoration: none;
    }
    .req { color: var(--primary); font-weight: 700; }
    .chip-list {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      padding: 12px;
      border-radius: 16px;
      background: rgba(31,111,92,0.08);
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border-radius: 999px;
      border: 1px solid rgba(31,111,92,0.22);
      background: #fff;
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
      box-shadow: 0 10px 18px rgba(31,111,92,0.08);
    }
    @media (max-width: 900px) {
      .hero { grid-template-columns: 1fr; }
      .grid { grid-template-columns: 1fr; }
    }
    @media (prefers-reduced-motion: reduce) {
      * { animation: none !important; transition: none !important; }
    }
  </style>
</head>
<body>
  <div class="page">
    <section class="hero">
      <div class="hero-card">
        <div class="badge" data-badge>Now hiring</div>
        <div class="brand-row">
          <img class="brand-logo" data-logo alt="Logo" />
          <div data-brand></div>
        </div>
        <h1 data-title></h1>
        <p data-description></p>
        <div class="lang-toggle" role="tablist">
          <button type="button" data-lang="es" class="active">ES</button>
          <button type="button" data-lang="en">EN</button>
        </div>
      </div>
      <div class="hero-media" data-hero></div>
    </section>

    <section class="grid">
      <div class="card">
        <h2 data-form-title>Apply now</h2>
        <p class="hint" data-form-subtitle>Tell us a bit about you. We answer fast.</p>
        <form id="apply-form" class="form-grid">
          <div class="row" id="base-fields"></div>
          <div id="custom-fields" class="form-grid"></div>
          <div id="file-fields" class="form-grid"></div>
          <button class="submit-btn" id="submit-btn" type="submit">Send application</button>
          <div class="status" id="status"></div>
          <div class="status-note" id="status-note"></div>
        </form>
      </div>
      <div class="card" id="side-card">
        <h3 data-side-title>Why this team?</h3>
        <p class="hint" data-side-text>We are growing, we move fast, and we care about service.</p>
        <div class="chip-list" data-side-note>Shift options and training available.</div>
        <div class="gallery" id="gallery"></div>
      </div>
    </section>
  </div>

  <script type="application/json" id="page-data">${pageJson}</script>
  <script>
    const page = JSON.parse(document.getElementById('page-data')?.textContent || '{}');
    const limits = page.limits || { resumeMaxBytes: 8 * 1024 * 1024, photoMaxBytes: 2 * 1024 * 1024 };
    let lang = page.localeDefault || 'es';
    let roleSelectEl = null;
    const contactPhoneRaw = page.contactPhone || (page.contact && page.contact.phone) || '';
    const contactName = page.contactName || (page.contact && page.contact.name) || page.brand || 'HR Team';

    const els = {
      brand: document.querySelector('[data-brand]'),
      title: document.querySelector('[data-title]'),
      description: document.querySelector('[data-description]'),
      logo: document.querySelector('[data-logo]'),
      hero: document.querySelector('[data-hero]'),
      badge: document.querySelector('[data-badge]'),
      formTitle: document.querySelector('[data-form-title]'),
      formSubtitle: document.querySelector('[data-form-subtitle]'),
      sideTitle: document.querySelector('[data-side-title]'),
      sideText: document.querySelector('[data-side-text]'),
      sideNote: document.querySelector('[data-side-note]'),
      gallery: document.getElementById('gallery'),
      baseFields: document.getElementById('base-fields'),
      customFields: document.getElementById('custom-fields'),
      fileFields: document.getElementById('file-fields'),
      status: document.getElementById('status'),
      statusNote: document.getElementById('status-note'),
      submit: document.getElementById('submit-btn')
    };

    function t(val, fallback = '') {
      if (!val) return fallback;
      if (typeof val === 'string') return val;
      return val[lang] || val.es || val.en || fallback;
    }

    function colorToRgb(value) {
      const raw = String(value || '').trim();
      if (!raw) return '';
      const rgbMatch = raw.match(/rgba?\\(([^)]+)\\)/i);
      if (rgbMatch) {
        const parts = rgbMatch[1].split(',').map((v) => v.trim());
        if (parts.length >= 3) {
          const r = Number(parts[0]);
          const g = Number(parts[1]);
          const b = Number(parts[2]);
          if ([r, g, b].every((n) => Number.isFinite(n))) {
            return r + ', ' + g + ', ' + b;
          }
        }
      }
      let hex = raw.replace('#', '');
      if (hex.length === 3) {
        hex = hex.split('').map((c) => c + c).join('');
      }
      if (hex.length !== 6) return '';
      const num = parseInt(hex, 16);
      if (Number.isNaN(num)) return '';
      const r = (num >> 16) & 255;
      const g = (num >> 8) & 255;
      const b = num & 255;
      return r + ', ' + g + ', ' + b;
    }

    function splitChips(value) {
      if (!value) return [];
      const normalized = String(value || '')
        .replace(/\\r/g, '\\n')
        .replace(/[•·]/g, '\\n');
      return normalized
        .split(/\\n+/)
        .map((part) => part.replace(/^[-–—\\s]+/, '').trim())
        .filter(Boolean);
    }

    function renderSideNote(value) {
      if (!els.sideNote) return;
      const items = splitChips(value);
      if (!items.length) {
        els.sideNote.textContent = '';
        els.sideNote.style.display = 'none';
        return;
      }
      els.sideNote.innerHTML = '';
      items.forEach((item) => {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = item;
        els.sideNote.appendChild(chip);
      });
      els.sideNote.style.display = '';
    }

    function normalizePhoneForLink(value) {
      const raw = String(value || '').trim();
      if (!raw) return '';
      const cleaned = raw.replace(/[^\d+]/g, '');
      if (!cleaned) return '';
      if (cleaned.startsWith('+')) return cleaned;
      return '+' + cleaned.replace(/\D/g, '');
    }

    function renderStatusNote() {
      if (!els.statusNote) return;
      els.statusNote.textContent = '';
      els.statusNote.innerHTML = '';
      const phone = normalizePhoneForLink(contactPhoneRaw);
      if (!phone) return;
      const noteText = t(
        {
          es: 'Para evitar perder la llamada, guardá el número del que te vamos a contactar:',
          en: 'To avoid missing our call, please save the number we will call you from:'
        },
        'Please save our calling number:'
      );
      const wrapper = document.createElement('div');
      wrapper.textContent = noteText + ' ';
      const phoneLink = document.createElement('a');
      phoneLink.href = 'tel:' + phone;
      phoneLink.textContent = contactPhoneRaw || phone;
      phoneLink.rel = 'noopener';
      wrapper.appendChild(phoneLink);
      wrapper.appendChild(document.createTextNode(' · '));
      const safeName = String(contactName || 'HR Team').replace(/[\\n\\r]/g, ' ').trim() || 'HR Team';
      const vcard = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        'FN:' + safeName,
        'TEL;TYPE=CELL:' + phone,
        'END:VCARD'
      ].join('\\n');
      const vcardLink = document.createElement('a');
      vcardLink.href = 'data:text/vcard;charset=utf-8,' + encodeURIComponent(vcard);
      vcardLink.download = 'contact.vcf';
      vcardLink.textContent = t({ es: 'Guardar contacto', en: 'Save contact' }, 'Save contact');
      vcardLink.rel = 'noopener';
      wrapper.appendChild(vcardLink);
      els.statusNote.appendChild(wrapper);
    }

    function applyTheme() {
      const theme = page.theme || {};
      if (theme.colorBg) document.documentElement.style.setProperty('--bg', theme.colorBg);
      if (theme.colorCard) document.documentElement.style.setProperty('--card', theme.colorCard);
      if (theme.colorText) document.documentElement.style.setProperty('--text', theme.colorText);
      if (theme.colorMuted) document.documentElement.style.setProperty('--muted', theme.colorMuted);
      if (theme.colorPrimary) document.documentElement.style.setProperty('--primary', theme.colorPrimary);
      if (theme.colorAccent) document.documentElement.style.setProperty('--accent', theme.colorAccent);
      const primaryRgb = colorToRgb(theme.colorPrimary);
      if (primaryRgb) {
        document.documentElement.style.setProperty('--primary-rgb', primaryRgb);
        document.documentElement.style.setProperty('--ring', 'rgba(' + primaryRgb + ', 0.25)');
      }
      const accentRgb = colorToRgb(theme.colorAccent);
      if (accentRgb) document.documentElement.style.setProperty('--accent-rgb', accentRgb);
      if (theme.fontHeading) document.documentElement.style.setProperty('--font-heading', theme.fontHeading + ', Fraunces, serif');
      if (theme.fontBody) document.documentElement.style.setProperty('--font-body', theme.fontBody + ', Manrope, sans-serif');
    }

    function renderHeader() {
      els.brand.textContent = page.brand || '';
      els.title.textContent = t(page.content?.title, 'Work with us');
      els.description.textContent = t(page.content?.description, 'Join our restaurant team.');
      els.badge.textContent = t(page.content?.badge, 'Now hiring');
      els.formTitle.textContent = t(page.content?.formTitle, 'Apply now');
      els.formSubtitle.textContent = t(page.content?.formSubtitle, 'Tell us a bit about you.');
      els.sideTitle.textContent = t(page.content?.sideTitle, 'Inside the team');
      els.sideText.textContent = t(page.content?.sideText, 'Fast pace, real growth, strong culture.');
      const sideNote = t(page.content?.sideNote, 'Flexible shifts and training.');
      renderSideNote(sideNote);

      if (page.assets?.logoUrl) {
        els.logo.src = page.assets.logoUrl;
        els.logo.style.display = 'block';
      } else {
        els.logo.style.display = 'none';
      }

      if (page.assets?.heroUrl) {
        const img = new Image();
        img.src = page.assets.heroUrl;
        img.alt = 'Photo';
        els.hero.innerHTML = '';
        els.hero.appendChild(img);
      }

      els.gallery.innerHTML = '';
      const gallery = Array.isArray(page.assets?.gallery) ? page.assets.gallery : [];
      gallery.forEach((url) => {
        if (!url) return;
        const img = new Image();
        img.src = url;
        img.alt = 'Gallery';
        els.gallery.appendChild(img);
      });
    }

    function optionValue(opt) {
      if (!opt) return '';
      if (typeof opt === 'string') return opt;
      return opt.key || opt.value || t(opt, '');
    }

    function optionLabel(opt) {
      if (!opt) return '';
      if (typeof opt === 'string') return opt;
      if (opt.label) return t(opt.label, opt.key || opt.value || '');
      return t(opt, opt.key || opt.value || '');
    }

    function optionAddress(opt) {
      if (!opt || !opt.address) return '';
      if (typeof opt.address === 'string') return opt.address;
      return t(opt.address, '');
    }

    function buildInputField(id, label, type, required, options) {
      const wrapper = document.createElement('div');
      const labelEl = document.createElement('label');
      labelEl.textContent = label + (required ? ' *' : '');
      labelEl.htmlFor = id;
      wrapper.appendChild(labelEl);

      let input;
      if (type === 'textarea') {
        input = document.createElement('textarea');
      } else if (type === 'select') {
        input = document.createElement('select');
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = t({ es: 'Seleccionar', en: 'Select' }, 'Select');
        input.appendChild(placeholder);
        (options || []).forEach((opt) => {
          const optionEl = document.createElement('option');
          optionEl.value = optionValue(opt) || '';
          optionEl.textContent = optionLabel(opt) || optionEl.value;
          input.appendChild(optionEl);
        });
      } else if (type === 'yesno') {
        input = document.createElement('div');
        input.className = 'row';
        const yes = document.createElement('label');
        const yesInput = document.createElement('input');
        yesInput.type = 'radio';
        yesInput.name = id;
        yesInput.value = 'yes';
        yes.appendChild(yesInput);
        yes.appendChild(document.createTextNode(' ' + t({ es: 'Si', en: 'Yes' }, 'Yes')));
        const no = document.createElement('label');
        const noInput = document.createElement('input');
        noInput.type = 'radio';
        noInput.name = id;
        noInput.value = 'no';
        no.appendChild(noInput);
        no.appendChild(document.createTextNode(' ' + t({ es: 'No', en: 'No' }, 'No')));
        input.appendChild(yes);
        input.appendChild(no);
      } else {
        input = document.createElement('input');
        input.type = type || 'text';
      }

      if (type !== 'yesno') {
        input.id = id;
        input.name = id;
        if (required) input.required = true;
      } else if (required) {
        input.dataset.required = '1';
      }

      wrapper.appendChild(input);
      return wrapper;
    }

    function buildMultiOptionsField(id, label, required, options, layout) {
      const wrapper = document.createElement('div');
      wrapper.className = 'field-span';
      const labelEl = document.createElement('label');
      labelEl.textContent = label + (required ? ' *' : '');
      wrapper.appendChild(labelEl);

      const list = document.createElement('div');
      list.className = 'multi-options layout-' + (layout || 'cards');
      (options || []).forEach((opt, idx) => {
        const value = optionValue(opt);
        if (!value) return;
        const text = optionLabel(opt) || value;
        const address = optionAddress(opt);
        const optLabel = document.createElement('label');
        optLabel.className = 'multi-option';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.name = id;
        input.value = value;
        input.id = id + '_' + idx;
        const mapEl = document.createElement('div');
        mapEl.className = 'multi-option-map';
        const content = document.createElement('div');
        content.className = 'multi-option-content';
        const textSpan = document.createElement('span');
        textSpan.className = 'multi-option-name';
        textSpan.textContent = text;
        const addressSpan = document.createElement('span');
        addressSpan.className = 'multi-option-address';
        addressSpan.textContent = address || '';
        if (!address) addressSpan.style.display = 'none';
        optLabel.appendChild(input);
        optLabel.appendChild(mapEl);
        content.appendChild(textSpan);
        content.appendChild(addressSpan);
        optLabel.appendChild(content);
        const syncChecked = () => {
          optLabel.classList.toggle('is-checked', input.checked);
        };
        input.addEventListener('change', syncChecked);
        syncChecked();
        list.appendChild(optLabel);
      });
      wrapper.appendChild(list);
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = t({ es: 'Podés elegir más de una.', en: 'You can choose more than one.' }, 'You can choose more than one.');
      wrapper.appendChild(hint);
      if (required) wrapper.dataset.required = '1';
      return wrapper;
    }

    function readSelectedLocations() {
      return Array.from(document.querySelectorAll('input[name="locations"]:checked'))
        .map((input) => input.value)
        .filter(Boolean);
    }

    function buildRoleOptionsForLocations(selected, roleByLocation) {
      if (!roleByLocation || typeof roleByLocation !== 'object') return [];
      const seen = new Set();
      const out = [];
      selected.forEach((key) => {
        const options = roleByLocation[key];
        if (!Array.isArray(options)) return;
        options.forEach((opt) => {
          const value = optionValue(opt);
          if (!value || seen.has(value)) return;
          seen.add(value);
          out.push(opt);
        });
      });
      return out;
    }

    function syncRoleOptions(roleSelectEl, fields) {
      if (!roleSelectEl || !fields) return;
      const roleByLocation = fields.roleByLocation || {};
      const baseOptions = Array.isArray(fields.role?.options) ? fields.role.options : [];
      const selectedLocations = readSelectedLocations();
      const useByLocation = roleByLocation && Object.keys(roleByLocation).length > 0;
      const options = useByLocation
        ? buildRoleOptionsForLocations(selectedLocations, roleByLocation)
        : baseOptions;
      const prev = roleSelectEl.value || '';
      roleSelectEl.innerHTML = '';
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = t({ es: 'Seleccionar', en: 'Select' }, 'Select');
      roleSelectEl.appendChild(placeholder);
      options.forEach((opt) => {
        const value = optionValue(opt);
        if (!value) return;
        const optionEl = document.createElement('option');
        optionEl.value = value;
        optionEl.textContent = optionLabel(opt) || value;
        roleSelectEl.appendChild(optionEl);
      });
      if (prev && options.some((opt) => optionValue(opt) === prev)) {
        roleSelectEl.value = prev;
      } else {
        roleSelectEl.value = '';
      }
    }

    function renderFields() {
      els.baseFields.innerHTML = '';
      els.customFields.innerHTML = '';
      els.fileFields.innerHTML = '';
      roleSelectEl = null;

      const fields = page.fields || {};
      const nameField = fields.name || { required: true };
      const emailField = fields.email || { required: true };
      const phoneField = fields.phone || { required: true };
      const roleField = fields.role || {};
      const roleByLocation = fields.roleByLocation || {};
      const locationLayout = fields.locations?.layout || 'cards';

      els.baseFields.appendChild(buildInputField('name', t(nameField.label, 'Full name'), 'text', nameField.required !== false));
      els.baseFields.appendChild(buildInputField('email', t(emailField.label, 'Email'), 'email', emailField.required !== false));
      els.baseFields.appendChild(buildInputField('phone', t(phoneField.label, 'Phone'), 'tel', phoneField.required !== false));

      if (fields.locations && Array.isArray(fields.locations.options) && fields.locations.options.length) {
        els.baseFields.appendChild(
          buildMultiOptionsField(
            'locations',
            t(fields.locations.label, 'Locations'),
            fields.locations.required === true,
            fields.locations.options,
            locationLayout
          )
        );
      }

      const hasRoleByLocation = roleByLocation && Object.keys(roleByLocation).length > 0;
      const baseRoleOptions = Array.isArray(roleField.options) ? roleField.options : [];
      if (hasRoleByLocation || baseRoleOptions.length || roleField.required) {
        const roleWrap = buildInputField('role', t(roleField.label, 'Role'), 'select', roleField.required === true, baseRoleOptions);
        roleSelectEl = roleWrap.querySelector('select');
        els.baseFields.appendChild(roleWrap);
      }

      const questions = Array.isArray(page.questions) ? page.questions : [];
      questions.forEach((q) => {
        const type = q.type === 'long' ? 'textarea' : q.type;
        els.customFields.appendChild(buildInputField(q.id, t(q.label, 'Question'), type, !!q.required, q.options));
      });

      const resumeCfg = page.resume || {};
      const photoCfg = page.photo || {};
      const resumeWrap = document.createElement('div');
      const resumeLabel = document.createElement('label');
      resumeLabel.textContent = t(resumeCfg.label, 'Resume (PDF)') + (resumeCfg.required ? ' *' : '');
      const resumeInput = document.createElement('input');
      resumeInput.type = 'file';
      resumeInput.accept = '.pdf,.doc,.docx,.txt';
      resumeInput.id = 'resume';
      resumeInput.name = 'resume';
      if (resumeCfg.required) resumeInput.required = true;
      resumeWrap.appendChild(resumeLabel);
      resumeWrap.appendChild(resumeInput);
      const resumeHint = document.createElement('div');
      resumeHint.className = 'hint';
      resumeHint.textContent = t({ es: 'Max 8MB', en: 'Max 8MB' }, 'Max 8MB');
      resumeWrap.appendChild(resumeHint);
      els.fileFields.appendChild(resumeWrap);

      const photoWrap = document.createElement('div');
      const photoLabel = document.createElement('label');
      photoLabel.textContent = t(photoCfg.label, 'Photo (optional)') + (photoCfg.required ? ' *' : '');
      const photoInput = document.createElement('input');
      photoInput.type = 'file';
      photoInput.accept = 'image/*';
      photoInput.id = 'photo';
      photoInput.name = 'photo';
      if (photoCfg.required) photoInput.required = true;
      photoWrap.appendChild(photoLabel);
      photoWrap.appendChild(photoInput);
      const photoHint = document.createElement('div');
      photoHint.className = 'hint';
      photoHint.textContent = t({ es: 'Max 2MB', en: 'Max 2MB' }, 'Max 2MB');
      photoWrap.appendChild(photoHint);
      els.fileFields.appendChild(photoWrap);

      const consentWrap = document.createElement('label');
      consentWrap.className = 'consent';
      const consentInput = document.createElement('input');
      consentInput.type = 'checkbox';
      consentInput.id = 'consent';
      consentInput.name = 'consent';
      consentInput.required = true;
      const consentText = document.createElement('span');
      consentText.textContent = t(
        {
          es: 'Al enviar este formulario, aceptás ser contactado por SMS o llamada telefónica sobre tu postulación.',
          en: 'By submitting this form, you agree to be contacted via SMS or voice call about your application.'
        },
        'By submitting this form, you agree to be contacted about your application.'
      );
      consentWrap.appendChild(consentInput);
      consentWrap.appendChild(consentText);
      els.fileFields.appendChild(consentWrap);

      if (hasRoleByLocation) {
        document.querySelectorAll('input[name="locations"]').forEach((input) => {
          input.addEventListener('change', () => syncRoleOptions(roleSelectEl, fields));
        });
        syncRoleOptions(roleSelectEl, fields);
      }
    }

    function setStatus(text, isError) {
      els.status.textContent = text || '';
      els.status.className = 'status' + (isError ? ' error' : ' ok');
      if (els.statusNote) {
        els.statusNote.textContent = '';
        els.statusNote.innerHTML = '';
      }
    }

    function readFileAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('file_read_failed'));
        reader.readAsDataURL(file);
      });
    }

    async function handleSubmit(event) {
      event.preventDefault();
      setStatus('');
      els.submit.disabled = true;

      try {
        const name = document.getElementById('name')?.value?.trim() || '';
        const email = document.getElementById('email')?.value?.trim() || '';
        const phone = document.getElementById('phone')?.value?.trim() || '';
        const role = document.getElementById('role')?.value?.trim() || '';
        const locationInputs = Array.from(document.querySelectorAll('input[name="locations"]:checked'));
        const locations = locationInputs.map((input) => input.value).filter(Boolean);
        const consent = !!document.getElementById('consent')?.checked;

        if (!name) throw new Error(t({ es: 'Nombre requerido', en: 'Name is required' }, 'Name is required'));
        const emailRe = /.+@.+\..+/;
        if (page.fields?.email?.required !== false && !emailRe.test(email)) {
          throw new Error(t({ es: 'Email invalido', en: 'Invalid email' }, 'Invalid email'));
        }
        if (page.fields?.phone?.required !== false && phone.length < 7) {
          throw new Error(t({ es: 'Telefono invalido', en: 'Invalid phone' }, 'Invalid phone'));
        }
        if (page.fields?.locations?.required && locations.length === 0) {
          throw new Error(t({ es: 'Selecciona una locacion', en: 'Select a location' }, 'Select a location'));
        }
        if (!consent) {
          throw new Error(t({ es: 'Tenés que aceptar los términos de contacto', en: 'You must accept the contact terms' }, 'You must accept the contact terms'));
        }

        const answers = {};
        (page.questions || []).forEach((q) => {
          if (q.type === 'yesno') {
            const selector = 'input[name="' + q.id + '"]:checked';
            const val = document.querySelector(selector)?.value || '';
            if (q.required && !val) throw new Error(t({ es: 'Falta responder una pregunta', en: 'Missing answer' }, 'Missing answer'));
            answers[q.id] = val;
          } else {
            const val = document.getElementById(q.id)?.value?.trim() || '';
            if (q.required && !val) throw new Error(t({ es: 'Falta responder una pregunta', en: 'Missing answer' }, 'Missing answer'));
            answers[q.id] = val;
          }
        });

        const resumeFile = document.getElementById('resume')?.files?.[0] || null;
        const photoFile = document.getElementById('photo')?.files?.[0] || null;
        if (page.resume?.required && !resumeFile) {
          throw new Error(t({ es: 'Resume requerido', en: 'Resume required' }, 'Resume required'));
        }
        if (resumeFile && resumeFile.size > limits.resumeMaxBytes) {
          throw new Error(t({ es: 'Resume muy grande', en: 'Resume too large' }, 'Resume too large'));
        }
        if (photoFile && photoFile.size > limits.photoMaxBytes) {
          throw new Error(t({ es: 'Foto muy grande', en: 'Photo too large' }, 'Photo too large'));
        }

        const payload = {
          slug: page.slug,
          name,
          email,
          phone,
          role,
          locations,
          lang,
          consent,
          answers,
          resume_data_url: resumeFile ? await readFileAsDataUrl(resumeFile) : '',
          resume_file_name: resumeFile ? resumeFile.name : '',
          photo_data_url: photoFile ? await readFileAsDataUrl(photoFile) : '',
          photo_file_name: photoFile ? photoFile.name : ''
        };

        const resp = await fetch('/apply/' + page.slug + '/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'submit_failed');

        setStatus(t(page.content?.thankYou, 'Thanks! We will contact you soon.'), false);
        renderStatusNote();
        document.getElementById('apply-form').reset();
      } catch (err) {
        setStatus(err.message || 'submit_failed', true);
      } finally {
        els.submit.disabled = false;
      }
    }

    function initLangToggle() {
      document.querySelectorAll('.lang-toggle button').forEach((btn) => {
        btn.addEventListener('click', () => {
          lang = btn.dataset.lang || 'es';
          document.querySelectorAll('.lang-toggle button').forEach((b) => b.classList.toggle('active', b === btn));
          renderHeader();
          renderFields();
        });
      });
    }

    applyTheme();
    renderHeader();
    renderFields();
    initLangToggle();
    document.getElementById('apply-form').addEventListener('submit', handleSubmit);
  </script>
</body>
</html>`;
}

function renderAdminPage(options = {}) {
  const title = escapeHtml(options.title || "Portal Admin");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&family=Work+Sans:wght@400;600&display=swap" />
  <style>
    :root {
      --bg: #f4f5f7;
      --card: #ffffff;
      --text: #181a1f;
      --muted: #5b626d;
      --primary: #c84c33;
      --accent: #264653;
      --shadow: 0 12px 28px rgba(24, 26, 31, 0.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: 'Work Sans', sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    header {
      padding: 20px 28px;
      background: var(--card);
      box-shadow: var(--shadow);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    header h1 { margin: 0; font-family: 'Space Grotesk', sans-serif; font-size: 22px; }
    .token-row { display: flex; gap: 8px; align-items: center; }
    .token-row input { padding: 8px 10px; border-radius: 8px; border: 1px solid #d0d4da; width: 260px; }
    .wrap { display: grid; grid-template-columns: 280px 1fr; gap: 18px; padding: 22px; }
    .panel { background: var(--card); border-radius: 16px; padding: 16px; box-shadow: var(--shadow); }
    .list { display: grid; gap: 10px; }
    .list button { width: 100%; text-align: left; border: 1px solid #e0e5ec; border-radius: 10px; padding: 10px 12px; background: #fafbfc; cursor: pointer; }
    .list button.active { border-color: var(--primary); background: #fff3ef; }
    .btn { border: none; border-radius: 10px; padding: 10px 14px; cursor: pointer; font-weight: 600; }
    .btn.primary { background: var(--primary); color: white; }
    .btn.ghost { background: transparent; border: 1px dashed #cbd2da; color: var(--muted); }
    .grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); }
    label { font-weight: 600; display: block; margin-bottom: 6px; }
    input, textarea, select {
      width: 100%;
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid #d7dde4;
      font-family: inherit;
      font-size: 14px;
    }
    textarea { min-height: 90px; resize: vertical; }
    .section-title { margin: 18px 0 8px; font-family: 'Space Grotesk', sans-serif; font-size: 16px; }
    .question { border: 1px solid #e3e7ee; border-radius: 12px; padding: 12px; display: grid; gap: 10px; }
    .row { display: flex; gap: 10px; align-items: center; }
    .row input[type="checkbox"] { width: auto; }
    .preview { border-radius: 12px; padding: 12px; background: #f8f6f2; display: grid; gap: 8px; }
    .preview img { max-width: 100%; border-radius: 10px; }
    .table-wrap { overflow: auto; border: 1px solid #e3e7ee; border-radius: 12px; }
    .app-table { width: 100%; border-collapse: collapse; min-width: 860px; font-size: 13px; }
    .app-table th, .app-table td { padding: 8px 10px; border-bottom: 1px solid #e3e7ee; text-align: left; vertical-align: top; }
    .app-table th { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
    .app-table td { white-space: nowrap; }
    .app-table td.answers { white-space: pre-wrap; min-width: 240px; }
    .app-table td.meta { color: var(--muted); font-size: 12px; }
    .status { font-weight: 600; }
  </style>
</head>
<body>
  <header>
    <h1>Portal Admin</h1>
    <div class="token-row">
      <label for="token">Token</label>
      <input id="token" placeholder="Bearer token" />
      <button class="btn primary" id="save-token">Save</button>
    </div>
  </header>
  <div class="wrap">
    <aside class="panel">
      <div class="row" style="justify-content: space-between;">
        <strong>Pages</strong>
        <button class="btn ghost" id="new-page">New</button>
      </div>
      <div class="list" id="page-list"></div>
    </aside>
    <main class="panel">
      <div class="grid">
        <div>
          <label>Slug</label>
          <input id="page-slug" />
        </div>
        <div>
          <label>Brand</label>
          <input id="page-brand" />
        </div>
        <div>
          <label>Default Lang</label>
          <select id="page-lang">
            <option value="es">ES</option>
            <option value="en">EN</option>
          </select>
        </div>
        <div>
          <label>Active</label>
          <select id="page-active">
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        </div>
      </div>

      <div class="section-title">Content</div>
      <div class="grid">
        <div>
          <label>Title (ES)</label>
          <input id="title-es" />
        </div>
        <div>
          <label>Title (EN)</label>
          <input id="title-en" />
        </div>
        <div>
          <label>Description (ES)</label>
          <textarea id="desc-es"></textarea>
        </div>
        <div>
          <label>Description (EN)</label>
          <textarea id="desc-en"></textarea>
        </div>
        <div>
          <label>Thank you (ES)</label>
          <input id="thanks-es" />
        </div>
        <div>
          <label>Thank you (EN)</label>
          <input id="thanks-en" />
        </div>
      </div>

      <div class="section-title">Theme</div>
      <div class="grid">
        <div>
          <label>Font Heading</label>
          <input id="font-heading" />
        </div>
        <div>
          <label>Font Body</label>
          <input id="font-body" />
        </div>
        <div>
          <label>Font URL</label>
          <input id="font-url" />
        </div>
        <div>
          <label>Primary Color</label>
          <input id="color-primary" />
        </div>
        <div>
          <label>Accent Color</label>
          <input id="color-accent" />
        </div>
        <div>
          <label>Background</label>
          <input id="color-bg" />
        </div>
        <div>
          <label>Card</label>
          <input id="color-card" />
        </div>
        <div>
          <label>Text</label>
          <input id="color-text" />
        </div>
        <div>
          <label>Muted</label>
          <input id="color-muted" />
        </div>
      </div>

      <div class="section-title">Assets</div>
      <div class="grid">
        <div>
          <label>Logo URL</label>
          <input id="logo-url" />
          <input type="file" id="logo-file" accept="image/*" />
        </div>
        <div>
          <label>Hero URL</label>
          <input id="hero-url" />
          <input type="file" id="hero-file" accept="image/*" />
        </div>
        <div>
          <label>Gallery URLs (one per line)</label>
          <textarea id="gallery-urls"></textarea>
          <input type="file" id="gallery-files" accept="image/*" multiple />
        </div>
      </div>

      <div class="section-title">Base Fields</div>
      <div class="grid">
        <div>
          <label>Name Label ES</label>
          <input id="name-es" />
        </div>
        <div>
          <label>Name Label EN</label>
          <input id="name-en" />
        </div>
        <div class="row">
          <input type="checkbox" id="name-required" />
          <label for="name-required">Required</label>
        </div>
      </div>
      <div class="grid">
        <div>
          <label>Email Label ES</label>
          <input id="email-es" />
        </div>
        <div>
          <label>Email Label EN</label>
          <input id="email-en" />
        </div>
        <div class="row">
          <input type="checkbox" id="email-required" />
          <label for="email-required">Required</label>
        </div>
      </div>
      <div class="grid">
        <div>
          <label>Phone Label ES</label>
          <input id="phone-es" />
        </div>
        <div>
          <label>Phone Label EN</label>
          <input id="phone-en" />
        </div>
        <div class="row">
          <input type="checkbox" id="phone-required" />
          <label for="phone-required">Required</label>
        </div>
      </div>

      <div class="section-title">Role Field</div>
      <div class="grid">
        <div>
          <label>Role Label ES</label>
          <input id="role-es" />
        </div>
        <div>
          <label>Role Label EN</label>
          <input id="role-en" />
        </div>
        <div class="row">
          <input type="checkbox" id="role-required" />
          <label for="role-required">Required</label>
        </div>
      </div>
      <div class="grid">
        <div>
          <label>Role Options (one per line)</label>
          <textarea id="role-options"></textarea>
        </div>
      </div>

      <div class="section-title">Resume and Photo</div>
      <div class="grid">
        <div>
          <label>Resume Label ES</label>
          <input id="resume-es" />
        </div>
        <div>
          <label>Resume Label EN</label>
          <input id="resume-en" />
        </div>
        <div class="row">
          <input type="checkbox" id="resume-required" />
          <label for="resume-required">Resume Required</label>
        </div>
      </div>
      <div class="grid">
        <div>
          <label>Photo Label ES</label>
          <input id="photo-es" />
        </div>
        <div>
          <label>Photo Label EN</label>
          <input id="photo-en" />
        </div>
        <div class="row">
          <input type="checkbox" id="photo-required" />
          <label for="photo-required">Photo Required</label>
        </div>
      </div>

      <div class="section-title">Questions</div>
      <div id="question-list" class="grid"></div>
      <button class="btn ghost" id="add-question">Add question</button>

      <div class="section-title">Actions</div>
      <div class="row">
        <button class="btn primary" id="save-page">Save page</button>
        <button class="btn" id="delete-page">Delete</button>
        <span class="status" id="status"></span>
      </div>

      <div class="section-title">Preview</div>
      <div class="preview" id="preview"></div>

      <div class="section-title">Applications</div>
      <div class="row">
        <label for="app-filter">Filter</label>
        <select id="app-filter"></select>
        <button class="btn" id="app-refresh">Refresh</button>
        <button class="btn" id="app-export">Export CSV</button>
        <span class="status" id="app-count"></span>
      </div>
      <div class="table-wrap">
        <table class="app-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Page</th>
              <th>Name</th>
              <th>Email</th>
              <th>Phone</th>
              <th>Role</th>
              <th>Resume</th>
              <th>Photo</th>
              <th>Answers</th>
            </tr>
          </thead>
          <tbody id="app-table-body"></tbody>
        </table>
      </div>
    </main>
  </div>

  <script>
    const tokenInput = document.getElementById('token');
    const saveTokenBtn = document.getElementById('save-token');
    const pageListEl = document.getElementById('page-list');
    const statusEl = document.getElementById('status');
    const previewEl = document.getElementById('preview');
    const appFilterEl = document.getElementById('app-filter');
    const appRefreshEl = document.getElementById('app-refresh');
    const appExportEl = document.getElementById('app-export');
    const appCountEl = document.getElementById('app-count');
    const appTableBodyEl = document.getElementById('app-table-body');

    let pages = [];
    let current = null;
    let pendingUploads = { logo: null, hero: null, gallery: [] };
    let lastApplications = [];
    let pendingSlug = '';
    try {
      pendingSlug = new URLSearchParams(window.location.search).get('slug') || '';
    } catch (err) {}

    function authHeaders() {
      const token = tokenInput.value.trim();
      return token ? { Authorization: token.startsWith('Bearer') ? token : 'Bearer ' + token } : {};
    }

    function setStatus(text, isError) {
      statusEl.textContent = text || '';
      statusEl.style.color = isError ? '#b42318' : '#1f6f5c';
    }

    function fileToDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('file_read_failed'));
        reader.readAsDataURL(file);
      });
    }

    function defaultPage() {
      return {
        slug: '',
        brand: '',
        active: true,
        localeDefault: 'es',
        content: {
          title: { es: 'Trabaja con nosotros', en: 'Work with us' },
          description: { es: 'Sumate al equipo.', en: 'Join the team.' },
          thankYou: { es: 'Gracias! Te contactamos pronto.', en: 'Thanks! We will contact you soon.' },
          sideTitle: { es: 'Dentro del equipo', en: 'Inside the team' },
          sideText: { es: 'Ritmo rapido, crecimiento real, buena cultura.', en: 'Fast pace, real growth, strong culture.' },
          sideNote: { es: 'Turnos flexibles y entrenamiento.', en: 'Flexible shifts and training.' }
        },
        theme: {
          fontHeading: 'Fraunces',
          fontBody: 'Manrope',
          fontUrl: 'https://fonts.googleapis.com/css2?family=Fraunces:wght@400;600;700&family=Manrope:wght@400;600;700&display=swap',
          colorPrimary: '#c84c33',
          colorAccent: '#1f6f5c',
          colorBg: '#f6f2e9',
          colorCard: '#ffffff',
          colorText: '#241b13',
          colorMuted: '#6c5f57'
        },
        assets: { logoUrl: '', heroUrl: '', faviconUrl: '', gallery: [] },
        fields: {
          name: { label: { es: 'Nombre completo', en: 'Full name' }, required: true },
          email: { label: { es: 'Email', en: 'Email' }, required: true },
          phone: { label: { es: 'Telefono', en: 'Phone' }, required: true },
          role: { label: { es: 'Puesto', en: 'Role' }, required: false, options: [] }
        },
        resume: { label: { es: 'CV (PDF)', en: 'Resume (PDF)' }, required: true },
        photo: { label: { es: 'Foto (opcional)', en: 'Photo (optional)' }, required: false },
        questions: []
      };
    }

    async function loadPages() {
      setStatus('Loading...');
      const resp = await fetch('/admin/portal/pages', { headers: authHeaders() });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'load_failed');
      pages = data.pages || [];
      renderList();
      renderAppFilter();
      if (pendingSlug && pages.some((p) => p.slug === pendingSlug)) {
        selectPage(pendingSlug);
        pendingSlug = '';
      } else if (!current && pages.length) {
        selectPage(pages[0].slug);
      }
      await loadApplications();
      setStatus('');
    }

    function renderList() {
      pageListEl.innerHTML = '';
      pages.forEach((p) => {
        const btn = document.createElement('button');
        btn.textContent = p.brand || p.slug || 'untitled';
        btn.className = current && current.slug === p.slug ? 'active' : '';
        btn.onclick = () => selectPage(p.slug);
        pageListEl.appendChild(btn);
      });
    }

    function findPageBySlug(slug) {
      return pages.find((p) => p.slug === slug) || null;
    }

    function renderAppFilter() {
      if (!appFilterEl) return;
      const prev = appFilterEl.value;
      appFilterEl.innerHTML = '';
      const allOpt = document.createElement('option');
      allOpt.value = '';
      allOpt.textContent = 'All pages';
      appFilterEl.appendChild(allOpt);
      pages.forEach((p) => {
        const opt = document.createElement('option');
        opt.value = p.slug;
        opt.textContent = p.brand || p.slug || 'untitled';
        appFilterEl.appendChild(opt);
      });
      if (prev && pages.some((p) => p.slug === prev)) {
        appFilterEl.value = prev;
      }
    }

    function formatDate(value) {
      if (!value) return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      return date.toLocaleString();
    }

    function buildAnswerText(app) {
      const page = findPageBySlug(app.slug);
      if (!page || !Array.isArray(page.questions) || !app.answers) return '';
      return page.questions
        .map((q) => {
          const key = q && q.id ? q.id : '';
          if (!key) return '';
          const val = app.answers[key];
          if (!val) return '';
          const label = (q.label && (q.label.es || q.label.en)) || key;
          return label + ': ' + val;
        })
        .filter(Boolean)
        .join('\n');
    }

    function addTextCell(row, text, className) {
      const td = document.createElement('td');
      if (className) td.className = className;
      td.textContent = text || '—';
      row.appendChild(td);
      return td;
    }

    function addLinkCell(row, url, label) {
      const td = document.createElement('td');
      if (url) {
        const link = document.createElement('a');
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = label;
        td.appendChild(link);
      } else {
        td.textContent = '—';
      }
      row.appendChild(td);
      return td;
    }

    function renderApplications(list) {
      if (!appTableBodyEl) return;
      lastApplications = Array.isArray(list) ? list.slice() : [];
      appTableBodyEl.innerHTML = '';
      if (appCountEl) {
        appCountEl.textContent = list.length + ' applications';
        appCountEl.style.color = 'var(--muted)';
      }
      list.forEach((app) => {
        const row = document.createElement('tr');
        const page = findPageBySlug(app.slug);
        const pageLabel = (page && page.brand) || app.brand || app.slug || '';
        addTextCell(row, formatDate(app.created_at), 'meta');
        addTextCell(row, pageLabel);
        addTextCell(row, app.name || '');
        addTextCell(row, app.email || '');
        addTextCell(row, app.phone || '');
        addTextCell(row, app.role || '');
        addLinkCell(row, app.resume_url || '', 'Resume');
        addLinkCell(row, app.photo_url || '', 'Photo');
        const answers = buildAnswerText(app);
        const answersCell = addTextCell(row, answers || '', 'answers');
        if (!answers) answersCell.textContent = '—';
        appTableBodyEl.appendChild(row);
      });
    }

    function csvEscape(value) {
      if (value === null || value === undefined) return '""';
      const str = String(value);
      const escaped = str.replace(/"/g, '""');
      return '"' + escaped + '"';
    }

    function safeFileName(value) {
      return String(value || 'applications').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'applications';
    }

    function buildCsv(apps) {
      const headers = [
        'Date',
        'Page',
        'Brand',
        'Name',
        'Email',
        'Phone',
        'Role',
        'Resume',
        'Photo',
        'Answers'
      ];
      const rows = [headers.map(csvEscape).join(',')];
      apps.forEach((app) => {
        const page = findPageBySlug(app.slug);
        const pageLabel = app.slug || '';
        const brandLabel = (page && page.brand) || app.brand || '';
        const answers = buildAnswerText(app);
        rows.push([
          formatDate(app.created_at),
          pageLabel,
          brandLabel,
          app.name || '',
          app.email || '',
          app.phone || '',
          app.role || '',
          app.resume_url || '',
          app.photo_url || '',
          answers || ''
        ].map(csvEscape).join(','));
      });
      return rows.join('\r\n');
    }

    function exportCsv() {
      const apps = Array.isArray(lastApplications) ? lastApplications : [];
      const csv = buildCsv(apps);
      const slug = appFilterEl ? appFilterEl.value : '';
      const stamp = new Date().toISOString().slice(0, 10);
      const name = safeFileName(slug || 'all') + '_' + stamp + '.csv';
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = name;
      document.body.appendChild(link);
      link.click();
      setTimeout(() => {
        URL.revokeObjectURL(link.href);
        link.remove();
      }, 0);
    }

    async function loadApplications() {
      if (!appTableBodyEl) return;
      const params = new URLSearchParams();
      const slug = appFilterEl ? appFilterEl.value : '';
      if (slug) params.set('slug', slug);
      const query = params.toString();
      const resp = await fetch('/admin/portal/applications' + (query ? ('?' + query) : ''), { headers: authHeaders() });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'load_failed');
      renderApplications(data.applications || []);
    }

    function selectPage(slug) {
      const page = pages.find((p) => p.slug === slug);
      if (!page) return;
      current = JSON.parse(JSON.stringify(page));
      pendingUploads = { logo: null, hero: null, gallery: [] };
      fillForm();
      renderList();
      renderPreview();
      if (appFilterEl) {
        appFilterEl.value = slug;
        loadApplications().catch(() => {});
      }
    }

    function val(id) { return document.getElementById(id).value; }
    function setVal(id, value) { document.getElementById(id).value = value || ''; }
    function setChecked(id, on) { document.getElementById(id).checked = !!on; }

    function fillForm() {
      setVal('page-slug', current.slug || '');
      setVal('page-brand', current.brand || '');
      setVal('page-lang', current.localeDefault || 'es');
      setVal('page-active', current.active === false ? 'false' : 'true');

      setVal('title-es', current.content?.title?.es || '');
      setVal('title-en', current.content?.title?.en || '');
      setVal('desc-es', current.content?.description?.es || '');
      setVal('desc-en', current.content?.description?.en || '');
      setVal('thanks-es', current.content?.thankYou?.es || '');
      setVal('thanks-en', current.content?.thankYou?.en || '');

      setVal('font-heading', current.theme?.fontHeading || '');
      setVal('font-body', current.theme?.fontBody || '');
      setVal('font-url', current.theme?.fontUrl || '');
      setVal('color-primary', current.theme?.colorPrimary || '');
      setVal('color-accent', current.theme?.colorAccent || '');
      setVal('color-bg', current.theme?.colorBg || '');
      setVal('color-card', current.theme?.colorCard || '');
      setVal('color-text', current.theme?.colorText || '');
      setVal('color-muted', current.theme?.colorMuted || '');

      setVal('logo-url', current.assets?.logoUrl || '');
      setVal('hero-url', current.assets?.heroUrl || '');
      setVal('gallery-urls', (current.assets?.gallery || []).join('\n'));

      setVal('name-es', current.fields?.name?.label?.es || '');
      setVal('name-en', current.fields?.name?.label?.en || '');
      setChecked('name-required', current.fields?.name?.required !== false);

      setVal('email-es', current.fields?.email?.label?.es || '');
      setVal('email-en', current.fields?.email?.label?.en || '');
      setChecked('email-required', current.fields?.email?.required !== false);

      setVal('phone-es', current.fields?.phone?.label?.es || '');
      setVal('phone-en', current.fields?.phone?.label?.en || '');
      setChecked('phone-required', current.fields?.phone?.required !== false);

      setVal('role-es', current.fields?.role?.label?.es || '');
      setVal('role-en', current.fields?.role?.label?.en || '');
      setChecked('role-required', !!current.fields?.role?.required);
      setVal('role-options', (current.fields?.role?.options || []).map((o) => (typeof o === 'string' ? o : (o.es || o.en || o.value || ''))).join('\n'));

      setVal('resume-es', current.resume?.label?.es || '');
      setVal('resume-en', current.resume?.label?.en || '');
      setChecked('resume-required', !!current.resume?.required);

      setVal('photo-es', current.photo?.label?.es || '');
      setVal('photo-en', current.photo?.label?.en || '');
      setChecked('photo-required', !!current.photo?.required);

      renderQuestions();
    }

    function renderQuestions() {
      const list = document.getElementById('question-list');
      list.innerHTML = '';
      (current.questions || []).forEach((q, idx) => {
        const wrap = document.createElement('div');
        wrap.className = 'question';
        wrap.innerHTML = [
          '<div class="grid">',
          '  <div>',
          '    <label>Label ES</label>',
          '    <input data-q="label-es" />',
          '  </div>',
          '  <div>',
          '    <label>Label EN</label>',
          '    <input data-q="label-en" />',
          '  </div>',
          '  <div>',
          '    <label>Type</label>',
          '    <select data-q="type">',
          '      <option value="short">Short</option>',
          '      <option value="long">Long</option>',
          '      <option value="select">Options</option>',
          '      <option value="yesno">Yes/No</option>',
          '    </select>',
          '  </div>',
          '  <div class="row">',
          '    <input type="checkbox" data-q="required" />',
          '    <label>Required</label>',
          '  </div>',
          '</div>',
          '<div>',
          '  <label>Options (one per line)</label>',
          '  <textarea data-q="options"></textarea>',
          '</div>',
          '<div class="row">',
          '  <button class="btn" data-q="remove">Remove</button>',
          '</div>'
        ].join('');
        wrap.querySelector('[data-q="label-es"]').value = q.label?.es || '';
        wrap.querySelector('[data-q="label-en"]').value = q.label?.en || '';
        wrap.querySelector('[data-q="type"]').value = q.type || 'short';
        wrap.querySelector('[data-q="required"]').checked = !!q.required;
        wrap.querySelector('[data-q="options"]').value = (q.options || []).map((o) => (typeof o === 'string' ? o : (o.es || o.en || ''))).join('\n');
        wrap.querySelector('[data-q="remove"]').onclick = () => {
          current.questions.splice(idx, 1);
          renderQuestions();
        };
        list.appendChild(wrap);
      });
    }

    function readQuestions() {
      const list = document.getElementById('question-list');
      const items = [];
      Array.from(list.children).forEach((wrap, idx) => {
        const labelEs = wrap.querySelector('[data-q="label-es"]').value.trim();
        const labelEn = wrap.querySelector('[data-q="label-en"]').value.trim();
        const type = wrap.querySelector('[data-q="type"]').value;
        const required = wrap.querySelector('[data-q="required"]').checked;
        const optionsRaw = wrap.querySelector('[data-q="options"]').value;
        const options = optionsRaw.split(/\n+/).map((v) => v.trim()).filter(Boolean).map((v) => ({ es: v, en: v }));
        items.push({
          id: (current.questions && current.questions[idx] && current.questions[idx].id) || ('q_' + Date.now() + '_' + idx),
          label: { es: labelEs, en: labelEn },
          type,
          required,
          options: type === 'select' ? options : []
        });
      });
      return items;
    }

    function collectForm() {
      const data = defaultPage();
      data.slug = val('page-slug').trim();
      data.brand = val('page-brand').trim();
      data.localeDefault = val('page-lang');
      data.active = val('page-active') === 'true';

      data.content.title.es = val('title-es').trim();
      data.content.title.en = val('title-en').trim();
      data.content.description.es = val('desc-es').trim();
      data.content.description.en = val('desc-en').trim();
      data.content.thankYou.es = val('thanks-es').trim();
      data.content.thankYou.en = val('thanks-en').trim();

      data.theme.fontHeading = val('font-heading').trim();
      data.theme.fontBody = val('font-body').trim();
      data.theme.fontUrl = val('font-url').trim();
      data.theme.colorPrimary = val('color-primary').trim();
      data.theme.colorAccent = val('color-accent').trim();
      data.theme.colorBg = val('color-bg').trim();
      data.theme.colorCard = val('color-card').trim();
      data.theme.colorText = val('color-text').trim();
      data.theme.colorMuted = val('color-muted').trim();

      data.assets.logoUrl = val('logo-url').trim();
      data.assets.heroUrl = val('hero-url').trim();
      data.assets.gallery = val('gallery-urls').split(/\n+/).map((v) => v.trim()).filter(Boolean);

      data.fields.name = { label: { es: val('name-es'), en: val('name-en') }, required: document.getElementById('name-required').checked };
      data.fields.email = { label: { es: val('email-es'), en: val('email-en') }, required: document.getElementById('email-required').checked };
      data.fields.phone = { label: { es: val('phone-es'), en: val('phone-en') }, required: document.getElementById('phone-required').checked };
      const roleOptions = val('role-options').split(/\n+/).map((v) => v.trim()).filter(Boolean).map((v) => ({ es: v, en: v }));
      data.fields.role = {
        label: { es: val('role-es'), en: val('role-en') },
        required: document.getElementById('role-required').checked,
        options: roleOptions
      };

      data.resume = { label: { es: val('resume-es'), en: val('resume-en') }, required: document.getElementById('resume-required').checked };
      data.photo = { label: { es: val('photo-es'), en: val('photo-en') }, required: document.getElementById('photo-required').checked };

      data.questions = readQuestions();
      return data;
    }

    function renderPreview() {
      if (!current) return;
      previewEl.innerHTML =
        '<strong>' + (current.brand || current.slug) + '</strong>' +
        '<div>' + (current.content?.title?.es || '') + ' / ' + (current.content?.title?.en || '') + '</div>' +
        '<div>Questions: ' + ((current.questions || []).length) + '</div>' +
        '<div>Active: ' + (current.active !== false ? 'Yes' : 'No') + '</div>';
    }

    document.getElementById('add-question').onclick = () => {
      if (!current) current = defaultPage();
      current.questions = current.questions || [];
      current.questions.push({ id: 'q_' + Date.now(), label: { es: '', en: '' }, type: 'short', required: false, options: [] });
      renderQuestions();
    };

    document.getElementById('new-page').onclick = () => {
      current = defaultPage();
      fillForm();
      renderPreview();
    };

    document.getElementById('logo-file').onchange = async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      pendingUploads.logo = { dataUrl: await fileToDataUrl(file), fileName: file.name };
      setStatus('Logo queued', false);
    };
    document.getElementById('hero-file').onchange = async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      pendingUploads.hero = { dataUrl: await fileToDataUrl(file), fileName: file.name };
      setStatus('Hero queued', false);
    };
    document.getElementById('gallery-files').onchange = async (e) => {
      const files = Array.from(e.target.files || []);
      const out = [];
      for (const file of files) {
        out.push({ dataUrl: await fileToDataUrl(file), fileName: file.name });
      }
      pendingUploads.gallery = out;
      setStatus('Gallery queued', false);
    };

    document.getElementById('save-page').onclick = async () => {
      try {
        if (!current) current = defaultPage();
        const payload = collectForm();
        if (pendingUploads.logo) {
          payload.logo_data_url = pendingUploads.logo.dataUrl;
          payload.logo_file_name = pendingUploads.logo.fileName;
        }
        if (pendingUploads.hero) {
          payload.hero_data_url = pendingUploads.hero.dataUrl;
          payload.hero_file_name = pendingUploads.hero.fileName;
        }
        if (pendingUploads.gallery.length) {
          payload.gallery_data_urls = pendingUploads.gallery.map((g) => g.dataUrl);
          payload.gallery_file_names = pendingUploads.gallery.map((g) => g.fileName);
        }
        const resp = await fetch('/admin/portal/pages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify(payload)
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'save_failed');
        pendingUploads = { logo: null, hero: null, gallery: [] };
        await loadPages();
        selectPage(data.page.slug);
        setStatus('Saved', false);
      } catch (err) {
        setStatus(err.message || 'save_failed', true);
      }
    };

    document.getElementById('delete-page').onclick = async () => {
      if (!current || !current.slug) return;
      if (!confirm('Delete page?')) return;
      const resp = await fetch('/admin/portal/pages/' + encodeURIComponent(current.slug), {
        method: 'DELETE',
        headers: authHeaders()
      });
      const data = await resp.json();
      if (!resp.ok) {
        setStatus(data.error || 'delete_failed', true);
        return;
      }
      current = null;
      await loadPages();
      setStatus('Deleted', false);
    };

    if (appFilterEl) {
      appFilterEl.addEventListener('change', () => {
        loadApplications().catch(() => {});
      });
    }
    if (appRefreshEl) {
      appRefreshEl.onclick = () => {
        loadApplications().catch(() => {});
      };
    }
    if (appExportEl) {
      appExportEl.onclick = () => {
        try {
          exportCsv();
        } catch (err) {
          setStatus(err.message || 'export_failed', true);
        }
      };
    }

    saveTokenBtn.onclick = () => {
      localStorage.setItem('portalToken', tokenInput.value.trim());
      setStatus('Token saved', false);
    };

    tokenInput.value = localStorage.getItem('portalToken') || '';
    loadPages().catch((err) => setStatus(err.message || 'load_failed', true));
  </script>
</body>
</html>`;
}

module.exports = {
  renderApplyPage,
  renderAdminPage
};

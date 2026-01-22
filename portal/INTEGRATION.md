Portal integration notes (server.js untouched)

1) Import the portal router

Add near the top of server.js:

  const { createPortalRouter } = require("./portal");

2) Mount the router (choose once you are ready)

Add after app initialization and middleware:

  const portalRouter = createPortalRouter({
    dataDir: path.join(__dirname, "data"),
    uploadsDir: path.join(__dirname, "data", "uploads"),
    uploadsBaseUrl: "/uploads",
    requireAdmin: requireAdminUser,
    requireWrite: requireWrite,
    saveCvEntry: (entry) => recordCvEntry(buildCvEntry(entry))
  });
  app.use("/", portalRouter);

Notes:
- If you mount at a different base path, update uploadsBaseUrl to match.
- The portal uses local storage in data/portal-pages.json and data/portal-applications.json.
- Resume and photo files are saved under data/uploads/portal-apps/... and served from /uploads.

3) Optional env overrides
- PORTAL_PAGES_PATH, PORTAL_APPS_PATH, PORTAL_UPLOADS_DIR
- You can pass them via createPortalRouter options or wire them from process.env.

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
    publicUploadsBaseUrl: getSpacesPublicBaseUrl() || "/uploads",
    uploadToSpaces: portalUploadToSpaces,
    dbPool,
    requireAdmin: requireAdminUser,
    requireWrite: requireWrite,
    saveCvEntry: (entry) => recordCvEntry(buildCvEntry(entry))
  });
  app.use("/", portalRouter);

Notes:
- If you mount at a different base path, update uploadsBaseUrl to match.
- If dbPool is provided, pages and applications are stored in Postgres tables.
- If uploadToSpaces + publicUploadsBaseUrl are provided, files are stored in Spaces.
- When Spaces is public, set SPACES_PUBLIC=1 or SPACES_PUBLIC_URL for public URLs.

3) Optional env overrides
- PORTAL_PAGES_PATH, PORTAL_APPS_PATH, PORTAL_UPLOADS_DIR (local fallback)
- You can pass them via createPortalRouter options or wire them from process.env.

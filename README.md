# Koorta DB Worker

The worker publishes its OpenAPI 3.1 document and interactive Swagger UI:

- Swagger UI: `https://<worker-host>/docs`
- OpenAPI JSON: `https://<worker-host>/openapi.json`

The documentation is served by the worker itself and does not require the D1
database to be available. Swagger UI assets load from the unpkg CDN.

Admin endpoints require a valid Cloudflare Access session for the worker host.
The order creation, contact, wholesale, and promo-validation endpoints also
require `x-koorta-db-api-key` with the configured `KOORTA_DB_WORKER_API_SECRET`.
The carrier webhook uses `x-api-key` with `SHIPROCKET_WEBHOOK_SECRET`.

Run the worker locally from this directory and leave the dev server running:

```powershell
npm run dev -- --config .\wrangler.toml
```

Then open `http://localhost:8787/docs`. No deployment is needed to view the
local Swagger UI.

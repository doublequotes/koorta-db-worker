import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { webcrypto } from "node:crypto";

import worker from "./index.js";
import {
  collectReservedReturnQuantities,
  getCorsHeaders,
  isWithinReturnWindow,
  normalizePhone,
  restoreCatalogStockForOrder,
  shiprocketRequest,
  verifyCloudflareAccess,
  verifyTurnstile,
} from "./index.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

test("reuses the Shiprocket auth token from KV across Worker isolates", async () => {
  const cachedValues = new Map();
  const cacheTtls = [];
  let authCalls = 0;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const tokenPayload = Buffer.from(JSON.stringify({ exp: nowSeconds + 10 * 24 * 60 * 60 }))
    .toString("base64url");
  const token = `header.${tokenPayload}.signature`;
  const originalFetch = globalThis.fetch;
  const authUrls = [];
  const cache = {
    async get(key) {
      return cachedValues.get(key) || null;
    },
    async put(key, value, options) {
      cachedValues.set(key, value);
      cacheTtls.push(options.expirationTtl);
    },
    async delete(key) {
      cachedValues.delete(key);
    },
  };
  globalThis.fetch = async (input) => {
    authUrls.push(String(input));
    authCalls += 1;
    return new Response(JSON.stringify({ token }), { status: 200 });
  };

  try {
    const env = {
      SHIPROCKET_EMAIL: "worker@example.test",
      SHIPROCKET_PASSWORD: "test-password",
      SHIPROCKET_API_BASE_URL: "https://sandbox.example.test/v1/external/",
      SHIPROCKET_TOKEN_CACHE: cache,
    };
    const firstIsolate = await import("./index.js?shiprocket-kv-first-isolate");
    assert.equal(await firstIsolate.getShiprocketToken(env, true), token);
    assert.equal(authCalls, 1);
    assert.deepEqual(authUrls, ["https://sandbox.example.test/v1/external/auth/login"]);
    assert.ok(Math.abs(cacheTtls[0] - (10 * 24 * 60 * 60 - 60)) <= 1);

    const secondIsolate = await import("./index.js?shiprocket-kv-second-isolate");
    assert.equal(await secondIsolate.getShiprocketToken(env), token);
    assert.equal(authCalls, 1);

    const productionEnv = {
      ...env,
      SHIPROCKET_API_BASE_URL: "https://apiv2.shiprocket.in/v1/external",
    };
    assert.equal(await firstIsolate.getShiprocketToken(productionEnv), token);
    assert.equal(authCalls, 2);
    assert.deepEqual(authUrls, [
      "https://sandbox.example.test/v1/external/auth/login",
      "https://apiv2.shiprocket.in/v1/external/auth/login",
    ]);

    const productionIsolate = await import("./index.js?shiprocket-kv-production-isolate");
    assert.equal(await productionIsolate.getShiprocketToken(productionEnv), token);
    assert.equal(authCalls, 2);

    const requestIsolate = await import("./index.js?shiprocket-configured-api-request");
    globalThis.fetch = async (input) => {
      assert.equal(String(input), "https://sandbox.example.test/v1/external/orders/create/adhoc");
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };
    assert.deepEqual(
      await requestIsolate.shiprocketRequest(env, "/orders/create/adhoc", {}),
      { success: true },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stores a new token before shipment calls and refreshes once after HTTP 498", async () => {
  const cachedValues = new Map();
  const cache = {
    async get(key) {
      return cachedValues.get(key) || null;
    },
    async put(key, value) {
      cachedValues.set(key, value);
    },
    async delete(key) {
      cachedValues.delete(key);
    },
  };
  const nowSeconds = Math.floor(Date.now() / 1000);
  const tokens = ["sandbox-token-1", "sandbox-token-2"].map(
    (label) =>
      `${label}.${Buffer.from(
        JSON.stringify({ exp: nowSeconds + 10 * 24 * 60 * 60 }),
      ).toString("base64url")}.signature`,
  );
  const originalFetch = globalThis.fetch;
  let authCalls = 0;
  let shipmentCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/auth/login")) {
      assert.equal(cachedValues.size, 0);
      authCalls += 1;
      return new Response(JSON.stringify({ token: tokens[authCalls - 1] }), { status: 200 });
    }

    assert.equal(url, "https://sandbox.example.test/v1/external/orders/create/adhoc");
    assert.equal(cachedValues.size, 1, "token should be stored in KV before the shipment request");
    const cachedToken = JSON.parse(Array.from(cachedValues.values())[0]).token;
    assert.equal(init.headers.Authorization, `Bearer ${cachedToken}`);
    shipmentCalls += 1;
    if (shipmentCalls === 1) {
      assert.equal(cachedToken, tokens[0]);
      return new Response(JSON.stringify({ message: "Invalid or expired token" }), {
        status: 498,
      });
    }
    assert.equal(cachedToken, tokens[1]);
    return new Response(JSON.stringify({ order_id: 7101 }), { status: 200 });
  };

  try {
    const module = await import("./index.js?shiprocket-498-token-refresh");
    const result = await module.shiprocketRequest(
      {
        SHIPROCKET_EMAIL: "sandbox@example.test",
        SHIPROCKET_PASSWORD: "sandbox-password",
        SHIPROCKET_API_BASE_URL: "https://sandbox.example.test/v1/external",
        SHIPROCKET_TOKEN_CACHE: cache,
      },
      "/orders/create/adhoc",
      { order_id: "TEST-1" },
    );

    assert.deepEqual(result, { order_id: 7101 });
    assert.equal(authCalls, 2);
    assert.equal(shipmentCalls, 2);
    assert.equal(JSON.parse(Array.from(cachedValues.values())[0]).token, tokens[1]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not retry a rejected Shiprocket login", async () => {
  let authCalls = 0;
  let shipmentCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    assert.equal(String(input), "https://sandbox.example.test/v1/external/auth/login");
    authCalls += 1;
    return new Response(JSON.stringify({}), { status: 498 });
  };

  try {
    const module = await import("./index.js?shiprocket-498-login-failure");
    await assert.rejects(
      module.shiprocketRequest(
        {
          SHIPROCKET_EMAIL: "sandbox@example.test",
          SHIPROCKET_PASSWORD: "sandbox-password",
          SHIPROCKET_API_BASE_URL: "https://sandbox.example.test/v1/external",
          SHIPROCKET_TOKEN_CACHE: {
            async get() {
              return null;
            },
            async put() {},
            async delete() {},
          },
        },
        "/orders/create/adhoc",
        { order_id: "TEST-2" },
      ),
      /Shiprocket authentication failed/,
    );
    assert.equal(authCalls, 1);
    assert.equal(shipmentCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("normalizes Indian phone numbers consistently", () => {
  assert.equal(normalizePhone("+91 98200 00000"), "9820000000");
  assert.equal(normalizePhone("98200-00000"), "9820000000");
});

test("enforces the trusted 15-day delivery return window", () => {
  const now = Date.parse("2026-04-20T12:00:00.000Z");
  assert.equal(isWithinReturnWindow("2026-04-05T12:00:00.000Z", now), true);
  assert.equal(isWithinReturnWindow("2026-04-04T11:59:59.999Z", now), false);
  assert.equal(isWithinReturnWindow("2026-04-21T12:00:00.000Z", now), false);
});

test("allows credentialed CORS only from configured admin UI origins", () => {
  const env = { ADMIN_UI_ORIGINS: "https://koorta.com,https://www.koorta.com" };
  const allowedRequest = new Request("https://db.koorta.com/admin/orders", {
    headers: { origin: "https://koorta.com" },
  });
  const blockedRequest = new Request("https://db.koorta.com/admin/orders", {
    headers: { origin: "https://untrusted.example" },
  });

  assert.equal(
    getCorsHeaders(env, allowedRequest, true)["Access-Control-Allow-Origin"],
    "https://koorta.com",
  );
  assert.equal(
    getCorsHeaders(env, allowedRequest, true)["Access-Control-Allow-Credentials"],
    "true",
  );
  assert.equal(getCorsHeaders(env, blockedRequest, true)["Access-Control-Allow-Origin"], undefined);
});

test("reserves item quantities only for active return ledger entries", () => {
  const quantities = collectReservedReturnQuantities([
    {
      status: "return_requested",
      metadata: JSON.stringify({
        type: "return",
        items: [{ itemId: "kurta-1", size: "M", qty: 1 }],
      }),
    },
    {
      status: "refunded",
      metadata: JSON.stringify({
        type: "return",
        items: [{ itemId: "kurta-1", size: "M", qty: 1 }],
      }),
    },
    {
      status: "rejected",
      metadata: JSON.stringify({
        type: "return",
        items: [{ itemId: "kurta-1", size: "M", qty: 3 }],
      }),
    },
  ]);
  assert.equal(quantities.get("kurta-1\u0000M"), 2);
});

test("restores R2 stock exactly once for a transaction adjustment", async () => {
  let catalog = [
    {
      id: "kurta-1",
      name: "Linen Kurta",
      sizes: ["M"],
      stockBySize: { M: 2 },
    },
  ];
  const bucket = {
    async get() {
      return { text: async () => JSON.stringify(catalog) };
    },
    async put(_key, content) {
      catalog = JSON.parse(content);
    },
  };
  const items = [{ itemId: "kurta-1", size: "M", qty: 2 }];

  await restoreCatalogStockForOrder(bucket, items, "return-test-id");
  await restoreCatalogStockForOrder(bucket, items, "return-test-id");

  assert.equal(catalog[0].stockBySize.M, 4);
  assert.deepEqual(catalog[0].inventoryAdjustmentIds, ["return-test-id"]);
});

test("validates Cloudflare Access JWT signature, issuer, audience, and identity", async () => {
  const keyPair = await webcrypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await webcrypto.subtle.exportKey("jwk", keyPair.publicKey);
  publicJwk.kid = "koorta-test-key";
  publicJwk.alg = "RS256";

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 });
  try {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: publicJwk.kid })).toString(
      "base64url",
    );
    const claims = {
      iss: "https://koorta-test.cloudflareaccess.com",
      aud: ["koorta-admin-audience"],
      email: "admin@koorta.com",
      exp: Math.floor(Date.now() / 1000) + 60,
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signingInput = `${header}.${payload}`;
    const signature = await webcrypto.subtle.sign(
      { name: "RSASSA-PKCS1-v1_5" },
      keyPair.privateKey,
      new TextEncoder().encode(signingInput),
    );
    const token = `${signingInput}.${Buffer.from(signature).toString("base64url")}`;
    const request = new Request("https://db.koorta.com/admin/orders", {
      headers: { "cf-access-jwt-assertion": token },
    });
    const env = {
      ACCESS_ISSUER: "https://koorta-test.cloudflareaccess.com",
      ACCESS_AUD: "koorta-admin-audience",
    };

    assert.equal(await verifyCloudflareAccess(request, env), "admin@koorta.com");
    const invalidRequest = new Request("https://db.koorta.com/admin/orders", {
      headers: {
        "cf-access-jwt-assertion": `${header}.${Buffer.from(JSON.stringify({ ...claims, aud: ["wrong"] })).toString("base64url")}.${Buffer.from(signature).toString("base64url")}`,
      },
    });
    assert.equal(await verifyCloudflareAccess(invalidRequest, env), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reports missing Cloudflare Access configuration for admin routes", async () => {
  const response = await worker.fetch(new Request("https://db.koorta.com/admin/orders"), {
    ADMIN_UI_ORIGINS: "https://koorta.com",
  });
  assert.equal(response.status, 503);
});

test("generates an Access-protected monthly cash report using India time and completed events only", async () => {
  const { database, d1 } = createOrderDatabase({
    orderStatus: "pending",
    paymentStatus: "pending",
    total: 2000,
    discount: 0,
    shipping: 0,
  });
  const accessToken = await (await createAccessCredentials())();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).includes("/cdn-cgi/access/certs")) {
      return new Response(JSON.stringify({ keys: [accessToken.jwk] }), { status: 200 });
    }
    throw new Error(`Unexpected fetch in test: ${String(input)}`);
  };
  database
    .prepare(
      `INSERT INTO transactions (
      transaction_id, order_number, provider, method, status, amount, external_reference, metadata, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "payment-nov",
      "ORD-1",
      "upi",
      "upi",
      "paid",
      2000,
      "upi-payment-ref",
      JSON.stringify({ paymentConfirmedAt: "2026-10-31T18:35:00.000Z" }),
      "2026-10-31T18:35:00.000Z",
    );
  database
    .prepare(
      `INSERT INTO transactions (
      transaction_id, order_number, provider, method, status, amount, external_reference, metadata, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "refund-nov",
      "ORD-1",
      "manual",
      "refund",
      "refunded",
      -300,
      "refund-ref",
      JSON.stringify({ type: "return", refundedAt: "2026-11-30T18:00:00.000Z" }),
      "2026-11-30T18:00:00.000Z",
    );
  database
    .prepare(
      `INSERT INTO transactions (
      transaction_id, order_number, provider, method, status, amount, metadata, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "refund-pending",
      "ORD-1",
      "manual",
      "refund",
      "refund_pending",
      -500,
      JSON.stringify({ type: "return" }),
      "2026-11-15T12:00:00.000Z",
    );
  const env = {
    KOORTA_DB: d1,
    ACCESS_ISSUER: "https://koorta-flow-test.cloudflareaccess.com",
    ACCESS_AUD: "koorta-flow-test-audience",
    ADMIN_UI_ORIGINS: "https://koorta.com",
  };
  const request = new Request("https://db.koorta.com/admin/reports/monthly?year=2026&month=11", {
    headers: {
      "cf-access-jwt-assertion": accessToken.token,
      origin: "https://koorta.com",
    },
  });

  try {
    const response = await worker.fetch(request, env);
    assert.equal(response.status, 200);
    const report = await response.json();
    assert.equal(report.summary.cashCollected, 2000);
    assert.equal(report.summary.refundsPaid, 300);
    assert.equal(report.summary.netCashCollected, 1700);
    assert.equal(report.summary.paymentCount, 1);
    assert.equal(report.summary.refundCount, 1);
    assert.deepEqual(
      report.transactions.map((transaction) => transaction.transaction_id),
      ["payment-nov", "refund-nov"],
    );

    const invalidMonth = await worker.fetch(
      new Request("https://db.koorta.com/admin/reports/monthly?year=2026&month=13", {
        headers: { "cf-access-jwt-assertion": accessToken.token },
      }),
      env,
    );
    assert.equal(invalidMonth.status, 400);
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test("verifies Turnstile action and allowed hostname server-side", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = new URLSearchParams(init.body);
    assert.equal(body.get("secret"), "server-only-secret");
    assert.equal(body.get("response"), "valid-token");
    assert.equal(body.get("remoteip"), "192.0.2.1");
    return new Response(
      JSON.stringify({
        success: true,
        action: "order_lookup",
        hostname: "koorta.com",
      }),
      { status: 200 },
    );
  };

  try {
    const request = new Request("https://db.koorta.com/customer/order-lookup", {
      headers: { "cf-connecting-ip": "192.0.2.1" },
    });
    const env = {
      TURNSTILE_SECRET_KEY: "server-only-secret",
      TURNSTILE_HOSTNAMES: "koorta.com,www.koorta.com",
    };
    assert.equal(await verifyTurnstile(request, "valid-token", env, "order_lookup"), true);
    assert.equal(await verifyTurnstile(request, "valid-token", env, "order_request"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

class LocalStatement {
  constructor(database, query) {
    this.database = database;
    this.query = query;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async first() {
    return this.database.prepare(this.query).get(...this.values) || null;
  }

  async all() {
    return { results: this.database.prepare(this.query).all(...this.values) };
  }

  async run() {
    const result = this.database.prepare(this.query).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

class LocalD1 {
  constructor(database) {
    this.database = database;
  }

  prepare(query) {
    return new LocalStatement(this.database, query);
  }

  async batch(statements) {
    this.database.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) {
        results.push(
          /^\s*SELECT\b/i.test(statement.query) ? await statement.all() : await statement.run(),
        );
      }
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function createOrderDatabase({
  orderStatus = "delivered",
  paymentStatus = "paid",
  total = 2000,
  discount = 200,
  shipping = 200,
} = {}) {
  const database = new DatabaseSync(":memory:");
  for (const migration of [
    "001_create_orders.sql",
    "002_returns_and_delivery.sql",
    "003_shiprocket_shipments.sql",
  ]) {
    database.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
  }
  const placedAt = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
  const deliveredAt = orderStatus === "delivered" ? new Date().toISOString() : null;
  database
    .prepare(
      `INSERT INTO orders (
      order_number, placed_at, customer_name, customer_email, customer_phone, customer_address,
      customer_city, customer_state, customer_district, customer_post_office, customer_pincode,
      payment_method, upi_id, subtotal, discount, promo_code, shipping, total, status, delivered_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "ORD-1",
      placedAt,
      "A Customer",
      "customer@example.com",
      "+91 98200 00000",
      "1 Test Road",
      "Mumbai",
      "Maharashtra",
      "Mumbai",
      "Central",
      "400001",
      "upi",
      null,
      2000,
      discount,
      null,
      shipping,
      total,
      orderStatus,
      deliveredAt,
    );
  database
    .prepare(
      "INSERT INTO order_items (order_number, item_id, name, size, quantity, price) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run("ORD-1", "item-1", "Linen Kurta", "M", 1, 800);
  database
    .prepare(
      "INSERT INTO order_items (order_number, item_id, name, size, quantity, price) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run("ORD-1", "item-2", "Cotton Pyjama", "L", 1, 1200);
  database
    .prepare(
      `INSERT INTO transactions (
      transaction_id, order_number, provider, method, status, amount, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("payment-1", "ORD-1", "upi", "upi", paymentStatus, total, "{}");
  return { database, d1: new LocalD1(database) };
}

let flowAccessTokenFactory;

async function createAccessCredentials() {
  if (flowAccessTokenFactory) return flowAccessTokenFactory;
  const keyPair = await webcrypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwk = await webcrypto.subtle.exportKey("jwk", keyPair.publicKey);
  jwk.kid = "koorta-flow-test-key";
  jwk.alg = "RS256";

  async function token() {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: jwk.kid })).toString(
      "base64url",
    );
    const payload = Buffer.from(
      JSON.stringify({
        iss: "https://koorta-flow-test.cloudflareaccess.com",
        aud: ["koorta-flow-test-audience"],
        email: "admin@koorta.com",
        exp: Math.floor(Date.now() / 1000) + 60,
      }),
    ).toString("base64url");
    const signingInput = `${header}.${payload}`;
    const signature = await webcrypto.subtle.sign(
      { name: "RSASSA-PKCS1-v1_5" },
      keyPair.privateKey,
      new TextEncoder().encode(signingInput),
    );
    return {
      token: `${signingInput}.${Buffer.from(signature).toString("base64url")}`,
      jwk,
    };
  }
  flowAccessTokenFactory = token;
  return flowAccessTokenFactory;
}

test("books forward and approved reverse Shiprocket shipments and applies carrier events", async () => {
  const { database, d1 } = createOrderDatabase({
    orderStatus: "confirmed",
    paymentStatus: "paid",
    discount: 0,
    shipping: 0,
  });
  const tokenFactory = await createAccessCredentials();
  const access = await tokenFactory();
  const originalFetch = globalThis.fetch;
  const shipmentCalls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("/cdn-cgi/access/certs")) {
      return new Response(JSON.stringify({ keys: [access.jwk] }), { status: 200 });
    }
    if (url.endsWith("/auth/login")) {
      return new Response(JSON.stringify({ token: "shiprocket-test-token" }), { status: 200 });
    }
    const body = init.body ? JSON.parse(init.body) : null;
    shipmentCalls.push({ url, body });
    if (url.endsWith("/orders/create/adhoc")) {
      assert.match(body.order_id, /^\d+$/);
      assert.equal(body.pickup_location, "Test Warehouse");
      assert.equal(body.payment_method, "Prepaid");
      return new Response(JSON.stringify({ order_id: 7001, shipment_id: 8001 }), {
        status: 200,
      });
    }
    if (url.endsWith("/orders/create/return")) {
      assert.equal(body.shipping_pincode, 400001);
      assert.equal(body.pickup_pincode, 400001);
      return new Response(JSON.stringify({ order_id: 7002, shipment_id: 8002 }), {
        status: 200,
      });
    }
    if (url.endsWith("/courier/assign/awb")) {
      assert.equal(init.headers.Authorization, "Bearer shiprocket-test-token");
      return new Response(
        JSON.stringify({
          response: {
            data: {
              awb_code: body.is_return ? "RETURN-AWB" : "FORWARD-AWB",
              courier_name: "Test Courier",
            },
          },
        }),
        { status: 200 },
      );
    }
    if (url.endsWith("/courier/generate/pickup")) {
      return new Response(JSON.stringify({ pickup_status: 1 }), { status: 200 });
    }
    if (url.endsWith("/manifests/generate")) {
      return new Response(
        JSON.stringify({ status: 1, manifest_url: "https://example.test/manifest.pdf" }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const env = {
    KOORTA_DB: d1,
    ACCESS_ISSUER: "https://koorta-flow-test.cloudflareaccess.com",
    ACCESS_AUD: "koorta-flow-test-audience",
    SHIPROCKET_EMAIL: "worker@example.test",
    SHIPROCKET_PASSWORD: "test-password",
    SHIPROCKET_PICKUP_LOCATION: "Test Warehouse",
    SHIPROCKET_PARCEL_LENGTH: "25",
    SHIPROCKET_PARCEL_BREADTH: "20",
    SHIPROCKET_PARCEL_HEIGHT: "5",
    SHIPROCKET_PARCEL_WEIGHT: "0.5",
    SHIPROCKET_RETURN_NAME: "Koorta Warehouse",
    SHIPROCKET_RETURN_ADDRESS: "2 Test Road",
    SHIPROCKET_RETURN_CITY: "Mumbai",
    SHIPROCKET_RETURN_STATE: "Maharashtra",
    SHIPROCKET_RETURN_PINCODE: "400001",
    SHIPROCKET_RETURN_PHONE: "9820000000",
    SHIPROCKET_RETURN_EMAIL: "returns@example.test",
    SHIPROCKET_WEBHOOK_SECRET: "test-webhook-secret",
  };
  const adminHeaders = {
    "content-type": "application/json",
    "cf-access-jwt-assertion": access.token,
  };

  try {
    const forwardResponse = await worker.fetch(
      new Request("https://db.koorta.com/admin/orders/ORD-1/shipping", {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ action: "book", direction: "forward" }),
      }),
      env,
    );
    assert.equal(forwardResponse.status, 200);
    const forwardBody = await forwardResponse.json();
    assert.equal(forwardBody.shipment.status, "booked");
    assert.equal(forwardBody.shipment.awb, "FORWARD-AWB");
    assert.equal(database.prepare("SELECT status FROM orders WHERE order_number = ?").get("ORD-1").status, "confirmed");

    database
      .prepare(
        `INSERT INTO transactions (
          transaction_id, order_number, provider, method, status, amount, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "return-approved",
        "ORD-1",
        "koorta",
        "return",
        "approved",
        -800,
        JSON.stringify({
          type: "return",
          items: [{ itemId: "item-1", name: "Linen Kurta", size: "M", qty: 1 }],
        }),
      );
    const reverseResponse = await worker.fetch(
      new Request("https://db.koorta.com/admin/orders/ORD-1/shipping", {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          action: "book",
          direction: "reverse",
          transactionId: "return-approved",
        }),
      }),
      env,
    );
    assert.equal(reverseResponse.status, 200);
    const reverseBody = await reverseResponse.json();
    assert.equal(reverseBody.shipment.status, "booked");
    assert.equal(reverseBody.shipment.awb, "RETURN-AWB");
    assert.ok(shipmentCalls.some((call) => call.url.endsWith("/orders/create/return")));
    assert.ok(
      shipmentCalls.some(
        (call) =>
          call.url.endsWith("/courier/assign/awb") && call.body.is_return === 1,
      ),
    );

    const unauthorizedWebhook = await worker.fetch(
      new Request("https://db.koorta.com/webhooks/carrier-events", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "wrong-secret" },
        body: JSON.stringify({ awb: "FORWARD-AWB", current_status: "PICKED UP" }),
      }),
      env,
    );
    assert.equal(unauthorizedWebhook.status, 401);

    const pickedUp = await worker.fetch(
      new Request("https://db.koorta.com/webhooks/carrier-events", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "test-webhook-secret" },
        body: JSON.stringify({
          awb: "FORWARD-AWB",
          courier_name: "Test Courier",
          current_status: "PICKED UP",
          current_timestamp: "11 Nov 2026 10:00:00",
        }),
      }),
      env,
    );
    assert.equal(pickedUp.status, 200);
    assert.equal(database.prepare("SELECT status FROM orders WHERE order_number = ?").get("ORD-1").status, "shipped");

    await worker.fetch(
      new Request("https://db.koorta.com/webhooks/carrier-events", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "test-webhook-secret" },
        body: JSON.stringify({
          awb: "FORWARD-AWB",
          current_status: "DELIVERED",
          current_timestamp: "12 11 2026 10:00:00",
        }),
      }),
      env,
    );
    assert.equal(
      database.prepare("SELECT delivered_at FROM orders WHERE order_number = ?").get("ORD-1").delivered_at,
      "2026-11-12T04:30:00.000Z",
    );
    await worker.fetch(
      new Request("https://db.koorta.com/webhooks/carrier-events", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "test-webhook-secret" },
        body: JSON.stringify({ awb: "FORWARD-AWB", current_status: "IN TRANSIT" }),
      }),
      env,
    );
    assert.equal(database.prepare("SELECT status FROM orders WHERE order_number = ?").get("ORD-1").status, "delivered");

    for (const [current_status, expectedStatus] of [
      ["RTO In Transit", "rto_in_transit"],
      ["RTO Delivered", "rto_received"],
      ["DELIVERED", "rto_received"],
    ]) {
      await worker.fetch(
        new Request("https://db.koorta.com/webhooks/carrier-events", {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": "test-webhook-secret" },
          body: JSON.stringify({ awb: "FORWARD-AWB", current_status }),
        }),
        env,
      );
      assert.equal(
        database.prepare("SELECT status FROM order_shipments WHERE order_number = ? AND direction = 'forward'")
          .get("ORD-1").status,
        expectedStatus,
      );
    }

    await worker.fetch(
      new Request("https://db.koorta.com/webhooks/carrier-events", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "test-webhook-secret" },
        body: JSON.stringify({ awb: "RETURN-AWB", current_status: "DELIVERED" }),
      }),
      env,
    );
    assert.equal(database.prepare("SELECT status FROM orders WHERE order_number = ?").get("ORD-1").status, "delivered");
    const reverseShipment = database
      .prepare("SELECT status FROM order_shipments WHERE return_transaction_id = ?")
      .get("return-approved");
    assert.equal(reverseShipment.status, "delivered");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("marks a pre-AWB shipment cancelled from an order-ID-only Shiprocket webhook", async () => {
  const { database, d1 } = createOrderDatabase({
    orderStatus: "confirmed",
    paymentStatus: "paid",
    discount: 0,
    shipping: 0,
  });
  database
    .prepare(
      `INSERT INTO order_shipments (
        id, order_number, direction, external_order_reference, shiprocket_order_id,
        shiprocket_shipment_id, status, error, created_at, updated_at
      ) VALUES (?, ?, 'forward', ?, ?, ?, 'booking_error', ?, ?, ?)`,
    )
    .run(
      "shipment-1",
      "ORD-1",
      "812230253382",
      "1721799272",
      "1717427392",
      "KYC verification is mandated for your account to ship an order.",
      new Date().toISOString(),
      new Date().toISOString(),
    );
  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;
  console.error = () => {};
  console.warn = () => {};

  try {
    const response = await worker.fetch(
      new Request("https://db.koorta.com/webhooks/carrier-events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "test-webhook-secret",
        },
        body: JSON.stringify({
          order_id: "1721799272",
          current_status: "CANCELLED",
        }),
      }),
      {
        KOORTA_DB: d1,
        SHIPROCKET_WEBHOOK_SECRET: "test-webhook-secret",
      },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, matched: true });
    const shipment = database
      .prepare("SELECT status, error, last_event FROM order_shipments WHERE id = ?")
      .get("shipment-1");
    assert.equal(shipment.status, "cancelled");
    assert.equal(shipment.error, null);
    assert.equal(shipment.last_event, "CANCELLED");
  } finally {
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
  }
});

test("logs and saves Shiprocket create errors without logging response values", async () => {
  const { database, d1 } = createOrderDatabase({
    orderStatus: "confirmed",
    paymentStatus: "paid",
    discount: 0,
    shipping: 0,
  });
  const tokenFactory = await createAccessCredentials();
  const access = await tokenFactory();
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  const originalConsoleLog = console.log;
  const diagnosticLogs = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/cdn-cgi/access/certs")) {
      return new Response(JSON.stringify({ keys: [access.jwk] }), { status: 200 });
    }
    if (url.endsWith("/auth/login")) {
      return new Response(JSON.stringify({ token: "shiprocket-test-token" }), { status: 200 });
    }
    if (url.endsWith("/orders/create/adhoc")) {
      return new Response(
        JSON.stringify({
          message: "Wrong Pickup location entered. Please choose one location from the data given",
          data: {
            data: [
              {
                phone_verified: 1,
                id: 8001,
                pickup_location: "work",
                address: "private address",
                email: "private@example.test",
                phone: "9999999999",
              },
            ],
          },
        }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  console.error = (...args) => diagnosticLogs.push(args.join(" "));
  console.log = (...args) => diagnosticLogs.push(args.join(" "));

  const env = {
    KOORTA_DB: d1,
    ACCESS_ISSUER: "https://koorta-flow-test.cloudflareaccess.com",
    ACCESS_AUD: "koorta-flow-test-audience",
    SHIPROCKET_EMAIL: "worker@example.test",
    SHIPROCKET_PASSWORD: "test-password",
    SHIPROCKET_PICKUP_LOCATION: "Test Warehouse",
    SHIPROCKET_PARCEL_LENGTH: "25",
    SHIPROCKET_PARCEL_BREADTH: "20",
    SHIPROCKET_PARCEL_HEIGHT: "5",
    SHIPROCKET_PARCEL_WEIGHT: "0.5",
  };

  try {
    const response = await worker.fetch(
      new Request("https://db.koorta.com/admin/orders/ORD-1/shipping", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-access-jwt-assertion": access.token,
        },
        body: JSON.stringify({ action: "book", direction: "forward" }),
      }),
      env,
    );
    const body = await response.json();
    assert.equal(response.status, 502);
    assert.equal(
      body.error,
      "Wrong Pickup location entered. Please choose one location from the data given",
    );
    assert.match(diagnosticLogs.join("\n"), /data\.data\[0\]\.id: present \(number\)/);
    assert.match(diagnosticLogs.join("\n"), /Wrong Pickup location entered/);
    assert.doesNotMatch(diagnosticLogs.join("\n"), /private@example\.test|9999999999|private address/);
    const shipment = database
      .prepare("SELECT status, error FROM order_shipments WHERE order_number = ?")
      .get("ORD-1");
    assert.equal(shipment.status, "booking_failed");
    assert.equal(
      shipment.error,
      "Wrong Pickup location entered. Please choose one location from the data given",
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
    console.log = originalConsoleLog;
  }
});

test("keeps ambiguous Shiprocket booking failures manual and saves manual fallback details", async () => {
  const { database, d1 } = createOrderDatabase({
    orderStatus: "confirmed",
    paymentStatus: "paid",
    discount: 0,
    shipping: 0,
  });
  const tokenFactory = await createAccessCredentials();
  const access = await tokenFactory();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/cdn-cgi/access/certs")) {
      return new Response(JSON.stringify({ keys: [access.jwk] }), { status: 200 });
    }
    if (url.endsWith("/auth/login")) {
      return new Response(JSON.stringify({ token: "shiprocket-test-token" }), { status: 200 });
    }
    if (url.endsWith("/orders/create/adhoc")) {
      return new Response(JSON.stringify({ message: "Temporary carrier error" }), {
        status: 503,
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const env = {
    KOORTA_DB: d1,
    ACCESS_ISSUER: "https://koorta-flow-test.cloudflareaccess.com",
    ACCESS_AUD: "koorta-flow-test-audience",
    SHIPROCKET_EMAIL: "worker@example.test",
    SHIPROCKET_PASSWORD: "test-password",
    SHIPROCKET_PICKUP_LOCATION: "Test Warehouse",
    SHIPROCKET_PARCEL_LENGTH: "25",
    SHIPROCKET_PARCEL_BREADTH: "20",
    SHIPROCKET_PARCEL_HEIGHT: "5",
    SHIPROCKET_PARCEL_WEIGHT: "0.5",
  };
  const headers = {
    "content-type": "application/json",
    "cf-access-jwt-assertion": access.token,
  };
  try {
    const failedBooking = await worker.fetch(
      new Request("https://db.koorta.com/admin/orders/ORD-1/shipping", {
        method: "POST",
        headers,
        body: JSON.stringify({ action: "book", direction: "forward" }),
      }),
      env,
    );
    assert.equal(failedBooking.status, 502);
    assert.equal(
      database.prepare("SELECT status FROM order_shipments WHERE order_number = ?").get("ORD-1")
        .status,
      "booking_uncertain",
    );

    const manualUpdate = await worker.fetch(
      new Request("https://db.koorta.com/admin/orders/ORD-1/shipping", {
        method: "POST",
        headers,
        body: JSON.stringify({
          action: "manual",
          direction: "forward",
          awb: "MANUAL-AWB",
          courier: "Local courier",
          status: "Handed to courier",
        }),
      }),
      env,
    );
    assert.equal(manualUpdate.status, 200);
    const manualBody = await manualUpdate.json();
    assert.equal(manualBody.shipment.manual, true);
    assert.equal(manualBody.shipment.awb, "MANUAL-AWB");
    assert.equal(manualBody.shipment.lastEvent, "Handed to courier");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function createBucket(initialCatalog) {
  let catalog = initialCatalog;
  return {
    async get() {
      return { text: async () => JSON.stringify(catalog) };
    },
    async put(_key, content) {
      catalog = JSON.parse(content);
    },
    get catalog() {
      return catalog;
    },
  };
}

test("handles a discounted partial return through approval, restock, and refund", async () => {
  const { database, d1 } = createOrderDatabase();
  const bucket = createBucket([
    { id: "item-1", name: "Linen Kurta", sizes: ["M"], stockBySize: { M: 2 } },
    { id: "item-2", name: "Cotton Pyjama", sizes: ["L"], stockBySize: { L: 3 } },
  ]);
  const getAccessToken = await createAccessCredentials();
  const accessToken = await getAccessToken();
  const originalFetch = globalThis.fetch;
  const emailRecipients = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("/cdn-cgi/access/certs")) {
      return new Response(JSON.stringify({ keys: [accessToken.jwk] }), { status: 200 });
    }
    if (url.includes("/turnstile/v0/siteverify")) {
      const form = new URLSearchParams(init.body);
      return new Response(
        JSON.stringify({
          success: true,
          action:
            form.get("response") === "lookup-token"
              ? "order_lookup"
              : form.get("response") === "update-token"
                ? "order_update"
                : "order_request",
          hostname: "koorta.com",
        }),
        { status: 200 },
      );
    }
    if (url === "https://api.resend.com/emails") {
      emailRecipients.push(JSON.parse(init.body).to);
      return new Response(JSON.stringify({ id: "email-test-id" }), { status: 200 });
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  };
  const env = {
    KOORTA_DB: d1,
    GARMENT_BUCKET: bucket,
    ADMIN_UI_ORIGINS: "https://koorta.com",
    TURNSTILE_SECRET_KEY: "turnstile-test-secret",
    TURNSTILE_HOSTNAMES: "koorta.com",
    RESEND_API_KEY: "resend-test-secret",
    ACCESS_ISSUER: "https://koorta-flow-test.cloudflareaccess.com",
    ACCESS_AUD: "koorta-flow-test-audience",
  };
  const adminHeaders = {
    "content-type": "application/json",
    "cf-access-jwt-assertion": accessToken.token,
    origin: "https://koorta.com",
  };

  try {
    const lookupResponse = await worker.fetch(
      new Request("https://db.koorta.com/customer/order-lookup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orderNumber: "ORD-1",
          phone: "9820000000",
          turnstileToken: "lookup-token",
        }),
      }),
      env,
    );
    assert.equal(lookupResponse.status, 200);
    const lookup = await lookupResponse.json();
    assert.equal(lookup.order.customer, undefined);
    assert.equal(lookup.order.email, "customer@example.com");
    assert.equal(lookup.order.deliveryNote, "");
    assert.equal(lookup.order.items[0].returnableQty, 1);

    const requestResponse = await worker.fetch(
      new Request("https://db.koorta.com/customer/orders/ORD-1/requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          phone: "9820000000",
          turnstileToken: "request-token",
          type: "return",
          policyConfirmed: true,
          reason: "Wrong size",
          items: [{ itemId: "item-1", size: "M", qty: 1 }],
        }),
      }),
      env,
    );
    assert.equal(requestResponse.status, 201);
    assert.deepEqual(emailRecipients.splice(0), [["admin@koorta.com"], ["customer@example.com"]]);
    const requested = await requestResponse.json();
    const timelineResponse = await worker.fetch(
      new Request("https://db.koorta.com/customer/order-lookup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orderNumber: "ORD-1",
          phone: "9820000000",
          turnstileToken: "lookup-token",
        }),
      }),
      env,
    );
    assert.equal(timelineResponse.status, 200);
    const timeline = await timelineResponse.json();
    assert.equal(timeline.order.paymentReceived, true);
    assert.equal(timeline.order.requests.length, 1);
    assert.equal(timeline.order.requests[0].transactionId, requested.transactionId);
    assert.equal(timeline.order.requests[0].type, "return");
    assert.ok(timeline.order.requests[0].requestedAt);
    assert.equal(requested.estimatedRefund, 720);
    let ledger = database
      .prepare("SELECT amount, status, metadata FROM transactions WHERE transaction_id = ?")
      .get(requested.transactionId);
    assert.equal(ledger.amount, -720);
    assert.equal(JSON.parse(ledger.metadata).discountAllocated, 80);

    const requestEndpoint = `https://db.koorta.com/admin/orders/ORD-1/requests/${requested.transactionId}`;
    const approveResponse = await worker.fetch(
      new Request(requestEndpoint, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ action: "approve" }),
      }),
      env,
    );
    assert.equal(approveResponse.status, 200);
    assert.deepEqual(emailRecipients.splice(0), [["customer@example.com"]]);

    const receiveResponse = await worker.fetch(
      new Request(requestEndpoint, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ action: "receive" }),
      }),
      env,
    );
    assert.equal(receiveResponse.status, 200);
    assert.deepEqual(emailRecipients.splice(0), []);
    assert.equal(bucket.catalog[0].stockBySize.M, 3);

    const refundResponse = await worker.fetch(
      new Request(requestEndpoint, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ action: "refund", reference: "upi-ref-123" }),
      }),
      env,
    );
    assert.equal(refundResponse.status, 200);
    assert.deepEqual(emailRecipients.splice(0), [["customer@example.com"]]);
    ledger = database
      .prepare(
        "SELECT amount, status, external_reference FROM transactions WHERE transaction_id = ?",
      )
      .get(requested.transactionId);
    assert.equal(ledger.amount, -720);
    assert.equal(ledger.status, "refunded");
    assert.equal(ledger.external_reference, "upi-ref-123");
    assert.equal(
      database.prepare("SELECT status FROM orders WHERE order_number = ?").get("ORD-1").status,
      "partially_returned",
    );

    const secondRequestResponse = await worker.fetch(
      new Request("https://db.koorta.com/customer/orders/ORD-1/requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          phone: "9820000000",
          turnstileToken: "request-token-2",
          type: "return",
          policyConfirmed: true,
          reason: "Returning the second item",
          items: [{ itemId: "item-2", size: "L", qty: 1 }],
        }),
      }),
      env,
    );
    assert.equal(secondRequestResponse.status, 201);
    assert.deepEqual(emailRecipients.splice(0), [["admin@koorta.com"], ["customer@example.com"]]);
    const secondRequest = await secondRequestResponse.json();
    assert.equal(secondRequest.estimatedRefund, 1080);
    const secondEndpoint = `https://db.koorta.com/admin/orders/ORD-1/requests/${secondRequest.transactionId}`;
    for (const action of ["approve", "receive"]) {
      const response = await worker.fetch(
        new Request(secondEndpoint, {
          method: "POST",
          headers: adminHeaders,
          body: JSON.stringify({ action }),
        }),
        env,
      );
      assert.equal(response.status, 200);
      assert.deepEqual(
        emailRecipients.splice(0),
        action === "approve" ? [["customer@example.com"]] : [],
      );
    }
    const secondRefund = await worker.fetch(
      new Request(secondEndpoint, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ action: "refund", reference: "upi-ref-456" }),
      }),
      env,
    );
    assert.equal(secondRefund.status, 200);
    assert.deepEqual(emailRecipients.splice(0), [["customer@example.com"]]);
    assert.equal(bucket.catalog[1].stockBySize.L, 4);
    assert.equal(
      database.prepare("SELECT status FROM orders WHERE order_number = ?").get("ORD-1").status,
      "returned",
    );
    assert.equal(
      database
        .prepare(
          "SELECT SUM(amount) AS amount FROM transactions WHERE order_number = ? AND status = 'refunded'",
        )
        .get("ORD-1").amount,
      -1800,
    );

    const duplicateResponse = await worker.fetch(
      new Request("https://db.koorta.com/customer/orders/ORD-1/requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          phone: "9820000000",
          turnstileToken: "request-token",
          type: "return",
          policyConfirmed: true,
          reason: "Duplicate request",
          items: [{ itemId: "item-1", size: "M", qty: 1 }],
        }),
      }),
      env,
    );
    assert.equal(duplicateResponse.status, 409);

    const invalidEmailResponse = await worker.fetch(
      new Request("https://db.koorta.com/customer/orders/ORD-1/contact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          phone: "9820000000",
          turnstileToken: "update-token",
          email: "not-an-email",
          deliveryNote: "",
        }),
      }),
      env,
    );
    assert.equal(invalidEmailResponse.status, 400);

    const contactUpdateResponse = await worker.fetch(
      new Request("https://db.koorta.com/customer/orders/ORD-1/contact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          phone: "9820000000",
          turnstileToken: "update-token",
          email: "updated@example.com",
          deliveryNote: "Please call before delivery.",
        }),
      }),
      env,
    );
    assert.equal(contactUpdateResponse.status, 200);
    assert.deepEqual(await contactUpdateResponse.json(), {
      success: true,
      email: "updated@example.com",
      deliveryNote: "Please call before delivery.",
    });
    const updatedContact = database
      .prepare("SELECT customer_email, customer_notes FROM orders WHERE order_number = ?")
      .get("ORD-1");
    assert.equal(updatedContact.customer_email, "updated@example.com");
    assert.equal(updatedContact.customer_notes, "Please call before delivery.");
    const mismatchedPhoneUpdate = await worker.fetch(
      new Request("https://db.koorta.com/customer/orders/ORD-1/contact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          phone: "9999999999",
          turnstileToken: "update-token",
          email: "attacker@example.com",
          deliveryNote: "",
        }),
      }),
      env,
    );
    assert.equal(mismatchedPhoneUpdate.status, 404);
    const refreshedLookupResponse = await worker.fetch(
      new Request("https://db.koorta.com/customer/order-lookup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orderNumber: "ORD-1",
          phone: "9820000000",
          turnstileToken: "lookup-token",
        }),
      }),
      env,
    );
    assert.equal(refreshedLookupResponse.status, 200);
    const refreshedLookup = await refreshedLookupResponse.json();
    assert.equal(refreshedLookup.order.email, "updated@example.com");
    assert.equal(refreshedLookup.order.deliveryNote, "Please call before delivery.");

    const unauthorized = await worker.fetch(new Request("https://db.koorta.com/orders/ORD-1"), env);
    assert.equal(unauthorized.status, 401);
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test("cancels an unpaid order without creating a refund transaction", async () => {
  const { database, d1 } = createOrderDatabase({
    orderStatus: "pending",
    paymentStatus: "pending",
    total: 2000,
    discount: 0,
    shipping: 0,
  });
  const bucket = createBucket([
    { id: "item-1", name: "Linen Kurta", sizes: ["M"], stockBySize: { M: 2 } },
    { id: "item-2", name: "Cotton Pyjama", sizes: ["L"], stockBySize: { L: 3 } },
  ]);
  const getAccessToken = await createAccessCredentials();
  const accessToken = await getAccessToken();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("/cdn-cgi/access/certs")) {
      return new Response(JSON.stringify({ keys: [accessToken.jwk] }), { status: 200 });
    }
    if (url.includes("/turnstile/v0/siteverify")) {
      return new Response(
        JSON.stringify({ success: true, action: "order_request", hostname: "koorta.com" }),
        { status: 200 },
      );
    }
    if (url === "https://api.resend.com/emails") {
      return new Response(JSON.stringify({ id: "email-test-id" }), { status: 200 });
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  };
  const env = {
    KOORTA_DB: d1,
    GARMENT_BUCKET: bucket,
    ADMIN_UI_ORIGINS: "https://koorta.com",
    TURNSTILE_SECRET_KEY: "turnstile-test-secret",
    TURNSTILE_HOSTNAMES: "koorta.com",
    RESEND_API_KEY: "resend-test-secret",
    ACCESS_ISSUER: "https://koorta-flow-test.cloudflareaccess.com",
    ACCESS_AUD: "koorta-flow-test-audience",
  };

  try {
    const requestResponse = await worker.fetch(
      new Request("https://db.koorta.com/customer/orders/ORD-1/requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          phone: "9820000000",
          turnstileToken: "request-token",
          type: "cancellation",
          reason: "Placed by mistake",
        }),
      }),
      env,
    );
    assert.equal(requestResponse.status, 201);
    const requestResult = await requestResponse.json();
    const adminToken = await getAccessToken();
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      if (url.includes("/cdn-cgi/access/certs")) {
        return new Response(JSON.stringify({ keys: [adminToken.jwk] }), { status: 200 });
      }
      if (url === "https://api.resend.com/emails") {
        return new Response(JSON.stringify({ id: "email-test-id" }), { status: 200 });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    };
    const approveResponse = await worker.fetch(
      new Request(
        `https://db.koorta.com/admin/orders/ORD-1/requests/${requestResult.transactionId}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "cf-access-jwt-assertion": adminToken.token,
            origin: "https://koorta.com",
          },
          body: JSON.stringify({ action: "approve" }),
        },
      ),
      env,
    );
    assert.equal(approveResponse.status, 200);
    assert.equal(
      database.prepare("SELECT status FROM orders WHERE order_number = ?").get("ORD-1").status,
      "cancelled",
    );
    const transactions = database
      .prepare(
        "SELECT status, amount FROM transactions WHERE order_number = ? ORDER BY transaction_id",
      )
      .all("ORD-1");
    assert.equal(transactions.find((transaction) => transaction.status === "cancelled").amount, 0);
    assert.equal(
      transactions.some((transaction) => transaction.amount < 0),
      false,
    );
    assert.equal(
      database.prepare("SELECT status FROM transactions WHERE transaction_id = ?").get("payment-1")
        .status,
      "cancelled",
    );
    assert.equal(bucket.catalog[0].stockBySize.M, 3);
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

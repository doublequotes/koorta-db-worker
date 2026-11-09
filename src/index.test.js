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
  verifyCloudflareAccess,
  verifyTurnstile,
} from "./index.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

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

  assert.equal(getCorsHeaders(env, allowedRequest, true)["Access-Control-Allow-Origin"], "https://koorta.com");
  assert.equal(getCorsHeaders(env, allowedRequest, true)["Access-Control-Allow-Credentials"], "true");
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
  const response = await worker.fetch(
    new Request("https://db.koorta.com/admin/orders"),
    { ADMIN_UI_ORIGINS: "https://koorta.com" },
  );
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
  database.prepare(
    `INSERT INTO transactions (
      transaction_id, order_number, provider, method, status, amount, external_reference, metadata, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
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
  database.prepare(
    `INSERT INTO transactions (
      transaction_id, order_number, provider, method, status, amount, external_reference, metadata, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
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
  database.prepare(
    `INSERT INTO transactions (
      transaction_id, order_number, provider, method, status, amount, metadata, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
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
  const request = new Request(
    "https://db.koorta.com/admin/reports/monthly?year=2026&month=11",
    {
      headers: {
        "cf-access-jwt-assertion": accessToken.token,
        origin: "https://koorta.com",
      },
    },
  );

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
      for (const statement of statements) results.push(await statement.run());
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
  for (const migration of ["001_create_orders.sql", "002_returns_and_delivery.sql"]) {
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
          action: form.get("response") === "lookup-token" ? "order_lookup" : "order_request",
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
    assert.deepEqual(emailRecipients.splice(0), [
      ["admin@koorta.com"],
      ["customer@example.com"],
    ]);
    const requested = await requestResponse.json();
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
    assert.deepEqual(emailRecipients.splice(0), [
      ["admin@koorta.com"],
      ["customer@example.com"],
    ]);
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

    const unauthorized = await worker.fetch(
      new Request("https://db.koorta.com/orders/ORD-1"),
      env,
    );
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

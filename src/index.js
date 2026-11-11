function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

async function parseJson(request) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return null;
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function nowISOString() {
  return new Date().toISOString();
}

function buildError(message, status = 400, headers = {}) {
  return jsonResponse({ success: false, error: message }, status, headers);
}

function sanitizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function ensureNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
}

function formatCurrency(amount) {
  return `₹${Number(amount).toLocaleString("en-IN")}`;
}

const SHIPROCKET_API_BASE = "https://apiv2.shiprocket.in/v1/external";
const SHIPROCKET_TOKEN_CACHE_KEY = "shiprocket-auth-token";
const SHIPROCKET_TOKEN_FALLBACK_TTL_MS = 9 * 24 * 60 * 60 * 1000;
const SHIPROCKET_TOKEN_EXPIRY_SKEW_MS = 60 * 1000;
let shiprocketTokenCache = null;

class ShiprocketApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "ShiprocketApiError";
    this.status = status;
  }
}

function randomNumericReference() {
  const digits = new Uint8Array(6);
  crypto.getRandomValues(digits);
  return `${String(Date.now()).slice(-6)}${Array.from(digits, (digit) => digit % 10).join("")}`;
}

function getShiprocketDimensions(env) {
  const dimensions = {
    length: Number(env.SHIPROCKET_PARCEL_LENGTH),
    breadth: Number(env.SHIPROCKET_PARCEL_BREADTH),
    height: Number(env.SHIPROCKET_PARCEL_HEIGHT),
    weight: Number(env.SHIPROCKET_PARCEL_WEIGHT),
  };
  if (
    !sanitizeString(env.SHIPROCKET_PICKUP_LOCATION) ||
    Object.values(dimensions).some((value) => !Number.isFinite(value) || value <= 0)
  ) {
    throw new Error(
      "Configure the Shiprocket pickup location and positive parcel length, breadth, height, and weight before booking.",
    );
  }
  return dimensions;
}

async function getShiprocketToken(env, forceRefresh = false) {
  if (!sanitizeString(env.SHIPROCKET_EMAIL) || !sanitizeString(env.SHIPROCKET_PASSWORD)) {
    throw new Error("Shiprocket API credentials are not configured.");
  }
  if (forceRefresh) {
    shiprocketTokenCache = null;
    await env.SHIPROCKET_TOKEN_CACHE?.delete(SHIPROCKET_TOKEN_CACHE_KEY);
  } else {
    const now = Date.now();
    if (shiprocketTokenCache && shiprocketTokenCache.expiresAt > now) {
      return shiprocketTokenCache.token;
    }

    if (env.SHIPROCKET_TOKEN_CACHE) {
      const cachedValue = await env.SHIPROCKET_TOKEN_CACHE.get(SHIPROCKET_TOKEN_CACHE_KEY);
      if (cachedValue) {
        let cached;
        try {
          cached = JSON.parse(cachedValue);
        } catch {
          console.warn("Discarding malformed Shiprocket auth token from KV.");
          await env.SHIPROCKET_TOKEN_CACHE.delete(SHIPROCKET_TOKEN_CACHE_KEY);
        }
        if (
          typeof cached?.token === "string" &&
          Number.isFinite(cached.expiresAt) &&
          cached.expiresAt > now
        ) {
          shiprocketTokenCache = cached;
          return cached.token;
        }
        if (cached) await env.SHIPROCKET_TOKEN_CACHE.delete(SHIPROCKET_TOKEN_CACHE_KEY);
      }
    }
  }

  let response;
  try {
    response = await fetch(`${SHIPROCKET_API_BASE}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: env.SHIPROCKET_EMAIL,
        password: env.SHIPROCKET_PASSWORD,
      }),
    });
  } catch {
    throw new ShiprocketApiError("Could not connect to Shiprocket authentication.", 0);
  }

  const data = await response.json().catch(() => null);
  const token = sanitizeString(data?.token);
  if (!response.ok || !token) {
    throw new ShiprocketApiError(
      sanitizeString(data?.message) || "Shiprocket authentication failed.",
      response.status,
    );
  }

  let expiresAt = Date.now() + SHIPROCKET_TOKEN_FALLBACK_TTL_MS;
  try {
    const encodedClaims = token
      .split(".")[1]
      .replace(/-/g, "+")
      .replace(/_/g, "/");
    const claims = JSON.parse(
      atob(encodedClaims.padEnd(Math.ceil(encodedClaims.length / 4) * 4, "=")),
    );
    if (Number.isFinite(claims.exp)) {
      expiresAt = claims.exp * 1000 - SHIPROCKET_TOKEN_EXPIRY_SKEW_MS;
    }
  } catch {
    // Shiprocket documents a 240-hour token TTL; use a shorter fallback for opaque tokens.
  }
  if (expiresAt > Date.now()) {
    shiprocketTokenCache = { token, expiresAt };
    if (env.SHIPROCKET_TOKEN_CACHE) {
      const expirationTtl = Math.ceil((expiresAt - Date.now()) / 1000);
      await env.SHIPROCKET_TOKEN_CACHE.put(
        SHIPROCKET_TOKEN_CACHE_KEY,
        JSON.stringify(shiprocketTokenCache),
        { expirationTtl },
      );
    }
  }
  return token;
}

async function shiprocketRequest(env, path, body, method = "POST") {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await getShiprocketToken(env, attempt === 1);
    let response;
    try {
      response = await fetch(`${SHIPROCKET_API_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new ShiprocketApiError("Could not connect to Shiprocket.", 0);
    }

    const data = await response.json().catch(() => null);
    if (response.status === 401 && attempt === 0) continue;
    if (!response.ok) {
      const fieldErrors =
        data?.errors && typeof data.errors === "object"
          ? Object.entries(data.errors)
              .map(([field, messages]) =>
                `${field}: ${Array.isArray(messages) ? messages.join(", ") : String(messages)}`,
              )
              .join("; ")
          : "";
      throw new ShiprocketApiError(
        [
          sanitizeString(data?.message) || "Shiprocket rejected the shipment request.",
          fieldErrors,
        ]
          .filter(Boolean)
          .join(" — "),
        response.status,
      );
    }
    return data;
  }
  throw new ShiprocketApiError("Shiprocket authorization failed.", 401);
}

function getShipmentResult(data) {
  return data?.response?.data || data?.data || data || {};
}

function summarizeShiprocketCreateResponse(data) {
  if (data === null) return "Response was null or not valid JSON.";
  if (typeof data !== "object") return `Response JSON type: ${typeof data}.`;

  const topLevelKeys = Object.keys(data)
    .slice(0, 30)
    .map((key) => key.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40));
  const idFields = [];
  let visited = 0;

  const inspect = (value, path = "", depth = 0) => {
    if (!value || typeof value !== "object" || depth > 4 || visited >= 100) return;
    if (Array.isArray(value)) {
      value.slice(0, 5).forEach((item, index) => inspect(item, `${path}[${index}]`, depth + 1));
      return;
    }

    for (const [key, child] of Object.entries(value).slice(0, 30)) {
      visited += 1;
      const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
      const childPath = path ? `${path}.${safeKey}` : safeKey;
      if (/^(shipment[_-]?id|order[_-]?id|id)$/i.test(key)) {
        const usable =
          (typeof child === "string" && child.trim().length > 0) ||
          (typeof child === "number" && Number.isFinite(child) && child > 0);
        idFields.push(
          `${childPath}: ${usable ? "present" : "empty"} (${child === null ? "null" : typeof child})`,
        );
      }
      inspect(child, childPath, depth + 1);
      if (visited >= 100) break;
    }
  };
  inspect(data);

  const fields = topLevelKeys.length > 0 ? topLevelKeys.join(", ") : "(none)";
  const identifiers =
    idFields.length > 0 ? idFields.join("; ") : "no order/shipment ID fields found";
  return `Top-level fields: ${fields}. ID field paths: ${identifiers}. Values omitted.`;
}

function getShiprocketCreateError(data) {
  const message = sanitizeString(data?.message);
  if (
    message &&
    (data?.success === false ||
      Number(data?.status_code) >= 400 ||
      /wrong pickup location entered/i.test(message))
  ) {
    return message;
  }
  return "";
}

function mapCarrierStatus(status) {
  const normalized = sanitizeString(status).toLowerCase();
  if (!normalized) return { status: "tracking_update", orderStatus: null };
  if (/rto.*delivered|return to origin.*(received|delivered)/.test(normalized)) {
    return { status: "rto_received", orderStatus: null };
  }
  if (/rto|return to origin|returned to origin/.test(normalized)) {
    return { status: "rto_in_transit", orderStatus: null };
  }
  if (/delivered/.test(normalized)) return { status: "delivered", orderStatus: "delivered" };
  if (/picked.?up|in transit|out for delivery|shipped|manifest/.test(normalized)) {
    return { status: "in_transit", orderStatus: "shipped" };
  }
  if (/cancel/.test(normalized)) return { status: "cancelled", orderStatus: null };
  if (/ndr|delivery attempt|undelivered|exception/.test(normalized)) {
    return { status: "delivery_exception", orderStatus: null };
  }
  return { status: "tracking_update", orderStatus: null };
}

function parseCarrierTimestamp(value) {
  const timestamp = sanitizeString(value);
  if (!timestamp) return null;
  const match = timestamp.match(
    /^(\d{1,2})[ -](\d{1,2})[ -](\d{4})[ T](\d{2}):(\d{2}):(\d{2})$/,
  );
  if (match) {
    const [, day, month, year, hour, minute, second] = match;
    const calendarDate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (
      calendarDate.getUTCFullYear() !== Number(year) ||
      calendarDate.getUTCMonth() !== Number(month) - 1 ||
      calendarDate.getUTCDate() !== Number(day) ||
      Number(hour) > 23 ||
      Number(minute) > 59 ||
      Number(second) > 59
    ) {
      return null;
    }
    return new Date(
      Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute) - 330, Number(second)),
    ).toISOString();
  }
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function shipmentDto(row) {
  return {
    id: row.id,
    direction: row.direction,
    returnTransactionId: row.return_transaction_id || null,
    awb: row.awb || "",
    courier: row.courier_name || "",
    status: row.status,
    lastEvent: row.last_event || "",
    manifestUrl: row.manifest_url || "",
    error: row.error || "",
    manual: Boolean(row.manual),
    deliveredAt: row.delivered_at || null,
    updatedAt: row.updated_at,
  };
}

async function getOrderShipments(db, orderNumber) {
  const result = await db
    .prepare("SELECT * FROM order_shipments WHERE order_number = ? ORDER BY created_at")
    .bind(orderNumber)
    .all();
  return (result.results || []).map(shipmentDto);
}

function splitCustomerName(name) {
  const parts = sanitizeString(name).split(/\s+/).filter(Boolean);
  return {
    first: parts.shift() || "Customer",
    last: parts.join(" "),
  };
}

function requireReturnAddress(env) {
  const address = {
    name: sanitizeString(env.SHIPROCKET_RETURN_NAME),
    address: sanitizeString(env.SHIPROCKET_RETURN_ADDRESS),
    city: sanitizeString(env.SHIPROCKET_RETURN_CITY),
    state: sanitizeString(env.SHIPROCKET_RETURN_STATE),
    pincode: sanitizeString(env.SHIPROCKET_RETURN_PINCODE),
    phone: sanitizeString(env.SHIPROCKET_RETURN_PHONE),
    email: sanitizeString(env.SHIPROCKET_RETURN_EMAIL),
  };
  if (Object.values(address).some((value) => !value)) {
    throw new Error(
      "Configure the Shiprocket return address, contact phone, and email before booking a reverse pickup.",
    );
  }
  if (!/^\d{6}$/.test(address.pincode) || !/^\+?\d{10,15}$/.test(address.phone.replace(/[\s()-]/g, ""))) {
    throw new Error("The Shiprocket return address PIN code or phone number is invalid.");
  }
  return address;
}

function makeShiprocketOrderPayload(order, reference, env) {
  const dimensions = getShiprocketDimensions(env);
  const customerName = splitCustomerName(order.customer.name);
  const paidAmount = order.transactions
    .filter((transaction) => transaction.status === "paid" && transaction.amount > 0)
    .reduce((sum, transaction) => sum + transaction.amount, 0);
  const prepaid = paidAmount >= order.total;
  return {
    order_id: reference,
    order_date: new Date(order.placedAt).toISOString().slice(0, 10),
    pickup_location: sanitizeString(env.SHIPROCKET_PICKUP_LOCATION),
    comment: `Koorta order ${order.orderNumber}`,
    billing_customer_name: customerName.first,
    billing_last_name: customerName.last,
    billing_address: order.customer.address,
    billing_address_2: order.customer.postOffice || "",
    billing_isd_code: "91",
    billing_city: order.customer.city,
    billing_pincode: Number(order.customer.pincode),
    billing_state: order.customer.state,
    billing_country: "India",
    billing_email: order.customer.email || sanitizeString(env.SHIPROCKET_RETURN_EMAIL) || "admin@koorta.com",
    billing_phone: order.customer.phone.replace(/\D/g, "").slice(-10),
    shipping_is_billing: true,
    order_items: order.items.map((item) => ({
      name: item.name,
      sku: item.id,
      units: item.qty,
      selling_price: item.price,
      discount: 0,
      tax: 0,
    })),
    payment_method: prepaid ? "Prepaid" : "COD",
    shipping_charges: order.shipping,
    giftwrap_charges: 0,
    transaction_charges: 0,
    total_discount: order.discount,
    sub_total: order.subtotal,
    ...dimensions,
  };
}

function getOrderEmailContent(order, audience) {
  const isAdmin = audience === "admin";
  const itemRows = order.items
    .map(
      (item) => `
    <tr>
      <td style="padding:14px 12px;border-bottom:1px solid #eee8dc;">${escapeHtml(item.name)}<br><span style="color:#777;font-size:12px;">Size ${escapeHtml(item.size)}</span></td>
      <td style="padding:14px 12px;border-bottom:1px solid #eee8dc;text-align:center;">${item.qty}</td>
      <td style="padding:14px 12px;border-bottom:1px solid #eee8dc;text-align:right;">${formatCurrency(item.qty * item.price)}</td>
    </tr>`,
    )
    .join("");
  const address = [
    order.customer.address,
    `${order.customer.city}, ${order.customer.district}`,
    `${order.customer.state} ${order.customer.pincode}`,
    order.customer.postOffice,
  ]
    .map(escapeHtml)
    .join("<br>");
  const terms = `
    <h3 style="margin:24px 0 8px;color:#202947;font-size:14px;">A few helpful details</h3>
    <ul style="padding-left:20px;color:#625f58;font-size:13px;line-height:1.7;">
      <li>Every order is reviewed by our team and confirmed before dispatch; payment arrangements are confirmed with you.</li>
      <li>India delivery typically takes 2–4 working days to metros and 4–6 working days elsewhere.</li>
      <li>Eligible items may be returned within 15 days of delivery if unworn, unwashed, and with original tags. Reverse pickup and size exchanges are free; refunds are processed within 5 working days. Made-to-measure and altered items cannot be returned. Email admin@koorta.com to start a return.</li>
    </ul>
    <p style="font-size:12px;color:#777;">Full details: <a href="https://koorta.com/shipping" style="color:#202947;">Shipping</a> · <a href="https://koorta.com/returns" style="color:#202947;">Returns &amp; Exchanges</a></p>`;
  const customerDetails = isAdmin
    ? `<div style="margin-top:20px;padding:16px;border-radius:12px;background:#f8f6f0;">
        <h3 style="margin:0 0 8px;color:#202947;font-size:14px;">Customer &amp; delivery</h3>
        <p style="margin:0;color:#3d3b36;font-size:13px;line-height:1.7;">
          <strong>${escapeHtml(order.customer.name)}</strong><br>
          ${escapeHtml(order.customer.email || "No email provided")}<br>
          ${escapeHtml(order.customer.phone)}<br>${address}
          ${order.customer.notes ? `<br><strong>Note:</strong> ${escapeHtml(order.customer.notes)}` : ""}
        </p>
      </div>`
    : `<div style="margin-top:20px;padding:16px;border-radius:12px;background:#f8f6f0;">
        <h3 style="margin:0 0 8px;color:#202947;font-size:14px;">Delivering to</h3>
        <p style="margin:0;color:#3d3b36;font-size:13px;line-height:1.7;">
          <strong>${escapeHtml(order.customer.name)}</strong><br>${address}<br>${escapeHtml(order.customer.phone)}
        </p>
      </div>`;
  const textLines = [
    isAdmin
      ? `New order ${order.orderNumber}`
      : `Thank you, ${order.customer.name}! Your order is placed.`,
    `Order: ${order.orderNumber}`,
    `Placed: ${new Date(order.placedAt).toLocaleString("en-IN")}`,
    "",
    "ORDER DETAILS",
    ...order.items.map(
      (item) =>
        `${item.name} — Size ${item.size} × ${item.qty}: ${formatCurrency(item.qty * item.price)}`,
    ),
    "",
    `Subtotal: ${formatCurrency(order.subtotal)}`,
    ...(order.discount > 0
      ? [
          `Discount${order.promoCode ? ` (${order.promoCode})` : ""}: -${formatCurrency(order.discount)}`,
        ]
      : []),
    `Shipping: ${order.shipping === 0 ? "Free" : formatCurrency(order.shipping)}`,
    `Total: ${formatCurrency(order.total)}`,
    `Payment: ${order.payment === "upi" ? "UPI (confirmation pending)" : "Discuss & Pay"}`,
    "",
    isAdmin ? "CUSTOMER & DELIVERY" : "DELIVERY ADDRESS",
    order.customer.name,
    ...(isAdmin && order.customer.email ? [order.customer.email] : []),
    order.customer.phone,
    order.customer.address,
    `${order.customer.city}, ${order.customer.district}`,
    `${order.customer.state} ${order.customer.pincode}`,
    order.customer.postOffice,
    ...(order.customer.notes ? [`Note: ${order.customer.notes}`] : []),
    "",
    "TERMS & USEFUL INFORMATION",
    "Your order is reviewed and confirmed by our team before dispatch; payment arrangements are confirmed with you.",
    "India delivery typically takes 2–4 working days to metros and 4–6 working days elsewhere.",
    "Eligible items may be returned within 15 days of delivery if unworn, unwashed, and with original tags. Reverse pickup and size exchanges are free; refunds are processed within 5 working days. Made-to-measure and altered items cannot be returned. Email admin@koorta.com to start a return.",
    "Shipping: https://koorta.com/shipping",
    "Returns: https://koorta.com/returns",
  ];

  return {
    subject: isAdmin
      ? `New Koorta order ${order.orderNumber.replace(/[\r\n]+/g, " ")}`
      : `Your Koorta order is placed — ${order.orderNumber.replace(/[\r\n]+/g, " ")}`,
    text: textLines.join("\n"),
    html: `
      <div style="margin:0;background:#f5f2eb;padding:28px 12px;font-family:Arial,Helvetica,sans-serif;color:#292821;">
        <div style="max-width:620px;margin:0 auto;border-radius:18px;overflow:hidden;background:#fff;box-shadow:0 12px 36px rgba(32,41,71,.08);">
          <div style="padding:30px 28px;background:#202947;color:#fff;">
            <p style="margin:0 0 10px;color:#d6b978;font-size:11px;font-weight:bold;letter-spacing:3px;">KOORTA · HANDCRAFTED MENSWEAR</p>
            <h1 style="margin:0;font-family:Georgia,serif;font-size:27px;font-weight:normal;">${isAdmin ? "A new order has arrived" : `Thank you, ${escapeHtml(order.customer.name)}!`}</h1>
            <p style="margin:10px 0 0;color:#e3e4eb;font-size:14px;">${isAdmin ? "Order details for your team" : "Your order is placed and our team will review it before dispatch."}</p>
          </div>
          <div style="padding:24px 28px;">
            <div style="display:flex;justify-content:space-between;gap:12px;padding-bottom:16px;border-bottom:1px solid #eee8dc;">
              <div><span style="display:block;color:#777;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Order number</span><strong style="display:block;margin-top:5px;color:#202947;font-size:18px;">${escapeHtml(order.orderNumber)}</strong></div>
              <div style="text-align:right;"><span style="display:block;color:#777;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Placed</span><strong style="display:block;margin-top:5px;font-size:13px;">${escapeHtml(new Date(order.placedAt).toLocaleString("en-IN"))}</strong></div>
            </div>
            <table role="presentation" style="width:100%;margin-top:12px;border-collapse:collapse;font-size:13px;">
              <thead><tr style="color:#777;font-size:11px;text-transform:uppercase;letter-spacing:.7px;"><th style="padding:10px 12px;text-align:left;">Piece</th><th style="padding:10px 12px;">Qty</th><th style="padding:10px 12px;text-align:right;">Amount</th></tr></thead>
              <tbody>${itemRows}</tbody>
            </table>
            <div style="max-width:270px;margin:16px 0 0 auto;color:#625f58;font-size:13px;line-height:1.8;">
              <div style="display:flex;justify-content:space-between;"><span>Subtotal</span><span>${formatCurrency(order.subtotal)}</span></div>
              ${order.discount > 0 ? `<div style="display:flex;justify-content:space-between;"><span>Discount${order.promoCode ? ` (${escapeHtml(order.promoCode)})` : ""}</span><span>−${formatCurrency(order.discount)}</span></div>` : ""}
              <div style="display:flex;justify-content:space-between;"><span>Shipping</span><span>${order.shipping === 0 ? "Free" : formatCurrency(order.shipping)}</span></div>
              <div style="display:flex;justify-content:space-between;margin-top:8px;padding-top:8px;border-top:1px solid #eee8dc;color:#202947;font-size:16px;font-weight:bold;"><span>Total</span><span>${formatCurrency(order.total)}</span></div>
              <div style="margin-top:6px;text-align:right;font-size:12px;">Payment: ${order.payment === "upi" ? "UPI · confirmation pending" : "Discuss &amp; Pay"}</div>
            </div>
            ${customerDetails}
            ${terms}
            <p style="margin:24px 0 0;padding-top:18px;border-top:1px solid #eee8dc;color:#777;font-size:12px;line-height:1.6;">Questions? Reply to this email or contact <a href="mailto:admin@koorta.com" style="color:#202947;">admin@koorta.com</a>.<br>With care, <strong style="color:#202947;">Team Koorta</strong></p>
          </div>
        </div>
      </div>`,
  };
}

async function sendResendEmail(env, { to, subject, text, html, replyTo }) {
  if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not configured.");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL || "Koorta Orders <orders@koorta.com>",
      to: [to],
      subject,
      text,
      html,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `Resend request failed (${response.status}): ${sanitizeString(result?.message) || response.statusText}`,
    );
  }
}

async function sendOrderNotifications(order, env) {
  const recipients = [
    { role: "admin", email: "admin@koorta.com" },
    ...(order.customer.email ? [{ role: "customer", email: order.customer.email }] : []),
  ];
  const results = await Promise.all(
    recipients.map(async ({ role, email }) => {
      try {
        const content = getOrderEmailContent(order, role);
        await sendResendEmail(env, { to: email, ...content });
        return { role, status: "sent" };
      } catch (error) {
        console.error(`Order email delivery failed for ${role} (${order.orderNumber}):`, error);
        return { role, status: "failed" };
      }
    }),
  );
  return results;
}

async function sendOrderLifecycleNotifications(order, env, event, audience = "both") {
  const safeEvent = escapeHtml(event.title);
  const recipients = [
    ...(audience === "both" ? [{ role: "admin", email: "admin@koorta.com" }] : []),
    ...(order.customer.email ? [{ role: "customer", email: order.customer.email }] : []),
  ];
  const items = (event.items || []).map((item) => `${item.name} — Size ${item.size} × ${item.qty}`);
  const results = await Promise.all(
    recipients.map(async ({ role, email }) => {
      const text = [
        role === "admin" ? event.title : `Hello ${order.customer.name},`,
        event.message,
        `Order: ${order.orderNumber}`,
        ...(role === "admin"
          ? [
              `Customer: ${order.customer.name} (${order.customer.phone})`,
              ...(order.customer.email ? [`Email: ${order.customer.email}`] : []),
            ]
          : []),
        ...(event.amount !== undefined
          ? [`${event.amount < 0 ? "Refund" : "Amount"}: ${formatCurrency(Math.abs(event.amount))}`]
          : []),
        ...(event.reference ? [`Reference: ${event.reference}`] : []),
        ...(event.reason ? [`Reason: ${event.reason}`] : []),
        ...(items.length ? ["", "Items:", ...items] : []),
        "",
        `Original order total: ${formatCurrency(order.total)}`,
        "For help, contact admin@koorta.com.",
      ].join("\n");
      const html = `
      <div style="margin:0;background:#f5f2eb;padding:28px 12px;font-family:Arial,Helvetica,sans-serif;color:#292821;">
        <div style="max-width:620px;margin:0 auto;border-radius:18px;overflow:hidden;background:#fff;">
          <div style="padding:26px 28px;background:#202947;color:#fff;">
            <p style="margin:0 0 10px;color:#d6b978;font-size:11px;font-weight:bold;letter-spacing:3px;">KOORTA · ORDER UPDATE</p>
            <h1 style="margin:0;font-family:Georgia,serif;font-size:25px;font-weight:normal;">${safeEvent}</h1>
          </div>
          <div style="padding:24px 28px;font-size:14px;line-height:1.8;">
            <p>${escapeHtml(role === "admin" ? event.message : `Hello ${order.customer.name}, ${event.message}`)}</p>
            <p><strong>Order:</strong> ${escapeHtml(order.orderNumber)}</p>
            ${role === "admin" ? `<p><strong>Customer:</strong> ${escapeHtml(order.customer.name)} · ${escapeHtml(order.customer.phone)}${order.customer.email ? ` · ${escapeHtml(order.customer.email)}` : ""}</p>` : ""}
            ${event.amount !== undefined ? `<p><strong>${event.amount < 0 ? "Refund" : "Amount"}:</strong> ${formatCurrency(Math.abs(event.amount))}</p>` : ""}
            ${event.reference ? `<p><strong>Reference:</strong> ${escapeHtml(event.reference)}</p>` : ""}
            ${event.reason ? `<p><strong>Reason:</strong> ${escapeHtml(event.reason)}</p>` : ""}
            ${items.length ? `<p><strong>Items:</strong><br>${items.map(escapeHtml).join("<br>")}</p>` : ""}
            <p><strong>Original order total:</strong> ${formatCurrency(order.total)}</p>
            <p style="padding-top:16px;border-top:1px solid #eee8dc;color:#777;font-size:12px;">Questions? Contact <a href="mailto:admin@koorta.com" style="color:#202947;">admin@koorta.com</a>.<br>With care, <strong style="color:#202947;">Team Koorta</strong></p>
          </div>
        </div>
      </div>`;
      try {
        await sendResendEmail(env, {
          to: email,
          subject: `${event.title} — ${order.orderNumber.replace(/[\r\n]+/g, " ")}`,
          text,
          html,
        });
        return { role, status: "sent" };
      } catch (error) {
        console.error(
          `Order update email delivery failed for ${role} (${order.orderNumber}):`,
          error,
        );
        return { role, status: "failed" };
      }
    }),
  );
  return results;
}

function validateOrderPayload(payload) {
  if (!payload || typeof payload !== "object") return "Request body must be a JSON object.";

  const customer = payload.customer || {};
  if (!sanitizeString(customer.name)) return "Customer name is required.";
  const customerEmail = sanitizeString(customer.email);
  if (
    customerEmail &&
    (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(customerEmail) || customerEmail.length > 255)
  ) {
    return "Customer email must be a valid email address.";
  }
  if (!sanitizeString(customer.phone)) return "Customer phone is required.";
  if (!sanitizeString(customer.address)) return "Customer address is required.";
  if (!sanitizeString(customer.city)) return "Customer city is required.";
  if (!sanitizeString(customer.state)) return "Customer state is required.";
  if (!sanitizeString(customer.district)) return "Customer district is required.";
  if (!sanitizeString(customer.postOffice)) return "Customer post office is required.";
  if (!sanitizeString(customer.pincode)) return "Customer PIN code is required.";

  if (!Array.isArray(payload.items) || payload.items.length === 0)
    return "Order items are required.";
  for (const item of payload.items) {
    if (!sanitizeString(item.id)) return "Order item id is required.";
    if (!sanitizeString(item.name)) return "Order item name is required.";
    if (!sanitizeString(item.size)) return "Order item size is required.";
    if (!ensureNumber(item.qty) || item.qty <= 0)
      return "Order item quantity must be a positive integer.";
    if (!ensureNumber(item.price) || item.price < 0)
      return "Order item price must be a non-negative integer.";
  }

  const paymentMethod = sanitizeString(payload.payment);
  if (paymentMethod !== "upi" && paymentMethod !== "discuss")
    return 'Payment method must be either "upi" or "discuss".';

  if (ensureNumber(payload.subtotal) === null) return "Order subtotal is required.";
  if (ensureNumber(payload.discount) === null) return "Order discount is required.";
  if (ensureNumber(payload.shipping) === null) return "Order shipping is required.";
  if (ensureNumber(payload.total) === null) return "Order total is required.";

  return null;
}

function normalizeOrderPayload(payload) {
  const customer = payload.customer || {};
  return {
    orderNumber: sanitizeString(payload.orderNumber),
    placedAt: sanitizeString(payload.placedAt) || nowISOString(),
    customer: {
      name: sanitizeString(customer.name),
      email: sanitizeString(customer.email),
      phone: sanitizeString(customer.phone),
      address: sanitizeString(customer.address),
      city: sanitizeString(customer.city),
      state: sanitizeString(customer.state),
      district: sanitizeString(customer.district),
      postOffice: sanitizeString(customer.postOffice),
      pincode: sanitizeString(customer.pincode),
      notes: sanitizeString(customer.notes),
    },
    payment: sanitizeString(payload.payment),
    upiId: sanitizeString(payload.upiId),
    items: Array.isArray(payload.items)
      ? payload.items.map((item) => ({
          itemId: sanitizeString(item.id),
          name: sanitizeString(item.name),
          size: sanitizeString(item.size),
          qty: ensureNumber(item.qty),
          price: ensureNumber(item.price),
          image: sanitizeString(item.image),
        }))
      : [],
    subtotal: ensureNumber(payload.subtotal),
    discount: ensureNumber(payload.discount),
    promoCode: sanitizeString(payload.promoCode),
    shipping: ensureNumber(payload.shipping),
    total: ensureNumber(payload.total),
  };
}

const PROMO_RULES = {
  KOORTA10: {
    code: "KOORTA10",
    type: "pct",
    value: 10,
    label: "10% off your order",
    minSubtotal: 0,
    active: true,
  },
  FESTIVE15: {
    code: "FESTIVE15",
    type: "pct",
    value: 15,
    label: "15% festive discount",
    minSubtotal: 4000,
    active: true,
  },
  BULK30: {
    code: "BULK30",
    type: "pct",
    value: 30,
    label: "30% bulk order discount",
    minSubtotal: 12000,
    active: true,
  },
  FREESHIP: {
    code: "FREESHIP",
    type: "shipping",
    value: 0,
    label: "Free shipping",
    minSubtotal: 1999,
    active: true,
  },
};

function normalizePromoCode(code) {
  return typeof code === "string" ? code.trim().toUpperCase() : "";
}

function getPromoRule(code) {
  const normalized = normalizePromoCode(code);
  return normalized ? PROMO_RULES[normalized] || null : null;
}

function calculateDiscount(subtotal, promoCode) {
  const rule = getPromoRule(promoCode);
  if (!rule || !rule.active) return 0;
  if (subtotal < (rule.minSubtotal ?? 0)) return 0;

  if (rule.type === "pct") {
    return Math.round((subtotal * rule.value) / 100);
  }

  if (rule.type === "flat") {
    return Math.min(rule.value, subtotal);
  }

  return 0;
}

function calculateShipping(subtotal, promoCode) {
  const rule = getPromoRule(promoCode);
  if (rule && rule.type === "shipping" && subtotal >= (rule.minSubtotal ?? 0)) {
    return 0;
  }
  return subtotal > 0 && subtotal < 1999 ? 99 : 0;
}

function validatePromoRequest(code, subtotal) {
  const normalized = normalizePromoCode(code);
  if (!normalized) {
    const shipping = calculateShipping(Number(subtotal), "");
    return {
      valid: true,
      message: "No promo code applied.",
      rule: null,
      discount: 0,
      shipping,
      total: Math.max(0, Number(subtotal) + shipping),
    };
  }

  const rule = getPromoRule(normalized);
  if (!rule || !rule.active) {
    return { valid: false, message: "Invalid promo code." };
  }

  if (Number(subtotal) < (rule.minSubtotal ?? 0)) {
    return {
      valid: false,
      message: `Requires a subtotal of ₹${(rule.minSubtotal ?? 0).toLocaleString("en-IN")}.`,
    };
  }

  const discount = calculateDiscount(Number(subtotal), normalized);
  const shipping = calculateShipping(Number(subtotal), normalized);
  return {
    valid: true,
    message: `Applied — ${rule.label}.`,
    rule,
    discount,
    shipping,
    total: Math.max(0, Number(subtotal) - discount + shipping),
  };
}

function normalizeRoute(pathname) {
  const cleaned = String(pathname || "")
    .replace(/\/+/g, "/")
    .replace(/\/+$/, "");
  if (cleaned === "") return "/";
  return cleaned;
}

function getCorsHeaders(env, request, allowCredentials = false) {
  const origin = request?.headers.get("origin") || "";
  const allowedOrigins = String(env.ADMIN_UI_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const originAllowed = origin && allowedOrigins.includes(origin);
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Koorta-Db-Api-Key",
    Vary: "Origin",
  };
  if (originAllowed) {
    headers["Access-Control-Allow-Origin"] = origin;
    if (allowCredentials) headers["Access-Control-Allow-Credentials"] = "true";
  }
  return headers;
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

let accessJwksCache = { issuer: "", expiresAt: 0, keys: [] };

function hasCloudflareAccessConfig(env) {
  const issuer = String(env.ACCESS_ISSUER || "")
    .trim()
    .replace(/\/+$/, "");
  const audiences = String(env.ACCESS_AUD || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/i.test(issuer) && audiences.length > 0;
}

async function getAccessJwks(env, forceRefresh = false) {
  const issuer = String(env.ACCESS_ISSUER || "")
    .trim()
    .replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/i.test(issuer)) {
    throw new Error("ACCESS_ISSUER is not configured with a valid Cloudflare Access team URL.");
  }
  if (
    !forceRefresh &&
    accessJwksCache.issuer === issuer &&
    accessJwksCache.expiresAt > Date.now()
  ) {
    return accessJwksCache.keys;
  }

  const response = await fetch(`${issuer}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error(`Cloudflare Access JWKS request failed (${response.status}).`);
  const jwks = await response.json();
  if (!Array.isArray(jwks?.keys) || jwks.keys.length === 0)
    throw new Error("Cloudflare Access returned no signing keys.");
  accessJwksCache = { issuer, expiresAt: Date.now() + 10 * 60 * 1000, keys: jwks.keys };
  return accessJwksCache.keys;
}

async function verifyCloudflareAccess(request, env) {
  const token = request.headers.get("cf-access-jwt-assertion") || "";
  const audiences = String(env.ACCESS_AUD || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const issuer = String(env.ACCESS_ISSUER || "")
    .trim()
    .replace(/\/+$/, "");
  if (!token || !hasCloudflareAccessConfig(env)) return false;

  try {
    const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
    if (!encodedHeader || !encodedPayload || !encodedSignature) return false;
    const header = JSON.parse(new TextDecoder().decode(decodeBase64Url(encodedHeader)));
    const claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(encodedPayload)));
    const tokenAudiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const now = Math.floor(Date.now() / 1000);
    if (
      !["RS256", "ES256"].includes(header.alg) ||
      !header.kid ||
      claims.iss !== issuer ||
      !tokenAudiences.some((audience) => audiences.includes(audience)) ||
      !Number.isFinite(claims.exp) ||
      claims.exp <= now ||
      (Number.isFinite(claims.nbf) && claims.nbf > now)
    )
      return false;

    let jwk = (await getAccessJwks(env)).find((key) => key.kid === header.kid);
    if (!jwk) jwk = (await getAccessJwks(env, true)).find((key) => key.kid === header.kid);
    if (!jwk) return false;
    const rsa = header.alg === "RS256";
    const algorithm = rsa
      ? { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }
      : { name: "ECDSA", namedCurve: "P-256" };
    const key = await crypto.subtle.importKey("jwk", jwk, algorithm, false, ["verify"]);
    const signatureAlgorithm = rsa
      ? { name: "RSASSA-PKCS1-v1_5" }
      : { name: "ECDSA", hash: "SHA-256" };
    const verified = await crypto.subtle.verify(
      signatureAlgorithm,
      key,
      decodeBase64Url(encodedSignature),
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
    );
    if (!verified) return false;

    const email = String(claims.email || "")
      .trim()
      .toLowerCase();
    return email || false;
  } catch (error) {
    console.error("Cloudflare Access token validation failed:", error);
    return false;
  }
}

async function verifyTurnstile(request, token, env, expectedAction) {
  if (!env.TURNSTILE_SECRET_KEY) throw new Error("TURNSTILE_SECRET_KEY is not configured.");
  if (typeof token !== "string" || token.length < 1 || token.length > 2048) return false;

  const body = new URLSearchParams({
    secret: env.TURNSTILE_SECRET_KEY,
    response: token,
  });
  const remoteIp = request.headers.get("cf-connecting-ip");
  if (remoteIp) body.set("remoteip", remoteIp);

  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) throw new Error(`Turnstile verification request failed (${response.status}).`);
  const result = await response.json();
  if (!result.success || result.action !== expectedAction) return false;
  const allowedHostnames = String(env.TURNSTILE_HOSTNAMES || "")
    .split(",")
    .map((hostname) => hostname.trim().toLowerCase())
    .filter(Boolean);
  return (
    allowedHostnames.length === 0 ||
    allowedHostnames.includes(String(result.hostname || "").toLowerCase())
  );
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function parseTransactionMetadata(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function newTransactionId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function findCustomerOrder(db, orderNumber, phone) {
  const order = await db
    .prepare("SELECT * FROM orders WHERE order_number = ?")
    .bind(orderNumber)
    .first();
  const providedPhone = normalizePhone(phone);
  if (
    !order ||
    providedPhone.length !== 10 ||
    normalizePhone(order.customer_phone) !== providedPhone
  )
    return null;
  return order;
}

function isWithinReturnWindow(deliveredAt, now = Date.now()) {
  const delivered = Date.parse(deliveredAt || "");
  return (
    Number.isFinite(delivered) && now >= delivered && now <= delivered + 15 * 24 * 60 * 60 * 1000
  );
}

function requestedItemKey(itemId, size) {
  return `${itemId}\u0000${size}`;
}

function collectReservedReturnQuantities(transactions) {
  const reserved = new Map();
  const activeStatuses = new Set([
    "return_requested",
    "approved",
    "processing",
    "inventory_review_required",
    "refund_pending",
    "refunded",
  ]);
  for (const transaction of transactions) {
    const metadata = parseTransactionMetadata(transaction.metadata);
    if (metadata.type !== "return" || !activeStatuses.has(transaction.status)) continue;
    for (const item of Array.isArray(metadata.items) ? metadata.items : []) {
      const key = requestedItemKey(String(item.itemId), String(item.size));
      reserved.set(key, (reserved.get(key) || 0) + Number(item.qty || 0));
    }
  }
  return reserved;
}

async function getOrder(db, orderNumber) {
  const orderResult = await db
    .prepare("SELECT * FROM orders WHERE order_number = ?")
    .bind(orderNumber)
    .first();

  if (!orderResult) return null;

  const itemsResult = await db
    .prepare(
      "SELECT item_id, name, size, quantity, price, image_url FROM order_items WHERE order_number = ?",
    )
    .bind(orderNumber)
    .all();

  const transactionsResult = await db
    .prepare(
      "SELECT transaction_id, provider, method, status, amount, external_reference, metadata, created_at, updated_at FROM transactions WHERE order_number = ?",
    )
    .bind(orderNumber)
    .all();
  const shipments = await getOrderShipments(db, orderNumber);

  return {
    orderNumber: orderResult.order_number,
    placedAt: orderResult.placed_at,
    customer: {
      name: orderResult.customer_name,
      email: orderResult.customer_email,
      phone: orderResult.customer_phone,
      address: orderResult.customer_address,
      city: orderResult.customer_city,
      state: orderResult.customer_state,
      district: orderResult.customer_district,
      postOffice: orderResult.customer_post_office,
      pincode: orderResult.customer_pincode,
      notes: orderResult.customer_notes,
    },
    payment: orderResult.payment_method,
    upiId: orderResult.upi_id,
    promoCode: orderResult.promo_code,
    subtotal: orderResult.subtotal,
    discount: orderResult.discount,
    shipping: orderResult.shipping,
    total: orderResult.total,
    status: orderResult.status,
    deliveredAt: orderResult.delivered_at || null,
    shipments,
    items: (itemsResult?.results || []).map((item) => ({
      id: item.item_id,
      name: item.name,
      size: item.size,
      qty: item.quantity,
      price: item.price,
      image: item.image_url,
    })),
    transactions: (transactionsResult?.results || []).map((t) => ({
      transactionId: t.transaction_id,
      provider: t.provider,
      method: t.method,
      status: t.status,
      amount: t.amount,
      externalReference: t.external_reference,
      metadata: parseTransactionMetadata(t.metadata),
      createdAt: t.created_at,
      updatedAt: t.updated_at,
    })),
  };
}

async function saveShipment(db, shipmentId, updates) {
  const allowedColumns = new Set([
    "shiprocket_order_id",
    "shiprocket_shipment_id",
    "awb",
    "courier_name",
    "status",
    "last_event",
    "manifest_url",
    "error",
    "manual",
    "delivered_at",
  ]);
  const entries = Object.entries(updates).filter(([column]) => allowedColumns.has(column));
  if (entries.length === 0) return;
  const updatedAt = nowISOString();
  const assignments = entries.map(([column]) => `${column} = ?`);
  assignments.push("updated_at = ?");
  await db
    .prepare(`UPDATE order_shipments SET ${assignments.join(", ")} WHERE id = ?`)
    .bind(...entries.map(([, value]) => value), updatedAt, shipmentId)
    .run();
}

async function findShipment(db, orderNumber, direction, returnTransactionId = null) {
  const query =
    direction === "reverse"
      ? "SELECT * FROM order_shipments WHERE order_number = ? AND direction = 'reverse' AND return_transaction_id = ?"
      : "SELECT * FROM order_shipments WHERE order_number = ? AND direction = 'forward'";
  return db.prepare(query).bind(orderNumber, ...(direction === "reverse" ? [returnTransactionId] : [])).first();
}

async function createShipmentRecord(
  db,
  orderNumber,
  direction,
  returnTransactionId = null,
  allowedOrderStatuses = null,
  externalOrderReference = randomNumericReference(),
) {
  const id = crypto.randomUUID();
  const now = nowISOString();
  const statusGuard = Array.isArray(allowedOrderStatuses) && allowedOrderStatuses.length > 0;
  const result = await db
    .prepare(
      `INSERT INTO order_shipments (
        id, order_number, direction, return_transaction_id, external_order_reference,
        status, created_at, updated_at
      )
       ${statusGuard
         ? `SELECT ?, ?, ?, ?, ?, 'creating_order', ?, ?
            WHERE EXISTS (
              SELECT 1 FROM orders WHERE order_number = ?
                AND status IN (${allowedOrderStatuses.map(() => "?").join(",")})
            )`
         : "VALUES (?, ?, ?, ?, ?, 'creating_order', ?, ?)"} `,
    )
    .bind(
      id,
      orderNumber,
      direction,
      returnTransactionId,
      externalOrderReference,
      now,
      now,
      ...(statusGuard ? [orderNumber, ...allowedOrderStatuses] : []),
    )
    .run();
  if (Number(result.meta?.changes || 0) !== 1) {
    throw new Error("Order status changed before the shipment could be reserved.");
  }
  return findShipment(db, orderNumber, direction, returnTransactionId);
}

function getExternalIds(data) {
  const result = getShipmentResult(data);
  return {
    orderId: result.order_id === undefined ? "" : String(result.order_id),
    shipmentId: result.shipment_id === undefined ? "" : String(result.shipment_id),
  };
}

async function advanceShipmentBooking(db, env, order, initialShipment, isReturn, returnPayload) {
  let shipment = initialShipment;
  if (["booked", "delivered", "in_transit", "rto_in_transit", "delivery_exception"].includes(shipment.status)) {
    return shipmentDto(shipment);
  }
  if (shipment.status === "booking_uncertain" || shipment.status === "booking_failed") {
    throw new Error(
      "Shiprocket order creation did not complete cleanly. Check Shiprocket before retrying; you can use the manual tracking controls here.",
    );
  }

  const failBooking = async (error, creatingOrder = false) => {
    const status =
      creatingOrder &&
      error instanceof ShiprocketApiError &&
      (error.status === 0 || error.status >= 500)
        ? "booking_uncertain"
        : creatingOrder
          ? "booking_failed"
          : "booking_error";
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    const httpStatus =
      error instanceof ShiprocketApiError ? ` (HTTP ${error.status})` : "";
    console.error(
      `Shiprocket ${creatingOrder ? "order creation" : "shipment booking"} failed for ${order.orderNumber}${httpStatus}: ${message}`,
    );
    await saveShipment(db, shipment.id, { status, error: message });
    throw new Error(message);
  };

  if (!shipment.shiprocket_shipment_id) {
    if (shipment.status !== "creating_order") {
      throw new Error(
        "The Shiprocket order could not be resumed safely. Check Shiprocket and use the manual tracking controls.",
      );
    }
    const claim = await db
      .prepare(
        `UPDATE order_shipments SET status = 'order_creation_in_progress', updated_at = ?
         WHERE id = ? AND status = 'creating_order'`,
      )
      .bind(nowISOString(), shipment.id)
      .run();
    if (Number(claim.meta?.changes || 0) !== 1) {
      throw new Error("Shipment booking is already in progress or requires manual review.");
    }
    let created;
    try {
      const path = isReturn ? "/orders/create/return" : "/orders/create/adhoc";
      created = await shiprocketRequest(env, path, returnPayload);
    } catch (error) {
      return failBooking(error, true);
    }
    const ids = getExternalIds(created);
    if (!ids.shipmentId) {
      const diagnostic = summarizeShiprocketCreateResponse(created);
      const carrierError = getShiprocketCreateError(created);
      const message = carrierError || `Shiprocket returned no usable shipment ID. ${diagnostic}`;
      const status = carrierError ? "booking_failed" : "booking_uncertain";
      console.error(
        `Shiprocket order creation failed for ${order.orderNumber}: ${message}. ${diagnostic}`,
      );
      await saveShipment(db, shipment.id, {
        shiprocket_order_id: ids.orderId || null,
        status,
        error: message,
      });
      throw new Error(message);
    }
    await saveShipment(db, shipment.id, {
      shiprocket_order_id: ids.orderId || null,
      shiprocket_shipment_id: ids.shipmentId,
      status: "order_created",
      error: null,
    });
    shipment = await findShipment(db, order.orderNumber, isReturn ? "reverse" : "forward", shipment.return_transaction_id);
  }

  if (!shipment.awb) {
    try {
      const awbData = await shiprocketRequest(env, "/courier/assign/awb", {
        shipment_id: Number(shipment.shiprocket_shipment_id),
        ...(isReturn ? { is_return: 1 } : {}),
      });
      const result = getShipmentResult(awbData);
      const awb = sanitizeString(result.awb_code);
      if (!awb) throw new Error("Shiprocket did not return an AWB.");
      await saveShipment(db, shipment.id, {
        awb,
        courier_name: sanitizeString(result.courier_name),
        status: "awb_assigned",
        error: null,
      });
      shipment = await findShipment(db, order.orderNumber, isReturn ? "reverse" : "forward", shipment.return_transaction_id);
    } catch (error) {
      return failBooking(error);
    }
  }

  if (!["pickup_requested", "booked"].includes(shipment.status)) {
    try {
      await shiprocketRequest(env, "/courier/generate/pickup", {
        shipment_id: [Number(shipment.shiprocket_shipment_id)],
      });
      await saveShipment(db, shipment.id, { status: "pickup_requested", error: null });
      shipment = await findShipment(db, order.orderNumber, isReturn ? "reverse" : "forward", shipment.return_transaction_id);
    } catch (error) {
      return failBooking(error);
    }
  }

  if (!shipment.manifest_url) {
    try {
      const manifest = await shiprocketRequest(env, "/manifests/generate", {
        shipment_id: [Number(shipment.shiprocket_shipment_id)],
      });
      await saveShipment(db, shipment.id, {
        manifest_url: sanitizeString(manifest?.manifest_url) || null,
        status: "booked",
        error: null,
      });
    } catch (error) {
      return failBooking(error);
    }
  }

  return shipmentDto(await findShipment(db, order.orderNumber, isReturn ? "reverse" : "forward", shipment.return_transaction_id));
}

function makeShiprocketReturnPayload(order, shipment, transactionId, env) {
  const returnAddress = requireReturnAddress(env);
  const dimensions = getShiprocketDimensions(env);
  const transaction = order.transactions.find((item) => item.transactionId === transactionId);
  if (!transaction || transaction.status !== "approved" || transaction.metadata?.type !== "return") {
    throw new Error("Only an approved customer return can be booked for reverse pickup.");
  }
  const selectedItems = Array.isArray(transaction.metadata.items) ? transaction.metadata.items : [];
  const items = selectedItems.map((selection) => {
    const item = order.items.find(
      (candidate) =>
        String(candidate.id) === String(selection.itemId) &&
        candidate.size === String(selection.size),
    );
    if (!item || !Number.isInteger(Number(selection.qty)) || Number(selection.qty) <= 0) {
      throw new Error("The approved return contains an invalid item selection.");
    }
    return {
      sku: item.id,
      name: `${item.name} - ${item.size}`,
      units: Number(selection.qty),
      selling_price: item.price,
      discount: 0,
      qc_enable: true,
      hsn: "",
      brand: "Koorta",
      qc_size: item.size,
    };
  });
  if (items.length === 0) throw new Error("The approved return has no items to collect.");
  const customerName = splitCustomerName(order.customer.name);
  const returnPhone = returnAddress.phone.replace(/\D/g, "").slice(-10);
  const pickupEmail =
    order.customer.email || sanitizeString(env.SHIPROCKET_RETURN_PICKUP_EMAIL) || returnAddress.email;
  const itemSubtotal = order.items.reduce((sum, item) => {
    const selection = selectedItems.find(
      (candidate) =>
        String(candidate.itemId) === String(item.id) && String(candidate.size) === item.size,
    );
    return sum + (selection ? item.price * Number(selection.qty) : 0);
  }, 0);
  return {
    order_id: shipment.external_order_reference,
    order_date: new Date().toISOString().slice(0, 10),
    pickup_customer_name: customerName.first,
    pickup_last_name: customerName.last,
    pickup_address: order.customer.address,
    pickup_address_2: order.customer.postOffice || "",
    pickup_city: order.customer.city,
    pickup_state: order.customer.state,
    pickup_country: "India",
    pickup_pincode: Number(order.customer.pincode),
    pickup_email: pickupEmail,
    pickup_phone: order.customer.phone.replace(/\D/g, "").slice(-10),
    pickup_isd_code: "91",
    shipping_customer_name: returnAddress.name,
    shipping_address: returnAddress.address,
    shipping_address_2: "",
    shipping_city: returnAddress.city,
    shipping_country: "India",
    shipping_pincode: Number(returnAddress.pincode),
    shipping_state: returnAddress.state,
    shipping_email: returnAddress.email,
    shipping_isd_code: "91",
    shipping_phone: returnPhone,
    order_items: items,
    payment_method: "PREPAID",
    total_discount: 0,
    sub_total: itemSubtotal,
    ...dimensions,
  };
}

function secretsMatch(provided, expected) {
  const providedBytes = new TextEncoder().encode(String(provided || ""));
  const expectedBytes = new TextEncoder().encode(String(expected || ""));
  if (!expectedBytes.length || providedBytes.length !== expectedBytes.length) return false;
  let mismatch = 0;
  for (let index = 0; index < expectedBytes.length; index += 1) {
    mismatch |= providedBytes[index] ^ expectedBytes[index];
  }
  return mismatch === 0;
}

async function applyCarrierWebhook(db, payload) {
  console.log("Received carrier webhook:", JSON.stringify(payload, null, 2));
  const awb = sanitizeString(payload.awb || payload.awb_code);
  const shipmentId = sanitizeString(payload.shipment_id);
  const orderId = sanitizeString(payload.order_id);
  if (!awb && !shipmentId && !orderId) {
    throw new Error("Carrier tracking event has no AWB, shipment ID, or order ID.");
  }
  const shipment = await db
    .prepare(
      `SELECT * FROM order_shipments
       WHERE (? <> '' AND awb = ? AND (? = '' OR shiprocket_shipment_id = ?))
          OR (? = '' AND ? <> '' AND shiprocket_shipment_id = ?)
          OR (? = '' AND ? = '' AND ? <> '' AND shiprocket_order_id = ?)
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(
      awb,
      awb,
      shipmentId,
      shipmentId,
      awb,
      shipmentId,
      shipmentId,
      awb,
      shipmentId,
      orderId,
      orderId,
    )
    .first();
  if (!shipment) return false;

  const carrierStatus = sanitizeString(payload.current_status || payload.shipment_status || payload.status);
  const mapped = mapCarrierStatus(carrierStatus);
  const eventTime = sanitizeString(payload.current_timestamp || payload.updated_at);
  const location = sanitizeString(payload.destination || payload.location);
  const lastEvent = [carrierStatus, location, eventTime].filter(Boolean).join(" · ").slice(0, 500);
  const keepTerminalStatus =
    (shipment.status === "cancelled" && mapped.status !== "cancelled") ||
    (shipment.status === "rto_received" && mapped.status !== "rto_received") ||
    (shipment.status === "delivered" &&
      !["delivered", "rto_in_transit", "rto_received"].includes(mapped.status));
  const nextShipmentStatus = keepTerminalStatus ? shipment.status : mapped.status;
  const deliveredAt =
    nextShipmentStatus === "delivered"
      ? shipment.delivered_at ||
        parseCarrierTimestamp(eventTime) ||
        nowISOString()
      : shipment.delivered_at || null;
  await saveShipment(db, shipment.id, {
    awb: awb || shipment.awb,
    courier_name: sanitizeString(payload.courier_name) || shipment.courier_name,
    status: nextShipmentStatus,
    last_event: lastEvent || carrierStatus || "Tracking update received",
    delivered_at: deliveredAt,
    error: null,
  });

  if (shipment.direction === "forward" && !keepTerminalStatus && mapped.orderStatus) {
    const nextStatus = mapped.orderStatus;
    await db
      .prepare(
        `UPDATE orders
         SET status = ?, delivered_at = CASE WHEN ? = 'delivered' THEN COALESCE(delivered_at, ?) ELSE delivered_at END,
             updated_at = ?
         WHERE order_number = ? AND status IN (${nextStatus === "delivered" ? "'confirmed', 'shipped'" : "'confirmed'"})`,
      )
      .bind(nextStatus, nextStatus, deliveredAt, nowISOString(), shipment.order_number)
      .run();
  }
  return true;
}

async function readCatalog(bucket) {
  if (!bucket || typeof bucket.get !== "function") return [];

  const object = await bucket.get("product.json");
  if (!object) return [];

  const content = await object.text();
  if (!content) return [];

  try {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeCatalog(bucket, products) {
  if (!bucket || typeof bucket.put !== "function") return products;
  await bucket.put("product.json", JSON.stringify(products, null, 2), {
    cacheControl: "public, max-age=31536000, immutable",
  });
  return products;
}

async function updateCatalogStockForOrder(bucket, orderItems) {
  if (!bucket || typeof bucket.get !== "function") {
    throw new Error("Catalog bucket is not configured for stock updates.");
  }

  const catalog = await readCatalog(bucket);
  if (!Array.isArray(catalog) || catalog.length === 0) {
    throw new Error("Catalog is empty; stock cannot be decremented.");
  }

  const catalogById = new Map(catalog.map((product) => [String(product.id), product]));
  const productUpdates = new Map();

  for (const item of orderItems) {
    const productId = String(item.itemId || item.id || "").trim();
    const sizeKey = String(item.size || "").trim();
    const requestedQty = ensureNumber(item.qty);

    if (!productId || !sizeKey || !requestedQty || requestedQty <= 0) {
      continue;
    }

    const product = catalogById.get(productId);
    if (!product) {
      throw new Error(`Product ${productId} was not found in the catalog.`);
    }

    const sizes = Array.isArray(product.sizes) ? product.sizes.map((size) => String(size)) : [];
    if (sizes.length > 0 && !sizes.includes(sizeKey)) {
      throw new Error(`Product ${product.name || productId} does not offer size ${sizeKey}.`);
    }

    const stockBySize =
      product.stockBySize &&
      typeof product.stockBySize === "object" &&
      !Array.isArray(product.stockBySize)
        ? { ...product.stockBySize }
        : {};
    const available = Number(stockBySize[sizeKey]);

    if (!Number.isFinite(available) || available < requestedQty) {
      throw new Error(
        `Insufficient stock for ${product.name || productId} in size ${sizeKey}. Available: ${Number.isFinite(available) ? available : 0}, requested: ${requestedQty}.`,
      );
    }

    const updatedProduct = productUpdates.get(productId) || structuredClone(product);
    const nextStockBySize =
      updatedProduct.stockBySize &&
      typeof updatedProduct.stockBySize === "object" &&
      !Array.isArray(updatedProduct.stockBySize)
        ? { ...updatedProduct.stockBySize }
        : {};
    const nextAvailable = Number(nextStockBySize[sizeKey] ?? stockBySize[sizeKey] ?? 0);

    if (!Number.isFinite(nextAvailable) || nextAvailable < requestedQty) {
      throw new Error(
        `Insufficient stock for ${updatedProduct.name || productId} in size ${sizeKey}. Available: ${Number.isFinite(nextAvailable) ? nextAvailable : 0}, requested: ${requestedQty}.`,
      );
    }

    nextStockBySize[sizeKey] = Math.max(0, nextAvailable - requestedQty);
    updatedProduct.stockBySize = nextStockBySize;
    productUpdates.set(productId, updatedProduct);
  }

  if (productUpdates.size === 0) {
    return;
  }

  const updatedCatalog = catalog.map((product) => {
    const id = String(product.id);
    const updatedProduct = productUpdates.get(id);
    return updatedProduct || product;
  });

  await writeCatalog(bucket, updatedCatalog);
}

async function restoreCatalogStockForOrder(bucket, orderItems, adjustmentId) {
  if (!bucket || typeof bucket.get !== "function") {
    throw new Error("Catalog bucket is not configured for stock restoration.");
  }
  if (!adjustmentId) throw new Error("Stock restoration requires an adjustment ID.");

  const catalog = await readCatalog(bucket);
  if (!Array.isArray(catalog) || catalog.length === 0) {
    throw new Error("Catalog is empty; stock cannot be restored.");
  }

  const itemsByProduct = new Map();
  for (const item of orderItems) {
    const productId = String(item.itemId || item.id || "").trim();
    const size = String(item.size || "").trim();
    const qty = ensureNumber(item.qty);
    if (!productId || !size || !qty || qty <= 0) {
      throw new Error("Stock restoration contains an invalid order item.");
    }
    const items = itemsByProduct.get(productId) || [];
    items.push({ size, qty });
    itemsByProduct.set(productId, items);
  }

  const catalogById = new Map(catalog.map((product) => [String(product.id), product]));
  const productUpdates = new Map();
  for (const [productId, items] of itemsByProduct) {
    const product = catalogById.get(productId);
    if (!product) throw new Error(`Product ${productId} was not found in the catalog.`);
    const appliedIds = Array.isArray(product.inventoryAdjustmentIds)
      ? product.inventoryAdjustmentIds.map(String)
      : [];
    if (appliedIds.includes(adjustmentId)) continue;

    const updatedProduct = structuredClone(product);
    const stockBySize =
      updatedProduct.stockBySize &&
      typeof updatedProduct.stockBySize === "object" &&
      !Array.isArray(updatedProduct.stockBySize)
        ? { ...updatedProduct.stockBySize }
        : {};
    for (const item of items) {
      const current = Number(stockBySize[item.size]);
      if (!Number.isFinite(current) || current < 0) {
        throw new Error(`Stock for ${product.name || productId} in size ${item.size} is invalid.`);
      }
      stockBySize[item.size] = current + item.qty;
    }
    updatedProduct.stockBySize = stockBySize;
    updatedProduct.inventoryAdjustmentIds = [...appliedIds, adjustmentId];
    productUpdates.set(productId, updatedProduct);
  }

  if (productUpdates.size === 0) return;
  const updatedCatalog = catalog.map(
    (product) => productUpdates.get(String(product.id)) || product,
  );
  await writeCatalog(bucket, updatedCatalog);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const route = normalizeRoute(url.pathname);
    const adminEndpoint =
      route.startsWith("/admin/") || (route.startsWith("/orders") && method !== "POST");
    const corsHeaders = getCorsHeaders(env, request, adminEndpoint);
    let adminIdentity = "";

    try {
      if (method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            ...corsHeaders,
            "Access-Control-Max-Age": "86400",
          },
        });
      }

      if (adminEndpoint) {
        if (!hasCloudflareAccessConfig(env)) {
          return buildError("Cloudflare Access authorization is not configured.", 503, corsHeaders);
        }
        adminIdentity = await verifyCloudflareAccess(request, env);
        if (!adminIdentity) {
          return buildError("Cloudflare Access authentication is required.", 401, corsHeaders);
        }
      }

      if (!env.KOORTA_DB && route !== "/contact" && route !== "/wholesale-enquiry") {
        return buildError("D1 binding KOORTA_DB is not configured.", 500, corsHeaders);
      }

      if (route === "/webhooks/carrier-events") {
        if (method !== "POST") {
          return buildError("Method not allowed.", 405, corsHeaders);
        }
        if (!sanitizeString(env.SHIPROCKET_WEBHOOK_SECRET)) {
          return buildError("Carrier webhook authentication is not configured.", 503);
        }
        if (
          !secretsMatch(
            request.headers.get("x-api-key"),
            env.SHIPROCKET_WEBHOOK_SECRET,
          )
        ) {
          return buildError("Unauthorized carrier webhook.", 401);
        }
        const payload = await parseJson(request);
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          return buildError("Carrier webhook body must be a JSON object.", 400);
        }
        const matched = await applyCarrierWebhook(env.KOORTA_DB, payload);
        if (!matched) {
          const carrierStatus = sanitizeString(
            payload.current_status || payload.shipment_status || payload.status,
          );
          console.warn(
            `Carrier webhook did not match a shipment (status: ${carrierStatus || "unknown"}).`,
          );
        }
        return jsonResponse({ success: true, matched }, 200);
      }

      if (route === "/wholesale-enquiry" && !env.GARMENT_BUCKET) {
        return buildError("Catalog bucket GARMENT_BUCKET is not configured.", 500, corsHeaders);
      }

      if (route.startsWith("/orders") && !env.GARMENT_BUCKET) {
        return buildError(
          "Catalog bucket GARMENT_BUCKET is not configured for stock updates.",
          500,
          corsHeaders,
        );
      }

      if (route === "/") {
        return jsonResponse(
          { success: true, message: "Koorta DB API is running." },
          200,
          corsHeaders,
        );
      }

      if (route === "/promo/validate") {
        if (method !== "POST") {
          return buildError("Method not allowed.", 405, corsHeaders);
        }

        const apiKey = request.headers.get("x-koorta-db-api-key") || "";
        if (!env.KOORTA_DB_WORKER_API_SECRET || apiKey !== env.KOORTA_DB_WORKER_API_SECRET) {
          return buildError("Unauthorized request.", 401, corsHeaders);
        }

        const payload = await parseJson(request);
        if (!payload || typeof payload !== "object") {
          return buildError("Request body must be a JSON object.", 400, corsHeaders);
        }

        const subtotal = ensureNumber(payload.subtotal);
        if (subtotal === null) {
          return buildError("Order subtotal is required.", 400, corsHeaders);
        }

        const validation = validatePromoRequest(payload.code, subtotal);
        return jsonResponse(validation, 200, corsHeaders);
      }

      if (route === "/contact") {
        if (method !== "POST") {
          return buildError("Method not allowed.", 405, corsHeaders);
        }

        const apiKey = request.headers.get("x-koorta-db-api-key") || "";
        if (!env.KOORTA_DB_WORKER_API_SECRET || apiKey !== env.KOORTA_DB_WORKER_API_SECRET) {
          return buildError("Unauthorized request.", 401, corsHeaders);
        }

        const payload = await parseJson(request);
        if (!payload || typeof payload !== "object") {
          return buildError("Request body must be a JSON object.", 400, corsHeaders);
        }

        const name = sanitizeString(payload.name);
        const email = sanitizeString(payload.email);
        const message = sanitizeString(payload.message);
        if (!name || name.length > 100) {
          return buildError(
            "Name is required and must be 100 characters or fewer.",
            400,
            corsHeaders,
          );
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 255) {
          return buildError("Enter a valid email address.", 400, corsHeaders);
        }
        if (!message || message.length > 5000) {
          return buildError(
            "Message is required and must be 5000 characters or fewer.",
            400,
            corsHeaders,
          );
        }

        const safeName = name.replace(/[\r\n]+/g, " ");
        const safeEmail = email.replace(/[\r\n]+/g, "");
        const safeMessage = escapeHtml(message).replace(/\r?\n/g, "<br>");
        const subject = `Website enquiry from ${safeName}`;
        const text = `New contact enquiry from koorta.com\n\nName: ${name}\nEmail: ${email}\n\nMessage:\n${message}`;
        const html = `
          <div style="margin:0;background:#f5f2eb;padding:28px 12px;font-family:Arial,Helvetica,sans-serif;color:#292821;">
            <div style="max-width:620px;margin:0 auto;border-radius:18px;overflow:hidden;background:#fff;box-shadow:0 12px 36px rgba(32,41,71,.08);">
              <div style="padding:26px 28px;background:#202947;color:#fff;">
                <p style="margin:0 0 10px;color:#d6b978;font-size:11px;font-weight:bold;letter-spacing:3px;">KOORTA · WEBSITE ENQUIRY</p>
                <h1 style="margin:0;font-family:Georgia,serif;font-size:26px;font-weight:normal;">A customer has reached out</h1>
              </div>
              <div style="padding:24px 28px;">
                <p style="margin:0;color:#625f58;font-size:13px;line-height:1.7;">You have received a new enquiry through the contact page.</p>
                <div style="margin-top:18px;padding:16px;border-radius:12px;background:#f8f6f0;font-size:14px;line-height:1.8;">
                  <strong style="color:#202947;">${escapeHtml(name)}</strong><br>
                  <a href="mailto:${escapeHtml(safeEmail)}" style="color:#202947;">${escapeHtml(email)}</a>
                </div>
                <div style="margin-top:18px;padding:18px;border:1px solid #eee8dc;border-radius:12px;font-size:14px;line-height:1.8;">${safeMessage}</div>
              </div>
            </div>
          </div>`;

        try {
          await sendResendEmail(env, {
            to: "admin@koorta.com",
            replyTo: safeEmail,
            subject,
            text,
            html,
          });
        } catch (error) {
          console.error("Contact enquiry email delivery failed:", error);
          return buildError(
            "Unable to send your message right now. Please try again later.",
            502,
            corsHeaders,
          );
        }

        return jsonResponse({ success: true }, 200, corsHeaders);
      }

      if (route === "/wholesale-enquiry") {
        if (method !== "POST") {
          return buildError("Method not allowed.", 405, corsHeaders);
        }

        const apiKey = request.headers.get("x-koorta-db-api-key") || "";
        if (!env.KOORTA_DB_WORKER_API_SECRET || apiKey !== env.KOORTA_DB_WORKER_API_SECRET) {
          return buildError("Unauthorized request.", 401, corsHeaders);
        }

        const payload = await parseJson(request);
        if (!payload || typeof payload !== "object") {
          return buildError("Request body must be a JSON object.", 400, corsHeaders);
        }

        const businessName = sanitizeString(payload.businessName);
        const contactName = sanitizeString(payload.contactName);
        const email = sanitizeString(payload.email);
        const phone = sanitizeString(payload.phone);
        const category = sanitizeString(payload.category);
        const deliveryDate = sanitizeString(payload.deliveryDate);
        const notes = sanitizeString(payload.notes);
        if (!businessName || businessName.length > 150) {
          return buildError(
            "Business name is required and must be 150 characters or fewer.",
            400,
            corsHeaders,
          );
        }
        if (!contactName || contactName.length > 100) {
          return buildError(
            "Contact name is required and must be 100 characters or fewer.",
            400,
            corsHeaders,
          );
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 255) {
          return buildError("Enter a valid email address.", 400, corsHeaders);
        }
        if (!phone || phone.length > 30) {
          return buildError(
            "Phone number is required and must be 30 characters or fewer.",
            400,
            corsHeaders,
          );
        }
        if (!category || category.length > 80) {
          return buildError("Category of interest is required.", 400, corsHeaders);
        }
        const parsedDeliveryDate = new Date(`${deliveryDate}T00:00:00Z`);
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate) ||
          !Number.isFinite(parsedDeliveryDate.getTime()) ||
          parsedDeliveryDate.toISOString().slice(0, 10) !== deliveryDate
        ) {
          return buildError("Enter a valid expected delivery date.", 400, corsHeaders);
        }
        const earliestDate = new Date();
        earliestDate.setUTCHours(0, 0, 0, 0);
        earliestDate.setUTCDate(earliestDate.getUTCDate() + 7);
        if (deliveryDate < earliestDate.toISOString().slice(0, 10)) {
          return buildError(
            "Expected delivery date must be at least 7 days from today.",
            400,
            corsHeaders,
          );
        }
        if (notes.length > 2000) {
          return buildError("Notes must be 2000 characters or fewer.", 400, corsHeaders);
        }
        if (
          !Array.isArray(payload.products) ||
          payload.products.length === 0 ||
          payload.products.length > 100
        ) {
          return buildError("Select between 1 and 100 products for the enquiry.", 400, corsHeaders);
        }

        const catalog = await readCatalog(env.GARMENT_BUCKET);
        const catalogById = new Map(catalog.map((product) => [String(product.id), product]));
        const enquiryProducts = [];
        const seenProductIds = new Set();
        for (const requestedProduct of payload.products) {
          const id = sanitizeString(requestedProduct?.id);
          const quantity = Number(requestedProduct?.quantity);
          if (!id || seenProductIds.has(id)) {
            return buildError(
              "Each selected product must have a unique catalog ID.",
              400,
              corsHeaders,
            );
          }
          if (!Number.isInteger(quantity) || quantity < 10 || quantity > 9999) {
            return buildError(
              "Each selected product quantity must be a whole number between 10 and 9999.",
              400,
              corsHeaders,
            );
          }
          const product = catalogById.get(id);
          if (!product) {
            return buildError(
              `Product ${id} is no longer in the live catalog. Please reload the page and try again.`,
              400,
              corsHeaders,
            );
          }
          const unitPrice = Number(product.price);
          if (!Number.isFinite(unitPrice) || unitPrice < 0) {
            return buildError(`Product ${id} has an invalid catalog price.`, 500, corsHeaders);
          }
          seenProductIds.add(id);
          enquiryProducts.push({
            id,
            name: sanitizeString(product.name),
            category: sanitizeString(product.category),
            quantity,
            unitPrice,
            sizes: Array.isArray(product.sizes)
              ? product.sizes.map((size) => sanitizeString(size)).filter(Boolean)
              : [],
          });
        }

        const totalQuantity = enquiryProducts.reduce(
          (total, product) => total + product.quantity,
          0,
        );
        const estimatedValue = enquiryProducts.reduce(
          (total, product) => total + product.quantity * product.unitPrice,
          0,
        );
        const safeBusinessName = businessName.replace(/[\r\n]+/g, " ");
        const safeContactName = contactName.replace(/[\r\n]+/g, " ");
        const safeEmail = email.replace(/[\r\n]+/g, "");
        const productsText = enquiryProducts.map(
          (product) =>
            `- ${product.name} (${product.category}) [${product.id}] — Qty: ${product.quantity}; Unit price: ${formatCurrency(product.unitPrice)}; Indicative line value: ${formatCurrency(product.quantity * product.unitPrice)}; Sizes: ${product.sizes.join(", ") || "Not specified"}`,
        );
        const productsHtml = enquiryProducts
          .map(
            (product) => `
          <tr>
            <td style="padding:12px;border-bottom:1px solid #eee8dc;">${escapeHtml(product.name)}<br><span style="font-size:12px;color:#777;">${escapeHtml(product.category)} · ${escapeHtml(product.id)}<br>Sizes: ${escapeHtml(product.sizes.join(", ") || "Not specified")}</span></td>
            <td style="padding:12px;border-bottom:1px solid #eee8dc;text-align:center;">${product.quantity}</td>
            <td style="padding:12px;border-bottom:1px solid #eee8dc;text-align:right;">${formatCurrency(product.unitPrice)}</td>
            <td style="padding:12px;border-bottom:1px solid #eee8dc;text-align:right;">${formatCurrency(product.quantity * product.unitPrice)}</td>
          </tr>`,
          )
          .join("");
        const subject = `Wholesale enquiry from ${safeBusinessName}`;
        const text = [
          "New wholesale enquiry from koorta.com",
          "",
          `Business / Buyer: ${businessName}`,
          `Contact person: ${contactName}`,
          `Email: ${email}`,
          `Phone: ${phone}`,
          `Category of interest: ${category}`,
          `Expected delivery date: ${deliveryDate}`,
          "",
          "SELECTED PRODUCTS",
          ...productsText,
          "",
          `Total quantity: ${totalQuantity}`,
          `Indicative value: ${formatCurrency(estimatedValue)} (before wholesale discount)`,
          "",
          "NOTES",
          notes || "None provided",
        ].join("\n");
        const html = `
          <div style="margin:0;background:#f5f2eb;padding:28px 12px;font-family:Arial,Helvetica,sans-serif;color:#292821;">
            <div style="max-width:720px;margin:0 auto;border-radius:18px;overflow:hidden;background:#fff;box-shadow:0 12px 36px rgba(32,41,71,.08);">
              <div style="padding:26px 28px;background:#202947;color:#fff;">
                <p style="margin:0 0 10px;color:#d6b978;font-size:11px;font-weight:bold;letter-spacing:3px;">KOORTA · WHOLESALE ENQUIRY</p>
                <h1 style="margin:0;font-family:Georgia,serif;font-size:26px;font-weight:normal;">A bulk buyer is interested</h1>
              </div>
              <div style="padding:24px 28px;">
                <h2 style="margin:0 0 10px;color:#202947;font-size:16px;">Buyer details</h2>
                <table role="presentation" style="width:100%;border-collapse:collapse;font-size:13px;line-height:1.7;">
                  <tr><td style="padding:4px 0;color:#777;">Business</td><td style="padding:4px 0;"><strong>${escapeHtml(businessName)}</strong></td></tr>
                  <tr><td style="padding:4px 0;color:#777;">Contact person</td><td style="padding:4px 0;">${escapeHtml(contactName)}</td></tr>
                  <tr><td style="padding:4px 0;color:#777;">Email</td><td style="padding:4px 0;"><a href="mailto:${escapeHtml(safeEmail)}" style="color:#202947;">${escapeHtml(email)}</a></td></tr>
                  <tr><td style="padding:4px 0;color:#777;">Phone / WhatsApp</td><td style="padding:4px 0;">${escapeHtml(phone)}</td></tr>
                  <tr><td style="padding:4px 0;color:#777;">Category</td><td style="padding:4px 0;">${escapeHtml(category)}</td></tr>
                  <tr><td style="padding:4px 0;color:#777;">Expected delivery</td><td style="padding:4px 0;">${escapeHtml(deliveryDate)}</td></tr>
                </table>
                <h2 style="margin:24px 0 8px;color:#202947;font-size:16px;">Requested products</h2>
                <table role="presentation" style="width:100%;border-collapse:collapse;font-size:12px;">
                  <thead><tr style="color:#777;text-transform:uppercase;letter-spacing:.5px;"><th style="padding:10px 12px;text-align:left;">Product</th><th style="padding:10px 12px;">Qty</th><th style="padding:10px 12px;text-align:right;">Unit price</th><th style="padding:10px 12px;text-align:right;">Est. value</th></tr></thead>
                  <tbody>${productsHtml}</tbody>
                </table>
                <p style="margin:14px 0 0;text-align:right;font-size:14px;line-height:1.8;"><strong>${totalQuantity}</strong> pieces · Indicative value: <strong>${formatCurrency(estimatedValue)}</strong><br><span style="font-size:11px;color:#777;">Before wholesale discount; confirm final pricing with buyer.</span></p>
                <h2 style="margin:22px 0 8px;color:#202947;font-size:16px;">Notes</h2>
                <div style="padding:16px;border:1px solid #eee8dc;border-radius:12px;font-size:13px;line-height:1.7;">${notes ? escapeHtml(notes).replace(/\r?\n/g, "<br>") : "None provided"}</div>
              </div>
            </div>
          </div>`;

        try {
          await sendResendEmail(env, {
            to: "admin@koorta.com",
            replyTo: safeEmail,
            subject,
            text,
            html,
          });
        } catch (error) {
          console.error("Wholesale enquiry email delivery failed:", error);
          return buildError(
            "Unable to send your enquiry right now. Please try again later.",
            502,
            corsHeaders,
          );
        }

        return jsonResponse({ success: true }, 200, corsHeaders);
      }

      if (route === "/customer/order-lookup") {
        if (method !== "POST") {
          return buildError("Method not allowed.", 405, corsHeaders);
        }

        const payload = await parseJson(request);
        if (!payload || typeof payload !== "object") {
          return buildError("Request body must be a JSON object.", 400, corsHeaders);
        }
        if (!(await verifyTurnstile(request, payload.turnstileToken, env, "order_lookup"))) {
          return buildError("Complete the security check and try again.", 403, corsHeaders);
        }
        const orderNumber = sanitizeString(payload.orderNumber);
        const phone = sanitizeString(payload.phone);
        if (!orderNumber || orderNumber.length > 80 || !phone || phone.length > 30) {
          return buildError("Enter a valid order number and phone number.", 400, corsHeaders);
        }

        const orderRow = await findCustomerOrder(env.KOORTA_DB, orderNumber, phone);
        if (!orderRow) return buildError("Order number or phone did not match.", 404, corsHeaders);
        const [itemsResult, transactionsResult, shipmentsResult] = await env.KOORTA_DB.batch([
          env.KOORTA_DB.prepare(
            "SELECT item_id, name, size, quantity, price FROM order_items WHERE order_number = ? ORDER BY id",
          ).bind(orderNumber),
          env.KOORTA_DB.prepare(
            "SELECT transaction_id, status, amount, metadata, created_at FROM transactions WHERE order_number = ?",
          ).bind(orderNumber),
          env.KOORTA_DB.prepare(
            `SELECT id, direction, return_transaction_id, awb, courier_name, status, last_event,
                    manual, delivered_at, updated_at
             FROM order_shipments WHERE order_number = ?`,
          ).bind(orderNumber),
        ]);
        const items = itemsResult.results || [];
        const transactions = transactionsResult.results || [];
        const shipments = (shipmentsResult.results || []).map(shipmentDto);
        const forwardShipment = shipments.find((shipment) => shipment.direction === "forward");
        const reverseShipments = new Map(
          shipments
            .filter((shipment) => shipment.direction === "reverse")
            .map((shipment) => [shipment.returnTransactionId, shipment]),
        );
        const reserved = collectReservedReturnQuantities(transactions);
        const paidAmount = transactions
          .filter((transaction) => transaction.status === "paid" && transaction.amount > 0)
          .reduce((sum, transaction) => sum + transaction.amount, 0);
        const returnEligible =
          isWithinReturnWindow(orderRow.delivered_at) &&
          ["delivered", "partially_returned"].includes(orderRow.status) &&
          paidAmount >= orderRow.total;

        return jsonResponse(
          {
            success: true,
            order: {
              orderNumber: orderRow.order_number,
              placedAt: orderRow.placed_at,
              status: orderRow.status,
              deliveredAt: orderRow.delivered_at || null,
              shipment: forwardShipment
                ? {
                    awb: forwardShipment.awb,
                    courier: forwardShipment.courier,
                    status: forwardShipment.status,
                    lastEvent: forwardShipment.lastEvent,
                    manual: forwardShipment.manual,
                  }
                : null,
              total: orderRow.total,
              payment: orderRow.payment_method,
              paymentReceived: paidAmount >= orderRow.total,
              email: orderRow.customer_email || "",
              deliveryNote: orderRow.customer_notes || "",
              cancellationEligible: ["pending", "confirmed"].includes(orderRow.status),
              returnEligible,
              requests: transactions
                .map((transaction) => ({
                  transactionId: transaction.transaction_id,
                  status: transaction.status,
                  amount: transaction.amount,
                  metadata: parseTransactionMetadata(transaction.metadata),
                }))
                .filter((transaction) =>
                  ["return", "cancellation"].includes(transaction.metadata.type),
                )
                .map(({ transactionId, status, amount, metadata, created_at: createdAt }) => ({
                  transactionId,
                  status,
                  amount,
                  type: metadata.type,
                  requestedAt: metadata.requestedAt || createdAt || null,
                  approvedAt: metadata.approvedAt || null,
                  receivedAt: metadata.receivedAt || metadata.inventoryRestoredAt || null,
                  refundedAt: metadata.refundedAt || null,
                  shipment: reverseShipments.has(transactionId)
                    ? {
                        awb: reverseShipments.get(transactionId).awb,
                        courier: reverseShipments.get(transactionId).courier,
                        status: reverseShipments.get(transactionId).status,
                        lastEvent: reverseShipments.get(transactionId).lastEvent,
                        manual: reverseShipments.get(transactionId).manual,
                      }
                    : null,
                })),
              items: items.map((item) => {
                const isNonReturnable =
                  /made[\s-]?to[\s-]?measure|altered|custom[\s-]?(made|order)/i.test(item.name);
                const availableQty = Math.max(
                  0,
                  item.quantity - (reserved.get(requestedItemKey(item.item_id, item.size)) || 0),
                );
                return {
                  id: item.item_id,
                  name: item.name,
                  size: item.size,
                  qty: item.quantity,
                  price: item.price,
                  returnableQty: isNonReturnable ? 0 : availableQty,
                };
              }),
            },
          },
          200,
          corsHeaders,
        );
      }

      if (route.startsWith("/customer/orders/") && route.endsWith("/contact")) {
        if (method !== "POST") {
          return buildError("Method not allowed.", 405, corsHeaders);
        }
        const parts = route.split("/").filter(Boolean);
        if (parts.length !== 4) return buildError("Invalid order contact route.", 404, corsHeaders);
        let orderNumber;
        try {
          orderNumber = decodeURIComponent(parts[2]);
        } catch {
          return buildError("Invalid order number.", 400, corsHeaders);
        }
        const payload = await parseJson(request);
        if (!payload || typeof payload !== "object") {
          return buildError("Request body must be a JSON object.", 400, corsHeaders);
        }
        if (!(await verifyTurnstile(request, payload.turnstileToken, env, "order_update"))) {
          return buildError("Complete the security check and try again.", 403, corsHeaders);
        }
        const phone = sanitizeString(payload.phone);
        if (typeof payload.email !== 'string' || typeof payload.deliveryNote !== 'string') {
          return buildError('Email address and delivery note must be provided as text.', 400, corsHeaders);
        }
        const email = sanitizeString(payload.email);
        const deliveryNote = sanitizeString(payload.deliveryNote);
        if (!phone || phone.length > 30) {
          return buildError("Enter the phone number used at checkout.", 400, corsHeaders);
        }
        if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 255)) {
          return buildError(
            "Enter a valid email address (maximum 255 characters).",
            400,
            corsHeaders,
          );
        }
        if (deliveryNote.length > 2000) {
          return buildError("Delivery note must be 2000 characters or fewer.", 400, corsHeaders);
        }

        const orderRow = await findCustomerOrder(env.KOORTA_DB, orderNumber, phone);
        if (!orderRow) return buildError("Order number or phone did not match.", 404, corsHeaders);
        const updatedAt = nowISOString();
        const update = await env.KOORTA_DB.prepare(
          `UPDATE orders SET customer_email = ?, customer_notes = ?, updated_at = ?
           WHERE order_number = ? AND customer_phone = ?`,
        )
          .bind(
            email || null,
            deliveryNote || null,
            updatedAt,
            orderNumber,
            orderRow.customer_phone,
          )
          .run();
        if (Number(update.meta?.changes || 0) !== 1) {
          return buildError(
            "Order details could not be updated. Please look up the order and try again.",
            409,
            corsHeaders,
          );
        }
        return jsonResponse(
          {
            success: true,
            email: email || "",
            deliveryNote: deliveryNote || "",
          },
          200,
          corsHeaders,
        );
      }

      if (route.startsWith("/customer/orders/") && route.endsWith("/requests")) {
        if (method !== "POST") {
          return buildError("Method not allowed.", 405, corsHeaders);
        }
        const parts = route.split("/").filter(Boolean);
        if (parts.length !== 4) return buildError("Invalid order request route.", 404, corsHeaders);
        let orderNumber;
        try {
          orderNumber = decodeURIComponent(parts[2]);
        } catch {
          return buildError("Invalid order number.", 400, corsHeaders);
        }
        const payload = await parseJson(request);
        if (!payload || typeof payload !== "object") {
          return buildError("Request body must be a JSON object.", 400, corsHeaders);
        }
        if (!(await verifyTurnstile(request, payload.turnstileToken, env, "order_request"))) {
          return buildError("Complete the security check and try again.", 403, corsHeaders);
        }
        const phone = sanitizeString(payload.phone);
        const reason = sanitizeString(payload.reason);
        const type = sanitizeString(payload.type);
        if (!phone || phone.length > 30 || reason.length < 3 || reason.length > 500) {
          return buildError(
            "A phone number and a short reason (3–500 characters) are required.",
            400,
            corsHeaders,
          );
        }
        if (!["return", "cancellation"].includes(type)) {
          return buildError("Request type must be return or cancellation.", 400, corsHeaders);
        }

        const orderRow = await findCustomerOrder(env.KOORTA_DB, orderNumber, phone);
        if (!orderRow) return buildError("Order number or phone did not match.", 404, corsHeaders);
        const requestTime = nowISOString();
        const transactionId = newTransactionId(type);
        let insertResult;
        let requestItems = [];

        if (type === "cancellation") {
          const metadata = JSON.stringify({
            type,
            reason,
            requestedBy: "customer",
            requestedAt: requestTime,
          });
          insertResult = await env.KOORTA_DB.prepare(
            `INSERT INTO transactions (
              transaction_id, order_number, provider, method, status, amount,
              external_reference, metadata, created_at, updated_at
            )
            SELECT ?, order_number, 'manual', 'cancellation', 'cancellation_requested', 0,
              NULL, ?, ?, ?
            FROM orders
            WHERE order_number = ?
              AND status IN ('pending', 'confirmed')
              AND NOT EXISTS (
                SELECT 1 FROM transactions
                WHERE order_number = ?
                  AND json_extract(metadata, '$.type') = 'cancellation'
                  AND status IN ('cancellation_requested', 'processing', 'inventory_review_required', 'refund_pending', 'cancelled')
              )`,
          )
            .bind(transactionId, metadata, requestTime, requestTime, orderNumber, orderNumber)
            .run();
        } else {
          if (payload.policyConfirmed !== true) {
            return buildError(
              "Confirm that the selected items meet the published return conditions.",
              400,
              corsHeaders,
            );
          }
          if (
            !isWithinReturnWindow(orderRow.delivered_at) ||
            !["delivered", "partially_returned"].includes(orderRow.status)
          ) {
            return buildError(
              "This order is not eligible for a return. Returns must be requested within 15 days of delivery.",
              409,
              corsHeaders,
            );
          }
          const [itemsResult, transactionsResult] = await Promise.all([
            env.KOORTA_DB.prepare(
              "SELECT item_id, name, size, quantity, price FROM order_items WHERE order_number = ? ORDER BY id",
            )
              .bind(orderNumber)
              .all(),
            env.KOORTA_DB.prepare(
              "SELECT status, amount, metadata FROM transactions WHERE order_number = ?",
            )
              .bind(orderNumber)
              .all(),
          ]);
          const purchasedItems = itemsResult.results || [];
          const transactions = transactionsResult.results || [];
          const paidAmount = transactions
            .filter((transaction) => transaction.status === "paid" && transaction.amount > 0)
            .reduce((sum, transaction) => sum + transaction.amount, 0);
          if (paidAmount < orderRow.total) {
            return buildError(
              "A return can be requested after the full order payment is recorded.",
              409,
              corsHeaders,
            );
          }
          const reserved = collectReservedReturnQuantities(transactions);
          const selection = Array.isArray(payload.items) ? payload.items : [];
          if (selection.length === 0 || selection.length > 20) {
            return buildError("Select at least one item and quantity to return.", 400, corsHeaders);
          }
          const selectedByKey = new Map();
          for (const selected of selection) {
            const itemId = sanitizeString(selected?.itemId);
            const size = sanitizeString(selected?.size);
            const qty = ensureNumber(selected?.qty);
            const key = requestedItemKey(itemId, size);
            if (!itemId || !size || !qty || qty <= 0) {
              return buildError(
                "Each selected item needs a valid size and positive quantity.",
                400,
                corsHeaders,
              );
            }
            selectedByKey.set(key, (selectedByKey.get(key) || 0) + qty);
          }

          let requestedGross = 0;
          for (const [key, qty] of selectedByKey) {
            const separator = key.indexOf("\u0000");
            const itemId = key.slice(0, separator);
            const size = key.slice(separator + 1);
            const matching = purchasedItems.filter(
              (item) => item.item_id === itemId && item.size === size,
            );
            const purchaseQty = matching.reduce((sum, item) => sum + item.quantity, 0);
            const isNonReturnable = matching.some((item) =>
              /made[\s-]?to[\s-]?measure|altered|custom[\s-]?(made|order)/i.test(item.name),
            );
            const alreadyReserved = reserved.get(key) || 0;
            if (matching.length === 0 || isNonReturnable || qty + alreadyReserved > purchaseQty) {
              return buildError(
                "One or more selected items are not eligible or exceed the remaining return quantity.",
                409,
                corsHeaders,
              );
            }
            const unitPrice = matching[0].price;
            if (matching.some((item) => item.price !== unitPrice)) {
              return buildError(
                "The selected item has inconsistent order pricing; contact support.",
                409,
                corsHeaders,
              );
            }
            requestedGross += unitPrice * qty;
            requestItems.push({ itemId, name: matching[0].name, size, qty, price: unitPrice });
          }

          const selectedJson = JSON.stringify(requestItems);
          const activeStatuses =
            "'return_requested','approved','processing','inventory_review_required','refund_pending','refunded'";
          const priorGross = `(SELECT COALESCE(SUM(CAST(json_extract(metadata, '$.requestedGross') AS INTEGER)), 0) FROM transactions WHERE order_number = o.order_number AND json_extract(metadata, '$.type') = 'return' AND status IN (${activeStatuses}))`;
          const priorDiscount = `(SELECT COALESCE(SUM(CAST(json_extract(metadata, '$.discountAllocated') AS INTEGER)), 0) FROM transactions WHERE order_number = o.order_number AND json_extract(metadata, '$.type') = 'return' AND status IN (${activeStatuses}))`;
          const discountAllocation = `MIN(?, MAX(0, ROUND(CASE WHEN o.subtotal > 0 THEN o.discount * MIN(o.subtotal, ${priorGross} + ?) / o.subtotal ELSE 0 END) - ${priorDiscount}))`;
          const insertSql = `INSERT INTO transactions (
              transaction_id, order_number, provider, method, status, amount,
              external_reference, metadata, created_at, updated_at
            )
            SELECT ?, o.order_number, 'manual', 'refund', 'return_requested',
              -MAX(0, ? - ${discountAllocation}),
              NULL,
              json_object(
                'type', 'return',
                'reason', ?,
                'requestedBy', 'customer',
                'customerConfirmedPolicy', true,
                'items', json(?),
                'requestedGross', ?,
                'discountAllocated', ${discountAllocation},
                'requestedAt', ?
              ),
              ?, ?
            FROM orders o
            WHERE o.order_number = ?
              AND o.status IN ('delivered', 'partially_returned')
              AND o.delivered_at IS NOT NULL
              AND julianday(o.delivered_at) >= julianday('now', '-15 days')
              AND julianday(o.delivered_at) <= julianday('now')
              AND (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE order_number = o.order_number AND status = 'paid' AND amount > 0)
                >= o.total - (SELECT COALESCE(SUM(-amount), 0) FROM transactions WHERE order_number = o.order_number AND status IN ('return_requested', 'approved', 'processing', 'inventory_review_required', 'refund_pending', 'refunded') AND amount < 0)
              AND NOT EXISTS (
                SELECT 1
                FROM json_each(?) requested
                WHERE CAST(json_extract(requested.value, '$.qty') AS INTEGER) + (
                  SELECT COALESCE(SUM(CAST(json_extract(reserved_item.value, '$.qty') AS INTEGER)), 0)
                  FROM transactions active
                  JOIN json_each(active.metadata, '$.items') reserved_item
                  WHERE active.order_number = o.order_number
                    AND json_extract(active.metadata, '$.type') = 'return'
                    AND active.status IN (${activeStatuses})
                    AND json_extract(reserved_item.value, '$.itemId') = json_extract(requested.value, '$.itemId')
                    AND json_extract(reserved_item.value, '$.size') = json_extract(requested.value, '$.size')
                ) > (
                  SELECT COALESCE(SUM(quantity), 0)
                  FROM order_items purchased
                  WHERE purchased.order_number = o.order_number
                    AND purchased.item_id = json_extract(requested.value, '$.itemId')
                    AND purchased.size = json_extract(requested.value, '$.size')
                )
              )`;
          insertResult = await env.KOORTA_DB.prepare(insertSql)
            .bind(
              transactionId,
              requestedGross,
              requestedGross,
              requestedGross,
              reason,
              selectedJson,
              requestedGross,
              requestedGross,
              requestedGross,
              requestTime,
              requestTime,
              requestTime,
              orderNumber,
              selectedJson,
            )
            .run();
        }

        if (!insertResult?.success || Number(insertResult.meta?.changes || 0) !== 1) {
          return buildError(
            "This request could not be submitted because the order is no longer eligible or a request is already in progress.",
            409,
            corsHeaders,
          );
        }
        const order = await getOrder(env.KOORTA_DB, orderNumber);
        const requestTransaction = await env.KOORTA_DB.prepare(
          "SELECT amount FROM transactions WHERE transaction_id = ?",
        )
          .bind(transactionId)
          .first();
        const refundAmount =
          type === "return" ? Math.abs(Number(requestTransaction?.amount || 0)) : undefined;
        const emailNotifications = await sendOrderLifecycleNotifications(order, env, {
          title: type === "return" ? "Return request received" : "Cancellation request received",
          message:
            type === "return"
              ? "A customer has requested a return. The request is awaiting review; the estimated refund is not approved until items are received and inspected."
              : "A customer has requested cancellation. The request is awaiting review and will be cancelled only if it is still before dispatch.",
          ...(refundAmount !== undefined ? { amount: -refundAmount } : {}),
          reason,
          items: requestItems,
        });
        return jsonResponse(
          {
            success: true,
            transactionId,
            status: type === "return" ? "return_requested" : "cancellation_requested",
            ...(refundAmount !== undefined ? { estimatedRefund: refundAmount } : {}),
            emailNotifications,
          },
          201,
          corsHeaders,
        );
      }

      if (route.startsWith("/admin/orders/") && method === "POST") {
        if (method !== "POST") {
          return buildError("Method not allowed.", 405, corsHeaders);
        }
        const parts = route.split("/").filter(Boolean);
        let orderNumber;
        try {
          orderNumber = decodeURIComponent(parts[2] || "");
        } catch {
          return buildError("Invalid order number.", 400, corsHeaders);
        }
        if (!orderNumber) return buildError("Order number is required.", 400, corsHeaders);
        const payload = await parseJson(request);
        if (!payload || typeof payload !== "object") {
          return buildError("Request body must be a JSON object.", 400, corsHeaders);
        }

        if (parts.length === 4 && parts[3] === "shipping") {
          const order = await getOrder(env.KOORTA_DB, orderNumber);
          if (!order) return buildError("Order not found.", 404, corsHeaders);
          const action = sanitizeString(payload.action);
          const direction = payload.direction === "reverse" ? "reverse" : "forward";
          const returnTransactionId = sanitizeString(payload.transactionId);

          if (action === "cancel") {
            if (direction !== "forward" || order.status !== "confirmed") {
              return buildError("Only a confirmed forward shipment can be cancelled before dispatch.", 409, corsHeaders);
            }
            const shipment = await findShipment(env.KOORTA_DB, orderNumber, "forward");
            if (!shipment || !shipment.shiprocket_order_id) {
              return buildError("No Shiprocket order ID is available to cancel. Verify the carrier dashboard and record the manual outcome.", 409, corsHeaders);
            }
            if (
              ![
                "creating_order",
                "order_creation_in_progress",
                "order_created",
                "awb_assigned",
                "pickup_requested",
                "booked",
                "booking_error",
                "booking_failed",
                "booking_uncertain",
              ].includes(shipment.status)
            ) {
              return buildError("This shipment may already be with the courier and cannot be cancelled from here.", 409, corsHeaders);
            }
            try {
              await shiprocketRequest(env, "/orders/cancel", {
                ids: [Number(shipment.shiprocket_order_id)],
              });
              await saveShipment(env.KOORTA_DB, shipment.id, {
                status: "cancelled",
                last_event: "Shiprocket shipment cancelled by admin before dispatch",
                error: null,
              });
              return jsonResponse(
                {
                  success: true,
                  shipment: shipmentDto(
                    await findShipment(env.KOORTA_DB, orderNumber, "forward"),
                  ),
                },
                200,
                corsHeaders,
              );
            } catch (error) {
              return buildError(
                error instanceof Error ? error.message : "Unable to cancel the Shiprocket order.",
                502,
                corsHeaders,
              );
            }
          }

          if (action === "manual_cancel") {
            if (direction !== "forward" || order.status !== "confirmed") {
              return buildError("Only a confirmed forward shipment can be marked manually cancelled.", 409, corsHeaders);
            }
            const shipment = await findShipment(env.KOORTA_DB, orderNumber, "forward");
            if (!shipment) return buildError("No forward shipment record was found.", 404, corsHeaders);
            await saveShipment(env.KOORTA_DB, shipment.id, {
              status: "cancelled",
              last_event: "Admin confirmed manual cancellation with the carrier",
              manual: 1,
              error: null,
            });
            return jsonResponse(
              {
                success: true,
                shipment: shipmentDto(
                  await findShipment(env.KOORTA_DB, orderNumber, "forward"),
                ),
              },
              200,
              corsHeaders,
            );
          }

          if (action === "book") {
            if (!sanitizeString(env.SHIPROCKET_EMAIL) || !sanitizeString(env.SHIPROCKET_PASSWORD)) {
              return buildError("Shiprocket API credentials are not configured.", 503, corsHeaders);
            }
            if (direction === "forward" && order.status !== "confirmed") {
              return buildError("Only a confirmed order can be booked for forward delivery.", 409, corsHeaders);
            }
            if (direction === "reverse") {
              try {
                makeShiprocketReturnPayload(
                  order,
                  { external_order_reference: "1000000000000000" },
                  returnTransactionId,
                  env,
                );
              } catch (error) {
                return buildError(error instanceof Error ? error.message : String(error), 400, corsHeaders);
              }
            }

            const existing = await findShipment(
              env.KOORTA_DB,
              orderNumber,
              direction,
              returnTransactionId,
            );
            if (existing) {
              if (["booked", "in_transit", "delivered", "rto_in_transit", "delivery_exception"].includes(existing.status)) {
                return jsonResponse({ success: true, shipment: shipmentDto(existing) }, 200, corsHeaders);
              }
              return buildError(
                "A shipment record already exists. Review Shiprocket and use the manual tracking controls rather than creating a duplicate.",
                409,
                corsHeaders,
              );
            }

            let shipment;
            try {
              const reference = randomNumericReference();
              const shiprocketPayload =
                direction === "reverse"
                  ? makeShiprocketReturnPayload(
                      order,
                      { external_order_reference: reference },
                      returnTransactionId,
                      env,
                    )
                  : makeShiprocketOrderPayload(order, reference, env);
              try {
                shipment = await createShipmentRecord(
                  env.KOORTA_DB,
                  orderNumber,
                  direction,
                  direction === "reverse" ? returnTransactionId : null,
                  direction === "forward" ? ["confirmed"] : null,
                  reference,
                );
              } catch (error) {
                const concurrentShipment = await findShipment(
                  env.KOORTA_DB,
                  orderNumber,
                  direction,
                  direction === "reverse" ? returnTransactionId : null,
                );
                if (concurrentShipment) {
                  return buildError(
                    "Another shipment action created a record. Reload the order before continuing.",
                    409,
                    corsHeaders,
                  );
                }
                if (
                  error instanceof Error &&
                  error.message === "Order status changed before the shipment could be reserved."
                ) {
                  return buildError(error.message, 409, corsHeaders);
                }
                throw error;
              }
              shipment.external_order_reference = reference;
              const result = await advanceShipmentBooking(
                env.KOORTA_DB,
                env,
                order,
                shipment,
                direction === "reverse",
                shiprocketPayload,
              );
              return jsonResponse({ success: true, shipment: result }, 200, corsHeaders);
            } catch (error) {
              console.error(`Shiprocket ${direction} booking failed for ${orderNumber}:`, error);
              return buildError(
                error instanceof Error ? error.message : "Shipment booking failed.",
                502,
                corsHeaders,
              );
            }
          }

          if (action === "manual") {
            const awb = sanitizeString(payload.awb);
            const courier = sanitizeString(payload.courier);
            const manualStatus = sanitizeString(payload.status) || "Manual shipment";
            if (awb.length > 100 || courier.length > 100 || manualStatus.length > 200) {
              return buildError("Manual shipment details exceed the allowed length.", 400, corsHeaders);
            }
            if (direction === "forward" && !["confirmed", "shipped", "delivered"].includes(order.status)) {
              return buildError("Manual shipping details can be saved only for a confirmed order.", 409, corsHeaders);
            }
            if (direction === "reverse") {
              const returnRequest = order.transactions.find(
                (transaction) => transaction.transactionId === returnTransactionId,
              );
              if (
                !returnRequest ||
                returnRequest.metadata?.type !== "return" ||
                !["approved", "processing"].includes(returnRequest.status)
              ) {
                return buildError("Manual reverse-pickup details require an approved return.", 409, corsHeaders);
              }
            }

            let shipment = await findShipment(
              env.KOORTA_DB,
              orderNumber,
              direction,
              returnTransactionId,
            );
            if (!shipment) {
              try {
                shipment = await createShipmentRecord(
                  env.KOORTA_DB,
                  orderNumber,
                  direction,
                  direction === "reverse" ? returnTransactionId : null,
                );
              } catch (error) {
                shipment = await findShipment(
                  env.KOORTA_DB,
                  orderNumber,
                  direction,
                  returnTransactionId,
                );
                if (!shipment) throw error;
              }
            }
            await saveShipment(env.KOORTA_DB, shipment.id, {
              awb: awb || shipment.awb,
              courier_name: courier || shipment.courier_name,
              status: "manual",
              last_event: manualStatus,
              manual: 1,
              error: null,
            });
            const updated = await findShipment(
              env.KOORTA_DB,
              orderNumber,
              direction,
              returnTransactionId,
            );
            return jsonResponse({ success: true, shipment: shipmentDto(updated) }, 200, corsHeaders);
          }

          return buildError("Unknown shipping action.", 400, corsHeaders);
        }

        if (parts.length === 4 && parts[3] === "status") {
          const nextStatus = sanitizeString(payload.status);
          const transitions = {
            pending: "confirmed",
            confirmed: "shipped",
            shipped: "delivered",
          };
          const orderRow = await env.KOORTA_DB.prepare(
            "SELECT status FROM orders WHERE order_number = ?",
          )
            .bind(orderNumber)
            .first();
          if (!orderRow) return buildError("Order not found.", 404, corsHeaders);
          if (transitions[orderRow.status] !== nextStatus) {
            return buildError(
              "Order fulfillment must advance one step at a time: pending → confirmed → shipped → delivered.",
              409,
              corsHeaders,
            );
          }
          const updatedAt = nowISOString();
          const result = await env.KOORTA_DB.prepare(
            `UPDATE orders
             SET status = ?, delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END,
                 updated_at = ?
             WHERE order_number = ? AND status = ?`,
          )
            .bind(nextStatus, nextStatus, updatedAt, updatedAt, orderNumber, orderRow.status)
            .run();
          if (Number(result.meta?.changes || 0) !== 1) {
            return buildError("The order status changed; reload and try again.", 409, corsHeaders);
          }
          const shipment = await findShipment(env.KOORTA_DB, orderNumber, "forward");
          if (shipment) {
            await saveShipment(env.KOORTA_DB, shipment.id, {
              status: "manual",
              last_event: `Admin manually marked ${nextStatus}`,
              manual: 1,
              ...(nextStatus === "delivered" ? { delivered_at: updatedAt } : {}),
            });
          }
          return jsonResponse(
            {
              success: true,
              status: nextStatus,
              deliveredAt: nextStatus === "delivered" ? updatedAt : null,
            },
            200,
            corsHeaders,
          );
        }

        if (parts.length === 4 && parts[3] === "payment") {
          const payment = await env.KOORTA_DB.prepare(
            `SELECT transactions.transaction_id, transactions.status, transactions.amount
             FROM transactions
             JOIN orders ON orders.order_number = transactions.order_number
             WHERE transactions.order_number = ? AND transactions.amount > 0
               AND orders.status NOT IN ('cancelled', 'cancellation_processing')
             ORDER BY transactions.created_at LIMIT 1`,
          )
            .bind(orderNumber)
            .first();
          if (!payment)
            return buildError("No payable transaction was found for this order.", 404, corsHeaders);
          if (payment.status === "paid") {
            return jsonResponse({ success: true, status: "paid" }, 200, corsHeaders);
          }
          if (payment.status !== "pending") {
            return buildError(
              "Only a pending payment can be marked as received.",
              409,
              corsHeaders,
            );
          }
          const reference = sanitizeString(payload.reference);
          if (reference.length > 200)
            return buildError(
              "Payment reference must be 200 characters or fewer.",
              400,
              corsHeaders,
            );
          const paidAt = nowISOString();
          const update = await env.KOORTA_DB.prepare(
            `UPDATE transactions
             SET status = 'paid', external_reference = ?, metadata = json_set(COALESCE(metadata, '{}'), '$.paymentConfirmedAt', ?, '$.paymentConfirmedBy', ?),
                 updated_at = ?
             WHERE transaction_id = ? AND status = 'pending' AND amount > 0
               AND EXISTS (SELECT 1 FROM orders WHERE order_number = ? AND status NOT IN ('cancelled', 'cancellation_processing'))`,
          )
            .bind(
              reference || null,
              paidAt,
              adminIdentity,
              paidAt,
              payment.transaction_id,
              orderNumber,
            )
            .run();
          if (Number(update.meta?.changes || 0) !== 1) {
            return buildError(
              "The payment status changed; reload and try again.",
              409,
              corsHeaders,
            );
          }
          return jsonResponse({ success: true, status: "paid" }, 200, corsHeaders);
        }

        if (parts.length !== 5 || parts[3] !== "requests") {
          return buildError("Unknown admin order action.", 404, corsHeaders);
        }
        let transactionId;
        try {
          transactionId = decodeURIComponent(parts[4]);
        } catch {
          return buildError("Invalid request ID.", 400, corsHeaders);
        }
        const action = sanitizeString(payload.action);
        const row = await env.KOORTA_DB.prepare(
          `SELECT transaction_id, status, amount, external_reference, metadata
           FROM transactions WHERE transaction_id = ? AND order_number = ?`,
        )
          .bind(transactionId, orderNumber)
          .first();
        if (!row) return buildError("Order request not found.", 404, corsHeaders);
        const metadata = parseTransactionMetadata(row.metadata);
        const order = await getOrder(env.KOORTA_DB, orderNumber);
        if (!order) return buildError("Order not found.", 404, corsHeaders);
        const itemDetails = Array.isArray(metadata.items) ? metadata.items : [];
        const reason = sanitizeString(metadata.reason);
        const changedAt = nowISOString();

        if (action === "reject") {
          if (!["return_requested", "cancellation_requested", "approved"].includes(row.status)) {
            return buildError("Only an unprocessed request can be rejected.", 409, corsHeaders);
          }
          const note = sanitizeString(payload.note);
          if (note.length > 500)
            return buildError("Admin note must be 500 characters or fewer.", 400, corsHeaders);
          const nextMetadata = {
            ...metadata,
            reviewedAt: changedAt,
            reviewedBy: adminIdentity,
            adminNote: note,
          };
          const update = await env.KOORTA_DB.prepare(
            `UPDATE transactions SET status = 'rejected', metadata = ?, updated_at = ?
             WHERE transaction_id = ? AND status = ?`,
          )
            .bind(JSON.stringify(nextMetadata), changedAt, transactionId, row.status)
            .run();
          if (Number(update.meta?.changes || 0) !== 1) {
            return buildError("The request changed; reload and try again.", 409, corsHeaders);
          }
          if (metadata.type === "return") {
            const emailNotifications = await sendOrderLifecycleNotifications(
              order,
              env,
              {
                title: "Return request update",
                message:
                  "We could not approve the return request. Please contact our team if you need help.",
                reason: note || reason,
                items: itemDetails,
              },
              "customer",
            );
            return jsonResponse(
              { success: true, status: "rejected", emailNotifications },
              200,
              corsHeaders,
            );
          }
          return jsonResponse({ success: true, status: "rejected" }, 200, corsHeaders);
        }

        if (metadata.type === "return" && action === "approve") {
          if (row.status === "approved")
            return jsonResponse({ success: true, status: "approved" }, 200, corsHeaders);
          if (row.status !== "return_requested") {
            return buildError("Only a newly requested return can be approved.", 409, corsHeaders);
          }
          const nextMetadata = { ...metadata, approvedAt: changedAt, approvedBy: adminIdentity };
          const update = await env.KOORTA_DB.prepare(
            `UPDATE transactions SET status = 'approved', metadata = ?, updated_at = ?
             WHERE transaction_id = ? AND status = 'return_requested'`,
          )
            .bind(JSON.stringify(nextMetadata), changedAt, transactionId)
            .run();
          if (Number(update.meta?.changes || 0) !== 1) {
            return buildError("The request changed; reload and try again.", 409, corsHeaders);
          }
          const emailNotifications = await sendOrderLifecycleNotifications(
            order,
            env,
            {
              title: "Return request approved",
              message:
                "Your return is approved. Our team will coordinate the free reverse pickup. A refund is recorded only after the items are received and inspected.",
              amount: Number(row.amount || 0),
              reason,
              items: itemDetails,
            },
            "customer",
          );
          return jsonResponse(
            { success: true, status: "approved", emailNotifications },
            200,
            corsHeaders,
          );
        }

        if (metadata.type === "cancellation" && action === "approve") {
          if (["refund_pending", "cancelled"].includes(row.status)) {
            return jsonResponse({ success: true, status: row.status }, 200, corsHeaders);
          }
          if (
            !["cancellation_requested", "inventory_review_required", "processing"].includes(
              row.status,
            )
          ) {
            return buildError("Only a pending cancellation can be approved.", 409, corsHeaders);
          }
          const orderStatus = (
            await env.KOORTA_DB.prepare("SELECT status FROM orders WHERE order_number = ?")
              .bind(orderNumber)
              .first()
          )?.status;
          if (!["pending", "confirmed", "cancellation_processing"].includes(orderStatus)) {
            return buildError("Cancellation is allowed only before dispatch.", 409, corsHeaders);
          }
          const carrierShipment = await findShipment(env.KOORTA_DB, orderNumber, "forward");
          if (carrierShipment && carrierShipment.status !== "cancelled") {
            return buildError(
              "Cancel the Shiprocket booking first. If it was cancelled in the carrier dashboard, record that manual outcome in Admin and retry.",
              409,
              corsHeaders,
            );
          }
          if (row.status === "cancellation_requested") {
            if (!["pending", "confirmed"].includes(orderStatus)) {
              return buildError("Cancellation is allowed only before dispatch.", 409, corsHeaders);
            }
            const startedAt = nowISOString();
            const startedMetadata = {
              ...metadata,
              approvedAt: startedAt,
              approvedBy: adminIdentity,
            };
            const start = await env.KOORTA_DB.batch([
              env.KOORTA_DB.prepare(
                `UPDATE orders SET status = 'cancellation_processing', updated_at = ?
                 WHERE order_number = ? AND status IN ('pending', 'confirmed')`,
              ).bind(startedAt, orderNumber),
              env.KOORTA_DB.prepare(
                `UPDATE transactions SET status = 'processing', metadata = ?, updated_at = ?
                 WHERE transaction_id = ? AND status IN ('cancellation_requested', 'inventory_review_required')`,
              ).bind(JSON.stringify(startedMetadata), startedAt, transactionId),
            ]);
            if (
              Number(start[0]?.meta?.changes || 0) !== 1 ||
              Number(start[1]?.meta?.changes || 0) !== 1
            ) {
              return buildError(
                "The cancellation could not be started; reload and retry.",
                409,
                corsHeaders,
              );
            }
          } else if (row.status === "inventory_review_required") {
            if (orderStatus !== "cancellation_processing") {
              return buildError(
                "Cancellation cannot be retried because the order is no longer processing.",
                409,
                corsHeaders,
              );
            }
            const retryAt = nowISOString();
            const retryMetadata = {
              ...metadata,
              inventoryRetryAt: retryAt,
              inventoryRetryBy: adminIdentity,
            };
            const retry = await env.KOORTA_DB.prepare(
              `UPDATE transactions SET status = 'processing', metadata = ?, updated_at = ?
               WHERE transaction_id = ? AND status = 'inventory_review_required'`,
            )
              .bind(JSON.stringify(retryMetadata), retryAt, transactionId)
              .run();
            if (Number(retry.meta?.changes || 0) !== 1) {
              return buildError(
                "The cancellation changed; reload and try again.",
                409,
                corsHeaders,
              );
            }
          } else if (row.status !== "processing" || orderStatus !== "cancellation_processing") {
            return buildError(
              "Cancellation is already being processed; reload and retry.",
              409,
              corsHeaders,
            );
          }

          try {
            await restoreCatalogStockForOrder(
              env.GARMENT_BUCKET,
              order.items.map((item) => ({
                itemId: String(item.id),
                size: item.size,
                qty: item.qty,
              })),
              `cancel-${transactionId}`,
            );
          } catch (error) {
            console.error(`Inventory restoration failed for cancellation ${transactionId}:`, error);
            const failedAt = nowISOString();
            const retryMetadata = {
              ...metadata,
              inventoryIssueAt: failedAt,
              inventoryIssue: error instanceof Error ? error.message : String(error),
            };
            await env.KOORTA_DB.prepare(
              `UPDATE transactions SET status = 'inventory_review_required', metadata = ?, updated_at = ?
               WHERE transaction_id = ? AND status = 'processing'`,
            )
              .bind(JSON.stringify(retryMetadata), failedAt, transactionId)
              .run();
            return buildError(
              "Cancellation is saved but inventory restoration needs an admin retry. The order remains in cancellation processing.",
              409,
              corsHeaders,
            );
          }

          const paymentsResult = await env.KOORTA_DB.prepare(
            "SELECT transaction_id, status, amount FROM transactions WHERE order_number = ? AND amount > 0",
          )
            .bind(orderNumber)
            .all();
          const payments = paymentsResult.results || [];
          const collectedAmount = payments
            .filter((payment) => payment.status === "paid")
            .reduce((sum, payment) => sum + payment.amount, 0);
          const finalAmount = collectedAmount > 0 ? -collectedAmount : 0;
          const finalStatus = collectedAmount > 0 ? "refund_pending" : "cancelled";
          const finalizedAt = nowISOString();
          const finalMetadata = {
            ...metadata,
            approvedAt: metadata.approvedAt || finalizedAt,
            approvedBy: metadata.approvedBy || adminIdentity,
            inventoryRestoredAt: finalizedAt,
            refundAmount: collectedAmount,
          };
          const finalStatements = [
            env.KOORTA_DB.prepare(
              `UPDATE orders SET status = 'cancelled', updated_at = ?
               WHERE order_number = ? AND status = 'cancellation_processing'`,
            ).bind(finalizedAt, orderNumber),
            env.KOORTA_DB.prepare(
              `UPDATE transactions SET status = ?, amount = ?, metadata = ?, updated_at = ?
               WHERE transaction_id = ? AND status = 'processing'
                 AND EXISTS (SELECT 1 FROM orders WHERE order_number = ? AND status = 'cancelled')`,
            ).bind(
              finalStatus,
              finalAmount,
              JSON.stringify(finalMetadata),
              finalizedAt,
              transactionId,
              orderNumber,
            ),
            ...payments
              .filter((payment) => payment.status === "pending")
              .map((payment) =>
                env.KOORTA_DB.prepare(
                  `UPDATE transactions SET status = 'cancelled', updated_at = ?
                 WHERE transaction_id = ? AND status = 'pending'`,
                ).bind(finalizedAt, payment.transaction_id),
              ),
          ];
          const finalized = await env.KOORTA_DB.batch(finalStatements);
          if (
            Number(finalized[0]?.meta?.changes || 0) !== 1 ||
            Number(finalized[1]?.meta?.changes || 0) !== 1
          ) {
            return buildError(
              "Inventory was restored, but the cancellation ledger could not be finalized. Retry the action to reconcile it.",
              409,
              corsHeaders,
            );
          }
          return jsonResponse({ success: true, status: finalStatus }, 200, corsHeaders);
        }

        if (metadata.type === "return" && action === "receive") {
          if (!["approved", "inventory_review_required", "processing"].includes(row.status)) {
            return buildError(
              "Approve the return before marking items received.",
              409,
              corsHeaders,
            );
          }
          if (row.status !== "processing") {
            const receivingAt = nowISOString();
            const receivedMetadata = {
              ...metadata,
              receivedAt: receivingAt,
              receivedBy: adminIdentity,
            };
            const start = await env.KOORTA_DB.prepare(
              `UPDATE transactions SET status = 'processing', metadata = ?, updated_at = ?
               WHERE transaction_id = ? AND status IN ('approved', 'inventory_review_required')`,
            )
              .bind(JSON.stringify(receivedMetadata), receivingAt, transactionId)
              .run();
            if (Number(start.meta?.changes || 0) !== 1) {
              return buildError(
                "The return status changed; reload and try again.",
                409,
                corsHeaders,
              );
            }
          }
          try {
            await restoreCatalogStockForOrder(
              env.GARMENT_BUCKET,
              itemDetails.map((item) => ({
                itemId: String(item.itemId),
                size: item.size,
                qty: item.qty,
              })),
              `return-${transactionId}`,
            );
          } catch (error) {
            console.error(`Inventory restoration failed for return ${transactionId}:`, error);
            const failedAt = nowISOString();
            const retryMetadata = {
              ...metadata,
              inventoryIssueAt: failedAt,
              inventoryIssue: error instanceof Error ? error.message : String(error),
            };
            await env.KOORTA_DB.prepare(
              `UPDATE transactions SET status = 'inventory_review_required', metadata = ?, updated_at = ?
               WHERE transaction_id = ? AND status = 'processing'`,
            )
              .bind(JSON.stringify(retryMetadata), failedAt, transactionId)
              .run();
            return buildError(
              "Return receipt is saved but inventory restoration needs an admin retry.",
              409,
              corsHeaders,
            );
          }

          const receivedAt = nowISOString();
          const nextStatus = Number(row.amount) < 0 ? "refund_pending" : "refunded";
          const receivedMetadata = { ...metadata, inventoryRestoredAt: receivedAt };
          const update = await env.KOORTA_DB.prepare(
            `UPDATE transactions SET status = ?, metadata = ?, external_reference = CASE WHEN ? = 'refunded' THEN 'No monetary refund due' ELSE external_reference END, updated_at = ?
             WHERE transaction_id = ? AND status = 'processing'`,
          )
            .bind(
              nextStatus,
              JSON.stringify(receivedMetadata),
              nextStatus,
              receivedAt,
              transactionId,
            )
            .run();
          if (Number(update.meta?.changes || 0) !== 1) {
            return buildError(
              "Items were received, but the return ledger could not be finalized. Retry the action to reconcile it.",
              409,
              corsHeaders,
            );
          }
          return jsonResponse({ success: true, status: nextStatus }, 200, corsHeaders);
        }

        if (action === "refund") {
          if (row.status === "refunded")
            return jsonResponse({ success: true, status: "refunded" }, 200, corsHeaders);
          if (row.status !== "refund_pending" || Number(row.amount) >= 0) {
            return buildError(
              "Only a pending negative refund transaction can be marked as refunded.",
              409,
              corsHeaders,
            );
          }
          const reference = sanitizeString(payload.reference);
          if (!reference || reference.length > 200) {
            return buildError(
              "Enter the refund payment reference (maximum 200 characters).",
              400,
              corsHeaders,
            );
          }
          const refundAt = nowISOString();
          const refundedMetadata = { ...metadata, refundedAt: refundAt, refundedBy: adminIdentity };
          const update = await env.KOORTA_DB.prepare(
            `UPDATE transactions SET status = 'refunded', external_reference = ?, metadata = ?, updated_at = ?
             WHERE transaction_id = ? AND status = 'refund_pending' AND amount < 0`,
          )
            .bind(reference, JSON.stringify(refundedMetadata), refundAt, transactionId)
            .run();
          if (Number(update.meta?.changes || 0) !== 1) {
            return buildError("The refund status changed; reload and try again.", 409, corsHeaders);
          }

          if (metadata.type === "return") {
            const transactionsResult = await env.KOORTA_DB.prepare(
              "SELECT status, metadata FROM transactions WHERE order_number = ?",
            )
              .bind(orderNumber)
              .all();
            const returned = collectReservedReturnQuantities(transactionsResult.results || []);
            const purchasedResult = await env.KOORTA_DB.prepare(
              "SELECT item_id, size, SUM(quantity) AS quantity FROM order_items WHERE order_number = ? GROUP BY item_id, size",
            )
              .bind(orderNumber)
              .all();
            const allItemsReturned = (purchasedResult.results || []).every(
              (item) =>
                (returned.get(requestedItemKey(item.item_id, item.size)) || 0) >= item.quantity,
            );
            const nextOrderStatus = allItemsReturned ? "returned" : "partially_returned";
            await env.KOORTA_DB.prepare(
              `UPDATE orders SET status = ?, updated_at = ?
               WHERE order_number = ? AND status IN ('delivered', 'partially_returned', 'returned')`,
            )
              .bind(nextOrderStatus, refundAt, orderNumber)
              .run();
          }

          const emailNotifications = await sendOrderLifecycleNotifications(
            order,
            env,
            {
              title: "Refund sent",
              message:
                "Your refund has been sent. The payment reference is included below for your records.",
              amount: Number(row.amount),
              reference,
              reason,
              items: itemDetails,
            },
            "customer",
          );
          return jsonResponse(
            { success: true, status: "refunded", emailNotifications },
            200,
            corsHeaders,
          );
        }

        return buildError("Action is not valid for this request.", 400, corsHeaders);
      }

      if (route === "/admin/reports/monthly") {
        if (method !== "GET") {
          return buildError("Method not allowed.", 405, corsHeaders);
        }

        const year = Number(url.searchParams.get("year"));
        const month = Number(url.searchParams.get("month"));
        const currentYear = new Date().getUTCFullYear();
        if (!Number.isInteger(year) || year < 2000 || year > currentYear) {
          return buildError(
            `Year must be a whole number between 2000 and ${currentYear}.`,
            400,
            corsHeaders,
          );
        }
        if (!Number.isInteger(month) || month < 1 || month > 12) {
          return buildError("Month must be a whole number between 1 and 12.", 400, corsHeaders);
        }

        const monthStartUtc = new Date(
          Date.UTC(year, month - 1, 1) - 330 * 60 * 1000,
        ).toISOString();
        const nextMonthStartUtc = new Date(
          Date.UTC(year, month, 1) - 330 * 60 * 1000,
        ).toISOString();
        const transactionsResult = await env.KOORTA_DB.prepare(
          `WITH completed_money_events AS (
             SELECT
               transaction_id,
               order_number,
               method,
               status,
               amount,
               external_reference,
               CASE WHEN amount > 0 THEN 'payment' ELSE 'refund' END AS event_type,
               CASE
                 WHEN amount > 0 THEN COALESCE(json_extract(metadata, '$.paymentConfirmedAt'), updated_at)
                 ELSE COALESCE(json_extract(metadata, '$.refundedAt'), updated_at)
               END AS event_at
             FROM transactions
             WHERE (status = 'paid' AND amount > 0)
                OR (status = 'refunded' AND amount < 0)
           )
           SELECT transaction_id, order_number, method, status, amount, external_reference, event_type, event_at
           FROM completed_money_events
           WHERE event_at IS NOT NULL
             AND datetime(event_at) >= datetime(?)
             AND datetime(event_at) < datetime(?)
           ORDER BY event_at, order_number, transaction_id`,
        )
          .bind(monthStartUtc, nextMonthStartUtc)
          .all();
        const transactions = transactionsResult.results || [];
        const cashCollected = transactions
          .filter((transaction) => transaction.event_type === "payment")
          .reduce((sum, transaction) => sum + Number(transaction.amount), 0);
        const refundsPaid = transactions
          .filter((transaction) => transaction.event_type === "refund")
          .reduce((sum, transaction) => sum + Math.abs(Number(transaction.amount)), 0);

        return jsonResponse(
          {
            success: true,
            year,
            month,
            currency: "INR",
            basis: "completed cash movements by transaction event time (Asia/Kolkata)",
            summary: {
              cashCollected,
              refundsPaid,
              netCashCollected: cashCollected - refundsPaid,
              paymentCount: transactions.filter(
                (transaction) => transaction.event_type === "payment",
              ).length,
              refundCount: transactions.filter((transaction) => transaction.event_type === "refund")
                .length,
            },
            transactions,
          },
          200,
          corsHeaders,
        );
      }

      const orderRoute = route.startsWith("/admin/orders")
        ? route.replace(/^\/admin\/orders/, "/orders")
        : route;
      if (orderRoute.startsWith("/orders")) {
        if (method === "GET") {
          const parts = orderRoute.split("/").filter(Boolean);
          if (parts.length === 2) {
            const orderNumber = parts[1];
            const record = await getOrder(env.KOORTA_DB, orderNumber);
            if (!record) return buildError("Order not found.", 404, corsHeaders);
            return jsonResponse({ success: true, order: record }, 200, corsHeaders);
          }

          const email = String(url.searchParams.get("email") || "").trim();
          const phone = String(url.searchParams.get("phone") || "").trim();
          if (!email && !phone) {
            return buildError("Provide email or phone to look up orders.", 400, corsHeaders);
          }

          const conditions = [];
          const values = [];
          if (email) {
            conditions.push("customer_email = ?");
            values.push(email);
          }
          if (phone) {
            conditions.push("customer_phone = ?");
            values.push(phone);
          }

          const query = `SELECT * FROM orders WHERE ${conditions.join(" OR ")} ORDER BY placed_at DESC LIMIT 50`;
          const ordersResult = await env.KOORTA_DB.prepare(query)
            .bind(...values)
            .all();
          const orders = ordersResult.results || [];

          if (orders.length === 0) {
            return jsonResponse({ success: true, orders: [] }, 200, corsHeaders);
          }

          const orderNumbers = orders.map((r) => r.order_number);
          const placeholders = orderNumbers.map(() => "?").join(",");

          const itemsQuery = `SELECT order_number, item_id, name, size, quantity, price, image_url FROM order_items WHERE order_number IN (${placeholders})`;
          const itemsResult = await env.KOORTA_DB.prepare(itemsQuery)
            .bind(...orderNumbers)
            .all();
          const items = itemsResult.results || [];

          const txQuery = `SELECT order_number, transaction_id, provider, method, status, amount, external_reference, metadata, created_at, updated_at FROM transactions WHERE order_number IN (${placeholders})`;
          const txResult = await env.KOORTA_DB.prepare(txQuery)
            .bind(...orderNumbers)
            .all();
          const txs = txResult.results || [];
          const shipmentsQuery = `SELECT * FROM order_shipments WHERE order_number IN (${placeholders}) ORDER BY created_at`;
          const shipmentsResult = await env.KOORTA_DB.prepare(shipmentsQuery)
            .bind(...orderNumbers)
            .all();
          const shipmentsByOrder = {};
          for (const shipment of shipmentsResult.results || []) {
            (shipmentsByOrder[shipment.order_number] ||= []).push(shipmentDto(shipment));
          }

          const itemsByOrder = {};
          for (const it of items) {
            (itemsByOrder[it.order_number] ||= []).push({
              id: it.item_id,
              name: it.name,
              size: it.size,
              qty: it.quantity,
              price: it.price,
              image: it.image_url,
            });
          }

          const txByOrder = {};
          for (const t of txs) {
            (txByOrder[t.order_number] ||= []).push({
              transactionId: t.transaction_id,
              provider: t.provider,
              method: t.method,
              status: t.status,
              amount: t.amount,
              externalReference: t.external_reference,
              metadata: parseTransactionMetadata(t.metadata),
              createdAt: t.created_at,
              updatedAt: t.updated_at,
            });
          }

          const assembled = orders.map((orderRow) => ({
            orderNumber: orderRow.order_number,
            placedAt: orderRow.placed_at,
            customer: {
              name: orderRow.customer_name,
              email: orderRow.customer_email,
              phone: orderRow.customer_phone,
              address: orderRow.customer_address,
              city: orderRow.customer_city,
              state: orderRow.customer_state,
              district: orderRow.customer_district,
              postOffice: orderRow.customer_post_office,
              pincode: orderRow.customer_pincode,
              notes: orderRow.customer_notes,
            },
            payment: orderRow.payment_method,
            upiId: orderRow.upi_id,
            promoCode: orderRow.promo_code,
            subtotal: orderRow.subtotal,
            discount: orderRow.discount,
            shipping: orderRow.shipping,
            total: orderRow.total,
            status: orderRow.status,
            deliveredAt: orderRow.delivered_at || null,
            shipments: shipmentsByOrder[orderRow.order_number] || [],
            items: itemsByOrder[orderRow.order_number] || [],
            transactions: txByOrder[orderRow.order_number] || [],
          }));

          return jsonResponse({ success: true, orders: assembled }, 200, corsHeaders);
        }

        if (method === "POST" && orderRoute === "/orders") {
          const apiKey = request.headers.get("x-koorta-db-api-key") || "";
          if (!env.KOORTA_DB_WORKER_API_SECRET || apiKey !== env.KOORTA_DB_WORKER_API_SECRET) {
            return buildError("Unauthorized request.", 401, corsHeaders);
          }

          const payload = await parseJson(request);
          const validationError = validateOrderPayload(payload);
          if (validationError) {
            return buildError(validationError, 400, corsHeaders);
          }

          const order = normalizeOrderPayload(payload);
          if (!order.orderNumber) {
            return buildError("Order number is required.", 400, corsHeaders);
          }

          const promoValidation = validatePromoRequest(order.promoCode, order.subtotal);
          if (!promoValidation.valid) {
            return buildError(promoValidation.message, 400, corsHeaders);
          }

          const expectedDiscount = calculateDiscount(order.subtotal, order.promoCode);
          const expectedShipping = calculateShipping(order.subtotal, order.promoCode);
          const expectedTotal = Math.max(0, order.subtotal - expectedDiscount + expectedShipping);

          if (
            Number(order.discount) !== expectedDiscount ||
            Number(order.shipping) !== expectedShipping ||
            Number(order.total) !== expectedTotal
          ) {
            return buildError(
              "Promo validation failed: totals do not match the approved rule.",
              400,
              corsHeaders,
            );
          }

          const existing = await env.KOORTA_DB.prepare(
            "SELECT order_number FROM orders WHERE order_number = ?",
          )
            .bind(order.orderNumber)
            .first();
          if (existing) {
            return buildError("Order number already exists.", 409, corsHeaders);
          }

          const tx = await env.KOORTA_DB.prepare(
            `INSERT INTO orders (
                order_number,
                placed_at,
                customer_name,
                customer_email,
                customer_phone,
                customer_address,
                customer_city,
                customer_state,
                customer_district,
                customer_post_office,
                customer_pincode,
                customer_notes,
                payment_method,
                upi_id,
                subtotal,
                discount,
                promo_code,
                shipping,
                total,
                status,
                created_at,
                updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
            .bind(
              order.orderNumber,
              order.placedAt,
              order.customer.name,
              order.customer.email,
              order.customer.phone,
              order.customer.address,
              order.customer.city,
              order.customer.state,
              order.customer.district,
              order.customer.postOffice,
              order.customer.pincode,
              order.customer.notes || null,
              order.payment,
              order.upiId || null,
              order.subtotal,
              order.discount,
              order.promoCode || null,
              order.shipping,
              order.total,
              "pending",
              nowISOString(),
              nowISOString(),
            )
            .run();

          if (!tx.success) {
            return buildError("Failed to persist order.", 500, corsHeaders);
          }

          const itemInserts = env.KOORTA_DB.prepare(
            `INSERT INTO order_items (order_number, item_id, name, size, quantity, price, image_url) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          );

          for (const item of order.items) {
            await itemInserts
              .bind(
                order.orderNumber,
                item.itemId,
                item.name,
                item.size,
                item.qty,
                item.price,
                item.image || null,
              )
              .run();
          }

          try {
            await updateCatalogStockForOrder(env.GARMENT_BUCKET, order.items);
          } catch (error) {
            console.error("Catalog stock update failed after order insert:", error);
            return buildError(
              error instanceof Error ? error.message : "Stock update failed.",
              409,
              corsHeaders,
            );
          }

          const transactionId = `tx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          const transactionInsert = await env.KOORTA_DB.prepare(
            `INSERT INTO transactions (transaction_id, order_number, provider, method, status, amount, external_reference, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
            .bind(
              transactionId,
              order.orderNumber,
              order.payment === "upi" ? "upi" : "manual",
              order.payment,
              "pending",
              order.total,
              null,
              JSON.stringify({ orderPlacedVia: order.payment }),
              nowISOString(),
              nowISOString(),
            )
            .run();

          if (!transactionInsert.success) {
            return buildError("Failed to persist transaction details.", 500, corsHeaders);
          }

          const emailNotifications = await sendOrderNotifications(order, env);
          return jsonResponse(
            {
              success: true,
              orderNumber: order.orderNumber,
              status: "pending",
              transactionId,
              emailNotifications,
            },
            201,
            corsHeaders,
          );
        }
      }

      return buildError("Not found.", 404, corsHeaders);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `Worker exception: ${message}`,
        error instanceof Error ? { name: error.name, stack: error.stack } : undefined,
      );
      return buildError(`Internal worker error: ${message}`, 500, corsHeaders);
    }
  },
};

export {
  getShiprocketToken,
  getCorsHeaders,
  collectReservedReturnQuantities,
  isWithinReturnWindow,
  normalizePhone,
  restoreCatalogStockForOrder,
  verifyCloudflareAccess,
  verifyTurnstile,
};

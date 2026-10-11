function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...headers,
    },
  });
}

async function parseJson(request) {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) return null;
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
  return typeof value === 'string' ? value.trim() : '';
}

function ensureNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function formatCurrency(amount) {
  return `₹${Number(amount).toLocaleString('en-IN')}`;
}

function getOrderEmailContent(order, audience) {
  const isAdmin = audience === 'admin';
  const itemRows = order.items.map((item) => `
    <tr>
      <td style="padding:14px 12px;border-bottom:1px solid #eee8dc;">${escapeHtml(item.name)}<br><span style="color:#777;font-size:12px;">Size ${escapeHtml(item.size)}</span></td>
      <td style="padding:14px 12px;border-bottom:1px solid #eee8dc;text-align:center;">${item.qty}</td>
      <td style="padding:14px 12px;border-bottom:1px solid #eee8dc;text-align:right;">${formatCurrency(item.qty * item.price)}</td>
    </tr>`).join('');
  const address = [
    order.customer.address,
    `${order.customer.city}, ${order.customer.district}`,
    `${order.customer.state} ${order.customer.pincode}`,
    order.customer.postOffice,
  ].map(escapeHtml).join('<br>');
  const terms = `
    <h3 style="margin:24px 0 8px;color:#202947;font-size:14px;">A few helpful details</h3>
    <ul style="padding-left:20px;color:#625f58;font-size:13px;line-height:1.7;">
      <li>Every order is reviewed by our team and confirmed before dispatch; payment arrangements are confirmed with you.</li>
      <li>India delivery typically takes 2–4 working days to metros and 4–6 working days elsewhere.</li>
      <li>Eligible items may be returned within 15 days of delivery if unworn, unwashed, and with original tags. Reverse pickup and size exchanges are free; refunds are processed within 5 working days. Made-to-measure and altered items cannot be returned. Email hello@koorta.com to start a return.</li>
    </ul>
    <p style="font-size:12px;color:#777;">Full details: <a href="https://koorta.com/shipping" style="color:#202947;">Shipping</a> · <a href="https://koorta.com/returns" style="color:#202947;">Returns &amp; Exchanges</a></p>`;
  const customerDetails = isAdmin
    ? `<div style="margin-top:20px;padding:16px;border-radius:12px;background:#f8f6f0;">
        <h3 style="margin:0 0 8px;color:#202947;font-size:14px;">Customer &amp; delivery</h3>
        <p style="margin:0;color:#3d3b36;font-size:13px;line-height:1.7;">
          <strong>${escapeHtml(order.customer.name)}</strong><br>
          ${escapeHtml(order.customer.email || 'No email provided')}<br>
          ${escapeHtml(order.customer.phone)}<br>${address}
          ${order.customer.notes ? `<br><strong>Note:</strong> ${escapeHtml(order.customer.notes)}` : ''}
        </p>
      </div>`
    : `<div style="margin-top:20px;padding:16px;border-radius:12px;background:#f8f6f0;">
        <h3 style="margin:0 0 8px;color:#202947;font-size:14px;">Delivering to</h3>
        <p style="margin:0;color:#3d3b36;font-size:13px;line-height:1.7;">
          <strong>${escapeHtml(order.customer.name)}</strong><br>${address}<br>${escapeHtml(order.customer.phone)}
        </p>
      </div>`;
  const textLines = [
    isAdmin ? `New order ${order.orderNumber}` : `Thank you, ${order.customer.name}! Your order is placed.`,
    `Order: ${order.orderNumber}`,
    `Placed: ${new Date(order.placedAt).toLocaleString('en-IN')}`,
    '',
    'ORDER DETAILS',
    ...order.items.map((item) => `${item.name} — Size ${item.size} × ${item.qty}: ${formatCurrency(item.qty * item.price)}`),
    '',
    `Subtotal: ${formatCurrency(order.subtotal)}`,
    ...(order.discount > 0 ? [`Discount${order.promoCode ? ` (${order.promoCode})` : ''}: -${formatCurrency(order.discount)}`] : []),
    `Shipping: ${order.shipping === 0 ? 'Free' : formatCurrency(order.shipping)}`,
    `Total: ${formatCurrency(order.total)}`,
    `Payment: ${order.payment === 'upi' ? 'UPI (confirmation pending)' : 'Discuss & Pay'}`,
    '',
    isAdmin ? 'CUSTOMER & DELIVERY' : 'DELIVERY ADDRESS',
    order.customer.name,
    ...(isAdmin && order.customer.email ? [order.customer.email] : []),
    order.customer.phone,
    order.customer.address,
    `${order.customer.city}, ${order.customer.district}`,
    `${order.customer.state} ${order.customer.pincode}`,
    order.customer.postOffice,
    ...(order.customer.notes ? [`Note: ${order.customer.notes}`] : []),
    '',
    'TERMS & USEFUL INFORMATION',
    'Your order is reviewed and confirmed by our team before dispatch; payment arrangements are confirmed with you.',
    'India delivery typically takes 2–4 working days to metros and 4–6 working days elsewhere.',
    'Eligible items may be returned within 15 days of delivery if unworn, unwashed, and with original tags. Reverse pickup and size exchanges are free; refunds are processed within 5 working days. Made-to-measure and altered items cannot be returned. Email hello@koorta.com to start a return.',
    'Shipping: https://koorta.com/shipping',
    'Returns: https://koorta.com/returns',
  ];

  return {
    subject: isAdmin
      ? `New Koorta order ${order.orderNumber.replace(/[\r\n]+/g, ' ')}`
      : `Your Koorta order is placed — ${order.orderNumber.replace(/[\r\n]+/g, ' ')}`,
    text: textLines.join('\n'),
    html: `
      <div style="margin:0;background:#f5f2eb;padding:28px 12px;font-family:Arial,Helvetica,sans-serif;color:#292821;">
        <div style="max-width:620px;margin:0 auto;border-radius:18px;overflow:hidden;background:#fff;box-shadow:0 12px 36px rgba(32,41,71,.08);">
          <div style="padding:30px 28px;background:#202947;color:#fff;">
            <p style="margin:0 0 10px;color:#d6b978;font-size:11px;font-weight:bold;letter-spacing:3px;">KOORTA · HANDCRAFTED MENSWEAR</p>
            <h1 style="margin:0;font-family:Georgia,serif;font-size:27px;font-weight:normal;">${isAdmin ? 'A new order has arrived' : `Thank you, ${escapeHtml(order.customer.name)}!`}</h1>
            <p style="margin:10px 0 0;color:#e3e4eb;font-size:14px;">${isAdmin ? 'Order details for your team' : 'Your order is placed and our team will review it before dispatch.'}</p>
          </div>
          <div style="padding:24px 28px;">
            <div style="display:flex;justify-content:space-between;gap:12px;padding-bottom:16px;border-bottom:1px solid #eee8dc;">
              <div><span style="display:block;color:#777;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Order number</span><strong style="display:block;margin-top:5px;color:#202947;font-size:18px;">${escapeHtml(order.orderNumber)}</strong></div>
              <div style="text-align:right;"><span style="display:block;color:#777;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Placed</span><strong style="display:block;margin-top:5px;font-size:13px;">${escapeHtml(new Date(order.placedAt).toLocaleString('en-IN'))}</strong></div>
            </div>
            <table role="presentation" style="width:100%;margin-top:12px;border-collapse:collapse;font-size:13px;">
              <thead><tr style="color:#777;font-size:11px;text-transform:uppercase;letter-spacing:.7px;"><th style="padding:10px 12px;text-align:left;">Piece</th><th style="padding:10px 12px;">Qty</th><th style="padding:10px 12px;text-align:right;">Amount</th></tr></thead>
              <tbody>${itemRows}</tbody>
            </table>
            <div style="max-width:270px;margin:16px 0 0 auto;color:#625f58;font-size:13px;line-height:1.8;">
              <div style="display:flex;justify-content:space-between;"><span>Subtotal</span><span>${formatCurrency(order.subtotal)}</span></div>
              ${order.discount > 0 ? `<div style="display:flex;justify-content:space-between;"><span>Discount${order.promoCode ? ` (${escapeHtml(order.promoCode)})` : ''}</span><span>−${formatCurrency(order.discount)}</span></div>` : ''}
              <div style="display:flex;justify-content:space-between;"><span>Shipping</span><span>${order.shipping === 0 ? 'Free' : formatCurrency(order.shipping)}</span></div>
              <div style="display:flex;justify-content:space-between;margin-top:8px;padding-top:8px;border-top:1px solid #eee8dc;color:#202947;font-size:16px;font-weight:bold;"><span>Total</span><span>${formatCurrency(order.total)}</span></div>
              <div style="margin-top:6px;text-align:right;font-size:12px;">Payment: ${order.payment === 'upi' ? 'UPI · confirmation pending' : 'Discuss &amp; Pay'}</div>
            </div>
            ${customerDetails}
            ${terms}
            <p style="margin:24px 0 0;padding-top:18px;border-top:1px solid #eee8dc;color:#777;font-size:12px;line-height:1.6;">Questions? Reply to this email or contact <a href="mailto:hello@koorta.com" style="color:#202947;">hello@koorta.com</a>.<br>With care, <strong style="color:#202947;">Team Koorta</strong></p>
          </div>
        </div>
      </div>`,
  };
}

async function sendResendEmail(env, { to, subject, text, html }) {
  if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not configured.');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL || 'Koorta Orders <orders@koorta.com>',
      to: [to],
      subject,
      text,
      html,
    }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Resend request failed (${response.status}): ${sanitizeString(result?.message) || response.statusText}`);
  }
}

async function sendOrderNotifications(order, env) {
  const recipients = [
    { role: 'admin', email: 'admin@koorta.com' },
    ...(order.customer.email ? [{ role: 'customer', email: order.customer.email }] : []),
  ];
  const results = await Promise.all(recipients.map(async ({ role, email }) => {
    try {
      const content = getOrderEmailContent(order, role);
      await sendResendEmail(env, { to: email, ...content });
      return { role, status: 'sent' };
    } catch (error) {
      console.error(`Order email delivery failed for ${role} (${order.orderNumber}):`, error);
      return { role, status: 'failed' };
    }
  }));
  return results;
}

function validateOrderPayload(payload) {
  if (!payload || typeof payload !== 'object') return 'Request body must be a JSON object.';

  const customer = payload.customer || {};
  if (!sanitizeString(customer.name)) return 'Customer name is required.';
  const customerEmail = sanitizeString(customer.email);
  if (customerEmail && (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(customerEmail) || customerEmail.length > 255)) {
    return 'Customer email must be a valid email address.';
  }
  if (!sanitizeString(customer.phone)) return 'Customer phone is required.';
  if (!sanitizeString(customer.address)) return 'Customer address is required.';
  if (!sanitizeString(customer.city)) return 'Customer city is required.';
  if (!sanitizeString(customer.state)) return 'Customer state is required.';
  if (!sanitizeString(customer.district)) return 'Customer district is required.';
  if (!sanitizeString(customer.postOffice)) return 'Customer post office is required.';
  if (!sanitizeString(customer.pincode)) return 'Customer PIN code is required.';

  if (!Array.isArray(payload.items) || payload.items.length === 0) return 'Order items are required.';
  for (const item of payload.items) {
    if (!sanitizeString(item.id)) return 'Order item id is required.';
    if (!sanitizeString(item.name)) return 'Order item name is required.';
    if (!sanitizeString(item.size)) return 'Order item size is required.';
    if (!ensureNumber(item.qty) || item.qty <= 0) return 'Order item quantity must be a positive integer.';
    if (!ensureNumber(item.price) || item.price < 0) return 'Order item price must be a non-negative integer.';
  }

  const paymentMethod = sanitizeString(payload.payment);
  if (paymentMethod !== 'upi' && paymentMethod !== 'discuss') return 'Payment method must be either "upi" or "discuss".';

  if (ensureNumber(payload.subtotal) === null) return 'Order subtotal is required.';
  if (ensureNumber(payload.discount) === null) return 'Order discount is required.';
  if (ensureNumber(payload.shipping) === null) return 'Order shipping is required.';
  if (ensureNumber(payload.total) === null) return 'Order total is required.';

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
  KOORTA10: { code: 'KOORTA10', type: 'pct', value: 10, label: '10% off your order', minSubtotal: 0, active: true },
  FESTIVE15: { code: 'FESTIVE15', type: 'pct', value: 15, label: '15% festive discount', minSubtotal: 4000, active: true },
  BULK30: { code: 'BULK30', type: 'pct', value: 30, label: '30% bulk order discount', minSubtotal: 12000, active: true },
  FREESHIP: { code: 'FREESHIP', type: 'shipping', value: 0, label: 'Free shipping', minSubtotal: 1999, active: true },
};

function normalizePromoCode(code) {
  return typeof code === 'string' ? code.trim().toUpperCase() : '';
}

function getPromoRule(code) {
  const normalized = normalizePromoCode(code);
  return normalized ? PROMO_RULES[normalized] || null : null;
}

function calculateDiscount(subtotal, promoCode) {
  const rule = getPromoRule(promoCode);
  if (!rule || !rule.active) return 0;
  if (subtotal < (rule.minSubtotal ?? 0)) return 0;

  if (rule.type === 'pct') {
    return Math.round((subtotal * rule.value) / 100);
  }

  if (rule.type === 'flat') {
    return Math.min(rule.value, subtotal);
  }

  return 0;
}

function calculateShipping(subtotal, promoCode) {
  const rule = getPromoRule(promoCode);
  if (rule && rule.type === 'shipping' && subtotal >= (rule.minSubtotal ?? 0)) {
    return 0;
  }
  return subtotal > 0 && subtotal < 1999 ? 99 : 0;
}

function validatePromoRequest(code, subtotal) {
  const normalized = normalizePromoCode(code);
  if (!normalized) {
    const shipping = calculateShipping(Number(subtotal), '');
    return {
      valid: true,
      message: 'No promo code applied.',
      rule: null,
      discount: 0,
      shipping,
      total: Math.max(0, Number(subtotal) + shipping),
    };
  }

  const rule = getPromoRule(normalized);
  if (!rule || !rule.active) {
    return { valid: false, message: 'Invalid promo code.' };
  }

  if (Number(subtotal) < (rule.minSubtotal ?? 0)) {
    return {
      valid: false,
      message: `Requires a subtotal of ₹${(rule.minSubtotal ?? 0).toLocaleString('en-IN')}.`,
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
  const cleaned = String(pathname || '').replace(/\/+/g, '/').replace(/\/+$/, '');
  if (cleaned === '') return '/';
  return cleaned;
}

function getCorsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': String(env.ALLOWED_ORIGIN || '*'),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Koorta-Db-Api-Key',
  };
}

async function getOrder(db, orderNumber) {
  const orderResult = await db
    .prepare('SELECT * FROM orders WHERE order_number = ?')
    .bind(orderNumber)
    .first();

  if (!orderResult) return null;

  const itemsResult = await db
    .prepare('SELECT item_id, name, size, quantity, price, image_url FROM order_items WHERE order_number = ?')
    .bind(orderNumber)
    .all();

  const transactionsResult = await db
    .prepare('SELECT transaction_id, provider, method, status, amount, external_reference, metadata, created_at, updated_at FROM transactions WHERE order_number = ?')
    .bind(orderNumber)
    .all();

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
      metadata: t.metadata ? JSON.parse(t.metadata) : null,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
    })),
  };
}

async function readCatalog(bucket) {
  if (!bucket || typeof bucket.get !== 'function') return [];

  const object = await bucket.get('product.json');
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
  if (!bucket || typeof bucket.put !== 'function') return products;
  await bucket.put('product.json', JSON.stringify(products, null, 2), {
    cacheControl: 'public, max-age=31536000, immutable',
  });
  return products;
}

async function updateCatalogStockForOrder(bucket, orderItems) {
  if (!bucket || typeof bucket.get !== 'function') {
    throw new Error('Catalog bucket is not configured for stock updates.');
  }

  const catalog = await readCatalog(bucket);
  if (!Array.isArray(catalog) || catalog.length === 0) {
    throw new Error('Catalog is empty; stock cannot be decremented.');
  }

  const catalogById = new Map(catalog.map((product) => [String(product.id), product]));
  const productUpdates = new Map();

  for (const item of orderItems) {
    const productId = String(item.itemId || item.id || '').trim();
    const sizeKey = String(item.size || '').trim();
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

    const stockBySize = product.stockBySize && typeof product.stockBySize === 'object' && !Array.isArray(product.stockBySize)
      ? { ...product.stockBySize }
      : {};
    const available = Number(stockBySize[sizeKey]);

    if (!Number.isFinite(available) || available < requestedQty) {
      throw new Error(`Insufficient stock for ${product.name || productId} in size ${sizeKey}. Available: ${Number.isFinite(available) ? available : 0}, requested: ${requestedQty}.`);
    }

    const updatedProduct = productUpdates.get(productId) || structuredClone(product);
    const nextStockBySize = updatedProduct.stockBySize && typeof updatedProduct.stockBySize === 'object' && !Array.isArray(updatedProduct.stockBySize)
      ? { ...updatedProduct.stockBySize }
      : {};
    const nextAvailable = Number(nextStockBySize[sizeKey] ?? stockBySize[sizeKey] ?? 0);

    if (!Number.isFinite(nextAvailable) || nextAvailable < requestedQty) {
      throw new Error(`Insufficient stock for ${updatedProduct.name || productId} in size ${sizeKey}. Available: ${Number.isFinite(nextAvailable) ? nextAvailable : 0}, requested: ${requestedQty}.`);
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const route = normalizeRoute(url.pathname);
    const corsHeaders = getCorsHeaders(env);

    try {
      if (method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            ...corsHeaders,
            'Access-Control-Max-Age': '86400',
          },
        });
      }

      if (!env.KOORTA_DB) {
        return buildError('D1 binding KOORTA_DB is not configured.', 500, corsHeaders);
      }

      if (route.startsWith('/orders') && !env.GARMENT_BUCKET) {
        return buildError('Catalog bucket GARMENT_BUCKET is not configured for stock updates.', 500, corsHeaders);
      }

      if (route === '/') {
        return jsonResponse({ success: true, message: 'Koorta DB API is running.' }, 200, corsHeaders);
      }

      if (route === '/promo/validate') {
        if (method !== 'POST') {
          return buildError('Method not allowed.', 405, corsHeaders);
        }

        const apiKey = request.headers.get('x-koorta-db-api-key') || '';
        if (!env.KOORTA_DB_WORKER_API_SECRET || apiKey !== env.KOORTA_DB_WORKER_API_SECRET) {
          return buildError('Unauthorized request.', 401, corsHeaders);
        }

        const payload = await parseJson(request);
        if (!payload || typeof payload !== 'object') {
          return buildError('Request body must be a JSON object.', 400, corsHeaders);
        }

        const subtotal = ensureNumber(payload.subtotal);
        if (subtotal === null) {
          return buildError('Order subtotal is required.', 400, corsHeaders);
        }

        const validation = validatePromoRequest(payload.code, subtotal);
        return jsonResponse(validation, 200, corsHeaders);
      }

      if (route.startsWith('/orders')) {
        if (method === 'GET') {
          const parts = route.split('/').filter(Boolean);
          if (parts.length === 2) {
            const orderNumber = parts[1];
            const record = await getOrder(env.KOORTA_DB, orderNumber);
            if (!record) return buildError('Order not found.', 404, corsHeaders);
            return jsonResponse({ success: true, order: record }, 200, corsHeaders);
          }

          const email = String(url.searchParams.get('email') || '').trim();
          const phone = String(url.searchParams.get('phone') || '').trim();
          if (!email && !phone) {
            return buildError('Provide email or phone to look up orders.', 400, corsHeaders);
          }

          const conditions = [];
          const values = [];
          if (email) {
            conditions.push('customer_email = ?');
            values.push(email);
          }
          if (phone) {
            conditions.push('customer_phone = ?');
            values.push(phone);
          }

          const query = `SELECT * FROM orders WHERE ${conditions.join(' OR ')} ORDER BY placed_at DESC LIMIT 50`;
          const ordersResult = await env.KOORTA_DB.prepare(query).bind(...values).all();
          const orders = ordersResult.results || [];

          if (orders.length === 0) {
            return jsonResponse({ success: true, orders: [] }, 200, corsHeaders);
          }

          const orderNumbers = orders.map((r) => r.order_number);
          const placeholders = orderNumbers.map(() => '?').join(',');

          const itemsQuery = `SELECT order_number, item_id, name, size, quantity, price, image_url FROM order_items WHERE order_number IN (${placeholders})`;
          const itemsResult = await env.KOORTA_DB.prepare(itemsQuery).bind(...orderNumbers).all();
          const items = itemsResult.results || [];

          const txQuery = `SELECT order_number, transaction_id, provider, method, status, amount, external_reference, metadata, created_at, updated_at FROM transactions WHERE order_number IN (${placeholders})`;
          const txResult = await env.KOORTA_DB.prepare(txQuery).bind(...orderNumbers).all();
          const txs = txResult.results || [];

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
              metadata: t.metadata ? JSON.parse(t.metadata) : null,
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
            items: itemsByOrder[orderRow.order_number] || [],
            transactions: txByOrder[orderRow.order_number] || [],
          }));

          return jsonResponse({ success: true, orders: assembled }, 200, corsHeaders);
        }

        if (method === 'POST') {
          const apiKey = request.headers.get('x-koorta-db-api-key') || '';
          if (!env.KOORTA_DB_WORKER_API_SECRET || apiKey !== env.KOORTA_DB_WORKER_API_SECRET) {
            return buildError('Unauthorized request.', 401, corsHeaders);
          }

          const payload = await parseJson(request);
          const validationError = validateOrderPayload(payload);
          if (validationError) {
            return buildError(validationError, 400, corsHeaders);
          }

          const order = normalizeOrderPayload(payload);
          if (!order.orderNumber) {
            return buildError('Order number is required.', 400, corsHeaders);
          }

          const promoValidation = validatePromoRequest(order.promoCode, order.subtotal);
          if (!promoValidation.valid) {
            return buildError(promoValidation.message, 400, corsHeaders);
          }

          const expectedDiscount = calculateDiscount(order.subtotal, order.promoCode);
          const expectedShipping = calculateShipping(order.subtotal, order.promoCode);
          const expectedTotal = Math.max(0, order.subtotal - expectedDiscount + expectedShipping);

          if (Number(order.discount) !== expectedDiscount || Number(order.shipping) !== expectedShipping || Number(order.total) !== expectedTotal) {
            return buildError('Promo validation failed: totals do not match the approved rule.', 400, corsHeaders);
          }

          const existing = await env.KOORTA_DB.prepare('SELECT order_number FROM orders WHERE order_number = ?').bind(order.orderNumber).first();
          if (existing) {
            return buildError('Order number already exists.', 409, corsHeaders);
          }

          const tx = await env.KOORTA_DB
            .prepare(
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
              'pending',
              nowISOString(),
              nowISOString(),
            )
            .run();

          if (!tx.success) {
            return buildError('Failed to persist order.', 500, corsHeaders);
          }

          const itemInserts = env.KOORTA_DB.prepare(
            `INSERT INTO order_items (order_number, item_id, name, size, quantity, price, image_url) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          );

          for (const item of order.items) {
            await itemInserts.bind(
              order.orderNumber,
              item.itemId,
              item.name,
              item.size,
              item.qty,
              item.price,
              item.image || null,
            ).run();
          }

          try {
            await updateCatalogStockForOrder(env.GARMENT_BUCKET, order.items);
          } catch (error) {
            console.error('Catalog stock update failed after order insert:', error);
            return buildError(error instanceof Error ? error.message : 'Stock update failed.', 409, corsHeaders);
          }

          const transactionId = `tx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          const transactionInsert = await env.KOORTA_DB.prepare(
            `INSERT INTO transactions (transaction_id, order_number, provider, method, status, amount, external_reference, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
            .bind(
              transactionId,
              order.orderNumber,
              order.payment === 'upi' ? 'upi' : 'manual',
              order.payment,
              'pending',
              order.total,
              null,
              JSON.stringify({ orderPlacedVia: order.payment }),
              nowISOString(),
              nowISOString(),
            )
            .run();

          if (!transactionInsert.success) {
            return buildError('Failed to persist transaction details.', 500, corsHeaders);
          }

          const emailNotifications = await sendOrderNotifications(order, env);
          return jsonResponse({
            success: true,
            orderNumber: order.orderNumber,
            status: 'pending',
            transactionId,
            emailNotifications,
          }, 201, corsHeaders);
        }
      }

      return buildError('Not found.', 404, corsHeaders);
    } catch (error) {
      console.error('Worker exception:', error);
      const message = error instanceof Error ? error.message : String(error);
      return buildError(`Internal worker error: ${message}`, 500, corsHeaders);
    }
  },
};

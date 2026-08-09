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

function validateOrderPayload(payload) {
  if (!payload || typeof payload !== 'object') return 'Request body must be a JSON object.';

  const customer = payload.customer || {};
  if (!sanitizeString(customer.name)) return 'Customer name is required.';
  if (!sanitizeString(customer.email)) return 'Customer email is required.';
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
  };
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

      if (route === '/') {
        return jsonResponse({ success: true, message: 'Koorta DB API is running.' }, 200, corsHeaders);
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

          const query = `SELECT order_number, placed_at, payment_method, total, status FROM orders WHERE ${conditions.join(' OR ')} ORDER BY placed_at DESC LIMIT 25`;
          const listResult = await env.KOORTA_DB.prepare(query).bind(...values).all();
          return jsonResponse({ success: true, orders: listResult.results || [] }, 200, corsHeaders);
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
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

          return jsonResponse({ success: true, orderNumber: order.orderNumber, status: 'pending', transactionId }, 201, corsHeaders);
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

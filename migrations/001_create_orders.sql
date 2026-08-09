CREATE TABLE IF NOT EXISTS orders (
  order_number TEXT PRIMARY KEY,
  placed_at TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  customer_address TEXT NOT NULL,
  customer_city TEXT NOT NULL,
  customer_state TEXT NOT NULL,
  customer_district TEXT NOT NULL,
  customer_post_office TEXT NOT NULL,
  customer_pincode TEXT NOT NULL,
  customer_notes TEXT,
  payment_method TEXT NOT NULL,
  upi_id TEXT,
  subtotal INTEGER NOT NULL,
  discount INTEGER NOT NULL,
  promo_code TEXT,
  shipping INTEGER NOT NULL,
  total INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number TEXT NOT NULL,
  item_id TEXT NOT NULL,
  name TEXT NOT NULL,
  size TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  price INTEGER NOT NULL,
  image_url TEXT,
  FOREIGN KEY(order_number) REFERENCES orders(order_number)
);

CREATE TABLE IF NOT EXISTS transactions (
  transaction_id TEXT PRIMARY KEY,
  order_number TEXT NOT NULL,
  provider TEXT NOT NULL,
  method TEXT NOT NULL,
  status TEXT NOT NULL,
  amount INTEGER NOT NULL,
  external_reference TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(order_number) REFERENCES orders(order_number)
);

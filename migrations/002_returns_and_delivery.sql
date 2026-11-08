ALTER TABLE orders ADD COLUMN delivered_at TEXT;

CREATE INDEX IF NOT EXISTS idx_transactions_order_status
  ON transactions(order_number, status);

CREATE INDEX IF NOT EXISTS idx_order_items_order_item_size
  ON order_items(order_number, item_id, size);

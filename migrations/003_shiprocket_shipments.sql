CREATE TABLE IF NOT EXISTS order_shipments (
  id TEXT PRIMARY KEY,
  order_number TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('forward', 'reverse')),
  return_transaction_id TEXT,
  external_order_reference TEXT NOT NULL,
  shiprocket_order_id TEXT,
  shiprocket_shipment_id TEXT,
  awb TEXT,
  courier_name TEXT,
  status TEXT NOT NULL,
  last_event TEXT,
  manifest_url TEXT,
  error TEXT,
  manual INTEGER NOT NULL DEFAULT 0,
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(order_number) REFERENCES orders(order_number),
  FOREIGN KEY(return_transaction_id) REFERENCES transactions(transaction_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_order_shipments_forward
  ON order_shipments(order_number)
  WHERE direction = 'forward';

CREATE UNIQUE INDEX IF NOT EXISTS idx_order_shipments_return
  ON order_shipments(return_transaction_id)
  WHERE direction = 'reverse' AND return_transaction_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_order_shipments_external_reference
  ON order_shipments(external_order_reference);

CREATE INDEX IF NOT EXISTS idx_order_shipments_awb
  ON order_shipments(awb);

CREATE INDEX IF NOT EXISTS idx_order_shipments_shipment_id
  ON order_shipments(shiprocket_shipment_id);

CREATE TABLE menu_product_inventory (
    store_id text NOT NULL,
    sku text NOT NULL,
    on_hand integer NOT NULL CHECK (on_hand >= 0),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    PRIMARY KEY (store_id, sku),
    FOREIGN KEY (store_id, sku) REFERENCES menu_products(store_id, sku)
);

CREATE INDEX orders_active_inventory ON orders(store_id, reservation_expires_at)
    WHERE status = 'awaiting_payment';

CREATE TABLE operator_inventory_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id text NOT NULL,
    sku text NOT NULL,
    operator_id uuid NOT NULL REFERENCES operator_accounts(id),
    previous_on_hand integer CHECK (previous_on_hand >= 0),
    new_on_hand integer NOT NULL CHECK (new_on_hand >= 0),
    inventory_revision bigint NOT NULL CHECK (inventory_revision > 0),
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (previous_on_hand IS DISTINCT FROM new_on_hand),
    FOREIGN KEY (store_id, sku) REFERENCES menu_product_inventory(store_id, sku),
    UNIQUE (store_id, sku, inventory_revision)
);

CREATE TRIGGER operator_inventory_events_no_rewrite
    BEFORE UPDATE OR DELETE OR TRUNCATE ON operator_inventory_events
    FOR EACH STATEMENT EXECUTE FUNCTION prevent_availability_event_rewrite();

CREATE FUNCTION catalog_reserved_product_units(
    target_store text, target_sku text, checked_at timestamptz
) RETURNS bigint
LANGUAGE sql STABLE STRICT AS $$
    SELECT COALESCE(sum(item.quantity), 0)
    FROM orders o
    CROSS JOIN LATERAL jsonb_to_recordset(o.lines) AS item(sku text, quantity integer)
    WHERE o.store_id = target_store AND o.status = 'awaiting_payment'
        AND o.reservation_expires_at > checked_at AND item.sku = target_sku
$$;

CREATE FUNCTION catalog_product_has_stock(
    target_store text, target_sku text, checked_at timestamptz
) RETURNS boolean
LANGUAGE sql STABLE STRICT AS $$
    SELECT COALESCE((
        SELECT i.on_hand > catalog_reserved_product_units(target_store, target_sku, checked_at)
        FROM menu_product_inventory i WHERE i.store_id = target_store AND i.sku = target_sku
    ), true)
$$;

CREATE FUNCTION catalog_product_stock_available_from(
    target_store text, target_sku text, checked_at timestamptz
) RETURNS timestamptz
LANGUAGE plpgsql STABLE STRICT AS $$
DECLARE
    portions integer;
BEGIN
    SELECT i.on_hand INTO portions
    FROM menu_product_inventory i
    WHERE i.store_id = target_store AND i.sku = target_sku;
    IF NOT FOUND THEN RETURN checked_at; END IF;
    IF portions = 0 THEN RETURN NULL; END IF;

    RETURN (
        WITH expirations AS (
            SELECT o.reservation_expires_at AS expires_at, sum(item.quantity) AS held
            FROM orders o
            CROSS JOIN LATERAL jsonb_to_recordset(o.lines) AS item(sku text, quantity integer)
            WHERE o.store_id = target_store AND o.status = 'awaiting_payment'
                AND o.reservation_expires_at > checked_at AND item.sku = target_sku
            GROUP BY o.reservation_expires_at
        ), balances AS (
            SELECT expires_at, sum(held) OVER () AS total_held,
                coalesce(sum(held) OVER (ORDER BY expires_at ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING), 0)
                    AS held_after
            FROM expirations
        )
        SELECT CASE WHEN coalesce(max(total_held), 0) < portions THEN checked_at
            ELSE min(expires_at) FILTER (WHERE held_after < portions) END
        FROM balances
    );
END;
$$;

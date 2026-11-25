ALTER TABLE operator_order_events DROP CONSTRAINT operator_order_events_check;

ALTER TABLE operator_order_events ADD CONSTRAINT operator_order_event_transition CHECK (
    (previous_status = 'accepted' AND requested_status = 'preparing' AND outcome = 'changed')
    OR (previous_status = 'preparing' AND requested_status = 'ready' AND outcome = 'changed')
    OR (previous_status = 'ready' AND requested_status = 'collected')
    OR (previous_status IN ('accepted', 'preparing', 'ready') AND requested_status = 'cancelled'
        AND operator_role = 'manager' AND outcome = 'changed')
);

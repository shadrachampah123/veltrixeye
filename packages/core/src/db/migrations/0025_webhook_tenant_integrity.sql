-- 0025: bind webhook deliveries to the owning alert and strategy
--
-- Additive only. Composite keys make the database enforce that a delivery's
-- alert, user and strategy describe the same tenant-owned alert.

CREATE UNIQUE INDEX alerts_id_user_uniq ON alerts (id, user_id);
CREATE UNIQUE INDEX alerts_id_strategy_uniq ON alerts (id, strategy_id);

ALTER TABLE notification_webhook_deliveries
  ADD CONSTRAINT notification_webhook_alert_user_fk
    FOREIGN KEY (alert_id, user_id) REFERENCES alerts (id, user_id) ON DELETE CASCADE,
  ADD CONSTRAINT notification_webhook_alert_strategy_fk
    FOREIGN KEY (alert_id, strategy_id) REFERENCES alerts (id, strategy_id) ON DELETE CASCADE;

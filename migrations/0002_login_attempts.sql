-- Fixed-window sign-in attempt counters keyed by 'email:<address>' or 'ip:<address>'.
CREATE TABLE login_attempt (key TEXT PRIMARY KEY, window_start TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);

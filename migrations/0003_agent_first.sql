-- Agent-first notebook: sites are keyed by domain, changes carry old -> new values,
-- and humans authenticate through Cloudflare Access instead of app passwords.
ALTER TABLE client ADD COLUMN domain TEXT;
CREATE UNIQUE INDEX client_org_domain ON client(org_id, domain);
ALTER TABLE change_entry ADD COLUMN diff TEXT NOT NULL DEFAULT '[]';
DROP TABLE session;
DROP TABLE invite;
DROP TABLE login_attempt;

-- Archiving now wipes a server's sealed credential; rows archived before that still hold theirs.
UPDATE "mcp_servers" SET "encrypted_auth" = NULL, "auth_last4" = NULL WHERE "archived_at" IS NOT NULL AND ("encrypted_auth" IS NOT NULL OR "auth_last4" IS NOT NULL);

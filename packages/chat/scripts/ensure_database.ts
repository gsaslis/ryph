// Creates the chat service's database if the server lacks it, before drizzle-kit runs; @ryph/db/ensure.
import { ensureDatabase } from "@ryph/db/ensure";

await ensureDatabase("RYPH_CHAT_DB");

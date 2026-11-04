// Runs the fake on its own, seeded with an admin, a bot at Developer and one project, for poking
// at by hand: `bun run start -- --port 8929 [--base-path /gitlab] [--hook-url URL --hook-master S]`.
// Prints the URL and the tokens as JSON, then serves until interrupted.

import { parseArgs } from "node:util";
import { startFakeGitlab } from "./fake.ts";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    port: { type: "string", default: "8929" },
    "base-path": { type: "string" },
    "hook-url": { type: "string" },
    "hook-master": { type: "string" },
  },
});

const fake = await startFakeGitlab({ port: Number(values.port), basePath: values["base-path"] });
fake.addUser({ username: "root", name: "Administrator", admin: true });
fake.addUser({ username: "ryph-bot", name: "ryph", bot: true });
fake.addGroup("acme", { visibility: "private" });
await fake.addProject("acme/widgets", { files: { "README.md": "# widgets\n" } });
fake.addMember("acme", "root", "owner");
fake.addMember("acme/widgets", "ryph-bot", "developer");
if (values["hook-url"] && values["hook-master"]) {
  fake.addRyphHook("acme/widgets", { url: values["hook-url"], master: values["hook-master"] });
}
console.log(JSON.stringify(
  {
    url: fake.url,
    rootToken: fake.token("root"),
    botToken: fake.token("ryph-bot"),
  },
  null,
  2,
));

const stop = async () => {
  await fake.shutdown();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

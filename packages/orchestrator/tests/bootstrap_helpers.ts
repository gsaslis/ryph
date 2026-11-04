import { assertEquals } from "@std/assert";

const fetched = new WeakMap<Record<string, string>, Promise<Record<string, string>>>();

/** Simulate one boot per launch, retaining credentials in the test runner, not launch.env. */
export function bootstrapEnv(
  handler: (req: Request) => Promise<Response>,
  env: Record<string, string>,
): Promise<Record<string, string>> {
  let result = fetched.get(env);
  if (!result) {
    result = (async () => {
      const response = await handler(
        new Request(
          `http://orchestrator.test/v1/runs/${env.RYPH_RUN_ID}/bootstrap`,
          { method: "POST", headers: { authorization: `Bearer ${env.RYPH_BOOTSTRAP_TOKEN}` } },
        ),
      );
      assertEquals(response.status, 200, await response.clone().text());
      return (await response.json()).env;
    })();
    fetched.set(env, result);
  }
  return result;
}

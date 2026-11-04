// The migration lock wrapper (ryph/files/migrate-locked.ts) never prints anything derived from the
// database URL: not on a URL the driver refuses, not on a failed login, not when the connection
// drops while it waits for the lock. Each case checks stdout and stderr for the password and every
// fragment of it a parser could cut it into. It also connects through a session-mode pooler, which
// refuses any startup parameter it does not track.
import { expect, test } from "bun:test";

const WRAPPER = new URL("./ryph/files/migrate-locked.ts", import.meta.url).pathname;
// The wrapper resolves `postgres` from its working directory, as in the image: a package with it.
const DB_PACKAGE = new URL("../../packages/db", import.meta.url).pathname;

async function runWrapper(
  url: string,
  extraEnv: Record<string, string> = {},
  command: string[] = ["true"],
) {
  const child = Bun.spawn([process.execPath, "--no-env-file", WRAPPER, "RYPH_DB", ...command], {
    cwd: DB_PACKAGE,
    env: { PATH: process.env.PATH ?? "", RYPH_DB: url, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { status, output: `${out}${err}` };
}

function expectNoneOf(output: string, fragments: string[]) {
  for (const f of fragments) expect(output).not.toContain(f);
  // Never an error object either: no stack, no driver options.
  expect(output).not.toMatch(/\n\s+at |password|options|PostgresError/i);
}

// ── a fake Postgres speaking just enough of the protocol for the wrapper's queries

type Mode =
  | "refuse-login"
  | "drop-at-holder"
  | "drop-at-second-lock"
  | "drop-while-running"
  | "session-pooler";

// The startup parameters a default PgBouncer tracks; it refuses a connection carrying any other.
const POOLER_PARAMS = new Set([
  "user",
  "database",
  "replication",
  "application_name",
  "client_encoding",
  "datestyle",
  "timezone",
  "standard_conforming_strings",
  "intervalstyle",
]);

function message(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.write(type, 0);
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}
const cstr = (s: string) => Buffer.from(`${s}\0`);
function int16(n: number) {
  const b = Buffer.alloc(2);
  b.writeInt16BE(n);
  return b;
}
function int32(n: number) {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
}

/** Columns (name, type oid) and text rows a query answers with; null: drop the connection. */
type Answer = { columns: [string, number][]; rows: string[][] } | null;

function fakePostgres(mode: Mode) {
  let lockQueries = 0;
  /** `executing`: an Execute, counted; a Describe asks the same query's shape first. */
  function answer(query: string, executing = false): Answer {
    if (query.includes("pg_try_advisory_lock")) {
      if (executing) lockQueries++;
      if (mode === "drop-at-second-lock" && lockQueries >= 2) return null;
      const granted = mode === "drop-while-running" || mode === "session-pooler";
      return { columns: [["locked", 16], ["pid", 23]], rows: [[granted ? "t" : "f", "4242"]] };
    }
    if (query.includes("pg_backend_pid")) {
      return { columns: [["pid", 23]], rows: [["4242"]] };
    }
    if (query.includes("pg_locks")) {
      if (mode === "drop-at-holder") return null;
      const cols = ["pid", "application_name", "client_addr", "backend_start", "state"];
      return { columns: cols.map((c) => [c, 25] as [string, number]), rows: [] };
    }
    if (query.includes("set_config")) {
      return { columns: [["a", 25], ["b", 25], ["c", 25]], rows: [["0", "0", "0"]] };
    }
    // The driver's own type lookup, and anything else: no rows.
    return { columns: [["oid", 26], ["typarray", 26]], rows: [] };
  }
  const rowDescription = (a: NonNullable<Answer>) =>
    message(
      "T",
      Buffer.concat([
        int16(a.columns.length),
        ...a.columns.map(([name, oid]) =>
          Buffer.concat([
            cstr(name),
            int32(0),
            int16(0),
            int32(oid),
            int16(-1),
            int32(-1),
            int16(0),
          ])
        ),
      ]),
    );

  return Bun.listen<
    { buf: Buffer; started: boolean; statements: Map<string, string>; portal: string }
  >({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.data = { buf: Buffer.alloc(0), started: false, statements: new Map(), portal: "" };
      },
      data(socket, chunk) {
        const st = socket.data;
        st.buf = Buffer.concat([st.buf, Buffer.from(chunk)]);
        const out: Buffer[] = [];
        for (;;) {
          if (!st.started) {
            if (st.buf.length < 8) break;
            const len = st.buf.readInt32BE(0);
            if (st.buf.length < len) break;
            const code = st.buf.readInt32BE(4);
            const startup = st.buf.subarray(8, len);
            st.buf = st.buf.subarray(len);
            if (code === 80877103) {
              out.push(Buffer.from("N"));
              continue;
            }
            st.started = true;
            const params = startup.toString("latin1").split("\0")
              .filter((_, i) => i % 2 === 0).filter(Boolean);
            const untracked = params.find((p) => !POOLER_PARAMS.has(p.toLowerCase()));
            if (mode === "session-pooler" && untracked) {
              const error = `SFATAL\0C08P01\0Munsupported startup parameter: ${untracked}\0\0`;
              out.push(message("E", Buffer.from(error)));
              socket.write(Buffer.concat(out));
              socket.end();
              return;
            }
            if (mode === "refuse-login") {
              out.push(
                message("E", Buffer.from("SFATAL\0C28P01\0Mpassword authentication failed\0\0")),
              );
              socket.write(Buffer.concat(out));
              socket.end();
              return;
            }
            out.push(message("R", int32(0)), message("Z", Buffer.from("I")));
            continue;
          }
          if (st.buf.length < 5) break;
          const type = String.fromCharCode(st.buf[0]);
          const len = st.buf.readInt32BE(1);
          if (st.buf.length < len + 1) break;
          const body = st.buf.subarray(5, len + 1);
          st.buf = st.buf.subarray(len + 1);
          const strings = body.toString("latin1").split("\0");
          if (type === "P") {
            st.statements.set(strings[0], strings[1]);
            out.push(message("1", Buffer.alloc(0)));
          } else if (type === "B") {
            st.portal = strings[1];
            out.push(message("2", Buffer.alloc(0)));
          } else if (type === "D") {
            const kind = String.fromCharCode(body[0]);
            const name = body.subarray(1).toString("latin1").split("\0")[0];
            const a = answer(st.statements.get(kind === "S" ? name : st.portal) ?? "");
            if (a === null) return void socket.end();
            if (kind === "S") out.push(message("t", int16(0)));
            out.push(rowDescription(a));
          } else if (type === "E") {
            const query = st.statements.get(st.portal) ?? "";
            const a = answer(query, true);
            if (a === null) return void socket.end();
            if (mode === "drop-while-running" && query.includes("pg_try_advisory_lock")) {
              // The lock is granted; the connection goes away while the command runs.
              setTimeout(() => socket.end(), 1000);
            }
            for (const row of a.rows) {
              out.push(
                message(
                  "D",
                  Buffer.concat([
                    int16(row.length),
                    ...row.map((v) => Buffer.concat([int32(Buffer.byteLength(v)), Buffer.from(v)])),
                  ]),
                ),
              );
            }
            out.push(message("C", cstr(`SELECT ${a.rows.length}`)));
          } else if (type === "S") {
            out.push(message("Z", Buffer.from("I")));
          } else if (type === "C") {
            out.push(message("3", Buffer.alloc(0)));
          } else if (type === "X") {
            return void socket.end();
          }
        }
        if (out.length > 0) socket.write(Buffer.concat(out));
      },
    },
  });
}

// ── the cases

test("a URL the driver refuses is named by its variable alone", async () => {
  for (const url of ["postgres://u:s3cr3t@[bad/db", "postgres://u:s3cr3t@h:port/db", "s3cr3t"]) {
    const { status, output } = await runWrapper(url);
    expect(status).toBe(2);
    expect(output).toContain("RYPH_DB is not a URL the Postgres driver accepts");
    expectNoneOf(output, ["s3cr3t", "bad", "port"]);
  }
});

test("passwords that move a parser's boundaries never reach the logs", async () => {
  // Each a password with `/`, `?` or `#` in it, which WHATWG URL and postgres.js cut differently:
  // the old `where` printed a path or host that held part of it. Hosts that do not resolve.
  const cases: [string, string[]][] = [
    ["postgres://u:/Kx9s@h:5432/db", ["/Kx9s", "Kx9s", "Kx9"]],
    ["postgres://u:8/Kx@h/db", ["8/Kx", "/Kx", "Kx@"]],
    ["postgres://u:12?ab@h/db", ["12?ab", "?ab", "12?", "ab@"]],
  ];
  for (const [url, fragments] of cases) {
    const { status, output } = await runWrapper(url);
    expect(status).toBe(1);
    expect(output).toContain("the database in RYPH_DB");
    expectNoneOf(output, [...fragments, url, "u:", "@h", "db"]);
  }
}, 120_000);

test("a multi-host URL with an encoded password: a refused login names its code only", async () => {
  const server = fakePostgres("refuse-login");
  try {
    const { status, output } = await runWrapper(
      `postgres://u:p%23w@127.0.0.1:${server.port},127.0.0.1:${server.port}/db`,
    );
    expect(status).toBe(1);
    expect(output).toContain("could not connect (the database in RYPH_DB: 28P01)");
    expectNoneOf(output, ["p%23w", "p#w", "%23", "23w", "127.0.0.1", String(server.port)]);
  } finally {
    server.stop(true);
  }
}, 60_000);

for (const mode of ["drop-at-holder", "drop-at-second-lock"] as const) {
  test(
    `a connection that drops while waiting for the lock (${mode}) names its code only`,
    async () => {
      const server = fakePostgres(mode);
      try {
        const { status, output } = await runWrapper(
          `postgres://u:p%23w@127.0.0.1:${server.port}/db`,
        );
        expect(status).toBe(1);
        expect(output).toMatch(
          /lost the connection while waiting for the lock \(the database in RYPH_DB: [A-Z_]+\)/,
        );
        if (mode === "drop-at-second-lock") {
          expect(output).toContain(
            "waiting for the lock on the database in RYPH_DB, held by nobody",
          );
        }
        expectNoneOf(output, ["p%23w", "p#w", "%23", "23w", "127.0.0.1", String(server.port)]);
      } finally {
        server.stop(true);
      }
    },
    60_000,
  );
}

test("a lock connection that drops while the command runs stops the command", async () => {
  const server = fakePostgres("drop-while-running");
  try {
    const started = Date.now();
    const { status, output } = await runWrapper(
      `postgres://u:p%23w@127.0.0.1:${server.port}/db`,
      {},
      [
        process.execPath,
        "-e",
        "console.log('child started'); setTimeout(() => console.log(['child', 'finished'].join(' ')), 30000)",
      ],
    );
    expect(status).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(output).toContain("lock held on the database in RYPH_DB");
    expect(output).toContain("child started");
    expect(output).not.toContain("child finished");
    expect(output).toContain(
      "lost the lock while the migration ran; the pod retries (the database in RYPH_DB: CONNECTION_CLOSED)",
    );
    expectNoneOf(output, ["p%23w", "p#w", "%23", "23w", "127.0.0.1", String(server.port)]);
  } finally {
    server.stop(true);
  }
}, 60_000);

test("a multi-host URL where no host resolves gives up at the connect deadline", async () => {
  const started = Date.now();
  const { status, output } = await runWrapper(
    "postgres://u:p%23w@nohost-a.invalid:5432,nohost-b.invalid:5432/db",
    { RYPH_MIGRATE_CONNECT_TIMEOUT: "2" },
  );
  expect(status).toBe(1);
  expect(Date.now() - started).toBeLessThan(20_000);
  expect(output).toContain("could not connect (the database in RYPH_DB: CONNECT_TIMEOUT)");
  expectNoneOf(output, ["p%23w", "p#w", "%23", "23w", "nohost", "invalid", "5432"]);
}, 60_000);

test("a connect deadline past what a timer can hold is refused, not fired at once", async () => {
  const { status, output } = await runWrapper("postgres://u:s3cr3t@nohost.invalid/db", {
    RYPH_MIGRATE_CONNECT_TIMEOUT: "1e10",
  });
  expect(status).toBe(2);
  expect(output).toContain("RYPH_MIGRATE_CONNECT_TIMEOUT must be a positive number of seconds");
  expectNoneOf(output, ["s3cr3t", "nohost"]);
});

test("a session-mode pooler accepts the lock's connection", async () => {
  const server = fakePostgres("session-pooler");
  try {
    const { status, output } = await runWrapper(`postgres://u:p%23w@127.0.0.1:${server.port}/db`);
    expect(output).not.toContain("could not connect");
    expect(output).toContain("lock held on the database in RYPH_DB");
    expect(status).toBe(0);
  } finally {
    server.stop(true);
  }
}, 60_000);

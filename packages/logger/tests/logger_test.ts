// The formatters and the serializer, plus level filtering through a captured console.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import {
  defaultJsonFormatter,
  defaultTextFormatter,
  Logger,
  LogLevel,
  serializeValue,
  setupLogger,
  setupLoggerFromEnv,
} from "../src/mod.ts";

const T0 = new Date("2026-01-01T00:00:00.000Z");

test("json formatter emits one line with level, scope, message, and data", () => {
  const line = defaultJsonFormatter(LogLevel.INFO, "db", "connected", T0, [{ pool: 3 }]);
  assert(!line.includes("\n"));
  const parsed = JSON.parse(line);
  assertEquals(parsed, {
    timestamp: "2026-01-01T00:00:00.000Z",
    level: "INFO",
    name: "db",
    message: "connected",
    data: [{ pool: 3 }],
  });
});

test("errors serialize with their non-enumerable fields and cause chain", () => {
  const inner = new Error("disk on fire");
  const outer = new Error("query failed", { cause: inner });
  const line = defaultJsonFormatter(LogLevel.ERROR, "db", "boom", T0, [outer]);
  const [data] = JSON.parse(line).data;
  assertEquals(data.name, "Error");
  assertEquals(data.message, "query failed");
  assert(typeof data.stack === "string");
  assertEquals(data.cause.message, "disk on fire");
});

test("true cycles flag as [Circular]; shared references do not", () => {
  const cyclic: Record<string, unknown> = { name: "loop" };
  cyclic.self = cyclic;
  assertEquals(serializeValue(cyclic), { name: "loop", self: "[Circular]" });

  const shared = { tag: "x" };
  assertEquals(serializeValue({ a: shared, b: shared }), {
    a: { tag: "x" },
    b: { tag: "x" },
  });
});

test("toJSON is honored, so Dates survive the deep walk", () => {
  assertEquals(serializeValue({ at: T0 }), { at: "2026-01-01T00:00:00.000Z" });
});

test("the text formatter never throws on cyclic data", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const line = defaultTextFormatter(LogLevel.WARN, "api", "odd payload", T0, [cyclic]);
  assert(line.includes("[Circular]"));
});

test("stderr mode routes every level through console.error", () => {
  const errs: string[] = [];
  const others: string[] = [];
  const originals = {
    debug: console.debug,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  console.debug = (msg: string) => others.push(msg);
  console.info = (msg: string) => others.push(msg);
  console.warn = (msg: string) => others.push(msg);
  console.error = (msg: string) => errs.push(msg);
  try {
    setupLogger({ level: LogLevel.DEBUG, formatter: defaultJsonFormatter, stderr: true });
    const logger = new Logger("test");
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    assertEquals(others, []);
    assertEquals(errs.map((line) => JSON.parse(line).message), ["d", "i", "w", "e"]);
  } finally {
    Object.assign(console, originals);
    setupLogger({ level: LogLevel.INFO, stderr: false });
  }
});

test("levels below the configured threshold are dropped", () => {
  const seen: string[] = [];
  const originals = { debug: console.debug, info: console.info, warn: console.warn };
  console.debug = (msg: string) => seen.push(msg);
  console.info = (msg: string) => seen.push(msg);
  console.warn = (msg: string) => seen.push(msg);
  try {
    setupLogger({ level: LogLevel.WARN, formatter: defaultJsonFormatter });
    const logger = new Logger("test");
    logger.debug("dropped");
    logger.info("dropped");
    logger.warn("kept");
    assertEquals(seen.length, 1);
    assertEquals(JSON.parse(seen[0]).message, "kept");
  } finally {
    Object.assign(console, originals);
    setupLogger({ level: LogLevel.INFO });
  }
});

test("setup from env defaults to info, and RYPH_LOG_LEVEL overrides it", () => {
  const seen: string[] = [];
  const originals = { debug: console.debug, info: console.info };
  const saved = { level: process.env.RYPH_LOG_LEVEL, format: process.env.RYPH_LOG_FORMAT };
  console.debug = (msg: string) => seen.push(msg);
  console.info = (msg: string) => seen.push(msg);
  try {
    delete process.env.RYPH_LOG_LEVEL;
    process.env.RYPH_LOG_FORMAT = "json";
    setupLoggerFromEnv();
    const logger = new Logger("test");
    logger.debug("dropped");
    logger.info("kept");
    assertEquals(seen.map((line) => JSON.parse(line).message), ["kept"]);

    seen.length = 0;
    process.env.RYPH_LOG_LEVEL = "debug";
    setupLoggerFromEnv();
    logger.debug("kept too");
    assertEquals(seen.map((line) => JSON.parse(line).message), ["kept too"]);
  } finally {
    Object.assign(console, originals);
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore("RYPH_LOG_LEVEL", saved.level);
    restore("RYPH_LOG_FORMAT", saved.format);
    setupLogger({ level: LogLevel.INFO, stderr: false });
  }
});

test("a log line never throws, even when there is nowhere left to write it", () => {
  // What every console method does once the terminal is closed: EIO, on every write.
  const originals = { warn: console.warn, error: console.error };
  const eio = () => {
    throw new Error("Input/output error (os error 5)");
  };
  console.warn = eio;
  console.error = eio;
  try {
    setupLogger({ level: LogLevel.DEBUG, formatter: defaultJsonFormatter });
    const logger = new Logger("test");
    logger.warn("the terminal is gone");
    logger.error("still gone");
    setupLogger({ level: LogLevel.DEBUG, formatter: defaultJsonFormatter, stderr: true });
    logger.info("and on stderr");
  } finally {
    Object.assign(console, originals);
    setupLogger({ level: LogLevel.INFO, stderr: false });
  }
});

// @ryph/logger — named/scoped loggers with level filtering and pluggable formatters.
// Every ryph service logs the same way. Setup reads from explicit options or RYPH_LOG_* env
// vars, and output can be pinned to stderr for processes whose stdout is a data channel.

import {
  bgBrightRed,
  bgRed,
  bgYellow,
  blue,
  bold,
  cyan,
  dim,
  gray,
  green,
  magenta,
  red,
} from "@std/fmt/colors";

/**
 * Defines the available log levels, ordered by severity.
 */
export enum LogLevel {
  DEBUG,
  INFO,
  WARN,
  ERROR,
  CRITICAL,
}

// Maps LogLevel enum to string names.
const LOG_LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: "DEBUG",
  [LogLevel.INFO]: "INFO",
  [LogLevel.WARN]: "WARN",
  [LogLevel.ERROR]: "ERROR",
  [LogLevel.CRITICAL]: "CRITICAL",
};

/**
 * Defines the shape of the formatter function.
 * It receives the 'args' array to include in the log.
 */
export type LogFormatter = (
  level: LogLevel,
  name: string,
  message: string,
  timestamp: Date,
  args: unknown[],
) => string;

// Depth limit for the recursive serializer. Well beyond any realistic
// cause chain or log payload, but finite — guards against stack overflow
// and unbounded output from pathological or accidentally cyclic input.
const MAX_DEPTH = 32;

/**
 * Helper to serialize Error objects, which don't stringify well.
 * Standard Error fields (name/message/stack) are non-enumerable, so a plain
 * JSON.stringify would drop them. Walks the `cause` chain and any enumerable
 * own properties (e.g. Drizzle's `query`/`params`) so nested errors don't
 * vanish into `{}` in logs.
 */
const serializeError = (
  error: Error,
  seen: WeakSet<object>,
  depth: number,
): Record<string, unknown> => {
  const result: Record<string, unknown> = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };

  for (const key of Object.keys(error)) {
    // Own-only check: `key in result` would walk Object.prototype and
    // silently drop legitimate enumerable fields named `toString`,
    // `constructor`, `hasOwnProperty`, etc. on custom Error subclasses.
    if (Object.hasOwn(result, key) || key === "cause") continue;
    result[key] = serializeValue(
      (error as unknown as Record<string, unknown>)[key],
      seen,
      depth + 1,
    );
  }

  // `cause` is non-enumerable when set via the Error constructor options, so
  // it won't appear in Object.keys. Handle it here unconditionally, and skip
  // it above to avoid duplicate serialization when a custom Error subclass
  // exposes `cause` as enumerable. Only a true cycle back to an ancestor
  // would be rendered as "[Circular]" by the `seen` guard.
  if ("cause" in error && error.cause !== undefined) {
    result.cause = serializeValue(error.cause, seen, depth + 1);
  }

  return result;
};

/**
 * Recursively walks a value, replacing any Error instance with its serialized
 * form. Guards against cycles via a WeakSet and runaway depth via MAX_DEPTH.
 *
 * `seen` tracks the current recursion *path* (ancestors only), not all values
 * ever visited — added before descending, removed after — so that shared but
 * non-cyclic references serialize twice rather than collapsing to `[Circular]`.
 * JSON.stringify behaves the same way; only true cycles get flagged.
 */
export const serializeValue = (
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
  depth: number = 0,
): unknown => {
  if (value === null || typeof value !== "object") return value;
  if (depth > MAX_DEPTH) return "[MaxDepth]";
  if (seen.has(value as object)) return "[Circular]";
  seen.add(value as object);

  try {
    if (value instanceof Error) {
      return serializeError(value, seen, depth);
    }

    // Honor `toJSON` (Date -> ISO string, URL -> href, etc.) so the deep walk
    // below doesn't turn these into `{}` — their useful state lives on the
    // prototype or in internal slots that `Object.entries` can't see.
    // `depth + 1` is important: a pathological chain of toJSON impls that each
    // return a fresh object would otherwise bypass MAX_DEPTH, since `seen`
    // never matches (fresh objects) and depth stays put.
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") {
      return serializeValue(
        (toJSON as () => unknown).call(value),
        seen,
        depth + 1,
      );
    }

    if (Array.isArray(value)) {
      return value.map((v) => serializeValue(v, seen, depth + 1));
    }

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = serializeValue(v, seen, depth + 1);
    }
    return out;
  } finally {
    seen.delete(value as object);
  }
};

/**
 * Default JSON log message formatter.
 * Outputs a single-line JSON string.
 */
export const defaultJsonFormatter: LogFormatter = (
  level,
  name,
  message,
  timestamp,
  args,
) => {
  const levelName = LOG_LEVEL_NAMES[level] || "LOG";

  const processedArgs = args.map((arg) => serializeValue(arg));

  const logObject = {
    timestamp: timestamp.toISOString(),
    level: levelName,
    name: name,
    message: message,
    // Conditionally add 'data' field only if args exist
    ...(processedArgs.length > 0 && { data: processedArgs }),
  };

  // Stringify to a single line
  return JSON.stringify(logObject);
};

export const defaultTextFormatter: LogFormatter = (
  level,
  name,
  message,
  timestamp,
  args,
) => {
  const levelName = LOG_LEVEL_NAMES[level] || "LOG";
  const timeString = timestamp.toISOString();

  let logMessage = `[${timeString}] [${levelName}] [${name}] ${message}`;

  if (args.length > 0) {
    const argsString = args.map((arg) => {
      if (arg instanceof Error) {
        return `Error: ${arg.name}: ${arg.message}\n${arg.stack}`;
      }
      return JSON.stringify(serializeValue(arg));
    }).join(" | ");
    logMessage += ` | Data: ${argsString}`;
  }

  return logMessage;
};

/**
 * Colorful log message formatter with ANSI colors.
 * Outputs a pretty, colorful log line with colors for different log levels.
 */
export const colorfulFormatter: LogFormatter = (
  level,
  name,
  message,
  timestamp,
  args,
) => {
  const levelName = LOG_LEVEL_NAMES[level] || "LOG";
  const timeString = timestamp.toLocaleTimeString("en-US", { hour12: false });

  // Color the log level based on severity
  let coloredLevel: string;
  switch (level) {
    case LogLevel.DEBUG:
      coloredLevel = blue(bold(`[${levelName}]`));
      break;
    case LogLevel.INFO:
      coloredLevel = green(bold(`[${levelName}]`));
      break;
    case LogLevel.WARN:
      coloredLevel = bgYellow(bold(` ${levelName} `));
      break;
    case LogLevel.ERROR:
      coloredLevel = bgRed(bold(` ${levelName} `));
      break;
    case LogLevel.CRITICAL:
      coloredLevel = bgBrightRed(bold(` ${levelName} `));
      break;
    default:
      coloredLevel = bold(`[${levelName}]`);
  }

  // Build the log message with colors
  const coloredTime = dim(gray(`[${timeString}]`));
  const coloredName = cyan(bold(`[${name}]`));
  const formattedMessage = level >= LogLevel.ERROR ? red(message) : message;

  let logMessage = `${coloredTime} ${coloredLevel} ${coloredName} ${formattedMessage}`;

  // Format additional arguments with colors
  if (args.length > 0) {
    const formattedArgs = args.map((arg) => {
      if (arg instanceof Error) {
        return `\n  ${red(bold("Error:"))} ${red(arg.name)}: ${arg.message}\n  ${
          dim(gray(arg.stack || ""))
        }`;
      }
      try {
        return `\n  ${magenta("→")} ${
          JSON.stringify(serializeValue(arg), null, 2).split("\n").join("\n    ")
        }`;
      } catch {
        return `\n  ${magenta("→")} ${String(arg)}`;
      }
    }).join("");
    logMessage += formattedArgs;
  }

  return logMessage;
};

/**
 * Configuration for the logger.
 */
interface LoggerConfig {
  level: LogLevel;
  formatter: LogFormatter;
  /**
   * Routes every level to stderr instead of the per-level console methods —
   * for processes whose stdout is a data channel that must stay machine-parseable.
   */
  stderr: boolean;
}

// Internal, module-level configuration.
const _config: LoggerConfig = {
  level: LogLevel.INFO, // Default level
  formatter: defaultJsonFormatter, // Default to JSON formatter
  stderr: false,
};

/**
 * Public function to set up and configure the logger.
 * You can still override the formatter if you want a different one.
 * @param options - Partial configuration to override defaults.
 */
export function setupLogger(options: Partial<LoggerConfig>) {
  Object.assign(_config, options);
}

const LEVEL_BY_NAME: Record<string, LogLevel> = {
  debug: LogLevel.DEBUG,
  info: LogLevel.INFO,
  warn: LogLevel.WARN,
  error: LogLevel.ERROR,
  critical: LogLevel.CRITICAL,
};

/**
 * Configures the logger from RYPH_LOG_LEVEL (debug|info|warn|error|critical) and
 * RYPH_LOG_FORMAT (json|text|colorful). The format default is colorful on a terminal and
 * JSON otherwise, so `bun run dev` is pretty and a container's stdout is machine-readable.
 * `stderr: true` pins every level to stderr (and detects the terminal on stderr accordingly).
 * Call this once from a composition root; libraries just `new Logger(...)`.
 */
export function setupLoggerFromEnv(defaults: { level?: LogLevel; stderr?: boolean } = {}) {
  const env = (name: string): string | undefined => process.env[name];
  const level = LEVEL_BY_NAME[env("RYPH_LOG_LEVEL")?.toLowerCase() ?? ""] ??
    defaults.level ?? LogLevel.INFO;

  const stderr = defaults.stderr ?? false;
  const isTty = (() => {
    try {
      return (stderr ? process.stderr : process.stdout).isTTY === true;
    } catch {
      return false;
    }
  })();
  const formatName = env("RYPH_LOG_FORMAT")?.toLowerCase() ?? (isTty ? "colorful" : "json");
  const formatter = formatName === "json"
    ? defaultJsonFormatter
    : formatName === "text"
    ? defaultTextFormatter
    : colorfulFormatter;

  setupLogger({ level, formatter, stderr });
}

/** One formatted line out through the console method for its level (or stderr, when pinned). */
function write(level: LogLevel, formattedMessage: string): void {
  if (_config.stderr) {
    console.error(formattedMessage);
    return;
  }
  switch (level) {
    case LogLevel.DEBUG:
      console.debug(formattedMessage);
      break;
    case LogLevel.INFO:
      console.info(formattedMessage);
      break;
    case LogLevel.WARN:
      console.warn(formattedMessage);
      break;
    case LogLevel.ERROR:
    case LogLevel.CRITICAL:
      console.error(formattedMessage);
      break;
    default:
      console.log(formattedMessage);
  }
}

/**
 * The main Logger class.
 * Use this to create named/scoped logger instances.
 */
export class Logger {
  private name: string;

  /**
   * Creates a new logger instance.
   * @param name - The name (scope) of the logger, e.g., "db", "api-routes".
   */
  constructor(name: string) {
    this.name = name;
  }

  /**
   * Logs a message at the given level.
   * This is the core method that respects the configured level and formatter.
   *
   * @param level - The log level.
   * @param message - The main log message.
   * @param args - Additional data to log (e.g., objects, errors).
   */
  private log(level: LogLevel, message: string, ...args: unknown[]) {
    // 1. Check if this log level should be processed
    if (level < _config.level) {
      return;
    }

    // 2. Format the message, passing args to the formatter
    const formattedMessage = _config.formatter(
      level,
      this.name,
      message,
      new Date(),
      args,
    );

    // 3. Output using the appropriate console method
    // We only pass the single formattedMessage string.
    // A log line never throws. Once the terminal a process runs in is closed, every write to it
    // fails with EIO — console.* included — and a log call that threw there would abort
    // whatever was logging, the shutdown that SIGHUP starts above all.
    try {
      write(level, formattedMessage);
    } catch {
      // Nowhere left to say it.
    }
  }

  // --- Public Logging Methods ---

  public debug(message: string, ...args: unknown[]) {
    this.log(LogLevel.DEBUG, message, ...args);
  }

  public info(message: string, ...args: unknown[]) {
    this.log(LogLevel.INFO, message, ...args);
  }

  public warn(message: string, ...args: unknown[]) {
    this.log(LogLevel.WARN, message, ...args);
  }

  public error(message: string, ...args: unknown[]) {
    this.log(LogLevel.ERROR, message, ...args);
  }

  public critical(message: string, ...args: unknown[]) {
    this.log(LogLevel.CRITICAL, message, ...args);
  }
}

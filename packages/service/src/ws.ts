// The real `ws` package, for the WebSocket upgrades `serve` accepts.
//
// Bun answers `import "ws"` with its own stand-in (measured on Bun 1.4: `BunWebSocketMocked`), and
// that stand-in does not enforce `maxPayload`: a frame past the limit is buffered and delivered
// whole. The limit is the point here — it is what stops a peer from making this process buffer a
// frame of any size — so the package is loaded from its own files, which the stand-in does not
// intercept. Under Node this is the same module `import "ws"` would give.
//
// In a compiled binary (`--define RYPH_STANDALONE=true`) there are no package files to load at
// run time: resolving `ws` there would search up from wherever the binary's modules sit (and run
// whatever `node_modules/ws` it found first, inside the key-holding host). So the build bundles
// the package's own entry under the specifier `ryph:ws` (packages/ryph/scripts/compile.ts), and
// the binary loads that or nothing.

import { createRequire } from "node:module";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

/** The part of a `ws` WebSocket this workspace uses. */
export interface WsSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  readonly protocol: string;
  readonly extensions: string;
  binaryType: "nodebuffer" | "arraybuffer" | "fragments";
  send(data: string | Uint8Array, opts?: { binary?: boolean }): void;
  ping(): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: "message", listener: (data: Buffer, binary: boolean) => void): void;
  on(event: "close", listener: (code: number, reason: Buffer) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "ping" | "pong", listener: () => void): void;
}

/** The part of a `ws` WebSocketServer this workspace uses. */
export interface WsServer {
  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    done: (socket: WsSocket) => void,
  ): void;
}

export interface WsServerOptions {
  noServer: true;
  maxPayload?: number;
  /** The most frames one message may arrive in (ws's default 16384); past it the socket is closed
   * (1008) with an `error` as the next frame arrives: at 1, a fragmented message's second, its
   * first (up to `maxPayload`) held until then. */
  maxFragments?: number;
  perMessageDeflate?: boolean;
  clientTracking?: boolean;
  /** Answer every ping with a pong (ws's default). Off, a ping is only an event: a peer that
   * pings and never reads cannot have a pong queued per ping, past any backpressure. */
  autoPong?: boolean;
  handleProtocols?: (offered: Set<string>, req: IncomingMessage) => string | false;
}

export interface WsModule {
  WebSocketServer: new (opts: WsServerOptions) => WsServer;
}

/** Defined `true` by a compiled binary's build (`bun build --compile --define`). */
declare const RYPH_STANDALONE: boolean | undefined;
const STANDALONE = typeof RYPH_STANDALONE !== "undefined" && RYPH_STANDALONE === true;

let loaded: WsModule | null = null;

/** The `ws` package itself, never a runtime's stand-in for it. */
export function realWs(): WsModule {
  if (loaded !== null) return loaded;
  if (STANDALONE) {
    // Bundled by the build; a build without the plugin fails to resolve it rather than load
    // something else.
    loaded = require("ryph:ws") as WsModule;
    return loaded;
  }
  const fromHere = createRequire(import.meta.url);
  // `ws/package.json` is in the package's exports, so it resolves under any runtime; the entry
  // beside it is then loaded by path, which no runtime redirects.
  const root = fromHere.resolve("ws/package.json").replace(/package\.json$/, "");
  loaded = fromHere(`${root}index.js`) as WsModule;
  return loaded;
}

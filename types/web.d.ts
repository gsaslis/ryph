// Web type names the DOM lib declares and bun-types does not, as global aliases.
//
// The workspace type-checks without the DOM lib (tsconfig.base.json): bun-types declares the web
// globals itself (fetch, Request, ReadableStream, WebSocket, …), and with the DOM lib as well its
// stream types and node's collide. What the DOM lib alone named is derived here from the globals,
// so it stays whatever the runtime's types say.

type HeadersInit = NonNullable<ConstructorParameters<typeof Headers>[0]>;
type BodyInit = NonNullable<ConstructorParameters<typeof Response>[0]>;
type ResponseInit = NonNullable<ConstructorParameters<typeof Response>[1]>;
type RequestInfo = ConstructorParameters<typeof Request>[0];
type ReadableStreamReadResult<T> = import("node:stream/web").ReadableStreamReadResult<T>;
type BinaryType = "blob" | "arraybuffer";

// The DOM lib (and Deno) type a body's JSON as `any`; undici-types, which bun-types takes Request
// and Response from, says `unknown`. Code written against the former reads fields straight off
// it, so the merged interfaces override the inherited member with the DOM lib's signature.
interface Request {
  // oxlint-disable-next-line no-explicit-any -- the DOM lib's own signature
  json(): Promise<any>;
}
interface Response {
  // oxlint-disable-next-line no-explicit-any -- the DOM lib's own signature
  json(): Promise<any>;
}

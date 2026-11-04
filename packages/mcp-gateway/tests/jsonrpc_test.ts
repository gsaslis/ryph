// The framing the data plane reads and rewrites: request parsing, the two tools/list filters,
// and response demuxing for the probe.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import {
  type ClientMessageRefusal,
  couldMean,
  filterToolsListPayload,
  filterToolsListResponse,
  filterToolsListSse,
  hasDuplicateKey,
  messagesInResponse,
  parseClientBody,
  parseClientMessage,
  rpcError,
} from "../src/core/jsonrpc.ts";

/** The message a body parses to, or the refusal reason. */
function read(body: string) {
  const parsed = parseClientMessage(body);
  return parsed.ok ? parsed.message : parsed.reason;
}

test("parseClientMessage reads method, id and the tool name of a tools/call", () => {
  const call = JSON.stringify({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "list_issues", arguments: {} },
  });
  assertEquals(parseClientMessage(call), {
    ok: true,
    message: { method: "tools/call", id: 7, toolName: "list_issues" },
    canonical: call,
  });
  // A notification has no id; a response has no method; neither is an error.
  assertEquals(
    read(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })),
    { method: "notifications/initialized", id: null, toolName: null },
  );
  assertEquals(
    read(JSON.stringify({ jsonrpc: "2.0", id: "x", result: {} })),
    { method: null, id: "x", toolName: null },
  );
  assertEquals(
    read(JSON.stringify({ jsonrpc: "2.0", id: 3, error: { code: -1, message: "no" } })),
    { method: null, id: 3, toolName: null },
  );
  // A tools/call without a string name is a tools/call with no tool — the caller refuses it.
  assertEquals(
    read(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: 5 } })),
    { method: "tools/call", id: 1, toolName: null },
  );
});

test("a batch, a scalar, garbage and bad UTF-8 are refused with distinct reasons", () => {
  assertEquals(parseClientMessage("[{}]"), { ok: false, reason: "batch" });
  assertEquals(parseClientMessage("42"), { ok: false, reason: "not_an_object" });
  assertEquals(parseClientMessage("null"), { ok: false, reason: "not_an_object" });
  assertEquals(parseClientMessage("{nope"), { ok: false, reason: "invalid_json" });

  const bytes = (s: string) => new TextEncoder().encode(s);
  const ping = '{"jsonrpc":"2.0","id":1,"method":"ping"}';
  assertEquals(parseClientBody(bytes(ping)).ok, true);
  // An overlong `e` (C1 A5) and a stray continuation byte: never decoded, never guessed at.
  const overlong = Uint8Array.from([...bytes('{"jsonrpc":"2.0","id":1,"method":"pin'), 0xc1]);
  assertEquals(parseClientBody(overlong), { ok: false, reason: "invalid_utf8" });
  const stray = Uint8Array.from([...bytes('{"jsonrpc":"2.0","id":"'), 0x80, ...bytes('"}')]);
  assertEquals(parseClientBody(stray), { ok: false, reason: "invalid_utf8" });
});

test("a key any parser could read differently is refused at the top level", () => {
  const cases: [string, ClientMessageRefusal][] = [
    // Go's encoding/json matches `Method` to `method`: no method here, resources/read there.
    [
      '{"jsonrpc":"2.0","id":1,"Method":"resources/read","params":{"uri":"x"}}',
      "unexpected_member",
    ],
    ['{"jsonrpc":"2.0","id":1,"method":"ping","METHOD":"prompts/get"}', "unexpected_member"],
    ['{"jsonrpc":"2.0","method":"notifications/initialized","ID":1}', "unexpected_member"],
    ['{"jsonrpc":"2.0","id":1,"method":"tools/list","Params":{}}', "unexpected_member"],
    ['{"jsonrpc":"2.0","id":1,"result":{},"Error":{}}', "unexpected_member"],
    // Unicode folding: `ſ` is `s` to Go, the Kelvin sign is `k`; and any stray member at all.
    ['{"jsonrpc":"2.0","id":1,"method":"ping","paramſ":{}}', "unexpected_member"],
    ['{"jsonrpc":"2.0","id":1,"method":"ping","extra":true}', "unexpected_member"],
    // The same key twice, however it is escaped: JSON.parse keeps the last, others the first.
    ['{"jsonrpc":"2.0","id":1,"method":"ping","method":"resources/read"}', "duplicate_key"],
    ['{"jsonrpc":"2.0","id":1,"method":"resources/read","m\\u0065thod":"ping"}', "duplicate_key"],
    ['{"jsonrpc":"2.0","id":1,"id":2,"method":"ping"}', "duplicate_key"],
  ];
  for (const [body, reason] of cases) assertEquals(read(body), reason, body);
});

test("params: name and arguments must be spelled exactly, the tool's data may not", () => {
  const call = (params: string) =>
    `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":${params}}`;
  for (
    const params of [
      '{"name":"search_dashboards","Name":"update_dashboard","arguments":{}}',
      '{"Name":"update_dashboard","arguments":{}}',
      '{"name":"search_dashboards","NAME":"update_dashboard"}',
      '{"name":"search_dashboards","nameſ":"x","ńame":"update_dashboard"}',
      '{"name":"search_dashboards","arguments":{},"Arguments":{"evil":true}}',
      '{"name":"search_dashboards","argumentſ":{}}',
      '{"name":"ｎａｍｅ","ｎａｍｅ":"update_dashboard"}',
    ]
  ) {
    assertEquals(read(call(params)), "unexpected_member", params);
  }
  assertEquals(
    read(call('{"name":"search_dashboards","name":"update_dashboard"}')),
    "duplicate_key",
  );
  assertEquals(
    read(call('{"name":"search_dashboards","n\\u0061me":"update_dashboard"}')),
    "duplicate_key",
  );
  // Inside `arguments` the keys are the tool's own: `Name`, `NAME` and `Arguments` are data.
  const data = call(
    '{"name":"search_dashboards","arguments":{"Name":"x","NAME":"y","Arguments":{"name":"z"}},"_meta":{"progressToken":1}}',
  );
  assertEquals(read(data), { method: "tools/call", id: 1, toolName: "search_dashboards" });
  // …but a key repeated anywhere is still refused: the tool would see one of two values.
  assertEquals(
    read(call('{"name":"search_dashboards","arguments":{"query":"a","query":"b"}}')),
    "duplicate_key",
  );
  assertEquals(
    read(call('{"name":"s","arguments":{"deep":[{"a":1},{"a":2,"b":{"c":1,"c":2}}]}}')),
    "duplicate_key",
  );
  // The same key in sibling objects, in arrays, or as a value is not a duplicate.
  assertEquals(
    typeof read(call('{"name":"s","arguments":{"l":[{"a":1},{"a":2}],"a":"a","b":{"a":"name"}}}')),
    "object",
  );
});

test("couldMean over-approximates any one-to-one case folding", () => {
  for (const key of ["Name", "NAME", "nAmE", "ńame", "namK".slice(0, 4), "ｎａｍｅ"]) {
    assertEquals(couldMean(key, "name"), true, key);
  }
  assertEquals(couldMean("argumentſ", "arguments"), true);
  for (const key of ["names", "nam", "nane", "n_me", "label"]) {
    assertEquals(couldMean(key, "name"), false, key);
  }
});

test("hasDuplicateKey finds a repeat in any object, and only a repeat", () => {
  assertEquals(hasDuplicateKey('{"a":1,"a":2}'), true);
  assertEquals(hasDuplicateKey('{"a":{"b":[{"c":1,"c":1}]}}'), true);
  assertEquals(hasDuplicateKey('{"a":"\\"","\\u0061":1}'), true);
  assertEquals(hasDuplicateKey('{"a":"a","b":"a","c":["a","a"],"d":{"a":1}}'), false);
  assertEquals(hasDuplicateKey('{"a\\"b":1,"a\\\\":{"x":"}{,"},"y":["{\\"a\\":1,"]}'), false);
  assertEquals(hasDuplicateKey('{"k":{},"j":[],"l":{"k":{}}}'), false);
  assertEquals(hasDuplicateKey("{}"), false);
});

test("a method-less message passes only as a well-formed response", () => {
  const cases = [
    '{"jsonrpc":"2.0","id":1}', // neither result nor error
    '{"jsonrpc":"2.0","id":1,"result":{},"error":{"code":1,"message":"x"}}', // both
    '{"jsonrpc":"2.0","result":{}}', // no id
    '{"jsonrpc":"2.0","id":null,"result":{}}',
    '{"jsonrpc":"2.0","id":1,"result":{},"params":{"name":"x"}}', // a request member
    '{"jsonrpc":"2.0","id":1,"result":"text"}',
    '{"jsonrpc":"2.0","id":1,"error":null}',
    '{"jsonrpc":"2.0","id":{"a":1},"result":{}}',
    '{"id":1,"result":{}}', // no jsonrpc
    '{"jsonrpc":"1.0","id":1,"result":{}}',
    // A `method` that is present but not a string was "no method", and so passed as a response.
    '{"jsonrpc":"2.0","id":1,"method":null,"result":{}}',
    '{"jsonrpc":"2.0","id":1,"method":["resources/read"]}',
    // A request carrying a response's members, or params that are not an object.
    '{"jsonrpc":"2.0","id":1,"method":"ping","result":{}}',
    '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":["delete_team"]}',
    '{"jsonrpc":"2.0","id":1,"method":"ping","params":null}',
    '{"jsonrpc":"2.0","id":true,"method":"ping"}',
  ];
  for (const body of cases) assertEquals(read(body), "invalid_message", body);
});

test("the canonical body is the judged message, every number exactly as written", () => {
  const body = ' {"jsonrpc" : "2.0", "id":9007199254740993, "method":"tools/call",\n' +
    '"params":{"n\\u0061me":"get_issue","arguments":{"id":12345678901234567890,"f":1.50,' +
    '"e":1e400,"z":-0,"s":"\\ud800 \\u00e9 \\"q\\"","__proto__":{"x":1}}}} ';
  const parsed = parseClientMessage(body);
  assert(parsed.ok);
  assertEquals(parsed.message.toolName, "get_issue");
  assertEquals(
    parsed.canonical,
    '{"jsonrpc":"2.0","id":9007199254740993,"method":"tools/call","params":{"name":"get_issue",' +
      '"arguments":{"id":12345678901234567890,"f":1.50,"e":1e400,"z":-0,' +
      '"s":"\\ud800 é \\"q\\"","__proto__":{"x":1}}}}',
  );
  // It parses back to the same message, so a second look sees exactly what the first judged.
  const again = parseClientMessage(parsed.canonical);
  assert(again.ok);
  assertEquals(again.canonical, parsed.canonical);
  assertEquals(JSON.parse(parsed.canonical), JSON.parse(body));
});

const LIST = {
  jsonrpc: "2.0",
  id: 2,
  result: {
    tools: [
      { name: "list_issues", description: "read" },
      { name: "create_issue", description: "write" },
      { name: "delete_team", description: "ouch" },
    ],
    nextCursor: "p2",
  },
};

test("filterToolsListPayload removes tools outside the allowlist and nothing else", () => {
  const filtered = filterToolsListPayload(structuredClone(LIST), ["list_issues"]) as typeof LIST;
  assertEquals(filtered.result.tools.map((t) => t.name), ["list_issues"]);
  assertEquals(filtered.result.nextCursor, "p2"); // untouched
  assertEquals(filtered.id, 2);

  const all = filterToolsListPayload(structuredClone(LIST), "*") as typeof LIST;
  assertEquals(all.result.tools.length, 3);

  // Not a tools/list result: passes through verbatim.
  const other = { jsonrpc: "2.0", id: 3, result: { content: [] } };
  assertEquals(filterToolsListPayload(structuredClone(other), []), other);
  const error = { jsonrpc: "2.0", id: 3, error: { code: -1, message: "no" } };
  assertEquals(filterToolsListPayload(structuredClone(error), []), error);
  assertEquals(filterToolsListPayload("text", []), "text");
});

test("filterToolsListSse rewrites data lines and keeps the framing", () => {
  const sse = [
    "event: message",
    "id: 1",
    `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: {} })}`,
    "",
    ": keepalive",
    "",
    "event: message",
    `data: ${JSON.stringify(LIST)}`,
    "",
    "",
  ].join("\n");
  const out = filterToolsListSse(sse, ["create_issue"]);
  const lines = out.split("\n");
  assertEquals(lines[0], "event: message");
  assertEquals(lines[3], ": keepalive");
  const rewritten = JSON.parse(lines[6].slice("data: ".length)) as typeof LIST;
  assertEquals(rewritten.result.tools.map((t) => t.name), ["create_issue"]);
  // The notification's data line survived untouched, minus normalised spacing.
  assertEquals(JSON.parse(lines[1].slice("data: ".length)).method, "notifications/message");
  // No event id survives: it is upstream's resumption handle, and a client holding one could ask
  // for everything after it to be replayed — past the filter that rewrote this very body.
  assert(!out.includes("id: 1"));
  // An event whose data is not JSON fails closed: its data is dropped, never passed on unread.
  assertEquals(filterToolsListSse("id: 7\ndata: not json\n\n", []), "\n\n");
});

test("filterToolsListSse reads events as a client does, so no framing smuggles a tool past it", () => {
  const json = JSON.stringify(LIST);
  const comma = json.indexOf(",");
  const denied = LIST.result.tools.map((t) => t.name).filter((n) => n !== "create_issue");
  assert(denied.length > 0);
  for (
    const [label, sse] of [
      // one JSON document split over two data lines, which a client joins with "\n"
      [
        "multi-line data",
        `event: message\ndata: ${json.slice(0, comma + 1)}\ndata: ${json.slice(comma + 1)}\n\n`,
      ],
      ["CR line endings", `event: message\rdata: ${json}\r\r`],
      ["CRLF line endings", `event: message\r\ndata: ${json}\r\n\r\n`],
      ["no space after the colon", `data:${json}\n\n`],
      ["no blank line at the end", `data: ${json}`],
    ]
  ) {
    const out = filterToolsListSse(sse, ["create_issue"]);
    for (const name of denied) assert(!out.includes(name), `${label}: ${name} leaked`);
    const [message] = messagesInResponse("text/event-stream", out) as Array<typeof LIST>;
    assertEquals(message.result.tools.map((t) => t.name), ["create_issue"], label);
  }
});

test("filterToolsListResponse sniffs the framing and fails closed on a body it cannot read", () => {
  const json = JSON.stringify(LIST);
  const fromJson = filterToolsListResponse(json, ["create_issue"]) as string;
  assertEquals(
    (JSON.parse(fromJson) as typeof LIST).result.tools.map((t) => t.name),
    ["create_issue"],
  );

  // An SSE body with no label at all, and one whose events are the only clue: still filtered.
  for (const sse of [`event: message\ndata: ${json}\n\n`, `data: ${json}\n\n`]) {
    const out = filterToolsListResponse(sse, ["create_issue"]) as string;
    assert(!out.includes("delete_team"));
    assert(out.includes("create_issue"));
  }

  // Nothing readable in it: null, so the caller refuses rather than passing the body on.
  assertEquals(filterToolsListResponse("", []), null);
  assertEquals(filterToolsListResponse("<html>not for us</html>", []), null);
  assertEquals(filterToolsListResponse("event: message\ndata: not json\n\n", []), null);
});

test("messagesInResponse demuxes both framings", () => {
  // Media types are case-insensitive, so a conforming server may shout the label.
  assertEquals(messagesInResponse("Text/Event-Stream", 'data: {"id":4}\n\n'), [{ id: 4 }]);
  assertEquals(
    messagesInResponse("text/event-stream", 'data: {"id":\ndata: 3}\n\n'),
    [{ id: 3 }],
    "an event's data lines are one message",
  );
  assertEquals(messagesInResponse("application/json", JSON.stringify(LIST)), [LIST]);
  const sse = `event: message\ndata: {"id":1}\n\ndata: {"id":2}\n\n: comment\n`;
  assertEquals(messagesInResponse("text/event-stream; charset=utf-8", sse), [{ id: 1 }, {
    id: 2,
  }]);
  assertEquals(messagesInResponse("application/json", ""), []);
  assertEquals(messagesInResponse("application/json", "garbage"), []);
});

test("rpcError is a JSON-RPC error object with the caller's id", () => {
  assertEquals(JSON.parse(rpcError(9, -32601, "Unknown tool: x")), {
    jsonrpc: "2.0",
    id: 9,
    error: { code: -32601, message: "Unknown tool: x" },
  });
  assertEquals(JSON.parse(rpcError(null, -32000, "m")).id, null);
});

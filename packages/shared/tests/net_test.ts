// The address rule, range by range — the union of what web__fetch, the MCP gateway, memory's URL
// fetcher and the egress proxy each refused. Nothing here opens a socket.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { isBlockedAddress, isLoopbackHost, parseIp } from "../src/net.ts";

test("every non-public IPv4 range is refused", () => {
  for (
    const address of [
      "0.0.0.0",
      "0.1.2.3",
      "10.0.0.1",
      "10.255.255.255",
      "127.0.0.1",
      "127.1.2.3",
      "100.64.0.1", // CGNAT
      "100.127.255.255",
      "169.254.169.254", // the cloud metadata address
      "172.16.0.1",
      "172.31.255.255",
      "192.0.0.1",
      "192.0.2.5",
      "192.88.99.1",
      "192.168.1.1",
      "198.18.0.1",
      "198.19.255.255",
      "198.51.100.7",
      "203.0.113.9",
      "224.0.0.1", // multicast
      "239.255.255.250",
      "240.0.0.1", // reserved
      "255.255.255.255",
    ]
  ) {
    assert(isBlockedAddress(address), `${address} must be refused`);
  }
});

test("credential vendors at ordinary-looking addresses are refused", () => {
  for (
    const address of [
      "169.254.169.254", // AWS, GCP
      "100.100.100.200", // Alibaba
      "168.63.129.16", // Azure's wireserver
      "192.0.0.192", // Oracle
      "fd00:ec2::254", // AWS over IPv6
    ]
  ) {
    assert(isBlockedAddress(address), `the metadata address ${address} must be refused`);
  }
  assertEquals(isBlockedAddress("168.63.129.17"), false);
});

test("public IPv4 and IPv6 addresses are allowed, mapped public IPv4 too", () => {
  for (
    const address of [
      "93.184.216.34",
      "8.8.8.8",
      "1.1.1.1",
      "140.82.112.3",
      "172.32.0.1",
      "100.128.0.1",
      "2606:4700::1",
      "2606:4700::1111",
      "::ffff:8c52:7003",
      "::ffff:8.8.8.8",
      "[2606:4700::1]",
    ]
  ) {
    assertEquals(isBlockedAddress(address), false, address);
  }
});

test("every non-global IPv6 range is refused, mapped IPv4 judged as the IPv4", () => {
  for (
    const address of [
      "::1",
      "::",
      "[::1]",
      "fc00::1", // unique local
      "fd12:3456::1",
      "fe80::1", // link-local
      "fec0::1", // site-local, deprecated, still routed
      "feff:ffff::1",
      "ff02::1", // multicast
      "100::1", // discard
      "2001:db8::1", // documentation
      "2001:0:53aa::1", // Teredo
      "2001::1",
      "3fff::1",
      "::ffff:127.0.0.1", // IPv4-mapped, dotted
      "::ffff:a00:1", // the same address in the hex spelling a URL parser produces
      "::ffff:7f00:1",
      "::ffff:a9fe:a9fe",
      "[::ffff:0a00:0105]",
      "::ffff:169.254.169.254",
      "::ffff:168.63.129.16",
    ]
  ) {
    assert(isBlockedAddress(address), `${address} must be refused`);
  }
});

test("every other way to wrap an IPv4 address is refused, around a public one too", () => {
  for (
    const address of [
      "::127.0.0.1", // IPv4-compatible
      "::7f00:1",
      "::8.8.8.8",
      "2002:7f00:1::", // 6to4
      "2002:c0a8:101::1",
      "2002:a00:1::",
      "2002:8c52:7003::1", // 6to4 around a public address: still a translator's
      "2002:6810:1::",
      "64:ff9b::1", // NAT64
      "64:ff9b::7f00:1",
      "64:ff9b::a00:1",
      "64:ff9b::169.254.169.254",
      "64:ff9b::8c52:7003", // well-known NAT64 around a public address
      "64:ff9b::1.1.1.1",
      "64:ff9b:1::7f00:1", // local-use NAT64, /96 layout
      "64:ff9b:1:7f00:0:100::", // local-use NAT64, /48 layout
      "64:ff9b:1::0808:0808",
      "64:ff9b:2::1",
      "::ffff:0:127.0.0.1", // SIIT, loopback
      "::ffff:0:a9fe:a9fe", // SIIT, the metadata address
      "::ffff:0:1.1.1.1", // SIIT around a public address
    ]
  ) {
    assert(isBlockedAddress(address), `${address} must be refused`);
  }
});

test("an address nothing can parse is refused rather than assumed public", () => {
  for (
    const address of [
      "not-an-address",
      "not:an:address",
      "garbage",
      "999.1.1.1",
      "256.1.1.1",
      "010.0.0.1", // octal to some parsers, decimal to others
      "1.2.3",
      "0x7f000001",
      "2130706433",
      "fe80::1%eth0", // a zone id
      "2606:4700::1%1",
      "1:2:3:4:5:6:7:8:9",
      "1::2::3",
      "::ffff:999.0.0.1",
      "",
    ]
  ) {
    assert(isBlockedAddress(address), `${address} must be refused`);
  }
});

test("parseIp reads both families and nothing else", () => {
  assertEquals(parseIp("mcp.example.com"), null);
  assertEquals(parseIp("256.1.1.1"), null);
  assertEquals(parseIp("999.1.1.1"), null);
  assertEquals(parseIp("1.2.3.4"), { v: 4, octets: [1, 2, 3, 4] });
  assertEquals(parseIp("0.0.0.0"), { v: 4, octets: [0, 0, 0, 0] });
  assertEquals(parseIp("::1"), { v: 6, groups: [0, 0, 0, 0, 0, 0, 0, 1] });
  assertEquals(parseIp("[::1]")?.v, 6);
  assertEquals(parseIp("::ffff:1.2.3.4"), { v: 6, groups: [0, 0, 0, 0, 0, 0xffff, 0x102, 0x304] });
  assertEquals(parseIp("1:2:3:4:5:6:7:8"), { v: 6, groups: [1, 2, 3, 4, 5, 6, 7, 8] });
  assertEquals(parseIp("1:2:3:4:5:6:7:8:9"), null);
  assertEquals(parseIp("1:2:3:4::5:6:7:8"), null);
  assertEquals(parseIp("1::2::3"), null);
  assertEquals(parseIp("fe80::1%eth0"), null);
});

test("loopback is localhost, *.localhost, 127/8 and ::1, however a host spells them", () => {
  for (
    const host of [
      "localhost",
      "LOCALHOST",
      " localhost ",
      "app.localhost",
      "localhost.",
      "app.localhost.",
      "127.0.0.1",
      "127.1.2.3",
      "::1",
      "[::1]",
      "0:0:0:0:0:0:0:1",
      "::ffff:127.0.0.1",
      "[::ffff:7f00:1]",
    ]
  ) {
    assert(isLoopbackHost(host), host);
  }
  for (
    const host of [
      "localhost.example.com",
      "mylocalhost",
      "128.0.0.1",
      "10.0.0.1",
      "0.0.0.0",
      "::",
      "::2",
      "::ffff:10.0.0.1",
      "example.com",
      "127.0.0.1.nip.io",
    ]
  ) {
    assertEquals(isLoopbackHost(host), false, host);
  }
});

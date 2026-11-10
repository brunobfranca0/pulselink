// PlayStation discovery: unit-tests the reply parser and runs a fake PS5 on localhost UDP 9302
// to exercise the full discovery path (route → broadcast/unicast → parse).
import dgram from "node:dgram";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { discoverConsoles, parseDiscoveryReply } from "../dist/playstation.js";

describe("parseDiscoveryReply", () => {
  test("ready PS4", () => {
    const c = parseDiscoveryReply(
      "HTTP/1.1 200 Ok\nhost-id:AABBCCDDEEFF\nhost-type:PS4\nhost-name:PS4-Sala\nsystem-version:11008001\nrunning-app-name:Netflix\n",
      "192.168.0.50",
    );
    assert.deepEqual(c, {
      address: "192.168.0.50",
      hostId: "AABBCCDDEEFF",
      name: "PS4-Sala",
      type: "PS4",
      state: "ready",
      systemVersion: "11008001",
      runningApp: "Netflix",
    });
  });

  test("standby PS5", () => {
    const c = parseDiscoveryReply("HTTP/1.1 620 Server Standby\r\nhost-type:PS5\r\nhost-name:Quarto\r\n", "10.0.0.2");
    assert.equal(c.state, "standby");
    assert.equal(c.type, "PS5");
    assert.equal(c.name, "Quarto");
  });

  test("garbage is ignored", () => {
    assert.equal(parseDiscoveryReply("hello", "1.2.3.4"), null);
  });
});

describe("discoverConsoles", () => {
  test("finds a console that answers a unicast search", async (t) => {
    const fake = dgram.createSocket("udp4");
    const requests = [];
    fake.on("message", (msg, rinfo) => {
      requests.push(msg.toString());
      fake.send(
        Buffer.from("HTTP/1.1 620 Server Standby\nhost-id:FAKE01\nhost-type:PS5\nhost-name:PS5-Teste\nsystem-version:09000000\n"),
        rinfo.port,
        rinfo.address,
      );
    });
    try {
      await new Promise((res, rej) => {
        fake.once("error", rej);
        fake.bind(9302, "127.0.0.1", res);
      });
    } catch (err) {
      t.skip(`UDP 9302 indisponível: ${err.message}`);
      return;
    }
    try {
      const consoles = await discoverConsoles(["127.0.0.1", "not a host; rm -rf"], 600);
      const found = consoles.find((c) => c.hostId === "FAKE01");
      assert.ok(found, "fake console discovered");
      assert.equal(found.state, "standby");
      assert.equal(found.registered, false);
      assert.match(requests[0], /^SRCH \* HTTP\/1\.1\ndevice-discovery-protocol-version:00030010\n$/);
    } finally {
      fake.close();
    }
  });
});

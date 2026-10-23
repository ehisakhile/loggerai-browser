import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// A browser page for the SDK: jsdom's window, with fetch and sendBeacon that record what's sent.
const dom = new JSDOM("<!doctype html><title>Shop</title><button id=pay>Pay now</button>", { url: "https://shop.example/orders/1234?token=abc" });
const sent = [];
const beacons = [];
dom.window.fetch = async (url, init) => {
  sent.push({ url: String(url), init });
  return new Response(JSON.stringify({ id: 42 }), { status: 200 });
};
dom.window.navigator.sendBeacon = (url, blob) => {
  beacons.push({ url, blob });
  return true;
};
for (const k of ["window", "document", "location", "history", "navigator", "screen", "sessionStorage", "XMLHttpRequest", "HTMLElement"]) {
  Object.defineProperty(globalThis, k, { value: k === "window" ? dom.window : dom.window[k], configurable: true, writable: true });
}

const L = await import("../src/index.js");
const batches = () => sent.filter((s) => s.url.includes("/ingest/batch")).map((s) => JSON.parse(s.init.body));

beforeEach(() => {
  sent.length = 0;
  beacons.length = 0;
});
afterEach(() => L.close());

test("does nothing without a public key, or with a secret key", () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(L.init({}), false);
    assert.equal(L.init({ publicKey: "sk_live_x" }), false);
  } finally {
    console.warn = warn;
  }
  assert.equal(L.isStarted(), false);
});

test("records the session, pages, clicks and requests, with secrets masked", async () => {
  assert.equal(L.init({ publicKey: "pk_test_1", release: "v2", user: 7 }), true);
  assert.equal(L.init({ publicKey: "pk_test_1" }), true); // a second call (React's double effect) changes nothing
  document.getElementById("pay").click();
  history.pushState({}, "", "/checkout?lat=6.5&lng=3.3");
  await window.fetch("/api/cart?access_token=xyz");
  L.flush();
  const [b] = batches();
  assert.equal(sent[sent.length - 1].url, "https://loggerapp.ehigiator.com/api/v1/ingest/batch?key=pk_test_1");
  assert.equal(b.sessions[0].id, L.sessionId());
  assert.equal(b.sessions[0].user, "7");
  assert.equal(b.release, "v2");
  const types = b.events.map((e) => e.type);
  assert.deepEqual(types, ["page_view", "click", "navigation", "network_request"]);
  assert.match(b.events[0].payload.url, /token=%5BREDACTED%5D/);
  assert.equal(b.events[1].payload.text, "Pay now");
  assert.match(b.events[2].payload.url, /lat=%5BREDACTED%5D&lng=%5BREDACTED%5D/);
  assert.match(b.events[3].payload.url, /access_token=%5BREDACTED%5D/);
  assert.equal(b.events[3].payload.status, 200);
});

test("same-origin requests carry the trace headers; other hosts only when listed", async () => {
  L.init({ publicKey: "pk_test_1", traceHosts: ["api.shop.example"] });
  await window.fetch("/api/a");
  await window.fetch("https://api.shop.example/b");
  await window.fetch("https://maps.other.com/c");
  const calls = sent.filter((s) => !s.url.includes("/ingest/"));
  const headers = calls.map((c) => c.init && c.init.headers && new Headers(c.init.headers));
  assert.match(headers[0].get("traceparent"), /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  assert.equal(headers[1].get("x-loggerai-session"), L.sessionId());
  assert.equal(headers[2], undefined);
});

test("errors go to the Errors page, grouped by route, and into the session", () => {
  L.init({ publicKey: "pk_test_1" });
  history.pushState({}, "", "/orders/987/items");
  const err = new TypeError("Cannot read properties of undefined (reading 'total')");
  err.stack = `TypeError: Cannot read properties of undefined (reading 'total')
    at Cart (https://shop.example/_next/static/chunks/app/cart/page-1a2b.js:3:1405)
    at renderWithHooks (https://shop.example/_next/static/chunks/framework-9f.js:1:2000)`;
  L.captureException(err, { password: "hunter2", step: "cart" });
  L.flush();
  const [b] = batches();
  const e = b.errors[0];
  assert.equal(e.type, "TypeError");
  assert.equal(e.route, "/orders/:id/items");
  assert.equal(e.method, "BROWSER");
  assert.deepEqual(e.frames[0], { file: "/_next/static/chunks/app/cart/page-1a2b.js", line: 3, column: 1405, function: "Cart", in_app: true });
  assert.equal(e.frames[1].in_app, false);
  assert.equal(e.context.password, "[REDACTED]");
  assert.equal(e.context.session_id, L.sessionId());
  assert.ok(b.events.some((x) => x.type === "console_error" && x.payload.source.endsWith("page-1a2b.js:3:1405")));
});

test("uncaught errors are sent at once", () => {
  L.init({ publicKey: "pk_test_1" });
  window.dispatchEvent(new window.ErrorEvent("error", { message: "boom", error: new Error("boom") }));
  const b = batches();
  assert.equal(b.length, 1);
  assert.equal(b[0].errors[0].message, "boom");
  assert.equal(b[0].errors[0].handled, false);
});

test("big backlogs go in several batches under the server's limit", () => {
  L.init({ publicKey: "pk_test_1" });
  for (let i = 0; i < 900; i++) L.track("step", { blob: "x".repeat(900) });
  L.flush();
  const b = batches();
  assert.ok(b.length >= 2, `${b.length} batches`);
  for (const s of sent) assert.ok(s.init.body.length < 1_000_000);
  assert.equal(b.reduce((n, x) => n + x.events.length, 0), 901); // the page view too
  assert.ok(b.every((x) => x.sessions.length === 1));
});

test("when the page goes away, what's left goes in a beacon", () => {
  L.init({ publicKey: "pk_test_1" });
  L.track("leaving");
  window.dispatchEvent(new window.Event("pagehide"));
  assert.equal(beacons.length, 1);
  assert.match(beacons[0].url, /key=pk_test_1$/);
});

test("report sends the note with the session and resolves to the issue id", async () => {
  L.init({ publicKey: "pk_test_1" });
  L.setUser("u-1");
  const id = await L.report("The pay button does nothing", { contact: "ada@example.com" });
  assert.equal(id, 42);
  const r = sent.find((s) => s.url.includes("/ingest/report"));
  assert.match(r.url, /\/ingest\/report\?key=pk_test_1$/);
  const fields = JSON.parse(r.init.body.get("report"));
  assert.equal(fields.session_id, L.sessionId());
  assert.equal(fields.user, "u-1");
  assert.equal(fields.platform, "browser");
  assert.equal(fields.contact, "ada@example.com");
  // The session and its steps went first, so the issue links to them.
  assert.ok(sent.findIndex((s) => s.url.includes("/ingest/batch")) < sent.indexOf(r));
});

test("close puts fetch, history and console back", () => {
  const before = { fetch: window.fetch, push: history.pushState, error: console.error };
  L.init({ publicKey: "pk_test_1" });
  assert.notEqual(window.fetch, before.fetch);
  L.close();
  assert.equal(window.fetch, before.fetch);
  assert.equal(history.pushState, before.push);
  assert.equal(console.error, before.error);
});

test("frames reads Firefox and Safari stacks too", () => {
  const f = L.frames("handle@https://shop.example/assets/app.js:10:5\n@https://shop.example/node_modules/x.js:1:1", "https://shop.example");
  assert.deepEqual(f[0], { file: "/assets/app.js", line: 10, column: 5, function: "handle", in_app: true });
  assert.equal(f[1].in_app, false);
});

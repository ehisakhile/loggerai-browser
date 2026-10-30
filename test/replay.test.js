import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// Replay in a jsdom page: what reaches /ingest/replay, and that typed text and marked elements are masked.
const dom = new JSDOM(
  `<!doctype html><title>Shop</title><form><input id=card value="4242 4242 4242 4242"><input type=password value=hunter2></form>
   <p data-loggerai-mask>Balance £1,234</p><div data-loggerai-block>secret panel</div><p>Hello</p>`,
  { url: "https://shop.example/checkout", pretendToBeVisual: true },
);
const sent = [];
dom.window.fetch = async (url, init) => {
  sent.push({ url: String(url), init });
  return new Response("{}", { status: 202 });
};
dom.window.navigator.sendBeacon = () => false;
for (const k of ["window", "document", "location", "history", "navigator", "screen", "sessionStorage", "XMLHttpRequest", "HTMLElement",
                 "MutationObserver", "Node", "Element", "CSSStyleSheet", "requestAnimationFrame"]) {
  Object.defineProperty(globalThis, k, { value: k === "window" ? dom.window : dom.window[k], configurable: true, writable: true });
}
for (const k of Object.getOwnPropertyNames(dom.window).filter((n) => /^(HTML|SVG|CSS)\w*$/.test(n) && !(n in globalThis))) globalThis[k] = dom.window[k];

const { startReplay } = await import("../src/replay.js");

test("sends chunks to /ingest/replay with typed text and marked elements masked", async () => {
  const stop = startReplay({ sessionId: "6cb839bb-609a-4862-a5e2-92ebbd649e38", endpoint: "https://api.example/api/v1/ingest/batch", key: "pk_test_1", send: dom.window.fetch });
  document.querySelector("p:last-of-type").textContent = "Hello again";
  await new Promise((r) => setTimeout(r, 50));
  stop();
  const chunks = sent.filter((s) => s.url.startsWith("https://api.example/api/v1/ingest/replay?key=pk_test_1"));
  assert.ok(chunks.length >= 1);
  const body = JSON.parse(chunks[0].init.body);
  assert.equal(body.session_id, "6cb839bb-609a-4862-a5e2-92ebbd649e38");
  assert.equal(body.seq, 0);
  assert.ok(body.events.some((e) => e.type === 2), "a full snapshot");
  const all = chunks.map((c) => c.init.body).join("");
  assert.ok(!all.includes("4242"), "card number masked");
  assert.ok(!all.includes("hunter2"), "password masked");
  assert.ok(!all.includes("1,234"), "marked text masked");
  assert.ok(!all.includes("secret panel"), "blocked element left out");
  assert.ok(all.includes("Hello"), "other text kept");
});

test("a session outside the sample rate records nothing", () => {
  sessionStorage.clear();
  sent.length = 0;
  const stop = startReplay({ sessionId: "s2", endpoint: "https://api.example/api/v1/ingest/batch", key: "pk", send: dom.window.fetch }, { sampleRate: 0 });
  stop();
  assert.equal(sent.length, 0);
});

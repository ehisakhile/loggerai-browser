import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><title>Shop</title><input id=card value=4242>", { url: "https://shop.example/pay" });
const sent = [];
dom.window.fetch = async (url, init) => {
  sent.push({ url: String(url), init });
  return new Response(JSON.stringify({ id: 77 }), { status: 200 });
};
for (const k of ["window", "document", "location", "history", "navigator", "screen", "sessionStorage", "XMLHttpRequest", "HTMLElement"]) {
  Object.defineProperty(globalThis, k, { value: k === "window" ? dom.window : dom.window[k], configurable: true, writable: true });
}

const L = await import("../src/index.js");
afterEach(() => L.close());

const sheet = () => document.querySelector("[data-loggerai-ignore]")?.shadowRoot;
const tick = () => new Promise((r) => setTimeout(r, 0));

test("the sheet sends the note and email, then thanks them", async () => {
  L.init({ publicKey: "pk_test_1" });
  const done = L.showReportSheet({ contact: "ada@example.com" });
  const root = sheet();
  assert.ok(root, "the sheet is on the page");
  const send = () => [...root.querySelectorAll("button")].find((b) => b.textContent === "Send");
  assert.equal(send().disabled, true, "nothing to send yet");
  // jsdom can't share the screen, so there are no capture buttons; the note still goes.
  assert.equal([...root.querySelectorAll("button")].some((b) => /Screenshot|Record/.test(b.textContent)), false);
  const note = root.querySelector("textarea");
  note.value = "Pay does nothing";
  note.dispatchEvent(new window.Event("input"));
  assert.equal(send().disabled, false);
  send().click();
  await tick();
  await tick();
  const r = sent.find((s) => s.url.includes("/ingest/report"));
  const fields = JSON.parse(r.init.body.get("report"));
  assert.equal(fields.note, "Pay does nothing");
  assert.equal(fields.contact, "ada@example.com");
  assert.match(root.textContent, /Thanks, it's sent/);
  [...root.querySelectorAll("button")].find((b) => b.textContent === "Done").click();
  assert.equal(await done, 77);
  assert.equal(sheet(), undefined, "closed");
});

test("Escape closes it without sending", async () => {
  L.init({ publicKey: "pk_test_1" });
  const done = L.showReportSheet();
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
  assert.equal(await done, null);
  assert.equal(sent.filter((s) => s.url.includes("/ingest/report")).length, 1); // only the first test's
});

test("reportButton adds a button that opens the sheet", async () => {
  L.init({ publicKey: "pk_test_1", reportButton: { label: "Problem?" } });
  const btn = sheet().querySelector("button");
  assert.equal(btn.textContent, "Problem?");
  btn.click();
  const hosts = document.querySelectorAll("[data-loggerai-ignore]");
  assert.equal(hosts.length, 2);
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
  L.close();
  assert.equal(document.querySelectorAll("[data-loggerai-ignore]").length, 0, "close() removes the button");
});

test("recordings are in the format the server reads", async () => {
  const jpeg = (n) => new Blob([new Uint8Array([0xff, 0xd8, n, 0xff, 0xd9])], { type: "image/jpeg" });
  const blob = await L.encodeRecording([{ t: 0, blob: jpeg(1) }, { t: 500, blob: jpeg(2) }, { t: 1000, blob: jpeg(3) }], 1024, 640);
  const bytes = Buffer.from(await blob.arrayBuffer());
  assert.equal(bytes.subarray(0, 4).toString(), "LREC");
  const n = bytes.readUInt32BE(4);
  const head = JSON.parse(bytes.subarray(8, 8 + n).toString());
  assert.deepEqual(head.frames[1], { t: 500, o: 5, n: 5 });
  assert.equal(bytes.length, 8 + n + 15);
  // The API's own check, when its code is next to this repository.
  const api = join(import.meta.dirname, "..", "..", "loggerai_api");
  let py = null;
  try {
    const file = join(mkdtempSync(join(tmpdir(), "lrec-")), "r.lrec");
    writeFileSync(file, bytes);
    const code = `import ast,sys,struct,json\nsrc=open(sys.argv[1]+'/app/observability/issues.py').read()\nm=ast.parse(src)\nf=[n for n in m.body if isinstance(n,ast.FunctionDef) and n.name=='read_recording'][0]\nns={'struct':struct,'json':json}\nexec(compile(ast.Module([f],[]),'x','exec'),ns)\nprint(json.dumps(ns['read_recording'](open(sys.argv[2],'rb').read())))`;
    py = execFileSync("python3", ["-c", code, api, file]).toString();
  } catch (e) {
    if (!String(e.message).includes("No such file")) throw e;
  }
  if (py) assert.deepEqual(JSON.parse(py), { width: 1024, height: 640, frames: 3, duration_ms: 1000 });
});

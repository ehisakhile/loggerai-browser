import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

// Rendering on the server (Next.js, Remix): importing and rendering must not touch the browser.
test("renders on the server without starting", async () => {
  const { LoggerAIProvider, ErrorBoundary } = await import("../src/react.js");
  const { LoggerAI } = await import("../src/next.js");
  const { isStarted } = await import("../src/index.js");
  const html = renderToString(
    createElement(LoggerAIProvider, { publicKey: "pk_test_1" }, createElement(ErrorBoundary, { fallback: "x" }, createElement("p", null, "hello")), createElement(LoggerAI)),
  );
  assert.equal(html, "<p>hello</p>");
  assert.equal(isStarted(), false);
});

test("init on the server does nothing", async () => {
  const { init } = await import("../src/index.js");
  assert.equal(init({ publicKey: "pk_test_1" }), false);
});

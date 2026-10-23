/*! @loggerai/browser · https://loggerai.uk
 * Records what happens in a web app (pages, clicks, requests, errors) as a session, sends
 * its errors to the Errors page, and links each request to what the server did with it.
 * Never records what people type. Safe to import while rendering on the server: nothing
 * runs until init() is called in a browser.
 */
import { VERSION } from "./version.js";
import { mountReportButton, showReportSheet } from "./report-ui.js";

export { VERSION };
export { canCapture, lrec as encodeRecording, mountReportButton, showReportSheet } from "./report-ui.js";
export const DEFAULT_ENDPOINT = "https://loggerapp.ehigiator.com/api/v1/ingest/batch";

const MASK = "[REDACTED]";
const MAX_EVENTS = 1000;     // waiting to be sent; the oldest go first
const MAX_ERRORS = 50;
const BATCH_BYTES = 400_000; // the server takes up to 1 MB a batch
const BEACON_BYTES = 60_000; // browsers cap a beacon (and a keepalive fetch) near 64 KB

let state = null; // set by init()

// ---- ids --------------------------------------------------------------------------------------------

function hex(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const h = hex(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const store = {
  get(k) {
    try {
      return sessionStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      sessionStorage.setItem(k, v);
    } catch {}
  },
};

// ---- redaction (the same rules as the server and the other SDKs) ---------------------------------------

const WORDS = new Set(["password", "passwd", "pwd", "pass", "passphrase", "secret", "token", "otp", "pin", "cvv", "cvc", "ssn", "cookie",
  "authorization", "auth", "signature", "sig", "credential", "credentials", "bvn", "nin"]);
const JOINED = ["apikey", "accesskey", "privatekey", "secretkey", "cardnumber", "clientsecret", "sessionid", "authtoken", "accesstoken",
  "refreshtoken", "idtoken", "csrftoken", "xsrf", "setcookie"];
// Where someone is: kept out of URLs and payloads.
const LOCATION = new Set(["lat", "lng", "lon", "long", "latitude", "longitude", "user_lat", "user_lon", "user_lng", "geo", "coords", "coordinates"]);
const URL_EXTRA = new Set(["key", "code", "access_token", "id_token"]);

export function sensitive(key) {
  if (typeof key !== "string" || !key) return false;
  if (LOCATION.has(key.toLowerCase())) return true;
  const words = key.split(/[^A-Za-z0-9]+|(?=[A-Z][a-z])/).filter(Boolean).map((w) => w.toLowerCase());
  if (words.some((w) => WORDS.has(w))) return true;
  const joined = words.join("");
  return JOINED.some((j) => joined.includes(j));
}

export function scrub(s) {
  return String(s)
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED_JWT]")
    .replace(/\b(bearer|basic|token)\s+[A-Za-z0-9\-._~+/]{12,}=*/gi, (_, k) => `${k} ${MASK}`);
}

export function cleanUrl(u) {
  try {
    const url = new URL(u, location.href);
    url.username = "";
    url.password = "";
    for (const [k, v] of [...url.searchParams]) {
      if (v && (sensitive(k) || URL_EXTRA.has(k.toLowerCase()))) url.searchParams.set(k, MASK);
    }
    return scrub(url.toString()).slice(0, 2000);
  } catch {
    return scrub(u).slice(0, 2000);
  }
}

export function redact(v, depth = 0) {
  if (depth > 6) return "[…]";
  if (typeof v === "string") return scrub(v).slice(0, 2000);
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redact(x, depth + 1));
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v).slice(0, 100)) out[k] = sensitive(k) ? MASK : redact(x, depth + 1);
    return out;
  }
  return v;
}

function text(s, n = 200) {
  return scrub(String(s ?? "")).replace(/\s+/g, " ").trim().slice(0, n);
}

/** /orders/1234 and /orders/5678 are one page: ids become :id, so errors group by route. */
export function routeOf(path) {
  return (path || "/")
    .split("?")[0]
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi, "/:id")
    .replace(/\/\d+(?=\/|$)/g, "/:id")
    .replace(/\/[0-9a-f]{24,}(?=\/|$)/gi, "/:id")
    .slice(0, 255);
}

// ---- stack traces ----------------------------------------------------------------------------------------

const VENDOR = /node_modules|\/_next\/static\/chunks\/(framework|main|webpack|polyfills|pages\/_app)|\/@vite\/|\/@react-refresh|react-dom|chrome-extension:|moz-extension:/;

/** Chrome's and Firefox/Safari's stack lines, innermost first: [{file, line, column, function, in_app}]. */
export function frames(stack, origin = typeof location !== "undefined" ? location.origin : "") {
  const out = [];
  for (const raw of String(stack || "").split("\n")) {
    const line = raw.trim();
    // Chrome: "at fn (https://x/app.js:10:5)" or "at https://x/app.js:10:5"
    let m = line.match(/^at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/);
    let fn, file, ln, col;
    if (m) [, fn, file, ln, col] = m;
    else {
      // Firefox / Safari: "fn@https://x/app.js:10:5"
      m = line.match(/^(.*?)@(.+?):(\d+):(\d+)$/);
      if (!m) continue;
      [, fn, file, ln, col] = m;
    }
    if (file.startsWith("async ")) file = file.slice(6);
    const sameOrigin = !!origin && file.startsWith(origin);
    out.push({
      file: (sameOrigin ? file.slice(origin.length) : file).split("?")[0].slice(0, 300),
      line: Number(ln),
      column: Number(col),
      function: (fn || "").replace(/^async /, "").slice(0, 200) || null,
      in_app: (sameOrigin || file.startsWith("/") || file.startsWith("webpack-internal:")) && !VENDOR.test(file),
    });
    if (out.length >= 50) break;
  }
  return out;
}

// ---- the browser -------------------------------------------------------------------------------------------

function device() {
  const u = navigator.userAgent;
  let browser = "Browser";
  let os = "Other";
  const m = u.match(/(Edg|OPR|Chrome|Firefox|Version)\/(\d+)/);
  if (m) browser = `${{ Edg: "Edge", OPR: "Opera", Version: "Safari" }[m[1]] || m[1]} ${m[2]}`;
  if (/iPhone|iPad|iPod/.test(u)) os = "iOS";
  else if (/Android/.test(u)) os = "Android";
  else if (/Mac OS X/.test(u)) os = "macOS";
  else if (/Windows/.test(u)) os = "Windows";
  else if (/Linux/.test(u)) os = "Linux";
  return { browser, os, device: /iPad|Tablet/.test(u) ? "tablet" : /Mobi|Android|iPhone/.test(u) ? "mobile" : "desktop" };
}

// ---- starting --------------------------------------------------------------------------------------------

/**
 * Starts recording. Call it once, in the browser (LoggerAIProvider and the Next.js <LoggerAI />
 * component do this for you). Calling it again does nothing, so React's double effects are fine.
 */
export function init(options) {
  if (typeof window === "undefined" || typeof document === "undefined") return false; // rendering on the server
  if (state) return true;
  const o = options || {};
  const key = o.publicKey || o.key;
  if (!key || !String(key).startsWith("pk_")) {
    console.warn("LoggerAI: pass your project's public key (pk_…, from its Connect page). Never the secret key in a browser.");
    return false;
  }
  if (o.enabled === false) return false;
  if (window.__loggerai) return true; // the Laravel package's script is already recording this page

  const endpoint = o.endpoint || DEFAULT_ENDPOINT;
  const startedKey = "loggerai_started";
  const sessionId = store.get("loggerai_session") || uuid();
  const startedAt = Number(store.get(startedKey)) || Date.now() / 1000;
  store.set("loggerai_session", sessionId);
  store.set(startedKey, String(startedAt));

  state = {
    key: String(key),
    endpoint,
    reportEndpoint: o.reportEndpoint || endpoint.replace(/\/batch\/?$/, "/report"),
    release: o.release || null,
    environment: o.environment || "production",
    service: o.service || "web",
    traceHosts: (o.traceHosts || []).map((h) => String(h).toLowerCase()),
    captureConsole: o.captureConsole !== false,
    sessionId,
    startedAt,
    user: o.user != null ? String(o.user) : null,
    events: [],
    errors: [],
    device: device(),
    timer: null,
    sent: false,
    undo: [],
    beforeSend: typeof o.beforeSend === "function" ? o.beforeSend : null,
  };
  window.__loggerai = { version: VERSION, sdk: "@loggerai/browser" };
  instrument(state);
  pageView("page_view");
  state.timer = setInterval(flush, o.flushInterval || 5000);
  if (o.reportButton) {
    const mount = () => state && state.undo.push(mountReportButton(o.reportButton === true ? {} : o.reportButton));
    if (document.body) mount();
    else document.addEventListener("DOMContentLoaded", mount, { once: true });
  }
  return true;
}

/** Stops recording and puts back everything it changed (for tests, and apps that let people opt out). */
export function close() {
  if (!state) return;
  flush(true);
  clearInterval(state.timer);
  for (const undo of state.undo.reverse()) undo();
  state = null;
  if (typeof window !== "undefined") delete window.__loggerai;
}

export function isStarted() {
  return !!state;
}

/** This visit's session id (the dashboard's Sessions page), or null before init(). */
export function sessionId() {
  return state ? state.sessionId : null;
}

/** Who's signed in: your own user id, so their sessions and reports can be found. Null when they sign out. */
export function setUser(id) {
  if (state) state.user = id == null ? null : String(id).slice(0, 64);
}

/** A step of your own in the session's timeline, e.g. track("checkout_started", { items: 3 }). */
export function track(name, data) {
  push("custom_event", { name: text(name, 80), ...(data ? { data: redact(data) } : {}) });
}

/** An error you caught: it goes to the Errors page (grouped with others like it) and into the session. */
export function captureException(error, context) {
  record(error, { handled: true, context });
}

function push(type, payload) {
  if (!state) return;
  let event = { session_id: state.sessionId, ts: Date.now() / 1000, type, payload: payload || {} };
  if (state.beforeSend) {
    try {
      event = state.beforeSend(event);
    } catch {}
    if (!event) return;
  }
  if (state.events.length >= MAX_EVENTS) state.events.shift();
  state.events.push(event);
}

function record(error, { handled, context, source } = {}) {
  if (!state) return;
  const e = error instanceof Error ? error : new Error(typeof error === "string" ? error : text(JSON.stringify(error ?? "unknown"), 500));
  const type = e.name && e.name !== "Error" ? e.name : e.constructor?.name || "Error";
  const message = text(e.message, 1000);
  const fr = frames(e.stack);
  if (state.errors.length >= MAX_ERRORS) state.errors.shift();
  state.errors.push({
    ts: Date.now() / 1000,
    type,
    message,
    handled: !!handled,
    route: routeOf(location.pathname),
    method: "BROWSER",
    status: null,
    frames: fr,
    // The session id goes on after redacting (its name looks like a session cookie's).
    context: { ...redact({ ...(context || {}), url: cleanUrl(location.href), ...(source ? { source } : {}) }), session_id: state.sessionId },
  });
  const top = fr.find((f) => f.in_app) || fr[0];
  push(handled ? "console_error" : "javascript_error", {
    message: `${type}: ${message.slice(0, 500)}`,
    source: top ? `${top.file}:${top.line}:${top.column}` : source,
    stack: e.stack ? text(e.stack, 2000) : undefined,
    handled: !!handled,
  });
  if (!handled) flush();
}

function pageView(kind) {
  push(kind, {
    url: cleanUrl(location.href),
    title: text(document.title, 200),
    ...(kind === "page_view" && document.referrer ? { referrer: cleanUrl(document.referrer) } : {}),
  });
}

// ---- sending -------------------------------------------------------------------------------------------

function session() {
  return {
    id: state.sessionId,
    started_at: state.startedAt,
    ended_at: Date.now() / 1000,
    page: cleanUrl(location.href),
    browser: state.device.browser,
    os: state.device.os,
    device: state.device.device,
    screen: [screen.width, screen.height],
    user: state.user,
  };
}

/** One batch: the session (every time, to move its end), then as many events and errors as fit. */
function batch(limit) {
  const head = {
    sdk: { name: "loggerai-browser", version: VERSION },
    service: state.service,
    environment: state.environment,
    release: state.release,
    sessions: [session()],
    events: [],
    errors: [],
  };
  let size = JSON.stringify(head).length;
  for (const [name, list] of [["errors", state.errors], ["events", state.events]]) {
    while (list.length) {
      const s = JSON.stringify(list[0]).length + 1;
      if (size + s > limit && (head.events.length || head.errors.length)) return head;
      head[name].push(list.shift());
      size += s;
    }
  }
  return head;
}

let origFetch = null;

/** Sends what's waiting. `final` when the page is going away: uses a beacon, which outlives the page. */
export function flush(final = false) {
  if (!state) return;
  // Nothing new: the session's end moves only when the page goes away.
  if (!state.events.length && !state.errors.length && state.sent && !final) return;
  state.sent = true;
  const url = state.endpoint + (state.endpoint.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(state.key);
  do {
    const body = JSON.stringify(batch(final ? BEACON_BYTES : BATCH_BYTES));
    // text/plain needs no CORS preflight.
    if (final && navigator.sendBeacon && body.length < BEACON_BYTES && navigator.sendBeacon(url, new Blob([body], { type: "text/plain" }))) continue;
    try {
      (origFetch || fetch).call(window, url, { method: "POST", body, headers: { "Content-Type": "text/plain" }, keepalive: final && body.length < BEACON_BYTES })
        .catch(() => {});
    } catch {}
  } while (state && (state.events.length || state.errors.length));
}

// ---- reports ----------------------------------------------------------------------------------------------

/**
 * Sends a problem someone reported, with what they did before it. Screenshots are Blobs (PNG or JPEG);
 * a recording is the LREC Blob showReportSheet makes. Resolves to the issue's id on the Issues page.
 * Or use showReportSheet(), which asks for all of this.
 */
export async function report(note, { screenshot, screenshots = [], recording, contact, extra, onProgress } = {}) {
  if (!state) throw new Error("LoggerAI isn't started: call init() first.");
  if (!String(note || "").trim()) throw new Error("Say what went wrong.");
  push("custom_event", { name: "issue_reported", note: text(note, 2000), url: cleanUrl(location.href) });
  flush(); // the session and its steps first, so the issue links to them
  const s = session();
  const form = new FormData();
  form.append("report", JSON.stringify({
    session_id: state.sessionId,
    note: scrub(String(note)).slice(0, 5000),
    screen: cleanUrl(location.href),
    user: state.user,
    ...(contact && String(contact).trim() ? { contact: String(contact).trim() } : {}),
    platform: "browser",
    device: `${s.device} · ${s.browser} on ${s.os}`,
    release: state.release,
    environment: state.environment,
    service: state.service,
    ...(extra ? { extra: redact(extra) } : {}),
  }));
  [screenshot, ...screenshots].filter(Boolean).slice(0, 5)
    .forEach((shot, i) => form.append("screenshot", shot, `screenshot-${i + 1}.${shot.type === "image/png" ? "png" : "jpg"}`));
  if (recording) form.append("recording", recording, "recording.lrec");
  const url = state.reportEndpoint + (state.reportEndpoint.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(state.key);
  const { status, body } = onProgress && typeof XMLHttpRequest !== "undefined" ? await upload(url, form, onProgress) : await post(url, form);
  if (status < 200 || status >= 300) {
    const detail = body && body.detail;
    throw new Error(typeof detail === "string" ? detail : status === 0 ? "Couldn't reach LoggerAI. Check your connection." : `LoggerAI answered ${status}`);
  }
  return body.id;
}

async function post(url, form) {
  const r = await (origFetch || fetch).call(window, url, { method: "POST", body: form });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

/** XHR, for the upload's progress (fetch can't report it). Ours, so it isn't recorded as a request. */
function upload(url, form, onProgress) {
  return new Promise((resolve) => {
    const x = new XMLHttpRequest();
    x.open("POST", url);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded, e.total);
    x.onload = () => {
      let body = {};
      try {
        body = JSON.parse(x.responseText || "{}");
      } catch {}
      resolve({ status: x.status, body });
    };
    x.onerror = () => resolve({ status: 0, body: {} });
    x.send(form);
  });
}

// ---- watching the page ---------------------------------------------------------------------------------------

function instrument(st) {
  const traced = (u) => {
    try {
      const url = new URL(u, location.href);
      return url.origin === location.origin || st.traceHosts.includes(url.host.toLowerCase());
    } catch {
      return false;
    }
  };
  const ours = (u) => String(u).startsWith(st.endpoint.split("?")[0]) || String(u).startsWith(st.reportEndpoint.split("?")[0]);
  const net = (method, u, status, started, trace, err) => {
    push("network_request", {
      method: String(method || "GET").toUpperCase(),
      url: cleanUrl(u),
      status: status || 0,
      duration_ms: Math.round(performance.now() - started),
      ...(trace ? { trace_id: trace } : {}),
      ...(err ? { error: text(err, 300) } : {}),
    });
  };
  const patch = (obj, name, make) => {
    const orig = obj[name];
    obj[name] = make(orig);
    st.undo.push(() => {
      obj[name] = orig;
    });
    return orig;
  };

  // fetch: the trace headers link a request to what the server did with it (same origin, or traceHosts).
  if (window.fetch) {
    origFetch = patch(window, "fetch", (orig) => function (input, init) {
      const u = typeof input === "string" ? input : input instanceof URL ? input.href : input && input.url;
      if (!u || ours(u)) return orig.apply(this, arguments);
      const method = (init && init.method) || (input && input.method) || "GET";
      const started = performance.now();
      let trace = null;
      if (traced(u)) {
        trace = hex(16);
        const headers = new Headers((init && init.headers) || (input && input.headers) || undefined);
        headers.set("traceparent", `00-${trace}-${hex(8)}-01`);
        headers.set("x-loggerai-session", st.sessionId);
        init = { ...(init || {}), headers };
        if (typeof Request !== "undefined" && input instanceof Request) input = new Request(input, init);
      }
      return orig.call(this, input, init).then(
        (res) => {
          net(method, u, res.status, started, trace);
          return res;
        },
        (e) => {
          net(method, u, 0, started, trace, e && e.message);
          throw e;
        },
      );
    });
    st.undo.push(() => {
      origFetch = null;
    });
  }

  if (window.XMLHttpRequest) {
    const P = XMLHttpRequest.prototype;
    patch(P, "open", (orig) => function (method, u) {
      this.__loggerai = { method, url: String(u) };
      return orig.apply(this, arguments);
    });
    patch(P, "send", (orig) => function () {
      const info = this.__loggerai;
      if (info && !ours(info.url)) {
        info.started = performance.now();
        if (traced(info.url)) {
          info.trace = hex(16);
          try {
            this.setRequestHeader("traceparent", `00-${info.trace}-${hex(8)}-01`);
            this.setRequestHeader("x-loggerai-session", st.sessionId);
          } catch {}
        }
        this.addEventListener("loadend", () => net(info.method, info.url, this.status, info.started, info.trace));
      }
      return orig.apply(this, arguments);
    });
  }

  // Pages: client-side navigation (Next.js, React Router) goes through history.
  for (const fn of ["pushState", "replaceState"]) {
    patch(history, fn, (orig) => function () {
      const before = location.href;
      const r = orig.apply(this, arguments);
      if (location.href !== before) pageView("navigation");
      return r;
    });
  }
  const on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    st.undo.push(() => target.removeEventListener(type, fn, opts));
  };
  on(window, "popstate", () => pageView("navigation"));

  const describe = (el) => {
    if (!el || !el.tagName) return "";
    let s = el.tagName.toLowerCase();
    if (el.id) s += `#${el.id}`;
    else if (el.classList && el.classList.length) s += `.${[...el.classList].slice(0, 2).join(".")}`;
    return s.slice(0, 120);
  };
  on(document, "click", (e) => {
    const el = e.target && e.target.closest ? e.target.closest("a,button,[role=button],input[type=submit],input[type=button],label,summary") : null;
    if (!el || el.closest("[data-loggerai-ignore]")) return;
    const label = el.tagName === "INPUT" ? el.value : el.getAttribute("aria-label") || el.textContent;
    push("click", { target: describe(el), text: text(label, 80), ...(el.href ? { href: cleanUrl(el.href) } : {}) });
  }, true);
  on(document, "submit", (e) => {
    const f = e.target;
    push("form_submit", { target: describe(f), ...(f.action ? { action: cleanUrl(f.action) } : {}), method: (f.method || "get").toUpperCase(),
      fields: f.elements ? f.elements.length : 0 });
  }, true);

  // Errors nobody caught.
  on(window, "error", (e) => {
    if (!e.message && !e.error) return; // a failed <img> or <script>, not a JavaScript error
    record(e.error || new Error(e.message), { handled: false, source: e.filename ? `${cleanUrl(e.filename)}:${e.lineno}:${e.colno}` : undefined });
  });
  on(window, "unhandledrejection", (e) => {
    const r = e.reason;
    const err = r instanceof Error ? r : new Error(typeof r === "string" ? r : text(JSON.stringify(r ?? "unknown"), 500));
    if (!(r instanceof Error)) err.name = "UnhandledRejection";
    record(err, { handled: false });
  });

  if (st.captureConsole) {
    for (const level of ["error", "warn"]) {
      patch(console, level, (orig) => function (...args) {
        try {
          const msg = args.map((a) => {
            if (a instanceof Error) return a.message;
            if (typeof a === "object") {
              try {
                return JSON.stringify(a);
              } catch {
                return String(a);
              }
            }
            return String(a);
          }).join(" ");
          push(level === "error" ? "console_error" : "console_warning", { message: text(msg, 1000) });
        } catch {}
        return orig.apply(this, args);
      });
    }
  }

  on(document, "visibilitychange", () => {
    if (document.visibilityState === "hidden") flush(true);
  });
  on(window, "pagehide", () => flush(true));
}

export default { init, close, flush, setUser, track, captureException, report, showReportSheet, sessionId, isStarted };


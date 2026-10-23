// "Report a problem" for the browser, like the Flutter SDK's sheet: a note, an email to reply to,
// screenshots and a screen recording, sent with the session. Plain DOM in a shadow root, so it works
// in any app and the page's CSS can't reach it.
//
// What people typed never ends up in a picture: while the screen is captured, every input, text area,
// select and editable area (and anything with data-loggerai-mask) is blurred.

import { report } from "./index.js";

const MAX_SHOTS = 5;
const MAX_RECORDING_MS = 90_000;
const MAX_RECORDING_BYTES = 22_000_000; // the server takes 25 MB
const FRAME_MS = 500;                   // two frames a second: enough to follow what happened
const SHOT_WIDTH = 1920;
const FRAME_WIDTH = 1024;

const MASK = [
  "input:not([type=button]):not([type=submit]):not([type=reset]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color])",
  "textarea", "select", "[contenteditable]:not([contenteditable=false])", "[data-loggerai-mask]",
];

let open = null; // the sheet on screen, if any

/** Whether this browser can capture the screen (desktop Chrome, Edge, Firefox, Safari 13+; not phones). */
export function canCapture() {
  return typeof navigator !== "undefined" && !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
}

// ---- masking -------------------------------------------------------------------------------------------

function mask(on, extra = []) {
  const id = "loggerai-mask";
  let el = document.getElementById(id);
  if (!on) return el && el.remove();
  if (el) return;
  el = document.createElement("style");
  el.id = id;
  el.textContent = `${[...MASK, ...extra].join(",")}{filter:blur(7px) !important;-webkit-text-security:disc !important}`;
  document.head.appendChild(el);
}

// ---- capturing -------------------------------------------------------------------------------------------

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

/** Asks to share this tab (Chrome and Edge offer it first) and returns a playing video of it. */
async function shareTab() {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: "browser", frameRate: 5 },
    audio: false,
    preferCurrentTab: true,
    selfBrowserSurface: "include",
    surfaceSwitching: "exclude",
  });
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play();
  return { stream, video, stop: () => stream.getTracks().forEach((t) => t.stop()) };
}

function draw(video, maxWidth, type, quality) {
  const scale = Math.min(1, maxWidth / (video.videoWidth || maxWidth));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round((video.videoWidth || 1280) * scale));
  c.height = Math.max(1, Math.round((video.videoHeight || 720) * scale));
  c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
  return new Promise((r) => c.toBlob((b) => r({ blob: b, width: c.width, height: c.height }), type, quality));
}

/** A recording in LoggerAI's format: "LREC", the header's length, the JSON header, then the frames. */
export async function lrec(frames, width, height) {
  const parts = [];
  let offset = 0;
  const index = frames.map((f) => {
    const x = { t: f.t, o: offset, n: f.blob.size };
    offset += f.blob.size;
    parts.push(f.blob);
    return x;
  });
  const head = new TextEncoder().encode(JSON.stringify({ v: 1, width, height, frames: index }));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, head.length);
  return new Blob([new TextEncoder().encode("LREC"), len, head, ...parts], { type: "application/x-loggerai-recording" });
}

// ---- the sheet ----------------------------------------------------------------------------------------------

const CSS = `
:host{all:initial}
*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.scrim{position:fixed;inset:0;background:rgba(15,23,20,.45);display:flex;align-items:flex-end;justify-content:center;z-index:2147483646}
@media(min-width:640px){.scrim{align-items:center;padding:16px}}
.sheet{width:100%;max-width:440px;max-height:92vh;overflow:auto;background:var(--bg);color:var(--ink);border-radius:20px 20px 0 0;padding:20px;box-shadow:0 20px 60px rgba(0,0,0,.3)}
@media(min-width:640px){.sheet{border-radius:20px}}
h2{margin:0 0 4px;font-size:18px}
p{margin:0;color:var(--ink2);font-size:13px;line-height:1.45}
label{display:block;margin-top:14px;font-size:13px;font-weight:600}
textarea,input{display:block;width:100%;margin-top:6px;padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:var(--field);color:var(--ink);font-size:14px}
textarea{min-height:96px;resize:vertical}
textarea:focus,input:focus{outline:2px solid var(--brand);outline-offset:-1px}
.row{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap}
button{cursor:pointer;border:0;border-radius:999px;padding:10px 14px;font-size:14px;font-weight:600}
.soft{background:var(--soft);color:var(--ink)}
.primary{background:var(--brand);color:#fff;flex:1}
.primary:disabled{opacity:.5;cursor:default}
.ghost{background:none;color:var(--ink2);padding:10px 8px}
.shots{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
.shot{position:relative;width:64px;height:64px;border-radius:10px;overflow:hidden;border:1px solid var(--line);background:#000}
.shot img{width:100%;height:100%;object-fit:cover}
.shot button{position:absolute;top:2px;right:2px;padding:0;width:20px;height:20px;line-height:20px;background:rgba(0,0,0,.6);color:#fff;font-size:12px}
.rec{display:flex;align-items:center;gap:8px;margin-top:12px;padding:10px 12px;border-radius:12px;background:var(--soft);font-size:13px}
.rec span{flex:1}
.err{margin-top:12px;color:#c62828;font-size:13px}
.note{margin-top:12px;font-size:12px;color:var(--ink2)}
.done{text-align:center;padding:12px 0 4px}
.tick{width:56px;height:56px;margin:0 auto 12px;border-radius:50%;background:var(--soft);color:var(--brand);display:flex;align-items:center;justify-content:center;font-size:28px}
.pill{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);display:flex;align-items:center;gap:6px;padding:6px 6px 6px 14px;border-radius:999px;background:#111;color:#fff;font-size:13px;font-weight:600;z-index:2147483647;box-shadow:0 8px 24px rgba(0,0,0,.35)}
.dot{width:8px;height:8px;border-radius:50%;background:#e53935;animation:blink 1s infinite}
@keyframes blink{50%{opacity:.3}}
.pill button{background:#333;color:#fff;padding:6px 12px;font-size:13px}
.pill .stop{background:#e53935}
.progress{height:4px;border-radius:4px;background:var(--soft);margin-top:12px;overflow:hidden}
.progress div{height:100%;background:var(--brand);width:0;transition:width .2s}
`;

function theme(dark, brand) {
  return dark
    ? `--bg:#15191a;--ink:#eef2f0;--ink2:#9aa6a1;--line:#2b3331;--field:#1c2122;--soft:#232a29;--brand:${brand}`
    : `--bg:#fff;--ink:#14201b;--ink2:#5b6b64;--line:#dbe3df;--field:#fff;--soft:#eef4f1;--brand:${brand}`;
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "on") for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
    else if (k === "text") e.textContent = v;
    else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) e.append(c);
  return e;
}

/**
 * Opens "Report a problem". Resolves to the issue's id once sent, or null if they closed it.
 * Options: title, intro, contact (prefill the email), askContact (default true), allowCapture
 * (default true where the browser can), mask (more CSS selectors to blur), brand (a colour),
 * captureScreenshot (your own () => Promise<Blob>, e.g. html2canvas, for phones), extra.
 */
export function showReportSheet(options = {}) {
  if (typeof document === "undefined") return Promise.resolve(null);
  if (open) return open.promise;
  const o = {
    title: "Report a problem",
    intro: "Tell us what went wrong. We'll send it with what just happened in the app, so the team can see it and fix it.",
    askContact: true,
    allowCapture: true,
    brand: "#0b7350",
    mask: [],
    ...options,
  };
  const capture = o.allowCapture && (canCapture() || typeof o.captureScreenshot === "function");
  const record = o.allowCapture && canCapture();
  const dark = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;

  const host = el("div", { "data-loggerai-ignore": true, style: "position:fixed;z-index:2147483646" });
  const root = host.attachShadow({ mode: "open" });
  root.append(el("style", { text: CSS }));
  document.body.appendChild(host);

  const s = { note: "", contact: o.contact || "", shots: [], recording: null, busy: false, error: null, sent: null };
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  const close = (value = null) => {
    host.remove();
    mask(false);
    open = null;
    resolve(value);
  };
  open = { promise };

  const scrim = el("div", { class: "scrim", style: theme(dark, o.brand), on: { mousedown: (e) => e.target === scrim && !s.busy && close(s.sent) } });
  const sheet = el("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": o.title });
  scrim.append(sheet);
  root.append(scrim);
  const onKey = (e) => e.key === "Escape" && !s.busy && close(s.sent);
  document.addEventListener("keydown", onKey);
  promise.then(() => document.removeEventListener("keydown", onKey));

  const hide = (h) => {
    scrim.style.display = h ? "none" : "";
  };

  async function screenshot() {
    s.error = null;
    try {
      if (!canCapture()) {
        hide(true);
        mask(true, o.mask);
        await frame();
        const blob = await o.captureScreenshot();
        if (blob) s.shots.push({ blob, url: URL.createObjectURL(blob) });
        return;
      }
      const tab = await shareTab();
      hide(true);
      mask(true, o.mask);
      await frame();
      await wait(350); // the picker closing, and the blur, reach the shared picture
      const { blob } = await draw(tab.video, SHOT_WIDTH, "image/jpeg", 0.85);
      tab.stop();
      if (blob) s.shots.push({ blob, url: URL.createObjectURL(blob) });
    } catch (e) {
      if (e && e.name !== "NotAllowedError" && e.name !== "AbortError") s.error = "Couldn't take the screenshot.";
    } finally {
      mask(false);
      hide(false);
      render();
    }
  }

  async function startRecording() {
    s.error = null;
    let tab;
    try {
      tab = await shareTab();
    } catch (e) {
      if (e && e.name !== "NotAllowedError" && e.name !== "AbortError") s.error = "Couldn't record the screen.";
      return render();
    }
    hide(true);
    mask(true, o.mask);
    const frames = [];
    let bytes = 0;
    let size = { width: 0, height: 0 };
    const started = performance.now();
    let stopping = false;
    const timer = el("b", { text: "0:00" });
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      clearInterval(tick);
      pill.remove();
      tab.stop();
      mask(false);
      if (frames.length) {
        const blob = await lrec(frames, size.width, size.height);
        s.recording = { blob, seconds: Math.round((frames[frames.length - 1].t + FRAME_MS) / 1000) };
      }
      hide(false);
      render();
    };
    const pill = el("div", { class: "pill", role: "status", "aria-live": "polite" },
      el("span", { class: "dot" }), "Recording ", timer,
      el("button", { type: "button", title: "Take a screenshot", on: { click: async () => {
        const { blob } = await draw(tab.video, SHOT_WIDTH, "image/jpeg", 0.85);
        if (blob && s.shots.length < MAX_SHOTS) s.shots.push({ blob, url: URL.createObjectURL(blob) });
        timer.textContent = `${timer.textContent.split(" ")[0]} · ${s.shots.length} 📷`;
      } } }, "📷"),
      el("button", { type: "button", class: "stop", on: { click: stop } }, "Stop"));
    root.append(pill);
    tab.stream.getVideoTracks()[0].addEventListener("ended", stop); // they pressed the browser's own "Stop sharing"
    await frame();
    const tick = setInterval(async () => {
      const t = Math.round(performance.now() - started);
      const sec = Math.floor(t / 1000);
      timer.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}${s.shots.length ? ` · ${s.shots.length} 📷` : ""}`;
      if (stopping) return;
      const f = await draw(tab.video, FRAME_WIDTH, "image/jpeg", 0.55);
      if (!f.blob) return;
      size = { width: f.width, height: f.height };
      frames.push({ t, blob: f.blob });
      bytes += f.blob.size;
      if (t >= MAX_RECORDING_MS || bytes >= MAX_RECORDING_BYTES || frames.length >= 1900) stop();
    }, FRAME_MS);
  }

  async function send() {
    s.busy = true;
    s.error = null;
    render();
    try {
      s.sent = await report(s.note, {
        screenshots: s.shots.map((x) => x.blob),
        recording: s.recording && s.recording.blob,
        contact: s.contact,
        extra: o.extra,
        // A progress bar only when there's something big to upload.
        onProgress: s.shots.length || s.recording ? (sent, total) => {
          const bar = root.querySelector(".progress div");
          if (bar) bar.style.width = `${Math.round((sent / Math.max(1, total)) * 100)}%`;
        } : undefined,
      });
    } catch (e) {
      s.error = (e && e.message) || "Couldn't send it. Check your connection and try again.";
    } finally {
      s.busy = false;
      render();
    }
  }

  function render() {
    const focused = root.activeElement && root.activeElement.name;
    sheet.replaceChildren();
    if (s.sent != null) {
      sheet.append(
        el("div", { class: "done" },
          el("div", { class: "tick", "aria-hidden": "true", text: "✓" }),
          el("h2", { text: "Thanks, it's sent" }),
          el("p", { text: s.contact ? `The team has it, with what happened just before. They may write to ${s.contact}.` : "The team has it, with what happened just before." })),
        el("div", { class: "row" }, el("button", { type: "button", class: "primary", on: { click: () => close(s.sent) } }, "Done")),
      );
      return;
    }
    const note = el("textarea", { name: "note", placeholder: "e.g. The pay button does nothing after I enter my card", maxlength: "5000", disabled: s.busy,
      on: { input: (e) => { s.note = e.target.value; sendBtn.disabled = s.busy || !s.note.trim(); } } });
    note.value = s.note;
    const contact = el("input", { name: "contact", type: "email", placeholder: "you@example.com", autocomplete: "email", disabled: s.busy,
      on: { input: (e) => { s.contact = e.target.value; } } });
    contact.value = s.contact;
    const sendBtn = el("button", { type: "button", class: "primary", disabled: s.busy || !s.note.trim(), on: { click: send } }, s.busy ? "Sending…" : "Send");
    sheet.append(
      el("h2", { text: o.title }),
      el("p", { text: o.intro }),
      el("label", {}, "What went wrong?", note),
      o.askContact ? el("label", {}, "Your email (optional, so we can reply)", contact) : null,
      s.shots.length ? el("div", { class: "shots" }, s.shots.map((x, i) =>
        el("div", { class: "shot" }, el("img", { src: x.url, alt: `Screenshot ${i + 1}` }),
          el("button", { type: "button", "aria-label": `Remove screenshot ${i + 1}`, disabled: s.busy, on: { click: () => { URL.revokeObjectURL(x.url); s.shots.splice(i, 1); render(); } } }, "✕")))) : null,
      s.recording ? el("div", { class: "rec" }, "🎬", el("span", { text: `Screen recording · ${s.recording.seconds} s` }),
        el("button", { type: "button", class: "ghost", disabled: s.busy, on: { click: () => { s.recording = null; render(); } } }, "Remove")) : null,
      capture || record ? el("div", { class: "row" },
        capture && s.shots.length < MAX_SHOTS ? el("button", { type: "button", class: "soft", disabled: s.busy, on: { click: screenshot } }, "📷 Screenshot") : null,
        record && !s.recording ? el("button", { type: "button", class: "soft", disabled: s.busy, on: { click: startRecording } }, "🎬 Record the screen") : null) : null,
      capture || record ? el("p", { class: "note", text: "What you type in the app is blurred in screenshots and recordings." }) : null,
      s.busy && (s.shots.length || s.recording) ? el("div", { class: "progress" }, el("div")) : null,
      s.error ? el("div", { class: "err", role: "alert", text: s.error }) : null,
      el("div", { class: "row" }, el("button", { type: "button", class: "ghost", disabled: s.busy, on: { click: () => close(null) } }, "Cancel"), sendBtn),
    );
    const again = focused === "contact" ? contact : note;
    if (!s.busy) again.focus();
  }

  render();
  return promise;
}

/** A floating "Report a problem" button in a corner; returns a function that removes it. */
export function mountReportButton({ label = "Report a problem", position = "bottom-right", brand = "#0b7350", ...sheet } = {}) {
  if (typeof document === "undefined") return () => {};
  const host = el("div", { "data-loggerai-ignore": true });
  const root = host.attachShadow({ mode: "open" });
  const [v, h] = position.split("-");
  root.append(
    el("style", { text: `button{position:fixed;${v}:16px;${h}:16px;z-index:2147483645;padding:10px 14px;border:0;border-radius:999px;background:${brand};color:#fff;font:600 13px system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.2);cursor:pointer}` }),
    el("button", { type: "button", on: { click: () => showReportSheet({ brand, ...sheet }) } }, label),
  );
  document.body.appendChild(host);
  return () => host.remove();
}

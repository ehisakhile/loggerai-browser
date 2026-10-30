// Session replay: the page as the person saw it, recorded with rrweb and sent in chunks while the
// visit goes on, so it can be watched on the Sessions page live or afterwards. Loaded only when
// init({ replay: true }) asks for it, so apps that don't use it never download rrweb.
//
// Privacy by default: everything typed is masked (shown as ***), and so is the text of anything
// marked data-loggerai-mask; elements marked data-loggerai-block are left out entirely (a grey box).
// replay: { maskAllText: true } masks all text on the page too.

import { record } from "@rrweb/record";

const CHUNK_MS = 5_000; // send at least this often while something happens (how far behind "live" is)
const CHUNK_BYTES = 400_000;
const BEACON_BYTES = 60_000;
const MAX_CHUNKS = 3000; // the server's cap per session

function get(k) {
  try {
    return sessionStorage.getItem(k);
  } catch {
    return null;
  }
}
function set(k, v) {
  try {
    sessionStorage.setItem(k, v);
  } catch {}
}

/**
 * Starts recording the page for `sessionId`, sending to `endpoint` (the ingest batch URL) with `key`.
 * Returns a function that stops it and sends what's left. options: { sampleRate, maskAllText, block, mask }.
 */
export function startReplay({ sessionId, endpoint, key, send = fetch }, options = {}) {
  if (typeof window === "undefined") return () => {};
  // In or out is decided once per session, so a session is either replayed whole or not at all.
  const pick = "loggerai_replay_in";
  let chosen = get(pick);
  if (chosen === null) {
    const rate = typeof options.sampleRate === "number" ? options.sampleRate : 1;
    chosen = Math.random() < rate ? "1" : "0";
    set(pick, chosen);
  }
  if (chosen !== "1") return () => {};

  const url = endpoint.replace(/\/batch\/?(\?.*)?$/, "/replay") + "?key=" + encodeURIComponent(key);
  const seqKey = "loggerai_replay_seq";
  let seq = Number(get(seqKey)) || 0;
  let buf = [];
  let size = 0;
  let timer = null;

  const ship = (final) => {
    if (!buf.length || seq >= MAX_CHUNKS) return;
    const body = JSON.stringify({ session_id: sessionId, seq, events: buf });
    buf = [];
    size = 0;
    seq += 1;
    set(seqKey, String(seq));
    // text/plain: no CORS preflight. A beacon outlives the page, but only for small bodies.
    if (final && navigator.sendBeacon && body.length < BEACON_BYTES && navigator.sendBeacon(url, new Blob([body], { type: "text/plain" }))) return;
    try {
      send.call(window, url, { method: "POST", body, headers: { "Content-Type": "text/plain" }, keepalive: final && body.length < BEACON_BYTES }).catch(() => {});
    } catch {}
  };

  const mask = ["[data-loggerai-mask]", ...(options.mask || [])].join(",");
  const stopRecording = record({
    emit(event) {
      buf.push(event);
      size += 200; // a rough guess; a full snapshot is measured below
      if (event.type === 2) size += JSON.stringify(event).length;
      if (size > CHUNK_BYTES) ship(false);
    },
    maskAllInputs: true,
    maskInputOptions: { password: true },
    maskTextSelector: options.maskAllText ? "*" : mask,
    blockSelector: ["[data-loggerai-block]", ...(options.block || [])].join(","),
    ignoreClass: "loggerai-ignore",
    inlineStylesheet: true,
    recordCanvas: false,
    collectFonts: false,
    sampling: { mousemove: 50, scroll: 150, input: "last", media: 800 },
    slimDOMOptions: { script: true, comment: true, headFavicon: true, headWhitespace: true, headMetaSocial: true, headMetaRobots: true },
  });
  timer = setInterval(() => ship(false), CHUNK_MS);
  const onHide = () => ship(true);
  const onVisibility = () => document.visibilityState === "hidden" && ship(true);
  window.addEventListener("pagehide", onHide);
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    clearInterval(timer);
    window.removeEventListener("pagehide", onHide);
    document.removeEventListener("visibilitychange", onVisibility);
    if (stopRecording) stopRecording();
    ship(true);
  };
}

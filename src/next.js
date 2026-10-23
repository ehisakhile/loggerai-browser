"use client";
// Next.js (App Router or Pages Router): <LoggerAI publicKey=… /> in the root layout starts it.
// Route changes are seen through history, so nothing else is needed for them.

import { useEffect } from "react";
import { init, setUser } from "./index.js";

export function LoggerAI({ user, ...options }) {
  useEffect(() => {
    init({
      publicKey: process.env.NEXT_PUBLIC_LOGGERAI_KEY,
      release: process.env.NEXT_PUBLIC_LOGGERAI_RELEASE || process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA || undefined,
      environment: process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.NODE_ENV,
      ...options,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    setUser(user ?? null);
  }, [user]);
  return null;
}

export { ErrorBoundary, LoggerAIProvider, useLoggerAI } from "./react.js";
export { captureException, report, track, setUser, sessionId } from "./index.js";

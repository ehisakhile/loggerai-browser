"use client";
// React: a provider that starts LoggerAI, and an error boundary that sends what broke a part of the page.

import { Component, createElement, Fragment, useEffect } from "react";
import { captureException, init, report, sessionId, setUser, showReportSheet, track } from "./index.js";

/** Starts LoggerAI once the app is in the browser. Put it near the top of your app. */
export function LoggerAIProvider({ children, user, ...options }) {
  useEffect(() => {
    init(options);
    // Options are read once; React's second effect run in development is ignored by init().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    setUser(user ?? null);
  }, [user]);
  return createElement(Fragment, null, children);
}

/** What a component needs to report problems and mark steps. */
export function useLoggerAI() {
  return { report, showReportSheet, track, captureException, setUser, sessionId };
}

/**
 * Catches errors while rendering the components inside it, sends them to LoggerAI, and shows
 * `fallback` (an element, or a function of { error, reset }) instead.
 */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.reset = () => this.setState({ error: null });
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    captureException(error, { component_stack: String(info && info.componentStack || "").slice(0, 2000), boundary: this.props.name || null });
    if (this.props.onError) this.props.onError(error, info);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { fallback } = this.props;
    if (typeof fallback === "function") return fallback({ error, reset: this.reset });
    return fallback === undefined ? null : fallback;
  }
}

/** A button that opens "Report a problem". Style it with className, or pass children for your own label. */
export function ReportButton({ children = "Report a problem", sheet, ...props }) {
  return createElement("button", { type: "button", ...props, onClick: () => showReportSheet(sheet) }, children);
}

export { captureException, report, showReportSheet, track, setUser, sessionId };

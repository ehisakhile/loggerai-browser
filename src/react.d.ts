import type { Component, ErrorInfo, ReactNode } from "react";
import type { Options, captureException, report, sessionId, setUser, track } from "./index.js";

export interface LoggerAIProviderProps extends Options {
  children?: ReactNode;
}

/** Starts LoggerAI once the app is in the browser. */
export declare function LoggerAIProvider(props: LoggerAIProviderProps): ReactNode;

export declare function useLoggerAI(): {
  report: typeof report;
  track: typeof track;
  captureException: typeof captureException;
  setUser: typeof setUser;
  sessionId: typeof sessionId;
};

export interface ErrorBoundaryProps {
  children?: ReactNode;
  /** Shown instead of what broke: an element, or a function of { error, reset }. */
  fallback?: ReactNode | ((props: { error: Error; reset: () => void }) => ReactNode);
  /** A name for this part of the page, kept with the error. */
  name?: string;
  onError?: (error: Error, info: ErrorInfo) => void;
}

export declare class ErrorBoundary extends Component<ErrorBoundaryProps, { error: Error | null }> {}

export { captureException, report, track, setUser, sessionId } from "./index.js";

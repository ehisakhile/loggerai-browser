import type { ReactNode } from "react";
import type { Options } from "./index.js";

export interface LoggerAIProps extends Partial<Options> {}

/**
 * Put it in the root layout. Reads NEXT_PUBLIC_LOGGERAI_KEY (and NEXT_PUBLIC_LOGGERAI_RELEASE, or Vercel's
 * commit) when publicKey isn't given.
 */
export declare function LoggerAI(props: LoggerAIProps): ReactNode;

export { ErrorBoundary, LoggerAIProvider, useLoggerAI } from "./react.js";
export { captureException, report, track, setUser, sessionId } from "./index.js";

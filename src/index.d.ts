export declare const VERSION: string;
export declare const DEFAULT_ENDPOINT: string;

export interface LoggerAIEvent {
  session_id: string;
  ts: number;
  type: string;
  payload: Record<string, unknown>;
}

export interface Options {
  /** The project's public key (pk_…), from its Connect page. Never the secret key. */
  publicKey: string;
  /** Your app's version, e.g. a git commit: errors show the release they started in. */
  release?: string;
  environment?: string;
  /** A name for this app in the project, e.g. "web" or "admin". */
  service?: string;
  /** The signed-in user's id, so their sessions and reports can be found. */
  user?: string | number | null;
  /** Other hosts (your API, e.g. "api.example.com") whose requests carry the trace headers. Same-origin requests always do. */
  traceHosts?: string[];
  /** Record console.error and console.warn in the session. Default true. */
  captureConsole?: boolean;
  /** Change or drop (return null) an event before it's sent. */
  beforeSend?: (event: LoggerAIEvent) => LoggerAIEvent | null;
  /** Milliseconds between sends. Default 5000. */
  flushInterval?: number;
  /** False turns it off, e.g. in development. */
  enabled?: boolean;
  endpoint?: string;
  reportEndpoint?: string;
}

export interface ReportOptions {
  screenshot?: Blob;
  screenshots?: Blob[];
  /** An email address to reply to. */
  contact?: string;
  extra?: Record<string, unknown>;
}

/** Starts recording; does nothing on the server, or when already started. Returns whether it's recording. */
export declare function init(options: Options): boolean;
export declare function close(): void;
export declare function isStarted(): boolean;
export declare function sessionId(): string | null;
export declare function setUser(id: string | number | null): void;
export declare function track(name: string, data?: Record<string, unknown>): void;
export declare function captureException(error: unknown, context?: Record<string, unknown>): void;
/** Sends a problem someone reported; resolves to the issue's id. */
export declare function report(note: string, options?: ReportOptions): Promise<number>;
export declare function flush(final?: boolean): void;

export declare function sensitive(key: string): boolean;
export declare function scrub(s: string): string;
export declare function cleanUrl(u: string): string;
export declare function redact<T>(v: T): T;
export declare function routeOf(path: string): string;
export declare function frames(stack: string, origin?: string): { file: string; line: number; column: number; function: string | null; in_app: boolean }[];

declare const LoggerAI: {
  init: typeof init;
  close: typeof close;
  flush: typeof flush;
  setUser: typeof setUser;
  track: typeof track;
  captureException: typeof captureException;
  report: typeof report;
  sessionId: typeof sessionId;
  isStarted: typeof isStarted;
};
export default LoggerAI;

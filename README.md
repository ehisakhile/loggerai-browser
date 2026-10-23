# @loggerai/browser

LoggerAI for web apps: React, Next.js, Vite, or any site. It records each visit as a session (pages, clicks, requests, errors), sends errors to the Errors page grouped by cause, lets people report a problem, and links every request to what your servers did with it.

It never records what people type. Passwords, tokens, card numbers and locations (`lat`, `lng`…) are masked in URLs and data before anything leaves the browser.

```bash
npm install @loggerai/browser
```

Use the project's **public key** (`pk_…`, on its Connect page). Never put the secret key (`sk_…`) in a browser app.

## Next.js

Add the key to `.env.local`:

```bash
NEXT_PUBLIC_LOGGERAI_KEY=pk_live_…
```

Then add `<LoggerAI />` to the root layout. It works in Server Component layouts (App Router) and in `_app.tsx` (Pages Router):

```tsx
// app/layout.tsx
import { LoggerAI } from "@loggerai/browser/next"

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <LoggerAI traceHosts={["api.example.com"]} />
        {children}
      </body>
    </html>
  )
}
```

Route changes are recorded automatically. The release comes from `NEXT_PUBLIC_LOGGERAI_RELEASE`, or Vercel's commit when deployed there.

To send errors that break a page, use them in `app/error.tsx` and `app/global-error.tsx`:

```tsx
"use client"
import { useEffect } from "react"
import { captureException } from "@loggerai/browser/next"

export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => captureException(error), [error])
  return <button onClick={reset}>Try again</button>
}
```

For your API routes and server code, add [`@loggerai/node`](https://www.npmjs.com/package/@loggerai/node) too: the browser's requests carry trace headers, so a session shows what the server did for each one.

## React (Vite, Create React App, Remix…)

```tsx
import { LoggerAIProvider, ErrorBoundary } from "@loggerai/browser/react"

export function App() {
  return (
    <LoggerAIProvider publicKey="pk_live_…" release={import.meta.env.VITE_COMMIT} user={currentUser?.id}>
      <ErrorBoundary fallback={({ reset }) => <button onClick={reset}>Something went wrong. Try again</button>}>
        <Routes />
      </ErrorBoundary>
    </LoggerAIProvider>
  )
}
```

`ErrorBoundary` sends what broke with React's component stack. You can wrap parts of the page with their own boundary and `name`.

## Any site

```js
import { init } from "@loggerai/browser"

init({ publicKey: "pk_live_…", release: "2026.10.1" })
```

## Report a problem

A sheet like the Flutter SDK's: what went wrong, an email to reply to, screenshots and a screen recording, sent with the session it happened in. You get an issue (and a Slack message) on the Issues page.

```tsx
import { ReportButton } from "@loggerai/browser/react"   // or "@loggerai/browser/next"

<ReportButton className="btn">Report a problem</ReportButton>
```

Or open it from anywhere with `showReportSheet()`, or add a floating button with `init({ …, reportButton: true })`.

**What people type stays private.** While a screenshot or recording is taken, every input, text area, select and editable area is blurred, as is anything you mark with `data-loggerai-mask` (or pass `mask: [".balance"]`). Notes are cleaned of tokens before they're sent. Recordings are two frames a second, at most 90 seconds, in LoggerAI's own format, which the dashboard plays.

Screenshots and recordings use the browser's screen sharing, so people choose to share the tab. Desktop Chrome, Edge, Firefox and Safari support it. Phone browsers don't, and there the sheet sends the note on its own, unless you pass `captureScreenshot` (e.g. with html2canvas).

## Users, steps and reports

```js
import { setUser, track, captureException, report } from "@loggerai/browser"

setUser(user.id)                           // their sessions and reports can be found; setUser(null) on sign-out
track("checkout_started", { items: 3 })    // a step of your own in the session's timeline
captureException(err, { orderId })         // an error you caught

// Your own "Report a problem" form: the note, the session it happened in and, if you have one, a screenshot.
const issueId = await report("The pay button does nothing", { contact: "ada@example.com", screenshot: blob })
```

In React, `useLoggerAI()` gives you the same functions.

## Options

| Option | |
|---|---|
| `publicKey` | The project's public key (required; `NEXT_PUBLIC_LOGGERAI_KEY` in Next.js). |
| `release` | Your app's version or commit. |
| `environment` | Default `production` (Next.js: Vercel's environment, or `NODE_ENV`). |
| `service` | A name for this app in the project. Default `web`. |
| `user` | The signed-in user's id. |
| `traceHosts` | Other hosts (your API) whose requests carry the trace headers. Same-origin requests always do. |
| `captureConsole` | Record `console.error` and `console.warn`. Default `true`. |
| `beforeSend(event)` | Change an event, or return `null` to drop it. |
| `enabled` | `false` turns it off, e.g. in development. |
| `reportButton` | `true` (or `{ label, position }`) adds a floating "Report a problem" button. |

Server-side rendering is safe: nothing runs until the code is in the browser, and calling `init` twice (React's development double effects) does nothing. On a page that already has the Laravel package's script, it leaves recording to that script.

## License

MIT

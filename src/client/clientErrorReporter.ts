type ClientErrorSource = "react" | "window_error" | "unhandled_rejection";

const recentlyReported = new Map<string, number>();
const DEDUPE_WINDOW_MS = 10_000;

function errorParts(error: unknown): { message: string; stack: string } {
  if (error instanceof Error) return { message: error.message, stack: error.stack ?? "" };
  if (typeof error === "string") return { message: error, stack: "" };
  try { return { message: JSON.stringify(error), stack: "" }; }
  catch { return { message: String(error), stack: "" }; }
}

function currentAssetVersion(): string {
  return document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute("src") ?? "unknown";
}

export function reportClientError(error: unknown, source: ClientErrorSource, componentStack = ""): void {
  const { message, stack } = errorParts(error);
  const fingerprint = `${source}|${message}|${stack.slice(0, 300)}`;
  const now = Date.now();
  const previous = recentlyReported.get(fingerprint);
  if (previous && now - previous < DEDUPE_WINDOW_MS) return;
  recentlyReported.set(fingerprint, now);
  for (const [key, timestamp] of recentlyReported) {
    if (now - timestamp > DEDUPE_WINDOW_MS) recentlyReported.delete(key);
  }

  void fetch("/api/client-errors", {
    method: "POST",
    credentials: "same-origin",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source,
      message: message.slice(0, 500),
      stack: stack.slice(0, 4_000),
      componentStack: componentStack.slice(0, 4_000),
      page: window.location.pathname,
      assetVersion: currentAssetVersion(),
    }),
  }).catch(() => { /* Error reporting must never create another visible failure. */ });
}

export function installGlobalErrorReporting(): () => void {
  const onError = (event: ErrorEvent) => reportClientError(event.error ?? event.message, "window_error");
  const onUnhandledRejection = (event: PromiseRejectionEvent) => reportClientError(event.reason, "unhandled_rejection");
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
  };
}


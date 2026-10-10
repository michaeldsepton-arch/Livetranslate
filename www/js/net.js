// fetch() with a timeout, uniform errors, and an automatic fallback to the native HTTP stack
// when the WebView blocks the request (CORS / connectivity quirks).
import { ApiError } from "./engine/errors.js";
import { nativeHttp, isNative } from "./platform.js";

export async function httpRequest(url, { method = "GET", headers = {}, body, timeoutMs = 45000, signal } = {}) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal) signal.aborted ? ctrl.abort() : signal.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  try {
    const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
    const text = await res.text();
    return { status: res.status, ok: res.ok, headers: res.headers, text };
  } catch (e) {
    if (signal && signal.aborted) throw new ApiError("Cancelled", { kind: "aborted" });
    if (timedOut) throw new ApiError("The request timed out", { kind: "network" });
    if (isNative()) {
      try {
        return await nativeHttp(url, { method, headers, body });
      } catch (e2) {
        throw new ApiError("No internet connection", { kind: "network" });
      }
    }
    throw new ApiError("No internet connection (or the server blocked the request)", { kind: "network" });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

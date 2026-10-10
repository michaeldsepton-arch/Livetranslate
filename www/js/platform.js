// Everything that differs between the Android app (Capacitor) and a normal browser lives here,
// so the rest of the code never touches Capacitor directly.

const cap = () => (typeof window !== "undefined" ? window.Capacitor : undefined);
export const isNative = () => !!(cap() && cap().isNativePlatform && cap().isNativePlatform());

const proxies = new Map();
function plugin(name) {
  if (!isNative() || !cap().registerPlugin) return null;
  if (!proxies.has(name)) {
    try {
      proxies.set(name, cap().registerPlugin(name));
    } catch {
      proxies.set(name, null);
    }
  }
  return proxies.get(name);
}

// ---- base64 -----------------------------------------------------------------------------
export function bytesToBase64(bytes) {
  let bin = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  return btoa(bin);
}

export async function blobToBase64(blob) {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

// ---- HTTP fallback through the native layer (used only if the WebView's fetch is blocked) ---------
export async function nativeHttp(url, { method = "GET", headers = {}, body } = {}) {
  const native = plugin("LiveTranslateNative");
  if (!native) throw new Error("native http unavailable");
  const hdrs = { ...headers };
  let bodyBase64 = "";
  if (body != null) {
    if (typeof body === "string") bodyBase64 = bytesToBase64(new TextEncoder().encode(body));
    else {
      const r = new Response(body); // serialises FormData/Blob/ArrayBuffer (adds multipart boundary)
      const ct = r.headers.get("content-type");
      if (ct && !Object.keys(hdrs).some((k) => k.toLowerCase() === "content-type")) hdrs["Content-Type"] = ct;
      bodyBase64 = bytesToBase64(new Uint8Array(await r.arrayBuffer()));
    }
  }
  const res = await native.http({ url, method, headers: hdrs, bodyBase64, timeoutMs: 60000 });
  const map = res.headers || {};
  return {
    status: res.status,
    ok: res.status >= 200 && res.status < 300,
    headers: { get: (k) => map[String(k).toLowerCase()] ?? null },
    text: res.bodyText || "",
  };
}

// ---- Files ---------------------------------------------------------------------------------------
function browserDownload(filename, text, mime) {
  const blob = new Blob([text], { type: mime + ";charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 2000);
}

/** Save to the phone's Downloads/Lisan folder.  Resolves {where, path}. */
export async function saveTextFile(filename, text, mime = "text/plain") {
  const native = plugin("LiveTranslateNative");
  if (native) {
    try {
      const r = await native.saveTextFile({ filename, text, mimeType: mime });
      return { where: "downloads", path: r.path || `Downloads/Lisan/${filename}` };
    } catch (e) {
      console.warn("native save failed, falling back to share sheet", e);
      await shareTextFile(filename, text, mime);
      return { where: "share" };
    }
  }
  browserDownload(filename, text, mime);
  return { where: "browser", path: filename };
}

/** Open the system share sheet with the transcript as a file attachment. */
export async function shareTextFile(filename, text, mime = "text/plain", title = "Lecture transcript") {
  const fs = plugin("Filesystem");
  const share = plugin("Share");
  if (fs && share) {
    const w = await fs.writeFile({ path: filename, data: text, directory: "CACHE", encoding: "utf8" });
    await share.share({ title, files: [w.uri], dialogTitle: title });
    return;
  }
  try {
    const file = new File([text], filename, { type: mime });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title });
      return;
    }
  } catch (e) {
    if (e && e.name === "AbortError") return;
  }
  browserDownload(filename, text, mime);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {}
    ta.remove();
    return ok;
  }
}

// ---- Screen / system -----------------------------------------------------------------------------
let wakeLock = null;
export async function keepAwake(on) {
  const native = plugin("LiveTranslateNative");
  if (native) {
    try {
      await native.keepAwake({ enabled: !!on });
    } catch {}
    return;
  }
  try {
    if (on && navigator.wakeLock) wakeLock = await navigator.wakeLock.request("screen");
    else if (wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {}
}

export function setStatusBar(light) {
  const sb = plugin("StatusBar");
  if (sb) sb.setStyle({ style: light ? "LIGHT" : "DARK" }).catch(() => {});
}

export function onAppResume(cb) {
  const app = plugin("App");
  if (app) app.addListener("appStateChange", (s) => cb(s.isActive));
  document.addEventListener("visibilitychange", () => cb(!document.hidden));
}

export function onBackButton(cb) {
  const app = plugin("App");
  if (app) app.addListener("backButton", cb);
}

export function exitApp() {
  const app = plugin("App");
  if (app) app.exitApp();
}

export function openExternal(url) {
  window.open(url, "_blank", "noopener");
}

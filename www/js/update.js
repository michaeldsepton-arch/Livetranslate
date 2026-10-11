// "Check for updates": ask GitHub which build is the newest and, if it is newer than this one, hand the phone's
// browser the APK link (the download is then installed over the old app; keys and lectures are kept).
import { httpRequest } from "./net.js";
import { ApiError } from "./engine/errors.js";
import { BUILD_NUMBER } from "./build-info.js";

export const UPDATE_REPO = "michaeldsepton-arch/Livetranslate";
export const RELEASE_PAGE = `https://github.com/${UPDATE_REPO}/releases/tag/latest-build`;
const API = `https://api.github.com/repos/${UPDATE_REPO}/releases/tags/latest-build`;

/** The release text says "... run #14." — that number grows with every build. */
export function parseBuildNumber(body) {
  const m = /run #(\d+)/.exec(body || "");
  return m ? Number(m[1]) : 0;
}

/**
 * @returns {Promise<{status:"available"|"current"|"dev"|"private"|"offline"|"error", current:number, latest:number, url:string, page:string, message:string}>}
 */
export async function checkForUpdate({ http = httpRequest, current = BUILD_NUMBER, signal } = {}) {
  const out = (status, message, extra = {}) => ({ status, message, current, latest: 0, url: "", page: RELEASE_PAGE, ...extra });
  if (!current) return out("dev", "This copy is running from source, so there is nothing to compare it with.");
  let res;
  try {
    res = await http(API, { headers: { Accept: "application/vnd.github+json" }, timeoutMs: 15000, signal });
  } catch (e) {
    const ae = ApiError.from(e);
    if (ae.kind === "aborted") throw ae;
    return out("offline", "No internet connection.");
  }
  if (res.status === 403 && res.headers && res.headers.get && res.headers.get("x-ratelimit-remaining") === "0") return out("error", "GitHub is busy. Try again in a few minutes.");
  if (res.status === 404 || res.status === 401 || res.status === 403)
    return out("private", "Couldn't check: the downloads page isn't public. Ask the owner to make the repository public, or open the downloads page yourself.");
  if (!res.ok) return out("error", `GitHub answered with an error (${res.status}).`);
  let release;
  try {
    release = JSON.parse(res.text);
  } catch {
    return out("error", "Couldn't read GitHub's answer.");
  }
  const latest = parseBuildNumber(release.body);
  const apk = (release.assets || []).find((a) => /\.apk$/i.test(a.name || ""));
  if (!latest || !apk) return out("error", "Couldn't find the latest build.");
  if (latest > current) return out("available", `A newer version is available: build ${latest} (you have build ${current}).`, { latest, url: apk.browser_download_url });
  return out("current", `You have the latest version (build ${current}).`, { latest });
}

const KEY = "lt.update.last";
const EVERY_MS = 6 * 3600 * 1000;

/** Quiet check when the app opens: at most every 6 hours, and never while a lecture is being recorded. */
export async function autoCheck({ isBusy = () => false, storage = globalThis.localStorage, now = Date.now, check = checkForUpdate } = {}) {
  try {
    const last = Number((storage && storage.getItem(KEY)) || 0);
    if (now() - last < EVERY_MS || isBusy()) return null;
    const result = await check();
    if (result.status !== "offline" && result.status !== "dev") storage && storage.setItem(KEY, String(now()));
    return isBusy() ? null : result;
  } catch {
    return null;
  }
}

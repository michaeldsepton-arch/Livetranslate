// A gentle heads-up while recording on a low battery: at about 15% Android's Battery Saver usually switches on, and it can slow the
// microphone processing or stop Lisan listening with the screen off.  Uses the Battery Status API where the WebView has it; silent otherwise.

/**
 * @param {{ onLow:(level:number, severity:"low"|"critical")=>void, getBattery?:()=>Promise<object>|undefined, every?:number, setTimer?:Function, clearTimer?:Function }} o
 * @returns {() => void} stop
 */
export function watchBattery({ onLow, getBattery = () => (typeof navigator !== "undefined" && navigator.getBattery ? navigator.getBattery() : undefined), every = 60000, setTimer = setInterval, clearTimer = clearInterval }) {
  let stopped = false;
  let warnedLow = false;
  let warnedCritical = false;
  let manager = null;
  const check = async () => {
    try {
      if (!manager) manager = await getBattery();
      if (stopped || !manager || manager.charging) return;
      const pct = Math.round(manager.level * 100);
      if (pct <= 10 && !warnedCritical) {
        warnedCritical = warnedLow = true;
        onLow(pct, "critical");
      } else if (pct <= 20 && !warnedLow) {
        warnedLow = true;
        onLow(pct, "low");
      }
    } catch {
      /* no battery information: nothing to say */
    }
  };
  check();
  const timer = setTimer(check, every);
  return () => {
    stopped = true;
    clearTimer(timer);
  };
}

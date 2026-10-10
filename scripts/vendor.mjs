// Copies Capacitor's tiny runtime into www/vendor so the app can run without a bundler.
import { copyFileSync, mkdirSync } from "node:fs";
mkdirSync("www/vendor", { recursive: true });
copyFileSync("node_modules/@capacitor/core/dist/capacitor.js", "www/vendor/capacitor.js");
console.log("copied capacitor.js runtime");

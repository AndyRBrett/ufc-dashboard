// One way to start the test browser, shared by every browser gate.
//
// A preinstalled Chromium (PLAYWRIGHT_BROWSERS_PATH/chromium, as cloud and CI
// images provide) is used when present, so a Playwright upgrade whose pinned
// browser revision isn't downloaded can't fail a gate that has nothing to do
// with it. check-ai-history once launched without this and was the only gate
// that broke on such an image.
//
// Takes the `chromium` the caller resolved: several gates fall back to
// playwright-core, or skip, when playwright isn't installed, and a static
// import here would turn that into a crash.
import { existsSync } from "node:fs";
import { join } from "node:path";

export function chromiumExecutable() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const exe = root ? join(root, "chromium") : undefined;
  return exe && existsSync(exe) ? exe : undefined;
}

export function launchChromium(chromium, opts = {}) {
  const exe = chromiumExecutable();
  return chromium.launch(exe ? { ...opts, executablePath: exe } : opts);
}

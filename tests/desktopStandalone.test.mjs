import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const repoRoot = new URL("../", import.meta.url);

function readRepoFile(path) {
  return readFileSync(new URL(path, repoRoot), "utf8");
}

test("desktop email sign-in does not expose an unconditional QR handoff", () => {
  const source = readRepoFile("js/ui/screens/account/authSignInScreen.js");

  assert.match(source, /import \{ Platform \}/);
  assert.match(source, /shouldShowQrLogin\(\)/);
  assert.match(source, /return !Platform\.isDesktop\(\);/);
  assert.match(source, /openQrLogin\(\)/);
  assert.match(source, /if \(!this\.shouldShowQrLogin\(\)\) \{\s*return;\s*\}\s*Router\.navigate\("authQrSignIn"\);/);
  assert.match(source, /const showQrLogin = this\.shouldShowQrLogin\(\);/);
  assert.doesNotMatch(source, /querySelector\("#email-qr-btn"\)\?\.addEventListener\("click", \(\) => Router\.navigate\("authQrSignIn"\)\)/);
  assert.match(source, /else if \(action === "qrLogin"\) \{\s*this\.openQrLogin\(\);/);
});

test("addon remote page uses device-neutral copy", () => {
  const source = readRepoFile("js/bootstrap/renderAddonRemotePage.js");

  assert.doesNotMatch(source, /from your phone/i);
  assert.doesNotMatch(source, /on this phone/i);
});

// Preloaded before every test file (bunfig.toml). The fast lane's per-user
// minute cap lives in memory and every file signs in as the same test user,
// so each test starts with a fresh minute.
import { beforeEach } from "bun:test";
import { resetFastLimits } from "../src/fastlane.js";

beforeEach(() => {
  resetFastLimits();
});

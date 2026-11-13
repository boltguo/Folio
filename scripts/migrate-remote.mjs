import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Wrangler returns success when an interactive migration prompt is declined.
// Apply without prompting so a skipped migration cannot allow deployment.
const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(
      new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
    ),
    "d1",
    "migrations",
    "apply",
    "DB",
    "--remote",
    ...process.argv.slice(2),
  ],
  {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, CI: "true" },
  },
);

if (result.error) console.error(result.error.message);
if (result.signal)
  console.error(`Database migration interrupted by ${result.signal}`);
process.exit(result.status ?? 1);

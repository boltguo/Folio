import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";

const target = new URL("../.dev.vars", import.meta.url);
const content = [
  "# Local development only. Do not commit this file.",
  `SESSION_SECRET=${randomBytes(32).toString("hex")}`,
  "ADMIN_EMAIL=admin@example.com",
  `ADMIN_PASSWORD=${randomBytes(18).toString("base64url")}`,
  "RESEND_API_KEY=",
  "RESEND_WEBHOOK_SECRET=",
  "",
].join("\n");
try {
  await writeFile(target, content, { flag: "wx", mode: 0o600 });
  console.log(
    "Created .dev.vars with random local credentials. Read ADMIN_EMAIL and ADMIN_PASSWORD there to log in.",
  );
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.log("Keeping existing .dev.vars unchanged.");
}

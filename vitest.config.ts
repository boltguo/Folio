import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

export default defineConfig(async () => ({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            config: false,
            main: "./src/server/index.ts",
            miniflare: {
              compatibilityDate: "2026-11-01",
              compatibilityFlags: ["nodejs_compat"],
              d1Databases: ["DB"],
              r2Buckets: ["MAIL_STORAGE"],
              bindings: {
                SESSION_SECRET:
                  "test-only-session-secret-not-for-production-123456789",
                ADMIN_EMAIL: "admin@example.com",
                ADMIN_PASSWORD: "test-only-password-123456",
                RESEND_API_KEY: "test-only-resend-key",
                RESEND_WEBHOOK_SECRET: "test-only-webhook-secret",
                TEST_MIGRATIONS: await readD1Migrations("./migrations"),
              },
            },
          }),
        ],
        test: {
          name: "worker",
          include: ["tests/worker.test.ts"],
          setupFiles: ["tests/setup.ts"],
          testTimeout: 15000,
        },
      },
      {
        test: {
          name: "client",
          include: ["tests/client.test.ts", "tests/i18n.test.ts"],
          environment: "node",
        },
      },
    ],
  },
}));

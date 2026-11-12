export interface Env {
  DB: D1Database;
  MAIL_STORAGE: R2Bucket;
  ASSETS: Fetcher;
  SESSION_SECRET: string;
  RESEND_API_KEY: string;
  RESEND_WEBHOOK_SECRET?: string;
  APP_ORIGIN?: string;
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD?: string;
  MAX_EMAIL_BYTES?: string;
}
export type Variables = { adminId: string };

# Folio

**English** | [简体中文](./README.zh-CN.md)

Folio is a private, single-admin webmail app for sending, receiving and managing email across multiple domains in one browser interface.

- Includes English and Simplified Chinese, inbox, sent mail, stars, archive, search, attachments, trash restoration and automatic forwarding.
- Built with Vue 3, TypeScript, Hono and Cloudflare Workers. D1 stores message metadata; private R2 stores raw emails, bodies and attachments.
- **Receiving:** external mailbox → Cloudflare Email Routing → Folio Worker → D1 / R2.
- **Sending:** Folio → Resend → recipient; webhooks report delivery status.

## Deployment

The examples use `hello@example.com` for email and `mail.example.com` for the website. Replace them with your own domains. The website and email domains can differ.

### 1. Prepare accounts and source code

You need Node.js **22.12+**, Git, a Cloudflare account and a Resend account. The email domain must use Cloudflare DNS. Enable Workers, D1 and R2; R2 may require billing activation.

```bash
git clone https://github.com/boltguo/Folio.git
cd Folio
npm ci
npx wrangler login
npx wrangler whoami
```

Confirm the intended Cloudflare account. To select among multiple accounts, run `export CLOUDFLARE_ACCOUNT_ID=YOUR_ACCOUNT_ID`.

[wrangler.jsonc](./wrangler.jsonc) declares the resources below. Wrangler creates or reuses them during deployment; you do not need to create them first or fill in `database_id`. [Automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning)

| Resource          | Default name | Worker binding |
| ----------------- | ------------ | -------------- |
| Worker            | `folio`      | —              |
| D1 database       | `folio-db`   | `DB`           |
| Private R2 bucket | `folio-mail` | `MAIL_STORAGE` |

To change resource names, edit the configuration before deployment. Keep the binding names and avoid reusing another project's resources.

### 2. Configure environment variables

Create `.secrets.production.json` in the project root and replace every example value:

```json
{
  "SESSION_SECRET": "REPLACE_WITH_AT_LEAST_32_RANDOM_CHARACTERS",
  "ADMIN_EMAIL": "you@example.com",
  "ADMIN_PASSWORD": "REPLACE_WITH_A_STRONG_12_TO_256_CHARACTER_PASSWORD"
}
```

Run `openssl rand -hex 32` to generate `SESSION_SECRET`. On macOS / Linux, use `chmod 600 .secrets.production.json` to restrict file access. This file is ignored by Git; do not commit or share it.

| Name                    | Type              | Requirement                                                                                             |
| ----------------------- | ----------------- | ------------------------------------------------------------------------------------------------------- |
| `SESSION_SECRET`        | Secret            | Required; at least 32 random characters. Keep it after the first login                                  |
| `ADMIN_EMAIL`           | Secret            | Initial administrator login email; does not create a receiving mailbox                                  |
| `ADMIN_PASSWORD`        | Secret            | Initial administrator password, 12–256 characters                                                       |
| `RESEND_API_KEY`        | Secret            | Required for sending; added in step 6                                                                   |
| `RESEND_WEBHOOK_SECRET` | Secret            | Required for delivery-status callbacks; added in step 6                                                 |
| `MAX_EMAIL_BYTES`       | Variable          | Already set to `26214400`: a 25 MiB limit for raw incoming email                                        |
| `APP_ORIGIN`            | Optional variable | Defaults to the request origin. If set, use `https://mail.example.com` without a path or trailing slash |

Set ordinary variables under `vars` in `wrangler.jsonc` and redeploy after changes. `DB` and `MAIL_STORAGE` are resource bindings, not values to add above. Production does not automatically read local `.dev.vars`.

### 3. Deploy, initialize the database and sign in

```bash
npm run deploy -- --secrets-file .secrets.production.json
npm run db:remote
```

The first command type-checks, builds and deploys the Worker, uploads secrets and provisions or binds resources. The second creates or updates database tables. **Both must succeed before opening the app or connecting inbound routing.**

Open the HTTPS URL printed in the terminal and sign in with `ADMIN_EMAIL` and `ADMIN_PASSWORD`. The first login creates the administrator. Use Folio's Settings to change the password afterward.

To use `mail.example.com`, merge the following `routes` field into `wrangler.jsonc`, then run `npm run deploy` again. Cloudflare configures DNS and a certificate for this website domain; this does not change email MX records. [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)

```json
{
  "routes": [{ "pattern": "mail.example.com", "custom_domain": true }]
}
```

After a successful first login, delete the bootstrap secrets and remove both fields from your local secrets file:

```bash
npx wrangler secret delete ADMIN_EMAIL
npx wrangler secret delete ADMIN_PASSWORD
```

Keep `SESSION_SECRET`; changing it invalidates existing sessions. Changing the deployed `ADMIN_PASSWORD` does not reset an existing administrator's password.

### 4. Add a domain and mailbox in Folio

1. Open **Domains → Add domain** and enter `example.com`.
2. Open **Email addresses → Create mailbox**, select that domain and enter `hello` as the mailbox name to create `hello@example.com`.
3. Keep the mailbox enabled. Enable domain receiving and sending in the next two steps.

Adding a domain or mailbox only saves it in Folio. It does not configure Cloudflare routing or Resend.

### 5. Configure Cloudflare receiving

1. In the Cloudflare dashboard, open **Email Routing** (currently under Compute → Email Service → Email Routing), select and enable `example.com`.
2. Confirm the required DNS records in the setup flow. Cloudflare adds inbound **MX** and email-authentication **TXT** records; you do not need to enter server addresses or priorities manually. If routing is already enabled and DNS is healthy, keep the existing records. [Official setup steps](https://developers.cloudflare.com/email-service/get-started/route-emails/)
3. Under **Routing Rules**, create or edit this rule:

   | Setting     | Value                           |
   | ----------- | ------------------------------- |
   | Address     | `hello@example.com`             |
   | Action      | **Send to a Worker**            |
   | Destination | `folio`, or your renamed Worker |
   | Status      | Enabled                         |

4. In Folio **Domains**, click **Enable receiving** for this domain.

If this address previously forwarded to Gmail or another mailbox, change its rule to send to the Worker. Other address rules can stay. To store mail in Folio and then forward it, verify the destination address in Cloudflare first, then configure **Auto-forward** under Folio's Email addresses.

You can point a catch-all rule to the Worker, but Folio **only accepts existing, enabled mailboxes**. Unknown addresses are rejected, not created automatically. Repeat this setup for each receiving domain.

**Optional: manage routing rules with Wrangler**

After configuring Email Routing / DNS and creating the Folio mailboxes, you can replace item 3 above with this approach. The project's Wrangler version supports it (requires 4.113.0+). Merge `addresses` into the top level of `wrangler.jsonc`, listing the addresses this Worker should handle:

```json
{
  "addresses": ["hello@example.com", "support@example.com"]
}
```

```bash
npm run deploy
```

Deployment creates or reconciles **Send to a Worker** rules for these addresses. You must still click **Enable receiving** in Folio. This configuration does not create Folio mailboxes or replace domain DNS setup.

- To keep an existing catch-all forwarding rule, list individual addresses and omit `*@example.com`.
- Wrangler displays changes and requests confirmation before taking over existing rules or deleting managed rules. Non-interactive deployments fail on these changes; the Worker may already be deployed while routing updates remain incomplete.
- Removing an address from the list removes its managed rule. Setting `addresses: []` removes all rules managed by this Worker. Omitting `addresses` leaves routing unchanged.

This is an optional deployment method; the repository does not configure `addresses` by default. [Wrangler email routing documentation](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/#configure-rules-with-wrangler)

### 6. Configure Resend sending

1. In Resend **Domains → Add Domain**, add `example.com`, matching the domain after `@` in your Folio mailbox.
2. Copy the DKIM and SPF / Return-Path names, types and values from Resend's **Records** page into Cloudflare DNS. Records may use TXT, MX or CNAME; set CNAME records to **DNS only**, with proxying disabled. Wait for **Verified** and confirm **Sending is enabled**. [Official domain verification steps](https://resend.com/docs/add-a-domain)
3. **Keep Resend Receiving disabled**; Cloudflare handles incoming mail. Preserve Cloudflare's root-domain MX records. Any MX required by Resend belongs on its designated Return-Path subdomain, such as `send.example.com`.
4. Create a key under Resend **API Keys** that allows sending from the intended domain. If one Worker serves multiple domains, the key must cover them all. Run this command and paste the key at the prompt:

   ```bash
   npx wrangler secret put RESEND_API_KEY
   ```

5. Under Resend **Webhooks**, add the following endpoint, using your actual public Folio HTTPS address:

   ```text
   https://mail.example.com/api/v1/webhooks/resend
   ```

   Subscribe to `email.sent`, `email.delivered`, `email.bounced` and `email.delivery_delayed`. Save this webhook's signing secret (`whsec_...`) in the Worker:

   ```bash
   npx wrangler secret put RESEND_WEBHOOK_SECRET
   ```

6. In Folio **Domains**, click **Mark sending verified** to enable sending for that domain.

This button is a manual confirmation switch. **It does not query Resend or update DNS.** Verify each sending domain in Resend before enabling it in Folio.

Enter secrets at the prompt, not in ordinary `vars`. `secret put` deploys the secret change immediately; no rebuild is needed. Skip this step if you only need receiving.

### 7. Verify email delivery

1. Send an email with an attachment from an external mailbox to `hello@example.com`. Confirm Folio displays the body and downloads the attachment.
2. Reply from that address in Folio and confirm the external mailbox receives it.
3. Check successful webhook delivery in Resend and the corresponding delivery status in Folio. **Submitted does not mean delivered.**

For missing incoming mail, check Cloudflare DNS / routing, Folio's domain receiving switch, the mailbox's enabled state and incoming mail issues in Settings. For sending failures, check Resend verification, the API key and Folio's sending switch. Settings only checks whether secrets are present, not whether they are valid or the services work.

## Updates

Run in the project directory:

```bash
git pull --ff-only
npm ci
npm test
npm run db:remote
npm run deploy
```

Apply migrations before deploying an upgrade. Existing remote secrets are preserved; there is no need to pass the secrets file again. Existing mail needs no relocation. If a migration fails, fix the error and rerun it rather than deleting the database.

To check the build and packaging without uploading:

```bash
npm run deploy:check
```

## Local development

```bash
npm ci
npm run setup:local
npm run dev
```

Open the URL printed in the terminal. `setup:local` creates `.dev.vars` with an administrator email and random password, then applies local migrations. Existing files are not overwritten. Real sending still needs local Resend configuration. Run `npm run db:local` to update the local database.

## Current limitations

- Single administrator; no multi-user isolation, IMAP / POP3, contacts or built-in spam engine.
- Drafts are not persisted. UI forwarding does not include original attachments. CID inline images are not displayed.
- Failed ingestion can be inspected and replayed in Settings, but there are no automatic queue retries. D1 and R2 do not share a transaction. Deletion does not clean up R2 objects; arrange your own backups.
- If a send outcome is unknown, retry the original email instead of creating a duplicate. The safe retry window is 23 hours; check the delivery outcome in Resend before sending again after that window.

## License

Licensed under the [Apache License 2.0](./LICENSE).

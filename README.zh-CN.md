# Folio

[English](./README.md) | **简体中文**

Folio 是一个单管理员、多域名的私有 Web 邮箱，可在浏览器中统一收发和管理多个邮箱地址的邮件。

- 支持中英文、收件箱、已发送、星标、归档、搜索、附件、回收站恢复和自动转发。
- 使用 Vue 3、TypeScript、Hono 和 Cloudflare Workers；D1 保存邮件元数据，私有 R2 保存原始邮件、正文和附件。
- **收件：** 外部邮箱 → Cloudflare Email Routing → Folio Worker → D1 / R2。
- **发件：** Folio → Resend → 收件人；Webhook 回传投递状态。

## 部署

以下以邮箱 `hello@example.com`、网页地址 `mail.example.com` 为例，请替换为自己的域名。网页域名和邮箱域名可以不同。

### 1. 准备账户和代码

需要 Node.js **22.12+**、Git、Cloudflare 账户和 Resend 账户。邮箱域名需使用 Cloudflare DNS；Cloudflare 需开通 Workers、D1 和 R2，R2 可能要求启用计费。

```bash
git clone https://github.com/boltguo/Folio.git
cd Folio
npm ci
npx wrangler login
npx wrangler whoami
```

确认登录了目标 Cloudflare 账户。多账户时可执行 `export CLOUDFLARE_ACCOUNT_ID=你的账户ID` 指定账户。

[wrangler.jsonc](./wrangler.jsonc) 已配置以下资源，部署时 Wrangler 会自动创建或复用，无需提前手动建库、建桶或填写 `database_id`。[自动创建资源说明](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning)

| 资源       | 默认名称     | Worker 绑定    |
| ---------- | ------------ | -------------- |
| Worker     | `folio`      | —              |
| D1 数据库  | `folio-db`   | `DB`           |
| 私有 R2 桶 | `folio-mail` | `MAIL_STORAGE` |

如需修改资源名，在部署前编辑配置；绑定名保持不变，避免复用其他项目的资源。

### 2. 配置环境变量

在项目根目录创建 `.secrets.production.json`，替换全部示例值：

```json
{
  "SESSION_SECRET": "替换为至少32个随机字符",
  "ADMIN_EMAIL": "you@example.com",
  "ADMIN_PASSWORD": "替换为12至256位的强密码"
}
```

运行 `openssl rand -hex 32` 生成 `SESSION_SECRET`。macOS / Linux 可执行 `chmod 600 .secrets.production.json` 限制文件权限。该文件已被 Git 忽略，不要提交或分享。

| 名称                    | 类型           | 配置要求                                                                      |
| ----------------------- | -------------- | ----------------------------------------------------------------------------- |
| `SESSION_SECRET`        | Secret         | 必填，至少 32 个随机字符；登录后也必须保留                                    |
| `ADMIN_EMAIL`           | Secret         | 首次登录的管理员邮箱，仅作为登录账号，不会自动创建收件邮箱                    |
| `ADMIN_PASSWORD`        | Secret         | 首次登录密码，12–256 位                                                       |
| `RESEND_API_KEY`        | Secret         | 发件必需，在第 6 步添加                                                       |
| `RESEND_WEBHOOK_SECRET` | Secret         | 接收投递状态回调必需，在第 6 步添加                                           |
| `MAX_EMAIL_BYTES`       | 普通变量       | 已配置为 `26214400`，即原始收件上限 25 MiB                                    |
| `APP_ORIGIN`            | 普通变量，可选 | 默认当前请求来源；如填写，使用 `https://mail.example.com`，不带路径或末尾斜线 |

普通变量放在 `wrangler.jsonc` 的 `vars` 中，修改后重新部署。`DB` 和 `MAIL_STORAGE` 是资源绑定，不需要填入上表。生产环境不会自动读取本地 `.dev.vars`。

### 3. 部署、建表并登录

```bash
npm run deploy -- --secrets-file .secrets.production.json
npm run db:remote
```

第一条命令检查类型、构建并部署 Worker，同时上传密钥、创建或绑定资源；第二条命令创建或更新数据库表。**两条命令都成功后，再打开网页或接通收件路由。**

打开终端输出的 HTTPS 地址，用 `ADMIN_EMAIL` 和 `ADMIN_PASSWORD` 登录。首次登录会创建管理员；后续在 Folio「设置」中修改密码。

如需使用 `mail.example.com`，将以下 `routes` 字段合并到 `wrangler.jsonc` 顶层，再执行 `npm run deploy`。Cloudflare 会为这个网页域名配置 DNS 和证书；这不影响邮箱的 MX 记录。[自定义域名说明](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)

```json
{
  "routes": [{ "pattern": "mail.example.com", "custom_domain": true }]
}
```

确认首次登录成功后，删除初始化密钥，并从本地密钥文件中移除这两个字段：

```bash
npx wrangler secret delete ADMIN_EMAIL
npx wrangler secret delete ADMIN_PASSWORD
```

保留 `SESSION_SECRET`，更换它会使现有会话失效。修改云端 `ADMIN_PASSWORD` 不会重置已创建的管理员密码。

### 4. 在 Folio 添加域名和邮箱

1. 打开「域名管理」→「添加域名」，填写 `example.com`。
2. 打开「邮箱地址」→「创建邮箱」，选择该域名，邮箱前缀填写 `hello`，创建 `hello@example.com`。
3. 确认邮箱处于启用状态；收件和发件开关按下面两步分别开启。

添加域名或邮箱只会保存到 Folio，不会自动修改 Cloudflare 路由或 Resend 配置。

### 5. 配置 Cloudflare 收件

1. 在 Cloudflare 控制台进入 **Email Routing**（当前入口为 Compute → Email Service → Email Routing），选择并启用 `example.com`。
2. 按页面提示确认添加所需 DNS 记录。Cloudflare 会添加收件 **MX** 和用于邮件认证的 **TXT** 记录，无需手工填写服务器地址或优先级。若已启用且 DNS 状态正常，保留现有记录即可。[官方配置步骤](https://developers.cloudflare.com/email-service/get-started/route-emails/)
3. 在 **Routing Rules** 中创建或修改规则：

   | 配置项 | 值                                    |
   | ------ | ------------------------------------- |
   | 地址   | `hello@example.com`                   |
   | 动作   | **Send to a Worker**（发送到 Worker） |
   | 目标   | `folio`，或你修改后的 Worker 名称     |
   | 状态   | 启用                                  |

4. 回到 Folio「域名管理」，点击该域名的 **「启用收件」**。

原来把同一地址转发到 Gmail 等邮箱的规则，应改为发送到 Worker。其他地址的规则可以保留。需要在 Folio 存储后再转发时，先在 Cloudflare 验证目标邮箱，再在 Folio「邮箱地址」中设置「自动转发」。

也可以把 catch-all 指向 Worker，但 Folio **只接收已创建且启用的邮箱**；未知地址不会自动建箱，会被拒收。每个收件域名都需配置以上步骤。

**可选：用 Wrangler 自动管理路由规则**

完成域名的 Email Routing / DNS 配置并创建 Folio 邮箱后，可用以下方式替代上面的第 3 项。项目使用的 Wrangler 已支持此功能（要求 4.113.0+）。将 `addresses` 合并到 `wrangler.jsonc` 顶层，填写需要交给当前 Worker 的地址：

```json
{
  "addresses": ["hello@example.com", "support@example.com"]
}
```

```bash
npm run deploy
```

部署会创建或同步这些地址的 **Send to a Worker** 规则；随后仍需在 Folio 点击「启用收件」。此配置不会创建 Folio 邮箱，也不代替域名 DNS 配置。

- 如需保留现有 catch-all 转发，列出具体地址即可，不要加入 `*@example.com`。
- 接管已有规则或删除受管规则时，Wrangler 会显示变更并要求确认；非交互部署遇到这类变更会报错，此时 Worker 可能已部署，但路由尚未完成更新。
- 以后从列表删除地址，会删除其受管规则；`addresses: []` 会移除当前 Worker 管理的全部规则。省略 `addresses` 则不修改路由。

以上是可选部署方式，仓库默认未配置 `addresses`。[Wrangler 邮件路由说明](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/#configure-rules-with-wrangler)

### 6. 配置 Resend 发件

1. 在 Resend **Domains → Add Domain** 添加 `example.com`，与 Folio 邮箱 `@` 后的域名一致。
2. 按 Resend **Records** 页面给出的名称、类型和值，在 Cloudflare DNS 添加 DKIM、SPF / Return-Path 记录。实际可能是 TXT、MX 或 CNAME；CNAME 使用 **DNS only**，关闭代理。等待域名变为 **Verified**，并确认 **Sending 已开启**。[官方域名验证步骤](https://resend.com/docs/add-a-domain)
3. **Resend Receiving 保持关闭**，收件由 Cloudflare 处理。保留根域的 Cloudflare MX；若 Resend 要求 MX，应添加到它指定的 Return-Path 子域（例如 `send.example.com`）。
4. 在 Resend **API Keys** 创建密钥，确保允许目标域名发件；多个域名共用同一个 Worker 时，密钥需覆盖这些域名。执行以下命令，按提示粘贴密钥：

   ```bash
   npx wrangler secret put RESEND_API_KEY
   ```

5. 在 Resend **Webhooks** 添加以下地址，替换为实际可访问的 Folio HTTPS 地址：

   ```text
   https://mail.example.com/api/v1/webhooks/resend
   ```

   订阅 `email.sent`、`email.delivered`、`email.bounced`、`email.delivery_delayed`，将该 Webhook 的签名密钥（`whsec_...`）保存到 Worker：

   ```bash
   npx wrangler secret put RESEND_WEBHOOK_SECRET
   ```

6. 回到 Folio「域名管理」，点击 **「标记发件已验证」**，开启该域名的发件权限。

该按钮只是人工确认开关，**不会向 Resend 查询验证结果，也不会修改 DNS**。每个发件域名都要先在 Resend 验证，再开启此开关。

Secret 通过交互输入，不放进普通 `vars`。`secret put` 会直接部署密钥变更，无需重新构建。只收件时可跳过本步骤。

### 7. 验证收发

1. 从外部邮箱发一封带附件的邮件到 `hello@example.com`，确认 Folio 能显示正文并下载附件。
2. 在 Folio 用该地址回复，确认外部邮箱收到邮件。
3. 在 Resend 检查 Webhook 投递成功，并确认 Folio 显示对应的投递状态；「已提交」不等于「已送达」。

收不到邮件时，依次检查 Cloudflare DNS / 路由、Folio 域名收件开关、邮箱是否启用，以及「设置」中的收件异常。发不出去时，检查 Resend 域名验证、API Key 和 Folio 发件开关。「设置」里的密钥状态仅检查是否已填写，不代表密钥有效或服务可用。

## 后续更新

在项目目录执行：

```bash
git pull --ff-only
npm ci
npm test
npm run db:remote
npm run deploy
```

升级时先迁移数据库，再部署新代码。现有云端 Secret 会保留，不必再次传入密钥文件。已有邮件无需搬迁；迁移失败时修复错误后重跑，不要删库重试。

仅检查构建和打包、不上传云端：

```bash
npm run deploy:check
```

## 本地开发

```bash
npm ci
npm run setup:local
npm run dev
```

打开终端提示的地址。`setup:local` 创建 `.dev.vars` 并应用本地迁移；管理员邮箱和随机密码在该文件中，已有文件不会被覆盖。实际发件仍需在本地配置 Resend。更新本地数据库用 `npm run db:local`。

## 当前限制

- 单管理员；不提供多用户隔离、IMAP / POP3、通讯录或内置反垃圾引擎。
- 草稿不持久保存；界面转发不自动附带原附件；暂不显示 CID 内嵌图片。
- 收件失败可在「设置」中查看并尝试恢复，尚无自动队列重试。D1 与 R2 没有跨服务事务，删除邮件不会清理 R2 对象，需自行安排备份。
- 发件结果未知时，重试原邮件，避免新建副本。安全重试窗口为 23 小时；超过后先在 Resend 确认投递结果。

## License

本项目采用 [Apache License 2.0](./LICENSE) 许可证。

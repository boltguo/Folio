# Folio

[English](./README.md) | **简体中文**

单管理员、多域名的私有 Web 邮箱。使用 Vue 3、TypeScript、Hono 和 Cloudflare Workers，D1 保存邮件元数据，私有 R2 保存原始邮件和附件；通过 Cloudflare Email Routing 收件，通过 Resend 发件。

支持简体中文 / English、收件箱、已发送、星标、归档、回收站恢复、搜索、分页、附件和自动转发。邮件数据需登录才能访问，管理员改密和退出入口位于设置。

## 本地运行

需要 Node.js **22.12+**。

```bash
npm ci
npm run setup:local
npm run dev
```

打开终端提示的地址。`setup:local` 自动创建 `.dev.vars` 并应用本地数据库迁移；管理员邮箱和随机密码分别在该文件的 `ADMIN_EMAIL`、`ADMIN_PASSWORD` 中。已有文件不会被覆盖，实际发送邮件仍需配置 Resend。

## 部署到 Cloudflare Workers

### 1. 准备账户和资源配置

- Cloudflare 账户已开通 Workers、D1、R2；R2 可能要求启用计费。
- 接收邮件的域名使用 Cloudflare DNS。
- 如需发件，准备 Resend 账户及已验证的发件域名。

```bash
npm ci
npx wrangler login
npx wrangler whoami
```

确认账户正确。多账户时可通过 `CLOUDFLARE_ACCOUNT_ID` 指定目标账户。

[wrangler.jsonc](./wrangler.jsonc) 已声明以下资源，部署时 Wrangler 会自动创建或复用并绑定，**无需手动填写 `database_id`**：

| 类型 | 资源名 | Worker 绑定 |
|---|---|---|
| Worker | `folio` | — |
| D1 数据库 | `folio-db` | `DB` |
| 私有 R2 桶 | `folio-mail` | `MAIL_STORAGE` |

可以修改资源名，但不要改绑定名，也不要误用其他项目的同名资源。Wrangler 可能将实际 ID 回填配置，保留即可。

### 2. 配置首次部署密钥

在项目根目录手动创建 `.secrets.production.json`，将下面的示例值全部替换：

```json
{
  "SESSION_SECRET": "替换为至少32个随机字符",
  "ADMIN_EMAIL": "you@example.com",
  "ADMIN_PASSWORD": "替换为12至256位的强密码"
}
```

可用 `openssl rand -hex 32` 生成会话密钥。在 macOS/Linux 上可执行 `chmod 600 .secrets.production.json` 限制文件权限。该文件已被 Git 忽略，**不要提交或分享**。生产环境不会自动使用本地 `.dev.vars`。

如已拿到 Resend 密钥，可在 JSON 中增加 `RESEND_API_KEY` 和 `RESEND_WEBHOOK_SECRET`；也可以部署后再配置。

### 3. 部署并初始化数据库

```bash
npm run deploy -- --secrets-file .secrets.production.json
npm run db:remote
```

第一条命令完成类型检查、构建、资源创建和 Worker 部署，并上传指定 Secret。第二条命令应用数据库迁移。**自动创建 D1 不等于自动建表，两条命令都必须成功后才能使用。** 首次初始化结束前不要接通 Email Routing。

构建产物分别位于 `dist/folio` 和 `dist/client`；Wrangler 使用 Vite 生成的部署配置。`/api/*` 始终交给 Worker，不走页面回退。

### 4. 首次登录

打开 Wrangler 输出的 HTTPS 地址，使用上一步配置的管理员邮箱和密码登录。数据库为空时，首次匹配登录会创建管理员并保存密码哈希。

**确认登录成功后**，删除两个初始化 Secret：

```bash
npx wrangler secret delete ADMIN_EMAIL
npx wrangler secret delete ADMIN_PASSWORD
```

将密码保存在密码管理器中，然后移除本地密钥文件里的初始化字段，或安全保存该文件。后续部署无需再次上传它。`SESSION_SECRET` 仍需保留；更换它会使已有会话失效。

修改 `ADMIN_PASSWORD` 不会重置已创建的管理员，之后请通过设置修改密码。

### 5. 配置收件

1. 在 Cloudflare 为域名启用 **Email Routing**，配置其要求的收件 MX 记录。
2. 创建指定地址或 catch-all 规则，动作选择发送到已部署的 `folio` Worker。
3. 在 Folio 添加域名、创建邮箱地址，然后启用收件。

catch-all 不会自动创建邮箱，未知或禁用的邮箱会被拒收。自动转发目标必须先在 Cloudflare Email Routing 验证。

### 6. 配置发件和 Webhook

1. 在 Resend 添加域名，发布其要求的 DKIM 和 return-path 等 DNS 记录，等待验证通过。
2. **不要用 Resend MX 替换根域的 Cloudflare 收件 MX**；Resend return-path 应使用其指定的专用子域。
3. 若首次部署未上传发件密钥，执行：

   ```bash
   npx wrangler secret put RESEND_API_KEY
   ```

4. 在 Resend 创建 Webhook：

   ```text
   https://你的Worker或自定义域名/api/v1/webhooks/resend
   ```

   订阅 `email.sent`、`email.delivered`、`email.bounced`、`email.delivery_delayed`，将签名密钥保存为：

   ```bash
   npx wrangler secret put RESEND_WEBHOOK_SECRET
   ```

5. 在 Folio 域名管理中点击“标记发件已验证”。此操作是人工确认，不会自动检测 DNS。

Secret 通过 CLI 交互输入，不要作为命令行参数或写入普通 `vars`。修改 Secret 后无需重新构建。上线前收发各测试一封邮件，并检查附件和 Webhook 投递状态；“已提交”不等于“已送达”。

## 环境变量

| 名称 | 类型 | 是否需要 / 用途 |
|---|---|---|
| `SESSION_SECRET` | Secret | 必填，至少 32 个随机字符，用于会话认证 |
| `ADMIN_EMAIL` | Secret | 首次初始化管理员使用，成功登录后删除 |
| `ADMIN_PASSWORD` | Secret | 首次管理员密码，12–256 位，成功登录后删除 |
| `RESEND_API_KEY` | Secret | 需要发件时配置 |
| `RESEND_WEBHOOK_SECRET` | Secret | 需要验证 Resend 投递状态回调时配置 |
| `APP_ORIGIN` | 普通变量，可选 | 精确 HTTPS 来源，如 `https://mail.example.com`，不带路径或末尾斜线；默认当前请求来源 |
| `MAX_EMAIL_BYTES` | 普通变量 | 收件大小上限，默认 `26214400`，即 25 MiB |

普通变量在 [wrangler.jsonc](./wrangler.jsonc) 的 `vars` 中设置，修改后重新部署。`DB`、`MAIL_STORAGE` 是资源绑定，不是需要填写的字符串变量。

使用本地 `wrangler login` 时不需要另设 API Token。若从 CI 部署，部署环境需要 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`；这些是部署凭据，不要放进邮件 Worker。Token 应限定目标账户及 Worker、D1、R2 所需权限。

## 后续更新与检查

已完成首次部署后：

```bash
npm ci
npm test
npm run db:remote
npm run deploy
```

更新会保留云端 Secret，不必再次传入密钥文件。数据库迁移需兼容仍在运行的旧版本；已部署后不要修改已应用的迁移文件，应新增迁移。

仅检查构建和部署配置，不上传、不创建云端资源：

```bash
npm run deploy:check
```

该检查不验证真实账户权限、DNS、密钥有效性或收发件链路。首次部署后若数据库初始化失败，修复后重新运行 `npm run db:remote`，不要删除数据库重试。

## 当前边界

- 单管理员，不提供多用户隔离、IMAP/POP3、通讯录、反垃圾引擎或全文索引。
- 草稿不持久保存；界面转发仅包含正文，不自动带上原附件；CID 内嵌图片暂不显示。
- D1 与 R2 没有跨服务事务。原始邮件先存 R2，收件失败可在设置中查看并尝试恢复；自动队列重试、孤立对象清理和备份恢复工具尚未实现。
- 发件结果未知时，应重试原邮件而不是新建副本。安全重试窗口为 23 小时；超过后先去 Resend 确认投递情况。
- 删除邮件是软删除，不会自动清理 R2。重要邮件上线前应安排 D1/R2 备份、监控与恢复演练。
- 首次使用会跟随浏览器语言，登录页和设置可切换中英文并保存偏好；邮件内容和服务商诊断保持原文。
- 去掉旧占位数据库 ID 可能改变本地 D1 存储标识；原 `.wrangler/state` 不会被删除。有旧本地数据时先备份，再处理迁移。

## License

Private project; add a license before public distribution.

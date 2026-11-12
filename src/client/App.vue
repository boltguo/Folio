<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import LanguageSelect from "./components/LanguageSelect.vue";
import {
  Inbox,
  Send,
  Star,
  Archive,
  Trash2,
  ShieldAlert,
  Globe,
  AtSign,
  Settings,
  Plus,
  Search,
  PenSquare,
  RefreshCw,
  Paperclip,
  ArrowLeft,
  Reply,
  Forward,
  Mail,
  LayoutGrid,
  LogOut,
  LockKeyhole,
  X,
  AlertCircle,
  Filter,
} from "lucide-vue-next";
import { useMailStore } from "./stores/mail";
import { api, ApiError, errorMessage, post, patch, del } from "./lib/api";
import type {
  ComposeAttachment,
  Domain,
  Mailbox,
  MailMessage,
} from "../shared/types";

const store = useMailStore();
const { t, te, locale } = useI18n();
const authenticated = ref(false),
  checking = ref(true),
  loginEmail = ref(""),
  loginPassword = ref(""),
  loginError = ref(""),
  loggingIn = ref(false);
const domains = ref<Domain[]>([]),
  mailboxes = ref<Mailbox[]>([]),
  page = ref("inbox");
const composeOpen = ref(false),
  domainModal = ref(false),
  mailboxModal = ref(false),
  settingsOpen = ref(false),
  toast = ref("");
const domainName = ref(""),
  newMailbox = ref({ domainId: "", localPart: "", displayName: "" });
const emptyCompose = () => ({
  mailboxId: "",
  to: "",
  cc: "",
  bcc: "",
  subject: "",
  text: "",
  inReplyTo: "",
  references: "",
  attachments: [] as ComposeAttachment[],
  idempotencyKey: crypto.randomUUID(),
});
const compose = ref(emptyCompose()),
  showCc = ref(false),
  showBcc = ref(false),
  sending = ref(false),
  sendLocked = ref(false),
  retrying = ref(false);
const navItems = [
  { id: "inbox", label: "nav.inbox", icon: Inbox },
  { id: "sent", label: "nav.sent", icon: Send },
  { id: "starred", label: "nav.starred", icon: Star },
  { id: "archive", label: "nav.archive", icon: Archive },
  { id: "trash", label: "nav.trash", icon: Trash2 },
];
const titles: Record<string, string> = {
  inbox: "nav.inbox",
  sent: "nav.sent",
  starred: "nav.starred",
  archive: "nav.archive",
  trash: "nav.trash",
  domains: "nav.domains",
  mailboxes: "nav.mailboxes",
  settings: "settings.title",
};
const statusName = (status: string) =>
  te(`status.${status}`) ? t(`status.${status}`) : status;
const domainStatus = (status: string) =>
  te(`domains.status.${status}`) ? t(`domains.status.${status}`) : status;
const currentTitle = computed(() => t(titles[page.value] || "nav.inbox"));
const isMailPage = computed(() =>
  navItems.some((item) => item.id === page.value),
);
const senders = computed(() =>
  mailboxes.value.filter((m) => m.enabled && m.domain_sending_enabled),
);
const emailDocument = computed(
  () =>
    `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'"><style>body{overflow-wrap:anywhere;font:14px/1.6 sans-serif}img{max-width:100%}</style></head><body>${store.selected?.body_html || ""}</body></html>`,
);
const fmt = (t: number) =>
  new Intl.DateTimeFormat(locale.value, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(t * 1000));
const formatSize = (bytes: number) =>
  new Intl.NumberFormat(locale.value, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(bytes / 1024);
const initials = (s: string) => (s.trim()[0] || "?").toUpperCase();
const forwardingMailbox = ref<Mailbox | null>(null),
  forwardingTarget = ref(""),
  confirmation = ref("");
let resolveConfirmation: ((answer: boolean) => void) | undefined;
function confirmAction(message: string): Promise<boolean> {
  resolveConfirmation?.(false);
  confirmation.value = message;
  return new Promise((resolve) => {
    resolveConfirmation = resolve;
  });
}
function answerConfirmation(answer: boolean) {
  confirmation.value = "";
  resolveConfirmation?.(answer);
  resolveConfirmation = undefined;
}
let toastTimer: ReturnType<typeof setTimeout>,
  searchTimer: ReturnType<typeof setTimeout>,
  refreshTimer: ReturnType<typeof setInterval>;

function notify(message: string) {
  toast.value = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = ""), 6000);
}
async function perform(action: () => Promise<unknown>, message?: string) {
  try {
    await action();
    if (message) notify(message);
  } catch (error) {
    notify(errorMessage(error));
  }
}
async function loadAll() {
  const [d, m] = await Promise.all([
    api<Domain[]>("/domains"),
    api<Mailbox[]>("/mailboxes"),
  ]);
  if (!authenticated.value) return;
  domains.value = d;
  mailboxes.value = m;
  await Promise.all([store.loadStats(), store.load()]);
}
async function init() {
  checking.value = true;
  try {
    await api("/auth/me");
    authenticated.value = true;
    await loadAll();
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) {
      loginError.value = errorMessage(error);
      notify(errorMessage(error));
    }
  } finally {
    checking.value = false;
  }
}
async function login() {
  if (loggingIn.value) return;
  loggingIn.value = true;
  loginError.value = "";
  try {
    await post("/auth/login", {
      email: loginEmail.value,
      password: loginPassword.value,
    });
    loginPassword.value = "";
    authenticated.value = true;
    await loadAll();
  } catch (error) {
    loginError.value = errorMessage(error);
    if (authenticated.value) notify(loginError.value);
  } finally {
    loggingIn.value = false;
  }
}
function sessionExpired() {
  authenticated.value = false;
  store.reset();
  page.value = "inbox";
  domains.value = [];
  mailboxes.value = [];
  forwardingMailbox.value = null;
  domainModal.value = false;
  mailboxModal.value = false;
  settingsOpen.value = false;
  answerConfirmation(false);
  if (!composeOpen.value) compose.value = emptyCompose();
}
async function logout() {
  if (composeOpen.value && !(await confirmAction(t("auth.logoutConfirm"))))
    return;
  await perform(async () => {
    await post("/auth/logout", {});
    composeOpen.value = false;
    sessionExpired();
  });
}
async function changePassword(event: Event) {
  const form = new FormData(event.target as HTMLFormElement);
  await perform(async () => {
    await post("/auth/change-password", {
      currentPassword: form.get("current"),
      newPassword: form.get("next"),
    });
    settingsOpen.value = false;
    sessionExpired();
  }, t("auth.passwordChanged"));
}
function navigate(id: string) {
  page.value = id;
  store.clearSelection();
  if (navItems.some((item) => item.id === id)) store.folder = id;
}
async function updateDomain(
  domain: Domain,
  field: "receiving_enabled" | "sending_enabled",
) {
  await perform(async () => {
    await patch(`/domains/${domain.id}`, { [field]: !domain[field] });
    await loadAll();
  }, t("domains.updated"));
}
async function createDomain() {
  await perform(async () => {
    await post("/domains", { name: domainName.value });
    domainName.value = "";
    domainModal.value = false;
    await loadAll();
  }, t("domains.added"));
}
async function createMailbox() {
  await perform(async () => {
    await post("/mailboxes", newMailbox.value);
    mailboxModal.value = false;
    newMailbox.value = { domainId: "", localPart: "", displayName: "" };
    await loadAll();
  }, t("mailboxes.created"));
}
async function removeItem(kind: "domains" | "mailboxes", id: string) {
  if (!(await confirmAction(t("mailboxes.deleteConfirm")))) return;
  await perform(async () => {
    await del(`/${kind}/${id}`);
    await loadAll();
  }, t("mailboxes.deleted"));
}
async function toggleMailbox(mailbox: Mailbox) {
  await perform(async () => {
    await patch(`/mailboxes/${mailbox.id}`, { enabled: !mailbox.enabled });
    await loadAll();
  }, t("mailboxes.updated"));
}
function toggleForward(mailbox: Mailbox) {
  forwardingMailbox.value = mailbox;
  forwardingTarget.value = mailbox.forward_to || "";
}
async function saveForward() {
  if (!forwardingMailbox.value) return;
  const mailbox = forwardingMailbox.value,
    target = forwardingTarget.value.trim();
  await perform(async () => {
    await patch(`/mailboxes/${mailbox.id}`, {
      forwardEnabled: !!target.trim(),
      forwardTo: target.trim() || null,
    });
    forwardingMailbox.value = null;
    await loadAll();
  }, t("mailboxes.forwardUpdated"));
}
function startCompose(mode = "new") {
  if (composeOpen.value) return;
  compose.value = { ...emptyCompose(), mailboxId: senders.value[0]?.id || "" };
  sendLocked.value = false;
  showCc.value = false;
  showBcc.value = false;
  const selected = store.selected;
  if ((mode === "reply" || mode === "forward") && selected) {
    compose.value.mailboxId =
      senders.value.find((m) => m.email === selected.mailbox_email)?.id ||
      compose.value.mailboxId;
    compose.value.subject = /^(re|fwd):/i.test(selected.subject)
      ? selected.subject
      : `${mode === "reply" ? "Re" : "Fwd"}: ${selected.subject}`;
    compose.value.text = `\n\n--- ${t("compose.original")} ---\n${selected.body_text || ""}`;
    if (mode === "reply") {
      compose.value.to =
        selected.direction === "outbound"
          ? selected.to_addresses.join(", ")
          : selected.from_address;
      compose.value.inReplyTo = selected.message_id || "";
      compose.value.references = [
        selected.references_header,
        selected.message_id,
      ]
        .filter(Boolean)
        .join(" ");
    }
  }
  composeOpen.value = true;
}
async function closeCompose() {
  if (sending.value) return;
  if (sendLocked.value && !(await confirmAction(t("compose.uncertainClose"))))
    return;
  if (
    !sendLocked.value &&
    (compose.value.text ||
      compose.value.to ||
      compose.value.attachments.length) &&
    !(await confirmAction(t("compose.discard")))
  )
    return;
  composeOpen.value = false;
  compose.value = emptyCompose();
  sendLocked.value = false;
}
async function addFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  await perform(async () => {
    for (const file of files) {
      const currentBytes = compose.value.attachments.reduce(
        (n, a) => n + atob(a.content).length,
        0,
      );
      if (
        compose.value.attachments.length >= 10 ||
        currentBytes + file.size > 10 * 1024 * 1024
      )
        throw new Error(t("compose.attachmentLimit"));
      const content = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () =>
          resolve(String(reader.result).split(",")[1] || "");
        reader.onerror = () =>
          reject(new Error(t("compose.fileError", { name: file.name })));
        reader.readAsDataURL(file);
      });
      compose.value.attachments.push({
        filename: file.name,
        content,
        contentType: file.type || "application/octet-stream",
      });
    }
  });
  input.value = "";
}
async function send() {
  if (sending.value) return;
  if (
    !compose.value.mailboxId ||
    !compose.value.to.trim() ||
    !compose.value.text.trim()
  ) {
    notify(t("compose.required"));
    return;
  }
  sending.value = true;
  sendLocked.value = true;
  const addresses = (text: string) =>
    text
      .split(/[;,\n]/)
      .map((x) => x.trim())
      .filter(Boolean);
  try {
    await api("/send", {
      method: "POST",
      headers: { "Idempotency-Key": compose.value.idempotencyKey },
      body: JSON.stringify({
        mailboxId: compose.value.mailboxId,
        to: addresses(compose.value.to),
        cc: addresses(compose.value.cc),
        bcc: addresses(compose.value.bcc),
        subject: compose.value.subject,
        text: compose.value.text,
        attachments: compose.value.attachments,
        inReplyTo: compose.value.inReplyTo || undefined,
        references: compose.value.references || undefined,
      }),
    });
    composeOpen.value = false;
    sendLocked.value = false;
    compose.value = emptyCompose();
    notify(t("compose.submitted"));
    await Promise.all([store.load(), store.loadStats()]);
  } catch (error) {
    if (
      error instanceof ApiError &&
      [400, 401, 403, 413, 503].includes(error.status)
    )
      sendLocked.value = false;
    notify(errorMessage(error));
  } finally {
    sending.value = false;
  }
}
async function retry(message: MailMessage) {
  if (retrying.value) return;
  retrying.value = true;
  try {
    await store.retry(message);
  } finally {
    retrying.value = false;
  }
}
async function handleFailure(id: string, action: "replay" | "dismiss") {
  await perform(
    async () => {
      await post(`/settings/failures/${id}/${action}`, {});
      await loadAll();
    },
    action === "replay" ? t("settings.replayed") : t("settings.dismissed"),
  );
}
function changePage(direction: number) {
  store.offset = Math.max(0, store.offset + direction * store.limit);
  store.clearSelection();
  void store.load();
}
watch(
  () => [
    store.folder,
    store.mailboxFilter,
    store.domainFilter,
    store.unreadOnly,
  ],
  () => {
    if (authenticated.value) {
      store.clearSelection();
      void store.load(true);
    }
  },
);
watch(
  () => store.query,
  () => {
    clearTimeout(searchTimer);
    store.requestId++;
    searchTimer = setTimeout(() => {
      if (authenticated.value) {
        store.clearSelection();
        void store.load(true);
      }
    }, 300);
  },
);
watch(
  () => JSON.stringify({ ...compose.value, idempotencyKey: undefined }),
  () => {
    if (!sendLocked.value && !sending.value)
      compose.value.idempotencyKey = crypto.randomUUID();
  },
  { flush: "sync" },
);
onMounted(() => {
  window.addEventListener("session-expired", sessionExpired);
  void init();
  refreshTimer = setInterval(() => {
    if (
      authenticated.value &&
      !composeOpen.value &&
      !store.loading &&
      document.visibilityState === "visible"
    ) {
      void perform(async () => {
        await Promise.all([store.load(), store.loadStats()]);
      });
    }
  }, 30_000);
});
onUnmounted(() => {
  answerConfirmation(false);
  clearTimeout(searchTimer);
  clearTimeout(toastTimer);
  clearInterval(refreshTimer);
  window.removeEventListener("session-expired", sessionExpired);
});
</script>

<template>
  <div v-if="checking" class="boot">
    <img
      class="brand-mark"
      src="/folio.svg"
      alt=""
      width="35"
      height="35"
      draggable="false"
    />
    {{ t("app.starting") }}
  </div>
  <div v-else-if="!authenticated" class="login-page">
    <div class="login-card">
      <div class="brand-lockup">
        <img
          class="brand-mark"
          src="/folio.svg"
          alt=""
          width="35"
          height="35"
          draggable="false"
        />
        <div>
          <b>Folio</b><small>{{ t("app.tagline") }}</small>
        </div>
      </div>
      <LanguageSelect />
      <h1>{{ t("auth.title") }}</h1>
      <p>{{ t("auth.description") }}</p>
      <form @submit.prevent="login">
        <label for="login-email">{{ t("auth.email") }}</label><input
          id="login-email"
          v-model="loginEmail"
          type="email"
          autocomplete="username"
          required
        />
        <label for="login-password">{{ t("auth.password") }}</label><input
          id="login-password"
          v-model="loginPassword"
          type="password"
          autocomplete="current-password"
          required
        />
        <div v-if="loginError" class="form-error" role="alert">
          {{ loginError }}
        </div>
        <button class="primary full" type="submit" :disabled="loggingIn">
          {{ loggingIn ? t("auth.loggingIn") : t("auth.login") }}
        </button>
      </form>
      <div class="login-foot">
        <LockKeyhole :size="13" /> {{ t("auth.private") }}
      </div>
    </div>
  </div>
  <div v-else class="app-shell">
    <aside class="sidebar">
      <div class="brand-lockup">
        <img
          class="brand-mark"
          src="/folio.svg"
          alt=""
          width="35"
          height="35"
          draggable="false"
        />
        <div>
          <b>Folio</b><small>{{ t("app.mailWorkspace") }}</small>
        </div>
      </div>
      <button
        class="compose-btn"
        :title="t('nav.compose')"
        @click="startCompose()"
      >
        <PenSquare :size="17" /><span>{{ t("nav.compose") }}</span>
      </button>
      <div class="nav-caption">{{ t("nav.mail") }}</div>
      <nav>
        <button
          v-for="item in navItems"
          :key="item.id"
          :class="['nav-item', { active: page === item.id }]"
          :title="t(item.label)"
          @click="navigate(item.id)"
        >
          <component :is="item.icon" :size="17" /><span>{{
            t(item.label)
          }}</span
          ><em v-if="item.id === 'inbox' && store.stats.unread">{{
            store.stats.unread
          }}</em>
        </button>
      </nav>
      <div class="nav-caption domain-caption">{{ t("app.workspace") }}</div>
      <button
        class="nav-item"
        :class="{ active: page === 'domains' }"
        :title="t('nav.domains')"
        @click="navigate('domains')"
      >
        <Globe :size="17" /><span>{{ t("nav.domains") }}</span
        ><em>{{ domains.length }}</em>
      </button>
      <button
        class="nav-item"
        :class="{ active: page === 'mailboxes' }"
        :title="t('nav.mailboxes')"
        @click="navigate('mailboxes')"
      >
        <AtSign :size="17" /><span>{{ t("nav.mailboxes") }}</span
        ><em>{{ mailboxes.length }}</em>
      </button>
      <div class="sidebar-bottom">
        <div class="storage-card">
          <ShieldAlert :size="16" />
          <div>
            <b>{{ t("mail.ownership") }}</b><small>{{
              t("mail.storage")
            }}</small>
          </div>
        </div>
        <button
          class="nav-item"
          :class="{ active: page === 'settings' }"
          :title="t('nav.settings')"
          @click="navigate('settings')"
        >
          <Settings :size="17" /><span>{{ t("nav.settings") }}</span>
        </button>
      </div>
    </aside>
    <main class="main-area">
      <header class="topbar">
        <div class="crumb">
          <span>{{ t("app.workspace") }}</span><span>/</span
          ><b>{{ currentTitle }}</b>
        </div>
        <div class="top-actions">
          <span class="connection">{{ t("mail.refreshInterval") }}</span><button
            class="icon-btn"
            :title="t('common.refresh')"
            @click="perform(loadAll)"
          >
            <RefreshCw :size="17" />
          </button>
        </div>
      </header>
      <div v-if="store.error" class="error-banner" role="alert">
        {{ store.error
        }}<button class="text-btn" @click="store.error = ''">
          {{ t("common.close") }}
        </button>
      </div>
      <section v-if="isMailPage" class="mail-layout">
        <div class="list-pane">
          <div class="list-heading">
            <div>
              <div class="eyebrow">{{ t("mail.eyebrow") }}</div>
              <h1>
                {{ currentTitle }}
                <span class="count-pill">{{ store.total }}</span>
              </h1>
            </div>
            <button class="primary small" @click="startCompose()">
              <Plus :size="15" />{{ t("nav.compose") }}
            </button>
          </div>
          <div class="search-row">
            <div class="search-box">
              <Search :size="16" /><input
                v-model="store.query"
                maxlength="200"
                :aria-label="t('mail.search')"
                :placeholder="t('mail.searchPlaceholder')"
              />
            </div>
            <button
              class="filter-btn"
              :class="{ selected: store.unreadOnly }"
              @click="store.unreadOnly = !store.unreadOnly"
            >
              <Filter :size="15" />{{ t("common.unread") }}
            </button>
          </div>
          <div class="mailbox-filter">
            <select
              v-model="store.domainFilter"
              :aria-label="t('mail.filterDomain')"
            >
              <option value="">{{ t("mail.allDomains") }}</option>
              <option v-for="d in domains" :key="d.id" :value="d.id">
                {{ d.name }}
              </option></select
            ><select
              v-model="store.mailboxFilter"
              :aria-label="t('mail.filterMailbox')"
            >
              <option value="">{{ t("mail.allMailboxes") }}</option>
              <option v-for="m in mailboxes" :key="m.id" :value="m.id">
                {{ m.email }}
              </option>
            </select>
          </div>
          <div
            v-if="store.messages.length"
            class="message-list"
            :aria-busy="store.loading"
          >
            <div
              v-for="m in store.messages"
              :key="m.id"
              :class="[
                'message-row',
                { selected: store.selected?.id === m.id, unread: !m.is_read },
              ]"
            >
              <button class="message-open" @click="store.open(m.id)">
                <div class="sender-avatar">
                  {{ initials(m.from_name || m.from_address) }}
                </div>
                <div class="message-main">
                  <div class="message-top">
                    <b>{{
                      m.direction === "outbound"
                        ? t("mail.sentTo", {
                            recipients: m.to_addresses.join(", "),
                          })
                        : m.from_name || m.from_address
                    }}</b><time>{{ fmt(m.received_at) }}</time>
                  </div>
                  <div class="message-subject">{{ m.subject }}</div>
                  <div class="message-snippet">
                    {{ m.snippet || t("mail.noSnippet") }}
                  </div>
                  <div class="message-tags">
                    <span>{{
                      m.mailbox_email || t("mail.removedMailbox")
                    }}</span><Paperclip
                      v-if="m.has_attachments"
                      :size="12"
                    /><span
                      v-if="m.direction === 'outbound'"
                      :class="{
                        'tag-error': ['failed', 'unknown', 'bounced'].includes(
                          m.status,
                        ),
                      }"
                      >{{ statusName(m.status) }}</span
                    >
                  </div>
                </div>
              </button>
              <button
                class="row-star"
                :title="m.is_starred ? t('mail.removeStar') : t('mail.addStar')"
                @click="store.toggleStar(m)"
              >
                <Star
                  :size="15"
                  :fill="m.is_starred ? 'currentColor' : 'none'"
                />
              </button>
            </div>
          </div>
          <div v-else class="empty-list">
            <div class="empty-icon"><Inbox :size="23" /></div>
            <b>{{ store.loading ? t("mail.loading") : t("mail.empty") }}</b>
            <p>{{ t("mail.refreshHint") }}</p>
          </div>
          <div class="list-footer">
            <span>{{
              t("mail.pagination", {
                total: t("mail.messageCount", store.total),
                page: Math.floor(store.offset / store.limit) + 1,
              })
            }}</span>
            <div>
              <button
                class="text-btn"
                :disabled="store.loading || store.offset === 0"
                @click="changePage(-1)"
              >
                {{ t("mail.previous") }}</button><button
                class="text-btn"
                :disabled="
                  store.loading || store.offset + store.limit >= store.total
                "
                @click="changePage(1)"
              >
                {{ t("mail.next") }}
              </button>
            </div>
          </div>
        </div>
        <div v-if="store.selected" class="detail-pane">
          <div class="detail-toolbar">
            <button
              class="icon-btn"
              :title="t('mail.back')"
              @click="store.clearSelection()"
            >
              <ArrowLeft :size="17" />
            </button>
            <div class="toolbar-spacer"></div>
            <button
              class="icon-btn"
              :title="t('mail.toggleStar')"
              @click="store.toggleStar(store.selected)"
            >
              <Star
                :size="17"
                :fill="store.selected.is_starred ? 'currentColor' : 'none'"
              /></button
            ><button class="text-btn" @click="store.archive(store.selected)">
              {{
                store.selected.is_archived
                  ? t("mail.unarchive")
                  : t("nav.archive")
              }}</button
            ><button class="text-btn" @click="store.trash(store.selected)">
              {{
                store.selected.is_deleted
                  ? t("mail.restore")
                  : t("mail.moveToTrash")
              }}</button
            ><button
              class="text-btn"
              @click="
                store.update(store.selected, {
                  isRead: !store.selected.is_read,
                })
              "
            >
              {{
                store.selected.is_read
                  ? t("mail.markUnread")
                  : t("mail.markRead")
              }}
            </button>
          </div>
          <article class="email-detail">
            <div class="detail-domain">
              {{ store.selected.mailbox_email }} ·
              {{ fmt(store.selected.received_at) }}
            </div>
            <h2>{{ store.selected.subject }}</h2>
            <div class="sender-block">
              <div class="sender-avatar large">
                {{
                  initials(
                    store.selected.from_name || store.selected.from_address,
                  )
                }}
              </div>
              <div class="sender-meta">
                <b>{{
                  store.selected.from_name || store.selected.from_address
                }}</b><span>{{ store.selected.from_address }}</span>
              </div>
            </div>
            <div class="recipient-line">
              {{ t("mail.toLabel") }}
              <b>{{ store.selected.to_addresses.join(", ") }}</b>
              <div v-if="store.selected.cc_addresses.length">
                {{ t("compose.cc") }}
                {{ store.selected.cc_addresses.join(", ") }}
              </div>
              <div v-if="store.selected.bcc_addresses.length">
                {{ t("compose.bcc") }}
                {{ store.selected.bcc_addresses.join(", ") }}
              </div>
            </div>
            <div
              v-if="store.selected.direction === 'outbound'"
              class="send-state"
            >
              <b>{{ statusName(store.selected.status) }}</b>
              <p v-if="store.selected.send_error">
                {{ store.selected.send_error }}
              </p>
              <button
                v-if="
                  ['pending', 'unknown', 'failed'].includes(
                    store.selected.status,
                  )
                "
                class="secondary"
                :disabled="retrying"
                @click="retry(store.selected)"
              >
                {{ retrying ? t("mail.confirming") : t("mail.retry") }}
              </button>
            </div>
            <div v-if="store.selected.body_html" class="email-body">
              <small>{{ t("mail.privacy") }}</small><iframe
                :srcdoc="emailDocument"
                :title="t('mail.body')"
                sandbox=""
                referrerpolicy="no-referrer"
              ></iframe>
            </div>
            <pre v-else class="plain-body">{{
              store.selected.body_text || t("mail.noBody")
            }}</pre>
            <div v-if="store.selected.attachments.length" class="attachments">
              <b>{{
                t("mail.attachments", {
                  count: store.selected.attachments.length,
                })
              }}</b><a
                v-for="a in store.selected.attachments"
                :key="a.id"
                :href="`/api/v1/messages/attachments/${a.id}`"
                ><Paperclip :size="15" /><span
                  >{{ a.filename
                  }}<small>{{
                    t("mail.attachmentSize", { size: formatSize(a.size) })
                  }}</small></span
                ></a
              >
            </div>
            <div class="detail-actions">
              <button class="primary" @click="startCompose('reply')">
                <Reply :size="16" />{{ t("mail.reply") }}</button
              ><button class="secondary" @click="startCompose('forward')">
                <Forward :size="16" />{{ t("mail.forward") }}
              </button>
            </div>
          </article>
        </div>
        <div v-else class="detail-placeholder">
          <div class="placeholder-art"><Mail :size="28" /></div>
          <b>{{ store.opening ? t("mail.opening") : t("mail.select") }}</b>
          <p>{{ t("mail.selectHint") }}</p>
        </div>
      </section>
      <section v-else-if="page === 'domains'" class="management-page">
        <div class="page-title">
          <div>
            <div class="eyebrow">{{ t("domains.eyebrow") }}</div>
            <h1>{{ t("nav.domains") }}</h1>
            <p>{{ t("domains.description") }}</p>
          </div>
          <button class="primary" @click="domainModal = true">
            <Plus :size="16" />{{ t("domains.add") }}
          </button>
        </div>
        <div class="domain-grid">
          <div v-for="d in domains" :key="d.id" class="domain-card">
            <div class="domain-card-top">
              <div class="domain-icon"><Globe :size="18" /></div>
              <span class="status" :class="d.status">{{
                domainStatus(d.status)
              }}</span>
            </div>
            <h3>{{ d.name }}</h3>
            <div class="domain-stats">
              <div>
                <b>{{ d.mailbox_count }}</b><small>{{
                  t("nav.mailboxes")
                }}</small>
              </div>
              <div>
                <b>{{ d.inbound_count }}</b><small>{{
                  t("domains.received")
                }}</small>
              </div>
            </div>
            <div class="domain-flags">
              <span :class="{ on: d.receiving_enabled }"
                ><i></i>{{ t("domains.receiving") }}</span
              ><span :class="{ on: d.sending_enabled }"
                ><i></i>{{ t("domains.sending") }}</span
              >
            </div>
            <div class="domain-card-actions">
              <button
                class="text-btn"
                @click="updateDomain(d, 'receiving_enabled')"
              >
                {{
                  d.receiving_enabled
                    ? t("domains.disableReceiving")
                    : t("domains.enableReceiving")
                }}</button><button
                class="text-btn"
                @click="updateDomain(d, 'sending_enabled')"
              >
                {{
                  d.sending_enabled
                    ? t("domains.disableSending")
                    : t("domains.verifySending")
                }}</button
              ><button
                class="icon-btn"
                :title="t('domains.delete')"
                @click="removeItem('domains', d.id)"
              >
                <Trash2 :size="15" />
              </button>
            </div>
          </div>
          <button class="add-domain-card" @click="domainModal = true">
            <Plus :size="20" /><b>{{ t("domains.add") }}</b
            ><span>{{ t("domains.multiple") }}</span>
          </button>
        </div>
      </section>
      <section v-else-if="page === 'mailboxes'" class="management-page">
        <div class="page-title">
          <div>
            <div class="eyebrow">{{ t("mailboxes.eyebrow") }}</div>
            <h1>{{ t("nav.mailboxes") }}</h1>
            <p>{{ t("mailboxes.description") }}</p>
          </div>
          <button
            class="primary"
            :disabled="!domains.length"
            @click="mailboxModal = true"
          >
            <Plus :size="16" />{{ t("mailboxes.create") }}
          </button>
        </div>
        <div class="table-card">
          <table>
            <thead>
              <tr>
                <th>{{ t("nav.mailboxes") }}</th>
                <th>{{ t("mailboxes.domain") }}</th>
                <th>{{ t("mailboxes.received") }}</th>
                <th>{{ t("mailboxes.forwarding") }}</th>
                <th>{{ t("common.unread") }}</th>
                <th>{{ t("common.status") }}</th>
                <th>{{ t("common.actions") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in mailboxes" :key="m.id">
                <td>
                  <div class="mailbox-cell">
                    <AtSign :size="15" />
                    <div>
                      <b>{{ m.email }}</b><small>{{
                        m.display_name || t("mailboxes.noDisplayName")
                      }}</small>
                    </div>
                  </div>
                </td>
                <td>{{ m.domain_name }}</td>
                <td>{{ t("mail.messageCount", m.received_count) }}</td>
                <td>
                  <button
                    class="forward-switch"
                    :class="{ enabled: m.forward_enabled }"
                    @click="toggleForward(m)"
                  >
                    <i></i
                    >{{
                      m.forward_enabled ? t("common.on") : t("common.off")
                    }}</button
                  ><small v-if="m.forward_to" class="forward-target">{{
                    m.forward_to
                  }}</small>
                </td>
                <td>{{ m.unread_count }}</td>
                <td>
                  <span
                    class="status"
                    :class="m.enabled ? 'active' : 'pending'"
                    >{{
                      m.enabled ? t("common.enabled") : t("common.disabled")
                    }}</span
                  >
                </td>
                <td>
                  <button class="text-btn" @click="toggleMailbox(m)">
                    {{
                      m.enabled ? t("common.disable") : t("common.enable")
                    }}</button><button
                    class="text-btn"
                    @click="removeItem('mailboxes', m.id)"
                  >
                    {{ t("common.delete") }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-if="!mailboxes.length" class="table-empty">
            {{ t("mailboxes.empty") }}
          </div>
        </div>
      </section>
      <section v-else class="management-page">
        <div class="page-title">
          <div>
            <div class="eyebrow">{{ t("settings.eyebrow") }}</div>
            <h1>{{ t("settings.title") }}</h1>
            <p>{{ t("settings.description") }}</p>
          </div>
        </div>
        <div class="settings-grid">
          <div class="setting-card">
            <div class="setting-icon"><ShieldAlert :size="18" /></div>
            <h3>{{ t("settings.account") }}</h3>
            <p>{{ t("settings.accountHint") }}</p>
            <div class="account-actions">
              <button class="secondary" @click="settingsOpen = true">
                {{ t("auth.changePassword") }}
              </button>
              <button class="secondary" @click="logout">
                <LogOut :size="15" />{{ t("auth.logout") }}
              </button>
            </div>
          </div>
          <div class="setting-card">
            <h3>{{ t("settings.language") }}</h3>
            <p>{{ t("settings.languageHint") }}</p>
            <LanguageSelect />
          </div>
          <div class="setting-card">
            <div class="setting-icon"><Send :size="18" /></div>
            <h3>{{ t("settings.sending") }}</h3>
            <p>
              {{
                t("settings.resendKey", {
                  status: t(
                    store.resendConfigured
                      ? "common.configured"
                      : "common.notConfigured",
                  ),
                })
              }}<br />
              {{
                t("settings.webhookKey", {
                  status: t(
                    store.webhookConfigured
                      ? "common.configured"
                      : "common.notConfigured",
                  ),
                })
              }}
            </p>
            <small>{{ t("settings.configHint") }}</small>
          </div>
          <div class="setting-card">
            <div class="setting-icon"><LayoutGrid :size="18" /></div>
            <h3>{{ t("settings.overview") }}</h3>
            <div class="overview-stats">
              <div>
                <b>{{ store.stats.domains }}</b><small>{{
                  t("common.domains")
                }}</small>
              </div>
              <div>
                <b>{{ store.stats.mailboxes }}</b><small>{{
                  t("common.mailboxes")
                }}</small>
              </div>
              <div>
                <b>{{ store.stats.messages }}</b><small>{{
                  t("common.messages")
                }}</small>
              </div>
            </div>
          </div>
        </div>
        <h3 class="failures-title">{{ t("settings.failures") }}</h3>
        <div v-if="!store.failures.length" class="setting-card">
          {{ t("settings.noFailures") }}
        </div>
        <div
          v-for="failure in store.failures"
          :key="failure.id"
          class="setting-card failure-card"
        >
          <b>{{ failure.recipient }} · {{ fmt(failure.created_at) }}</b>
          <p>{{ failure.reason }}</p>
          <button
            v-if="
              failure.raw_object_key &&
              !failure.reason.startsWith('Forward failed')
            "
            class="secondary"
            @click="handleFailure(failure.id, 'replay')"
          >
            {{ t("settings.replay") }}</button><button
            class="text-btn"
            @click="handleFailure(failure.id, 'dismiss')"
          >
            {{ t("settings.dismiss") }}
          </button>
        </div>
      </section>
    </main>
  </div>
  <div
    v-if="authenticated && composeOpen"
    class="overlay"
    @click.self="closeCompose"
  >
    <div class="compose-window">
      <div class="compose-head">
        <div>
          <PenSquare :size="17" /><b>{{ t("compose.title") }}</b>
        </div>
        <button
          class="icon-btn"
          :title="t('compose.close')"
          :disabled="sending"
          @click="closeCompose"
        >
          <X :size="18" />
        </button>
      </div>
      <fieldset :disabled="sending || sendLocked" class="compose-fields">
        <div class="compose-field">
          <label for="sender">{{ t("compose.from") }}</label><select
            id="sender"
            v-model="compose.mailboxId"
          >
            <option value="">{{ t("compose.chooseSender") }}</option>
            <option v-for="m in senders" :key="m.id" :value="m.id">
              {{ m.display_name ? `${m.display_name} (${m.email})` : m.email }}
            </option>
          </select>
        </div>
        <div class="compose-field">
          <label for="to">{{ t("compose.to") }}</label><input
            id="to"
            v-model="compose.to"
            placeholder="recipient@example.com"
          />
          <div class="cc-links">
            <button @click="showCc = !showCc">
              {{ t("compose.cc") }}</button><button @click="showBcc = !showBcc">
              {{ t("compose.bcc") }}
            </button>
          </div>
        </div>
        <div v-if="showCc" class="compose-field">
          <label for="cc">{{ t("compose.cc") }}</label><input
            id="cc"
            v-model="compose.cc"
          />
        </div>
        <div v-if="showBcc" class="compose-field">
          <label for="bcc">{{ t("compose.bcc") }}</label><input
            id="bcc"
            v-model="compose.bcc"
          />
        </div>
        <div class="compose-field">
          <label for="subject">{{ t("compose.subject") }}</label><input
            id="subject"
            v-model="compose.subject"
            maxlength="998"
            :placeholder="t('compose.subjectPlaceholder')"
          />
        </div>
        <textarea
          v-model="compose.text"
          class="compose-body"
          :aria-label="t('mail.body')"
          :placeholder="t('compose.bodyPlaceholder')"
        ></textarea>
        <div class="compose-attachments">
          <label class="attach-label"
            >{{ t("compose.addAttachments")
            }}<input type="file" multiple hidden @change="addFiles"
          /></label>
          <div v-for="(a, index) in compose.attachments" :key="index">
            {{ a.filename
            }}<button
              class="text-btn"
              @click="compose.attachments.splice(index, 1)"
            >
              {{ t("common.remove") }}
            </button>
          </div>
        </div>
      </fieldset>
      <div v-if="sendLocked && !sending" class="error-banner">
        {{ t("compose.locked") }}
      </div>
      <div class="compose-foot">
        <span>{{ t("compose.footer") }}</span><button
          class="primary"
          :disabled="sending"
          @click="send"
        >
          <Send :size="15" />{{
            sending
              ? t("compose.sending")
              : sendLocked
                ? t("compose.retry")
                : t("compose.send")
          }}
        </button>
      </div>
    </div>
  </div>
  <div
    v-if="authenticated && domainModal"
    class="overlay"
    @click.self="domainModal = false"
  >
    <form class="modal" @submit.prevent="createDomain">
      <div class="modal-head">
        <h2>{{ t("domains.add") }}</h2>
        <button
          type="button"
          class="icon-btn"
          :title="t('common.close')"
          @click="domainModal = false"
        >
          <X :size="18" />
        </button>
      </div>
      <label for="domain">{{ t("common.domain") }}</label><input
        id="domain"
        v-model="domainName"
        placeholder="example.com"
        required
      />
      <div class="modal-note">
        <AlertCircle :size="15" />{{ t("domains.setupHint") }}
      </div>
      <div class="modal-actions">
        <button class="primary" type="submit">{{ t("domains.add") }}</button>
      </div>
    </form>
  </div>
  <div
    v-if="authenticated && mailboxModal"
    class="overlay"
    @click.self="mailboxModal = false"
  >
    <form class="modal" @submit.prevent="createMailbox">
      <div class="modal-head">
        <h2>{{ t("mailboxes.createTitle") }}</h2>
        <button
          type="button"
          class="icon-btn"
          :title="t('common.close')"
          @click="mailboxModal = false"
        >
          <X :size="18" />
        </button>
      </div>
      <label for="mailbox-domain">{{ t("mailboxes.domain") }}</label><select
        id="mailbox-domain"
        v-model="newMailbox.domainId"
        required
      >
        <option value="">{{ t("mailboxes.chooseDomain") }}</option>
        <option v-for="d in domains" :key="d.id" :value="d.id">
          {{ d.name }}
        </option></select
      ><label for="local-part">{{ t("mailboxes.localPart") }}</label
      ><input
        id="local-part"
        v-model="newMailbox.localPart"
        placeholder="hello"
        maxlength="64"
        required
      /><label for="display-name">{{ t("mailboxes.displayName") }}</label
      ><input
        id="display-name"
        v-model="newMailbox.displayName"
        maxlength="100"
      />
      <div class="modal-actions">
        <button class="primary" type="submit">
          {{ t("mailboxes.create") }}
        </button>
      </div>
    </form>
  </div>
  <div
    v-if="authenticated && settingsOpen"
    class="overlay"
    @click.self="settingsOpen = false"
  >
    <form class="modal" @submit.prevent="changePassword">
      <div class="modal-head">
        <h2>{{ t("auth.changePassword") }}</h2>
        <button
          type="button"
          class="icon-btn"
          :title="t('common.close')"
          @click="settingsOpen = false"
        >
          <X :size="18" />
        </button>
      </div>
      <label for="current-password">{{
        t("auth.currentPassword")
      }}</label><input
        id="current-password"
        name="current"
        type="password"
        autocomplete="current-password"
        required
      /><label for="new-password">{{ t("auth.newPassword") }}</label
      ><input
        id="new-password"
        name="next"
        type="password"
        autocomplete="new-password"
        minlength="12"
        maxlength="256"
        required
      />
      <div class="modal-actions">
        <button class="primary" type="submit">
          {{ t("auth.savePassword") }}
        </button>
      </div>
    </form>
  </div>
  <div
    v-if="authenticated && forwardingMailbox"
    class="overlay"
    @click.self="forwardingMailbox = null"
  >
    <form class="modal" @submit.prevent="saveForward">
      <div class="modal-head">
        <h2>{{ t("mailboxes.forwarding") }}</h2>
        <button
          type="button"
          class="icon-btn"
          :title="t('common.close')"
          @click="forwardingMailbox = null"
        >
          <X :size="18" />
        </button>
      </div>
      <p>
        {{ t("mailboxes.forwardHint", { email: forwardingMailbox.email }) }}
      </p>
      <label for="forward-to">{{ t("mailboxes.forwardTo") }}</label><input
        id="forward-to"
        v-model="forwardingTarget"
        type="email"
        placeholder="target@example.com"
      />
      <div class="modal-actions">
        <button
          class="secondary"
          type="button"
          @click="forwardingMailbox = null"
        >
          {{ t("common.cancel") }}</button><button
          class="primary"
          type="submit"
        >
          {{ t("mailboxes.saveForward") }}
        </button>
      </div>
    </form>
  </div>
  <div
    v-if="confirmation"
    class="overlay confirmation-overlay"
    @click.self="answerConfirmation(false)"
  >
    <div
      class="modal"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirmation-title"
    >
      <h2 id="confirmation-title">{{ t("common.confirmTitle") }}</h2>
      <p>{{ confirmation }}</p>
      <div class="modal-actions">
        <button class="secondary" @click="answerConfirmation(false)">
          {{ t("common.cancel") }}</button><button
          class="primary"
          @click="answerConfirmation(true)"
        >
          {{ t("common.confirm") }}
        </button>
      </div>
    </div>
  </div>
  <Transition
    ><div v-if="toast" class="toast" role="status">{{ toast }}</div></Transition
  >
</template>

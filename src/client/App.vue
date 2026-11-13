<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import UApp from "@nuxt/ui/components/App.vue";
import UButton from "@nuxt/ui/components/Button.vue";
import UInput from "@nuxt/ui/components/Input.vue";
import UTextarea from "@nuxt/ui/components/Textarea.vue";
import USelect from "@nuxt/ui/components/Select.vue";
import UDashboardGroup from "@nuxt/ui/components/DashboardGroup.vue";
import UDashboardNavbar from "@nuxt/ui/components/DashboardNavbar.vue";
import UDashboardSidebarCollapse from "@nuxt/ui/components/DashboardSidebarCollapse.vue";
import { zh_cn, en } from "@nuxt/ui/locale";
import WorkspaceSidebar from "./components/WorkspaceSidebar.vue";
import MailList from "./components/MailList.vue";
import MailReader from "./components/MailReader.vue";
import FormModal from "./components/FormModal.vue";
import DomainSetup from "./components/DomainSetup.vue";
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
  Plus,
  PenSquare,
  Paperclip,
  Forward,
  LogOut,
  LockKeyhole,
  X,
  AlertCircle,
  CheckCircle2,
  Minus,
  Maximize2,
  Minimize2,
} from "lucide-vue-next";
import { useMailStore } from "./stores/mail";
import { api, ApiError, errorMessage, post, patch, del } from "./lib/api";
import { replyRecipients } from "./lib/compose";
import {
  composeSender,
  hasComposeContent,
  mailboxesForDomain,
} from "./lib/workspace";
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
const smallScreen = ref(window.matchMedia("(max-width: 1023px)").matches);
const mobileNav = ref(false),
  compactNav = ref(false),
  filtersOpen = ref(false),
  composeMinimized = ref(false),
  composeExpanded = ref(false),
  refreshing = ref(false);
const composeOpen = ref(false),
  domainModal = ref(false),
  mailboxModal = ref(false),
  settingsOpen = ref(false),
  toast = ref("");
const domainName = ref(""),
  newMailbox = ref({ domainId: "", localPart: "", displayName: "" });
const setupDomainId = ref("");
const returnToSetup = ref("");
const setupDomain = computed(() =>
  domains.value.find((d) => d.id === setupDomainId.value),
);
const domainUpdating = ref(false);
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
const composeMode = ref("new");
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
const currentTitle = computed(() => t(titles[page.value] || "nav.inbox"));
const isMailPage = computed(() =>
  navItems.some((item) => item.id === page.value),
);
const senders = computed(() =>
  mailboxes.value.filter((m) => m.enabled && m.domain_sending_enabled),
);
const filteredMailboxes = computed(() =>
  mailboxesForDomain(mailboxes.value, store.domainFilter),
);
const hasFilters = computed(
  () =>
    !!(
      store.query ||
      store.domainFilter ||
      store.mailboxFilter ||
      store.unreadOnly
    ),
);
const selectionIndex = computed(() =>
  store.messages.findIndex((m) => m.id === store.selected?.id),
);
const dialogActive = computed(
  () =>
    !!(
      confirmation.value ||
      domainModal.value ||
      mailboxModal.value ||
      settingsOpen.value ||
      forwardingMailbox.value ||
      setupDomainId.value
    ),
);
function clearFilters() {
  store.query = "";
  store.domainFilter = "";
  store.mailboxFilter = "";
  store.unreadOnly = false;
}
async function refresh() {
  if (refreshing.value) return;
  refreshing.value = true;
  await perform(loadAll);
  refreshing.value = false;
}
function openMailbox(mailbox: Mailbox) {
  clearFilters();
  navigate("inbox");
  store.domainFilter = mailbox.domain_id;
  store.mailboxFilter = mailbox.id;
}
function addMailbox(domainId = "", continueSetup = false) {
  returnToSetup.value = continueSetup ? domainId : "";
  newMailbox.value.domainId = domainId || domains.value[0]?.id || "";
  mailboxModal.value = true;
}
function moveSelection(direction: number) {
  const message = store.messages[selectionIndex.value + direction];
  if (message && !store.opening) void store.open(message.id);
}
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
  mobileNav.value = false;
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
  if (
    composeOpen.value &&
    (sendLocked.value || hasComposeContent(compose.value)) &&
    !(await confirmAction(t("auth.logoutConfirm")))
  )
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
  mobileNav.value = false;
  page.value = id;
  store.clearSelection();
  if (navItems.some((item) => item.id === id)) store.folder = id;
}
async function updateDomain(
  domain: Domain,
  field: "receiving_enabled" | "sending_enabled",
) {
  if (domainUpdating.value) return;
  domainUpdating.value = true;
  await perform(async () => {
    await patch(`/domains/${domain.id}`, { [field]: !domain[field] });
    await loadAll();
  }, t("domains.updated"));
  domainUpdating.value = false;
}
async function createDomain() {
  await perform(async () => {
    const name = domainName.value.trim().toLowerCase();
    await post("/domains", { name });
    domainName.value = "";
    domainModal.value = false;
    await loadAll();
    setupDomainId.value = domains.value.find((d) => d.name === name)?.id || "";
  }, t("domains.added"));
}
async function createMailbox() {
  await perform(async () => {
    await post("/mailboxes", newMailbox.value);
    mailboxModal.value = false;
    newMailbox.value = { domainId: "", localPart: "", displayName: "" };
    await loadAll();
    if (returnToSetup.value) {
      setupDomainId.value = returnToSetup.value;
      returnToSetup.value = "";
    }
  }, t("mailboxes.created"));
}
async function removeItem(kind: "domains" | "mailboxes", id: string) {
  const name =
    kind === "domains"
      ? domains.value.find((d) => d.id === id)?.name
      : mailboxes.value.find((m) => m.id === id)?.email;
  if (
    !(await confirmAction(
      t(kind === "domains" ? "ui.deleteDomain" : "ui.deleteMailbox", { name }),
    ))
  )
    return;
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
  mobileNav.value = false;
  composeMinimized.value = false;
  if (composeOpen.value) {
    if (mode !== "new") notify(t("ui.existingDraft"));
    void nextTick(() =>
      document
        .getElementById(compose.value.mailboxId ? "to" : "sender")
        ?.focus(),
    );
    return;
  }
  compose.value = {
    ...emptyCompose(),
    mailboxId: composeSender(mailboxes.value, store.mailboxFilter),
  };
  composeMode.value = mode;
  sendLocked.value = false;
  showCc.value = false;
  showBcc.value = false;
  const selected = store.selected;
  if ((mode === "reply" || mode === "forward") && selected) {
    compose.value.mailboxId = composeSender(
      mailboxes.value,
      "",
      selected.mailbox_email || "__removed__",
    );
    compose.value.subject = (mode === "reply" ? /^re:/i : /^fwd:/i).test(
      selected.subject,
    )
      ? selected.subject
      : `${mode === "reply" ? "Re" : "Fwd"}: ${selected.subject}`;
    compose.value.text = `\n\n--- ${t("compose.original")} ---\n${selected.body_text || ""}`;
    if (mode === "reply") {
      compose.value.to = replyRecipients(selected).join(", ");
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
  void nextTick(() =>
    document
      .getElementById(
        !compose.value.mailboxId
          ? "sender"
          : mode === "reply"
            ? "compose-body"
            : "to",
      )
      ?.focus(),
  );
}
async function closeCompose() {
  if (sending.value) return;
  if (sendLocked.value && !(await confirmAction(t("compose.uncertainClose"))))
    return;
  if (
    !sendLocked.value &&
    hasComposeContent(compose.value) &&
    !(await confirmAction(t("compose.discard")))
  )
    return;
  composeOpen.value = false;
  composeMinimized.value = false;
  composeExpanded.value = false;
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
  if (!store.resendConfigured) {
    notify(t("ui.missingService"));
    return;
  }
  if (!senders.value.some((m) => m.id === compose.value.mailboxId)) {
    notify(t("ui.chooseIdentity"));
    document.getElementById("sender")?.focus();
    return;
  }
  if (
    !compose.value.mailboxId ||
    !compose.value.to.trim() ||
    !compose.value.text.trim()
  ) {
    notify(t("compose.required"));
    document
      .getElementById(
        !compose.value.mailboxId
          ? "sender"
          : !compose.value.to.trim()
            ? "to"
            : "compose-body",
      )
      ?.focus();
    return;
  }
  if (
    !sendLocked.value &&
    !compose.value.subject.trim() &&
    !(await confirmAction(t("ui.emptySubject")))
  )
    return;
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
watch(
  () => store.domainFilter,
  () => {
    if (!filteredMailboxes.value.some((m) => m.id === store.mailboxFilter))
      store.mailboxFilter = "";
  },
);
function resize() {
  smallScreen.value = window.matchMedia("(max-width: 1023px)").matches;
  if (!smallScreen.value) mobileNav.value = false;
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (composeOpen.value && hasComposeContent(compose.value)) {
    event.preventDefault();
    event.returnValue = "";
  }
}
function keydown(event: KeyboardEvent) {
  if (event.isComposing || event.defaultPrevented) return;
  if (dialogActive.value || mobileNav.value) return;
  if (!authenticated.value) return;
  if ((event.target as HTMLElement).closest('[role="listbox"]')) return;
  if (
    smallScreen.value &&
    composeOpen.value &&
    !composeMinimized.value &&
    event.key === "Tab"
  ) {
    const items = Array.from(
      document.querySelectorAll<HTMLElement>(
        '.compose-window button:not([disabled]), .compose-window input:not([disabled]):not([type="hidden"]), .compose-window textarea:not([disabled]), .compose-window [tabindex="0"]',
      ),
    ).filter(
      (element) =>
        element.getClientRects().length &&
        element.getAttribute("type") !== "file",
    );
    if (event.shiftKey && document.activeElement === items[0]) {
      event.preventDefault();
      items.at(-1)?.focus();
    } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
      event.preventDefault();
      items[0]?.focus();
    }
  }
  if (event.key === "Escape") {
    if (mobileNav.value) mobileNav.value = false;
    else if (composeOpen.value && !composeMinimized.value) {
      composeMinimized.value = true;
      void nextTick(() =>
        document.querySelector<HTMLElement>(".compose-heading")?.focus(),
      );
    } else store.clearSelection();
    return;
  }
  if (
    event.key === "Enter" &&
    (event.metaKey || event.ctrlKey) &&
    composeOpen.value &&
    !composeMinimized.value &&
    (event.target as HTMLElement).closest(".compose-window")
  ) {
    event.preventDefault();
    void send();
    return;
  }
  const target = event.target as HTMLElement;
  if (
    target.closest(
      "input, textarea, select, [role=combobox], [role=listbox], [contenteditable='true']",
    ) ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey
  )
    return;
  if (event.key === "/" && isMailPage.value) {
    event.preventDefault();
    document.getElementById("mail-search")?.focus();
  }
  if (event.key.toLowerCase() === "c") {
    event.preventDefault();
    startCompose();
  }
}
onMounted(() => {
  window.addEventListener("resize", resize);
  window.addEventListener("keydown", keydown);
  window.addEventListener("beforeunload", beforeUnload);

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
  window.removeEventListener("resize", resize);
  window.removeEventListener("keydown", keydown);
  window.removeEventListener("beforeunload", beforeUnload);
  answerConfirmation(false);
  clearTimeout(searchTimer);
  clearTimeout(toastTimer);
  clearInterval(refreshTimer);
  window.removeEventListener("session-expired", sessionExpired);
});
</script>

<template>
  <UApp
    :locale="locale === 'zh-CN' ? zh_cn : en"
    :tooltip="{ delayDuration: 300 }"
  >
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
      <aside class="login-story">
        <div class="login-story-brand">
          <img src="/folio.svg" alt="" width="40" height="40" /><b>Folio</b>
        </div>
        <div class="login-story-copy">
          <span class="eyebrow">{{ t("ui.privateWorkspace") }}</span>
          <h2>{{ t("ui.loginHeadline") }}</h2>
          <p>{{ t("ui.loginStory") }}</p>
        </div>
        <div class="login-story-foot">
          <LockKeyhole :size="17" /><span>{{ t("mail.ownership") }}</span
          ><span>01 — FOLIO</span>
        </div>
      </aside>
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
          <label for="login-email">{{ t("auth.email") }}</label><UInput
            class="w-full"
            id="login-email"
            v-model="loginEmail"
            type="email"
            autocomplete="username"
            required
          />
          <label for="login-password">{{ t("auth.password") }}</label><UInput
            class="w-full"
            id="login-password"
            v-model="loginPassword"
            type="password"
            autocomplete="current-password"
            required
          />
          <div v-if="loginError" class="form-error" role="alert">
            {{ loginError }}
          </div>
          <UButton
            color="primary"
            variant="solid"
            class="primary full"
            type="submit"
            :disabled="loggingIn"
          >
            {{ loggingIn ? t("auth.loggingIn") : t("auth.login") }}
          </UButton>
        </form>
        <div class="login-foot">
          <LockKeyhole :size="13" /> {{ t("auth.private") }}
        </div>
      </div>
    </div>

    <UDashboardGroup
      v-else
      unit="px"
      storage="local"
      storage-key="folio-layout-v2"
      :class="{ 'has-draft': composeOpen && composeMinimized }"
      :inert="(smallScreen && composeOpen && !composeMinimized) || undefined"
    >
      <WorkspaceSidebar
        v-model:open="mobileNav"
        v-model:collapsed="compactNav"
        :page="page"
        :unread="store.stats.unread"
        :mailboxes="mailboxes"
        :mailbox-filter="store.mailboxFilter"
        @navigate="
          (id) => {
            if (id === 'inbox') clearFilters();
            navigate(id);
          }
        "
        @compose="startCompose()"
        @mailbox="openMailbox"
      />
      <main
        class="flex-1 min-w-0 flex flex-col overflow-hidden"
        :aria-label="currentTitle"
      >
        <div
          v-if="store.undoAction"
          role="status"
          class="flex items-center gap-3 px-4 py-2 border-b border-default bg-elevated text-sm"
        >
          <span class="flex-1">{{
            t(`ui.actions.${store.undoAction.label}`)
          }}</span>
          <UButton
            variant="link"
            :loading="store.updating"
            @click="store.undo()"
            >{{ t("ui.undo") }}</UButton
          >
          <UButton
            color="neutral"
            variant="ghost"
            icon="i-lucide-x"
            :aria-label="t('common.close')"
            @click="store.undoAction = null"
          />
        </div>
        <div v-if="store.error" class="error-banner" role="alert">
          {{ store.error
          }}<UButton
            color="error"
            variant="ghost"
            size="xs"
            @click="store.error = ''"
            >{{ t("common.close") }}</UButton
          >
        </div>
        <div
          v-if="isMailPage"
          class="mail-workspace flex flex-1 min-h-0"
          :class="{ 'has-selection': store.selected || store.opening }"
        >
          <MailList
            v-model:filters-open="filtersOpen"
            :title="currentTitle"
            :domains="domains"
            :mailboxes="filteredMailboxes"
            :has-filters="hasFilters"
            :refreshing="refreshing"
            @clear="clearFilters"
            @refresh="refresh"
            @paginate="changePage"
            @setup="navigate(domains.length ? 'mailboxes' : 'domains')"
            @compose="startCompose()"
          />
          <MailReader
            :email-document="emailDocument"
            :retrying="retrying"
            @compose="startCompose"
            @retry="store.selected && retry(store.selected)"
            @move="moveSelection"
          />
        </div>
        <template v-else>
          <UDashboardNavbar :title="currentTitle">
            <template #leading><UDashboardSidebarCollapse /></template>
            <template #right>
              <UButton
                v-if="page === 'domains'"
                icon="i-lucide-plus"
                @click="domainModal = true"
                >{{ t("domains.add") }}</UButton
              >
              <UButton
                v-else-if="page === 'mailboxes'"
                icon="i-lucide-plus"
                @click="domains.length ? addMailbox() : (domainModal = true)"
                >{{
                  t(domains.length ? "mailboxes.create" : "domains.add")
                }}</UButton
              >
              <UButton
                icon="i-lucide-refresh-cw"
                color="neutral"
                variant="ghost"
                :aria-label="t('common.refresh')"
                :loading="refreshing"
                @click="refresh"
              />
            </template>
          </UDashboardNavbar>
          <section v-if="page === 'domains'" class="management-page">
            <div
              v-if="!domains.length"
              class="mb-6 rounded-lg border border-default bg-elevated/40 px-4 py-3 text-sm text-muted leading-relaxed"
            >
              {{ t("ui.setupOverview") }}
            </div>
            <div class="domain-grid">
              <div v-for="d in domains" :key="d.id" class="domain-card">
                <div class="domain-card-top">
                  <div class="domain-icon"><Globe :size="18" /></div>
                  <span class="status" :class="d.status">{{
                    t(
                      d.receiving_enabled && d.sending_enabled
                        ? "ui.enabledBoth"
                        : d.receiving_enabled
                          ? "ui.enabledReceiving"
                          : d.sending_enabled
                            ? "ui.enabledSending"
                            : "domains.status.pending",
                    )
                  }}</span>
                </div>
                <h3>{{ d.name }}</h3>
                <UButton
                  color="neutral"
                  variant="ghost"
                  type="button"
                  class="domain-mailbox-link text-btn"
                  @click="addMailbox(d.id)"
                >
                  <Plus :size="14" />{{ t("mailboxes.create") }}
                </UButton>
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
                <div class="domain-card-actions">
                  <UButton
                    icon="i-lucide-settings-2"
                    color="primary"
                    variant="soft"
                    @click="setupDomainId = d.id"
                    >{{ t("ui.configureDomain") }}</UButton
                  >
                  <UButton
                    color="neutral"
                    variant="ghost"
                    icon="i-lucide-trash-2"
                    :aria-label="t('domains.delete') + ' ' + d.name"
                    :title="t('domains.delete')"
                    @click="removeItem('domains', d.id)"
                  />
                </div>
              </div>
            </div>
          </section>
          <section v-else-if="page === 'mailboxes'" class="management-page">
            <div class="table-card">
              <table v-if="mailboxes.length">
                <thead>
                  <tr>
                    <th>{{ t("nav.mailboxes") }}</th>
                    <th>{{ t("mailboxes.forwarding") }}</th>
                    <th>{{ t("common.status") }}</th>
                    <th>{{ t("common.actions") }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="m in mailboxes" :key="m.id">
                    <td>
                      <UButton
                        color="neutral"
                        variant="ghost"
                        type="button"
                        class="mailbox-cell"
                        @click="openMailbox(m)"
                        :title="t('ui.openMailbox')"
                      >
                        <AtSign :size="15" />
                        <div>
                          <b>{{ m.email }}</b><small v-if="m.display_name">{{
                            m.display_name
                          }}</small>
                        </div>
                      </UButton>
                    </td>

                    <td :data-label="t('mailboxes.forwarding')">
                      <UButton
                        color="neutral"
                        variant="link"
                        class="max-w-56"
                        :ui="{ label: 'truncate' }"
                        :label="
                          m.forward_enabled && m.forward_to
                            ? m.forward_to
                            : t('ui.configureForward')
                        "
                        :aria-label="
                          t('ui.configureForwardFor', { email: m.email })
                        "
                        :title="
                          m.forward_enabled && m.forward_to
                            ? m.forward_to
                            : undefined
                        "
                        @click="toggleForward(m)"
                      />
                    </td>

                    <td :data-label="t('common.status')">
                      <span
                        class="status"
                        :class="m.enabled ? 'active' : 'pending'"
                        >{{
                          m.enabled ? t("common.enabled") : t("common.disabled")
                        }}</span
                      >
                    </td>
                    <td>
                      <UButton
                        color="neutral"
                        variant="ghost"
                        type="button"
                        class="text-btn"
                        @click="toggleMailbox(m)"
                      >
                        {{
                          m.enabled ? t("common.disable") : t("common.enable")
                        }}</UButton><UButton
                        color="neutral"
                        variant="ghost"
                        type="button"
                        class="text-btn"
                        @click="removeItem('mailboxes', m.id)"
                      >
                        {{ t("common.delete") }}
                      </UButton>
                    </td>
                  </tr>
                </tbody>
              </table>
              <div v-if="!mailboxes.length" class="table-empty">
                <AtSign :size="28" /><b>{{
                  t(domains.length ? "mailboxes.empty" : "ui.addDomainFirst")
                }}</b>
              </div>
            </div>
          </section>
          <section v-else class="management-page">
            <div class="settings-grid">
              <div class="setting-card">
                <div class="setting-icon"><ShieldAlert :size="18" /></div>
                <h3>{{ t("settings.account") }}</h3>
                <p>{{ t("settings.accountHint") }}</p>
                <div class="account-actions">
                  <UButton
                    color="neutral"
                    variant="outline"
                    type="button"
                    class="secondary"
                    @click="settingsOpen = true"
                  >
                    {{ t("auth.changePassword") }}
                  </UButton>
                  <UButton
                    color="neutral"
                    variant="outline"
                    type="button"
                    class="secondary"
                    @click="logout"
                  >
                    <LogOut :size="15" />{{ t("auth.logout") }}
                  </UButton>
                </div>
              </div>
              <div class="setting-card">
                <h3>{{ t("settings.language") }}</h3>
                <p>{{ t("settings.languageHint") }}</p>
                <LanguageSelect :show-label="false" />
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
            </div>
            <h3 v-if="store.failures.length" class="failures-title">
              {{ t("settings.failures") }}
            </h3>
            <div v-if="!store.failures.length" class="py-3 text-sm text-muted">
              <div class="all-clear">
                <CheckCircle2 :size="22" /><span>{{
                  t("settings.noFailures")
                }}</span>
              </div>
            </div>
            <div
              v-for="failure in store.failures"
              :key="failure.id"
              class="setting-card failure-card"
            >
              <b>{{ failure.recipient }} · {{ fmt(failure.created_at) }}</b>
              <p>{{ failure.reason }}</p>
              <UButton
                color="neutral"
                variant="outline"
                type="button"
                v-if="
                  failure.raw_object_key &&
                  !failure.reason.startsWith('Forward failed')
                "
                class="secondary"
                @click="handleFailure(failure.id, 'replay')"
              >
                {{ t("settings.replay") }}</UButton><UButton
                color="neutral"
                variant="ghost"
                type="button"
                class="text-btn"
                @click="handleFailure(failure.id, 'dismiss')"
              >
                {{ t("settings.dismiss") }}
              </UButton>
            </div>
          </section>
        </template>
      </main>
    </UDashboardGroup>
    <div
      v-if="authenticated && composeOpen"
      class="compose-dock"
      :class="{ minimized: composeMinimized, expanded: composeExpanded }"
      :inert="dialogActive || (smallScreen && mobileNav) || undefined"
    >
      <div
        class="compose-window"
        role="dialog"
        :aria-modal="(smallScreen && !composeMinimized) || undefined"
        :aria-label="t('compose.title')"
      >
        <div class="compose-head">
          <UButton
            color="neutral"
            variant="ghost"
            type="button"
            v-if="composeMinimized"
            class="compose-heading"
            :aria-label="t('ui.restoreComposer')"
            @click="startCompose()"
          >
            <PenSquare :size="17" /><b>{{
              compose.subject || t("compose.title")
            }}</b>
          </UButton>
          <div v-else class="compose-heading">
            <PenSquare :size="17" /><b>{{
              compose.subject || t("compose.title")
            }}</b>
          </div>
          <div class="compose-controls">
            <UButton
              color="neutral"
              variant="ghost"
              square
              size="sm"
              type="button"
              v-if="!composeMinimized"
              class="icon-btn"
              :aria-label="
                t(
                  composeMinimized
                    ? 'ui.restoreComposer'
                    : 'ui.minimizeComposer',
                )
              "
              @click="composeMinimized = !composeMinimized"
            >
              <component
                :is="composeMinimized ? Maximize2 : Minus"
                :size="17" /></UButton
            ><UButton
              color="neutral"
              variant="ghost"
              square
              size="sm"
              type="button"
              v-if="!composeMinimized"
              class="icon-btn expand-composer"
              :aria-label="
                t(composeExpanded ? 'ui.shrinkComposer' : 'ui.expandComposer')
              "
              @click="
                composeExpanded = !composeExpanded;
                composeMinimized = false;
              "
            >
              <component
                :is="composeExpanded ? Minimize2 : Maximize2"
                :size="16" /></UButton
            ><UButton
              color="neutral"
              variant="ghost"
              square
              size="sm"
              type="button"
              class="icon-btn"
              :aria-label="t('compose.close')"
              :disabled="sending"
              @click="closeCompose"
            >
              <X :size="18" />
            </UButton>
          </div>
        </div>
        <div
          v-if="!compose.mailboxId || !store.resendConfigured"
          class="composer-notice"
        >
          <AlertCircle :size="17" /><span>{{
            !senders.length
              ? t("ui.noSender")
              : !compose.mailboxId
                ? t("ui.chooseIdentity")
                : t("ui.missingService")
          }}</span
          ><UButton
            color="neutral"
            variant="ghost"
            type="button"
            class="text-btn"
            @click="
              composeMinimized = true;
              navigate(
                !compose.mailboxId || !senders.length ? 'domains' : 'settings',
              );
            "
          >
            {{ t("ui.configure") }}
          </UButton>
        </div>
        <fieldset :disabled="sending || sendLocked" class="compose-fields">
          <div class="compose-field">
            <label for="sender">{{ t("compose.from") }}</label><USelect
              id="sender"
              v-model="compose.mailboxId"
              :items="
                senders.map((m) => ({
                  value: m.id,
                  label: m.display_name
                    ? m.display_name + ' (' + m.email + ')'
                    : m.email,
                }))
              "
              :placeholder="t('compose.chooseSender')"
              :disabled="sending || sendLocked"
              class="w-full"
            />
          </div>
          <div class="compose-field">
            <label for="to">{{ t("compose.to") }}</label><UInput
              class="w-full"
              id="to"
              v-model="compose.to"
              placeholder="recipient@example.com"
            />
            <div class="cc-links">
              <UButton
                color="neutral"
                variant="ghost"
                type="button"
                :aria-expanded="showCc"
                @click="showCc = !showCc"
              >
                {{ t("compose.cc")
                }}{{ !showCc && compose.cc.trim() ? " •" : "" }}</UButton
              ><UButton
                color="neutral"
                variant="ghost"
                type="button"
                :aria-expanded="showBcc"
                @click="showBcc = !showBcc"
              >
                {{ t("compose.bcc")
                }}{{ !showBcc && compose.bcc.trim() ? " •" : "" }}
              </UButton>
            </div>
          </div>
          <div v-if="showCc" class="compose-field">
            <label for="cc">{{ t("compose.cc") }}</label><UInput
              class="w-full"
              id="cc"
              v-model="compose.cc"
            />
          </div>
          <div v-if="showBcc" class="compose-field">
            <label for="bcc">{{ t("compose.bcc") }}</label><UInput
              class="w-full"
              id="bcc"
              v-model="compose.bcc"
            />
          </div>
          <div class="compose-field">
            <label for="subject">{{ t("compose.subject") }}</label><UInput
              class="w-full"
              id="subject"
              v-model="compose.subject"
              maxlength="998"
              :placeholder="t('compose.subjectPlaceholder')"
            />
          </div>
          <UTextarea
            :rows="9"
            :ui="{
              root: 'items-stretch',
              base: 'resize-none ring-0 focus-visible:ring-0 p-5',
            }"
            id="compose-body"
            v-model="compose.text"
            class="compose-body"
            :aria-label="t('mail.body')"
            :placeholder="t('compose.bodyPlaceholder')"
          ></UTextarea>
          <div class="compose-attachments">
            <p v-if="composeMode === 'forward'" class="text-xs text-muted mb-3">
              {{ t("ui.forwardBodyHint") }}
            </p>
            <label
              class="attach-label"
              tabindex="0"
              @keydown.enter.prevent="
                ($event.currentTarget as HTMLElement)
                  .querySelector('input')
                  ?.click()
              "
              @keydown.space.prevent="
                ($event.currentTarget as HTMLElement)
                  .querySelector('input')
                  ?.click()
              "
              ><Paperclip :size="17" />{{ t("compose.addAttachments")
              }}<input type="file" multiple hidden @change="addFiles"
            /></label>
            <div v-for="(a, index) in compose.attachments" :key="index">
              {{ a.filename
              }}<UButton
                color="neutral"
                variant="ghost"
                type="button"
                class="text-btn"
                @click="compose.attachments.splice(index, 1)"
              >
                {{ t("common.remove") }}
              </UButton>
            </div>
          </div>
        </fieldset>
        <div v-if="sendLocked && !sending" class="error-banner">
          {{ t("compose.locked") }}
        </div>
        <div class="compose-foot">
          <span>{{ t("ui.unsavedDraft") }}<small>⌘ / Ctrl + Enter</small></span
          ><UButton
            color="primary"
            variant="solid"
            type="button"
            class="primary"
            :disabled="sending || !compose.mailboxId || !store.resendConfigured"
            @click="send"
          >
            <Send :size="15" />{{
              sending
                ? t("compose.sending")
                : sendLocked
                  ? t("compose.retry")
                  : t("compose.send")
            }}
          </UButton>
        </div>
      </div>
    </div>
    <FormModal
      v-if="authenticated"
      :open="domainModal"
      :title="t('domains.add')"
      @update:open="domainModal = $event"
    >
      <form class="modal" @submit.prevent="createDomain">
        <label for="domain">{{ t("common.domain") }}</label><UInput
          class="w-full"
          id="domain"
          v-model="domainName"
          placeholder="example.com"
          required
        />
        <div class="modal-note">
          <AlertCircle :size="15" />{{ t("domains.setupHint") }}
        </div>
        <div class="modal-actions">
          <UButton
            color="primary"
            variant="solid"
            class="primary"
            type="submit"
            >{{ t("domains.add") }}</UButton
          >
        </div>
      </form>
    </FormModal>
    <FormModal
      v-if="authenticated"
      :open="mailboxModal"
      :title="t('mailboxes.createTitle')"
      @update:open="mailboxModal = $event"
    >
      <form class="modal" @submit.prevent="createMailbox">
        <label for="mailbox-domain">{{ t("mailboxes.domain") }}</label><USelect
          id="mailbox-domain"
          v-model="newMailbox.domainId"
          :items="domains.map((d) => ({ value: d.id, label: d.name }))"
          :placeholder="t('mailboxes.chooseDomain')"
          class="w-full"
          required
        /><label for="local-part">{{ t("mailboxes.localPart") }}</label
        ><UInput
          class="w-full"
          id="local-part"
          v-model="newMailbox.localPart"
          placeholder="hello"
          maxlength="64"
          required
        /><label for="display-name">{{ t("mailboxes.displayName") }}</label
        ><UInput
          class="w-full"
          id="display-name"
          v-model="newMailbox.displayName"
          maxlength="100"
        />
        <p
          v-if="newMailbox.localPart && newMailbox.domainId"
          class="mt-3 text-sm text-primary break-all"
        >
          {{ newMailbox.localPart.trim() }}@{{
            domains.find((d) => d.id === newMailbox.domainId)?.name
          }}
        </p>
        <div class="modal-actions">
          <UButton
            color="primary"
            variant="solid"
            class="primary"
            type="submit"
          >
            {{ t("mailboxes.create") }}
          </UButton>
        </div>
      </form>
    </FormModal>
    <DomainSetup
      v-if="authenticated"
      :domain="setupDomain"
      :busy="domainUpdating"
      @close="setupDomainId = ''"
      @toggle="(field) => setupDomain && updateDomain(setupDomain, field)"
      @mailbox="
        () => {
          const id = setupDomainId;
          setupDomainId = '';
          addMailbox(id, true);
        }
      "
    />
    <FormModal
      v-if="authenticated"
      :open="settingsOpen"
      :title="t('auth.changePassword')"
      @update:open="settingsOpen = $event"
    >
      <form class="modal" @submit.prevent="changePassword">
        <label for="current-password">{{
          t("auth.currentPassword")
        }}</label><UInput
          class="w-full"
          id="current-password"
          name="current"
          type="password"
          autocomplete="current-password"
          required
        /><label for="new-password">{{ t("auth.newPassword") }}</label
        ><UInput
          class="w-full"
          id="new-password"
          name="next"
          type="password"
          autocomplete="new-password"
          minlength="12"
          maxlength="256"
          required
        />
        <div class="modal-actions">
          <UButton
            color="primary"
            variant="solid"
            class="primary"
            type="submit"
          >
            {{ t("auth.savePassword") }}
          </UButton>
        </div>
      </form>
    </FormModal>
    <FormModal
      v-if="authenticated"
      :open="!!forwardingMailbox"
      :title="t('mailboxes.forwarding')"
      @update:open="!$event && (forwardingMailbox = null)"
    >
      <form class="modal" @submit.prevent="saveForward">
        <p>
          {{ t("mailboxes.forwardHint", { email: forwardingMailbox?.email }) }}
        </p>
        <label for="forward-to">{{ t("mailboxes.forwardTo") }}</label><UInput
          class="w-full"
          id="forward-to"
          v-model="forwardingTarget"
          type="email"
          placeholder="target@example.com"
        />
        <div class="modal-actions">
          <UButton
            color="neutral"
            variant="outline"
            class="secondary"
            type="button"
            @click="forwardingMailbox = null"
          >
            {{ t("common.cancel") }}</UButton><UButton
            color="primary"
            variant="solid"
            class="primary"
            type="submit"
          >
            {{ t("mailboxes.saveForward") }}
          </UButton>
        </div>
      </form>
    </FormModal>
    <FormModal
      :open="!!confirmation"
      :title="t('common.confirmTitle')"
      @update:open="!$event && answerConfirmation(false)"
    >
      <div class="modal">
        <p>{{ confirmation }}</p>
        <div class="modal-actions">
          <UButton
            color="neutral"
            variant="outline"
            type="button"
            class="secondary"
            @click="answerConfirmation(false)"
          >
            {{ t("common.cancel") }}</UButton><UButton
            color="primary"
            variant="solid"
            type="button"
            class="primary"
            @click="answerConfirmation(true)"
          >
            {{ t("common.confirm") }}
          </UButton>
        </div>
      </div>
    </FormModal>
    <Transition
      ><div v-if="toast" class="toast" role="status">
        {{ toast }}
      </div></Transition
    >
  </UApp>
</template>

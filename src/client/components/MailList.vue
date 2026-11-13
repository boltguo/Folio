<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import UDashboardPanel from "@nuxt/ui/components/DashboardPanel.vue";
import UDashboardNavbar from "@nuxt/ui/components/DashboardNavbar.vue";
import UDashboardSidebarCollapse from "@nuxt/ui/components/DashboardSidebarCollapse.vue";
import UButton from "@nuxt/ui/components/Button.vue";
import UBadge from "@nuxt/ui/components/Badge.vue";
import UInput from "@nuxt/ui/components/Input.vue";
import USelect from "@nuxt/ui/components/Select.vue";
import UTabs from "@nuxt/ui/components/Tabs.vue";
import USkeleton from "@nuxt/ui/components/Skeleton.vue";
import { Star, Paperclip, Inbox } from "lucide-vue-next";
import { useMailStore } from "../stores/mail";
import type { Domain, Mailbox } from "../../shared/types";
const props = defineProps<{
  title: string;
  domains: Domain[];
  mailboxes: Mailbox[];
  hasFilters: boolean;
  refreshing: boolean;
}>();
const emit = defineEmits<{
  clear: [];
  refresh: [];
  setup: [];
  compose: [];
  paginate: [direction: number];
}>();
const filtersOpen = defineModel<boolean>("filtersOpen");
const store = useMailStore();
const { t, te, locale } = useI18n();
const tabs = computed(() => [
  { label: t("ui.allMessages"), value: "all" },
  { label: t("common.unread"), value: "unread" },
]);
const tab = computed({
  get: () => (store.unreadOnly ? "unread" : "all"),
  set: (value) => {
    store.unreadOnly = value === "unread";
  },
});
const domainOptions = computed(() => [
  { label: t("mail.allDomains"), value: "__all__" },
  ...props.domains.map((d) => ({ label: d.name, value: d.id })),
]);
const mailboxOptions = computed(() => [
  { label: t("mail.allMailboxes"), value: "__all__" },
  ...props.mailboxes.map((m) => ({ label: m.email, value: m.id })),
]);
const scope = computed(
  () =>
    props.mailboxes.find((m) => m.id === store.mailboxFilter)?.email ||
    props.domains.find((d) => d.id === store.domainFilter)?.name ||
    "",
);
const domain = computed({
  get: () => store.domainFilter || "__all__",
  set: (value) => {
    store.domainFilter = value === "__all__" ? "" : value;
  },
});
const mailbox = computed({
  get: () => store.mailboxFilter || "__all__",
  set: (value) => {
    store.mailboxFilter = value === "__all__" ? "" : value;
  },
});
function date(timestamp: number) {
  const value = new Date(timestamp * 1000);
  return new Intl.DateTimeFormat(
    locale.value,
    value.toDateString() === new Date().toDateString()
      ? { hour: "2-digit", minute: "2-digit" }
      : { month: "short", day: "numeric" },
  ).format(value);
}
const status = (value: string) =>
  te(`status.${value}`) ? t(`status.${value}`) : value;
</script>
<template>
  <UDashboardPanel
    id="mail-list"
    :default-size="380"
    :min-size="330"
    :max-size="520"
    resizable
    class="mail-list-panel min-h-0"
    :ui="{ handle: 'hidden lg:block' }"
  >
    <UDashboardNavbar :title="title" :ui="{ title: 'text-base font-semibold' }">
      <template #leading><UDashboardSidebarCollapse /></template>
      <template #trailing
        ><UBadge :label="store.total" variant="subtle" size="sm"
      /></template>
      <template #right
        ><UButton
          class="lg:hidden"
          icon="i-lucide-square-pen"
          variant="ghost"
          :aria-label="t('nav.compose')"
          @click="emit('compose')" /><UButton
          icon="i-lucide-refresh-cw"
          color="neutral"
          variant="ghost"
          :loading="refreshing"
          :aria-label="t('common.refresh')"
          :title="t('common.refresh')"
          @click="emit('refresh')"
      /></template>
    </UDashboardNavbar>
    <div class="p-4 space-y-3 border-b border-default shrink-0">
      <div class="flex items-center gap-2">
        <UInput
          id="mail-search"
          v-model="store.query"
          icon="i-lucide-search"
          class="flex-1"
          :placeholder="t('mail.searchPlaceholder')"
          :aria-label="t('mail.search')"
          maxlength="200"
          :ui="{ trailing: 'pe-1' }"
        >
          <template #trailing
            ><UButton
              v-if="store.query"
              icon="i-lucide-x"
              color="neutral"
              variant="link"
              size="xs"
              :aria-label="t('ui.clearSearch')"
              @click="store.query = ''"
            /><kbd
              v-else
              class="text-[10px] border border-default rounded px-1 text-dimmed"
              >/</kbd
            ></template
          >
        </UInput>
        <UButton
          icon="i-lucide-sliders-horizontal"
          :color="
            filtersOpen || store.domainFilter || store.mailboxFilter
              ? 'primary'
              : 'neutral'
          "
          variant="ghost"
          :aria-label="t('ui.filters')"
          :aria-expanded="!!filtersOpen"
          @click="filtersOpen = !filtersOpen"
        />
      </div>
      <UTabs
        v-model="tab"
        :items="tabs"
        :content="false"
        size="sm"
        class="w-full"
        :aria-label="t('ui.messageFilter')"
      />
      <div
        v-if="scope && !filtersOpen"
        class="flex items-center gap-2 text-xs text-muted"
      >
        <span class="shrink-0">{{ t("ui.currentScope") }}</span>
        <UBadge
          class="min-w-0"
          :ui="{ base: 'truncate' }"
          variant="subtle"
          color="neutral"
          >{{ scope }}</UBadge
        >
      </div>
      <div v-if="filtersOpen" class="space-y-2">
        <USelect
          v-model="domain"
          :items="domainOptions"
          class="w-full"
          :aria-label="t('mail.filterDomain')"
        />
        <USelect
          v-model="mailbox"
          :items="mailboxOptions"
          class="w-full"
          :aria-label="t('mail.filterMailbox')"
        />
      </div>
      <UButton
        v-if="store.domainFilter || store.mailboxFilter"
        color="neutral"
        variant="link"
        size="xs"
        icon="i-lucide-filter-x"
        :label="t('ui.clearFilters')"
        @click="emit('clear')"
      />
    </div>
    <div
      v-if="store.loading && !store.messages.length"
      class="flex-1 p-5 space-y-7"
      role="status"
      :aria-label="t('mail.loading')"
    >
      <div v-for="i in 5" :key="i" class="space-y-3">
        <USkeleton class="h-4 w-2/3" /><USkeleton
          class="h-3 w-full"
        /><USkeleton class="h-3 w-4/5" />
      </div>
    </div>
    <div
      v-else-if="store.messages.length"
      class="message-list flex-1 min-h-0 overflow-y-auto"
      :aria-busy="store.loading"
    >
      <div
        v-for="m in store.messages"
        :key="m.id"
        class="mail-row relative border-b border-default border-l-2 transition-colors"
        :class="
          store.selected?.id === m.id
            ? 'border-l-primary bg-primary/8'
            : 'border-l-transparent hover:bg-elevated/60'
        "
      >
        <button
          class="block w-full text-left pl-5 pr-10 py-4 outline-offset-[-3px]"
          :aria-current="store.selected?.id === m.id ? 'true' : undefined"
          @click="store.open(m.id)"
        >
          <div class="flex items-center gap-2 mb-1.5">
            <b
              class="truncate text-[13px] text-highlighted"
              :class="m.is_read ? 'font-medium' : 'font-semibold'"
              >{{
                m.direction === "outbound"
                  ? t("mail.sentTo", { recipients: m.to_addresses.join(", ") })
                  : m.from_name || m.from_address
              }}</b><span
              v-if="!m.is_read"
              class="size-1.5 rounded-full bg-primary shrink-0"
            /><time class="ml-auto shrink-0 text-[11px] text-muted">{{
              date(m.received_at)
            }}</time>
          </div>
          <p
            class="truncate text-[13px] text-toned"
            :class="{ 'font-semibold text-highlighted': !m.is_read }"
          >
            {{ m.subject }}
          </p>
          <p
            v-if="m.snippet"
            class="line-clamp-2 text-xs text-dimmed leading-relaxed mt-1.5"
          >
            {{ m.snippet }}
          </p>
          <div
            v-if="
              !store.mailboxFilter ||
              m.has_attachments ||
              m.direction === 'outbound'
            "
            class="flex items-center gap-2 mt-3"
          >
            <UBadge
              v-if="!store.mailboxFilter"
              color="neutral"
              variant="subtle"
              size="sm"
              class="max-w-full font-normal"
              :ui="{ base: 'truncate' }"
              >{{
                m.mailbox_email || t("mail.removedMailbox")
              }}</UBadge><Paperclip
              v-if="m.has_attachments"
              class="size-3 text-dimmed shrink-0"
            /><UBadge
              v-if="m.direction === 'outbound'"
              :color="
                ['failed', 'unknown', 'bounced'].includes(m.status)
                  ? 'error'
                  : 'neutral'
              "
              variant="soft"
              size="sm"
              >{{ status(m.status) }}</UBadge
            >
          </div>
        </button>
        <UButton
          color="neutral"
          variant="ghost"
          size="xs"
          class="absolute right-3 bottom-3"
          :class="{ 'text-amber-600': m.is_starred }"
          :aria-label="m.is_starred ? t('mail.removeStar') : t('mail.addStar')"
          :aria-pressed="!!m.is_starred"
          :disabled="store.updating"
          @click="store.toggleStar(m)"
          ><Star
            class="size-3.5"
            :fill="m.is_starred ? 'currentColor' : 'none'"
        /></UButton>
      </div>
    </div>
    <div
      v-else
      class="flex-1 flex flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <Inbox class="size-9 text-dimmed" /><b class="text-sm font-medium">{{
        t("mail.empty")
      }}</b>
      <p class="text-xs text-muted leading-relaxed">
        {{
          hasFilters
            ? t("ui.emptyFiltered")
            : t(`ui.emptyFolders.${store.folder}`)
        }}
      </p>
      <UButton
        v-if="hasFilters"
        color="neutral"
        variant="outline"
        size="sm"
        @click="emit('clear')"
        >{{ t("ui.clearFilters") }}</UButton><UButton
        v-else-if="!mailboxes.length"
        variant="outline"
        size="sm"
        @click="emit('setup')"
        >{{ t("ui.setupMailbox") }}</UButton
      ><UButton
        v-else-if="store.folder === 'sent'"
        size="sm"
        @click="emit('compose')"
        >{{ t("nav.compose") }}</UButton
      >
    </div>
    <footer
      v-if="store.total > store.limit || store.offset > 0"
      class="flex items-center justify-between gap-2 border-t border-default px-4 py-2 shrink-0"
    >
      <span class="text-[10px] text-dimmed">{{
        t("mail.pagination", {
          total: t("mail.messageCount", store.total),
          page: Math.floor(store.offset / store.limit) + 1,
        })
      }}</span>
      <div class="flex gap-1">
        <UButton
          icon="i-lucide-chevron-left"
          color="neutral"
          variant="ghost"
          size="xs"
          :aria-label="t('mail.previous')"
          :disabled="store.loading || store.offset === 0"
          @click="emit('paginate', -1)"
        /><UButton
          icon="i-lucide-chevron-right"
          color="neutral"
          variant="ghost"
          size="xs"
          :aria-label="t('mail.next')"
          :disabled="store.loading || store.offset + store.limit >= store.total"
          @click="emit('paginate', 1)"
        />
      </div>
    </footer>
  </UDashboardPanel>
</template>

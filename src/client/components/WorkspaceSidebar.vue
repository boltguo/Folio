<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import UDashboardSidebar from "@nuxt/ui/components/DashboardSidebar.vue";
import UButton from "@nuxt/ui/components/Button.vue";
import UNavigationMenu from "@nuxt/ui/components/NavigationMenu.vue";
import UTooltip from "@nuxt/ui/components/Tooltip.vue";
import type { Mailbox } from "../../shared/types";
const props = defineProps<{
  page: string;
  unread: number;
  mailboxes: Mailbox[];
  mailboxFilter: string;
}>();
const emit = defineEmits<{
  navigate: [page: string];
  compose: [];
  mailbox: [mailbox: Mailbox];
}>();
const open = defineModel<boolean>("open");
const collapsed = defineModel<boolean>("collapsed");
const { t } = useI18n();
const items = computed(() =>
  [
    [
      {
        label: t("nav.inbox"),
        icon: "i-lucide-inbox",
        id: "inbox",
        badge: props.unread || undefined,
      },
      { label: t("nav.sent"), icon: "i-lucide-send", id: "sent" },
      { label: t("nav.starred"), icon: "i-lucide-star", id: "starred" },
      { label: t("nav.archive"), icon: "i-lucide-archive", id: "archive" },
      { label: t("nav.trash"), icon: "i-lucide-trash-2", id: "trash" },
    ],
    [
      {
        label: t("nav.domains"),
        icon: "i-lucide-globe",
        id: "domains",
      },
      {
        label: t("nav.mailboxes"),
        icon: "i-lucide-at-sign",
        id: "mailboxes",
      },
    ],
  ].map((group) =>
    group.map((item) => ({
      ...item,
      active:
        props.page === item.id && !(item.id === "inbox" && props.mailboxFilter),
      onSelect: () => emit("navigate", item.id),
    })),
  ),
);
</script>
<template>
  <UDashboardSidebar
    id="navigation"
    v-model:open="open"
    v-model:collapsed="collapsed"
    collapsible
    :default-size="232"
    :min-size="200"
    :max-size="300"
    :collapsed-size="68"
    :toggle="false"
    :menu="{ title: t('app.workspace'), description: t('app.tagline') }"
    class="bg-elevated/25"
    :ui="{
      header: 'border-b border-default px-4',
      body: 'gap-4 px-3 py-4',
      footer: 'border-t border-default p-3',
    }"
  >
    <template #header="{ collapsed: narrow }">
      <div class="flex items-center gap-2.5 min-w-0 flex-1">
        <img src="/folio.svg" alt="" class="size-8 shrink-0" />
        <span
          v-if="!narrow"
          class="font-semibold text-lg tracking-tight text-highlighted"
          >Folio</span
        >
      </div>
      <UButton
        v-if="!narrow"
        class="lg:hidden"
        icon="i-lucide-x"
        color="neutral"
        variant="ghost"
        :aria-label="t('common.close')"
        @click="open = false"
      />
    </template>
    <template #default="{ collapsed: narrow }">
      <UTooltip :text="t('nav.compose')" :disabled="!narrow">
        <UButton
          icon="i-lucide-square-pen"
          :label="narrow ? undefined : t('nav.compose')"
          :block="!narrow"
          :square="narrow"
          :aria-label="t('nav.compose')"
          class="justify-center"
          @click="emit('compose')"
        />
      </UTooltip>
      <UNavigationMenu
        :items="items"
        :collapsed="narrow"
        orientation="vertical"
        tooltip
        :ui="{ link: 'py-2', list: 'space-y-1', separator: 'my-3' }"
      />
      <div
        v-if="!narrow && mailboxes.length"
        class="min-h-0 flex-1 overflow-y-auto space-y-1"
      >
        <p class="px-2 pt-2 pb-2 text-xs font-medium text-dimmed">
          {{ t("mail.allMailboxes") }}
        </p>
        <UButton
          v-for="m in mailboxes"
          :key="m.id"
          :label="m.email"
          icon="i-lucide-mail"
          color="neutral"
          :variant="
            page === 'inbox' && mailboxFilter === m.id ? 'soft' : 'ghost'
          "
          class="w-full justify-start text-xs font-normal"
          :ui="{ label: 'truncate', leadingIcon: 'size-3.5 text-dimmed' }"
          :title="m.email"
          @click="emit('mailbox', m)"
        />
      </div>
    </template>
    <template #footer="{ collapsed: narrow }">
      <div class="w-full">
        <UButton
          icon="i-lucide-settings-2"
          color="neutral"
          :variant="page === 'settings' ? 'soft' : 'ghost'"
          :label="narrow ? undefined : t('nav.settings')"
          :aria-label="t('nav.settings')"
          class="w-full"
          @click="emit('navigate', 'settings')"
        />
      </div>
    </template>
  </UDashboardSidebar>
</template>

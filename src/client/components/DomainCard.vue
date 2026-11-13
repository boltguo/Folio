<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import UCard from "@nuxt/ui/components/Card.vue";
import UBadge from "@nuxt/ui/components/Badge.vue";
import UButton from "@nuxt/ui/components/Button.vue";
import UTooltip from "@nuxt/ui/components/Tooltip.vue";
import { Globe } from "lucide-vue-next";
import type { Domain } from "../../shared/types";
const props = defineProps<{ domain: Domain }>();
const emit = defineEmits<{ configure: []; mailbox: []; remove: [] }>();
const { t } = useI18n();
const status = computed(() =>
  props.domain.receiving_enabled && props.domain.sending_enabled
    ? "ui.enabledBoth"
    : props.domain.receiving_enabled
      ? "ui.enabledReceiving"
      : props.domain.sending_enabled
        ? "ui.enabledSending"
        : "domains.status.pending",
);
</script>

<template>
  <UCard
    as="article"
    variant="outline"
    :ui="{
      root: 'overflow-hidden',
      body: 'p-4 sm:p-5',
      footer: 'p-3 sm:px-5 sm:py-3',
    }"
  >
    <div class="flex items-start gap-3">
      <div
        class="size-9 shrink-0 rounded-lg bg-elevated flex items-center justify-center text-muted"
      >
        <Globe class="size-4" />
      </div>
      <div class="min-w-0">
        <h2 class="text-base font-semibold leading-6 break-all">
          {{ domain.name }}
        </h2>
        <UBadge
          :color="
            domain.receiving_enabled || domain.sending_enabled
              ? 'success'
              : 'neutral'
          "
          variant="subtle"
          size="sm"
          class="mt-1.5 font-normal"
          >{{ t(status) }}</UBadge
        >
      </div>
    </div>
    <dl class="grid grid-cols-2 gap-4 mt-5">
      <div>
        <dt class="text-xs text-muted">{{ t("nav.mailboxes") }}</dt>
        <dd class="mt-1 text-xl font-medium tabular-nums text-highlighted">
          {{ domain.mailbox_count }}
        </dd>
      </div>
      <div>
        <dt class="text-xs text-muted">{{ t("domains.received") }}</dt>
        <dd class="mt-1 text-xl font-medium tabular-nums text-highlighted">
          {{ domain.inbound_count }}
        </dd>
      </div>
    </dl>
    <template #footer>
      <div class="flex items-center gap-2">
        <UButton
          icon="i-lucide-settings-2"
          size="sm"
          variant="soft"
          class="h-8 rounded-md"
          :ui="{ leadingIcon: 'size-4' }"
          @click="emit('configure')"
          >{{ t("ui.configureDomain") }}</UButton
        >
        <UButton
          size="sm"
          color="neutral"
          variant="outline"
          class="h-8 rounded-md"
          @click="emit('mailbox')"
          >{{ t("mailboxes.create") }}</UButton
        >
        <UTooltip :text="t('domains.delete')">
          <UButton
            icon="i-lucide-trash-2"
            square
            size="sm"
            color="neutral"
            variant="ghost"
            class="ml-auto size-8 rounded-md hover:text-error"
            :ui="{ leadingIcon: 'size-4' }"
            :aria-label="t('domains.delete') + ' ' + domain.name"
            @click="emit('remove')"
          />
        </UTooltip>
      </div>
    </template>
  </UCard>
</template>

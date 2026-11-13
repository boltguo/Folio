<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import UBadge from "@nuxt/ui/components/Badge.vue";
import UButton from "@nuxt/ui/components/Button.vue";
import type { MessageDetail } from "../../shared/types";

const props = defineProps<{ message: MessageDetail; retrying: boolean }>();
defineEmits<{ retry: [] }>();
const { t, te } = useI18n();
const status = (value: string) =>
  te(`status.${value}`) ? t(`status.${value}`) : value;
const failed = (value: string) =>
  ["failed", "unknown", "bounced", "suppressed", "partial_failed"].includes(
    value,
  );
const canRetry = computed(
  () =>
    !props.message.provider_message_id &&
    props.message.send_retryable !== false &&
    ["pending", "unknown", "failed"].includes(props.message.status),
);
</script>

<template>
  <section
    class="mb-5 p-3 rounded-lg bg-elevated text-xs space-y-3"
    :aria-label="t('mail.deliveryStatus')"
  >
    <UBadge
      :color="failed(message.status) ? 'error' : 'neutral'"
      variant="soft"
    >
      {{ status(message.status) }}
    </UBadge>
    <p v-if="message.send_error" class="break-words">
      {{ message.send_error }}
    </p>
    <p v-if="message.send_can_edit" class="text-muted">
      {{ t("mail.sendRejectedEdit") }}
    </p>
    <ul v-if="message.deliveries?.length" class="space-y-2">
      <li
        v-for="recipient in message.deliveries"
        :key="recipient.address"
        class="space-y-1"
      >
        <div class="flex flex-wrap items-center gap-2">
          <span class="break-all">{{ recipient.address }}</span>
          <span v-if="recipient.recipient_type !== 'to'" class="text-dimmed">
            {{ t(`compose.${recipient.recipient_type}`) }}
          </span>
          <UBadge
            :color="failed(recipient.status) ? 'error' : 'neutral'"
            variant="soft"
            size="sm"
          >
            {{ status(recipient.status) }}
          </UBadge>
          <UBadge
            v-if="recipient.complained_at !== null"
            color="warning"
            variant="soft"
            size="sm"
          >
            {{ t("mail.deliveryComplaint") }}
          </UBadge>
        </div>
        <p
          v-if="recipient.error_message || recipient.error_code"
          class="text-muted break-words"
        >
          {{ recipient.error_message || recipient.error_code }}
        </p>
      </li>
    </ul>
    <UButton
      v-if="canRetry"
      color="neutral"
      variant="outline"
      size="sm"
      :loading="retrying"
      @click="$emit('retry')"
    >
      {{ retrying ? t("mail.confirming") : t("mail.retry") }}
    </UButton>
  </section>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n";
import UModal from "@nuxt/ui/components/Modal.vue";
import UButton from "@nuxt/ui/components/Button.vue";
import UBadge from "@nuxt/ui/components/Badge.vue";
import type { Domain } from "../../shared/types";
defineProps<{ domain?: Domain; busy: boolean }>();
const emit = defineEmits<{
  close: [];
  mailbox: [];
  toggle: [field: "receiving_enabled" | "sending_enabled"];
}>();
const { t } = useI18n();
</script>

<template>
  <UModal
    :open="!!domain"
    :title="domain?.name || t('ui.configureDomain')"
    :description="t('ui.manualConfiguration')"
    :ui="{ content: 'max-w-2xl' }"
    @update:open="!$event && emit('close')"
  >
    <template #body>
      <div v-if="domain" class="space-y-5">
        <section class="rounded-lg border border-default p-4 space-y-3">
          <div class="flex justify-between gap-3 items-center">
            <h3 class="text-sm font-semibold">1. {{ t("nav.mailboxes") }}</h3>
            <UBadge color="neutral" variant="subtle">{{
              domain.mailbox_count
            }}</UBadge>
          </div>
          <p
            v-if="!domain.mailbox_count"
            class="text-sm text-muted leading-relaxed"
          >
            {{ t("ui.setupAddress") }}
          </p>
          <UButton
            color="neutral"
            variant="outline"
            icon="i-lucide-plus"
            @click="emit('mailbox')"
            >{{ t("mailboxes.create") }}</UButton
          >
        </section>
        <section class="rounded-lg border border-default p-4 space-y-3">
          <div class="flex justify-between gap-3 items-center">
            <h3 class="text-sm font-semibold">2. {{ t("ui.stepRouting") }}</h3>
            <UBadge
              :color="domain?.receiving_enabled ? 'success' : 'neutral'"
              variant="subtle"
              >{{
                t(domain?.receiving_enabled ? "common.enabled" : "common.off")
              }}</UBadge
            >
          </div>
          <details
            :open="!domain?.receiving_enabled"
            class="text-sm text-muted leading-relaxed"
          >
            <summary class="cursor-pointer">
              {{ t("ui.setupInstructions") }}
            </summary>
            <p class="mt-2">
              {{ t("ui.setupReceiving") }}
            </p>
          </details>
          <div class="flex flex-wrap gap-2">
            <UButton
              to="https://dash.cloudflare.com/"
              target="_blank"
              color="neutral"
              variant="outline"
              trailing-icon="i-lucide-external-link"
              >Cloudflare</UButton
            >
            <UButton
              :color="domain?.receiving_enabled ? 'neutral' : 'primary'"
              :variant="domain?.receiving_enabled ? 'ghost' : 'solid'"
              :loading="busy"
              @click="emit('toggle', 'receiving_enabled')"
              >{{
                t(
                  domain?.receiving_enabled
                    ? "domains.disableReceiving"
                    : "ui.confirmReceiving",
                )
              }}</UButton
            >
          </div>
        </section>
        <section class="rounded-lg border border-default p-4 space-y-3">
          <div class="flex justify-between gap-3 items-center">
            <h3 class="text-sm font-semibold">
              3. {{ t("ui.stepSending") }}
              <span class="font-normal text-muted">{{ t("ui.optional") }}</span>
            </h3>
            <UBadge
              :color="domain?.sending_enabled ? 'success' : 'neutral'"
              variant="subtle"
              >{{
                t(domain?.sending_enabled ? "common.enabled" : "common.off")
              }}</UBadge
            >
          </div>
          <details
            :open="!domain?.sending_enabled"
            class="text-sm text-muted leading-relaxed"
          >
            <summary class="cursor-pointer">
              {{ t("ui.setupInstructions") }}
            </summary>
            <p class="mt-2">
              {{ t("ui.setupSending") }}
            </p>
          </details>
          <div class="flex flex-wrap gap-2">
            <UButton
              to="https://resend.com/domains"
              target="_blank"
              color="neutral"
              variant="outline"
              trailing-icon="i-lucide-external-link"
              >Resend</UButton
            >
            <UButton
              :color="domain?.sending_enabled ? 'neutral' : 'primary'"
              :variant="domain?.sending_enabled ? 'ghost' : 'solid'"
              :loading="busy"
              @click="emit('toggle', 'sending_enabled')"
              >{{
                t(
                  domain?.sending_enabled
                    ? "domains.disableSending"
                    : "ui.confirmSending",
                )
              }}</UButton
            >
          </div>
        </section>
        <p class="text-xs leading-relaxed text-muted">
          {{ t("ui.testDelivery") }}
        </p>
      </div>
    </template>
  </UModal>
</template>

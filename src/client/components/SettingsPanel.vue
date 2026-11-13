<script setup lang="ts">
import { useI18n } from "vue-i18n";
import UCard from "@nuxt/ui/components/Card.vue";
import UButton from "@nuxt/ui/components/Button.vue";
import UBadge from "@nuxt/ui/components/Badge.vue";
import {
  Languages,
  ShieldCheck,
  Send,
  Inbox,
  CircleCheck,
} from "lucide-vue-next";
import LanguageSelect from "./LanguageSelect.vue";
import { useMailStore } from "../stores/mail";
const emit = defineEmits<{
  password: [];
  logout: [];
  failure: [id: string, action: "replay" | "dismiss"];
}>();
const store = useMailStore();
const { t, locale } = useI18n();
const cardUi = { header: "px-5 py-4", body: "p-5" };
const date = (value: number) =>
  new Intl.DateTimeFormat(locale.value, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value * 1000));
</script>

<template>
  <div class="max-w-5xl space-y-5">
    <div class="grid sm:grid-cols-2 gap-5">
      <UCard :ui="cardUi">
        <template #header
          ><div class="flex items-center gap-2.5">
            <Languages class="size-4 text-muted" />
            <h2 class="text-sm font-semibold">{{ t("settings.language") }}</h2>
          </div></template
        >
        <p class="text-sm leading-6 text-muted min-h-12">
          {{ t("settings.languageHint") }}
        </p>
        <div class="mt-4"><LanguageSelect :show-label="false" /></div>
      </UCard>
      <UCard :ui="cardUi">
        <template #header
          ><div class="flex items-center gap-2.5">
            <ShieldCheck class="size-4 text-muted" />
            <h2 class="text-sm font-semibold">{{ t("settings.account") }}</h2>
          </div></template
        >
        <p class="text-sm leading-6 text-muted min-h-12">
          {{ t("settings.accountHint") }}
        </p>
        <div class="mt-4 flex flex-wrap gap-2">
          <UButton
            color="neutral"
            variant="outline"
            icon="i-lucide-key-round"
            :ui="{ leadingIcon: 'size-4' }"
            @click="emit('password')"
            >{{ t("auth.changePassword") }}</UButton
          >
          <UButton
            color="neutral"
            variant="ghost"
            icon="i-lucide-log-out"
            :ui="{ leadingIcon: 'size-4' }"
            @click="emit('logout')"
            >{{ t("auth.logout") }}</UButton
          >
        </div>
      </UCard>
    </div>
    <UCard :ui="{ ...cardUi, body: 'p-0 sm:p-0', footer: 'px-5 py-3' }">
      <template #header
        ><div class="flex items-center gap-2.5">
          <Send class="size-4 text-muted" />
          <h2 class="text-sm font-semibold">{{ t("settings.sending") }}</h2>
        </div></template
      >
      <dl class="divide-y divide-default">
        <div class="flex items-center justify-between gap-4 px-5 py-4">
          <dt>
            <span class="block text-sm font-medium">{{
              t("ui.sendService")
            }}</span
            ><span class="block text-xs text-muted mt-1">Resend API</span>
          </dt>
          <dd>
            <UBadge
              :color="store.resendConfigured ? 'success' : 'warning'"
              variant="subtle"
              >{{
                t(
                  store.resendConfigured
                    ? "common.configured"
                    : "common.notConfigured",
                )
              }}</UBadge
            >
          </dd>
        </div>
        <div class="flex items-center justify-between gap-4 px-5 py-4">
          <dt>
            <span class="block text-sm font-medium">{{
              t("ui.deliveryUpdates")
            }}</span
            ><span class="block text-xs text-muted mt-1">Webhook</span>
          </dt>
          <dd>
            <UBadge
              :color="store.webhookConfigured ? 'success' : 'warning'"
              variant="subtle"
              >{{
                t(
                  store.webhookConfigured
                    ? "common.configured"
                    : "common.notConfigured",
                )
              }}</UBadge
            >
          </dd>
        </div>
      </dl>
      <template #footer
        ><p class="text-xs text-muted leading-5">
          {{ t("settings.configHint") }}
        </p></template
      >
    </UCard>
    <UCard :ui="{ ...cardUi, body: 'p-0 sm:p-0' }">
      <template #header
        ><div class="flex items-center gap-2.5">
          <Inbox class="size-4 text-muted" />
          <h2 class="text-sm font-semibold">{{ t("ui.inboundIssues") }}</h2>
          <UBadge
            v-if="store.failures.length"
            color="warning"
            variant="subtle"
            size="sm"
            >{{ store.failures.length }}</UBadge
          >
        </div></template
      >
      <div
        v-if="!store.failures.length"
        class="px-5 py-5 flex items-center gap-2.5 text-sm text-muted"
      >
        <CircleCheck class="size-4 text-success shrink-0" />{{
          t("settings.noFailures")
        }}
      </div>
      <div v-else class="divide-y divide-default">
        <p class="px-5 py-3 text-xs text-muted">{{ t("settings.failures") }}</p>
        <div
          v-for="failure in store.failures"
          :key="failure.id"
          class="p-5 space-y-3"
        >
          <div class="flex flex-wrap items-center justify-between gap-2">
            <b class="text-sm font-medium break-all">{{ failure.recipient }}</b
            ><time class="text-xs text-muted">{{
              date(failure.created_at)
            }}</time>
          </div>
          <p class="text-sm text-muted break-words">{{ failure.reason }}</p>
          <div class="flex flex-wrap gap-2">
            <UButton
              v-if="
                failure.raw_object_key &&
                !failure.reason.startsWith('Forward failed')
              "
              size="sm"
              color="neutral"
              variant="outline"
              @click="emit('failure', failure.id, 'replay')"
              >{{ t("settings.replay") }}</UButton
            ><UButton
              size="sm"
              color="neutral"
              variant="ghost"
              @click="emit('failure', failure.id, 'dismiss')"
              >{{ t("settings.dismiss") }}</UButton
            >
          </div>
        </div>
      </div>
    </UCard>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import UDashboardPanel from "@nuxt/ui/components/DashboardPanel.vue";
import UButton from "@nuxt/ui/components/Button.vue";
import UAvatar from "@nuxt/ui/components/Avatar.vue";
import UBadge from "@nuxt/ui/components/Badge.vue";
import UTooltip from "@nuxt/ui/components/Tooltip.vue";
import USkeleton from "@nuxt/ui/components/Skeleton.vue";
import MailReaderSkeleton from "./MailReaderSkeleton.vue";
import DeliveryStatus from "./DeliveryStatus.vue";
import { Star, Paperclip, Inbox, Download } from "lucide-vue-next";
import { useMailStore } from "../stores/mail";
defineProps<{ emailDocument: string; retrying: boolean }>();
const emit = defineEmits<{
  compose: [mode: string];
  retry: [];
  move: [direction: number];
}>();
const store = useMailStore();
const { t, locale } = useI18n();
const message = computed(() => store.selected);
const index = computed(() =>
  store.messages.findIndex((m) => m.id === message.value?.id),
);
const date = (time: number) =>
  new Intl.DateTimeFormat(locale.value, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(time * 1000));
const size = (bytes: number) =>
  new Intl.NumberFormat(locale.value, { maximumFractionDigits: 1 }).format(
    bytes / 1024,
  );
</script>
<template>
  <UDashboardPanel id="mail-reader" class="mail-reader-panel min-h-0">
    <template v-if="message">
      <header
        class="flex items-center gap-1 px-3 lg:px-4 h-16 border-b border-default shrink-0"
      >
        <UButton
          size="sm"
          square
          :ui="{ base: 'size-8 justify-center', leadingIcon: 'size-4' }"
          class="lg:hidden"
          icon="i-lucide-arrow-left"
          color="neutral"
          variant="ghost"
          :aria-label="t('mail.back')"
          @click="store.clearSelection()"
        />
        <span class="text-xs text-muted ml-1 mr-auto"
          ><template v-if="store.messages.length > 1"
            >{{ index + 1 }} / {{ store.messages.length }}</template
          ></span
        >
        <UTooltip :text="t('mail.toggleStar')"
          ><UButton
            size="sm"
            square
            :ui="{ base: 'size-8 justify-center', leadingIcon: 'size-4' }"
            color="neutral"
            variant="ghost"
            :aria-label="t('mail.toggleStar')"
            :disabled="store.updating || store.opening"
            @click="store.toggleStar(message)"
            ><Star
              class="size-4"
              :class="{ 'text-amber-600': message.is_starred }"
              :fill="message.is_starred ? 'currentColor' : 'none'" /></UButton
        ></UTooltip>
        <UTooltip
          v-if="!message.is_deleted"
          :text="message.is_archived ? t('mail.unarchive') : t('nav.archive')"
          ><UButton
            size="sm"
            square
            :ui="{ base: 'size-8 justify-center', leadingIcon: 'size-4' }"
            icon="i-lucide-archive"
            :disabled="store.updating || store.opening || !!message.is_deleted"
            color="neutral"
            variant="ghost"
            :aria-label="
              message.is_archived ? t('mail.unarchive') : t('nav.archive')
            "
            @click="store.archive(message)"
        /></UTooltip>
        <UTooltip
          :text="message.is_deleted ? t('mail.restore') : t('mail.moveToTrash')"
          ><UButton
            size="sm"
            square
            :ui="{ base: 'size-8 justify-center', leadingIcon: 'size-4' }"
            :icon="
              message.is_deleted
                ? 'i-lucide-archive-restore'
                : 'i-lucide-trash-2'
            "
            :disabled="store.updating || store.opening"
            color="neutral"
            variant="ghost"
            :aria-label="
              message.is_deleted ? t('mail.restore') : t('mail.moveToTrash')
            "
            @click="store.trash(message)"
        /></UTooltip>
        <UTooltip
          :text="message.is_read ? t('mail.markUnread') : t('mail.markRead')"
          ><UButton
            size="sm"
            square
            :ui="{ base: 'size-8 justify-center', leadingIcon: 'size-4' }"
            icon="i-lucide-mail"
            :disabled="store.updating || store.opening"
            color="neutral"
            variant="ghost"
            :aria-label="
              message.is_read ? t('mail.markUnread') : t('mail.markRead')
            "
            @click="store.update(message, { isRead: !message.is_read })"
        /></UTooltip>
        <span
          v-if="store.messages.length > 1"
          class="h-5 border-l border-default mx-1"
        />
        <UButton
          size="sm"
          square
          :ui="{ base: 'size-8 justify-center', leadingIcon: 'size-4' }"
          v-if="store.messages.length > 1"
          icon="i-lucide-chevron-left"
          color="neutral"
          variant="ghost"
          :disabled="index <= 0 || store.opening"
          :aria-label="t('ui.previousMessage')"
          @click="emit('move', -1)"
        />
        <UButton
          size="sm"
          square
          :ui="{ base: 'size-8 justify-center', leadingIcon: 'size-4' }"
          v-if="store.messages.length > 1"
          icon="i-lucide-chevron-right"
          color="neutral"
          variant="ghost"
          :disabled="index >= store.messages.length - 1 || store.opening"
          :aria-label="t('ui.nextMessage')"
          @click="emit('move', 1)"
        />
      </header>
      <MailReaderSkeleton v-if="store.opening" />
      <article
        v-else
        class="flex-1 min-h-0 overflow-y-auto"
        :aria-busy="store.opening"
      >
        <div class="p-5 lg:p-6 border-b border-default">
          <div
            class="flex items-center justify-between gap-3 text-xs text-dimmed mb-4"
          >
            <UBadge
              color="neutral"
              variant="subtle"
              size="sm"
              class="truncate max-w-[60%] font-normal"
              >{{
                message.mailbox_email || t("mail.removedMailbox")
              }}</UBadge><time class="shrink-0">{{
              date(message.received_at)
            }}</time>
          </div>
          <h1
            class="text-xl font-semibold text-highlighted leading-snug break-words mb-5"
          >
            {{ message.subject }}
          </h1>
          <div class="flex items-start gap-3">
            <UAvatar
              :alt="message.from_name || message.from_address"
              size="lg"
            />
            <div class="min-w-0">
              <b class="block text-sm text-highlighted break-words">{{
                message.from_name || message.from_address
              }}</b>
              <p
                v-if="
                  message.from_name &&
                  message.from_name !== message.from_address
                "
                class="text-xs text-muted mt-1 break-all"
              >
                {{ message.from_address }}
              </p>
            </div>
          </div>
          <div class="text-xs text-muted mt-4 leading-relaxed break-words">
            {{ t("mail.toLabel") }} {{ message.to_addresses.join(", ") }}
            <p v-if="message.cc_addresses.length">
              {{ t("compose.cc") }} {{ message.cc_addresses.join(", ") }}
            </p>
            <p v-if="message.bcc_addresses.length">
              {{ t("compose.bcc") }} {{ message.bcc_addresses.join(", ") }}
            </p>
            <a
              v-if="message.direction === 'inbound' && message.has_raw"
              :href="`/api/v1/messages/${message.id}/raw`"
              class="inline-flex items-center gap-1.5 mt-3 text-primary hover:underline"
            >
              <Download class="size-3.5" aria-hidden="true" />
              {{ t("mail.downloadOriginal") }}
            </a>
          </div>
        </div>
        <div class="p-5 lg:p-6">
          <DeliveryStatus
            v-if="message.direction === 'outbound'"
            :message="message"
            :retrying="retrying"
            @retry="emit('retry')"
          />
          <div v-if="message.body_html" class="space-y-3">
            <p class="text-[11px] text-dimmed leading-relaxed">
              {{ t("mail.privacy") }}
            </p>
            <iframe
              :srcdoc="emailDocument"
              :title="t('mail.body')"
              sandbox=""
              referrerpolicy="no-referrer"
              class="w-full min-h-[500px] bg-white border-0"
            />
          </div>
          <pre
            v-else
            class="whitespace-pre-wrap break-words font-sans text-sm leading-7 text-toned"
            >{{ message.body_text || t("mail.noBody") }}</pre>
          <div v-if="message.attachments.length" class="mt-6 space-y-2">
            <p class="text-xs font-medium">
              {{ t("mail.attachments", { count: message.attachments.length }) }}
            </p>
            <a
              v-for="a in message.attachments"
              :key="a.id"
              :href="`/api/v1/messages/attachments/${a.id}`"
              class="flex items-center gap-3 p-3 border border-default rounded-lg text-xs hover:bg-elevated"
              ><Paperclip class="size-4" /><span class="break-all"
                >{{ a.filename
                }}<small class="block text-dimmed mt-1">{{
                  t("mail.attachmentSize", { size: size(a.size) })
                }}</small></span
              ></a
            >
          </div>
        </div>
      </article>
      <footer class="p-4 lg:px-6 border-t border-default shrink-0">
        <div class="flex gap-2">
          <UButton
            :disabled="store.opening"
            icon="i-lucide-reply"
            @click="emit('compose', 'reply')"
            >{{
              t(
                message.direction === "outbound"
                  ? "ui.continueConversation"
                  : "mail.reply",
              )
            }}</UButton><UButton
            :disabled="store.opening"
            icon="i-lucide-forward"
            color="neutral"
            variant="outline"
            @click="emit('compose', 'forward')"
            >{{ t("mail.forward") }}</UButton
          >
        </div>
      </footer>
    </template>
    <template v-else-if="store.opening">
      <header
        class="flex items-center gap-2 px-3 lg:px-4 h-16 border-b border-default shrink-0"
      >
        <UButton
          class="lg:hidden"
          icon="i-lucide-arrow-left"
          color="neutral"
          variant="ghost"
          square
          size="sm"
          :ui="{ base: 'size-8 justify-center', leadingIcon: 'size-4' }"
          :aria-label="t('mail.back')"
          @click="store.clearSelection()"
        />
        <div class="ml-auto flex gap-2" aria-hidden="true">
          <USkeleton v-for="i in 4" :key="i" class="size-8" />
        </div>
      </header>
      <MailReaderSkeleton />
      <footer
        class="h-[65px] px-4 lg:px-6 border-t border-default shrink-0 flex items-center gap-2"
        aria-hidden="true"
      >
        <USkeleton class="h-8 w-20" /><USkeleton class="h-8 w-24" />
      </footer>
    </template>
    <div
      v-else
      class="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center"
    >
      <div
        class="size-14 rounded-2xl bg-elevated flex items-center justify-center"
      >
        <Inbox class="size-7 text-dimmed" />
      </div>
      <h2 class="text-sm font-medium">
        {{ t("mail.select") }}
      </h2>
      <p class="text-xs text-muted">{{ t("mail.selectHint") }}</p>
      <div class="text-xs text-dimmed flex gap-5 mt-4">
        <span
          ><kbd class="border border-default rounded px-1.5 mr-1.5">C</kbd
          >{{ t("nav.compose") }}</span
        ><span
          ><kbd class="border border-default rounded px-1.5 mr-1.5">/</kbd
          >{{ t("mail.search") }}</span
        >
      </div>
    </div>
  </UDashboardPanel>
</template>

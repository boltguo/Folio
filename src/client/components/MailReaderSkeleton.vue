<script setup lang="ts">
import { useI18n } from "vue-i18n";
import USkeleton from "@nuxt/ui/components/Skeleton.vue";
const { t } = useI18n();
</script>
<template>
  <div
    class="flex-1 min-h-0 overflow-hidden"
    role="status"
    :aria-label="t('mail.opening')"
  >
    <div aria-hidden="true">
      <div class="p-5 lg:p-6 border-b border-default space-y-5">
        <div class="flex justify-between gap-4">
          <USkeleton class="h-5 w-36" /><USkeleton class="h-4 w-24" />
        </div>
        <USkeleton class="h-7 w-3/4" />
        <div class="flex gap-3 items-center">
          <USkeleton class="size-10 rounded-full shrink-0" />
          <div class="space-y-2">
            <USkeleton class="h-4 w-24" /><USkeleton class="h-3 w-40" />
          </div>
        </div>
        <USkeleton class="h-3 w-1/2" />
      </div>
      <div class="p-5 lg:p-6 space-y-4">
        <USkeleton class="h-4 w-1/4" /><USkeleton
          v-for="i in 4"
          :key="i"
          class="h-4"
          :class="i === 4 ? 'w-2/3' : 'w-full'"
        />
      </div>
    </div>
  </div>
</template>

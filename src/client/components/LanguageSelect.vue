<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import USelect from "@nuxt/ui/components/Select.vue";
import { isLocale, setLocale } from "../i18n";
withDefaults(defineProps<{ showLabel?: boolean }>(), { showLabel: true });
const { t, locale } = useI18n();
const saveFailed = ref(false);
const items = [
  { label: "简体中文", value: "zh-CN" },
  { label: "English", value: "en" },
];
function change(value: string) {
  if (isLocale(value)) saveFailed.value = !setLocale(value);
}
</script>
<template>
  <div class="language-select">
    <label
      ><span v-if="showLabel">{{ t("settings.language") }}</span
      ><USelect
        :model-value="locale"
        :items="items"
        :aria-label="t('settings.language')"
        class="w-36"
        @update:model-value="change"
    /></label>
    <p v-if="saveFailed" class="form-error" role="alert">
      {{ t("settings.languageNotSaved") }}
    </p>
  </div>
</template>

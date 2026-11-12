<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { isLocale, setLocale } from "../i18n";

const { t, locale } = useI18n();
const saveFailed = ref(false);
function change(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  if (isLocale(value)) saveFailed.value = !setLocale(value);
}
</script>
<template>
  <div class="language-select">
    <label
      ><span>{{ t("settings.language") }}</span
      ><select :value="locale" @change="change">
        <option value="zh-CN">简体中文</option>
        <option value="en">English</option>
      </select></label
    >
    <p v-if="saveFailed" class="form-error" role="alert">
      {{ t("settings.languageNotSaved") }}
    </p>
  </div>
</template>

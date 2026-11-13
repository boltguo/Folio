<script setup lang="ts">
import { ref, watch, nextTick } from "vue";
import UModal from "@nuxt/ui/components/Modal.vue";
const props = defineProps<{ open: boolean; title: string }>();
const emit = defineEmits<{ "update:open": [value: boolean] }>();
const body = ref<HTMLElement>();
let previousFocus: HTMLElement | null = null;
watch(
  () => props.open,
  (open) => {
    if (open) previousFocus = document.activeElement as HTMLElement;
  },
  { flush: "sync" },
);
function focus() {
  void nextTick(() =>
    body.value
      ?.querySelector<HTMLElement>(
        "input:not([type=hidden]), textarea, [role=combobox], button",
      )
      ?.focus(),
  );
}
function restore() {
  if (previousFocus?.isConnected) previousFocus.focus();
}
</script>
<template>
  <UModal
    :open="open"
    :title="title"
    :ui="{ content: 'max-w-md' }"
    @update:open="emit('update:open', $event)"
    @after:enter="focus"
    @after:leave="restore"
  >
    <template #body
      ><div ref="body"><slot /></div
    ></template>
  </UModal>
</template>

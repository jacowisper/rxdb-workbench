<script setup lang="ts">
import { computed, ref } from "vue";
import { ChevronDown, ChevronRight } from "lucide-vue-next";

defineOptions({
  name: "JsonTreeNode"
});

const props = withDefaults(
  defineProps<{
    label: string;
    value: unknown;
    depth?: number;
    pathPrefix?: string;
  }>(),
  {
    depth: 0,
    pathPrefix: ""
  }
);

const emit = defineEmits<{
  "select-leaf-key": [path: string];
}>();

const isArrayValue = computed(() => Array.isArray(props.value));
const isObjectValue = computed(() => Boolean(props.value) && typeof props.value === "object" && !Array.isArray(props.value));

const childEntries = computed(() => {
  if (Array.isArray(props.value)) {
    return props.value.map((entry, index) => [String(index), entry] as const);
  }
  if (props.value && typeof props.value === "object") {
    return Object.entries(props.value as Record<string, unknown>);
  }
  return [] as Array<[string, unknown]>;
});

const hasChildren = computed(() => (isArrayValue.value || isObjectValue.value) && childEntries.value.length > 0);
const expanded = ref(false);
const currentPath = computed(() => (props.pathPrefix ? `${props.pathPrefix}.${props.label}` : props.label));

const typeLabel = computed(() => {
  if (isArrayValue.value) {
    return `Array(${childEntries.value.length})`;
  }
  if (isObjectValue.value) {
    return "Object";
  }
  return "";
});

const scalarValueLabel = computed(() => {
  const value = props.value;
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return `"${value}"`;
  }
  return String(value);
});

const urlValue = computed(() => {
  const value = props.value;
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
    return null;
  } catch {
    return null;
  }
});

const isUrlScalar = computed(() => Boolean(urlValue.value) && !hasChildren.value);

function onLeafKeyClick(): void {
  if (hasChildren.value) {
    return;
  }
  emit("select-leaf-key", currentPath.value);
}

function onScalarValueClick(event: MouseEvent): void {
  if (!isUrlScalar.value || !urlValue.value) {
    return;
  }

  // Keep normal click as non-navigation; only follow links with Ctrl/Cmd click.
  if (!(event.ctrlKey || event.metaKey)) {
    return;
  }

  window.open(urlValue.value, "_blank", "noopener,noreferrer");
}
</script>

<template>
  <div>
    <div class="flex items-start gap-1 leading-5" :style="{ paddingLeft: `${props.depth * 0.75}rem` }">
      <button
        v-if="hasChildren"
        type="button"
        class="mt-0.5 inline-flex h-4 w-4 items-center justify-center text-slate-400 transition hover:text-slate-200"
        @click="expanded = !expanded"
      >
        <ChevronDown v-if="expanded" class="h-3.5 w-3.5" aria-hidden="true" />
        <ChevronRight v-else class="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <span v-else class="inline-flex h-4 w-4" />

      <button
        type="button"
        class="text-left text-slate-400 transition hover:text-slate-200"
        :class="hasChildren ? 'cursor-default hover:text-slate-400' : 'cursor-pointer'"
        @click="onLeafKeyClick"
      >
        {{ props.label }}:
      </button>
      <span v-if="hasChildren" class="text-cyan-300">{{ typeLabel }}</span>
      <button
        v-else-if="isUrlScalar"
        type="button"
        class="cursor-pointer text-left text-sky-300 underline decoration-dotted underline-offset-2 transition hover:text-sky-200"
        title="Ctrl+Click (Cmd+Click on macOS) to open link"
        @click="onScalarValueClick"
      >
        {{ scalarValueLabel }}
      </button>
      <span v-else class="text-emerald-300">{{ scalarValueLabel }}</span>
    </div>

    <div v-if="hasChildren && expanded">
      <JsonTreeNode
        v-for="[key, childValue] in childEntries"
        :key="`${props.depth}-${props.label}-${key}`"
        :label="key"
        :value="childValue"
        :depth="props.depth + 1"
        :path-prefix="currentPath"
        @select-leaf-key="(path) => emit('select-leaf-key', path)"
      />
    </div>
  </div>
</template>

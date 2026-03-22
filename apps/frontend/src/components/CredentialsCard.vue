<script setup lang="ts">
import { ref, watch } from "vue";

const props = defineProps<{
  initialUsername: string;
}>();

const emit = defineEmits<{
  save: [payload: { username: string; password: string }];
  close: [];
}>();

const username = ref(props.initialUsername);
const password = ref("");
const error = ref("");

watch(
  () => props.initialUsername,
  (value) => {
    username.value = value;
    password.value = "";
    error.value = "";
  },
  { immediate: true }
);

function submit(): void {
  error.value = "";

  const nextUsername = username.value.trim();
  if (!nextUsername || !password.value) {
    error.value = "Username and password are required.";
    return;
  }

  emit("save", { username: nextUsername, password: password.value });
}
</script>

<template>
  <div class="fixed inset-0 z-20 flex items-start justify-center overflow-y-auto bg-black/60 px-4 py-4 sm:items-center">
    <div class="my-auto w-full max-w-md max-h-[calc(100vh-2rem)] overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl shadow-black/40">
      <h3 class="text-lg font-semibold tracking-tight">Change username/password</h3>
      <p class="mt-1 text-sm text-slate-300">Update credentials used for login.</p>

      <form class="mt-5 space-y-4" @submit.prevent="submit">
        <label class="block text-sm">
          <span class="mb-1 block text-slate-300">New username</span>
          <input
            v-model="username"
            type="text"
            class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none transition focus:border-sky-500"
            autocomplete="off"
          />
        </label>

        <label class="block text-sm">
          <span class="mb-1 block text-slate-300">New password</span>
          <input
            v-model="password"
            type="password"
            class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none transition focus:border-sky-500"
            autocomplete="off"
          />
        </label>

        <p v-if="error" class="text-sm text-rose-300">{{ error }}</p>

        <div class="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            class="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 transition hover:bg-slate-800"
            @click="emit('close')"
          >
            Cancel
          </button>
          <button
            type="submit"
            class="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-sky-500"
          >
            Save
          </button>
        </div>
      </form>
    </div>
  </div>
</template>

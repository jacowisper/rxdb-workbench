<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { getCurrentAuthHash, ensureDefaultAuth, verifyCredentials } from "../lib/workbenchAuthStore";
import { md5 } from "../lib/md5";
import {
  clearManualLogout,
  clearSavedLogin,
  getSavedLogin,
  isManualLogout,
  saveSavedLogin
} from "../lib/loginPersistence";
import packageJson from "../../package.json";

const emit = defineEmits<{
  authenticated: [username: string];
}>();

const appVersion = packageJson.version;
const isReady = ref(false);
const loginUsername = ref("admin");
const loginPassword = ref("");
const loginError = ref("");
const shouldSavePasswordHash = ref(false);

const passwordSaveForm = ref<HTMLFormElement | null>(null);
const passwordSaveUsername = ref("");
const passwordSavePassword = ref("");

onMounted(async () => {
  await ensureDefaultAuth();
  const savedLogin = getSavedLogin();
  shouldSavePasswordHash.value = Boolean(savedLogin);
  isReady.value = true;

  if (!savedLogin || isManualLogout()) {
    return;
  }

  const currentAuthHash = await getCurrentAuthHash();
  if (!currentAuthHash || currentAuthHash !== savedLogin.hash) {
    clearSavedLogin();
    shouldSavePasswordHash.value = false;
    return;
  }

  emit("authenticated", savedLogin.username);
});

watch(shouldSavePasswordHash, (checked) => {
  if (!checked) {
    clearSavedLogin();
  }
});

async function offerPasswordSave(username: string, password: string): Promise<void> {
  passwordSaveUsername.value = username;
  passwordSavePassword.value = password;
  requestAnimationFrame(() => {
    passwordSaveForm.value?.requestSubmit();
  });

  try {
    const credentialsApi = (navigator as Navigator & { credentials?: { store?: (credential: Credential) => Promise<Credential | null> } })
      .credentials;
    const passwordCredentialCtor = (
      window as Window & { PasswordCredential?: new (data: { id: string; password: string; name?: string }) => Credential }
    ).PasswordCredential;

    if (!credentialsApi?.store || !passwordCredentialCtor) {
      return;
    }

    const credential = new passwordCredentialCtor({ id: username, password, name: username });
    await credentialsApi.store(credential);
  } catch {
    // Ignore; browser support and user settings vary.
  }
}

async function login(): Promise<void> {
  loginError.value = "";

  const username = loginUsername.value.trim();
  const password = loginPassword.value;

  if (!username || !password) {
    loginError.value = "Username and password are required.";
    return;
  }

  const valid = await verifyCredentials(username, password);
  if (!valid) {
    loginError.value = "Invalid username or password.";
    return;
  }

  if (shouldSavePasswordHash.value) {
    saveSavedLogin({ username, hash: md5(`${username}/${password}`) });
  } else {
    clearSavedLogin();
  }
  clearManualLogout();
  await offerPasswordSave(username, password);
  emit("authenticated", username);
}
</script>

<template>
  <main class="min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-slate-800 text-slate-100">
    <section v-if="!isReady" class="mx-auto flex min-h-screen max-w-5xl items-center justify-center px-6">
      <p class="text-sm text-slate-300">Loading workbench...</p>
    </section>

    <section v-else class="mx-auto flex min-h-screen max-w-5xl items-center justify-center px-6">
      <div class="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900/75 p-8 shadow-2xl shadow-black/30">
        <h1 class="text-2xl font-semibold tracking-tight">RXDB Server Workbench v{{ appVersion }}</h1>
        <p class="mt-2 text-sm text-slate-300">Sign in to continue.</p>

        <iframe name="password-save-sink" title="password-save-sink" class="hidden" />
        <form
          ref="passwordSaveForm"
          class="hidden"
          method="post"
          action="/__password-save"
          target="password-save-sink"
          autocomplete="on"
        >
          <input v-model="passwordSaveUsername" type="text" name="username" autocomplete="username" />
          <input v-model="passwordSavePassword" type="password" name="password" autocomplete="current-password" />
        </form>

        <form class="mt-6 space-y-4" autocomplete="on" @submit.prevent="login">
          <label class="block text-sm">
            <span class="mb-1 block text-slate-300">Username</span>
            <input
              v-model="loginUsername"
              type="text"
              name="username"
              class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none transition focus:border-sky-500"
              autocomplete="username"
            />
          </label>

          <label class="block text-sm">
            <span class="mb-1 block text-slate-300">Password</span>
            <input
              v-model="loginPassword"
              type="password"
              name="password"
              class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none transition focus:border-sky-500"
              autocomplete="current-password"
            />
          </label>

          <label class="flex items-center gap-2 text-sm text-slate-300">
            <input
              v-model="shouldSavePasswordHash"
              type="checkbox"
              class="h-4 w-4 rounded border-slate-600 bg-slate-950 text-sky-500 focus:ring-sky-500"
            />
            Save password hash for auto login
          </label>

          <p v-if="loginError" class="text-sm text-rose-300">{{ loginError }}</p>

          <button
            type="submit"
            class="w-full rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-sky-500"
          >
            Login
          </button>
        </form>
      </div>
    </section>
  </main>
</template>

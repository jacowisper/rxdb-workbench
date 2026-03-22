<script setup lang="ts">
import { ref } from "vue";
import LoginView from "./views/LoginView.vue";
import WorkbenchView from "./views/WorkbenchView.vue";

const isAuthenticated = ref(false);
const currentUsername = ref("");

function handleAuthenticated(username: string): void {
  isAuthenticated.value = true;
  currentUsername.value = username;
}

function handleLogout(): void {
  isAuthenticated.value = false;
  currentUsername.value = "";
}

function handleUsernameUpdated(username: string): void {
  currentUsername.value = username;
}
</script>

<template>
  <LoginView v-if="!isAuthenticated" @authenticated="handleAuthenticated" />
  <WorkbenchView
    v-else
    :username="currentUsername"
    @logout="handleLogout"
    @username-updated="handleUsernameUpdated"
  />
</template>
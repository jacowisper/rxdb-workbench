<script setup lang="ts">
import { Download, Eye, EyeOff, Trash2 } from "lucide-vue-next";
import type {
  MongoConnectionTestResult,
  ReplicationEndpointTestResult,
  RuntimeLogEvent,
  ServerConfigResponse
} from "../../lib/backendApi";

type WsServerStatus = {
  serverId: string;
  status: string;
  hasStagedConfig: boolean;
  hasRunningConfig: boolean;
  replicationEndpointTest: ReplicationEndpointTestResult | null;
  mongoConnectionTest: MongoConnectionTestResult | null;
};

const props = defineProps<{
  setupLoading: boolean;
  wsStatus: WsServerStatus | null;
  canDeployStagedConfig: boolean;
  canStopServer: boolean;
  canStartServer: boolean;
  setupConfig: ServerConfigResponse | null;
  hasServerSetup: boolean;
  backendUnavailable: boolean;
  backendUnreachableMessage: string;
  statusLabel: string;
  showStageValidationTests: boolean;
  replicationEndpointTest: ReplicationEndpointTestResult | null;
  mongoConnectionTest: MongoConnectionTestResult | null;
  websocketState: "idle" | "connecting" | "connected" | "reconnecting";
  websocketError: string;
  showStatusReport: boolean;
  statusServerName: string;
  deploymentMessage: string;
  setupError: string;
  setupSuccess: string;
  runtimeLogs: RuntimeLogEvent[];
  formatLogTimestamp: (at: string) => string;
  showRuntimeLogs: boolean;
}>();

const emit = defineEmits<{
  openSetupCard: [];
  openDeployConfirm: [];
  openStopConfirm: [];
  startServer: [];
  requestClearLogs: [];
  requestExportLogs: [];
  toggleRuntimeLogs: [];
}>();
</script>

<template>
  <div class="space-y-5">
    <div class="flex flex-wrap items-center gap-3">
      <button
        type="button"
        class="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:bg-slate-700"
        :disabled="props.setupLoading"
        @click="emit('openSetupCard')"
      >
        Setup RxDB Server
      </button>
      <button
        v-if="props.wsStatus?.hasStagedConfig"
        type="button"
        class="rounded-lg border border-amber-500/60 bg-amber-600/20 px-4 py-2 text-sm font-medium text-amber-200 transition hover:bg-amber-600/30 disabled:cursor-not-allowed disabled:opacity-60"
        :disabled="!props.canDeployStagedConfig"
        @click="emit('openDeployConfirm')"
      >
        Deploy Staged Config
      </button>
      <button
        v-if="props.wsStatus?.status === 'running'"
        type="button"
        class="rounded-lg border border-rose-500/60 bg-rose-600/20 px-4 py-2 text-sm font-medium text-rose-200 transition hover:bg-rose-600/30 disabled:cursor-not-allowed disabled:opacity-60"
        :disabled="!props.canStopServer"
        @click="emit('openStopConfirm')"
      >
        Stop Server
      </button>
      <button
        v-else-if="props.wsStatus?.status === 'stopped' && props.hasServerSetup"
        type="button"
        class="rounded-lg border border-emerald-500/60 bg-emerald-600/20 px-4 py-2 text-sm font-medium text-emerald-200 transition hover:bg-emerald-600/30 disabled:cursor-not-allowed disabled:opacity-60"
        :disabled="!props.canStartServer"
        @click="emit('startServer')"
      >
        Start Server
      </button>
    </div>

    <p v-if="props.backendUnavailable" class="text-sm text-rose-300">{{ props.backendUnreachableMessage }}</p>

    <div v-else class="rounded-lg border border-slate-700 bg-slate-950/60 p-4 text-sm text-slate-300">
      <p v-if="!props.hasServerSetup" class="font-medium text-slate-100">no server setup</p>
      <template v-else>
        <p>
          Server Identifier:
          <span class="font-medium text-slate-100">{{ props.setupConfig?.effectiveServerSetup?.serverIdentifier }}</span>
        </p>
        <p class="mt-1">
          Url:
          <span class="font-medium text-slate-100">{{ props.setupConfig?.effectiveServerSetup?.url }}</span>
        </p>
        <p class="mt-1">
          Port:
          <span class="font-medium text-slate-100">{{ props.setupConfig?.effectiveServerSetup?.port }}</span>
        </p>
        <p class="mt-1">
          Status:
          <span class="font-medium text-slate-100">{{ props.statusLabel }}</span>
        </p>
        <p
          v-if="props.showStageValidationTests"
          class="mt-1"
          :class="
            !props.replicationEndpointTest
              ? 'text-amber-300'
              : props.replicationEndpointTest.ok
                ? 'text-emerald-300'
                : 'text-rose-300'
          "
        >
          {{
            !props.replicationEndpointTest
              ? "Testing endpoint..."
              : props.replicationEndpointTest.ok
                ? "Replication Endpoint test passed."
                : `Warning replication endpoint for ${props.replicationEndpointTest.collection} gave ${
                    props.replicationEndpointTest.httpStatus ?? "no response"
                  }.`
          }}
        </p>
        <p
          v-if="props.showStageValidationTests"
          class="mt-1"
          :class="!props.mongoConnectionTest ? 'text-amber-300' : props.mongoConnectionTest.ok ? 'text-emerald-300' : 'text-rose-300'"
        >
          {{
            !props.mongoConnectionTest
              ? "Testing Mongo connection..."
              : props.mongoConnectionTest.ok
                ? "MongoDB connection test passed."
                : `Warning MongoDB connection test failed: ${props.mongoConnectionTest.error ?? "unknown error"}.`
          }}
        </p>
      </template>
    </div>

    <p v-if="props.websocketState === 'connected'" class="text-sm text-emerald-300">WebSocket connected.</p>
    <p v-else-if="props.websocketState === 'connecting'" class="text-sm text-slate-300">WebSocket connecting...</p>
    <p v-else-if="props.websocketState === 'reconnecting'" class="text-sm text-amber-300">WebSocket reconnecting...</p>
    <p v-if="props.websocketError" class="text-sm text-rose-300">{{ props.websocketError }}</p>

    <div v-if="props.showStatusReport" class="rounded-lg border border-slate-700 bg-slate-950/60 p-4 text-sm text-slate-300">
      <p>
        Server Name:
        <span class="font-medium text-slate-100">{{ props.statusServerName }}</span>
      </p>
      <p class="mt-1">
        Runtime Status:
        <span class="font-medium text-slate-100">{{ props.wsStatus?.status }}</span>
      </p>
    </div>

    <p v-if="props.deploymentMessage" class="text-sm text-sky-300">{{ props.deploymentMessage }}</p>

    <p v-if="props.setupError && props.setupError !== props.backendUnreachableMessage" class="text-sm text-rose-300">{{ props.setupError }}</p>
    <p v-if="props.setupSuccess" class="text-sm text-emerald-300">{{ props.setupSuccess }}</p>

    <div class="rounded-lg border border-slate-700 bg-slate-950/60 p-4 text-sm text-slate-300">
      <div class="flex items-center justify-between gap-2">
        <p class="font-medium text-slate-100">Runtime Logs</p>
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-200 transition hover:bg-slate-800"
            @click="emit('toggleRuntimeLogs')"
          >
            <component :is="props.showRuntimeLogs ? EyeOff : Eye" class="h-3.5 w-3.5" aria-hidden="true" />
            <span>{{ props.showRuntimeLogs ? "Hide Logs" : "Show Logs" }}</span>
          </button>
          <button
            type="button"
            class="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-200 transition hover:bg-slate-800"
            @click="emit('requestExportLogs')"
          >
            <Download class="h-3.5 w-3.5" aria-hidden="true" />
            <span>Export Logs</span>
          </button>
          <button
            type="button"
            class="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-200 transition hover:bg-slate-800"
            @click="emit('requestClearLogs')"
          >
            <Trash2 class="h-3.5 w-3.5" aria-hidden="true" />
            <span>Clear Logs</span>
          </button>
        </div>
      </div>
      <div v-if="props.showRuntimeLogs && props.runtimeLogs.length === 0" class="terminal-empty mt-2">No logs yet.</div>
      <div v-else-if="props.showRuntimeLogs" class="terminal-log-panel thin-scrollbar mt-2 max-h-64 overflow-y-auto p-3">
        <div v-for="(entry, index) in props.runtimeLogs" :key="`${entry.at}-${index}`" class="terminal-log-entry">
          <p class="terminal-log-meta">{{ props.formatLogTimestamp(entry.at) }}</p>
          <p class="terminal-log-meta">{{ entry.area }} | {{ entry.level }}</p>
          <p class="terminal-log-message">{{ entry.message }}</p>
          <p v-if="entry.collection" class="terminal-log-extra">Collection: {{ entry.collection }}</p>
          <p v-if="entry.details" class="terminal-log-extra whitespace-pre-wrap break-all">{{ entry.details }}</p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.terminal-log-panel {
  background-color: #020603;
  color: #56f08a;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 0.77rem;
  line-height: 1.35;
  text-shadow: 0 0 6px rgb(54 255 129 / 0.25);
  background-image: repeating-linear-gradient(
    to bottom,
    rgb(86 240 138 / 0.06) 0,
    rgb(86 240 138 / 0.06) 1px,
    transparent 1px,
    transparent 3px
  );
}

.terminal-log-entry + .terminal-log-entry {
  margin-top: 0.75rem;
}

.terminal-log-meta {
  font-size: 0.61rem;
  color: #39d975;
  text-transform: uppercase;
}

.terminal-log-message {
  margin-top: 0.15rem;
  color: #7dfca8;
}

.terminal-log-extra {
  margin-top: 0.1rem;
  font-size: 0.61rem;
  color: #4ddf7f;
}

.terminal-empty {
  color: #4ddf7f;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 0.77rem;
}
</style>

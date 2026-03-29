<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { User } from "lucide-vue-next";
import {
  clearRuntimeLogs,
  createServer,
  deleteServer,
  type DeployValidationResult,
  getRuntimeLogs,
  getServerConfig,
  type MongoConnectionTestResult,
  selectServer,
  type RuntimeLogEvent,
  type ServerSummary,
  validateDeploy,
  updateServer,
  type ReplicationEndpointTestResult,
  type ServerConfigResponse,
  type ServerSetup
} from "../lib/backendApi";
import { updateCredentials } from "../lib/workbenchAuthStore";
import CredentialsCard from "../components/CredentialsCard.vue";
import SetupCard from "../components/SetupCard.vue";
import SetupTab from "../components/workbench/SetupTab.vue";
import CollectionsTab from "../components/workbench/CollectionsTab.vue";
import { markManualLogout } from "../lib/loginPersistence";
import packageJson from "../../package.json";

const BACKEND_UNREACHABLE_MESSAGE = "Unable to connect to backend is it running ?";
const BACKEND_WEBSOCKET_PORT = String(import.meta.env.VITE_FRONTEND_TO_USE_BACKEND_WEBSOCKET_PORT ?? "4001");
const BACKEND_HTTP_BASE_URL = (import.meta.env.VITE_FRONTEND_TO_USE_BACKEND_URL ?? "http://localhost:4000").trim();
const DEFAULT_MONGODB_CONNECTION_STRING = import.meta.env.VITE_FRONTEND_DEFAULT_MONGODB_CONNECTION_STRING ?? "";

type WsServerStatus = {
  serverId: string;
  activeServerId: string | null;
  status: string;
  hasStagedConfig: boolean;
  hasRunningConfig: boolean;
  servers: ServerSummary[];
  replicationEndpointTest: ReplicationEndpointTestResult | null;
  mongoConnectionTest: MongoConnectionTestResult | null;
};

type CollectionChangeEvent = {
  at: string;
  collection: string;
  changeCount: number;
  operations: string[];
};

const props = defineProps<{
  username: string;
}>();

const emit = defineEmits<{
  logout: [];
  usernameUpdated: [username: string];
}>();

const appVersion = packageJson.version;
const currentUsername = ref(props.username);
const dropdownOpen = ref(false);
const isCredentialsCardOpen = ref(false);
const isSetupCardOpen = ref(false);
const setupConfig = ref<ServerConfigResponse | null>(null);
const selectedServerId = ref<string | null>(null);
const isCreatingServer = ref(false);
const setupLoading = ref(false);
const setupError = ref("");
const setupSuccess = ref("");
const backendUnavailable = ref(false);

const websocketState = ref<"idle" | "connecting" | "connected" | "reconnecting">("idle");
const websocketError = ref("");
const wsStatus = ref<WsServerStatus | null>(null);
const deploymentMessage = ref("");
const isDeployValidationModalOpen = ref(false);
const isDeployValidating = ref(false);
const deployValidationError = ref("");
const deployValidationResult = ref<DeployValidationResult | null>(null);
const suppressStageValidationTests = ref(false);
const isStopConfirmOpen = ref(false);
const runtimeLogs = ref<RuntimeLogEvent[]>([]);
const activeTab = ref<"setup" | "collections">("setup");
const isClearLogsConfirmOpen = ref(false);
const isExportLogsConfirmOpen = ref(false);
const isDeleteServerConfirmOpen = ref(false);
const showRuntimeLogs = ref(true);
const lastCollectionChange = ref<CollectionChangeEvent | null>(null);
const collectionChangeVersion = ref(0);
const emptyServerSetup: ServerSetup = {
  serverIdentifier: "",
  url: "",
  port: "",
  resyncBackendCollectionsFromScratch: true,
  schemaValidationEnabled: true,
  mongodbConnectionString: DEFAULT_MONGODB_CONNECTION_STRING,
  authHeader: "",
  collections: [],
  collectionEndpoints: {},
  schemasByCollection: {}
};
const availableServers = computed(() => setupConfig.value?.servers ?? []);
const setupCardInitialSetup = computed<ServerSetup>(() => {
  if (isCreatingServer.value) {
    return emptyServerSetup;
  }
  return setupConfig.value?.stagedServerSetup ?? setupConfig.value?.runningServerSetup ?? emptyServerSetup;
});

const dropdownRoot = ref<HTMLElement | null>(null);
let websocketClient: WebSocket | null = null;
let reconnectTimer: number | null = null;
let reconnectAttempt = 0;
let refreshInFlight = false;

watch(
  () => props.username,
  (value) => {
    currentUsername.value = value;
  }
);

watch(
  () => wsStatus.value?.status,
  (status) => {
    if (status !== "running" && activeTab.value === "collections") {
      activeTab.value = "setup";
    }
  }
);

onMounted(async () => {
  document.addEventListener("click", closeDropdownOnOutsideClick);
  await refreshRuntimeLogs();
  await refreshServerConfig();
  restartWebSocketConnection();
});

onBeforeUnmount(() => {
  document.removeEventListener("click", closeDropdownOnOutsideClick);
  stopWebSocketConnection();
});

function closeDropdownOnOutsideClick(event: MouseEvent): void {
  if (!dropdownRoot.value) {
    return;
  }

  const target = event.target as Node | null;
  if (target && !dropdownRoot.value.contains(target)) {
    dropdownOpen.value = false;
  }
}

function hasServerSetup(config: ServerConfigResponse | null): boolean {
  const setup = config?.effectiveServerSetup;
  if (!setup) {
    return false;
  }

  return Boolean(
    setup.serverIdentifier.trim() &&
      setup.url.trim() &&
      setup.port.trim() &&
      setup.mongodbConnectionString.trim() &&
      setup.collections.length > 0
  );
}

function hasValidStagedSetup(config: ServerConfigResponse | null): boolean {
  const setup = config?.stagedServerSetup;
  if (!setup) {
    return false;
  }

  return Boolean(
    setup.serverIdentifier.trim() &&
      setup.url.trim() &&
      setup.port.trim() &&
      setup.mongodbConnectionString.trim() &&
      setup.collections.length > 0
  );
}

function clearReconnectTimer(): void {
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function stopWebSocketConnection(): void {
  clearReconnectTimer();
  if (websocketClient) {
    websocketClient.onopen = null;
    websocketClient.onclose = null;
    websocketClient.onerror = null;
    websocketClient.onmessage = null;
    websocketClient.close();
    websocketClient = null;
  }
  reconnectAttempt = 0;
  websocketState.value = "idle";
  wsStatus.value = null;
}

function canConnectWebSocket(): boolean {
  return Boolean(BACKEND_HTTP_BASE_URL && BACKEND_WEBSOCKET_PORT.trim());
}

function buildWebSocketUrl(): string | null {
  const urlInput = BACKEND_HTTP_BASE_URL;
  const wsPort = BACKEND_WEBSOCKET_PORT.trim();
  if (!urlInput || !wsPort) {
    return null;
  }

  try {
    const parsed = new URL(urlInput.includes("://") ? urlInput : `http://${urlInput}`);
    const protocol = parsed.protocol === "https:" ? "wss" : "ws";
    return `${protocol}://${parsed.hostname}:${wsPort}`;
  } catch {
    return null;
  }
}

function scheduleReconnect(): void {
  clearReconnectTimer();
  reconnectAttempt += 1;
  const delayMs = Math.min(1000 * reconnectAttempt, 15000);
  websocketState.value = "reconnecting";
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, delayMs);
}

function handleWsStatus(status: WsServerStatus): void {
  wsStatus.value = status;
  console.log("[WS status]", status);
}

function prependRuntimeLog(log: RuntimeLogEvent): void {
  runtimeLogs.value = [log, ...runtimeLogs.value].slice(0, 500);
}

function formatLogTimestamp(at: string): string {
  const parsed = new Date(at);
  if (Number.isNaN(parsed.getTime())) {
    return at;
  }
  return parsed.toLocaleString();
}

function syncSelectedServerFromConfig(config: ServerConfigResponse | null): void {
  if (!config) {
    selectedServerId.value = null;
    return;
  }

  if (config.activeServerId) {
    selectedServerId.value = config.activeServerId;
    return;
  }

  selectedServerId.value = config.servers[0]?.serverId ?? null;
}

async function refreshRuntimeLogs(): Promise<void> {
  try {
    runtimeLogs.value = await getRuntimeLogs();
  } catch {
    // Ignore log preload failures.
  }
}

function activeReplicationEndpointTest(): ReplicationEndpointTestResult | null {
  return wsStatus.value?.replicationEndpointTest ?? setupConfig.value?.replicationEndpointTest ?? null;
}

function activeMongoConnectionTest(): MongoConnectionTestResult | null {
  return wsStatus.value?.mongoConnectionTest ?? setupConfig.value?.mongoConnectionTest ?? null;
}

function shouldShowStageValidationTests(): boolean {
  if (!hasValidStagedSetup(setupConfig.value)) {
    return false;
  }

  if (wsStatus.value?.status !== "staged") {
    return false;
  }

  if (suppressStageValidationTests.value || isDeployValidationModalOpen.value || isDeployValidating.value) {
    return false;
  }

  // These checks belong to staged-config save validation only.
  return true;
}

function connectWebSocket(): void {
  if (!canConnectWebSocket()) {
    stopWebSocketConnection();
    return;
  }

  const wsUrl = buildWebSocketUrl();
  if (!wsUrl) {
    websocketError.value = "Invalid server URL or websocket port.";
    stopWebSocketConnection();
    return;
  }

  websocketError.value = "";
  deploymentMessage.value = "";
  websocketState.value = reconnectAttempt > 0 ? "reconnecting" : "connecting";

  const socket = new WebSocket(wsUrl);
  websocketClient = socket;

  socket.onopen = () => {
    websocketState.value = "connected";
    reconnectAttempt = 0;
    backendUnavailable.value = false;
    void refreshServerConfig();
    socket.send(JSON.stringify({ type: "server:subscribe-status" }));
  };

  socket.onmessage = (event) => {
    try {
      const payload = JSON.parse(String(event.data)) as {
        type?: string;
        serverId?: string;
        activeServerId?: unknown;
        status?: string;
        hasStagedConfig?: boolean;
        hasRunningConfig?: boolean;
        servers?: unknown;
        replicationEndpointTest?: unknown;
        mongoConnectionTest?: unknown;
        message?: string;
        log?: unknown;
        change?: unknown;
      };

      if (payload.type === "server:status") {
        const replicationEndpointTest =
          payload.replicationEndpointTest &&
          typeof payload.replicationEndpointTest === "object" &&
          !Array.isArray(payload.replicationEndpointTest) &&
          typeof (payload.replicationEndpointTest as { collection?: unknown }).collection === "string" &&
          typeof (payload.replicationEndpointTest as { endpoint?: unknown }).endpoint === "string" &&
          typeof (payload.replicationEndpointTest as { ok?: unknown }).ok === "boolean" &&
          (typeof (payload.replicationEndpointTest as { httpStatus?: unknown }).httpStatus === "number" ||
            (payload.replicationEndpointTest as { httpStatus?: unknown }).httpStatus === null)
            ? ({
                collection: (payload.replicationEndpointTest as { collection: string }).collection,
                endpoint: (payload.replicationEndpointTest as { endpoint: string }).endpoint,
                ok: (payload.replicationEndpointTest as { ok: boolean }).ok,
                httpStatus: (payload.replicationEndpointTest as { httpStatus: number | null }).httpStatus
              } as ReplicationEndpointTestResult)
            : null;

        const mongoConnectionTest =
          payload.mongoConnectionTest &&
          typeof payload.mongoConnectionTest === "object" &&
          !Array.isArray(payload.mongoConnectionTest) &&
          typeof (payload.mongoConnectionTest as { ok?: unknown }).ok === "boolean" &&
          (typeof (payload.mongoConnectionTest as { error?: unknown }).error === "string" ||
            (payload.mongoConnectionTest as { error?: unknown }).error === null)
            ? ({
                ok: (payload.mongoConnectionTest as { ok: boolean }).ok,
                error: (payload.mongoConnectionTest as { error: string | null }).error
              } as MongoConnectionTestResult)
            : null;

        handleWsStatus({
          serverId: payload.serverId ?? "unknown",
          activeServerId: typeof payload.activeServerId === "string" ? payload.activeServerId : null,
          status: payload.status ?? "unknown",
          hasStagedConfig: Boolean(payload.hasStagedConfig),
          hasRunningConfig: Boolean(payload.hasRunningConfig),
          servers: Array.isArray(payload.servers)
            ? payload.servers
                .filter((entry): entry is ServerSummary => {
                  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
                    return false;
                  }
                  const cast = entry as Record<string, unknown>;
                  return (
                    typeof cast.serverId === "string" &&
                    typeof cast.serverIdentifier === "string" &&
                    typeof cast.url === "string" &&
                    typeof cast.port === "string" &&
                    typeof cast.collectionCount === "number" &&
                    typeof cast.updatedAt === "string" &&
                    typeof cast.isActive === "boolean"
                  );
                })
                .map((entry) => ({ ...entry }))
            : [],
          replicationEndpointTest,
          mongoConnectionTest
        });
        return;
      }

      if (payload.type === "server:deploying") {
        console.log("[WS event] server:deploying", payload);
        suppressStageValidationTests.value = true;
        deploymentMessage.value = payload.message ?? "Server is being deployed.";
        return;
      }

      if (payload.type === "server:deployed") {
        console.log("[WS event] server:deployed", payload);
        suppressStageValidationTests.value = false;
        deploymentMessage.value = "";
        return;
      }

      if (payload.type === "server:deploy-failed") {
        console.log("[WS event] server:deploy-failed", payload);
        suppressStageValidationTests.value = false;
        deploymentMessage.value = payload.message ?? "Deployment failed.";
        return;
      }

      if (payload.type === "server:stopped") {
        console.log("[WS event] server:stopped", payload);
        return;
      }

      if (payload.type === "server:started") {
        console.log("[WS event] server:started", payload);
        return;
      }

      if (payload.type === "server:runtime-log") {
        const logPayload = payload.log;
        if (logPayload && typeof logPayload === "object" && !Array.isArray(logPayload)) {
          const cast = logPayload as {
            at?: unknown;
            level?: unknown;
            area?: unknown;
            message?: unknown;
            collection?: unknown;
            details?: unknown;
          };
          if (
            typeof cast.at === "string" &&
            (cast.level === "info" || cast.level === "warn" || cast.level === "error") &&
            (cast.area === "runtime" || cast.area === "mongo" || cast.area === "replication") &&
            typeof cast.message === "string"
          ) {
            prependRuntimeLog({
              at: cast.at,
              level: cast.level,
              area: cast.area,
              message: cast.message,
              collection: typeof cast.collection === "string" ? cast.collection : undefined,
              details: typeof cast.details === "string" ? cast.details : undefined
            });
          }
        }
        return;
      }

      if (payload.type === "server:collection-change") {
        const changePayload = payload.change;
        if (changePayload && typeof changePayload === "object" && !Array.isArray(changePayload)) {
          const cast = changePayload as {
            at?: unknown;
            collection?: unknown;
            changeCount?: unknown;
            operations?: unknown;
          };
          if (
            typeof cast.at === "string" &&
            typeof cast.collection === "string" &&
            typeof cast.changeCount === "number" &&
            Array.isArray(cast.operations)
          ) {
            lastCollectionChange.value = {
              at: cast.at,
              collection: cast.collection,
              changeCount: cast.changeCount,
              operations: cast.operations.filter((entry): entry is string => typeof entry === "string")
            };
            collectionChangeVersion.value += 1;
          }
        }
        return;
      }

      if (payload.type === "server:start-ignored") {
        console.log("[WS event] server:start-ignored", payload);
        deploymentMessage.value = payload.message ?? "Start was ignored.";
        return;
      }

      if (payload.type === "server:deploy-ignored") {
        console.log("[WS event] server:deploy-ignored", payload);
        deploymentMessage.value = payload.message ?? "Deploy was ignored.";
        return;
      }

      if (payload.type === "error") {
        console.log("[WS event] error", payload);
        deploymentMessage.value = payload.message ?? "Backend operation failed.";
        return;
      }

      console.log("[WS event] unhandled", payload);
    } catch {
      // Ignore malformed websocket payloads.
    }
  };

  socket.onerror = () => {
    websocketError.value = "WebSocket error.";
  };

  socket.onclose = () => {
    if (websocketClient === socket) {
      websocketClient = null;
    }

    if (!canConnectWebSocket()) {
      websocketState.value = "idle";
      return;
    }

    scheduleReconnect();
  };
}

function restartWebSocketConnection(): void {
  stopWebSocketConnection();
  if (canConnectWebSocket()) {
    connectWebSocket();
  }
}

async function refreshServerConfig(): Promise<void> {
  if (refreshInFlight) {
    return;
  }

  refreshInFlight = true;
  try {
    setupConfig.value = await getServerConfig();
    syncSelectedServerFromConfig(setupConfig.value);
    backendUnavailable.value = false;
    setupError.value = "";
  } catch {
    backendUnavailable.value = true;
    setupConfig.value = null;
    setupError.value = BACKEND_UNREACHABLE_MESSAGE;
  } finally {
    refreshInFlight = false;
  }
}

async function openSetupCard(): Promise<void> {
  setupError.value = "";
  setupSuccess.value = "";
  setupLoading.value = true;

  try {
    const currentConfig = await getServerConfig();
    setupConfig.value = currentConfig;
    syncSelectedServerFromConfig(currentConfig);
    isCreatingServer.value = false;
    backendUnavailable.value = false;
    isSetupCardOpen.value = true;
  } catch {
    backendUnavailable.value = true;
    setupError.value = BACKEND_UNREACHABLE_MESSAGE;
  } finally {
    setupLoading.value = false;
  }
}

async function saveSetup(payload: ServerSetup): Promise<void> {
  setupError.value = "";
  setupSuccess.value = "";
  console.log("[Setup save] staging server config", payload);

  try {
    if (isCreatingServer.value || !selectedServerId.value) {
      setupConfig.value = await createServer(payload);
    } else {
      setupConfig.value = await updateServer(selectedServerId.value, payload);
    }
    syncSelectedServerFromConfig(setupConfig.value);
    console.log("[Setup save] staged config response", setupConfig.value);
    backendUnavailable.value = false;
    isCreatingServer.value = false;
    isSetupCardOpen.value = false;
  } catch {
    console.log("[Setup save] failed to stage config");
    backendUnavailable.value = true;
    setupError.value = BACKEND_UNREACHABLE_MESSAGE;
  }
}

function canDeployStagedConfig(): boolean {
  return Boolean(
    websocketState.value === "connected" &&
      wsStatus.value?.hasStagedConfig
  );
}

function canStopServer(): boolean {
  return Boolean(websocketState.value === "connected" && wsStatus.value?.status === "running");
}

function canStartServer(): boolean {
  return Boolean(websocketState.value === "connected" && wsStatus.value?.status === "stopped" && hasServerSetup(setupConfig.value));
}

function deployStagedConfig(force = false): void {
  if (!websocketClient || websocketState.value !== "connected") {
    websocketError.value = "WebSocket is not connected.";
    return;
  }

  deploymentMessage.value = "Deployment requested.";
  websocketClient.send(JSON.stringify({ type: "server:deploy-staged-config", force }));
}

function shouldShowStatusReport(): boolean {
  return wsStatus.value?.status === "deploying";
}

async function selectActiveServer(serverId: string): Promise<void> {
  setupError.value = "";
  setupSuccess.value = "";
  setupLoading.value = true;
  try {
    setupConfig.value = await selectServer(serverId);
    syncSelectedServerFromConfig(setupConfig.value);
    backendUnavailable.value = false;
    activeTab.value = "setup";
  } catch {
    backendUnavailable.value = true;
    setupError.value = BACKEND_UNREACHABLE_MESSAGE;
  } finally {
    setupLoading.value = false;
  }
}

function onServerSelectChange(event: Event): void {
  const target = event.target as HTMLSelectElement | null;
  const serverId = target?.value?.trim() ?? "";
  if (!serverId || serverId === selectedServerId.value) {
    return;
  }
  void selectActiveServer(serverId);
}

function openCreateServer(): void {
  setupError.value = "";
  setupSuccess.value = "";
  isCreatingServer.value = true;
  isSetupCardOpen.value = true;
}

function canEditServer(): boolean {
  return Boolean(selectedServerId.value);
}

function canDeleteServer(): boolean {
  return availableServers.value.length > 0 && Boolean(selectedServerId.value);
}

function openDeleteServerConfirm(): void {
  if (!canDeleteServer()) {
    return;
  }
  isDeleteServerConfirmOpen.value = true;
}

function closeDeleteServerConfirm(): void {
  isDeleteServerConfirmOpen.value = false;
}

async function confirmDeleteServer(): Promise<void> {
  const targetServerId = selectedServerId.value;
  if (!targetServerId) {
    closeDeleteServerConfirm();
    return;
  }

  try {
    setupConfig.value = await deleteServer(targetServerId);
    syncSelectedServerFromConfig(setupConfig.value);
    activeTab.value = "setup";
  } finally {
    closeDeleteServerConfirm();
  }
}

function formatLogLine(entry: RuntimeLogEvent): string {
  const parts = [`[${entry.at}]`, `${entry.area.toUpperCase()}.${entry.level.toUpperCase()}`, entry.message];
  if (entry.collection) {
    parts.push(`collection=${entry.collection}`);
  }
  if (entry.details) {
    parts.push(`details=${entry.details}`);
  }
  return parts.join(" ");
}

function canOpenCollectionsTab(): boolean {
  return wsStatus.value?.status === "running";
}

function stagedStatusLabel(config: ServerConfigResponse | null): string {
  const runtimeStatus = wsStatus.value?.status;
  if (runtimeStatus === "running") {
    return "Running";
  }
  if (runtimeStatus === "stopped") {
    return hasValidStagedSetup(config) ? "Config Staged (Not Running)" : "Stopped";
  }
  if (runtimeStatus === "deploying") {
    return hasValidStagedSetup(config) ? "Config Staged (Not Running)" : "Deploying";
  }
  if (runtimeStatus === "staged") {
    return hasValidStagedSetup(config) ? "Config Staged (Not Running)" : "Staged";
  }

  if (!hasValidStagedSetup(config)) {
    return "No staged config";
  }

  // Fallback only when websocket status hasn't arrived yet.
  return config?.runningServerSetup ? "Config Staged (Running)" : "Config Staged (Not Running)";
}

function statusServerName(): string {
  const configuredName = setupConfig.value?.effectiveServerSetup?.serverIdentifier?.trim();
  if (configuredName) {
    return configuredName;
  }

  return wsStatus.value?.serverId ?? "unknown";
}

async function openDeployConfirm(): Promise<void> {
  if (!canDeployStagedConfig()) {
    return;
  }

  console.log("[Deploy validation] opening modal and starting validation.");
  suppressStageValidationTests.value = true;
  isDeployValidationModalOpen.value = true;
  isDeployValidating.value = true;
  deployValidationError.value = "";
  deployValidationResult.value = null;

  try {
    const result = await validateDeploy();
    console.log("[Deploy validation] result", result);
    deployValidationResult.value = result;
    if (!result.hasFailures) {
      isDeployValidationModalOpen.value = false;
      deployStagedConfig(true);
    }
  } catch (error) {
    console.log("[Deploy validation] failed", error);
    deployValidationError.value = error instanceof Error && error.message ? error.message : "Deploy validation failed.";
  } finally {
    isDeployValidating.value = false;
  }
}

function closeDeployConfirm(): void {
  suppressStageValidationTests.value = false;
  isDeployValidationModalOpen.value = false;
  isDeployValidating.value = false;
  deployValidationError.value = "";
  deployValidationResult.value = null;
}

function closeDeployConfirmKeepSuppression(): void {
  isDeployValidationModalOpen.value = false;
  isDeployValidating.value = false;
  deployValidationError.value = "";
  deployValidationResult.value = null;
}

function confirmDeployStagedConfig(): void {
  console.log("[Deploy validation] continue regardless selected.");
  deployStagedConfig(true);
  closeDeployConfirmKeepSuppression();
}

function deployValidationFailures(): string[] {
  if (!deployValidationResult.value) {
    return [];
  }

  const failures: string[] = [];
  for (const test of deployValidationResult.value.replicationTests) {
    if (!test.ok) {
      failures.push(`Replication ${test.collection}: ${test.httpStatus ?? "no response"}`);
    }
  }

  if (!deployValidationResult.value.mongoConnectionTest.ok) {
    failures.push(`MongoDB: ${deployValidationResult.value.mongoConnectionTest.error ?? "unknown error"}`);
  }

  return failures;
}

function openStopConfirm(): void {
  if (!canStopServer()) {
    return;
  }
  isStopConfirmOpen.value = true;
}

function closeStopConfirm(): void {
  isStopConfirmOpen.value = false;
}

function openClearLogsConfirm(): void {
  isClearLogsConfirmOpen.value = true;
}

function closeClearLogsConfirm(): void {
  isClearLogsConfirmOpen.value = false;
}

async function confirmClearLogs(): Promise<void> {
  try {
    await clearRuntimeLogs();
    runtimeLogs.value = [];
  } finally {
    closeClearLogsConfirm();
  }
}

function openExportLogsConfirm(): void {
  isExportLogsConfirmOpen.value = true;
}

function closeExportLogsConfirm(): void {
  isExportLogsConfirmOpen.value = false;
}

function confirmExportLogs(): void {
  const content = runtimeLogs.value.map((entry) => formatLogLine(entry)).join("\n");
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  anchor.href = url;
  anchor.download = `runtime-logs-${timestamp}.txt`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
  closeExportLogsConfirm();
}

function toggleRuntimeLogs(): void {
  showRuntimeLogs.value = !showRuntimeLogs.value;
}

function confirmStopServer(): void {
  if (!websocketClient || websocketState.value !== "connected") {
    websocketError.value = "WebSocket is not connected.";
    closeStopConfirm();
    return;
  }

  websocketClient.send(JSON.stringify({ type: "server:stop-server" }));
  closeStopConfirm();
}

function startServer(): void {
  if (!websocketClient || websocketState.value !== "connected") {
    websocketError.value = "WebSocket is not connected.";
    return;
  }

  websocketClient.send(JSON.stringify({ type: "server:start-server" }));
}

async function saveCredentials(payload: { username: string; password: string }): Promise<void> {
  await updateCredentials(payload.username, payload.password);
  currentUsername.value = payload.username;
  emit("usernameUpdated", payload.username);
  isCredentialsCardOpen.value = false;
}

function logout(): void {
  stopWebSocketConnection();
  markManualLogout();
  emit("logout");
}
</script>

<template>
  <main class="min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-slate-800 text-slate-100">
    <section class="min-h-screen">
      <header class="border-b border-slate-700/70 bg-slate-950/60 backdrop-blur">
        <div class="flex w-full items-center justify-between px-6 py-4">
          <h1 class="text-lg font-semibold tracking-tight">RXDB Server Workbench v{{ appVersion }}</h1>

          <div ref="dropdownRoot" class="relative">
            <button
              type="button"
              class="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 transition hover:border-slate-500"
              @click="dropdownOpen = !dropdownOpen"
            >
              <span class="inline-flex h-6 w-6 items-center justify-center rounded-full bg-slate-700 text-slate-200">
                <User class="h-4 w-4" aria-hidden="true" />
              </span>
              <span>{{ currentUsername }}</span>
            </button>

            <div
              v-if="dropdownOpen"
              class="absolute right-0 z-10 mt-2 w-52 rounded-lg border border-slate-700 bg-slate-900 p-1 shadow-2xl shadow-black/30"
            >
              <button
                type="button"
                class="block w-full rounded-md px-3 py-2 text-left text-sm text-slate-100 transition hover:bg-slate-800"
                @click="isCredentialsCardOpen = true; dropdownOpen = false"
              >
                Change username/password
              </button>
              <button
                type="button"
                class="block w-full rounded-md px-3 py-2 text-left text-sm text-slate-100 transition hover:bg-slate-800"
                @click="logout"
              >
                Logout
              </button>
            </div>
          </div>
        </div>
      </header>

      <div class="mx-[30px] pt-4 pb-10">
        <div class="max-h-[87.96vh] space-y-5 overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900/60 p-6">
          <h2 class="text-xl font-semibold">Welcome, {{ currentUsername }}</h2>

          <div class="flex items-end gap-1 border-b border-slate-700/70">
            <button
              type="button"
              class="tab-trigger"
              :class="activeTab === 'setup' ? 'tab-trigger-active' : 'tab-trigger-inactive'"
              @click="activeTab = 'setup'"
            >
              Setup
            </button>
            <button
              type="button"
              class="tab-trigger"
              :class="
                !canOpenCollectionsTab()
                  ? 'tab-trigger-disabled'
                  : activeTab === 'collections'
                    ? 'tab-trigger-active'
                    : 'tab-trigger-inactive'
              "
              :disabled="!canOpenCollectionsTab()"
              @click="activeTab = 'collections'"
            >
              Collections
            </button>
          </div>

          <div v-show="activeTab === 'setup'" class="flex flex-wrap items-end gap-3 rounded-lg border border-slate-700 bg-slate-950/50 p-3">
            <label class="min-w-64 flex-1 text-sm">
              <span class="mb-1 block text-slate-300">Active Server</span>
              <select
                :value="selectedServerId ?? ''"
                class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none transition focus:border-sky-500"
                :disabled="setupLoading || availableServers.length === 0"
                @change="onServerSelectChange"
              >
                <option v-if="availableServers.length === 0" value="">No servers configured</option>
                <option v-for="server in availableServers" :key="server.serverId" :value="server.serverId">
                  {{ server.serverIdentifier }} ({{ server.url }}:{{ server.port }})
                </option>
              </select>
            </label>
            <button
              type="button"
              class="rounded-lg border border-emerald-500/60 bg-emerald-600/20 px-4 py-2 text-sm font-medium text-emerald-200 transition hover:bg-emerald-600/30"
              @click="openCreateServer"
            >
              Add Server
            </button>
            <button
              type="button"
              class="rounded-lg border border-emerald-500/60 bg-emerald-600/20 px-4 py-2 text-sm font-medium text-emerald-200 transition hover:bg-emerald-600/30 disabled:cursor-not-allowed disabled:opacity-60"
              :disabled="!canEditServer()"
              @click="openSetupCard"
            >
              Edit Server
            </button>
            <button
              type="button"
              class="rounded-lg border border-rose-500/60 bg-rose-600/20 px-4 py-2 text-sm font-medium text-rose-200 transition hover:bg-rose-600/30 disabled:cursor-not-allowed disabled:opacity-60"
              :disabled="!canDeleteServer()"
              @click="openDeleteServerConfirm"
            >
              Delete Server
            </button>
          </div>

          <SetupTab
            v-show="activeTab === 'setup'"
            :setup-loading="setupLoading"
            :ws-status="wsStatus"
            :can-deploy-staged-config="canDeployStagedConfig()"
            :can-stop-server="canStopServer()"
            :can-start-server="canStartServer()"
            :setup-config="setupConfig"
            :has-server-setup="hasServerSetup(setupConfig)"
            :backend-unavailable="backendUnavailable"
            :backend-unreachable-message="BACKEND_UNREACHABLE_MESSAGE"
            :status-label="stagedStatusLabel(setupConfig)"
            :show-stage-validation-tests="shouldShowStageValidationTests()"
            :replication-endpoint-test="activeReplicationEndpointTest()"
            :mongo-connection-test="activeMongoConnectionTest()"
            :websocket-state="websocketState"
            :websocket-error="websocketError"
            :show-status-report="shouldShowStatusReport()"
            :status-server-name="statusServerName()"
            :deployment-message="deploymentMessage"
            :setup-error="setupError"
            :setup-success="setupSuccess"
            :runtime-logs="runtimeLogs"
            :format-log-timestamp="formatLogTimestamp"
            :show-runtime-logs="showRuntimeLogs"
            @open-deploy-confirm="openDeployConfirm"
            @open-stop-confirm="openStopConfirm"
            @start-server="startServer"
            @request-clear-logs="openClearLogsConfirm"
            @request-export-logs="openExportLogsConfirm"
            @toggle-runtime-logs="toggleRuntimeLogs"
          />

          <CollectionsTab
            v-show="activeTab === 'collections'"
            :collections="setupConfig?.effectiveServerSetup?.collections ?? []"
            :active-server-id="setupConfig?.activeServerId ?? null"
            :rxdb-server-url="setupConfig?.effectiveServerSetup?.url ?? ''"
            :rxdb-server-port="setupConfig?.effectiveServerSetup?.port ?? ''"
            :rxdb-server-auth-header="setupConfig?.effectiveServerSetup?.authHeader ?? ''"
            :schema-validation-enabled="setupConfig?.effectiveServerSetup?.schemaValidationEnabled ?? true"
            :schemas-by-collection="setupConfig?.effectiveServerSetup?.schemasByCollection ?? {}"
            :last-collection-change="lastCollectionChange"
            :collection-change-version="collectionChangeVersion"
          />
        </div>
      </div>

      <SetupCard
        v-if="isSetupCardOpen"
        :initial-setup="setupCardInitialSetup"
        :persist-schema-changes="!isCreatingServer"
        @close="isSetupCardOpen = false; isCreatingServer = false"
        @save="saveSetup"
      />

      <CredentialsCard
        v-if="isCredentialsCardOpen"
        :initial-username="currentUsername"
        @close="isCredentialsCardOpen = false"
        @save="saveCredentials"
      />

      <div v-if="isDeployValidationModalOpen" class="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-black/60 px-4 py-4 sm:items-center">
        <div class="my-auto w-full max-w-md max-h-[calc(100vh-2rem)] overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl shadow-black/40">
          <h3 class="text-lg font-semibold tracking-tight text-slate-100">Validating Deployment</h3>
          <p v-if="isDeployValidating" class="mt-2 text-sm text-amber-300">Validating endpoints and MongoDB connection...</p>
          <p v-else-if="deployValidationError" class="mt-2 text-sm text-rose-300">{{ deployValidationError }}</p>
          <template v-else-if="deployValidationResult?.hasFailures">
            <p class="mt-2 text-sm text-rose-300">Validation found failures.</p>
            <ul class="mt-2 list-disc space-y-1 pl-5 text-sm text-rose-200">
              <li v-for="failure in deployValidationFailures()" :key="failure">{{ failure }}</li>
            </ul>
            <p class="mt-3 text-sm text-slate-300">Continue deployment regardless?</p>
          </template>
          <p v-else class="mt-2 text-sm text-slate-300">Validation passed. Starting deployment...</p>

          <div class="mt-5 flex items-center justify-end gap-2">
            <button
              type="button"
              class="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 transition hover:bg-slate-800"
              :disabled="isDeployValidating"
              @click="closeDeployConfirm"
            >
              Cancel
            </button>
            <button
              v-if="!isDeployValidating && (deployValidationError || deployValidationResult?.hasFailures)"
              type="button"
              class="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-amber-500"
              @click="confirmDeployStagedConfig"
            >
              Continue Regardless
            </button>
          </div>
        </div>
      </div>

      <div v-if="isStopConfirmOpen" class="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-black/60 px-4 py-4 sm:items-center">
        <div class="my-auto w-full max-w-md max-h-[calc(100vh-2rem)] overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl shadow-black/40">
          <h3 class="text-lg font-semibold tracking-tight text-slate-100">Confirm Stop</h3>
          <p class="mt-2 text-sm text-slate-300">Stop the running server instance?</p>
          <div class="mt-5 flex items-center justify-end gap-2">
            <button
              type="button"
              class="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 transition hover:bg-slate-800"
              @click="closeStopConfirm"
            >
              Cancel
            </button>
            <button
              type="button"
              class="rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-rose-500"
              @click="confirmStopServer"
            >
              Stop Server
            </button>
          </div>
        </div>
      </div>

      <div v-if="isClearLogsConfirmOpen" class="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-black/60 px-4 py-4 sm:items-center">
        <div class="my-auto w-full max-w-md max-h-[calc(100vh-2rem)] overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl shadow-black/40">
          <h3 class="text-lg font-semibold tracking-tight text-slate-100">Clear Runtime Logs</h3>
          <p class="mt-2 text-sm text-slate-300">This will permanently remove all runtime logs. Continue?</p>
          <div class="mt-5 flex items-center justify-end gap-2">
            <button
              type="button"
              class="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 transition hover:bg-slate-800"
              @click="closeClearLogsConfirm"
            >
              Cancel
            </button>
            <button
              type="button"
              class="rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-rose-500"
              @click="confirmClearLogs"
            >
              Clear Logs
            </button>
          </div>
        </div>
      </div>

      <div v-if="isExportLogsConfirmOpen" class="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-black/60 px-4 py-4 sm:items-center">
        <div class="my-auto w-full max-w-md max-h-[calc(100vh-2rem)] overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl shadow-black/40">
          <h3 class="text-lg font-semibold tracking-tight text-slate-100">Export Runtime Logs</h3>
          <div class="mt-5 flex items-center justify-end gap-2">
            <button
              type="button"
              class="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 transition hover:bg-slate-800"
              @click="closeExportLogsConfirm"
            >
              Cancel
            </button>
            <button
              type="button"
              class="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-sky-500"
              @click="confirmExportLogs"
            >
              Export Logs
            </button>
          </div>
        </div>
      </div>

      <div v-if="isDeleteServerConfirmOpen" class="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-black/60 px-4 py-4 sm:items-center">
        <div class="my-auto w-full max-w-md max-h-[calc(100vh-2rem)] overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl shadow-black/40">
          <h3 class="text-lg font-semibold tracking-tight text-slate-100">Delete Server</h3>
          <p class="mt-2 text-sm text-slate-300">Delete selected server configuration? Running runtime will be stopped first.</p>
          <div class="mt-5 flex items-center justify-end gap-2">
            <button
              type="button"
              class="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 transition hover:bg-slate-800"
              @click="closeDeleteServerConfirm"
            >
              Cancel
            </button>
            <button
              type="button"
              class="rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-rose-500"
              @click="confirmDeleteServer"
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    </section>
  </main>
</template>

<style scoped>
.tab-trigger {
  margin-bottom: -1px;
  border: 1px solid transparent;
  border-top-left-radius: 0.5rem;
  border-top-right-radius: 0.5rem;
  padding: 0.5rem 1rem;
  font-size: 0.875rem;
  font-weight: 500;
  transition: color 0.15s ease, background-color 0.15s ease, border-color 0.15s ease;
}

.tab-trigger-active {
  border-color: rgb(51 65 85 / 1);
  border-bottom-color: rgb(15 23 42 / 0.65);
  background: rgb(15 23 42 / 0.65);
  color: rgb(241 245 249 / 1);
}

.tab-trigger-inactive {
  color: rgb(148 163 184 / 1);
}

.tab-trigger-inactive:hover {
  border-color: rgb(51 65 85 / 0.7);
  background: rgb(30 41 59 / 0.5);
  color: rgb(241 245 249 / 1);
}

.tab-trigger-disabled {
  cursor: not-allowed;
  color: rgb(100 116 139 / 1);
  opacity: 0.7;
}
</style>

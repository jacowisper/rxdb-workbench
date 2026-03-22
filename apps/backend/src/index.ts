import cors from "cors";
import express from "express";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import {
  SingleServerRuntimeController,
  type RuntimeCollectionChangeEvent,
  type RuntimeLogEvent
} from "./runtime/singleServerRuntimeController.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const app = express();
const port = Number(process.env.BACKEND_PORT ?? process.env.PORT ?? 4000);
const defaultWebsocketPort = Number(
  process.env.BACKEND_DEFAULT_WEBSOCKET_PORT ?? process.env.BACKEND_WEBSOCKET_PORT ?? process.env.WEBSOCKET_PORT ?? 4001
);
const backendJsonBodyLimit = process.env.BACKEND_JSON_BODY_LIMIT ?? "10mb";
const backendRuntimeLogWebhookUrl = process.env.BACKEND_RUNTIME_LOG_WEBHOOK_URL ?? "";
const backendDefaultMongoConnectionString = process.env.BACKEND_DEFAULT_MONGODB_CONNECTION_STRING ?? "";
const backendToken =
  process.env.BACKEND_TOKEN ?? process.env.BACKENDTOKEN ?? process.env["Backend Token"] ?? "";

if (!backendToken) {
  throw new Error("Missing BACKEND_TOKEN in environment.");
}

type SettingsStore = Record<string, unknown>;

type ServerSetup = {
  serverIdentifier: string;
  url: string;
  port: string;
  resyncBackendCollectionsFromScratch: boolean;
  schemaValidationEnabled: boolean;
  mongodbConnectionString: string;
  authHeader: string;
  collections: string[];
  collectionEndpoints: Record<string, { replEndpoint: string; restEndpoint: string }>;
  schemasByCollection: Record<string, unknown>;
};

type ReplicationEndpointTestResult = {
  collection: string;
  endpoint: string;
  ok: boolean;
  httpStatus: number | null;
};

type MongoConnectionTestResult = {
  ok: boolean;
  error: string | null;
};

type DeployValidationResult = {
  replicationTests: ReplicationEndpointTestResult[];
  mongoConnectionTest: MongoConnectionTestResult;
  hasFailures: boolean;
};

type RuntimeStatus = "stopped" | "running" | "deploying" | "staged";

type BackendConfig = {
  runningServerSetup: ServerSetup | null;
  stagedServerSetup: ServerSetup | null;
  replicationEndpointTest: ReplicationEndpointTestResult | null;
  mongoConnectionTest: MongoConnectionTestResult | null;
  settings: SettingsStore;
  runtime: {
    serverId: string;
    status: RuntimeStatus;
  };
};

type RxdbState = {
  initialized: boolean;
  lastSetupAt: string | null;
  lastSetupAttemptAt: string | null;
};

type ClientCommand =
  | { type: "server:subscribe-status" }
  | { type: "server:deploy-staged-config"; force: boolean }
  | { type: "server:stop-server" }
  | { type: "server:start-server" };

const backendConfigFilePath = process.env.BACKEND_CONFIG_FILE
  ? path.resolve(process.cwd(), process.env.BACKEND_CONFIG_FILE)
  : path.resolve(__dirname, "../data/backend-config.json");

const rxdbState: RxdbState = {
  initialized: false,
  lastSetupAt: null,
  lastSetupAttemptAt: null
};

function getDefaultServerSetup(): ServerSetup {
  return {
    serverIdentifier: "",
    url: "",
    port: "",
    resyncBackendCollectionsFromScratch: true,
    schemaValidationEnabled: true,
    mongodbConnectionString: backendDefaultMongoConnectionString,
    authHeader: "",
    collections: [],
    collectionEndpoints: {},
    schemasByCollection: {}
  };
}

function getDefaultBackendConfig(): BackendConfig {
  return {
    runningServerSetup: null,
    stagedServerSetup: null,
    replicationEndpointTest: null,
    mongoConnectionTest: null,
    settings: {},
    runtime: {
      serverId: "rxdb-server-1",
      status: "stopped"
    }
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeServerSetup(input: unknown): ServerSetup {
  if (!isPlainObject(input)) {
    return getDefaultServerSetup();
  }

  return {
    serverIdentifier: typeof input.serverIdentifier === "string" ? input.serverIdentifier : "",
    url: typeof input.url === "string" ? input.url : "",
    port: typeof input.port === "string" ? input.port : "",
    resyncBackendCollectionsFromScratch:
      typeof input.resyncBackendCollectionsFromScratch === "boolean" ? input.resyncBackendCollectionsFromScratch : true,
    schemaValidationEnabled: typeof input.schemaValidationEnabled === "boolean" ? input.schemaValidationEnabled : true,
    mongodbConnectionString:
      typeof input.mongodbConnectionString === "string" ? input.mongodbConnectionString : backendDefaultMongoConnectionString,
    authHeader: typeof input.authHeader === "string" ? input.authHeader : "",
    collections: Array.isArray(input.collections)
      ? input.collections.filter((name): name is string => typeof name === "string")
      : [],
    collectionEndpoints: isPlainObject(input.collectionEndpoints)
      ? Object.fromEntries(
          Object.entries(input.collectionEndpoints)
            .filter(([collectionName, endpointValue]) => {
              if (typeof collectionName !== "string" || !isPlainObject(endpointValue)) {
                return false;
              }
              const replEndpoint = endpointValue.replEndpoint;
              const restEndpoint = endpointValue.restEndpoint;
              return typeof replEndpoint === "string" && typeof restEndpoint === "string";
            })
            .map(([collectionName, endpointValue]) => [
              collectionName,
              {
                replEndpoint: String((endpointValue as { replEndpoint: unknown }).replEndpoint),
                restEndpoint: String((endpointValue as { restEndpoint: unknown }).restEndpoint)
              }
            ])
        )
      : {},
    schemasByCollection: isPlainObject(input.schemasByCollection) ? input.schemasByCollection : {}
  };
}

function normalizeNullableServerSetup(input: unknown): ServerSetup | null {
  if (input === null || input === undefined) {
    return null;
  }

  const normalized = normalizeServerSetup(input);
  const hasValue =
    Boolean(
      normalized.serverIdentifier ||
        normalized.url ||
        normalized.port ||
        normalized.authHeader ||
        normalized.collections.length ||
        Object.keys(normalized.schemasByCollection).length
    );

  return hasValue ? normalized : null;
}

function migrateLocalhostMongoConnectionString(setup: ServerSetup | null): ServerSetup | null {
  if (!setup) {
    return null;
  }

  if (!backendDefaultMongoConnectionString.trim()) {
    return setup;
  }

  const normalizedMongo = setup.mongodbConnectionString.trim().toLowerCase();
  if (normalizedMongo !== "mongodb://localhost:27017" && normalizedMongo !== "mongodb://127.0.0.1:27017") {
    return setup;
  }

  return {
    ...setup,
    mongodbConnectionString: backendDefaultMongoConnectionString
  };
}

function migrateBackendConfig(config: BackendConfig): BackendConfig {
  return {
    ...config,
    runningServerSetup: migrateLocalhostMongoConnectionString(config.runningServerSetup),
    stagedServerSetup: migrateLocalhostMongoConnectionString(config.stagedServerSetup)
  };
}

function isValidServerSetup(setup: ServerSetup | null): setup is ServerSetup {
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

function normalizeBackendConfig(input: unknown): BackendConfig {
  if (!isPlainObject(input)) {
    return getDefaultBackendConfig();
  }

  const runtime = isPlainObject(input.runtime) ? input.runtime : {};
  const status = runtime.status;
  const replicationEndpointTest = isPlainObject(input.replicationEndpointTest) ? input.replicationEndpointTest : null;
  const mongoConnectionTest = isPlainObject(input.mongoConnectionTest) ? input.mongoConnectionTest : null;
  const replicationEndpointTestNormalized =
    replicationEndpointTest &&
    typeof replicationEndpointTest.collection === "string" &&
    typeof replicationEndpointTest.endpoint === "string" &&
    typeof replicationEndpointTest.ok === "boolean" &&
    (typeof replicationEndpointTest.httpStatus === "number" || replicationEndpointTest.httpStatus === null)
      ? {
          collection: replicationEndpointTest.collection,
          endpoint: replicationEndpointTest.endpoint,
          ok: replicationEndpointTest.ok,
          httpStatus: replicationEndpointTest.httpStatus
        }
      : null;
  const mongoConnectionTestNormalized =
    mongoConnectionTest &&
    typeof mongoConnectionTest.ok === "boolean" &&
    (typeof mongoConnectionTest.error === "string" || mongoConnectionTest.error === null)
      ? {
          ok: mongoConnectionTest.ok,
          error: mongoConnectionTest.error
        }
      : null;

  return {
    runningServerSetup: normalizeNullableServerSetup(input.runningServerSetup),
    stagedServerSetup: normalizeNullableServerSetup(input.stagedServerSetup),
    replicationEndpointTest: replicationEndpointTestNormalized,
    mongoConnectionTest: mongoConnectionTestNormalized,
    settings: isPlainObject(input.settings) ? input.settings : {},
      runtime: {
        serverId: typeof runtime.serverId === "string" ? runtime.serverId : "rxdb-server-1",
        status: status === "running" || status === "deploying" || status === "stopped" || status === "staged" ? status : "stopped"
      }
  };
}

function persistBackendConfig(config: BackendConfig): void {
  mkdirSync(path.dirname(backendConfigFilePath), { recursive: true });
  writeFileSync(backendConfigFilePath, JSON.stringify(config, null, 2), "utf-8");
}

function loadBackendConfig(): BackendConfig {
  if (!existsSync(backendConfigFilePath)) {
    const defaults = getDefaultBackendConfig();
    persistBackendConfig(defaults);
    return defaults;
  }

  try {
    const raw = readFileSync(backendConfigFilePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    const normalized = normalizeBackendConfig(parsed);
    const migrated = migrateBackendConfig(normalized);
    persistBackendConfig(migrated);
    return migrated;
  } catch {
    const defaults = getDefaultBackendConfig();
    persistBackendConfig(defaults);
    return defaults;
  }
}

function resolveStartupWebSocketPort(): number {
  return defaultWebsocketPort;
}

function getEffectiveServerSetup(config: BackendConfig): ServerSetup | null {
  return config.stagedServerSetup ?? config.runningServerSetup;
}

function deriveDefaultReplEndpoint(collectionName: string): string {
  const trimmed = collectionName.trim();
  if (!trimmed) {
    return "";
  }

  return `repl${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}/0`;
}

function buildReplicationEndpointUrl(setup: ServerSetup, collection: string): string {
  const base = setup.url.trim().replace(/\/+$/, "");
  const endpoint = (setup.collectionEndpoints[collection]?.replEndpoint ?? deriveDefaultReplEndpoint(collection)).trim();
  const withPort = setup.port.trim() ? `${base}:${setup.port.trim()}` : base;
  const normalizedEndpoint = endpoint.replace(/^\/+/, "").replace(/\/+$/, "");
  return `${withPort}/${normalizedEndpoint}/pull?lwt=0&id=&limit=100`;
}

function parseCollectionSelectorQuery(queryText: unknown): Record<string, unknown> | null {
  if (queryText === undefined || queryText === null) {
    return null;
  }

  if (typeof queryText !== "string") {
    throw new Error("Invalid query. Expected JSON string.");
  }

  const trimmed = queryText.trim();
  if (!trimmed) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("Invalid query JSON.");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid query JSON. Expected an object.");
  }

  return parsed as Record<string, unknown>;
}

async function testFirstCollectionReplicationEndpoint(setup: ServerSetup): Promise<ReplicationEndpointTestResult | null> {
  const firstCollection = setup.collections[0]?.trim();
  if (!firstCollection) {
    return null;
  }

  return testCollectionReplicationEndpoint(setup, firstCollection);
}

async function testCollectionReplicationEndpoint(setup: ServerSetup, collection: string): Promise<ReplicationEndpointTestResult> {
  const normalizedCollection = collection.trim();
  const endpointUrl = buildReplicationEndpointUrl(setup, normalizedCollection);
  const hasAuthHeader = Boolean(setup.authHeader.trim());
  console.log(
    hasAuthHeader
      ? `[Replication Test] curl -X GET "${endpointUrl}" -H "Authorization: ${setup.authHeader}"`
      : `[Replication Test] curl -X GET "${endpointUrl}"`
  );

  try {
    const headers = hasAuthHeader ? { Authorization: setup.authHeader } : undefined;
    const response = await fetch(endpointUrl, {
      method: "GET",
      headers
    });
    console.log(`[Replication Test Result] collection=${normalizedCollection} ok=${response.ok} httpStatus=${response.status}`);

    return {
      collection: normalizedCollection,
      endpoint: endpointUrl,
      ok: response.ok,
      httpStatus: response.status
    };
  } catch {
    console.log(`[Replication Test Result] collection=${normalizedCollection} ok=false httpStatus=null (request failed)`);
    return {
      collection: normalizedCollection,
      endpoint: endpointUrl,
      ok: false,
      httpStatus: null
    };
  }
}

let backendConfig = loadBackendConfig();
let replicationEndpointTestRunId = 0;
let collectionResetRunId = 0;
const runtimeLogBuffer: RuntimeLogEvent[] = [];
const runtimeLogBufferMaxItems = 500;
const websocketPort = resolveStartupWebSocketPort();
const websocketServer = new WebSocketServer({ port: websocketPort });
const subscribedClients = new Set<WebSocket>();

function sendJson(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === 1) {
    socket.send(JSON.stringify(payload));
  }
}

function emitRuntimeLog(event: RuntimeLogEvent): void {
  runtimeLogBuffer.push(event);
  if (runtimeLogBuffer.length > runtimeLogBufferMaxItems) {
    runtimeLogBuffer.shift();
  }

  for (const client of subscribedClients) {
    sendJson(client, {
      type: "server:runtime-log",
      log: event
    });
  }
}

function emitCollectionChange(event: RuntimeCollectionChangeEvent): void {
  for (const client of subscribedClients) {
    sendJson(client, {
      type: "server:collection-change",
      change: event
    });
  }
}

const runtimeController = new SingleServerRuntimeController({
  webhookUrl: backendRuntimeLogWebhookUrl,
  onLog: emitRuntimeLog,
  onCollectionChange: emitCollectionChange
});

async function testMongoConnection(setup: ServerSetup): Promise<MongoConnectionTestResult> {
  const connectionString = setup.mongodbConnectionString.trim();
  if (!connectionString) {
    return {
      ok: false,
      error: "MongoDB connection string is empty."
    };
  }

  console.log(`[Mongo Test] Attempting MongoDB ping using configured connection string.`);
  const client = new MongoClient(connectionString, {
    serverSelectionTimeoutMS: 5000
  });

  try {
    await client.connect();
    await client.db().command({ ping: 1 });
    console.log("[Mongo Test Result] ok=true");
    return {
      ok: true,
      error: null
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "MongoDB connection failed.";
    console.log(`[Mongo Test Result] ok=false error=${message}`);
    return {
      ok: false,
      error: message
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function runDeployValidation(setup: ServerSetup): Promise<DeployValidationResult> {
  const collections = setup.collections.map((name) => name.trim()).filter(Boolean);
  const replicationTests = await Promise.all(collections.map((collection) => testCollectionReplicationEndpoint(setup, collection)));
  const mongoConnectionTest = await testMongoConnection(setup);
  const hasFailures = replicationTests.some((test) => !test.ok) || !mongoConnectionTest.ok;

  return {
    replicationTests,
    mongoConnectionTest,
    hasFailures
  };
}

function scheduleReplicationEndpointTest(setup: ServerSetup): void {
  const runId = ++replicationEndpointTestRunId;
  const setupSnapshot = JSON.parse(JSON.stringify(setup)) as ServerSetup;

  void Promise.all([testFirstCollectionReplicationEndpoint(setupSnapshot), testMongoConnection(setupSnapshot)]).then(
    ([replicationResult, mongoResult]) => {
    if (runId !== replicationEndpointTestRunId) {
      return;
    }

      backendConfig.replicationEndpointTest = replicationResult;
      backendConfig.mongoConnectionTest = mongoResult;
    try {
      persistBackendConfig(backendConfig);
    } catch {
      return;
    }
    broadcastServerStatus();
    }
  );
}

function normalizeServerIdentifierForMongo(serverIdentifier: string): string {
  const normalized = serverIdentifier
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "rxdb-runtime";
}

function deriveMongoRuntimeDatabaseName(setup: ServerSetup): string {
  return `rxdb-workbench-${normalizeServerIdentifierForMongo(setup.serverIdentifier)}-v0`;
}

function getRemovedCollections(previousSetup: ServerSetup | null, nextSetup: ServerSetup): string[] {
  if (!isValidServerSetup(previousSetup)) {
    return [];
  }

  const previousCollections = new Set(previousSetup.collections.map((name) => name.trim()).filter(Boolean));
  const nextCollections = new Set(nextSetup.collections.map((name) => name.trim()).filter(Boolean));
  return Array.from(previousCollections).filter((name) => !nextCollections.has(name));
}

function isNamespaceMissingError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const maybe = error as { code?: unknown; message?: unknown };
  if (maybe.code === 26) {
    return true;
  }

  return typeof maybe.message === "string" && maybe.message.toLowerCase().includes("ns not found");
}

async function cleanupRemovedCollectionsInMongo(previousSetup: ServerSetup, removedCollections: string[]): Promise<void> {
  if (removedCollections.length === 0) {
    return;
  }

  const runtimeDbName = deriveMongoRuntimeDatabaseName(previousSetup);
  const client = new MongoClient(previousSetup.mongodbConnectionString.trim(), {
    serverSelectionTimeoutMS: 10000
  });

  emitRuntimeLog({
    at: new Date().toISOString(),
    level: "info",
    area: "mongo",
    message: `Starting manual cleanup for removed collection(s): ${removedCollections.join(", ")}.`,
    details: `database=${runtimeDbName}`
  });

  try {
    await client.connect();
    const runtimeDb = client.db(runtimeDbName);
    const internalCollection = runtimeDb.collection("_rxdb_internal");

    for (const collectionName of removedCollections) {
      const query = {
        $or: [
          { "data.name": collectionName },
          { id: `collection|${collectionName}-0` },
          { key: `${collectionName}-0` }
        ]
      };

      const docs = await internalCollection.find(query).toArray();
      const connectedStorageCollectionNames = new Set<string>();
      for (const doc of docs) {
        const connectedStorages = (doc as { data?: { connectedStorages?: unknown } }).data?.connectedStorages;
        if (!Array.isArray(connectedStorages)) {
          continue;
        }
        for (const entry of connectedStorages) {
          if (entry && typeof entry === "object") {
            const collectionNameValue = (entry as { collectionName?: unknown }).collectionName;
            if (typeof collectionNameValue === "string" && collectionNameValue.trim()) {
              connectedStorageCollectionNames.add(collectionNameValue.trim());
            }
          }
        }
      }

      if (docs.length > 0) {
        await internalCollection.deleteMany(query);
      }

      emitRuntimeLog({
        at: new Date().toISOString(),
        level: "info",
        area: "mongo",
        message: `Removed _rxdb_internal metadata for collection "${collectionName}".`,
        details: `matchedDocs=${docs.length}`
      });

      for (const connectedStorageCollectionName of connectedStorageCollectionNames) {
        try {
          await runtimeDb.dropCollection(connectedStorageCollectionName);
          emitRuntimeLog({
            at: new Date().toISOString(),
            level: "info",
            area: "mongo",
            message: `Dropped connected storage collection "${connectedStorageCollectionName}".`,
            details: `removedCollection=${collectionName}`
          });
        } catch (error) {
          if (isNamespaceMissingError(error)) {
            continue;
          }
          throw error;
        }
      }

      try {
        await runtimeDb.dropCollection(collectionName);
        emitRuntimeLog({
          at: new Date().toISOString(),
          level: "info",
          area: "mongo",
          message: `Dropped removed data collection "${collectionName}".`
        });
      } catch (error) {
        if (isNamespaceMissingError(error)) {
          continue;
        }
        throw error;
      }
    }
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function dropRuntimeDatabaseForSetup(previousSetup: ServerSetup): Promise<void> {
  const runtimeDbName = deriveMongoRuntimeDatabaseName(previousSetup);
  const client = new MongoClient(previousSetup.mongodbConnectionString.trim(), {
    serverSelectionTimeoutMS: 10000
  });

  emitRuntimeLog({
    at: new Date().toISOString(),
    level: "warn",
    area: "mongo",
    message: `Dropping previous runtime database "${runtimeDbName}" due to server name change.`
  });

  try {
    await client.connect();
    await client.db(runtimeDbName).dropDatabase();
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function applyRunningSetup(setup: ServerSetup, previousSetup: ServerSetup | null = backendConfig.runningServerSetup): Promise<void> {
  const removedCollections = getRemovedCollections(previousSetup, setup);
  const previousValidSetup = isValidServerSetup(previousSetup);
  const serverNameChanged =
    previousValidSetup &&
    deriveMongoRuntimeDatabaseName(previousSetup) !== deriveMongoRuntimeDatabaseName(setup);

  if (removedCollections.length > 0 || serverNameChanged) {
    await runtimeController.stop();
    if (previousValidSetup) {
      await cleanupRemovedCollectionsInMongo(previousSetup, removedCollections);
      if (serverNameChanged) {
        await dropRuntimeDatabaseForSetup(previousSetup);
      }
    }
    await runtimeController.start(setup);
    return;
  }

  if (runtimeController.getState() === "running") {
    await runtimeController.reconcile(setup);
    return;
  }

  await runtimeController.start(setup);
}

function triggerHardResetCollection(collection: string): void {
  const runId = ++collectionResetRunId;
  const setup = backendConfig.runningServerSetup ?? getEffectiveServerSetup(backendConfig);
  if (!isValidServerSetup(setup)) {
    emitRuntimeLog({
      at: new Date().toISOString(),
      level: "error",
      area: "runtime",
      message: `Hard reset skipped for "${collection}".`,
      details: "No valid server setup is available."
    });
    return;
  }

  const normalizedCollection = collection.trim();
  if (!normalizedCollection || !setup.collections.includes(normalizedCollection)) {
    emitRuntimeLog({
      at: new Date().toISOString(),
      level: "error",
      area: "runtime",
      message: `Hard reset skipped for "${collection}".`,
      details: "Collection is not part of active setup."
    });
    return;
  }

  void (async () => {
    emitRuntimeLog({
      at: new Date().toISOString(),
      level: "warn",
      area: "runtime",
      message: `Starting hard reset for collection "${normalizedCollection}".`
    });

    try {
      await runtimeController.stop();
      await cleanupRemovedCollectionsInMongo(setup, [normalizedCollection]);

      if (runId !== collectionResetRunId) {
        emitRuntimeLog({
          at: new Date().toISOString(),
          level: "warn",
          area: "runtime",
          message: `Hard reset aborted for "${normalizedCollection}" due to newer reset request.`
        });
        return;
      }

      await runtimeController.start(setup);
      backendConfig.runningServerSetup = setup;
      backendConfig.runtime.status = "running";
      persistBackendConfig(backendConfig);
      broadcastServerStatus();
      emitRuntimeLog({
        at: new Date().toISOString(),
        level: "info",
        area: "runtime",
        message: `Hard reset completed for collection "${normalizedCollection}".`
      });
    } catch (error) {
      backendConfig.runtime.status = "stopped";
      persistBackendConfig(backendConfig);
      broadcastServerStatus();
      emitRuntimeLog({
        at: new Date().toISOString(),
        level: "error",
        area: "runtime",
        message: `Hard reset failed for collection "${normalizedCollection}".`,
        details: error instanceof Error ? error.message : "Unknown hard reset error."
      });
    }
  })();
}

app.use(cors());
app.use(express.json({ limit: backendJsonBodyLimit }));

app.use("/api", (req, res, next) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  return next();
});

app.use("/api", (req, res, next) => {
  const authorization = req.header("authorization");
  const expected = `Bearer ${backendToken}`;

  if (authorization !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  return next();
});

app.post("/api/settings/get", (req, res) => {
  const key = typeof req.body?.key === "string" ? req.body.key : null;

  if (!key) {
    return res.json({
      settings: backendConfig.settings,
      runningServerSetup: backendConfig.runningServerSetup,
      stagedServerSetup: backendConfig.stagedServerSetup,
      effectiveServerSetup: getEffectiveServerSetup(backendConfig)
    });
  }

  return res.json({
    key,
    value: Object.prototype.hasOwnProperty.call(backendConfig.settings, key) ? backendConfig.settings[key] : null
  });
});

app.post("/api/settings/update", (req, res) => {
  const body = req.body as { key?: unknown; value?: unknown; settings?: unknown };

  let changed = false;

  if (isPlainObject(body.settings)) {
    Object.assign(backendConfig.settings, body.settings);
    changed = true;
  }

  if (typeof body.key === "string") {
    backendConfig.settings[body.key] = body.value ?? null;
    changed = true;
  }

  if (!changed) {
    return res.status(400).json({ error: "Invalid payload. Expected settings object or key/value." });
  }

  try {
    persistBackendConfig(backendConfig);
  } catch {
    return res.status(500).json({ error: "Failed to persist backend config." });
  }

  return res.json({
    ok: true,
    settings: backendConfig.settings
  });
});

app.post("/api/server/config/get", (_req, res) => {
  return res.json({
    runningServerSetup: backendConfig.runningServerSetup,
    stagedServerSetup: backendConfig.stagedServerSetup,
    replicationEndpointTest: backendConfig.replicationEndpointTest,
    mongoConnectionTest: backendConfig.mongoConnectionTest,
    effectiveServerSetup: getEffectiveServerSetup(backendConfig)
  });
});

app.post("/api/server/config/stage", (req, res) => {
  const body = req.body as { serverSetup?: unknown };

  if (body.serverSetup === undefined) {
    return res.status(400).json({ error: "Invalid payload. Expected serverSetup." });
  }

  const normalized = normalizeNullableServerSetup(body.serverSetup);
  if (!isValidServerSetup(normalized)) {
    return res.status(400).json({ error: "Invalid serverSetup. Missing required fields." });
  }

  backendConfig.stagedServerSetup = normalized;
  backendConfig.runtime.status = "staged";
  backendConfig.replicationEndpointTest = null;
  backendConfig.mongoConnectionTest = null;
  scheduleReplicationEndpointTest(normalized);

  try {
    persistBackendConfig(backendConfig);
  } catch {
    return res.status(500).json({ error: "Failed to persist staged config." });
  }

  broadcastServerStatus();

  return res.json({
    ok: true,
    runningServerSetup: backendConfig.runningServerSetup,
    stagedServerSetup: backendConfig.stagedServerSetup,
    replicationEndpointTest: backendConfig.replicationEndpointTest,
    mongoConnectionTest: backendConfig.mongoConnectionTest,
    effectiveServerSetup: getEffectiveServerSetup(backendConfig)
  });
});

app.post("/api/server/config/update", (req, res) => {
  const body = req.body as { serverSetup?: unknown };

  if (body.serverSetup === undefined) {
    return res.status(400).json({ error: "Invalid payload. Expected serverSetup." });
  }

  const normalized = normalizeNullableServerSetup(body.serverSetup);
  if (!isValidServerSetup(normalized)) {
    return res.status(400).json({ error: "Invalid serverSetup. Missing required fields." });
  }

  backendConfig.stagedServerSetup = normalized;
  backendConfig.runtime.status = "staged";
  backendConfig.replicationEndpointTest = null;
  backendConfig.mongoConnectionTest = null;
  scheduleReplicationEndpointTest(normalized);

  try {
    persistBackendConfig(backendConfig);
  } catch {
    return res.status(500).json({ error: "Failed to persist staged config." });
  }

  broadcastServerStatus();

  return res.json({
    ok: true,
    runningServerSetup: backendConfig.runningServerSetup,
    stagedServerSetup: backendConfig.stagedServerSetup,
    replicationEndpointTest: backendConfig.replicationEndpointTest,
    mongoConnectionTest: backendConfig.mongoConnectionTest,
    effectiveServerSetup: getEffectiveServerSetup(backendConfig)
  });
});

app.post("/api/server/deploy/validate", async (_req, res) => {
  const stagedSetup = backendConfig.stagedServerSetup;
  if (!stagedSetup || !isValidServerSetup(stagedSetup)) {
    return res.status(400).json({ error: "No valid staged config exists. Save setup before deploy validation." });
  }

  try {
    const result = await runDeployValidation(stagedSetup);
    return res.json({
      ok: true,
      ...result
    });
  } catch {
    return res.status(500).json({ error: "Failed to run deploy validation." });
  }
});

app.post("/api/server/schema/get", (req, res) => {
  const body = req.body as { collection?: unknown };
  const collection = typeof body.collection === "string" ? body.collection.trim() : "";
  const setup = backendConfig.stagedServerSetup ?? backendConfig.runningServerSetup;
  const schemas = setup?.schemasByCollection ?? {};

  if (!collection) {
    return res.json({
      schemasByCollection: schemas
    });
  }

  return res.json({
    collection,
    schema: Object.prototype.hasOwnProperty.call(schemas, collection) ? schemas[collection] : null
  });
});

app.post("/api/server/schema/upsert", (req, res) => {
  const body = req.body as { collection?: unknown; schema?: unknown };
  const collection = typeof body.collection === "string" ? body.collection.trim() : "";

  if (!collection) {
    return res.status(400).json({ error: "Invalid payload. Expected collection." });
  }

  const targetSetup = backendConfig.stagedServerSetup ?? backendConfig.runningServerSetup;
  if (!targetSetup || !isValidServerSetup(targetSetup)) {
    return res.status(400).json({ error: "No valid server setup exists. Save setup before managing schemas." });
  }

  targetSetup.schemasByCollection[collection] = body.schema ?? null;
  if (!targetSetup.collections.includes(collection)) {
    targetSetup.collections.push(collection);
  }

  backendConfig.stagedServerSetup = targetSetup;

  try {
    persistBackendConfig(backendConfig);
  } catch {
    return res.status(500).json({ error: "Failed to persist schema." });
  }

  broadcastServerStatus();

  return res.json({
    ok: true,
    collection,
    schema: targetSetup.schemasByCollection[collection]
  });
});

app.post("/api/server/schema/remove", (req, res) => {
  const body = req.body as { collection?: unknown };
  const collection = typeof body.collection === "string" ? body.collection.trim() : "";

  if (!collection) {
    return res.status(400).json({ error: "Invalid payload. Expected collection." });
  }

  const targetSetup = backendConfig.stagedServerSetup ?? backendConfig.runningServerSetup;
  if (!targetSetup || !isValidServerSetup(targetSetup)) {
    return res.status(400).json({ error: "No valid server setup exists. Save setup before managing schemas." });
  }

  const hadSchema = Object.prototype.hasOwnProperty.call(targetSetup.schemasByCollection, collection);
  delete targetSetup.schemasByCollection[collection];

  backendConfig.stagedServerSetup = targetSetup;

  try {
    persistBackendConfig(backendConfig);
  } catch {
    return res.status(500).json({ error: "Failed to remove schema." });
  }

  broadcastServerStatus();

  return res.json({
    ok: true,
    collection,
    removed: hadSchema
  });
});

app.post("/api/rxdb/setup", (_req, res) => {
  rxdbState.lastSetupAttemptAt = new Date().toISOString();

  return res.json({
    ok: false,
    message: "RxDB setup is not wired yet. State remains uninitialized.",
    rxdb: rxdbState
  });
});

app.post("/api/server/runtime/logs/get", (_req, res) => {
  return res.json({
    logs: runtimeLogBuffer
  });
});

app.post("/api/server/runtime/logs/clear", (_req, res) => {
  const removed = runtimeLogBuffer.length;
  runtimeLogBuffer.length = 0;
  return res.json({
    ok: true,
    removed
  });
});

app.post("/api/server/collection/count", async (req, res) => {
  const body = req.body as { collection?: unknown; query?: unknown };
  const collection = typeof body.collection === "string" ? body.collection.trim() : "";
  if (!collection) {
    return res.status(400).json({ error: "Invalid payload. Expected collection." });
  }

  let selector: Record<string, unknown> | null = null;
  try {
    selector = parseCollectionSelectorQuery(body.query);
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : "Invalid query." });
  }

  if (runtimeController.getState() !== "running") {
    return res.status(400).json({ error: "Runtime is not running." });
  }

  try {
    const count = await runtimeController.getCollectionDocumentCount(collection, selector ?? undefined);
    return res.json({
      collection,
      count
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : "Failed to query collection count.";
    console.error(`[Collection Count Error] collection=${collection} details=${details}`);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    return res.status(500).json({ error: details });
  }
});

app.post("/api/server/collection/docs", async (req, res) => {
  const body = req.body as { collection?: unknown; limit?: unknown; page?: unknown; query?: unknown };
  const collection = typeof body.collection === "string" ? body.collection.trim() : "";
  if (!collection) {
    return res.status(400).json({ error: "Invalid payload. Expected collection." });
  }

  let selector: Record<string, unknown> | null = null;
  try {
    selector = parseCollectionSelectorQuery(body.query);
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : "Invalid query." });
  }

  const requestedLimit = typeof body.limit === "number" && Number.isFinite(body.limit) ? Math.floor(body.limit) : 100;
  const limit = Math.max(1, Math.min(100, requestedLimit));
  const requestedPage = typeof body.page === "number" && Number.isFinite(body.page) ? Math.floor(body.page) : 1;
  const page = Math.max(1, requestedPage);

  if (runtimeController.getState() !== "running") {
    return res.status(400).json({ error: "Runtime is not running." });
  }

  try {
    const docs = await runtimeController.getCollectionDocuments(collection, limit, page, selector ?? undefined);
    return res.json({
      collection,
      limit,
      page,
      docs
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : "Failed to query documents.";
    console.error(`[Collection Docs Error] collection=${collection} page=${page} limit=${limit} details=${details}`);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    return res.status(500).json({ error: details });
  }
});

app.post("/api/server/collection/upsert", async (req, res) => {
  const body = req.body as { collection?: unknown; doc?: unknown };
  const collection = typeof body.collection === "string" ? body.collection.trim() : "";
  console.log(`[Collection Upsert Request] collection=${collection || "<empty>"}`);
  if (!collection) {
    return res.status(400).json({ error: "Invalid payload. Expected collection." });
  }

  if (typeof body.doc !== "object" || body.doc === null || Array.isArray(body.doc)) {
    return res.status(400).json({ error: "Invalid payload. Expected doc object." });
  }

  if (runtimeController.getState() !== "running") {
    return res.status(400).json({ error: "Runtime is not running." });
  }

  try {
    const doc = await runtimeController.upsertCollectionDocument(collection, body.doc as Record<string, unknown>);
    console.log(`[Collection Upsert Complete] collection=${collection}`);
    return res.json({
      ok: true,
      collection,
      doc
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : "Failed to upsert document.";
    console.error(`[Collection Upsert Error] collection=${collection} details=${details}`);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    return res.status(500).json({ error: details });
  }
});

app.post("/api/server/collection/remove", async (req, res) => {
  const body = req.body as {
    collection?: unknown;
    query?: unknown;
    docs?: unknown;
    limit?: unknown;
  };
  const collection = typeof body.collection === "string" ? body.collection.trim() : "";
  if (!collection) {
    return res.status(400).json({ error: "Invalid payload. Expected collection." });
  }

  let selector: Record<string, unknown> | null = null;
  try {
    selector = parseCollectionSelectorQuery(body.query);
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : "Invalid query." });
  }

  const docs =
    Array.isArray(body.docs) && body.docs.every((entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry))
      ? (body.docs as Array<Record<string, unknown>>)
      : [];
  const limit =
    typeof body.limit === "number" && Number.isFinite(body.limit) ? Math.max(1, Math.floor(body.limit)) : undefined;

  if (!selector && docs.length === 0) {
    return res.status(400).json({ error: "Invalid payload. Expected query or docs." });
  }

  if (runtimeController.getState() !== "running") {
    return res.status(400).json({ error: "Runtime is not running." });
  }

  try {
    const result = await runtimeController.removeCollectionDocuments(collection, {
      selector: selector ?? undefined,
      docs,
      limit
    });
    return res.json({
      ok: true,
      collection,
      removed: result.removed,
      attempted: result.attempted
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : "Failed to remove documents.";
    console.error(`[Collection Remove Error] collection=${collection} details=${details}`);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    return res.status(500).json({ error: details });
  }
});

app.post("/api/server/collection/resync", async (req, res) => {
  const body = req.body as { collection?: unknown };
  const collection = typeof body.collection === "string" ? body.collection.trim() : "";
  if (!collection) {
    return res.status(400).json({ error: "Invalid payload. Expected collection." });
  }

  const startedAt = Date.now();
  console.log(`[Collection Resync Request] collection=${collection}`);

  if (runtimeController.getState() !== "running") {
    console.log(`[Collection Resync Rejected] collection=${collection} reason=runtime_not_running`);
    return res.status(400).json({ error: "Runtime is not running." });
  }

  try {
    await runtimeController.resyncCollection(collection);
    const count = await runtimeController.getCollectionDocumentCount(collection);
    console.log(`[Collection Resync Complete] collection=${collection} count=${count} durationMs=${Date.now() - startedAt}`);
    return res.json({
      ok: true,
      collection,
      count
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : "Failed to resync collection.";
    console.error(`[Collection Resync Error] collection=${collection} details=${details}`);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    if (details.toLowerCase().includes("already running")) {
      return res.status(409).json({ error: details });
    }
    return res.status(500).json({ error: details });
  }
});

app.post("/api/server/collection/reset", (req, res) => {
  const body = req.body as { collection?: unknown };
  const collection = typeof body.collection === "string" ? body.collection.trim() : "";
  if (!collection) {
    return res.status(400).json({ error: "Invalid payload. Expected collection." });
  }

  triggerHardResetCollection(collection);
  return res.json({
    ok: true,
    collection,
    accepted: true
  });
});

app.post("/api/health", (_req, res) => {
  res.json({ status: "ok", service: "rxdb-server-workbench-backend" });
});

app.use((err: { type?: string; status?: number } | undefined, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err?.type === "entity.too.large" || err?.status === 413) {
    return res.status(413).json({
      error: `Payload too large. Increase BACKEND_JSON_BODY_LIMIT (current: ${backendJsonBodyLimit}).`
    });
  }

  return next(err);
});

app.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`);
  console.log(`Backend config file: ${backendConfigFilePath}`);
});

function buildServerStatusMessage() {
  return {
    type: "server:status",
    serverId: backendConfig.runtime.serverId,
    status: backendConfig.runtime.status,
    hasStagedConfig: backendConfig.stagedServerSetup !== null,
    hasRunningConfig: backendConfig.runningServerSetup !== null,
    replicationEndpointTest: backendConfig.replicationEndpointTest,
    mongoConnectionTest: backendConfig.mongoConnectionTest
  };
}

function broadcastServerStatus(): void {
  const payload = buildServerStatusMessage();
  for (const client of subscribedClients) {
    sendJson(client, payload);
  }
}

function tryParseCommand(raw: string): ClientCommand | null {
  try {
    const parsed = JSON.parse(raw) as { type?: unknown; force?: unknown };
    if (parsed.type === "server:subscribe-status") {
      return { type: "server:subscribe-status" };
    }

    if (parsed.type === "server:deploy-staged-config") {
      return { type: "server:deploy-staged-config", force: parsed.force === true };
    }

    if (parsed.type === "server:stop-server") {
      return { type: "server:stop-server" };
    }

    if (parsed.type === "server:start-server") {
      return { type: "server:start-server" };
    }

    return null;
  } catch {
    return null;
  }
}

websocketServer.on("connection", (socket: WebSocket, request: IncomingMessage) => {
  sendJson(socket, {
    type: "connected",
    at: new Date().toISOString(),
    remoteAddress: request.socket.remoteAddress ?? null
  });

  socket.on("message", (message: unknown) => {
    const command = tryParseCommand(String(message));
    if (!command) {
      sendJson(socket, { type: "error", message: "Unknown websocket command." });
      return;
    }

    if (command.type === "server:subscribe-status") {
      subscribedClients.add(socket);
      sendJson(socket, buildServerStatusMessage());
      return;
    }

    if (command.type === "server:deploy-staged-config") {
      if (!backendConfig.stagedServerSetup) {
        sendJson(socket, { type: "server:deploy-ignored", message: "No staged config to deploy." });
        return;
      }

      const stagedSetup = backendConfig.stagedServerSetup;
      const runId = ++replicationEndpointTestRunId;
      backendConfig.runtime.status = "deploying";
      backendConfig.replicationEndpointTest = null;
      backendConfig.mongoConnectionTest = null;

      try {
        persistBackendConfig(backendConfig);
      } catch {
        sendJson(socket, { type: "error", message: "Failed to persist deployment state." });
        return;
      }

      sendJson(socket, {
        type: "server:deploying",
        serverId: backendConfig.runtime.serverId,
        message: command.force ? "Deployment started." : "Deployment started. Running pre-deploy tests."
      });
      broadcastServerStatus();

      if (command.force) {
        void (async () => {
          try {
            await applyRunningSetup(stagedSetup, backendConfig.runningServerSetup);
            backendConfig.runningServerSetup = stagedSetup;
            backendConfig.stagedServerSetup = null;
            backendConfig.runtime.status = "running";
            persistBackendConfig(backendConfig);
            sendJson(socket, {
              type: "server:deployed",
              serverId: backendConfig.runtime.serverId,
              message: "Deployment completed successfully."
            });
            broadcastServerStatus();
          } catch {
            backendConfig.runtime.status = "staged";
            persistBackendConfig(backendConfig);
            sendJson(socket, { type: "error", message: "Failed to apply running config." });
          }
        })();
        return;
      }

      void (async () => {
        const [replicationResult, mongoResult] = await Promise.all([
          testFirstCollectionReplicationEndpoint(stagedSetup),
          testMongoConnection(stagedSetup)
        ]);

        // Ignore stale deploy-test result if newer staged/deploy action occurred.
        if (runId !== replicationEndpointTestRunId) {
          return;
        }

        backendConfig.replicationEndpointTest = replicationResult;
        backendConfig.mongoConnectionTest = mongoResult;

        const replicationOk = Boolean(replicationResult?.ok);
        const mongoOk = mongoResult.ok;

        if (!replicationOk || !mongoOk) {
          backendConfig.runtime.status = "staged";
          try {
            persistBackendConfig(backendConfig);
          } catch {
            sendJson(socket, { type: "error", message: "Failed to persist failed deployment state." });
            return;
          }

          const replicationMessage = replicationResult
            ? replicationResult.ok
              ? "replication=ok"
              : `replication=failed(${replicationResult.httpStatus ?? "no response"})`
            : "replication=failed(no collection)";
          const mongoMessage = mongoResult.ok ? "mongo=ok" : `mongo=failed(${mongoResult.error ?? "unknown error"})`;

          sendJson(socket, {
            type: "server:deploy-failed",
            serverId: backendConfig.runtime.serverId,
            message: `Deployment blocked: ${replicationMessage}, ${mongoMessage}.`
          });
          broadcastServerStatus();
          return;
        }

        // Tests passed, promote staged config to running.
        try {
          await applyRunningSetup(stagedSetup, backendConfig.runningServerSetup);
          backendConfig.runningServerSetup = stagedSetup;
          backendConfig.stagedServerSetup = null;
          backendConfig.runtime.status = "running";
          persistBackendConfig(backendConfig);
        } catch {
          backendConfig.runtime.status = "staged";
          persistBackendConfig(backendConfig);
          sendJson(socket, { type: "error", message: "Failed to apply running config." });
          return;
        }

        sendJson(socket, {
          type: "server:deployed",
          serverId: backendConfig.runtime.serverId,
          message: "Deployment completed successfully."
        });
        broadcastServerStatus();
      })();
      return;
    }

    if (command.type === "server:stop-server") {
      void (async () => {
        try {
          await runtimeController.stop();
          backendConfig.runtime.status = "stopped";
          persistBackendConfig(backendConfig);
          sendJson(socket, {
            type: "server:stopped",
            serverId: backendConfig.runtime.serverId,
            message: "Server stopped."
          });
          broadcastServerStatus();
        } catch {
          sendJson(socket, { type: "error", message: "Failed to stop runtime." });
        }
      })();
      return;
    }

    if (command.type === "server:start-server") {
      const effectiveSetup = getEffectiveServerSetup(backendConfig);
      if (!isValidServerSetup(effectiveSetup)) {
        sendJson(socket, {
          type: "server:start-ignored",
          message: "No valid config exists to start the server."
        });
        return;
      }

      void (async () => {
        try {
          await applyRunningSetup(effectiveSetup, backendConfig.runningServerSetup);
          backendConfig.runningServerSetup = effectiveSetup;
          backendConfig.runtime.status = "running";
          persistBackendConfig(backendConfig);
          sendJson(socket, {
            type: "server:started",
            serverId: backendConfig.runtime.serverId,
            message: "Server started."
          });
          broadcastServerStatus();
        } catch (error) {
          const details = error instanceof Error && error.message ? error.message : "Unknown runtime start error.";
          sendJson(socket, { type: "error", message: `Failed to start runtime: ${details}` });
        }
      })();
    }
  });

  socket.on("close", () => {
    subscribedClients.delete(socket);
  });
});

websocketServer.on("listening", () => {
  console.log(`WebSocket listening on ws://localhost:${websocketPort}`);
});

void (async () => {
  if (backendConfig.runtime.status !== "running") {
    return;
  }

  const setup = backendConfig.runningServerSetup;
  if (!isValidServerSetup(setup)) {
    backendConfig.runtime.status = "stopped";
    persistBackendConfig(backendConfig);
    return;
  }

  try {
    await applyRunningSetup(setup);
    emitRuntimeLog({
      at: new Date().toISOString(),
      level: "info",
      area: "runtime",
      message: "Runtime restored from persisted running state."
    });
  } catch (error) {
    backendConfig.runtime.status = "stopped";
    persistBackendConfig(backendConfig);
    emitRuntimeLog({
      at: new Date().toISOString(),
      level: "error",
      area: "runtime",
      message: "Failed to restore runtime on startup.",
      details: error instanceof Error ? error.message : "Unknown startup restore error."
    });
  }
})();

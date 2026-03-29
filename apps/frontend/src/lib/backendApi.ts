const API_BASE_URL = (import.meta.env.VITE_FRONTEND_TO_USE_BACKEND_URL ?? "http://localhost:4000").replace(/\/$/, "");

type ApiPayload = Record<string, unknown>;

export type ServerSetup = {
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

export type ReplicationEndpointTestResult = {
  collection: string;
  endpoint: string;
  ok: boolean;
  httpStatus: number | null;
};

export type MongoConnectionTestResult = {
  ok: boolean;
  error: string | null;
};

export type DeployValidationResult = {
  replicationTests: ReplicationEndpointTestResult[];
  mongoConnectionTest: MongoConnectionTestResult;
  hasFailures: boolean;
};

export type RuntimeLogEvent = {
  at: string;
  level: "info" | "warn" | "error";
  area: "runtime" | "mongo" | "replication";
  message: string;
  collection?: string;
  details?: string;
};

export type ServerSummary = {
  serverId: string;
  serverIdentifier: string;
  url: string;
  port: string;
  collectionCount: number;
  updatedAt: string;
  isActive: boolean;
};

export type ServerConfigResponse = {
  runningServerSetup: ServerSetup | null;
  stagedServerSetup: ServerSetup | null;
  replicationEndpointTest: ReplicationEndpointTestResult | null;
  mongoConnectionTest: MongoConnectionTestResult | null;
  effectiveServerSetup: ServerSetup | null;
  activeServerId: string | null;
  servers: ServerSummary[];
};

export type ImportableServerSchemasResponse = {
  collections: string[];
  schemasByCollection: Record<string, unknown>;
};

function getAuthHeader(): string {
  const token = import.meta.env.VITE_FRONTEND_TO_USE_FORBACKEND_TOKEN;
  if (!token) {
    throw new Error("Missing VITE_FRONTEND_TO_USE_FORBACKEND_TOKEN in frontend env.");
  }

  return `Bearer ${token}`;
}

async function post<T>(path: string, payload: ApiPayload = {}): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: getAuthHeader()
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed with ${response.status}`);
  }

  return (await response.json()) as T;
}

function normalizeServerSetup(input: unknown): ServerSetup {
  const value = (typeof input === "object" && input !== null ? input : {}) as Partial<ServerSetup>;

  return {
    serverIdentifier: typeof value.serverIdentifier === "string" ? value.serverIdentifier : "",
    url: typeof value.url === "string" ? value.url : "",
    port: typeof value.port === "string" ? value.port : "",
    resyncBackendCollectionsFromScratch:
      typeof value.resyncBackendCollectionsFromScratch === "boolean" ? value.resyncBackendCollectionsFromScratch : true,
    schemaValidationEnabled: typeof value.schemaValidationEnabled === "boolean" ? value.schemaValidationEnabled : true,
    mongodbConnectionString: typeof value.mongodbConnectionString === "string" ? value.mongodbConnectionString : "",
    authHeader: typeof value.authHeader === "string" ? value.authHeader : "",
    collections: Array.isArray(value.collections) ? value.collections.filter((name): name is string => typeof name === "string") : [],
    collectionEndpoints:
      value.collectionEndpoints && typeof value.collectionEndpoints === "object" && !Array.isArray(value.collectionEndpoints)
        ? Object.fromEntries(
            Object.entries(value.collectionEndpoints).filter(([, endpoint]) => {
              if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)) {
                return false;
              }
              const replEndpoint = (endpoint as { replEndpoint?: unknown }).replEndpoint;
              const restEndpoint = (endpoint as { restEndpoint?: unknown }).restEndpoint;
              return typeof replEndpoint === "string" && typeof restEndpoint === "string";
            })
          )
        : {},
    schemasByCollection:
      value.schemasByCollection && typeof value.schemasByCollection === "object" && !Array.isArray(value.schemasByCollection)
        ? value.schemasByCollection
        : {}
  };
}

function normalizeNullableServerSetup(input: unknown): ServerSetup | null {
  if (input === null || input === undefined) {
    return null;
  }

  const normalized = normalizeServerSetup(input);
  const hasValue = Boolean(
    normalized.serverIdentifier ||
      normalized.url ||
      normalized.port ||
      normalized.authHeader ||
      normalized.collections.length ||
      Object.keys(normalized.schemasByCollection).length
  );

  return hasValue ? normalized : null;
}

function normalizeServerConfigResponse(input: unknown): ServerConfigResponse {
  const value = (typeof input === "object" && input !== null ? input : {}) as {
    runningServerSetup?: unknown;
    stagedServerSetup?: unknown;
    replicationEndpointTest?: unknown;
    mongoConnectionTest?: unknown;
    effectiveServerSetup?: unknown;
    activeServerId?: unknown;
    servers?: unknown;
  };

  const replicationEndpointTest =
    value.replicationEndpointTest && typeof value.replicationEndpointTest === "object" && !Array.isArray(value.replicationEndpointTest)
      ? (value.replicationEndpointTest as {
          collection?: unknown;
          endpoint?: unknown;
          ok?: unknown;
          httpStatus?: unknown;
        })
      : null;
  const mongoConnectionTest =
    value.mongoConnectionTest && typeof value.mongoConnectionTest === "object" && !Array.isArray(value.mongoConnectionTest)
      ? (value.mongoConnectionTest as {
          ok?: unknown;
          error?: unknown;
        })
      : null;

  const servers = Array.isArray(value.servers)
    ? value.servers
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
    : [];

  return {
    runningServerSetup: normalizeNullableServerSetup(value.runningServerSetup),
    stagedServerSetup: normalizeNullableServerSetup(value.stagedServerSetup),
    replicationEndpointTest:
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
        : null,
    mongoConnectionTest:
      mongoConnectionTest &&
      typeof mongoConnectionTest.ok === "boolean" &&
      (typeof mongoConnectionTest.error === "string" || mongoConnectionTest.error === null)
        ? {
            ok: mongoConnectionTest.ok,
            error: mongoConnectionTest.error
          }
        : null,
    effectiveServerSetup: normalizeNullableServerSetup(value.effectiveServerSetup),
    activeServerId: typeof value.activeServerId === "string" ? value.activeServerId : null,
    servers
  };
}

export async function getServerConfig(): Promise<ServerConfigResponse> {
  const result = await post("/api/server/config/get");
  return normalizeServerConfigResponse(result);
}

export async function stageServerConfig(serverSetup: ServerSetup): Promise<ServerConfigResponse> {
  const result = await post("/api/server/config/stage", { serverSetup });
  return normalizeServerConfigResponse(result);
}

export async function selectServer(serverId: string): Promise<ServerConfigResponse> {
  const result = await post("/api/server/select", { serverId });
  return normalizeServerConfigResponse(result);
}

export async function createServer(serverSetup: ServerSetup): Promise<ServerConfigResponse> {
  const result = await post("/api/server/create", { serverSetup });
  return normalizeServerConfigResponse(result);
}

export async function updateServer(serverId: string, serverSetup: ServerSetup): Promise<ServerConfigResponse> {
  const result = await post("/api/server/update", { serverId, serverSetup });
  return normalizeServerConfigResponse(result);
}

export async function deleteServer(serverId: string): Promise<ServerConfigResponse> {
  const result = await post("/api/server/delete", { serverId });
  return normalizeServerConfigResponse(result);
}

export async function upsertServerSchema(collection: string, schema: unknown): Promise<void> {
  await post("/api/server/schema/upsert", { collection, schema });
}

export async function removeServerSchema(collection: string): Promise<void> {
  await post("/api/server/schema/remove", { collection });
}

export async function getImportableServerSchemas(): Promise<ImportableServerSchemasResponse> {
  const result = await post("/api/server/schema/import/list");
  const value = (typeof result === "object" && result !== null ? result : {}) as {
    collections?: unknown;
    schemasByCollection?: unknown;
  };

  const collections = Array.isArray(value.collections)
    ? value.collections.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean)
    : [];
  const schemasByCollection =
    value.schemasByCollection && typeof value.schemasByCollection === "object" && !Array.isArray(value.schemasByCollection)
      ? (value.schemasByCollection as Record<string, unknown>)
      : {};

  return {
    collections,
    schemasByCollection
  };
}

export async function validateDeploy(): Promise<DeployValidationResult> {
  const result = await post("/api/server/deploy/validate");
  const value = (typeof result === "object" && result !== null ? result : {}) as {
    replicationTests?: unknown;
    mongoConnectionTest?: unknown;
    hasFailures?: unknown;
  };

  const replicationTests = Array.isArray(value.replicationTests)
    ? value.replicationTests
        .filter((entry): entry is ReplicationEndpointTestResult => {
          if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
            return false;
          }
          const cast = entry as { collection?: unknown; endpoint?: unknown; ok?: unknown; httpStatus?: unknown };
          return (
            typeof cast.collection === "string" &&
            typeof cast.endpoint === "string" &&
            typeof cast.ok === "boolean" &&
            (typeof cast.httpStatus === "number" || cast.httpStatus === null)
          );
        })
        .map((entry) => ({
          collection: entry.collection,
          endpoint: entry.endpoint,
          ok: entry.ok,
          httpStatus: entry.httpStatus
        }))
    : [];

  const mongoConnectionTest =
    value.mongoConnectionTest && typeof value.mongoConnectionTest === "object" && !Array.isArray(value.mongoConnectionTest)
      ? (value.mongoConnectionTest as { ok?: unknown; error?: unknown })
      : null;

  return {
    replicationTests,
    mongoConnectionTest:
      mongoConnectionTest &&
      typeof mongoConnectionTest.ok === "boolean" &&
      (typeof mongoConnectionTest.error === "string" || mongoConnectionTest.error === null)
        ? { ok: mongoConnectionTest.ok, error: mongoConnectionTest.error }
        : { ok: false, error: "Mongo validation result missing." },
    hasFailures: typeof value.hasFailures === "boolean" ? value.hasFailures : true
  };
}

export async function getRuntimeLogs(): Promise<RuntimeLogEvent[]> {
  const result = await post("/api/server/runtime/logs/get");
  const value = (typeof result === "object" && result !== null ? result : {}) as { logs?: unknown };
  if (!Array.isArray(value.logs)) {
    return [];
  }

  return value.logs
    .filter((entry): entry is RuntimeLogEvent => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        return false;
      }
      const cast = entry as {
        at?: unknown;
        level?: unknown;
        area?: unknown;
        message?: unknown;
        collection?: unknown;
        details?: unknown;
      };
      return (
        typeof cast.at === "string" &&
        (cast.level === "info" || cast.level === "warn" || cast.level === "error") &&
        (cast.area === "runtime" || cast.area === "mongo" || cast.area === "replication") &&
        typeof cast.message === "string" &&
        (typeof cast.collection === "string" || cast.collection === undefined) &&
        (typeof cast.details === "string" || cast.details === undefined)
      );
    })
    .reverse();
}

export async function clearRuntimeLogs(): Promise<number> {
  const result = await post("/api/server/runtime/logs/clear");
  const value = (typeof result === "object" && result !== null ? result : {}) as { removed?: unknown };
  return typeof value.removed === "number" ? value.removed : 0;
}

export async function getCollectionDocumentCount(collection: string, query?: string): Promise<number> {
  const result = await post("/api/server/collection/count", { collection, query: query ?? "" });
  const value = (typeof result === "object" && result !== null ? result : {}) as { count?: unknown };
  return typeof value.count === "number" ? value.count : 0;
}

export async function getCollectionDocuments(collection: string, limit = 100, page = 1, query?: string): Promise<Array<Record<string, unknown>>> {
  const result = await post("/api/server/collection/docs", { collection, limit, page, query: query ?? "" });
  const value = (typeof result === "object" && result !== null ? result : {}) as { docs?: unknown };
  if (!Array.isArray(value.docs)) {
    return [];
  }

  return value.docs.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && !Array.isArray(entry));
}

export async function upsertCollectionDocument(collection: string, doc: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await post("/api/server/collection/upsert", { collection, doc });
  const value = (typeof result === "object" && result !== null ? result : {}) as { doc?: unknown };
  if (value.doc && typeof value.doc === "object" && !Array.isArray(value.doc)) {
    return value.doc as Record<string, unknown>;
  }

  return doc;
}

export async function removeCollectionDocuments(
  collection: string,
  options: {
    query?: string;
    docs?: Array<Record<string, unknown>>;
    limit?: number;
  }
): Promise<{ removed: number; attempted: number }> {
  const result = await post("/api/server/collection/remove", {
    collection,
    query: options.query ?? "",
    docs: options.docs ?? [],
    limit: options.limit
  });
  const value = (typeof result === "object" && result !== null ? result : {}) as {
    removed?: unknown;
    attempted?: unknown;
  };
  return {
    removed: typeof value.removed === "number" ? value.removed : 0,
    attempted: typeof value.attempted === "number" ? value.attempted : 0
  };
}

export async function resyncCollection(collection: string): Promise<number | null> {
  const result = await post("/api/server/collection/resync", { collection });
  const value = (typeof result === "object" && result !== null ? result : {}) as { count?: unknown };
  return typeof value.count === "number" ? value.count : null;
}

export async function resetCollection(collection: string): Promise<void> {
  await post("/api/server/collection/reset", { collection });
}

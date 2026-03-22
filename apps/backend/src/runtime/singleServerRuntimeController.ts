import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import { addRxPlugin, createRxDatabase, type RxCollection, type RxDatabase, type RxJsonSchema } from "rxdb";
import { RxDBQueryBuilderPlugin } from "rxdb/plugins/query-builder";
import { replicateRxCollection, type RxReplicationState } from "rxdb/plugins/replication";
import { getRxStorageMongoDB, type RxStorageMongoDB } from "rxdb/plugins/storage-mongodb";
import { wrappedValidateAjvStorage } from "rxdb/plugins/validate-ajv";

addRxPlugin(RxDBQueryBuilderPlugin);

export type RuntimeServerSetup = {
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

export type RuntimeLogEvent = {
  at: string;
  level: "info" | "warn" | "error";
  area: "runtime" | "mongo" | "replication";
  message: string;
  collection?: string;
  details?: string;
};

export type RuntimeCollectionChangeEvent = {
  at: string;
  collection: string;
  changeCount: number;
  operations: string[];
};

type RuntimeState = "stopped" | "starting" | "running" | "stopping";

type ControllerOptions = {
  webhookUrl?: string;
  onLog?: (event: RuntimeLogEvent) => void;
  onCollectionChange?: (event: RuntimeCollectionChangeEvent) => void;
};

function applyCollectionNameModifier(collectionName: string): string {
  const trimmed = collectionName.trim();
  if (!trimmed) {
    return "";
  }

  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function deriveDefaultReplEndpoint(collectionName: string): string {
  const modified = applyCollectionNameModifier(collectionName);
  if (!modified) {
    return "";
  }

  return `repl${modified}/0`;
}

function buildReplicationPullUrl(setup: RuntimeServerSetup, collection: string): string {
  const base = setup.url.trim().replace(/\/+$/, "");
  const endpoint = (setup.collectionEndpoints[collection]?.replEndpoint ?? deriveDefaultReplEndpoint(collection))
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  const withPort = setup.port.trim() ? `${base}:${setup.port.trim()}` : base;
  return `${withPort}/${endpoint}/pull?lwt=0&id=&limit=100`;
}

export class SingleServerRuntimeController {
  private readonly webhookUrl: string;
  private readonly onLog: (event: RuntimeLogEvent) => void;
  private readonly onCollectionChange: (event: RuntimeCollectionChangeEvent) => void;
  private state: RuntimeState = "stopped";
  private currentSetup: RuntimeServerSetup | null = null;
  private rxDatabase: RxDatabase | null = null;
  private collectionMap = new Map<string, RxCollection>();
  private replicationStates = new Map<string, RxReplicationState<any, any>>();
  private replicationSubscriptions = new Map<string, Array<{ unsubscribe: () => void }>>();
  private collectionChangeSubscriptions = new Map<string, { unsubscribe: () => void }>();
  private resyncInFlightCollections = new Set<string>();
  private resyncStartedAtByCollection = new Map<string, number>();
  private replicationLastErrorByCollection = new Map<string, string>();
  private collectionValidators = new Map<string, ValidateFunction>();
  private readonly ajv = new Ajv({ allErrors: true, strict: false });

  constructor(options: ControllerOptions = {}) {
    this.webhookUrl = options.webhookUrl?.trim() ?? "";
    this.onLog = options.onLog ?? (() => undefined);
    this.onCollectionChange = options.onCollectionChange ?? (() => undefined);
  }

  getState(): RuntimeState {
    return this.state;
  }

  async getCollectionDocumentCount(collectionName: string, selector?: Record<string, unknown>): Promise<number> {
    if (this.state !== "running") {
      throw new Error("Runtime is not running.");
    }

    const collection = this.collectionMap.get(collectionName.trim());
    if (!collection) {
      throw new Error(`Collection "${collectionName}" is not available in runtime.`);
    }

    if (!selector || Object.keys(selector).length === 0) {
      return collection.count().exec();
    }

    const docs = await collection.find({ selector }).exec();
    return docs.length;
  }

  async getCollectionDocuments(
    collectionName: string,
    limit: number,
    page: number,
    selector?: Record<string, unknown>
  ): Promise<Array<Record<string, unknown>>> {
    if (this.state !== "running") {
      throw new Error("Runtime is not running.");
    }

    const collection = this.collectionMap.get(collectionName.trim());
    if (!collection) {
      throw new Error(`Collection "${collectionName}" is not available in runtime.`);
    }

    const normalizedPage = Math.max(1, Math.floor(page));
    const skip = (normalizedPage - 1) * limit;
    const baseQuery = selector && Object.keys(selector).length > 0 ? collection.find({ selector }) : collection.find();
    const docs = await baseQuery.skip(skip).limit(limit).exec();
    return docs.map((doc) => this.stripUnderscoreFields((doc as { toJSON: (withMetaFields?: boolean) => unknown }).toJSON(true)) as Record<
      string,
      unknown
    >);
  }

  async upsertCollectionDocument(collectionName: string, docData: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.state !== "running") {
      throw new Error("Runtime is not running.");
    }

    const normalized = collectionName.trim();
    if (!normalized) {
      throw new Error("Collection is required.");
    }

    const collection = this.collectionMap.get(normalized);
    if (!collection) {
      throw new Error(`Collection "${collectionName}" is not available in runtime.`);
    }

    this.log("info", "runtime", "Collection upsert requested.", `keys=${Object.keys(docData).join(",")}`, normalized);

    const savedDoc = await collection.incrementalUpsert(docData);
    this.log("info", "runtime", "Collection upsert completed.", undefined, normalized);
    const serialized = (savedDoc as { toJSON: (withMetaFields?: boolean) => unknown }).toJSON(true);
    return this.stripUnderscoreFields(serialized) as Record<string, unknown>;
  }

  async removeCollectionDocuments(
    collectionName: string,
    options: {
      selector?: Record<string, unknown>;
      docs?: Array<Record<string, unknown>>;
      limit?: number;
    } = {}
  ): Promise<{ removed: number; attempted: number }> {
    if (this.state !== "running") {
      throw new Error("Runtime is not running.");
    }

    const normalized = collectionName.trim();
    if (!normalized) {
      throw new Error("Collection is required.");
    }

    const collection = this.collectionMap.get(normalized);
    if (!collection) {
      throw new Error(`Collection "${collectionName}" is not available in runtime.`);
    }

    const targetDocs: Array<{ remove: () => Promise<unknown> }> = [];
    const requestedDocs = Array.isArray(options.docs) ? options.docs : [];
    const selector = options.selector;

    if (requestedDocs.length > 0) {
      const primaryPath = this.getCollectionPrimaryPath(collection);
      for (const requested of requestedDocs) {
        const resolved = await this.resolveDocumentForRemoval(collection, primaryPath, requested);
        if (resolved) {
          targetDocs.push(resolved);
        }
      }
    } else {
      const baseQuery = selector && Object.keys(selector).length > 0 ? collection.find({ selector }) : collection.find();
      const limit = typeof options.limit === "number" && Number.isFinite(options.limit) ? Math.max(1, Math.floor(options.limit)) : null;
      const docs = limit ? await baseQuery.limit(limit).exec() : await baseQuery.exec();
      for (const doc of docs) {
        targetDocs.push(doc as unknown as { remove: () => Promise<unknown> });
      }
    }

    if (targetDocs.length === 0) {
      return { removed: 0, attempted: 0 };
    }

    let removed = 0;
    for (const doc of targetDocs) {
      await doc.remove();
      removed += 1;
    }

    this.log("info", "runtime", "Collection document remove completed.", `removed=${removed}`, normalized);
    return {
      removed,
      attempted: targetDocs.length
    };
  }

  async resyncCollection(collectionName: string): Promise<void> {
    if (this.state !== "running") {
      throw new Error("Runtime is not running.");
    }

    const normalized = collectionName.trim();
    if (!normalized) {
      throw new Error("Collection is required.");
    }

    const replicationState = this.replicationStates.get(normalized);
    if (!replicationState) {
      throw new Error(`Replication is not active for collection "${normalized}".`);
    }

    if (this.resyncInFlightCollections.has(normalized)) {
      const startedAt = this.resyncStartedAtByCollection.get(normalized);
      const elapsedMs = startedAt ? Date.now() - startedAt : null;
      const lastError = this.replicationLastErrorByCollection.get(normalized);
      const elapsedText = elapsedMs !== null ? `${elapsedMs}ms` : "unknown duration";
      const extra = lastError ? ` Last replication error: ${lastError}` : "";
      throw new Error(`Resync is already running for collection "${normalized}" (${elapsedText}).${extra}`);
    }

    this.resyncInFlightCollections.add(normalized);
    this.resyncStartedAtByCollection.set(normalized, Date.now());
    let waitLogTimer: NodeJS.Timeout | null = null;
    try {
      this.log("info", "replication", "Manual resync requested.", undefined, normalized);
      replicationState.reSync();
      waitLogTimer = setInterval(() => {
        const startedAt = this.resyncStartedAtByCollection.get(normalized);
        const elapsedMs = startedAt ? Date.now() - startedAt : 0;
        const lastError = this.replicationLastErrorByCollection.get(normalized);
        this.log(
          "info",
          "replication",
          "Manual resync still waiting for in-sync.",
          `elapsedMs=${elapsedMs}${lastError ? ` | lastError=${lastError}` : ""}`,
          normalized
        );
      }, 10000);
      await replicationState.awaitInSync();
      this.log("info", "replication", "Manual resync completed.", undefined, normalized);
    } catch (error) {
      const lastError = this.replicationLastErrorByCollection.get(normalized);
      this.log(
        "warn",
        "replication",
        "Manual resync failed while waiting for in-sync.",
        `${this.describeError(error)}${lastError ? ` | lastReplicationError=${lastError}` : ""}`,
        normalized
      );
      throw error;
    } finally {
      if (waitLogTimer) {
        clearInterval(waitLogTimer);
      }
      this.resyncInFlightCollections.delete(normalized);
      this.resyncStartedAtByCollection.delete(normalized);
    }
  }

  async start(setup: RuntimeServerSetup): Promise<void> {
    if (this.state === "starting" || this.state === "running") {
      this.log("warn", "runtime", "Start requested but runtime is already active.");
      return;
    }

    this.state = "starting";
    this.log("info", "runtime", `Starting runtime for server "${setup.serverIdentifier}".`);

    try {
      await this.createDatabase(setup);
      await this.addCollectionsToDatabase(setup, setup.collections);
      await this.startReplicationsForCollections(setup, setup.collections);
      this.currentSetup = this.cloneSetup(setup);
      this.state = "running";
      this.log("info", "runtime", "Runtime started.");
    } catch (error) {
      this.log("error", "runtime", "Runtime start failed.", this.describeError(error));
      await this.safeStopInternal();
      this.state = "stopped";
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.state === "stopped" || this.state === "stopping") {
      return;
    }

    this.state = "stopping";
    this.log("info", "runtime", "Stopping runtime.");
    await this.safeStopInternal();
    this.state = "stopped";
    this.log("info", "runtime", "Runtime stopped.");
  }

  async reconcile(setup: RuntimeServerSetup): Promise<void> {
    this.currentSetup = this.cloneSetup(setup);

    if (this.state !== "running") {
      this.log("info", "runtime", "Reconcile requested while runtime not running. Config snapshot updated only.");
      return;
    }

    const existingCollections = new Set(this.replicationStates.keys());
    const incomingCollections = setup.collections.map((name) => name.trim()).filter(Boolean);
    const newCollections = incomingCollections.filter((name) => !existingCollections.has(name));
    if (newCollections.length === 0) {
      return;
    }

    this.log("info", "runtime", `Reconciling ${newCollections.length} new collection(s).`);
    await this.addCollectionsToDatabase(setup, newCollections);
    await this.startReplicationsForCollections(setup, newCollections);
  }

  private getDatabaseStorage(setup: RuntimeServerSetup): RxStorageMongoDB {
    const connectionString = setup.mongodbConnectionString.trim();
    if (!connectionString) {
      throw new Error("MongoDB connection string is missing.");
    }

    return getRxStorageMongoDB({
      connection: connectionString
    });
  }

  private normalizeCollectionNames(collections: string[]): string[] {
    return Array.from(new Set(collections.map((name) => name.trim()).filter(Boolean)));
  }

  private getCollectionPrimaryPath(collection: RxCollection): string {
    const schemaValue = collection as unknown as {
      schema?: {
        primaryPath?: unknown;
      };
    };
    const primaryPath = schemaValue.schema?.primaryPath;
    if (typeof primaryPath === "string" && primaryPath.trim()) {
      return primaryPath;
    }

    throw new Error("Collection schema primary key is not a string.");
  }

  private async resolveDocumentForRemoval(
    collection: RxCollection,
    primaryPath: string,
    data: Record<string, unknown>
  ): Promise<{ remove: () => Promise<unknown> } | null> {
    const primaryValue = data[primaryPath];
    if (primaryValue === undefined || primaryValue === null) {
      return null;
    }

    if (typeof primaryValue === "string") {
      const byId = await collection.findOne(primaryValue).exec();
      if (byId) {
        return byId as unknown as { remove: () => Promise<unknown> };
      }
    }

    const bySelector = await collection
      .findOne({
        selector: {
          [primaryPath]: primaryValue
        }
      })
      .exec();

    if (!bySelector) {
      return null;
    }

    return bySelector as unknown as { remove: () => Promise<unknown> };
  }

  private getCollectionSchema(setup: RuntimeServerSetup, collectionName: string): RxJsonSchema<unknown> {
    const rawSchema = setup.schemasByCollection[collectionName];
    if (!rawSchema || typeof rawSchema !== "object" || Array.isArray(rawSchema)) {
      throw new Error(`Missing or invalid schema for collection "${collectionName}".`);
    }

    return rawSchema as RxJsonSchema<unknown>;
  }

  private buildCollectionBaseUrl(setup: RuntimeServerSetup, collectionName: string): string {
    const base = setup.url.trim().replace(/\/+$/, "");
    const endpoint = (setup.collectionEndpoints[collectionName]?.replEndpoint ?? deriveDefaultReplEndpoint(collectionName))
      .trim()
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");
    const withPort = setup.port.trim() ? `${base}:${setup.port.trim()}` : base;
    return `${withPort}/${endpoint}`;
  }

  private buildHeaders(setup: RuntimeServerSetup, includeJsonContentType = false): Record<string, string> {
    const headers: Record<string, string> = {};
    const authHeader = setup.authHeader.trim();
    if (authHeader) {
      headers.Authorization = setup.authHeader;
    }
    if (includeJsonContentType) {
      headers["Content-Type"] = "application/json";
    }

    return headers;
  }

  private compileCollectionValidator(setup: RuntimeServerSetup, collectionName: string): void {
    if (!setup.schemaValidationEnabled) {
      this.collectionValidators.delete(collectionName);
      return;
    }

    const schema = this.getCollectionSchema(setup, collectionName);
    this.collectionValidators.set(collectionName, this.ajv.compile(schema));
  }

  private async createDatabase(setup: RuntimeServerSetup): Promise<void> {
    const baseStorage = this.getDatabaseStorage(setup);
    const storage = setup.schemaValidationEnabled ? wrappedValidateAjvStorage({ storage: baseStorage }) : baseStorage;
    const databaseName = this.deriveRuntimeDatabaseName(setup);

    this.rxDatabase = await createRxDatabase({
      name: databaseName,
      storage,
      multiInstance: false,
      eventReduce: true,
      allowSlowCount: true
    });

    this.collectionMap.clear();
    this.resyncInFlightCollections.clear();
    this.collectionValidators.clear();
    this.log("info", "mongo", "RxDB Mongo storage initialized.", databaseName);
  }

  private async addCollectionsToDatabase(setup: RuntimeServerSetup, requestedCollections: string[]): Promise<void> {
    if (!this.rxDatabase) {
      throw new Error("RxDB database is not initialized.");
    }

    const targetCollections = this.normalizeCollectionNames(requestedCollections).filter((name) => !this.collectionMap.has(name));
    if (targetCollections.length === 0) {
      return;
    }

    const collectionCreators: Record<string, { schema: RxJsonSchema<unknown> }> = {};
    for (const collectionName of targetCollections) {
      this.compileCollectionValidator(setup, collectionName);
      collectionCreators[collectionName] = {
        schema: this.getCollectionSchema(setup, collectionName)
      };
    }

    const createdCollections = await this.rxDatabase.addCollections(collectionCreators);
    for (const collectionName of Object.keys(createdCollections)) {
      const collection = createdCollections[collectionName];
      this.collectionMap.set(collectionName, collection);
      this.subscribeToCollectionChanges(collectionName, collection);
      this.log("info", "runtime", "RxDB collection initialized.", undefined, collectionName);
    }
  }

  private subscribeToCollectionChanges(collectionName: string, collection: RxCollection): void {
    const existing = this.collectionChangeSubscriptions.get(collectionName);
    if (existing) {
      existing.unsubscribe();
      this.collectionChangeSubscriptions.delete(collectionName);
    }

    const subscription = collection.$.subscribe((changeEventBulk: unknown) => {
      const normalized = this.normalizeCollectionChangeEvent(collectionName, changeEventBulk);
      if (!normalized) {
        return;
      }
      this.onCollectionChange(normalized);
    });

    this.collectionChangeSubscriptions.set(collectionName, subscription);
  }

  private normalizeCollectionChangeEvent(collectionName: string, changeEventBulk: unknown): RuntimeCollectionChangeEvent | null {
    if (!changeEventBulk || typeof changeEventBulk !== "object" || Array.isArray(changeEventBulk)) {
      return null;
    }

    const cast = changeEventBulk as {
      events?: unknown;
    };

    const events = Array.isArray(cast.events) ? cast.events : [];
    if (events.length === 0) {
      return null;
    }

    const operationsSet = new Set<string>();
    for (const eventItem of events) {
      if (!eventItem || typeof eventItem !== "object" || Array.isArray(eventItem)) {
        continue;
      }
      const operation = (eventItem as { operation?: unknown }).operation;
      if (typeof operation === "string" && operation.trim()) {
        operationsSet.add(operation.trim().toUpperCase());
      }
    }

    const operationList = Array.from(operationsSet);
    return {
      at: new Date().toISOString(),
      collection: collectionName,
      changeCount: events.length,
      operations: operationList
    };
  }

  private extractPullResponseDocuments(payload: unknown): unknown[] {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return [];
    }

    const candidate = payload as { documents?: unknown; docs?: unknown };
    if (Array.isArray(candidate.documents)) {
      return candidate.documents;
    }
    if (Array.isArray(candidate.docs)) {
      return candidate.docs;
    }

    return [];
  }

  private extractPullResponseCheckpoint(payload: unknown): unknown {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return undefined;
    }

    const candidate = payload as { checkpoint?: unknown };
    return candidate.checkpoint;
  }

  private async startReplicationsForCollections(setup: RuntimeServerSetup, requestedCollections: string[]): Promise<void> {
    const targetCollections = this.normalizeCollectionNames(requestedCollections);
    for (const collectionName of targetCollections) {
      if (this.replicationStates.has(collectionName)) {
        continue;
      }

      const collection = this.collectionMap.get(collectionName);
      if (!collection) {
        throw new Error(`Collection "${collectionName}" is not available in RxDB.`);
      }

      const collectionBaseUrl = this.buildCollectionBaseUrl(setup, collectionName);
      const pullUrl = `${collectionBaseUrl}/pull`;
      const pushUrl = `${collectionBaseUrl}/push`;
      const localValidator = this.collectionValidators.get(collectionName);

      const replicationState = replicateRxCollection({
        replicationIdentifier: `${setup.serverIdentifier}:${collectionName}:${collectionBaseUrl}`,
        collection,
        deletedField: "_deleted",
        live: true,
        retryTime: 5000,
        waitForLeadership: false,
        autoStart: true,
        pull: {
          batchSize: 100,
          handler: async (checkpoint: unknown, batchSize: number) => {
            const checkpointObject = checkpoint && typeof checkpoint === "object" ? (checkpoint as Record<string, unknown>) : {};
            const lwt = typeof checkpointObject.lwt === "number" ? checkpointObject.lwt : 0;
            const id = typeof checkpointObject.id === "string" ? checkpointObject.id : "";
            const url = `${pullUrl}?lwt=${encodeURIComponent(String(lwt))}&id=${encodeURIComponent(id)}&limit=${encodeURIComponent(
              String(batchSize)
            )}`;

            const response = await fetch(url, {
              method: "GET",
              headers: this.buildHeaders(setup)
            });

            if (!response.ok) {
              throw new Error(`Pull failed (${response.status}) at ${url}`);
            }

            const payload = (await response.json().catch(() => ({}))) as unknown;
            const documents = this.extractPullResponseDocuments(payload);
            const filteredDocuments =
              localValidator
                ? documents.filter((docData) => {
                  const docForValidation = this.withoutDeletedField(docData);
                  const isValid = localValidator(docForValidation) === true;
                  if (!isValid) {
                    this.log(
                      "warn",
                      "replication",
                      "Pulled document failed AJV validation and was skipped.",
                      this.describeAjvValidationFailure(docData, localValidator.errors ?? []),
                      collectionName
                    );
                  }
                  return isValid;
                })
                : documents;

            return {
              checkpoint: this.extractPullResponseCheckpoint(payload),
              documents: filteredDocuments as Array<Record<string, unknown>>
            };
          }
        },
        push: {
          batchSize: 100,
          handler: async (rows: unknown[]) => {
            const rowCount = Array.isArray(rows) ? rows.length : 0;
            this.log("info", "replication", "Push request started.", `rows=${rowCount} url=${pushUrl}`, collectionName);

            const response = await fetch(pushUrl, {
              method: "POST",
              headers: this.buildHeaders(setup, true),
              body: JSON.stringify(rows)
            });

            if (!response.ok) {
              this.log("error", "replication", "Push request failed.", `status=${response.status} url=${pushUrl}`, collectionName);
              throw new Error(`Push failed (${response.status}) at ${pushUrl}`);
            }

            const payload = (await response.json().catch(() => [])) as unknown;
            if (Array.isArray(payload)) {
              this.log("info", "replication", "Push request completed.", `status=${response.status} conflicts=${payload.length}`, collectionName);
              return payload as Array<Record<string, unknown>>;
            }

            if (payload && typeof payload === "object" && Array.isArray((payload as { conflicts?: unknown }).conflicts)) {
              this.log(
                "info",
                "replication",
                "Push request completed.",
                `status=${response.status} conflicts=${(payload as { conflicts: unknown[] }).conflicts.length}`,
                collectionName
              );
              return (payload as { conflicts: Array<Record<string, unknown>> }).conflicts;
            }

            this.log("info", "replication", "Push request completed.", `status=${response.status} conflicts=0`, collectionName);
            return [];
          }
        }
      });

      const subscriptions: Array<{ unsubscribe: () => void }> = [
        replicationState.error$.subscribe((error) => {
          this.replicationLastErrorByCollection.set(collectionName, this.describeError(error));
          this.log("error", "replication", "Replication stream error.", this.describeError(error), collectionName);
        }),
        replicationState.canceled$.subscribe((isCanceled) => {
          if (isCanceled) {
            this.log("warn", "replication", "Replication canceled.", undefined, collectionName);
          }
        })
      ];

      this.replicationStates.set(collectionName, replicationState);
      this.replicationSubscriptions.set(collectionName, subscriptions);
      this.log("info", "replication", "Replication started.", `${pullUrl} | ${pushUrl}`, collectionName);
    }
  }

  private async safeStopInternal(): Promise<void> {
    const replications = Array.from(this.replicationStates.values());
    this.replicationStates.clear();
    for (const replicationState of replications) {
      await replicationState.cancel().catch(() => undefined);
    }

    for (const subscriptions of this.replicationSubscriptions.values()) {
      for (const subscription of subscriptions) {
        subscription.unsubscribe();
      }
    }
    this.replicationSubscriptions.clear();
    this.replicationLastErrorByCollection.clear();
    this.resyncStartedAtByCollection.clear();

    for (const subscription of this.collectionChangeSubscriptions.values()) {
      subscription.unsubscribe();
    }
    this.collectionChangeSubscriptions.clear();

    if (this.rxDatabase) {
      await this.rxDatabase.close().catch(() => undefined);
      this.rxDatabase = null;
    }

    this.collectionMap.clear();
    this.collectionValidators.clear();
    this.currentSetup = null;
  }

  private deriveRuntimeDatabaseName(setup: RuntimeServerSetup): string {
    const raw = setup.serverIdentifier.trim().toLowerCase();
    const normalized = raw.replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
    const fallback = normalized || "rxdb-runtime";

    return `rxdb-workbench-${fallback}`;
  }

  private log(
    level: RuntimeLogEvent["level"],
    area: RuntimeLogEvent["area"],
    message: string,
    details?: string,
    collection?: string
  ): void {
    const event: RuntimeLogEvent = {
      at: new Date().toISOString(),
      level,
      area,
      message,
      collection,
      details
    };

    this.onLog(event);
    if (this.webhookUrl) {
      void fetch(this.webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(event)
      }).catch(() => undefined);
    }
  }

  private describeError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return "Unknown runtime error.";
  }

  private describeAjvValidationFailure(docData: unknown, errors: ErrorObject[]): string {
    const issues = errors.slice(0, 5).map((entry) => {
      const path = entry.instancePath || "/";
      const reason = entry.message ?? "validation error";
      return `${path}: ${reason}`;
    });

    const issueSummary = issues.length > 0 ? issues.join("; ") : "Unknown AJV validation error.";
    const docPreview = this.stringifyForLogs(docData, 1200);
    return `AJV errors: ${issueSummary} | document: ${docPreview}`;
  }

  private stringifyForLogs(value: unknown, maxLength: number): string {
    try {
      const text = JSON.stringify(value);
      if (typeof text !== "string") {
        return String(value);
      }

      if (text.length <= maxLength) {
        return text;
      }

      return `${text.slice(0, maxLength)}...(truncated)`;
    } catch {
      return "[unserializable value]";
    }
  }

  private withoutDeletedField(docData: unknown): unknown {
    if (!docData || typeof docData !== "object" || Array.isArray(docData)) {
      return docData;
    }

    const clone = { ...(docData as Record<string, unknown>) };
    delete clone._deleted;
    return clone;
  }

  private stripUnderscoreFields(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((entry) => this.stripUnderscoreFields(entry));
    }

    if (!value || typeof value !== "object") {
      return value;
    }

    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, fieldValue] of Object.entries(input)) {
      if (key.startsWith("_")) {
        continue;
      }
      output[key] = this.stripUnderscoreFields(fieldValue);
    }
    return output;
  }

  private cloneSetup(setup: RuntimeServerSetup): RuntimeServerSetup {
    return JSON.parse(JSON.stringify(setup)) as RuntimeServerSetup;
  }
}

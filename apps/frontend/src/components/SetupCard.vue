<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import Ajv from "ajv";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { json } from "@codemirror/lang-json";
import { oneDark } from "@codemirror/theme-one-dark";
import { removeServerSchema, stageServerConfig, upsertServerSchema, type ServerSetup } from "../lib/backendApi";

const props = defineProps<{
  initialSetup: ServerSetup;
}>();

const emit = defineEmits<{
  close: [];
  save: [payload: ServerSetup];
}>();

const serverIdentifier = ref("");
const serverUrl = ref("");
const serverPort = ref("");
const resyncBackendCollectionsFromScratch = ref(true);
const mongodbConnectionString = ref("");
const serverAuthHeader = ref("");

const collections = ref<string[]>([]);
const collectionInput = ref("");
const collectionReplEndpointInput = ref("");
const collectionRestEndpointInput = ref("");
const autoDeriveEndpoints = ref(true);
const editingCollectionIndex = ref<number | null>(null);
const collectionEndpoints = ref<Record<string, { replEndpoint: string; restEndpoint: string }>>({});

const schemaTargetCollection = ref("");
const schemaFileInput = ref<HTMLInputElement | null>(null);
const schemaError = ref("");
const schemaPasteError = ref("");
const schemasByCollection = ref<Record<string, unknown>>({});
const pastedSchemasByCollection = ref<Record<string, string>>({});
const pastedSchemaInput = ref("");
const isPasteSchemaModalOpen = ref(false);
const isSchemaValidationEnabled = ref(true);
const isSchemaSectionInvalid = ref(false);
const schemaEditorHost = ref<HTMLDivElement | null>(null);
const configError = ref("");
const invalidFields = ref({
  serverIdentifier: false,
  serverUrl: false,
  serverPort: false,
  mongodbConnectionString: false,
  serverAuthHeader: false,
  collections: false
});

function getApiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    try {
      const parsed = JSON.parse(error.message) as { error?: unknown };
      if (typeof parsed.error === "string" && parsed.error.trim()) {
        return parsed.error;
      }
    } catch {
      // Ignore non-JSON backend error payloads.
    }
  }

  return fallback;
}

const schemaAjv = new Ajv({ allErrors: true, strict: false, validateSchema: true });
let schemaEditorView: EditorView | null = null;
let isSyncingSchemaEditorFromModel = false;

function loadFromSetup(setup: ServerSetup): void {
  serverIdentifier.value = setup.serverIdentifier;
  serverUrl.value = setup.url;
  serverPort.value = setup.port;
  resyncBackendCollectionsFromScratch.value = setup.resyncBackendCollectionsFromScratch;
  isSchemaValidationEnabled.value = setup.schemaValidationEnabled;
  mongodbConnectionString.value = setup.mongodbConnectionString;
  serverAuthHeader.value = setup.authHeader;

  collections.value = [...setup.collections];
  collectionInput.value = "";
  collectionReplEndpointInput.value = "";
  collectionRestEndpointInput.value = "";
  autoDeriveEndpoints.value = true;
  editingCollectionIndex.value = null;
  collectionEndpoints.value = { ...setup.collectionEndpoints };

  schemasByCollection.value = { ...setup.schemasByCollection };
  schemaTargetCollection.value = setup.collections[0] ?? "";
  schemaError.value = "";
  schemaPasteError.value = "";
  pastedSchemasByCollection.value = {};
  pastedSchemaInput.value = "";
  isPasteSchemaModalOpen.value = false;
  isSchemaSectionInvalid.value = false;
  destroySchemaEditor();
  configError.value = "";
  invalidFields.value = {
    serverIdentifier: false,
    serverUrl: false,
    serverPort: false,
    mongodbConnectionString: false,
    serverAuthHeader: false,
    collections: false
  };
  syncSchemaValidationState();
}

watch(
  () => props.initialSetup,
  (setup) => {
    loadFromSetup(setup);
  },
  { immediate: true }
);

watch(collectionInput, (nextValue, previousValue) => {
  if (!autoDeriveEndpoints.value) {
    return;
  }

  const previousReplDefault = buildDefaultReplEndpoint(previousValue ?? "");
  const nextReplDefault = buildDefaultReplEndpoint(nextValue ?? "");
  if (!collectionReplEndpointInput.value.trim() || collectionReplEndpointInput.value === previousReplDefault) {
    collectionReplEndpointInput.value = nextReplDefault;
  }

  const previousRestDefault = buildDefaultRestEndpoint(previousValue ?? "");
  const nextRestDefault = buildDefaultRestEndpoint(nextValue ?? "");
  if (!collectionRestEndpointInput.value.trim() || collectionRestEndpointInput.value === previousRestDefault) {
    collectionRestEndpointInput.value = nextRestDefault;
  }
});

watch(autoDeriveEndpoints, (enabled) => {
  if (!enabled) {
    return;
  }

  applyDefaultReplEndpointIfBlank();
  applyDefaultRestEndpointIfBlank();
});

watch(schemaTargetCollection, (nextCollection, previousCollection) => {
  const previousKey = previousCollection.trim();
  if (previousKey) {
    pastedSchemasByCollection.value[previousKey] = pastedSchemaInput.value;
  }

  const nextKey = nextCollection.trim();
  pastedSchemaInput.value = nextKey ? (pastedSchemasByCollection.value[nextKey] ?? "") : "";
  schemaPasteError.value = "";
});

function recordCollectionChange(next: string[]): void {
  collections.value = next;
  for (const name of Object.keys(collectionEndpoints.value)) {
    if (!next.includes(name)) {
      delete collectionEndpoints.value[name];
    }
  }
  for (const name of Object.keys(pastedSchemasByCollection.value)) {
    if (!next.includes(name)) {
      delete pastedSchemasByCollection.value[name];
    }
  }

  if (schemaTargetCollection.value && !next.includes(schemaTargetCollection.value)) {
    schemaTargetCollection.value = "";
  }
}

function applyCollectionNameModifier(collectionName: string): string {
  const trimmed = collectionName.trim();
  if (!trimmed) {
    return "";
  }

  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function buildDefaultReplEndpoint(collectionName: string): string {
  const modifiedCollectionName = applyCollectionNameModifier(collectionName);
  if (!modifiedCollectionName) {
    return "";
  }

  return `repl${modifiedCollectionName}/0`;
}

function buildDefaultRestEndpoint(collectionName: string): string {
  const modifiedCollectionName = applyCollectionNameModifier(collectionName);
  if (!modifiedCollectionName) {
    return "";
  }

  return `rest${modifiedCollectionName}/0`;
}

function applyDefaultReplEndpointIfBlank(): void {
  if (!autoDeriveEndpoints.value) {
    return;
  }

  if (collectionReplEndpointInput.value.trim()) {
    return;
  }

  const fallback = buildDefaultReplEndpoint(collectionInput.value);
  if (fallback) {
    collectionReplEndpointInput.value = fallback;
  }
}

function applyDefaultRestEndpointIfBlank(): void {
  if (!autoDeriveEndpoints.value) {
    return;
  }

  if (collectionRestEndpointInput.value.trim()) {
    return;
  }

  const fallback = buildDefaultRestEndpoint(collectionInput.value);
  if (fallback) {
    collectionRestEndpointInput.value = fallback;
  }
}

function addOrUpdateCollection(): void {
  const raw = collectionInput.value.trim();
  if (!raw) {
    return;
  }

  const value = raw;
  const next = [...collections.value];
  const previousName = editingCollectionIndex.value !== null ? collections.value[editingCollectionIndex.value] : null;

  if (editingCollectionIndex.value !== null) {
    next[editingCollectionIndex.value] = value;
  } else {
    if (next.includes(value)) {
      collectionInput.value = "";
      return;
    }
    next.push(value);
  }

  recordCollectionChange(next);

  if (previousName !== null) {
    if (previousName !== value && schemasByCollection.value[previousName] !== undefined) {
      schemasByCollection.value[value] = schemasByCollection.value[previousName];
      delete schemasByCollection.value[previousName];
    }
    if (previousName !== value && pastedSchemasByCollection.value[previousName] !== undefined) {
      pastedSchemasByCollection.value[value] = pastedSchemasByCollection.value[previousName];
      delete pastedSchemasByCollection.value[previousName];
    }

    const previousEndpoints = collectionEndpoints.value[previousName];
    if (previousName !== value && previousEndpoints) {
      collectionEndpoints.value[value] = previousEndpoints;
      delete collectionEndpoints.value[previousName];
    }
  }

  const replEndpoint =
    collectionReplEndpointInput.value.trim() || (autoDeriveEndpoints.value ? buildDefaultReplEndpoint(value) : "");
  const restEndpoint =
    collectionRestEndpointInput.value.trim() || (autoDeriveEndpoints.value ? buildDefaultRestEndpoint(value) : "");
  collectionEndpoints.value[value] = {
    replEndpoint,
    restEndpoint
  };

  schemaTargetCollection.value = value;
  collectionInput.value = "";
  collectionReplEndpointInput.value = "";
  collectionRestEndpointInput.value = "";
  editingCollectionIndex.value = null;
  syncSchemaValidationState();
}

function editCollection(index: number): void {
  const name = collections.value[index];
  collectionInput.value = name;
  const endpoints = collectionEndpoints.value[name];
  collectionReplEndpointInput.value = endpoints?.replEndpoint ?? "";
  collectionRestEndpointInput.value = endpoints?.restEndpoint ?? "";
  editingCollectionIndex.value = index;
}

function removeCollection(index: number): void {
  const name = collections.value[index];
  const next = collections.value.filter((_, i) => i !== index);
  recordCollectionChange(next);
  if (name) {
    delete schemasByCollection.value[name];
    delete pastedSchemasByCollection.value[name];
  }
  if (editingCollectionIndex.value === index) {
    editingCollectionIndex.value = null;
    collectionInput.value = "";
    collectionReplEndpointInput.value = "";
    collectionRestEndpointInput.value = "";
  }
  syncSchemaValidationState();
}

function clearCollectionInputs(): void {
  collectionInput.value = "";
  collectionReplEndpointInput.value = "";
  collectionRestEndpointInput.value = "";
  editingCollectionIndex.value = null;
}

function commitPendingCollectionEndpointDraft(): void {
  const editingName = editingCollectionIndex.value !== null ? collections.value[editingCollectionIndex.value] ?? "" : "";
  const typedName = collectionInput.value.trim();
  const targetCollection =
    editingName || (typedName && collections.value.includes(typedName) ? typedName : "");

  if (!targetCollection) {
    return;
  }

  const existing = collectionEndpoints.value[targetCollection];
  const replEndpoint =
    collectionReplEndpointInput.value.trim() ||
    existing?.replEndpoint ||
    (autoDeriveEndpoints.value ? buildDefaultReplEndpoint(targetCollection) : "");
  const restEndpoint =
    collectionRestEndpointInput.value.trim() ||
    existing?.restEndpoint ||
    (autoDeriveEndpoints.value ? buildDefaultRestEndpoint(targetCollection) : "");

  collectionEndpoints.value[targetCollection] = {
    replEndpoint,
    restEndpoint
  };
}

function hasOutstandingSchemas(): boolean {
  return collections.value.some((name) => schemasByCollection.value[name] === undefined);
}

function syncSchemaValidationState(showErrors = false): boolean {
  if (!isSchemaValidationEnabled.value) {
    isSchemaSectionInvalid.value = false;
    if (schemaError.value.includes("missing schemas")) {
      schemaError.value = "";
    }
    return false;
  }

  const missingSchemas = hasOutstandingSchemas();

  if (missingSchemas) {
    isSchemaSectionInvalid.value = showErrors;
    if (showErrors) {
      schemaError.value = "Schema validation is enabled and there are collections with missing schemas.";
    } else if (schemaError.value.includes("missing schemas")) {
      schemaError.value = "";
    }
    return true;
  }

  isSchemaSectionInvalid.value = false;
  if (schemaError.value.includes("missing schemas")) {
    schemaError.value = "";
  }

  return false;
}

function validateRequiredSetupFieldsForSchemaActions(): boolean {
  invalidFields.value = {
    serverIdentifier: false,
    serverUrl: false,
    serverPort: false,
    mongodbConnectionString: false,
    serverAuthHeader: false,
    collections: false
  };

  if (!serverIdentifier.value.trim()) {
    invalidFields.value.serverIdentifier = true;
    configError.value = "Save setup before managing schemas: complete all required fields and add at least one collection.";
    return false;
  }

  if (!serverUrl.value.trim()) {
    invalidFields.value.serverUrl = true;
    configError.value = "Save setup before managing schemas: complete all required fields and add at least one collection.";
    return false;
  }

  if (!serverPort.value.trim()) {
    invalidFields.value.serverPort = true;
    configError.value = "Save setup before managing schemas: complete all required fields and add at least one collection.";
    return false;
  }

  if (!mongodbConnectionString.value.trim()) {
    invalidFields.value.mongodbConnectionString = true;
    configError.value = "Save setup before managing schemas: complete all required fields and add at least one collection.";
    return false;
  }

  if (collections.value.length === 0) {
    invalidFields.value.collections = true;
    configError.value = "Save setup before managing schemas: complete all required fields and add at least one collection.";
    return false;
  }

  configError.value = "";
  return true;
}

async function ensureSetupStagedForSchemaActions(validateLocally = true): Promise<boolean> {
  if (validateLocally && !validateRequiredSetupFieldsForSchemaActions()) {
    return false;
  }

  try {
    await stageServerConfig(buildPayload());
    return true;
  } catch (error) {
    schemaError.value = getApiErrorMessage(error, "Failed to save setup before managing schemas.");
    return false;
  }
}

async function uploadSchema(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  if (!isSchemaValidationEnabled.value) {
    schemaError.value = "";
    input.value = "";
    return;
  }

  schemaError.value = "";

  const target = schemaTargetCollection.value;
  if (!target) {
    schemaError.value = "Select a collection before uploading a schema.";
    return;
  }

  const file = input.files?.[0];
  if (!file) {
    return;
  }

  if (!(await ensureSetupStagedForSchemaActions())) {
    input.value = "";
    return;
  }

  try {
    const text = await file.text();
    const parsed = JSON.parse(text) as unknown;

    try {
      await upsertServerSchema(target, parsed);
      schemasByCollection.value[target] = parsed;
      syncSchemaValidationState();
    } catch (error) {
      schemaError.value = getApiErrorMessage(error, "Schema upload failed. Unable to contact backend service is it running ?");
    }
  } catch {
    schemaError.value = "Schema file must be valid JSON.";
  } finally {
    input.value = "";
  }
}

function validatePastedSchema(): unknown | null {
  const text = pastedSchemaInput.value.trim();
  if (!text) {
    schemaPasteError.value = "";
    return null;
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      schemaPasteError.value = "Schema must be a JSON object.";
      return null;
    }

    const validSchema = schemaAjv.validateSchema(parsed);
    if (!validSchema) {
      const issues = (schemaAjv.errors ?? [])
        .map((entry) => `${entry.instancePath || "/"} ${entry.message ?? "is invalid"}`)
        .join("; ");
      schemaPasteError.value = issues ? `Invalid JSON Schema: ${issues}` : "Invalid JSON Schema.";
      return null;
    }

    schemaPasteError.value = "";
    return parsed;
  } catch {
    schemaPasteError.value = "Schema must be valid JSON.";
    return null;
  }
}

function onPastedSchemaInput(): void {
  if (!isSchemaValidationEnabled.value) {
    schemaPasteError.value = "";
    return;
  }

  const target = schemaTargetCollection.value.trim();
  if (target) {
    pastedSchemasByCollection.value[target] = pastedSchemaInput.value;
  }

  validatePastedSchema();
}

function destroySchemaEditor(): void {
  if (!schemaEditorView) {
    return;
  }

  schemaEditorView.destroy();
  schemaEditorView = null;
}

function syncSchemaEditorFromModel(content: string): void {
  if (!schemaEditorView) {
    return;
  }

  const current = schemaEditorView.state.doc.toString();
  if (current === content) {
    return;
  }

  isSyncingSchemaEditorFromModel = true;
  schemaEditorView.dispatch({
    changes: { from: 0, to: current.length, insert: content }
  });
  isSyncingSchemaEditorFromModel = false;
}

function initializeSchemaEditor(): void {
  const host = schemaEditorHost.value;
  if (!host || schemaEditorView) {
    return;
  }

  const updateListener = EditorView.updateListener.of((update) => {
    if (!update.docChanged || isSyncingSchemaEditorFromModel) {
      return;
    }
    pastedSchemaInput.value = update.state.doc.toString();
    onPastedSchemaInput();
  });

  schemaEditorView = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: pastedSchemaInput.value,
      extensions: [json(), oneDark, EditorView.lineWrapping, updateListener]
    })
  });
}

async function applyPastedSchema(): Promise<void> {
  if (!isSchemaValidationEnabled.value) {
    return;
  }

  schemaError.value = "";
  const target = schemaTargetCollection.value;
  if (!target) {
    schemaError.value = "Select a collection before applying a schema.";
    return;
  }

  const parsed = validatePastedSchema();
  if (parsed === null) {
    if (!pastedSchemaInput.value.trim()) {
      schemaPasteError.value = "Paste a schema JSON before applying.";
    }
    return;
  }

  // Close the modal as soon as parsing succeeds.
  isPasteSchemaModalOpen.value = false;
  schemasByCollection.value[target] = parsed;
}

function openPasteSchemaModal(): void {
  if (!isSchemaValidationEnabled.value) {
    return;
  }

  schemaError.value = "";
  if (!schemaTargetCollection.value) {
    schemaError.value = "Select a collection before editing a schema.";
    return;
  }

  const key = schemaTargetCollection.value.trim();
  const draft = key ? (pastedSchemasByCollection.value[key] ?? "") : "";
  if (draft) {
    pastedSchemaInput.value = draft;
  } else {
    const existingSchema = schemasByCollection.value[key];
    pastedSchemaInput.value = existingSchema === undefined ? "" : JSON.stringify(existingSchema, null, 2);
  }
  isPasteSchemaModalOpen.value = true;
  validatePastedSchema();
}

function closePasteSchemaModal(): void {
  isPasteSchemaModalOpen.value = false;
  schemaPasteError.value = "";
}

function canApplyEditedSchema(): boolean {
  return isSchemaValidationEnabled.value && pastedSchemaInput.value.trim().length > 0 && !schemaPasteError.value;
}

function onSchemaValidationToggle(): void {
  if (!isSchemaValidationEnabled.value) {
    schemaPasteError.value = "";
    isPasteSchemaModalOpen.value = false;
  }
  syncSchemaValidationState();
}

function openSchemaFileBrowser(): void {
  if (!isSchemaValidationEnabled.value) {
    return;
  }

  if (!schemaTargetCollection.value) {
    schemaError.value = "Select a collection before uploading a schema.";
    return;
  }

  schemaError.value = "";
  schemaFileInput.value?.click();
}

function hasSchemaForSelectedCollection(): boolean {
  const target = schemaTargetCollection.value.trim();
  if (!target) {
    return false;
  }

  return schemasByCollection.value[target] !== undefined;
}

function hasValidPastedSchemaInput(): boolean {
  const text = pastedSchemaInput.value.trim();
  if (!text) {
    return false;
  }

  return validatePastedSchema() !== null;
}

function canRemoveSchemaForSelectedCollection(): boolean {
  return hasSchemaForSelectedCollection();
}

function canRemoveSchemaFromPasteModal(): boolean {
  if (hasSchemaForSelectedCollection()) {
    return true;
  }

  return hasValidPastedSchemaInput();
}

async function removeSchema(): Promise<void> {
  if (!isSchemaValidationEnabled.value) {
    return;
  }

  const target = schemaTargetCollection.value;
  if (!target) {
    schemaError.value = "Select a collection before removing a schema.";
    return;
  }

  schemaError.value = "";
  schemaPasteError.value = "";

  if (!hasSchemaForSelectedCollection()) {
    if (hasValidPastedSchemaInput()) {
      delete pastedSchemasByCollection.value[target];
      pastedSchemaInput.value = "";
      return;
    }

    return;
  }

  // Always remove from local setup state without triggering save/validation flows.
  delete schemasByCollection.value[target];
  delete pastedSchemasByCollection.value[target];
  pastedSchemaInput.value = "";
  syncSchemaValidationState();
  isPasteSchemaModalOpen.value = false;

  try {
    await removeServerSchema(target);
  } catch (error) {
    // Keep local remove behavior. Ignore backend setup-state errors for unsaved setups.
    const message = getApiErrorMessage(error, "Schema remove failed. Unable to contact backend service is it running ?");
    if (message.includes("No valid server setup exists")) {
      return;
    }
    schemaError.value = message;
  }
}

watch(pastedSchemaInput, () => {
  if (!isPasteSchemaModalOpen.value) {
    return;
  }
  syncSchemaEditorFromModel(pastedSchemaInput.value);
});

watch(isPasteSchemaModalOpen, async (open) => {
  if (open) {
    await nextTick();
    initializeSchemaEditor();
    syncSchemaEditorFromModel(pastedSchemaInput.value);
    schemaEditorView?.focus();
    return;
  }

  destroySchemaEditor();
});

onBeforeUnmount(() => {
  destroySchemaEditor();
});

function buildPayload(): ServerSetup {
  const payload: ServerSetup = {
    serverIdentifier: serverIdentifier.value.trim(),
    url: serverUrl.value.trim(),
    port: serverPort.value.trim(),
    resyncBackendCollectionsFromScratch: resyncBackendCollectionsFromScratch.value,
    schemaValidationEnabled: isSchemaValidationEnabled.value,
    mongodbConnectionString: mongodbConnectionString.value.trim(),
    authHeader: serverAuthHeader.value.trim(),
    collections: [...collections.value],
    collectionEndpoints: {},
    schemasByCollection: {}
  };

  for (const collection of payload.collections) {
    const endpoints = collectionEndpoints.value[collection];
    if (endpoints) {
      payload.collectionEndpoints[collection] = {
        replEndpoint: endpoints.replEndpoint,
        restEndpoint: endpoints.restEndpoint
      };
    }

    if (schemasByCollection.value[collection] !== undefined) {
      payload.schemasByCollection[collection] = schemasByCollection.value[collection];
    }
  }

  return payload;
}

function clearInvalid(field: keyof typeof invalidFields.value): void {
  invalidFields.value[field] = false;
}

function validateSetup(): boolean {
  invalidFields.value = {
    serverIdentifier: false,
    serverUrl: false,
    serverPort: false,
    mongodbConnectionString: false,
    serverAuthHeader: false,
    collections: false
  };

  if (!serverIdentifier.value.trim()) {
    invalidFields.value.serverIdentifier = true;
    configError.value = "Please complete all required fields and add at least one collection.";
    return false;
  }

  if (!serverUrl.value.trim()) {
    invalidFields.value.serverUrl = true;
    configError.value = "Please complete all required fields and add at least one collection.";
    return false;
  }

  if (!serverPort.value.trim()) {
    invalidFields.value.serverPort = true;
    configError.value = "Please complete all required fields and add at least one collection.";
    return false;
  }

  if (!mongodbConnectionString.value.trim()) {
    invalidFields.value.mongodbConnectionString = true;
    configError.value = "Please complete all required fields and add at least one collection.";
    return false;
  }

  if (collections.value.length === 0) {
    invalidFields.value.collections = true;
    configError.value = "Please complete all required fields and add at least one collection.";
    return false;
  }

  const hasMissingSchemas = syncSchemaValidationState(true);
  if (isSchemaValidationEnabled.value && hasMissingSchemas) {
    configError.value = "Schema validation is enabled and there are collections with missing schemas.";
    return false;
  }

  configError.value = "";
  return true;
}

function normalizeImportedConfig(input: unknown): ServerSetup | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }

  const value = input as Record<string, unknown>;
  if (
    typeof value.serverIdentifier !== "string" ||
    typeof value.url !== "string" ||
    typeof value.port !== "string" ||
    typeof value.resyncBackendCollectionsFromScratch !== "boolean" ||
    (value.schemaValidationEnabled !== undefined && typeof value.schemaValidationEnabled !== "boolean") ||
    typeof value.mongodbConnectionString !== "string" ||
    typeof value.authHeader !== "string" ||
    !Array.isArray(value.collections) ||
    value.collections.some((entry) => typeof entry !== "string") ||
    (value.collectionEndpoints !== undefined &&
      (typeof value.collectionEndpoints !== "object" || value.collectionEndpoints === null || Array.isArray(value.collectionEndpoints))) ||
    typeof value.schemasByCollection !== "object" ||
    value.schemasByCollection === null ||
    Array.isArray(value.schemasByCollection)
  ) {
    return null;
  }

  return {
    serverIdentifier: value.serverIdentifier,
    url: value.url,
    port: value.port,
    resyncBackendCollectionsFromScratch: value.resyncBackendCollectionsFromScratch as boolean,
    schemaValidationEnabled: typeof value.schemaValidationEnabled === "boolean" ? value.schemaValidationEnabled : true,
    mongodbConnectionString: value.mongodbConnectionString,
    authHeader: value.authHeader,
    collections: value.collections as string[],
    collectionEndpoints:
      value.collectionEndpoints && typeof value.collectionEndpoints === "object" && !Array.isArray(value.collectionEndpoints)
        ? (value.collectionEndpoints as Record<string, { replEndpoint: string; restEndpoint: string }>)
        : {},
    schemasByCollection: value.schemasByCollection as Record<string, unknown>
  };
}

async function importConfig(event: Event): Promise<void> {
  configError.value = "";
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) {
    return;
  }

  try {
    const text = await file.text();
    const parsed = JSON.parse(text) as unknown;
    const normalized = normalizeImportedConfig(parsed);
    if (!normalized) {
      configError.value = "Invalid config file format.";
      return;
    }

    loadFromSetup(normalized);
  } catch {
    configError.value = "Invalid config file. Must be valid JSON.";
  } finally {
    input.value = "";
  }
}

function exportConfig(): void {
  commitPendingCollectionEndpointDraft();

  if (!validateSetup()) {
    return;
  }

  const payload = buildPayload();
  const safeServerName = (payload.serverIdentifier || "unnamed-server")
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `rxdb-workbench-server-config-${safeServerName || "unnamed-server"}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function save(): void {
  commitPendingCollectionEndpointDraft();

  if (!validateSetup()) {
    return;
  }

  const payload = buildPayload();
  emit("save", payload);
}
</script>

<template>
  <div v-if="!isPasteSchemaModalOpen" class="fixed inset-0 z-20 flex items-start justify-center overflow-y-auto bg-black/60 px-4 py-4 sm:items-center">
    <div class="my-auto flex w-full max-w-5xl max-h-[calc(100vh-2rem)] flex-col overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl shadow-black/40">
      <h3 class="text-lg font-semibold tracking-tight">RxDB Server Setup</h3>

      <div class="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <label class="block text-sm">
          <span class="mb-1 block text-slate-300">Server Identifier (Name)</span>
          <input
            v-model="serverIdentifier"
            type="text"
            class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none transition focus:border-sky-500"
            :class="{ 'is-invalid': invalidFields.serverIdentifier }"
            @focus="clearInvalid('serverIdentifier')"
          />
        </label>

        <label class="block text-sm">
          <span class="mb-1 block text-slate-300">Url</span>
          <input
            v-model="serverUrl"
            type="text"
            class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none transition focus:border-sky-500"
            :class="{ 'is-invalid': invalidFields.serverUrl }"
            @focus="clearInvalid('serverUrl')"
          />
        </label>

        <label class="block text-sm">
          <span class="mb-1 block text-slate-300">Port</span>
          <input
            v-model="serverPort"
            type="text"
            class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none transition focus:border-sky-500"
            :class="{ 'is-invalid': invalidFields.serverPort }"
            @focus="clearInvalid('serverPort')"
          />
        </label>

        <div class="block text-sm">
          <span class="mb-1 block text-slate-300">Resync Backend Collections from scratch</span>
          <div class="flex h-[42px] items-center">
            <label class="toggle-switch" aria-label="Resync backend collections from scratch">
              <input
                v-model="resyncBackendCollectionsFromScratch"
                type="checkbox"
              />
              <span class="toggle-slider" />
            </label>
            <span class="ml-3 text-xs font-medium uppercase tracking-wide text-slate-400">
              {{ resyncBackendCollectionsFromScratch ? "On" : "Off" }}
            </span>
          </div>
        </div>

        <label class="block text-sm lg:col-span-2">
          <span class="mb-1 block text-slate-300">Auth Header</span>
          <input
            v-model="serverAuthHeader"
            type="text"
            class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none transition focus:border-sky-500"
            :class="{ 'is-invalid': invalidFields.serverAuthHeader }"
            @focus="clearInvalid('serverAuthHeader')"
          />
        </label>

        <label class="block text-sm lg:col-span-3">
          <span class="mb-1 block text-slate-300">MongoDb connect string</span>
          <input
            v-model="mongodbConnectionString"
            type="text"
            class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none transition focus:border-sky-500"
            :class="{ 'is-invalid': invalidFields.mongodbConnectionString }"
            @focus="clearInvalid('mongodbConnectionString')"
          />
        </label>
      </div>

      <div class="mt-6 max-h-56 overflow-auto rounded-lg border border-slate-700 p-3 pr-1">
        <div class="flex items-center justify-between gap-3">
          <h4 class="text-sm font-semibold text-slate-100">Collections</h4>
          <label class="me-2 inline-flex items-center gap-2 text-xs text-slate-300">
            <input
              v-model="autoDeriveEndpoints"
              type="checkbox"
              class="h-4 w-4 rounded border-slate-600 bg-slate-950 text-sky-500 focus:ring-sky-500"
            />
            <span>Auto derive endpoints</span>
          </label>
        </div>
        <div class="mt-3 flex flex-wrap gap-2">
          <div
            v-for="(name, index) in collections"
            :key="`${name}-${index}`"
            class="inline-flex items-center rounded-full border border-slate-700 bg-slate-950 px-3 py-1 text-sm"
          >
            <button type="button" class="mr-2 text-slate-100 hover:text-sky-300" @click="editCollection(index)">{{ name }}</button>
            <button type="button" class="text-rose-300 hover:text-rose-200" @click="removeCollection(index)">x</button>
          </div>
          <p v-if="collections.length === 0" class="text-sm text-slate-400">No collections added yet.</p>
        </div>

        <div class="mt-3 grid grid-cols-1 gap-3 xl:grid-cols-[minmax(11rem,1fr)_minmax(12rem,1fr)_minmax(12rem,1fr)_auto]">
          <label class="block text-xs text-slate-300">
            <span class="mb-1 block uppercase tracking-wide text-slate-400">Collection</span>
            <input
              v-model="collectionInput"
              type="text"
              class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-sky-500"
              :class="{ 'is-invalid': invalidFields.collections }"
              @focus="clearInvalid('collections')"
            />
          </label>

          <label class="block text-xs text-slate-300">
            <span class="mb-1 block uppercase tracking-wide text-slate-400">Repl Endpoint</span>
            <input
              v-model="collectionReplEndpointInput"
              type="text"
              class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-sky-500"
              @blur="applyDefaultReplEndpointIfBlank"
            />
          </label>

          <label class="block text-xs text-slate-300">
            <span class="mb-1 block uppercase tracking-wide text-slate-400">REST Endpoint</span>
            <input
              v-model="collectionRestEndpointInput"
              type="text"
              class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-sky-500"
              @blur="applyDefaultRestEndpointIfBlank"
            />
          </label>

          <div class="flex items-end gap-2">
            <button
              type="button"
              class="rounded-lg bg-sky-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-sky-500"
              @click="addOrUpdateCollection"
            >
              {{ editingCollectionIndex !== null ? "Update" : "Add" }}
            </button>
            <button
              type="button"
              class="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-200 transition hover:bg-slate-800"
              @click="clearCollectionInputs"
            >
              Clear
            </button>
          </div>
        </div>
      </div>

      <div class="mt-6 max-h-64 overflow-auto rounded-lg border border-slate-700 p-3 pr-1" :class="{ 'is-invalid': isSchemaSectionInvalid }">
        <div class="mb-3 flex items-center justify-between text-sm">
          <span class="text-slate-200">Validation enabled</span>
          <div class="flex items-center">
            <label class="toggle-switch" aria-label="Schema validation enabled">
              <input
                v-model="isSchemaValidationEnabled"
                type="checkbox"
                @change="onSchemaValidationToggle"
              />
              <span class="toggle-slider" />
            </label>
            <span class="ml-3 text-xs font-medium uppercase tracking-wide text-slate-400">
              {{ isSchemaValidationEnabled ? "On" : "Off" }}
            </span>
          </div>
        </div>
        <h4 class="text-sm font-semibold text-slate-100">Schema Input</h4>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <select
            v-model="schemaTargetCollection"
            class="min-w-[14rem] rounded-none border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-sky-500"
            :disabled="!isSchemaValidationEnabled"
          >
            <option value="">Select collection</option>
            <option v-for="name in collections" :key="`schema-${name}`" :value="name">{{ name }}</option>
          </select>
          <input
            id="schema-file-upload"
            ref="schemaFileInput"
            type="file"
            accept=".json"
            class="hidden"
            :disabled="!isSchemaValidationEnabled"
            @change="uploadSchema"
          />
          <button
            type="button"
            class="rounded-lg bg-sky-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="!isSchemaValidationEnabled"
            @click="openSchemaFileBrowser"
          >
            Upload Schema
          </button>
          <button
            type="button"
            class="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="!isSchemaValidationEnabled"
            @click="openPasteSchemaModal"
          >
            Edit Schema
          </button>
          <button
            type="button"
            class="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="!isSchemaValidationEnabled || !canRemoveSchemaForSelectedCollection()"
            @click="removeSchema"
          >
            Remove Schema
          </button>
        </div>

        <p v-if="schemaError" class="mt-2 text-sm text-rose-300">{{ schemaError }}</p>

      </div>

      <p v-if="configError" class="mt-2 text-sm text-rose-300">{{ configError }}</p>

      <div class="mt-auto flex items-center justify-end gap-2 pt-4">
        <input
          id="import-config-upload"
          type="file"
          accept=".json"
          class="hidden"
          @change="importConfig"
        />
        <button
          type="button"
          class="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 transition hover:bg-slate-800"
          @click="emit('close')"
        >
          Close
        </button>
        <button
          type="button"
          class="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 transition hover:bg-slate-800"
          @click="exportConfig"
        >
          Export Config
        </button>
        <label
          for="import-config-upload"
          class="inline-flex cursor-pointer items-center rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 transition hover:bg-slate-800"
        >
          Import Config
        </label>
        <button
          type="button"
          class="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-sky-500"
          @click="save"
        >
          Save Setup
        </button>
      </div>
    </div>
  </div>

  <div v-else class="fixed inset-0 z-20 flex items-start justify-center overflow-y-auto bg-black/60 px-4 py-4 sm:items-center">
    <div class="my-auto w-full max-w-6xl max-h-[calc(100vh-2rem)] overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl shadow-black/40">
      <h3 class="text-lg font-semibold tracking-tight">Edit Schema</h3>
      <p class="mt-1 text-sm text-slate-300">
        Collection:
        <span class="font-semibold text-slate-100">{{ schemaTargetCollection }}</span>
      </p>

      <div class="mt-4 rounded-lg border border-slate-700 bg-slate-950/60 p-3">
        <div
          ref="schemaEditorHost"
          class="min-h-[22rem] w-full overflow-hidden rounded-lg border border-slate-700 bg-slate-950 text-xs"
          :class="{ 'is-invalid': !!schemaPasteError }"
        />
      </div>

      <p v-if="schemaPasteError" class="mt-2 text-sm text-rose-300">{{ schemaPasteError }}</p>
      <p v-if="schemaError" class="mt-2 text-sm text-rose-300">{{ schemaError }}</p>

      <div class="mt-4 flex items-center justify-end gap-2">
        <button
          type="button"
          class="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 transition hover:bg-slate-800"
          @click="closePasteSchemaModal"
        >
          Cancel
        </button>
        <button
          type="button"
          class="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="!isSchemaValidationEnabled || !canRemoveSchemaFromPasteModal()"
            @click="removeSchema"
          >
            Remove Schema
          </button>
        <button
          type="button"
          class="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="!canApplyEditedSchema()"
          @click="applyPastedSchema"
        >
          Apply Schema
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.is-invalid {
  border-color: rgb(244 63 94 / 1);
}

.toggle-switch {
  position: relative;
  display: inline-block;
  width: 44px;
  height: 24px;
}

.toggle-switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-slider {
  position: absolute;
  inset: 0;
  cursor: pointer;
  border-radius: 9999px;
  background-color: rgb(51 65 85 / 1);
  border: 1px solid rgb(71 85 105 / 1);
  transition: all 0.2s ease;
}

.toggle-slider::before {
  content: "";
  position: absolute;
  height: 18px;
  width: 18px;
  left: 2px;
  top: 2px;
  border-radius: 9999px;
  background-color: rgb(226 232 240 / 1);
  transition: transform 0.2s ease;
}

.toggle-switch input:checked + .toggle-slider {
  background-color: rgb(14 165 233 / 1);
  border-color: rgb(14 165 233 / 1);
}

.toggle-switch input:checked + .toggle-slider::before {
  transform: translateX(20px);
}

.toggle-switch input:focus-visible + .toggle-slider {
  box-shadow: 0 0 0 2px rgb(14 165 233 / 0.35);
}

:deep(.cm-editor) {
  height: 22rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
}

:deep(.cm-scroller) {
  overflow: auto;
}
</style>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import Ajv, { type ValidateFunction } from "ajv";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { json } from "@codemirror/lang-json";
import { oneDark } from "@codemirror/theme-one-dark";
import VSelect from "vue-select";
import "vue-select/dist/vue-select.css";
import {
  getCollectionDocumentCount,
  getCollectionDocuments,
  removeCollectionDocuments,
  resetCollection,
  resyncCollection,
  upsertCollectionDocument
} from "../../lib/backendApi";
import { Check, ChevronLeft, ChevronRight, Download, Pencil, Plus, RefreshCw, RotateCcw, Trash2 } from "lucide-vue-next";
import JsonTreeNode from "./JsonTreeNode.vue";

const props = defineProps<{
  collections: string[];
  schemaValidationEnabled: boolean;
  schemasByCollection: Record<string, unknown>;
  lastCollectionChange: {
    at: string;
    collection: string;
    changeCount: number;
    operations: string[];
  } | null;
  collectionChangeVersion: number;
}>();

const selectedCollection = ref<string | null>(null);
const queryInput = ref("");
const appliedQuery = ref("");
const selectedCollectionCount = ref<number | null>(null);
const loadingCount = ref(false);
const loadingDocs = ref(false);
const collectionDocs = ref<Array<Record<string, unknown>>>([]);
const isBulkDeleteConfirmOpen = ref(false);
const isApplyDeleteConfirmOpen = ref(false);
const isExportDataConfirmOpen = ref(false);
const isResetCollectionConfirmOpen = ref(false);
const isDocEditModalOpen = ref(false);
const isExportingData = ref(false);
const isResyncing = ref(false);
const isResettingCollection = ref(false);
const isApplyingDocEdit = ref(false);
const isRemovingDocs = ref(false);
const editDocIndex = ref<number | null>(null);
const editDocCollectionName = ref<string | null>(null);
const editDocJson = ref("");
const editDocError = ref("");
const isEditDocJsonValid = ref(true);
const removeDocsError = ref("");
const unfilteredCollectionCount = ref<number | null>(null);
const currentPage = ref(1);
const pageSize = 100;
const selectedColumns = ref(1);
const markedDeleteDocKeys = ref<Set<string>>(new Set());
const editDocEditorHost = ref<HTMLDivElement | null>(null);
let collectionChangeRefreshTimer: number | null = null;
let countRequestId = 0;
let docsRequestId = 0;
const ajv = new Ajv({ allErrors: true, strict: false });
const collectionValidators = new Map<string, ValidateFunction>();
let editDocEditorView: EditorView | null = null;
let isSyncingEditorFromModel = false;

const collectionOptions = computed(() =>
  Array.from(new Set(props.collections.map((name) => name.trim()).filter(Boolean)))
);

async function refreshSelectedCollectionCount(): Promise<void> {
  if (!selectedCollection.value) {
    selectedCollectionCount.value = null;
    return;
  }

  const requestId = ++countRequestId;
  loadingCount.value = true;
  try {
    const count = await getCollectionDocumentCount(selectedCollection.value, appliedQuery.value);
    if (requestId === countRequestId) {
      selectedCollectionCount.value = count;
      const totalPages = Math.max(1, Math.ceil(count / pageSize));
      if (currentPage.value > totalPages) {
        currentPage.value = totalPages;
      }
    }
  } catch {
    if (requestId === countRequestId) {
      selectedCollectionCount.value = null;
    }
  } finally {
    if (requestId === countRequestId) {
      loadingCount.value = false;
    }
  }
}

async function refreshSelectedCollectionDocs(): Promise<void> {
  if (!selectedCollection.value) {
    collectionDocs.value = [];
    markedDeleteDocKeys.value = new Set();
    return;
  }

  const requestId = ++docsRequestId;
  loadingDocs.value = true;
  try {
    const docs = await getCollectionDocuments(selectedCollection.value, pageSize, currentPage.value, appliedQuery.value);
    if (requestId === docsRequestId) {
      collectionDocs.value = docs;
      markedDeleteDocKeys.value = new Set();
    }
  } catch {
    if (requestId === docsRequestId) {
      collectionDocs.value = [];
      markedDeleteDocKeys.value = new Set();
    }
  } finally {
    if (requestId === docsRequestId) {
      loadingDocs.value = false;
    }
  }
}

const totalPages = computed(() => {
  if (!selectedCollectionCount.value || selectedCollectionCount.value <= 0) {
    return 1;
  }
  return Math.max(1, Math.ceil(selectedCollectionCount.value / pageSize));
});

const pageStart = computed(() => (selectedCollectionCount.value && selectedCollectionCount.value > 0 ? (currentPage.value - 1) * pageSize + 1 : 0));
const pageEnd = computed(() => {
  if (!selectedCollectionCount.value || selectedCollectionCount.value <= 0) {
    return 0;
  }
  return Math.min(selectedCollectionCount.value, currentPage.value * pageSize);
});

const hasAppliedQuery = computed(() => Boolean(appliedQuery.value.trim()));

const bulkDeleteTargetCount = computed(() => {
  const total = Math.max(0, selectedCollectionCount.value ?? collectionDocs.value.length);
  if (hasAppliedQuery.value) {
    // Query-selected delete targets all matched docs (no cap).
    return total;
  }
  // Without query, keep capped behavior.
  return Math.min(100, total);
});

function canGoPrevPage(): boolean {
  return currentPage.value > 1 && !loadingDocs.value;
}

function canGoNextPage(): boolean {
  return currentPage.value < totalPages.value && !loadingDocs.value;
}

async function goToPrevPage(): Promise<void> {
  if (!canGoPrevPage()) {
    return;
  }
  currentPage.value -= 1;
  await refreshSelectedCollectionDocs();
}

async function goToNextPage(): Promise<void> {
  if (!canGoNextPage()) {
    return;
  }
  currentPage.value += 1;
  await refreshSelectedCollectionDocs();
}

function openBulkDeleteConfirm(): void {
  if (!selectedCollection.value) {
    return;
  }
  isBulkDeleteConfirmOpen.value = true;
}

function closeBulkDeleteConfirm(): void {
  isBulkDeleteConfirmOpen.value = false;
}

async function confirmBulkDelete(): Promise<void> {
  const collectionName = selectedCollection.value?.trim();
  if (!collectionName || isRemovingDocs.value) {
    return;
  }

  removeDocsError.value = "";
  isRemovingDocs.value = true;
  try {
    if (hasAppliedQuery.value) {
      await removeCollectionDocuments(collectionName, {
        query: appliedQuery.value
      });
    } else {
      const docsToDelete = collectionDocs.value.slice(0, 100);
      if (docsToDelete.length > 0) {
        await removeCollectionDocuments(collectionName, {
          docs: docsToDelete
        });
      }
    }

    closeBulkDeleteConfirm();
    markedDeleteDocKeys.value = new Set();
    await refreshSelectedCollectionCount();
    await refreshSelectedCollectionDocs();
  } catch (error) {
    removeDocsError.value = error instanceof Error ? error.message : "Failed to remove documents.";
  } finally {
    isRemovingDocs.value = false;
  }
}

function docKeyForIndex(docIndex: number): string {
  return `${currentPage.value}:${docIndex}`;
}

function isDocMarkedForDelete(docIndex: number): boolean {
  return markedDeleteDocKeys.value.has(docKeyForIndex(docIndex));
}

function toggleDocMarkedForDelete(docIndex: number): void {
  const key = docKeyForIndex(docIndex);
  const next = new Set(markedDeleteDocKeys.value);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  markedDeleteDocKeys.value = next;
  removeDocsError.value = "";
}

function openDocEditModal(docIndex: number): void {
  const doc = collectionDocs.value[docIndex];
  if (!doc) {
    return;
  }

  editDocIndex.value = docIndex;
  editDocCollectionName.value = selectedCollection.value?.trim() || null;
  editDocJson.value = JSON.stringify(doc, null, 2);
  editDocError.value = "";
  isEditDocJsonValid.value = true;
  isDocEditModalOpen.value = true;
  parseEditedDocInput();
}

function closeDocEditModal(): void {
  isDocEditModalOpen.value = false;
  editDocIndex.value = null;
  editDocCollectionName.value = null;
  editDocJson.value = "";
  editDocError.value = "";
  isEditDocJsonValid.value = true;
  isApplyingDocEdit.value = false;
}

function destroyEditDocEditor(): void {
  if (!editDocEditorView) {
    return;
  }
  editDocEditorView.destroy();
  editDocEditorView = null;
}

function syncEditorFromModel(content: string): void {
  if (!editDocEditorView) {
    return;
  }

  const current = editDocEditorView.state.doc.toString();
  if (current === content) {
    return;
  }

  isSyncingEditorFromModel = true;
  editDocEditorView.dispatch({
    changes: { from: 0, to: current.length, insert: content }
  });
  isSyncingEditorFromModel = false;
}

function initializeEditDocEditor(): void {
  const host = editDocEditorHost.value;
  if (!host || editDocEditorView) {
    return;
  }

  const updateListener = EditorView.updateListener.of((update) => {
    if (!update.docChanged || isSyncingEditorFromModel) {
      return;
    }

    editDocJson.value = update.state.doc.toString();
  });

  editDocEditorView = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: editDocJson.value,
      extensions: [json(), oneDark, EditorView.lineWrapping, updateListener]
    })
  });
}

function parseEditedDocInput(): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(editDocJson.value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      editDocError.value = "Document must be a JSON object.";
      isEditDocJsonValid.value = false;
      return null;
    }

    const collectionName = (editDocCollectionName.value ?? selectedCollection.value ?? "").trim();
    const schemaError = validateDocumentAgainstCollectionSchema(collectionName, parsed as Record<string, unknown>);
    if (schemaError) {
      editDocError.value = schemaError;
      isEditDocJsonValid.value = false;
      return null;
    }

    editDocError.value = "";
    isEditDocJsonValid.value = true;
    return parsed as Record<string, unknown>;
  } catch {
    editDocError.value = "Invalid JSON.";
    isEditDocJsonValid.value = false;
    return null;
  }
}

function getCollectionValidator(collectionName: string): ValidateFunction | null {
  const collection = collectionName.trim();
  if (!collection || !props.schemaValidationEnabled) {
    return null;
  }

  if (collectionValidators.has(collection)) {
    return collectionValidators.get(collection) ?? null;
  }

  const schema = props.schemasByCollection[collection];
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return null;
  }

  const validator = ajv.compile(schema);
  collectionValidators.set(collection, validator);
  return validator;
}

function validateDocumentAgainstCollectionSchema(collectionName: string, doc: Record<string, unknown>): string | null {
  const validator = getCollectionValidator(collectionName);
  if (!validator) {
    return null;
  }

  const valid = validator(doc);
  if (valid) {
    return null;
  }

  const details = (validator.errors ?? [])
    .map((entry) => `${entry.instancePath || "/"} ${entry.message ?? "is invalid"}`)
    .join("; ");
  return details ? `Schema validation failed: ${details}` : "Schema validation failed.";
}

async function applyDocEdit(): Promise<void> {
  const index = editDocIndex.value;
  if (index === null || index < 0 || index >= collectionDocs.value.length) {
    closeDocEditModal();
    return;
  }

  const parsedDoc = parseEditedDocInput();
  if (!parsedDoc) {
    return;
  }

  const collectionName = (editDocCollectionName.value ?? selectedCollection.value ?? "").trim();
  if (!collectionName) {
    return;
  }

  isApplyingDocEdit.value = true;
  try {
    console.log("[Collection doc edit] apply requested", { collectionName, index });
    const savedDoc = await upsertCollectionDocument(collectionName, parsedDoc);
    console.log("[Collection doc edit] apply completed", { collectionName, index });
    const next = [...collectionDocs.value];
    next[index] = savedDoc;
    collectionDocs.value = next;
    closeDocEditModal();
  } catch (error) {
    console.error("[Collection doc edit] apply failed", error);
    editDocError.value = error instanceof Error ? error.message : "Failed to save document.";
  } finally {
    isApplyingDocEdit.value = false;
  }
}

const selectedDeleteCount = computed(() => markedDeleteDocKeys.value.size);
const documentsGridClass = computed(() => {
  if (selectedColumns.value === 2) {
    return "grid grid-cols-1 gap-2 lg:grid-cols-2";
  }
  if (selectedColumns.value === 3) {
    return "grid grid-cols-1 gap-2 lg:grid-cols-3";
  }
  return "grid grid-cols-1 gap-2";
});

function openApplyDeleteConfirm(): void {
  if (selectedDeleteCount.value <= 0) {
    return;
  }
  isApplyDeleteConfirmOpen.value = true;
}

function closeApplyDeleteConfirm(): void {
  isApplyDeleteConfirmOpen.value = false;
}

async function confirmApplyDelete(): Promise<void> {
  const collectionName = selectedCollection.value?.trim();
  if (!collectionName || isRemovingDocs.value) {
    return;
  }

  const docsToDelete = collectionDocs.value.filter((_doc, index) => isDocMarkedForDelete(index));
  if (docsToDelete.length === 0) {
    closeApplyDeleteConfirm();
    return;
  }

  removeDocsError.value = "";
  isRemovingDocs.value = true;
  try {
    await removeCollectionDocuments(collectionName, {
      docs: docsToDelete
    });
    markedDeleteDocKeys.value = new Set();
    closeApplyDeleteConfirm();
    await refreshSelectedCollectionCount();
    await refreshSelectedCollectionDocs();
  } catch (error) {
    removeDocsError.value = error instanceof Error ? error.message : "Failed to remove documents.";
  } finally {
    isRemovingDocs.value = false;
  }
}

function openExportDataConfirm(): void {
  if (!selectedCollection.value) {
    return;
  }
  const collectionName = selectedCollection.value.trim();
  unfilteredCollectionCount.value = null;
  void getCollectionDocumentCount(collectionName, "")
    .then((count) => {
      unfilteredCollectionCount.value = count;
    })
    .catch(() => {
      unfilteredCollectionCount.value = null;
    });
  isExportDataConfirmOpen.value = true;
}

function closeExportDataConfirm(): void {
  if (isExportingData.value) {
    return;
  }
  isExportDataConfirmOpen.value = false;
}

function safeCollectionFileName(collectionName: string): string {
  return collectionName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function downloadJsonData(collectionName: string, scope: "selection" | "all", docs: Array<Record<string, unknown>>): void {
  const blob = new Blob([JSON.stringify(docs, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const safeCollection = safeCollectionFileName(collectionName) || "collection";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  anchor.href = url;
  anchor.download = `${safeCollection}-${scope}-${timestamp}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

async function exportCurrentPageData(): Promise<void> {
  const collectionName = selectedCollection.value?.trim();
  if (!collectionName) {
    return;
  }

  isExportingData.value = true;
  try {
    const totalCount = selectedCollectionCount.value ?? (await getCollectionDocumentCount(collectionName, appliedQuery.value));
    const totalPagesToFetch = Math.max(1, Math.ceil(Math.max(0, totalCount) / pageSize));
    const matchingDocs: Array<Record<string, unknown>> = [];

    for (let page = 1; page <= totalPagesToFetch; page += 1) {
      const docs = await getCollectionDocuments(collectionName, pageSize, page, appliedQuery.value);
      if (docs.length === 0) {
        break;
      }
      matchingDocs.push(...docs);
      if (docs.length < pageSize) {
        break;
      }
    }

    downloadJsonData(collectionName, "selection", matchingDocs);
    isExportDataConfirmOpen.value = false;
  } finally {
    isExportingData.value = false;
  }
}

async function exportCompleteCollectionData(): Promise<void> {
  const collectionName = selectedCollection.value?.trim();
  if (!collectionName) {
    return;
  }

  isExportingData.value = true;
  try {
    const totalCount = await getCollectionDocumentCount(collectionName, "");
    const totalPagesToFetch = Math.max(1, Math.ceil(Math.max(0, totalCount) / pageSize));
    const allDocs: Array<Record<string, unknown>> = [];

    for (let page = 1; page <= totalPagesToFetch; page += 1) {
      const docs = await getCollectionDocuments(collectionName, pageSize, page, "");
      if (docs.length === 0) {
        break;
      }
      allDocs.push(...docs);
      if (docs.length < pageSize) {
        break;
      }
    }

    downloadJsonData(collectionName, "all", allDocs);
    isExportDataConfirmOpen.value = false;
  } finally {
    isExportingData.value = false;
  }
}

async function triggerResyncCollection(): Promise<void> {
  await triggerResyncCollectionWithOptions();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function isAlreadyRunningResyncMessage(message: string): boolean {
  return message.includes("already running") || message.includes("409");
}

function isRuntimeUnavailableForResync(message: string): boolean {
  return message.includes("runtime is not running") || message.includes("\"runtime is not running\"");
}

async function runResyncRequest(collectionName: string): Promise<void> {
  const count = await resyncCollection(collectionName);
  if (count !== null) {
    selectedCollectionCount.value = count;
  } else {
    await refreshSelectedCollectionCount();
  }
  await refreshSelectedCollectionDocs();
}

async function triggerResyncCollectionWithOptions(options?: { collectionName?: string; retryUntilRuntimeReady?: boolean }): Promise<void> {
  const collectionName = (options?.collectionName ?? selectedCollection.value)?.trim();
  if (!collectionName) {
    return;
  }

  isResyncing.value = true;
  try {
    const retryUntilRuntimeReady = options?.retryUntilRuntimeReady === true;
    if (!retryUntilRuntimeReady) {
      try {
        await runResyncRequest(collectionName);
      } catch (error) {
        const message = error instanceof Error ? error.message.toLowerCase() : "";
        if (!isAlreadyRunningResyncMessage(message)) {
          throw error;
        }
      }
      return;
    }

    const maxAttempts = 20;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await runResyncRequest(collectionName);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message.toLowerCase() : "";
        if (isAlreadyRunningResyncMessage(message)) {
          return;
        }
        if (isRuntimeUnavailableForResync(message) && attempt < maxAttempts) {
          await sleep(1000);
          continue;
        }
        throw error;
      }
    }
  } finally {
    isResyncing.value = false;
  }
}

function openResetCollectionConfirm(): void {
  if (!selectedCollection.value) {
    return;
  }
  isResetCollectionConfirmOpen.value = true;
}

function closeResetCollectionConfirm(): void {
  if (isResettingCollection.value) {
    return;
  }
  isResetCollectionConfirmOpen.value = false;
}

function confirmResetCollection(): void {
  const collectionName = selectedCollection.value?.trim();
  if (!collectionName) {
    closeResetCollectionConfirm();
    return;
  }

  collectionDocs.value = [];
  markedDeleteDocKeys.value = new Set();
  selectedCollectionCount.value = 0;
  currentPage.value = 1;

  isResetCollectionConfirmOpen.value = false;
  isResettingCollection.value = true;
  void triggerResyncCollectionWithOptions({ collectionName, retryUntilRuntimeReady: true });
  void resetCollection(collectionName).finally(() => {
    isResettingCollection.value = false;
  });
}

async function submitQuery(): Promise<void> {
  appliedQuery.value = queryInput.value.trim();
  currentPage.value = 1;
  await refreshSelectedCollectionCount();
  await refreshSelectedCollectionDocs();
}

function fillQueryFromKeyPath(path: string): void {
  const normalizedPath = path.trim();
  if (!normalizedPath) {
    return;
  }
  queryInput.value = JSON.stringify({ [normalizedPath]: "" });
}

watch(selectedCollection, async () => {
  closeDocEditModal();
  queryInput.value = "";
  appliedQuery.value = "";
  removeDocsError.value = "";
  currentPage.value = 1;
  await refreshSelectedCollectionCount();
  await refreshSelectedCollectionDocs();
});

watch(editDocJson, () => {
  if (!isDocEditModalOpen.value) {
    return;
  }
  syncEditorFromModel(editDocJson.value);
  parseEditedDocInput();
});

watch(isDocEditModalOpen, async (open) => {
  if (open) {
    await nextTick();
    initializeEditDocEditor();
    syncEditorFromModel(editDocJson.value);
    editDocEditorView?.focus();
    return;
  }

  destroyEditDocEditor();
});

watch(
  () => [props.schemasByCollection, props.schemaValidationEnabled],
  () => {
    collectionValidators.clear();
    if (isDocEditModalOpen.value) {
      parseEditedDocInput();
    }
  },
  { deep: true }
);

watch(
  () => props.collectionChangeVersion,
  async () => {
    const selected = selectedCollection.value?.trim().toLowerCase();
    const changedCollection = props.lastCollectionChange?.collection?.trim().toLowerCase();
    if (!selected || !changedCollection) {
      return;
    }

    if (selected !== changedCollection) {
      return;
    }

    if (collectionChangeRefreshTimer !== null) {
      window.clearTimeout(collectionChangeRefreshTimer);
      collectionChangeRefreshTimer = null;
    }

    collectionChangeRefreshTimer = window.setTimeout(async () => {
      collectionChangeRefreshTimer = null;
      await refreshSelectedCollectionCount();
      await refreshSelectedCollectionDocs();
    }, 200);
  }
);

onBeforeUnmount(() => {
  destroyEditDocEditor();
  if (collectionChangeRefreshTimer !== null) {
    window.clearTimeout(collectionChangeRefreshTimer);
    collectionChangeRefreshTimer = null;
  }
});
</script>

<template>
  <div class="rounded-lg border border-slate-700 bg-slate-950/60 p-4 text-sm text-slate-300">
    <p class="font-medium text-slate-100">Collections</p>

    <div class="mt-3 flex flex-wrap items-center gap-3">
      <div class="w-full max-w-md">
        <VSelect v-model="selectedCollection" :options="collectionOptions" :clearable="false" placeholder="Select collection" />
      </div>
      <p class="text-sm text-slate-300">
        <span class="text-slate-400">Documents:</span>
        <span v-if="selectedCollectionCount !== null" class="ml-1 font-medium text-slate-100">{{ selectedCollectionCount }}</span>
        <span v-else class="ml-1 text-slate-500">-</span>
      </p>
      <button
        type="button"
        class="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="!selectedCollection || loadingCount"
        @click="refreshSelectedCollectionCount"
      >
        <RefreshCw class="h-3.5 w-3.5" :class="loadingCount ? 'animate-spin' : ''" aria-hidden="true" />
        <span>Refresh</span>
      </button>
      <button
        type="button"
        class="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="!selectedCollection || isResyncing || loadingDocs"
        @click="triggerResyncCollection"
      >
        <RefreshCw class="h-3.5 w-3.5" :class="isResyncing ? 'animate-spin' : ''" aria-hidden="true" />
        <span>Resync</span>
      </button>
      <button
        type="button"
        class="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="!selectedCollection || isResettingCollection"
        @click="openResetCollectionConfirm"
      >
        <RotateCcw class="h-3.5 w-3.5 text-amber-300" aria-hidden="true" />
        <span>Reset Collection</span>
      </button>
    </div>

    <form class="mt-3" @submit.prevent="submitQuery">
      <label class="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400" for="collection-query-input">Query</label>
      <div class="flex items-stretch">
        <input
          id="collection-query-input"
          v-model="queryInput"
          type="text"
          class="w-full rounded-l-lg rounded-r-none border border-r-0 border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none"
          @keydown.enter.prevent="submitQuery"
        />
        <button
          type="submit"
          class="inline-flex min-w-[5.5rem] items-center justify-center rounded-l-none rounded-r-lg border border-slate-700 bg-slate-800/60 px-3 text-xs font-medium text-slate-200 transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="!selectedCollection || loadingDocs || loadingCount"
        >
          Submit
        </button>
      </div>
    </form>

    <div class="mt-4 rounded-lg border border-slate-700 bg-slate-950/60 p-3">
      <div class="mb-3 flex flex-wrap items-center gap-2">
        <button type="button" class="inline-flex items-center gap-1 rounded-lg border border-emerald-500/60 bg-emerald-700/20 px-3 py-1.5 text-xs font-medium text-emerald-200">
          <Plus class="h-3.5 w-3.5" aria-hidden="true" />
          <span>ADD DATA</span>
        </button>
        <button
          type="button"
          class="inline-flex items-center gap-1 rounded-lg border border-slate-600 bg-slate-800/50 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="!selectedCollection || isExportingData"
          @click="openExportDataConfirm"
        >
          <Download class="h-3.5 w-3.5" aria-hidden="true" />
          <span>EXPORT DATA</span>
        </button>
      <button
        type="button"
        class="inline-flex items-center gap-1 rounded-lg border border-slate-600 bg-slate-800/50 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="!selectedCollection || loadingDocs || loadingCount || isRemovingDocs || bulkDeleteTargetCount === 0"
        @click="openBulkDeleteConfirm"
      >
          <Trash2 class="h-3.5 w-3.5" aria-hidden="true" />
          <span>DELETE</span>
        </button>
      <button
        type="button"
        class="inline-flex items-center gap-1 rounded-lg border border-slate-600 bg-slate-800/50 px-3 py-1.5 text-xs font-medium text-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="selectedDeleteCount === 0 || isRemovingDocs"
        @click="openApplyDeleteConfirm"
      >
          <Check class="h-3.5 w-3.5" aria-hidden="true" />
          <span>APPLY</span>
        </button>
        <label class="inline-flex items-center gap-2 rounded-lg border border-slate-600 bg-slate-800/50 px-2 py-1.5 text-xs font-medium text-slate-200">
          <span>Columns</span>
          <select
            v-model.number="selectedColumns"
            class="rounded border border-slate-600 bg-slate-900 px-1.5 py-0.5 text-xs text-slate-200 focus:border-sky-500 focus:outline-none"
          >
            <option :value="1">1</option>
            <option :value="2">2</option>
            <option :value="3">3</option>
          </select>
        </label>
        <div class="ml-auto inline-flex items-center gap-1 text-xs text-slate-300">
          <button
            type="button"
            class="inline-flex h-7 w-7 items-center justify-center rounded border border-slate-600 bg-slate-800/40 text-slate-200 transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="!canGoPrevPage()"
            @click="goToPrevPage"
          >
            <ChevronLeft class="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <span class="min-w-[8.5rem] text-center">
            {{ pageStart }}-{{ pageEnd }}
          </span>
          <button
            type="button"
            class="inline-flex h-7 w-7 items-center justify-center rounded border border-slate-600 bg-slate-800/40 text-slate-200 transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="!canGoNextPage()"
            @click="goToNextPage"
          >
            <ChevronRight class="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
      <p v-if="removeDocsError" class="mb-2 text-xs text-rose-300">{{ removeDocsError }}</p>

      <div class="thin-scrollbar max-h-[calc(28rem-5vh-25px)] space-y-2 overflow-y-auto">
        <p v-if="!selectedCollection" class="text-sm text-slate-400">Select a collection to view documents.</p>
        <p v-else-if="collectionDocs.length === 0 && isResyncing" class="text-sm text-amber-300">Waiting on resync</p>
        <p v-else-if="collectionDocs.length === 0" class="text-sm text-slate-400">No documents found.</p>
        <div v-else :class="documentsGridClass">
          <div
            v-for="(doc, docIndex) in collectionDocs"
            :key="`doc-${docIndex}`"
            class="relative rounded-lg border border-slate-700 bg-slate-950 px-3 pt-2 pb-3 font-mono text-xs text-slate-200"
          >
            <div class="absolute right-2 top-2 z-10 flex items-center gap-2">
              <button
                type="button"
                class="inline-flex items-center gap-1 rounded border border-slate-600 bg-slate-900/90 px-2 py-1 text-[11px] font-medium text-slate-200 transition hover:bg-slate-700/90"
                @click="openDocEditModal(docIndex)"
              >
                <Pencil class="h-3 w-3" aria-hidden="true" />
                <span>Edit</span>
              </button>
              <button
                type="button"
                class="inline-flex items-center gap-1 rounded border px-2 py-1 text-[11px] font-medium transition"
                :class="
                  isDocMarkedForDelete(docIndex)
                    ? 'border-amber-500 bg-amber-600/40 text-amber-200 hover:bg-amber-600/50'
                    : 'border-slate-600 bg-slate-900/90 text-slate-200 hover:bg-slate-700/90'
                "
                @click="toggleDocMarkedForDelete(docIndex)"
              >
                <Trash2 class="h-3 w-3" aria-hidden="true" />
                <span>Delete</span>
              </button>
            </div>
            <JsonTreeNode
              v-for="(value, key) in doc"
              :key="`${docIndex}-${String(key)}`"
              :label="String(key)"
              :value="value"
              :depth="0"
              @select-leaf-key="fillQueryFromKeyPath"
            />
          </div>
        </div>
      </div>
    </div>

    <div v-if="isDocEditModalOpen" class="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-black/60 px-4 py-4 sm:items-center">
      <div class="my-auto w-full max-w-3xl max-h-[calc(100vh-2rem)] overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl shadow-black/40">
        <h3 class="text-lg font-semibold tracking-tight text-slate-100">Edit Document</h3>
        <div
          ref="editDocEditorHost"
          class="mt-4 min-h-[22rem] w-full overflow-hidden rounded-lg border border-slate-700 bg-slate-950 text-xs"
          :class="{ 'border-rose-500': !isEditDocJsonValid }"
        />
        <p v-if="editDocError" class="mt-2 text-xs text-rose-300">{{ editDocError }}</p>
        <div class="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            class="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 transition hover:bg-slate-800"
            :disabled="isApplyingDocEdit"
            @click="closeDocEditModal"
          >
            Cancel
          </button>
          <button
            type="button"
            class="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="!isEditDocJsonValid || isApplyingDocEdit"
            @click="applyDocEdit"
          >
            Apply
          </button>
        </div>
      </div>
    </div>

    <div v-if="isBulkDeleteConfirmOpen" class="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-black/60 px-4 py-4 sm:items-center">
      <div class="my-auto w-full max-w-md max-h-[calc(100vh-2rem)] overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl shadow-black/40">
        <h3 class="text-lg font-semibold tracking-tight text-slate-100">Confirm Delete</h3>
        <template v-if="hasAppliedQuery">
          <p class="mt-2 text-sm text-slate-300">
            Delete all {{ bulkDeleteTargetCount }} document{{ bulkDeleteTargetCount === 1 ? "" : "s" }} matching the current query?
          </p>
        </template>
        <template v-else>
          <p class="mt-2 text-sm text-slate-300">
            Delete {{ bulkDeleteTargetCount }} document{{ bulkDeleteTargetCount === 1 ? "" : "s" }}?
          </p>
        </template>
        <div class="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            class="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 transition hover:bg-slate-800"
            @click="closeBulkDeleteConfirm"
          >
            Cancel
          </button>
          <button
            type="button"
            class="rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-rose-500"
            :disabled="isRemovingDocs"
            @click="confirmBulkDelete"
          >
            Delete
          </button>
        </div>
      </div>
    </div>

    <div v-if="isApplyDeleteConfirmOpen" class="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-black/60 px-4 py-4 sm:items-center">
      <div class="my-auto w-full max-w-md max-h-[calc(100vh-2rem)] overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl shadow-black/40">
        <h3 class="text-lg font-semibold tracking-tight text-slate-100">Confirm Delete</h3>
        <p class="mt-2 text-sm text-slate-300">
          Delete {{ selectedDeleteCount }} selected document{{ selectedDeleteCount === 1 ? "" : "s" }}?
        </p>
        <div class="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            class="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 transition hover:bg-slate-800"
            @click="closeApplyDeleteConfirm"
          >
            Cancel
          </button>
          <button
            type="button"
            class="rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-rose-500"
            :disabled="isRemovingDocs"
            @click="confirmApplyDelete"
          >
            Delete
          </button>
        </div>
      </div>
    </div>

    <div v-if="isExportDataConfirmOpen" class="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-black/60 px-4 py-4 sm:items-center">
      <div class="my-auto w-full max-w-md max-h-[calc(100vh-2rem)] overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl shadow-black/40">
        <h3 class="text-lg font-semibold tracking-tight text-slate-100">Export Data</h3>
        <p class="mt-2 text-sm text-slate-300">Choose what to export for this collection.</p>
        <div class="mt-5 grid gap-2">
          <button
            type="button"
            class="rounded-lg border border-slate-700 bg-slate-800/60 px-4 py-2 text-left text-sm text-slate-100 transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="isExportingData"
            @click="exportCurrentPageData"
          >
            Export current selection ({{ selectedCollectionCount ?? 0 }})
          </button>
          <button
            type="button"
            class="rounded-lg border border-slate-700 bg-slate-800/60 px-4 py-2 text-left text-sm text-slate-100 transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="isExportingData"
            @click="exportCompleteCollectionData"
          >
            Export complete collection ({{ unfilteredCollectionCount ?? "-" }})
          </button>
        </div>
        <div class="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            class="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="isExportingData"
            @click="closeExportDataConfirm"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>

    <div v-if="isResetCollectionConfirmOpen" class="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-black/60 px-4 py-4 sm:items-center">
      <div class="my-auto w-full max-w-md max-h-[calc(100vh-2rem)] overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl shadow-black/40">
        <h3 class="text-lg font-semibold tracking-tight text-slate-100">Confirm Collection Reset</h3>
        <p class="mt-2 text-sm text-slate-300">
          This will hard reset and resync collection
          <span class="font-medium text-slate-100">{{ selectedCollection }}</span>.
          Continue?
        </p>
        <div class="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            class="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="isResettingCollection"
            @click="closeResetCollectionConfirm"
          >
            Cancel
          </button>
          <button
            type="button"
            class="rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="isResettingCollection"
            @click="confirmResetCollection"
          >
            Proceed Reset
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
:deep(.vs__dropdown-toggle) {
  border-color: rgb(51 65 85 / 1);
  background-color: rgb(2 6 23 / 1);
  color: rgb(248 250 252 / 1);
}

:deep(.vs__selected) {
  color: rgb(248 250 252 / 1);
}

:deep(.vs__search),
:deep(.vs__search::placeholder) {
  color: rgb(148 163 184 / 1);
}

:deep(.vs__actions) {
  color: rgb(148 163 184 / 1);
}

:deep(.vs__dropdown-menu) {
  border: 1px solid rgb(51 65 85 / 1);
  background-color: rgb(2 6 23 / 1);
  color: rgb(226 232 240 / 1);
}

:deep(.vs__dropdown-option) {
  background-color: transparent;
  color: rgb(226 232 240 / 1);
}

:deep(.vs__dropdown-option--highlight) {
  background-color: rgb(30 41 59 / 1);
  color: rgb(248 250 252 / 1);
}

:deep(.vs__dropdown-option--selected) {
  background-color: rgb(15 23 42 / 1);
  color: rgb(125 252 168 / 1);
}

:deep(.cm-editor) {
  height: 22rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
}

:deep(.cm-scroller) {
  overflow: auto;
}
</style>

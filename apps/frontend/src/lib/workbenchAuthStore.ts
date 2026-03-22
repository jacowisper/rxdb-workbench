import { md5 } from "./md5";

const DB_NAME = "indexdeb";
const DB_VERSION = 1;
const STORE_NAME = "rxdb-workbench-internal";
const AUTH_KEY = "auth";
const LEGACY_SERVER_SETUP_KEY = "rxdbServerSetup";

type InternalRecord = {
  key: string;
  value: unknown;
};

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB."));
  });
}

function runStoreRequest<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDatabase().then(
    (database) =>
      new Promise<T>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, mode);
        const store = transaction.objectStore(STORE_NAME);
        const request = operation(store);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));

        transaction.oncomplete = () => database.close();
        transaction.onerror = () => {
          database.close();
          reject(transaction.error ?? new Error("IndexedDB transaction failed."));
        };
      })
  );
}

async function getRecord(key: string): Promise<unknown | null> {
  const record = await runStoreRequest<InternalRecord | undefined>("readonly", (store) =>
    store.get(key) as IDBRequest<InternalRecord | undefined>
  );

  return record?.value ?? null;
}

async function setRecord(key: string, value: unknown): Promise<void> {
  await runStoreRequest<IDBValidKey>("readwrite", (store) =>
    store.put({ key, value }) as IDBRequest<IDBValidKey>
  );
}

async function deleteRecord(key: string): Promise<void> {
  await runStoreRequest<undefined>("readwrite", (store) => store.delete(key) as IDBRequest<undefined>);
}

async function getAuthHash(): Promise<string | null> {
  const record = await getRecord(AUTH_KEY);
  if (!record || typeof record !== "string") {
    return null;
  }

  return record;
}

async function setAuthHash(hash: string): Promise<void> {
  await setRecord(AUTH_KEY, hash);
}

export async function ensureDefaultAuth(): Promise<void> {
  // Cleanup from older frontend versions that stored server setup in IndexedDB.
  await deleteRecord(LEGACY_SERVER_SETUP_KEY);

  const authHash = await getAuthHash();
  if (!authHash) {
    await setAuthHash(md5("admin/admin"));
  }
}

export async function verifyCredentials(username: string, password: string): Promise<boolean> {
  const authHash = await getAuthHash();
  if (!authHash) {
    return false;
  }

  return md5(`${username}/${password}`) === authHash;
}

export async function updateCredentials(username: string, password: string): Promise<void> {
  await setAuthHash(md5(`${username}/${password}`));
}

export async function getCurrentAuthHash(): Promise<string | null> {
  return getAuthHash();
}

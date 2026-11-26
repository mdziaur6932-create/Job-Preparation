import type { WorkspaceData } from '@/src/types/system';
import { isValidWorkspaceData } from './guest-workspace-storage';
import {
  collectWarmableAssetUrls,
  summarizeOfflineStudyMaterials,
} from './offline-cache-policy';

export const OFFLINE_DB_NAME = 'prostuti_ai_offline_vault_v1';
export const OFFLINE_DB_VERSION = 1;
export const SNAPSHOT_STORE = 'study_snapshots';
export const PDF_BLOB_STORE = 'pdf_blobs';

export interface OfflineWorkspaceSnapshotRecord {
  scopeKey: string;
  data: WorkspaceData;
  savedAt: string;
  booksCount: number;
  chunksCount: number;
  questionsCount: number;
  estimatedBytes: number;
}

export interface OfflinePdfBlobRecord {
  key: string; // `${scopeKey}::${bookId}`
  scopeKey: string;
  bookId: number;
  bookTitle: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  cachedAt: string;
  blob: Blob;
}

export interface OfflinePdfMeta {
  bookId: number;
  bookTitle: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  cachedAt: string;
}

export interface ServiceWorkerCacheStatus {
  registered: boolean;
  active: boolean;
  version: string | null;
  shellEntries: number;
  assetEntries: number;
  pdfEntries: number;
  totalEntries: number;
}

export interface OfflineVaultAdapter {
  putSnapshot(record: OfflineWorkspaceSnapshotRecord): Promise<void>;
  getSnapshot(scopeKey: string): Promise<OfflineWorkspaceSnapshotRecord | null>;
  deleteSnapshot(scopeKey: string): Promise<void>;
  putPdfBlob(record: OfflinePdfBlobRecord): Promise<void>;
  getPdfBlob(scopeKey: string, bookId: number): Promise<OfflinePdfBlobRecord | null>;
  deletePdfBlob(scopeKey: string, bookId: number): Promise<void>;
  listPdfBlobs(scopeKey: string): Promise<OfflinePdfMeta[]>;
  clearScopePdfBlobs(scopeKey: string): Promise<void>;
}

export function buildPdfBlobKey(scopeKey: string, bookId: number): string {
  return `${scopeKey}::${bookId}`;
}

/**
 * Pure, testable store wrapper over any OfflineVaultAdapter (IndexedDB in browser,
 * in-memory adapter in unit tests).
 */
export function createOfflineLibraryStore(adapter: OfflineVaultAdapter) {
  return {
    async saveWorkspaceSnapshot(
      scopeKey: string,
      data: WorkspaceData
    ): Promise<OfflineWorkspaceSnapshotRecord | null> {
      if (!scopeKey || !isValidWorkspaceData(data)) return null;
      const summary = summarizeOfflineStudyMaterials(data);
      const record: OfflineWorkspaceSnapshotRecord = {
        scopeKey,
        data,
        savedAt: new Date().toISOString(),
        booksCount: summary.booksCount,
        chunksCount: summary.chunksCount,
        questionsCount: summary.questionsCount,
        estimatedBytes: summary.estimatedTextBytes,
      };
      await adapter.putSnapshot(record);
      return record;
    },

    async loadWorkspaceSnapshot(
      scopeKey: string
    ): Promise<OfflineWorkspaceSnapshotRecord | null> {
      if (!scopeKey) return null;
      const rec = await adapter.getSnapshot(scopeKey);
      if (!rec || !isValidWorkspaceData(rec.data)) return null;
      return rec;
    },

    async savePdfForBook(params: {
      scopeKey: string;
      bookId: number;
      bookTitle: string;
      file: Blob;
      fileName: string;
      mimeType?: string;
    }): Promise<OfflinePdfMeta> {
      const mimeType =
        params.mimeType ||
        (params.file instanceof File ? params.file.type : params.file.type) ||
        'application/pdf';
      const record: OfflinePdfBlobRecord = {
        key: buildPdfBlobKey(params.scopeKey, params.bookId),
        scopeKey: params.scopeKey,
        bookId: params.bookId,
        bookTitle: params.bookTitle,
        fileName: params.fileName || `${params.bookTitle}.pdf`,
        mimeType,
        sizeBytes: params.file.size,
        cachedAt: new Date().toISOString(),
        blob: params.file,
      };
      await adapter.putPdfBlob(record);
      return {
        bookId: record.bookId,
        bookTitle: record.bookTitle,
        fileName: record.fileName,
        mimeType: record.mimeType,
        sizeBytes: record.sizeBytes,
        cachedAt: record.cachedAt,
      };
    },

    async getPdfForBook(
      scopeKey: string,
      bookId: number
    ): Promise<OfflinePdfBlobRecord | null> {
      if (!scopeKey) return null;
      return adapter.getPdfBlob(scopeKey, bookId);
    },

    async removePdfForBook(scopeKey: string, bookId: number): Promise<void> {
      if (!scopeKey) return;
      await adapter.deletePdfBlob(scopeKey, bookId);
    },

    async listCachedPdfs(scopeKey: string): Promise<OfflinePdfMeta[]> {
      if (!scopeKey) return [];
      return adapter.listPdfBlobs(scopeKey);
    },

    async clearScope(scopeKey: string): Promise<void> {
      if (!scopeKey) return;
      await Promise.all([
        adapter.deleteSnapshot(scopeKey),
        adapter.clearScopePdfBlobs(scopeKey),
      ]);
    },
  };
}

function openOfflineDb(): Promise<IDBDatabase | null> {
  if (typeof window === 'undefined' || !('indexedDB' in window)) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    try {
      const req = window.indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) {
          db.createObjectStore(SNAPSHOT_STORE, { keyPath: 'scopeKey' });
        }
        if (!db.objectStoreNames.contains(PDF_BLOB_STORE)) {
          const pdfStore = db.createObjectStore(PDF_BLOB_STORE, {
            keyPath: 'key',
          });
          pdfStore.createIndex('scopeKey', 'scopeKey', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function createBrowserIndexedDbAdapter(): OfflineVaultAdapter {
  return {
    async putSnapshot(record) {
      const db = await openOfflineDb();
      if (!db) return;
      await new Promise<void>((resolve) => {
        try {
          const tx = db.transaction(SNAPSHOT_STORE, 'readwrite');
          tx.objectStore(SNAPSHOT_STORE).put(record);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
          tx.onabort = () => resolve();
        } catch {
          resolve();
        }
      });
    },

    async getSnapshot(scopeKey) {
      const db = await openOfflineDb();
      if (!db) return null;
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(SNAPSHOT_STORE, 'readonly');
          const req = tx.objectStore(SNAPSHOT_STORE).get(scopeKey);
          req.onsuccess = () =>
            resolve(
              (req.result as OfflineWorkspaceSnapshotRecord | undefined) ?? null
            );
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
    },

    async deleteSnapshot(scopeKey) {
      const db = await openOfflineDb();
      if (!db) return;
      await new Promise<void>((resolve) => {
        try {
          const tx = db.transaction(SNAPSHOT_STORE, 'readwrite');
          tx.objectStore(SNAPSHOT_STORE).delete(scopeKey);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch {
          resolve();
        }
      });
    },

    async putPdfBlob(record) {
      const db = await openOfflineDb();
      if (!db) return;
      await new Promise<void>((resolve) => {
        try {
          const tx = db.transaction(PDF_BLOB_STORE, 'readwrite');
          tx.objectStore(PDF_BLOB_STORE).put(record);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
          tx.onabort = () => resolve();
        } catch {
          resolve();
        }
      });
    },

    async getPdfBlob(scopeKey, bookId) {
      const db = await openOfflineDb();
      if (!db) return null;
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(PDF_BLOB_STORE, 'readonly');
          const req = tx
            .objectStore(PDF_BLOB_STORE)
            .get(buildPdfBlobKey(scopeKey, bookId));
          req.onsuccess = () =>
            resolve((req.result as OfflinePdfBlobRecord | undefined) ?? null);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
    },

    async deletePdfBlob(scopeKey, bookId) {
      const db = await openOfflineDb();
      if (!db) return;
      await new Promise<void>((resolve) => {
        try {
          const tx = db.transaction(PDF_BLOB_STORE, 'readwrite');
          tx.objectStore(PDF_BLOB_STORE).delete(
            buildPdfBlobKey(scopeKey, bookId)
          );
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch {
          resolve();
        }
      });
    },

    async listPdfBlobs(scopeKey) {
      const db = await openOfflineDb();
      if (!db) return [];
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(PDF_BLOB_STORE, 'readonly');
          const idx = tx.objectStore(PDF_BLOB_STORE).index('scopeKey');
          const req = idx.getAll(scopeKey);
          req.onsuccess = () => {
            const rows = (req.result as OfflinePdfBlobRecord[]) || [];
            resolve(
              rows.map((r) => ({
                bookId: r.bookId,
                bookTitle: r.bookTitle,
                fileName: r.fileName,
                mimeType: r.mimeType,
                sizeBytes: r.sizeBytes,
                cachedAt: r.cachedAt,
              }))
            );
          };
          req.onerror = () => resolve([]);
        } catch {
          resolve([]);
        }
      });
    },

    async clearScopePdfBlobs(scopeKey) {
      const db = await openOfflineDb();
      if (!db) return;
      await new Promise<void>((resolve) => {
        try {
          const tx = db.transaction(PDF_BLOB_STORE, 'readwrite');
          const store = tx.objectStore(PDF_BLOB_STORE);
          const idx = store.index('scopeKey');
          const req = idx.getAllKeys(scopeKey);
          req.onsuccess = () => {
            const keys = (req.result as IDBValidKey[]) || [];
            for (const key of keys) {
              store.delete(key);
            }
          };
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch {
          resolve();
        }
      });
    },
  };
}

export const offlineLibraryStore = createOfflineLibraryStore(
  createBrowserIndexedDbAdapter()
);

function postMessageToWorker<T>(
  worker: ServiceWorker,
  message: Record<string, unknown>,
  timeoutMs = 5000
): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      const channel = new MessageChannel();
      const timer = window.setTimeout(() => resolve(null), timeoutMs);
      channel.port1.onmessage = (event) => {
        window.clearTimeout(timer);
        resolve((event.data as T) ?? null);
      };
      worker.postMessage(message, [channel.port2]);
    } catch {
      resolve(null);
    }
  });
}

async function getActiveServiceWorker(): Promise<ServiceWorker | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return null;
  }
  try {
    const reg = await navigator.serviceWorker.getRegistration('/');
    return reg?.active ?? navigator.serviceWorker.controller ?? null;
  } catch {
    return null;
  }
}

export async function registerOfflineServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return null;
  }
  try {
    const registration = await navigator.serviceWorker.register('/sw.js', {
      scope: '/',
      updateViaCache: 'none',
    });
    if (registration.waiting) {
      registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    }
    return registration;
  } catch {
    return null;
  }
}

/**
 * Proactively caches all loaded scripts, stylesheets, fonts, and the current
 * page HTML inside the Service Worker cache so the very first offline reload works.
 */
export async function warmCurrentAppAssetsInSw(): Promise<ServiceWorkerCacheStatus> {
  const empty: ServiceWorkerCacheStatus = {
    registered: false,
    active: false,
    version: null,
    shellEntries: 0,
    assetEntries: 0,
    pdfEntries: 0,
    totalEntries: 0,
  };
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return empty;
  }

  let reg = await navigator.serviceWorker.getRegistration('/');
  if (!reg) {
    reg = (await registerOfflineServiceWorker()) ?? undefined;
  }
  if (!reg) return empty;

  const readyReg = await navigator.serviceWorker.ready.catch(() => reg);
  const worker = readyReg?.active ?? navigator.serviceWorker.controller;
  if (!worker) {
    return { ...empty, registered: true };
  }

  // Collect currently loaded JS/CSS/font resources from Performance & DOM
  const discovered: string[] = [];
  if (typeof document !== 'undefined') {
    document
      .querySelectorAll<HTMLScriptElement>('script[src]')
      .forEach((el) => el.src && discovered.push(el.src));
    document
      .querySelectorAll<HTMLLinkElement>(
        'link[rel="stylesheet"], link[rel="preload"], link[rel="manifest"], link[rel="icon"], link[rel="apple-touch-icon"]'
      )
      .forEach((el) => el.href && discovered.push(el.href));
  }
  if (typeof performance !== 'undefined' && performance.getEntriesByType) {
    const entries = performance.getEntriesByType('resource');
    for (const entry of entries) {
      if (entry.name) discovered.push(entry.name);
    }
  }

  const assetUrls = collectWarmableAssetUrls(discovered, window.location.origin);

  // Warm the root app shell + all active static bundles
  await postMessageToWorker(worker, {
    type: 'WARM_URLS',
    bucket: 'shell',
    urls: [window.location.href, '/'],
  });
  const res = await postMessageToWorker<{
    ok: boolean;
    status?: {
      version: string;
      shellEntries: number;
      assetEntries: number;
      pdfEntries: number;
      totalEntries: number;
    };
  }>(worker, {
    type: 'WARM_URLS',
    bucket: 'asset',
    urls: assetUrls,
  });

  if (res?.status) {
    return {
      registered: true,
      active: true,
      ...res.status,
    };
  }
  return getServiceWorkerCacheStatus();
}

export async function getServiceWorkerCacheStatus(): Promise<ServiceWorkerCacheStatus> {
  const empty: ServiceWorkerCacheStatus = {
    registered: false,
    active: false,
    version: null,
    shellEntries: 0,
    assetEntries: 0,
    pdfEntries: 0,
    totalEntries: 0,
  };
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return empty;
  }
  try {
    const reg = await navigator.serviceWorker.getRegistration('/');
    if (!reg) return empty;
    const worker = await getActiveServiceWorker();
    if (!worker) {
      return { ...empty, registered: true };
    }
    const res = await postMessageToWorker<{
      ok: boolean;
      status?: {
        version: string;
        shellEntries: number;
        assetEntries: number;
        pdfEntries: number;
        totalEntries: number;
      };
    }>(worker, { type: 'GET_CACHE_STATUS' });

    if (res?.status) {
      return {
        registered: true,
        active: true,
        ...res.status,
      };
    }
    return { ...empty, registered: true, active: Boolean(reg.active) };
  } catch {
    return empty;
  }
}

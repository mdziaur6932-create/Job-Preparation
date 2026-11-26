'use client';

import { useCallback, useSyncExternalStore } from 'react';
import {
  EMPTY_CATALOG_OVERRIDES,
  type BookCatalogOverrides,
  type BookContentFormat,
} from './book-catalog-organization';

const STORAGE_PREFIX = 'prostuti_book_catalog_overrides_v1_';
const SYNC_EVENT_NAME = 'prostuti:book-catalog-overrides-changed';

interface CachedOverrideSnapshot {
  raw: string | null;
  value: BookCatalogOverrides;
}

const snapshotCacheByScope = new Map<string, CachedOverrideSnapshot>();

function parseCatalogOverrides(raw: string | null): BookCatalogOverrides {
  if (!raw) return EMPTY_CATALOG_OVERRIDES;
  try {
    const parsed = JSON.parse(raw) as Partial<BookCatalogOverrides>;
    const customMasterByBookId =
      parsed.customMasterByBookId &&
      typeof parsed.customMasterByBookId === 'object'
        ? parsed.customMasterByBookId
        : {};
    const customFormatByBookId =
      parsed.customFormatByBookId &&
      typeof parsed.customFormatByBookId === 'object'
        ? parsed.customFormatByBookId
        : {};
    if (
      Object.keys(customMasterByBookId).length === 0 &&
      Object.keys(customFormatByBookId).length === 0
    ) {
      return EMPTY_CATALOG_OVERRIDES;
    }
    return {
      customMasterByBookId,
      customFormatByBookId,
    };
  } catch {
    return EMPTY_CATALOG_OVERRIDES;
  }
}

export function readBookCatalogOverrides(scopeKey: string): BookCatalogOverrides {
  if (typeof window === 'undefined') return EMPTY_CATALOG_OVERRIDES;
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${scopeKey}`);
    const cached = snapshotCacheByScope.get(scopeKey);
    if (cached && cached.raw === raw) {
      return cached.value;
    }
    const value = parseCatalogOverrides(raw);
    snapshotCacheByScope.set(scopeKey, { raw, value });
    return value;
  } catch {
    return EMPTY_CATALOG_OVERRIDES;
  }
}

export function writeBookCatalogOverrides(
  scopeKey: string,
  next: BookCatalogOverrides
): void {
  if (typeof window === 'undefined') return;
  try {
    const serialized = JSON.stringify(next);
    window.localStorage.setItem(`${STORAGE_PREFIX}${scopeKey}`, serialized);
    snapshotCacheByScope.set(scopeKey, { raw: serialized, value: next });
    window.dispatchEvent(
      new CustomEvent(SYNC_EVENT_NAME, { detail: { scopeKey, next } })
    );
  } catch {
    // Ignore storage quota errors
  }
}

function subscribeCatalogOverrides(onStoreChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(SYNC_EVENT_NAME, onStoreChange);
  window.addEventListener('storage', onStoreChange);
  return () => {
    window.removeEventListener(SYNC_EVENT_NAME, onStoreChange);
    window.removeEventListener('storage', onStoreChange);
  };
}

function getServerCatalogOverridesSnapshot(): BookCatalogOverrides {
  return EMPTY_CATALOG_OVERRIDES;
}

/**
 * React hook keeping Option (ক) Virtual Master Book folder assignments and MCQ/Written
 * format tags synchronized across Book Library, Smart Reader, and Question Lab.
 * Uses useSyncExternalStore so SSR and initial client hydration always match cleanly.
 */
export function useBookCatalogOverrides(scopeKey: string) {
  const getClientSnapshot = useCallback(
    () => readBookCatalogOverrides(scopeKey),
    [scopeKey]
  );

  const overrides = useSyncExternalStore(
    subscribeCatalogOverrides,
    getClientSnapshot,
    getServerCatalogOverridesSnapshot
  );

  const assignBookToMaster = useCallback(
    (bookId: number, masterTitle: string | null) => {
      const current = readBookCatalogOverrides(scopeKey);
      const nextMasters = { ...current.customMasterByBookId };
      const cleaned = (masterTitle || '').trim();
      if (cleaned) {
        nextMasters[String(bookId)] = cleaned;
      } else {
        delete nextMasters[String(bookId)];
      }
      const next: BookCatalogOverrides = {
        ...current,
        customMasterByBookId: nextMasters,
      };
      writeBookCatalogOverrides(scopeKey, next);
    },
    [scopeKey]
  );

  const assignBookFormat = useCallback(
    (bookId: number, format: BookContentFormat | null) => {
      const current = readBookCatalogOverrides(scopeKey);
      const nextFormats = { ...current.customFormatByBookId };
      if (format) {
        nextFormats[String(bookId)] = format;
      } else {
        delete nextFormats[String(bookId)];
      }
      const next: BookCatalogOverrides = {
        ...current,
        customFormatByBookId: nextFormats,
      };
      writeBookCatalogOverrides(scopeKey, next);
    },
    [scopeKey]
  );

  return {
    overrides,
    assignBookToMaster,
    assignBookFormat,
  };
}

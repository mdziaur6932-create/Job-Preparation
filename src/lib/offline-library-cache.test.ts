import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPdfBlobKey,
  createOfflineLibraryStore,
  type OfflinePdfBlobRecord,
  type OfflineVaultAdapter,
  type OfflineWorkspaceSnapshotRecord,
} from './offline-library-cache';
import { createInitialSeedData } from './seed-data';

function createInMemoryVaultAdapter(): OfflineVaultAdapter {
  const snapshots = new Map<string, OfflineWorkspaceSnapshotRecord>();
  const blobs = new Map<string, OfflinePdfBlobRecord>();

  return {
    async putSnapshot(record) {
      snapshots.set(record.scopeKey, record);
    },
    async getSnapshot(scopeKey) {
      return snapshots.get(scopeKey) ?? null;
    },
    async deleteSnapshot(scopeKey) {
      snapshots.delete(scopeKey);
    },
    async putPdfBlob(record) {
      blobs.set(record.key, record);
    },
    async getPdfBlob(scopeKey, bookId) {
      return blobs.get(buildPdfBlobKey(scopeKey, bookId)) ?? null;
    },
    async deletePdfBlob(scopeKey, bookId) {
      blobs.delete(buildPdfBlobKey(scopeKey, bookId));
    },
    async listPdfBlobs(scopeKey) {
      return Array.from(blobs.values())
        .filter((b) => b.scopeKey === scopeKey)
        .map((b) => ({
          bookId: b.bookId,
          bookTitle: b.bookTitle,
          fileName: b.fileName,
          mimeType: b.mimeType,
          sizeBytes: b.sizeBytes,
          cachedAt: b.cachedAt,
        }));
    },
    async clearScopePdfBlobs(scopeKey) {
      for (const [k, v] of blobs.entries()) {
        if (v.scopeKey === scopeKey) blobs.delete(k);
      }
    },
  };
}

test('createOfflineLibraryStore persists and isolates guest vs authenticated workspace snapshots', async () => {
  const store = createOfflineLibraryStore(createInMemoryVaultAdapter());
  const guestData = createInitialSeedData();
  const userData = createInitialSeedData();
  userData.books = [
    {
      ...userData.books[0],
      id: 999,
      title: 'অফলাইন ইউজার বই — সংবিধান নোট',
    },
  ];

  const savedGuest = await store.saveWorkspaceSnapshot('guest', guestData);
  const savedUser = await store.saveWorkspaceSnapshot('user:uid-1', userData);

  assert.ok(savedGuest);
  assert.ok(savedUser);
  assert.equal(savedUser.booksCount, 1);

  const loadedGuest = await store.loadWorkspaceSnapshot('guest');
  const loadedUser = await store.loadWorkspaceSnapshot('user:uid-1');

  assert.equal(loadedGuest?.data.books.length, guestData.books.length);
  assert.equal(loadedUser?.data.books[0]?.title, 'অফলাইন ইউজার বই — সংবিধান নোট');
  assert.equal(await store.loadWorkspaceSnapshot('user:uid-other'), null);
});

test('createOfflineLibraryStore saves, retrieves, lists, and deletes original PDF blobs per book & scope', async () => {
  const store = createOfflineLibraryStore(createInMemoryVaultAdapter());
  const pdfBytes = new Blob(['%PDF-1.7 sample offline study pdf'], {
    type: 'application/pdf',
  });

  const meta = await store.savePdfForBook({
    scopeKey: 'user:uid-1',
    bookId: 101,
    bookTitle: 'বাংলাদেশের সংবিধান',
    file: pdfBytes,
    fileName: 'constitution.pdf',
  });

  assert.equal(meta.bookId, 101);
  assert.equal(meta.fileName, 'constitution.pdf');
  assert.equal(meta.sizeBytes, pdfBytes.size);

  const fetched = await store.getPdfForBook('user:uid-1', 101);
  assert.ok(fetched);
  assert.equal(await fetched.blob.text(), '%PDF-1.7 sample offline study pdf');

  // Guest scope cannot see user:uid-1 PDFs
  assert.equal(await store.getPdfForBook('guest', 101), null);
  assert.equal((await store.listCachedPdfs('user:uid-1')).length, 1);

  await store.removePdfForBook('user:uid-1', 101);
  assert.equal(await store.getPdfForBook('user:uid-1', 101), null);
  assert.equal((await store.listCachedPdfs('user:uid-1')).length, 0);
});

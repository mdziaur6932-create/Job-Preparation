import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_DRIVE_FOLDER_ID,
  DEFAULT_DRIVE_FOLDER_URL,
  DRIVE_MULTIPART_LIMIT_BYTES,
  EXISTING_LIBRARY_DRIVE_FOLDER_ID,
  EXISTING_LIBRARY_DRIVE_FOLDER_URL,
  GOOGLE_DOC_MIME,
  GOOGLE_DRIVE_SCOPES,
  OTHER_USERS_DRIVE_FOLDER_ID,
  OTHER_USERS_DRIVE_FOLDER_URL,
  OWNER_ADMIN_EMAIL,
  buildBookDrivePayload,
  deleteBookFromGoogleDrive,
  downloadGoogleDriveFile,
  extractGoogleDriveFolderId,
  isValidDriveId,
  isValidDriveWebViewLink,
  listGoogleDriveFolderFiles,
  resolveUploadDriveTarget,
  sanitizeDriveFileName,
  uploadBookToGoogleDrive,
} from './google-drive';

test('1. Extracts configured Google Drive folder ID from user folder URL and rejects invalid URLs', () => {
  assert.equal(
    extractGoogleDriveFolderId(DEFAULT_DRIVE_FOLDER_URL),
    DEFAULT_DRIVE_FOLDER_ID
  );
  assert.equal(
    extractGoogleDriveFolderId(
      'https://drive.google.com/drive/folders/1w3Vo3C-KCJi803OsrCVofVpGj5T1r7tv?usp=sharing'
    ),
    '1w3Vo3C-KCJi803OsrCVofVpGj5T1r7tv'
  );
  assert.equal(
    extractGoogleDriveFolderId('https://evil.example.com/drive/folders/1w3Vo3C-KCJi803OsrCVofVpGj5T1r7tv'),
    null
  );
  assert.equal(extractGoogleDriveFolderId('../bad/id'), null);
  assert.equal(isValidDriveId('1w3Vo3C-KCJi803OsrCVofVpGj5T1r7tv'), true);
  assert.equal(isValidDriveId('short'), false);
  assert.equal(isValidDriveWebViewLink('https://drive.google.com/file/d/abc123456789/view'), true);
  assert.equal(isValidDriveWebViewLink('javascript:alert(1)'), false);
});

test('2. Builds Drive payload preserving uploaded original File and sanitizing Bengali/Unicode names', async () => {
  assert.equal(
    sanitizeDriveFileName('মুক্তিযুদ্ধের ইতিহাস: অধ্যায় ১/২', 'pdf'),
    'মুক্তিযুদ্ধের ইতিহাস অধ্যায় ১ ২.pdf'
  );

  const sampleDocx = new File(
    [new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])],
    'bcs-guide.docx',
    {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }
  );
  const filePayload = buildBookDrivePayload({
    title: 'বিসিএস বাংলা গাইড',
    author: 'প্রস্তুতি',
    subject: 'বাংলা',
    category: 'BCS',
    totalPages: 12,
    sourceFile: sampleDocx,
  });
  assert.equal(filePayload.fileName, 'বিসিএস বাংলা গাইড.docx');
  assert.equal(
    filePayload.mimeType,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  );
  assert.equal(filePayload.blob.size, sampleDocx.size);

  const manualPayload = buildBookDrivePayload({
    title: 'সংবিধান নোট',
    author: 'ব্যক্তিগত',
    subject: 'বাংলাদেশ বিষয়াবলি',
    category: 'BCS',
    totalPages: 2,
    chunks: [
      {
        chapter: 'প্রথম ভাগ',
        pageNumber: 1,
        content: 'বাংলাদেশ একটি একক, স্বাধীন ও সার্বভৌম প্রজাতন্ত্র।',
      },
    ],
  });
  assert.equal(manualPayload.fileName, 'সংবিধান নোট.txt');
  assert.equal(manualPayload.mimeType, 'text/plain');
  const txt = await manualPayload.blob.text();
  assert.match(txt, /বইয়ের নাম: সংবিধান নোট/);
  assert.match(txt, /বাংলাদেশ একটি একক/);
});

test('3. Multipart upload (<= 5 MB) targets configured Drive folder with Bearer token and returns fileId', async () => {
  let capturedUrl = '';
  let capturedAuth = '';
  let capturedBodyText = '';

  const mockFetch: typeof fetch = async (input, init) => {
    capturedUrl = String(input);
    const headers = init?.headers as Record<string, string>;
    capturedAuth = headers.Authorization;
    capturedBodyText = await (init?.body as Blob).text();
    return new Response(
      JSON.stringify({
        id: '1AbCdEfGhIjKlMnOpQrStUvWxYz',
        name: 'টেস্ট বই.txt',
        webViewLink: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/view',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  const payload = buildBookDrivePayload({
    title: 'টেস্ট বই',
    author: 'লেখক',
    subject: 'ইতিহাস',
    category: 'BCS',
    totalPages: 1,
    rawText: 'বাংলাদেশের মুক্তিযুদ্ধ ১৯৭১ সালে সংঘটিত হয়েছিল এবং বিজয় অর্জিত হয়।',
  });

  const res = await uploadBookToGoogleDrive({
    accessToken: 'ya29.test-access-token',
    title: 'টেস্ট বই',
    subject: 'ইতিহাস',
    bookId: 42,
    payload,
    fetchImpl: mockFetch,
  });

  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.fileId, '1AbCdEfGhIjKlMnOpQrStUvWxYz');
    assert.equal(
      res.webViewLink,
      'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/view'
    );
  }
  assert.match(capturedUrl, /uploadType=multipart/);
  assert.match(capturedUrl, /supportsAllDrives=true/);
  assert.equal(capturedAuth, 'Bearer ya29.test-access-token');
  assert.match(capturedBodyText, new RegExp(DEFAULT_DRIVE_FOLDER_ID));
  assert.match(capturedBodyText, /"app":"prostuti-ai"/);
});

test('4. Resumable upload (> 5 MB) initiates session with folder parent and PUTs binary bytes', async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const bigBytes = new Uint8Array(DRIVE_MULTIPART_LIMIT_BYTES + 1024);
  bigBytes[0] = 0x25; // %PDF

  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method });

    if (calls.length === 1) {
      assert.match(url, /uploadType=resumable/);
      const meta = JSON.parse(String(init?.body)) as { parents: string[] };
      assert.deepEqual(meta.parents, [DEFAULT_DRIVE_FOLDER_ID]);
      return new Response(null, {
        status: 200,
        headers: {
          Location:
            'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=session123',
        },
      });
    }

    assert.equal(method, 'PUT');
    assert.match(url, /upload_id=session123/);
    return new Response(
      JSON.stringify({
        id: '1LargePdfDriveFileId987654',
        name: 'বড় বই.pdf',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  const res = await uploadBookToGoogleDrive({
    accessToken: 'ya29.large-upload-token',
    title: 'বড় বই',
    subject: 'গণিত',
    payload: {
      blob: new Blob([bigBytes], { type: 'application/pdf' }),
      fileName: 'বড় বই.pdf',
      mimeType: 'application/pdf',
    },
    fetchImpl: mockFetch,
  });

  assert.equal(calls.length, 2);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.fileId, '1LargePdfDriveFileId987654');
    assert.equal(
      res.webViewLink,
      'https://drive.google.com/file/d/1LargePdfDriveFileId987654/view'
    );
  }
});

test('5. Deletes linked book from Google Drive cleanly and handles 204, 404, 401, and invalid IDs', async () => {
  let lastDeleteUrl = '';
  let lastAuthHeader = '';

  const okDelete = await deleteBookFromGoogleDrive({
    accessToken: 'ya29.delete-token',
    fileId: '1AbCdEfGhIjKlMnOpQrStUvWxYz',
    fetchImpl: async (input, init) => {
      lastDeleteUrl = String(input);
      lastAuthHeader = (init?.headers as Record<string, string>).Authorization;
      assert.equal(init?.method, 'DELETE');
      return new Response(null, { status: 204 });
    },
  });
  assert.equal(okDelete.ok, true);
  if (okDelete.ok) {
    assert.equal(okDelete.deleted, true);
    assert.equal(okDelete.alreadyDeleted, false);
  }
  assert.match(lastDeleteUrl, /\/files\/1AbCdEfGhIjKlMnOpQrStUvWxYz\?supportsAllDrives=true$/);
  assert.equal(lastAuthHeader, 'Bearer ya29.delete-token');

  const alreadyGone = await deleteBookFromGoogleDrive({
    accessToken: 'ya29.delete-token',
    fileId: '1AbCdEfGhIjKlMnOpQrStUvWxYz',
    fetchImpl: async () => new Response(null, { status: 404 }),
  });
  assert.equal(alreadyGone.ok, true);
  if (alreadyGone.ok) {
    assert.equal(alreadyGone.alreadyDeleted, true);
  }

  const expired = await deleteBookFromGoogleDrive({
    accessToken: 'ya29.expired',
    fileId: '1AbCdEfGhIjKlMnOpQrStUvWxYz',
    fetchImpl: async () => new Response(null, { status: 401 }),
  });
  assert.equal(expired.ok, false);
  if (!expired.ok) {
    assert.equal(expired.code, 'unauthorized');
  }

  const invalidId = await deleteBookFromGoogleDrive({
    accessToken: 'ya29.delete-token',
    fileId: '../../etc/passwd',
  });
  assert.equal(invalidId.ok, false);
  if (!invalidId.ok) {
    assert.equal(invalidId.code, 'invalid_input');
  }
});

test('6. Security invariants: Drive OAuth scope configured, token stays strictly in memory, and delete uses custom confirmation modal', () => {
  assert.deepEqual(GOOGLE_DRIVE_SCOPES, ['https://www.googleapis.com/auth/drive']);

  const firebaseSrc = fs.readFileSync(
    path.join(process.cwd(), 'src/lib/firebase.ts'),
    'utf8'
  );
  assert.match(firebaseSrc, /googleAuthProvider\.addScope/);

  const providerSrc = fs.readFileSync(
    path.join(process.cwd(), 'src/components/WorkspaceProvider.tsx'),
    'utf8'
  );
  assert.match(providerSrc, /GoogleAuthProvider\.credentialFromResult/);
  assert.match(providerSrc, /driveAccessTokenRef\.current\s*=\s*null/);
  // Must NEVER store driveAccessToken in localStorage or sessionStorage
  assert.doesNotMatch(
    providerSrc,
    /(localStorage|sessionStorage)\.setItem\([^)]*drive/i
  );

  const librarySrc = fs.readFileSync(
    path.join(process.cwd(), 'src/components/modules/BookLibraryView.tsx'),
    'utf8'
  );
  assert.match(librarySrc, /data-testid="book-delete-confirm-modal"/);
  assert.doesNotMatch(librarySrc, /\bwindow\.(confirm|alert|open)\b/);
});

test('7. Routes Drive save target to owner folder for owner email and shared folder for all other users', () => {
  assert.equal(
    extractGoogleDriveFolderId(OTHER_USERS_DRIVE_FOLDER_URL),
    OTHER_USERS_DRIVE_FOLDER_ID
  );
  assert.equal(
    extractGoogleDriveFolderId(EXISTING_LIBRARY_DRIVE_FOLDER_URL),
    EXISTING_LIBRARY_DRIVE_FOLDER_ID
  );

  const ownerTarget = resolveUploadDriveTarget(OWNER_ADMIN_EMAIL.toUpperCase());
  assert.equal(ownerTarget.isOwnerFolder, true);
  assert.equal(ownerTarget.folderId, DEFAULT_DRIVE_FOLDER_ID);
  assert.equal(ownerTarget.folderUrl, DEFAULT_DRIVE_FOLDER_URL);

  const otherUserTarget = resolveUploadDriveTarget('student.candidate@gmail.com');
  assert.equal(otherUserTarget.isOwnerFolder, false);
  assert.equal(otherUserTarget.folderId, OTHER_USERS_DRIVE_FOLDER_ID);
  assert.equal(otherUserTarget.folderUrl, OTHER_USERS_DRIVE_FOLDER_URL);

  const guestTarget = resolveUploadDriveTarget(null);
  assert.equal(guestTarget.isOwnerFolder, false);
  assert.equal(guestTarget.folderId, OTHER_USERS_DRIVE_FOLDER_ID);
});

test('8. Lists supported book files from existing Drive library folder and skips unsupported files', async () => {
  let requestedUrl = '';
  const result = await listGoogleDriveFolderFiles({
    accessToken: 'ya29.list-token',
    folderId: EXISTING_LIBRARY_DRIVE_FOLDER_ID,
    fetchImpl: async (input, init) => {
      requestedUrl = String(input);
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        'Bearer ya29.list-token'
      );
      return new Response(
        JSON.stringify({
          files: [
            {
              id: '1PdfBookId1234567890',
              name: 'রিসেন্ট জব সলুশন ২০২৬.pdf',
              mimeType: 'application/pdf',
              size: '2048576',
              webViewLink: 'https://drive.google.com/file/d/1PdfBookId1234567890/view',
            },
            {
              id: '1GoogleDocId12345678',
              name: 'বিসিএস নোটস',
              mimeType: GOOGLE_DOC_MIME,
            },
            {
              id: '1SubFolderId12345678',
              name: 'Subfolder',
              mimeType: 'application/vnd.google-apps.folder',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    },
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.folderId, EXISTING_LIBRARY_DRIVE_FOLDER_ID);
    assert.equal(result.files.length, 2);
    assert.equal(result.files[0].kindLabel, 'PDF');
    assert.equal(result.files[0].size, 2048576);
    assert.equal(result.files[1].kindLabel, 'Google Doc');
  }
  assert.match(requestedUrl, new RegExp(EXISTING_LIBRARY_DRIVE_FOLDER_ID));
  assert.match(requestedUrl, /supportsAllDrives=true/);
  assert.match(requestedUrl, /includeItemsFromAllDrives=true/);
});

test('9. Downloads binary Drive PDF via alt=media and exports Google Doc as .docx', async () => {
  let pdfUrl = '';
  const pdfRes = await downloadGoogleDriveFile({
    accessToken: 'ya29.download-token',
    file: {
      id: '1PdfBookId1234567890',
      name: 'জব সলুশন.pdf',
      mimeType: 'application/pdf',
      size: 16,
    },
    fetchImpl: async (input) => {
      pdfUrl = String(input);
      return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]), {
        status: 200,
        headers: { 'Content-Type': 'application/pdf' },
      });
    },
  });
  assert.equal(pdfRes.ok, true);
  if (pdfRes.ok) {
    assert.equal(pdfRes.file.name, 'জব সলুশন.pdf');
    assert.equal(pdfRes.file.type, 'application/pdf');
    assert.equal(pdfRes.file.size, 8);
  }
  assert.match(pdfUrl, /alt=media/);

  let exportUrl = '';
  const docRes = await downloadGoogleDriveFile({
    accessToken: 'ya29.download-token',
    file: {
      id: '1GoogleDocId12345678',
      name: 'সংবিধান নোট',
      mimeType: GOOGLE_DOC_MIME,
      size: 0,
    },
    fetchImpl: async (input) => {
      exportUrl = String(input);
      return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]), {
        status: 200,
      });
    },
  });
  assert.equal(docRes.ok, true);
  if (docRes.ok) {
    assert.equal(docRes.file.name, 'সংবিধান নোট.docx');
    assert.equal(
      docRes.file.type,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
  }
  assert.match(exportUrl, /\/export\?mimeType=/);
});

import type { Book } from '@/src/types/system';
import { normalizeExamDocumentFormatting } from './exam-text-formatter';
import { MAX_UPLOAD_BYTES } from './file-validation';

export const OWNER_ADMIN_EMAIL = 'mdziaur.6932@gmail.com';

// Owner's personal Google Drive save folder
export const DEFAULT_DRIVE_FOLDER_ID = '1w3Vo3C-KCJi803OsrCVofVpGj5T1r7tv';
export const DEFAULT_DRIVE_FOLDER_URL =
  'https://drive.google.com/drive/folders/1w3Vo3C-KCJi803OsrCVofVpGj5T1r7tv?usp=sharing';

// Other users' shared Google Drive save folder
export const OTHER_USERS_DRIVE_FOLDER_ID = '1IVUONYZtllEKW8p3DJjIYJt7MoZIz8JL';
export const OTHER_USERS_DRIVE_FOLDER_URL =
  'https://drive.google.com/drive/folders/1IVUONYZtllEKW8p3DJjIYJt7MoZIz8JL?usp=sharing';

// Pre-existing Google Drive library folder for importing books already uploaded to Drive
export const EXISTING_LIBRARY_DRIVE_FOLDER_ID =
  '1kEgk9Z4PM9vdHPMr1ON-RMMJFcAOqy_e';
export const EXISTING_LIBRARY_DRIVE_FOLDER_URL =
  'https://drive.google.com/drive/folders/1kEgk9Z4PM9vdHPMr1ON-RMMJFcAOqy_e?usp=drive_link';

// Dedicated Google Drive folder for newspaper cutting photos (Current GK & Book Library)
export const PAPER_CUTTING_DRIVE_FOLDER_ID =
  '1WZlt8I7B0pISMEkaYOxv_36gvs-kdsNW';
export const PAPER_CUTTING_DRIVE_FOLDER_URL =
  'https://drive.google.com/drive/folders/1WZlt8I7B0pISMEkaYOxv_36gvs-kdsNW?usp=sharing';

export interface UploadDriveTarget {
  folderId: string;
  folderUrl: string;
  isOwnerFolder: boolean;
  label: string;
}

export function resolveUploadDriveTarget(
  userEmail: string | null | undefined
): UploadDriveTarget {
  const normalized = (userEmail ?? '').trim().toLowerCase();
  if (normalized === OWNER_ADMIN_EMAIL.toLowerCase()) {
    return {
      folderId: DEFAULT_DRIVE_FOLDER_ID,
      folderUrl: DEFAULT_DRIVE_FOLDER_URL,
      isOwnerFolder: true,
      label: 'মালিকের ব্যক্তিগত Drive ফোল্ডার',
    };
  }
  return {
    folderId: OTHER_USERS_DRIVE_FOLDER_ID,
    folderUrl: OTHER_USERS_DRIVE_FOLDER_URL,
    isOwnerFolder: false,
    label: 'ব্যবহারকারীদের শেয়ার্ড Drive ফোল্ডার',
  };
}

export const GOOGLE_DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive',
] as const;

// Google Drive recommends multipart upload up to 5 MB and resumable upload above 5 MB
export const DRIVE_MULTIPART_LIMIT_BYTES = 5 * 1024 * 1024;

const DRIVE_UPLOAD_BASE_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const DRIVE_FILES_BASE_URL = 'https://www.googleapis.com/drive/v3/files';

const DRIVE_ID_REGEX = /^[a-zA-Z0-9_-]{10,200}$/;

export function isValidDriveId(value: string | null | undefined): boolean {
  if (!value || typeof value !== 'string') return false;
  return DRIVE_ID_REGEX.test(value.trim());
}

export function isValidDriveWebViewLink(
  value: string | null | undefined
): boolean {
  if (!value || typeof value !== 'string') return false;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'https:') return false;
    return (
      parsed.hostname === 'drive.google.com' ||
      parsed.hostname === 'docs.google.com'
    );
  } catch {
    return false;
  }
}

export function extractGoogleDriveFolderId(
  input: string | null | undefined
): string | null {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (isValidDriveId(trimmed)) {
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname !== 'drive.google.com'
    ) {
      return null;
    }
    const folderMatch = parsed.pathname.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    if (folderMatch && isValidDriveId(folderMatch[1])) {
      return folderMatch[1];
    }
    const queryId = parsed.searchParams.get('id');
    if (queryId && isValidDriveId(queryId)) {
      return queryId;
    }
    return null;
  } catch {
    return null;
  }
}

export function sanitizeDriveFileName(
  title: string,
  extension: string
): string {
  const cleanExt = extension
    .replace(/^\.+/, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase() || 'txt';

  const base = title
    .replace(/[\\/:*?"<>|\u0000-\u001F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);

  const safeBase = base || 'prostuti-book';
  const suffix = `.${cleanExt}`;
  if (safeBase.toLowerCase().endsWith(suffix)) {
    return safeBase;
  }
  return `${safeBase}${suffix}`;
}

export interface BookDriveUploadPayload {
  blob: Blob;
  fileName: string;
  mimeType: string;
}

export function buildBookDrivePayload(params: {
  title: string;
  author: string;
  subject: string;
  category: string;
  totalPages: number;
  rawText?: string;
  chunks?: Array<{ chapter: string; pageNumber: number; content: string }>;
  sourceFile?: File | null;
}): BookDriveUploadPayload {
  if (params.sourceFile && params.sourceFile.size > 0) {
    const extMatch = params.sourceFile.name.match(/\.([a-zA-Z0-9]{1,8})$/);
    const ext = extMatch?.[1]?.toLowerCase() ?? 'bin';
    const fileName = sanitizeDriveFileName(
      params.title || params.sourceFile.name.replace(/\.[^.]+$/, ''),
      ext
    );
    const mimeType =
      params.sourceFile.type ||
      (ext === 'pdf'
        ? 'application/pdf'
        : ext === 'docx'
          ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          : ext === 'md'
            ? 'text/markdown'
            : ext === 'txt'
              ? 'text/plain'
              : 'application/octet-stream');

    return {
      blob: params.sourceFile,
      fileName,
      mimeType,
    };
  }

  const lines: string[] = [
    `বইয়ের নাম: ${params.title}`,
    `বিষয়: ${params.subject}`,
    `লেখক: ${params.author || 'অজানা লেখক'}`,
    `ক্যাটাগরি: ${params.category}`,
    `মোট পৃষ্ঠা: ${params.totalPages}`,
    '----------------------------------------',
    '',
  ];

  if (params.chunks && params.chunks.length > 0) {
    const groupedByPage = new Map<
      number,
      { chapter: string; parts: string[] }
    >();
    for (const chunk of params.chunks) {
      const existing = groupedByPage.get(chunk.pageNumber);
      if (existing) {
        existing.parts.push(chunk.content.trim());
      } else {
        groupedByPage.set(chunk.pageNumber, {
          chapter: chunk.chapter,
          parts: [chunk.content.trim()],
        });
      }
    }
    for (const [pageNumber, entry] of groupedByPage.entries()) {
      lines.push(`[${entry.chapter} — পৃষ্ঠা ${pageNumber}]`);
      lines.push(
        normalizeExamDocumentFormatting(entry.parts.filter(Boolean).join('\n\n'))
      );
      lines.push('');
    }
  } else if (params.rawText?.trim()) {
    lines.push(normalizeExamDocumentFormatting(params.rawText.trim()));
  }

  const textBody = lines.join('\n').trim() + '\n';
  const fileName = sanitizeDriveFileName(params.title, 'txt');
  return {
    blob: new Blob([textBody], { type: 'text/plain; charset=utf-8' }),
    fileName,
    mimeType: 'text/plain',
  };
}

export function buildDrivePayloadFromSavedBook(
  book: Book
): BookDriveUploadPayload {
  return buildBookDrivePayload({
    title: book.title,
    author: book.author,
    subject: book.subject,
    category: book.category,
    totalPages: book.totalPages,
    chunks: book.chunks.map((c) => ({
      chapter: c.chapter,
      pageNumber: c.pageNumber,
      content: c.content,
    })),
  });
}

export type DriveErrorCode =
  | 'invalid_input'
  | 'unauthorized'
  | 'forbidden'
  | 'folder_not_found'
  | 'file_too_large'
  | 'network_error'
  | 'api_error';

export type DriveUploadResult =
  | {
      ok: true;
      fileId: string;
      fileName: string;
      webViewLink: string;
    }
  | {
      ok: false;
      code: DriveErrorCode;
      error: string;
    };

export type DriveDeleteResult =
  | {
      ok: true;
      deleted: true;
      alreadyDeleted: boolean;
    }
  | {
      ok: false;
      code: DriveErrorCode;
      error: string;
    };

function mapDriveHttpError(
  status: number,
  operation: 'upload' | 'delete' | 'list' | 'download'
): { code: DriveErrorCode; error: string } {
  if (status === 401) {
    return {
      code: 'unauthorized',
      error:
        'Google Drive সেশনের মেয়াদ শেষ হয়ে গেছে। অনুগ্রহ করে পুনরায় Google Drive সংযুক্ত করুন।',
    };
  }
  if (status === 403) {
    return {
      code: 'forbidden',
      error:
        operation === 'upload'
          ? 'নির্বাচিত Google Drive ফোল্ডারে ফাইল সংরক্ষণের অনুমতি (Editor permission) পাওয়া যায়নি। ফোল্ডার শেয়ারিং পারমিশন যাচাই করুন।'
          : operation === 'delete'
            ? 'এই Google Drive ফাইলটি মুছে ফেলার অনুমতি (Delete permission) পাওয়া যায়নি।'
            : 'এই Google Drive ফোল্ডার বা ফাইলটি পড়ার অনুমতি (Viewer/Editor permission) পাওয়া যায়নি। ফোল্ডার শেয়ারিং সেটিংস যাচাই করুন।',
    };
  }
  if (status === 404) {
    return {
      code: 'folder_not_found',
      error:
        operation === 'upload' || operation === 'list'
          ? 'নির্বাচিত Google Drive ফোল্ডারটি খুঁজে পাওয়া যায়নি বা আপনার অ্যাকাউন্টে এই ফোল্ডারের অ্যাক্সেস নেই।'
          : 'Google Drive ফাইলটি খুঁজে পাওয়া যায়নি।',
    };
  }
  return {
    code: 'api_error',
    error:
      operation === 'upload'
        ? `Google Drive-এ ফাইল আপলোড ব্যর্থ হয়েছে (স্ট্যাটাস ${status})। কিছুক্ষণ পর আবার চেষ্টা করুন।`
        : operation === 'delete'
          ? `Google Drive থেকে ফাইল ডিলিট ব্যর্থ হয়েছে (স্ট্যাটাস ${status})। কিছুক্ষণ পর আবার চেষ্টা করুন।`
          : operation === 'list'
            ? `Google Drive ফোল্ডারের ফাইল তালিকা লোড করা যায়নি (স্ট্যাটাস ${status})। কিছুক্ষণ পর আবার চেষ্টা করুন।`
            : `Google Drive থেকে ফাইলটি ডাউনলোড করা যায়নি (স্ট্যাটাস ${status})। কিছুক্ষণ পর আবার চেষ্টা করুন।`,
  };
}

function isValidGoogleUploadUrl(locationHeader: string | null): boolean {
  if (!locationHeader) return false;
  try {
    const parsed = new URL(locationHeader);
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === 'www.googleapis.com'
    );
  } catch {
    return false;
  }
}

export async function uploadBookToGoogleDrive(params: {
  accessToken: string;
  folderId?: string;
  title: string;
  subject: string;
  bookId?: number;
  payload: BookDriveUploadPayload;
  fetchImpl?: typeof fetch;
}): Promise<DriveUploadResult> {
  const fetchFn = params.fetchImpl ?? fetch;
  const token = params.accessToken?.trim();
  if (!token) {
    return {
      ok: false,
      code: 'unauthorized',
      error: 'Google Drive সংযুক্ত নয়। প্রথমে Google Drive সংযুক্ত করুন।',
    };
  }

  const folderId = params.folderId?.trim() || DEFAULT_DRIVE_FOLDER_ID;
  if (!isValidDriveId(folderId)) {
    return {
      ok: false,
      code: 'invalid_input',
      error: 'সঠিক Google Drive ফোল্ডার আইডি পাওয়া যায়নি।',
    };
  }

  const fileSize = params.payload.blob.size;
  if (fileSize <= 0) {
    return {
      ok: false,
      code: 'invalid_input',
      error: 'আপলোড করার মতো কোনো বৈধ ফাইল বা পাঠ্য পাওয়া যায়নি।',
    };
  }

  if (fileSize > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      code: 'file_too_large',
      error: 'ফাইলের আকার ১০০ MB সীমার বেশি হওয়ায় Google Drive-এ আপলোড করা যাবে না।',
    };
  }

  const metadata = {
    name: params.payload.fileName,
    mimeType: params.payload.mimeType,
    parents: [folderId],
    description: `প্রস্তুতি AI — ${params.title} (${params.subject})`,
    appProperties: {
      app: 'prostuti-ai',
      bookTitle: params.title.slice(0, 80),
      ...(typeof params.bookId === 'number'
        ? { bookId: String(params.bookId) }
        : {}),
    },
  };

  try {
    let response: Response;

    if (fileSize <= DRIVE_MULTIPART_LIMIT_BYTES) {
      const boundary = `prostuti_drive_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      const multipartBody = new Blob([
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
        JSON.stringify(metadata),
        `\r\n--${boundary}\r\nContent-Type: ${params.payload.mimeType}\r\n\r\n`,
        params.payload.blob,
        `\r\n--${boundary}--`,
      ]);

      response = await fetchFn(
        `${DRIVE_UPLOAD_BASE_URL}?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': `multipart/related; boundary=${boundary}`,
          },
          body: multipartBody,
        }
      );
    } else {
      const initRes = await fetchFn(
        `${DRIVE_UPLOAD_BASE_URL}?uploadType=resumable&supportsAllDrives=true&fields=id,name,webViewLink`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json; charset=UTF-8',
            'X-Upload-Content-Type': params.payload.mimeType,
            'X-Upload-Content-Length': String(fileSize),
          },
          body: JSON.stringify(metadata),
        }
      );

      if (!initRes.ok) {
        const mapped = mapDriveHttpError(initRes.status, 'upload');
        return { ok: false, ...mapped };
      }

      const uploadLocation = initRes.headers.get('location');
      if (!isValidGoogleUploadUrl(uploadLocation)) {
        return {
          ok: false,
          code: 'api_error',
          error: 'Google Drive Resumable Upload সেশন শুরু করা যায়নি।',
        };
      }

      response = await fetchFn(uploadLocation!, {
        method: 'PUT',
        headers: {
          'Content-Type': params.payload.mimeType,
        },
        body: params.payload.blob,
      });
    }

    if (!response.ok) {
      const mapped = mapDriveHttpError(response.status, 'upload');
      return { ok: false, ...mapped };
    }

    const data = (await response.json()) as {
      id?: string;
      name?: string;
      webViewLink?: string;
    };

    if (!data?.id || !isValidDriveId(data.id)) {
      return {
        ok: false,
        code: 'api_error',
        error: 'Google Drive ফাইল তৈরি হয়েছে কিন্তু বৈধ ফাইল আইডি ফেরত পাওয়া যায়নি।',
      };
    }

    const fallbackLink = `https://drive.google.com/file/d/${encodeURIComponent(data.id)}/view`;
    const webViewLink =
      data.webViewLink && isValidDriveWebViewLink(data.webViewLink)
        ? data.webViewLink
        : fallbackLink;

    return {
      ok: true,
      fileId: data.id,
      fileName: data.name || params.payload.fileName,
      webViewLink,
    };
  } catch {
    return {
      ok: false,
      code: 'network_error',
      error:
        'Google Drive-এর সাথে সংযোগ স্থাপন করা যায়নি। ইন্টারনেট সংযোগ যাচাই করে আবার চেষ্টা করুন।',
    };
  }
}

export async function deleteBookFromGoogleDrive(params: {
  accessToken: string;
  fileId: string;
  fetchImpl?: typeof fetch;
}): Promise<DriveDeleteResult> {
  const fetchFn = params.fetchImpl ?? fetch;
  const token = params.accessToken?.trim();
  if (!token) {
    return {
      ok: false,
      code: 'unauthorized',
      error: 'Google Drive সংযুক্ত নয়। ফাইলটি মুছতে আগে Google Drive সংযুক্ত করুন।',
    };
  }

  const cleanFileId = params.fileId?.trim();
  if (!isValidDriveId(cleanFileId)) {
    return {
      ok: false,
      code: 'invalid_input',
      error: 'বৈধ Google Drive ফাইল আইডি পাওয়া যায়নি।',
    };
  }

  try {
    const response = await fetchFn(
      `${DRIVE_FILES_BASE_URL}/${encodeURIComponent(cleanFileId)}?supportsAllDrives=true`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    if (response.status === 204 || response.status === 200) {
      return { ok: true, deleted: true, alreadyDeleted: false };
    }

    if (response.status === 404) {
      return { ok: true, deleted: true, alreadyDeleted: true };
    }

    const mapped = mapDriveHttpError(response.status, 'delete');
    return { ok: false, ...mapped };
  } catch {
    return {
      ok: false,
      code: 'network_error',
      error:
        'Google Drive-এর সাথে সংযোগ ব্যর্থ হয়েছে। ইন্টারনেট সংযোগ যাচাই করে আবার চেষ্টা করুন।',
    };
  }
}

export const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';
const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export interface DriveFolderFileItem {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  webViewLink: string;
  modifiedTime: string | null;
  kindLabel: 'PDF' | 'Word (.docx)' | 'Google Doc' | 'Text' | 'Image';
}

export type DriveListResult =
  | {
      ok: true;
      folderId: string;
      files: DriveFolderFileItem[];
    }
  | {
      ok: false;
      code: DriveErrorCode;
      error: string;
    };

export type DriveDownloadResult =
  | {
      ok: true;
      file: File;
    }
  | {
      ok: false;
      code: DriveErrorCode;
      error: string;
    };

export function classifySupportedDriveBookFile(
  name: string,
  mimeType: string
): DriveFolderFileItem['kindLabel'] | null {
  const lowerName = (name || '').toLowerCase();
  const lowerMime = (mimeType || '').toLowerCase();

  if (lowerMime === GOOGLE_DOC_MIME) return 'Google Doc';
  if (lowerMime === 'application/pdf' || lowerName.endsWith('.pdf')) {
    return 'PDF';
  }
  if (lowerMime === DOCX_MIME || lowerName.endsWith('.docx')) {
    return 'Word (.docx)';
  }
  if (
    lowerMime === 'text/plain' ||
    lowerMime === 'text/markdown' ||
    lowerName.endsWith('.txt') ||
    lowerName.endsWith('.md')
  ) {
    return 'Text';
  }
  if (
    lowerMime === 'image/png' ||
    lowerMime === 'image/jpeg' ||
    lowerMime === 'image/webp' ||
    lowerName.endsWith('.png') ||
    lowerName.endsWith('.jpg') ||
    lowerName.endsWith('.jpeg') ||
    lowerName.endsWith('.webp')
  ) {
    return 'Image';
  }
  return null;
}

export async function listGoogleDriveFolderFiles(params: {
  accessToken: string;
  folderId?: string;
  fetchImpl?: typeof fetch;
}): Promise<DriveListResult> {
  const fetchFn = params.fetchImpl ?? fetch;
  const token = params.accessToken?.trim();
  if (!token) {
    return {
      ok: false,
      code: 'unauthorized',
      error:
        'Google Drive সংযুক্ত নয়। ফোল্ডারের বই দেখতে প্রথমে Google Drive সংযুক্ত করুন।',
    };
  }

  const folderId =
    params.folderId?.trim() || EXISTING_LIBRARY_DRIVE_FOLDER_ID;
  if (!isValidDriveId(folderId)) {
    return {
      ok: false,
      code: 'invalid_input',
      error: 'সঠিক Google Drive ফোল্ডার লিংক বা ফোল্ডার আইডি দিন।',
    };
  }

  try {
    const queryStr = `'${folderId}' in parents and trashed = false`;
    const searchParams = new URLSearchParams({
      q: queryStr,
      pageSize: '100',
      orderBy: 'modifiedTime desc,name',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      fields: 'files(id,name,mimeType,size,webViewLink,modifiedTime)',
    });

    const response = await fetchFn(
      `${DRIVE_FILES_BASE_URL}?${searchParams.toString()}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    if (!response.ok) {
      const mapped = mapDriveHttpError(response.status, 'list');
      return { ok: false, ...mapped };
    }

    const json = (await response.json()) as {
      files?: Array<{
        id?: string;
        name?: string;
        mimeType?: string;
        size?: string | number;
        webViewLink?: string;
        modifiedTime?: string;
      }>;
    };

    const files: DriveFolderFileItem[] = [];
    for (const raw of json.files ?? []) {
      if (!raw?.id || !isValidDriveId(raw.id) || !raw.name) continue;
      const mime = raw.mimeType ?? '';
      const kindLabel = classifySupportedDriveBookFile(raw.name, mime);
      if (!kindLabel) continue;
      const parsedSize =
        typeof raw.size === 'number'
          ? raw.size
          : typeof raw.size === 'string' && /^\d+$/.test(raw.size)
            ? Number(raw.size)
            : 0;
      const fallbackLink = `https://drive.google.com/file/d/${encodeURIComponent(raw.id)}/view`;
      const webViewLink =
        raw.webViewLink && isValidDriveWebViewLink(raw.webViewLink)
          ? raw.webViewLink
          : fallbackLink;
      files.push({
        id: raw.id,
        name: raw.name,
        mimeType: mime,
        size: parsedSize,
        webViewLink,
        modifiedTime: raw.modifiedTime ?? null,
        kindLabel,
      });
    }

    return { ok: true, folderId, files };
  } catch {
    return {
      ok: false,
      code: 'network_error',
      error:
        'Google Drive ফোল্ডারের সাথে সংযোগ করা যায়নি। ইন্টারনেট সংযোগ যাচাই করে আবার চেষ্টা করুন।',
    };
  }
}

export async function downloadGoogleDriveFile(params: {
  accessToken: string;
  file: Pick<DriveFolderFileItem, 'id' | 'name' | 'mimeType' | 'size'>;
  fetchImpl?: typeof fetch;
}): Promise<DriveDownloadResult> {
  const fetchFn = params.fetchImpl ?? fetch;
  const token = params.accessToken?.trim();
  if (!token) {
    return {
      ok: false,
      code: 'unauthorized',
      error:
        'Google Drive সংযুক্ত নয়। বই ইমপোর্ট করতে প্রথমে Google Drive সংযুক্ত করুন।',
    };
  }

  const cleanFileId = params.file.id?.trim();
  if (!isValidDriveId(cleanFileId)) {
    return {
      ok: false,
      code: 'invalid_input',
      error: 'বৈধ Google Drive ফাইল আইডি পাওয়া যায়নি।',
    };
  }

  if (params.file.size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      code: 'file_too_large',
      error:
        'এই Drive ফাইলটির আকার ১০০ MB সীমার বেশি হওয়ায় সরাসরি ইমপোর্ট করা যাবে না।',
    };
  }

  const isGoogleDoc = params.file.mimeType === GOOGLE_DOC_MIME;
  const endpoint = isGoogleDoc
    ? `${DRIVE_FILES_BASE_URL}/${encodeURIComponent(cleanFileId)}/export?mimeType=${encodeURIComponent(DOCX_MIME)}`
    : `${DRIVE_FILES_BASE_URL}/${encodeURIComponent(cleanFileId)}?alt=media&supportsAllDrives=true`;

  try {
    const response = await fetchFn(endpoint, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      const mapped = mapDriveHttpError(response.status, 'download');
      return { ok: false, ...mapped };
    }

    const blob = await response.blob();
    if (blob.size <= 0) {
      return {
        ok: false,
        code: 'invalid_input',
        error: 'ডাউনলোড করা Drive ফাইলটি খালি পাওয়া গেছে।',
      };
    }

    if (blob.size > MAX_UPLOAD_BYTES) {
      return {
        ok: false,
        code: 'file_too_large',
        error:
          'ডাউনলোড করা ফাইলটির আকার ১০০ MB সীমার বেশি হওয়ায় প্রক্রিয়াকরণ করা যাবে না।',
      };
    }

    const finalMime = isGoogleDoc
      ? DOCX_MIME
      : params.file.mimeType || blob.type || 'application/octet-stream';
    const finalName = isGoogleDoc
      ? sanitizeDriveFileName(params.file.name, 'docx')
      : params.file.name;

    const downloadedFile = new File([blob], finalName, { type: finalMime });
    return { ok: true, file: downloadedFile };
  } catch {
    return {
      ok: false,
      code: 'network_error',
      error:
        'Google Drive থেকে ফাইলটি ডাউনলোড করতে সমস্যা হয়েছে। ইন্টারনেট সংযোগ যাচাই করে আবার চেষ্টা করুন।',
    };
  }
}

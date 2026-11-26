export const MAX_UPLOAD_MB = 100;
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
export const CHUNK_UPLOAD_SIZE_BYTES = 4 * 1024 * 1024; // 4 MB chunks (safe under Cloud Run 32 MiB limit)
export const MAX_SINGLE_CHUNK_BYTES = 5 * 1024 * 1024; // 5 MB strict ceiling per chunk request

export const DOCX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document' as const;

export type SupportedBinaryMimeType =
  | 'application/pdf'
  | typeof DOCX_MIME_TYPE
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp';

export type SupportedDocumentMimeType =
  | SupportedBinaryMimeType
  | 'text/plain'
  | 'text/markdown';

export type FileValidationErrorCode =
  | 'EMPTY_FILE'
  | 'FILE_TOO_LARGE'
  | 'INVALID_FILE_TYPE';

export type FileValidationResult =
  | {
      ok: true;
      kind: 'text';
      mimeType: 'text/plain' | 'text/markdown';
    }
  | {
      ok: true;
      kind: 'binary';
      mimeType: SupportedBinaryMimeType;
    }
  | {
      ok: false;
      code: FileValidationErrorCode;
      error: string;
    };

const ALLOWED_BINARY_MIME_TYPES = new Set<string>([
  'application/pdf',
  DOCX_MIME_TYPE,
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
]);

const ALLOWED_TEXT_MIME_TYPES = new Set<string>([
  'text/plain',
  'text/markdown',
  'text/x-markdown',
]);

const BENGALI_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'] as const;

export function toBengaliNumber(value: number | string): string {
  return String(value).replace(/\d/g, (d) => BENGALI_DIGITS[Number(d)] ?? d);
}

/**
 * Formats a byte size cleanly for display (e.g., "0 B", "850 KB", "24.50 MB").
 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(2)} MB`;
}

/**
 * Formats a clear Bengali file-size-limit error displaying both actual and maximum sizes.
 */
export function formatFileTooLargeError(
  actualBytes: number,
  maxBytes: number = MAX_UPLOAD_BYTES
): string {
  const actualLabel = formatFileSize(actualBytes);
  const maxMb = Math.round((maxBytes / (1024 * 1024)) * 100) / 100;
  const maxLabel =
    maxMb >= 1
      ? `${Number.isInteger(maxMb) ? maxMb : maxMb.toFixed(2)} MB`
      : formatFileSize(maxBytes);
  return `নির্বাচিত ফাইলটির আকার ${actualLabel}, যা সর্বোচ্চ অনুমোদিত সীমা (${maxLabel})-এর বেশি। অনুগ্রহ করে সর্বোচ্চ ${maxLabel} আকারের ফাইল আপলোড করুন।`;
}

function hasPrefix(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[i] !== signature[i]) return false;
  }
  return true;
}

/**
 * Returns true if the leading bytes match an OLE2 legacy Microsoft Word `.doc` file.
 */
export function isLegacyOleDocSignature(bytes: Uint8Array): boolean {
  return hasPrefix(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
}

export const LEGACY_DOC_UNSUPPORTED_ERROR =
  'পুরোনো .doc (Word 97-2003) ফরম্যাট সরাসরি সমর্থিত নয়। অনুগ্রহ করে ফাইলটি MS Word বা Google Docs থেকে Save As → .docx (অথবা PDF) করে আপলোড করুন।';

/**
 * Inspects file magic bytes to detect supported binary formats (PDF, DOCX/ZIP, PNG, JPEG, WebP).
 * For PDF, also permits up to 1024 leading bytes before "%PDF-" per PDF spec (ISO 32000).
 */
export function detectBinaryMimeFromMagicBytes(
  bytes: Uint8Array
): SupportedBinaryMimeType | null {
  // PDF: "%PDF-" (25 50 44 46 2D) at offset 0 (or within first 1024 bytes after whitespace/BOM)
  if (hasPrefix(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return 'application/pdf';
  }
  const searchLimit = Math.min(bytes.length - 5, 1024);
  if (searchLimit > 0) {
    let onlyLeadingWhitespaceOrBom = true;
    for (let i = 0; i <= searchLimit; i += 1) {
      if (
        bytes[i] === 0x25 &&
        bytes[i + 1] === 0x50 &&
        bytes[i + 2] === 0x44 &&
        bytes[i + 3] === 0x46 &&
        bytes[i + 4] === 0x2d
      ) {
        if (onlyLeadingWhitespaceOrBom) {
          return 'application/pdf';
        }
        break;
      }
      const b = bytes[i];
      const isBom =
        (i === 0 && b === 0xef) ||
        (i === 1 && b === 0xbb) ||
        (i === 2 && b === 0xbf);
      const isWs = b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x00;
      if (!isBom && !isWs) {
        onlyLeadingWhitespaceOrBom = false;
        break;
      }
    }
  }

  // DOCX (OOXML ZIP container): PK\x03\x04, PK\x05\x06, or PK\x07\x08
  if (
    hasPrefix(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    hasPrefix(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
    hasPrefix(bytes, [0x50, 0x4b, 0x07, 0x08])
  ) {
    return DOCX_MIME_TYPE;
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }

  // JPEG: FF D8 FF
  if (hasPrefix(bytes, [0xff, 0xd8, 0xff])) {
    return 'image/jpeg';
  }

  // WebP: "RIFF" at 0..3 and "WEBP" at 8..11
  if (
    bytes.length >= 12 &&
    hasPrefix(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }

  return null;
}

function getExtension(fileName: string): string {
  const lower = fileName.trim().toLowerCase();
  const lastDot = lower.lastIndexOf('.');
  if (lastDot === -1) return '';
  return lower.slice(lastDot);
}

function normalizeDeclaredMime(mimeType: string): string {
  return mimeType.split(';')[0].trim().toLowerCase();
}

function looksLikePlainText(bytes: Uint8Array): boolean {
  const sampleLen = Math.min(bytes.length, 8192);
  for (let i = 0; i < sampleLen; i += 1) {
    // Reject NUL bytes (typical of binary executables/archives disguised as .txt)
    if (bytes[i] === 0x00) {
      return false;
    }
  }
  return true;
}

function isExtensionCompatibleWithBinaryMime(
  ext: string,
  detectedMime: SupportedBinaryMimeType,
  declaredMime: string
): boolean {
  if (detectedMime === DOCX_MIME_TYPE) {
    // Require explicit .docx extension (or explicit DOCX MIME when extensionless)
    // so arbitrary .zip/.xlsx/.pptx files are never accepted as Word documents.
    return ext === '.docx' || (ext === '' && declaredMime === DOCX_MIME_TYPE);
  }
  if (!ext) return true;
  switch (detectedMime) {
    case 'application/pdf':
      return ext === '.pdf';
    case 'image/png':
      return ext === '.png';
    case 'image/jpeg':
      return ext === '.jpg' || ext === '.jpeg';
    case 'image/webp':
      return ext === '.webp';
  }
}

function isDeclaredMimeCompatibleWithBinaryMime(
  declaredMime: string,
  detectedMime: SupportedBinaryMimeType
): boolean {
  if (!declaredMime || declaredMime === 'application/octet-stream') {
    return true;
  }
  if (
    detectedMime === DOCX_MIME_TYPE &&
    (declaredMime === 'application/zip' || declaredMime === 'application/x-zip-compressed')
  ) {
    // Some browsers/OSes report .docx with generic ZIP MIME; extension check still enforces .docx
    return true;
  }
  if (!ALLOWED_BINARY_MIME_TYPES.has(declaredMime)) {
    return false;
  }
  if (declaredMime === 'image/jpg') {
    return detectedMime === 'image/jpeg';
  }
  return declaredMime === detectedMime;
}

/**
 * Validates file metadata + leading header bytes (first 8 KB) without requiring
 * the full 100 MB payload to be loaded into memory at once.
 */
export function validateUploadedDocumentHeader(
  fileName: string,
  declaredMimeType: string,
  headerBytes: Uint8Array,
  totalByteLength: number,
  maxBytes: number = MAX_UPLOAD_BYTES
): FileValidationResult {
  if (totalByteLength <= 0 || headerBytes.byteLength === 0) {
    return {
      ok: false,
      code: 'EMPTY_FILE',
      error:
        'নির্বাচিত ফাইলটি খালি। অনুগ্রহ করে একটি বৈধ PDF, Word (.docx), ছবি বা টেক্সট ফাইল আপলোড করুন।',
    };
  }

  if (totalByteLength > maxBytes) {
    return {
      ok: false,
      code: 'FILE_TOO_LARGE',
      error: formatFileTooLargeError(totalByteLength, maxBytes),
    };
  }

  const ext = getExtension(fileName);
  const declaredMime = normalizeDeclaredMime(declaredMimeType);

  // Give clear conversion guidance when a user uploads a legacy binary .doc file
  if (
    ext === '.doc' ||
    declaredMime === 'application/msword' ||
    isLegacyOleDocSignature(headerBytes)
  ) {
    return {
      ok: false,
      code: 'INVALID_FILE_TYPE',
      error: LEGACY_DOC_UNSUPPORTED_ERROR,
    };
  }

  // First check whether the file claims to be plain text / markdown
  const isTextExtension = ext === '.txt' || ext === '.md';
  const isTextMime = ALLOWED_TEXT_MIME_TYPES.has(declaredMime);
  const hasGenericOrEmptyMime =
    !declaredMime || declaredMime === 'application/octet-stream';

  if (
    (isTextMime && (ext === '' || isTextExtension)) ||
    (isTextExtension && (hasGenericOrEmptyMime || isTextMime))
  ) {
    // Reject binary payloads renamed to .txt/.md
    if (
      detectBinaryMimeFromMagicBytes(headerBytes) !== null ||
      !looksLikePlainText(headerBytes)
    ) {
      return {
        ok: false,
        code: 'INVALID_FILE_TYPE',
        error:
          'ফাইলটির ভেতরের ফরম্যাট বৈধ টেক্সট নয়। অনুগ্রহ করে সঠিক PDF, Word (.docx), ছবি (PNG/JPEG/WebP) বা টেক্সট ফাইল আপলোড করুন।',
      };
    }

    return {
      ok: true,
      kind: 'text',
      mimeType:
        ext === '.md' || declaredMime.includes('markdown')
          ? 'text/markdown'
          : 'text/plain',
    };
  }

  // For PDF, DOCX, and image uploads, verify actual magic bytes against MIME & extension
  const detectedMime = detectBinaryMimeFromMagicBytes(headerBytes);
  if (!detectedMime) {
    return {
      ok: false,
      code: 'INVALID_FILE_TYPE',
      error:
        'অসমর্থিত বা ত্রুটিপূর্ণ ফাইল। শুধুমাত্র বৈধ PDF, Word (.docx), PNG, JPEG, WebP অথবা TXT/MD ফাইল আপলোড করা যাবে।',
    };
  }

  if (
    !isDeclaredMimeCompatibleWithBinaryMime(declaredMime, detectedMime) ||
    !isExtensionCompatibleWithBinaryMime(ext, detectedMime, declaredMime)
  ) {
    return {
      ok: false,
      code: 'INVALID_FILE_TYPE',
      error:
        'ফাইলের ধরন ও ভেতরের ফরম্যাট মিলছে না। অনুগ্রহ করে সঠিক PDF, Word (.docx) বা ছবি ফাইল নির্বাচন করুন।',
    };
  }

  return {
    ok: true,
    kind: 'binary',
    mimeType: detectedMime,
  };
}

/**
 * Validates uploaded study documents by size, MIME allowlist, extension, and binary magic bytes.
 */
export function validateUploadedDocument(
  fileName: string,
  declaredMimeType: string,
  bytes: Uint8Array,
  maxBytes: number = MAX_UPLOAD_BYTES
): FileValidationResult {
  return validateUploadedDocumentHeader(
    fileName,
    declaredMimeType,
    bytes.subarray(0, Math.min(bytes.byteLength, 8192)),
    bytes.byteLength,
    maxBytes
  );
}

/**
 * Validates declared file metadata (name, declared MIME, size) before uploading
 * chunks so clearly invalid or > 100 MB files are rejected before transfer begins.
 */
export function validateDeclaredUploadMetadata(params: {
  fileName: string;
  declaredMimeType: string;
  fileSize: number;
  maxBytes?: number;
}): {
  ok: true;
  expectedKind: 'pdf' | 'docx' | 'image' | 'text';
} | {
  ok: false;
  code: FileValidationErrorCode;
  error: string;
} {
  const maxBytes = params.maxBytes ?? MAX_UPLOAD_BYTES;
  if (!Number.isFinite(params.fileSize) || params.fileSize <= 0) {
    return {
      ok: false,
      code: 'EMPTY_FILE',
      error:
        'নির্বাচিত ফাইলটি খালি। অনুগ্রহ করে একটি বৈধ PDF, Word (.docx), ছবি বা টেক্সট ফাইল আপলোড করুন।',
    };
  }
  if (params.fileSize > maxBytes) {
    return {
      ok: false,
      code: 'FILE_TOO_LARGE',
      error: formatFileTooLargeError(params.fileSize, maxBytes),
    };
  }

  const ext = getExtension(params.fileName);
  const declaredMime = normalizeDeclaredMime(params.declaredMimeType);

  if (ext === '.doc' || declaredMime === 'application/msword') {
    return {
      ok: false,
      code: 'INVALID_FILE_TYPE',
      error: LEGACY_DOC_UNSUPPORTED_ERROR,
    };
  }

  if (ext === '.pdf' || declaredMime === 'application/pdf') {
    if (ext && ext !== '.pdf') {
      return {
        ok: false,
        code: 'INVALID_FILE_TYPE',
        error: 'ফাইলের এক্সটেনশন ও ধরন মিলছে না। অনুগ্রহ করে বৈধ PDF ফাইল নির্বাচন করুন।',
      };
    }
    return { ok: true, expectedKind: 'pdf' };
  }

  if (ext === '.docx' || declaredMime === DOCX_MIME_TYPE) {
    if (ext && ext !== '.docx') {
      return {
        ok: false,
        code: 'INVALID_FILE_TYPE',
        error: 'ফাইলের এক্সটেনশন ও ধরন মিলছে না। অনুগ্রহ করে বৈধ Word (.docx) ফাইল নির্বাচন করুন।',
      };
    }
    return { ok: true, expectedKind: 'docx' };
  }

  if (
    ext === '.png' ||
    ext === '.jpg' ||
    ext === '.jpeg' ||
    ext === '.webp' ||
    (declaredMime.startsWith('image/') && ALLOWED_BINARY_MIME_TYPES.has(declaredMime))
  ) {
    return { ok: true, expectedKind: 'image' };
  }

  if (ext === '.txt' || ext === '.md' || ALLOWED_TEXT_MIME_TYPES.has(declaredMime)) {
    return { ok: true, expectedKind: 'text' };
  }

  return {
    ok: false,
    code: 'INVALID_FILE_TYPE',
    error:
      'অসমর্থিত ফাইল ফরম্যাট। শুধুমাত্র PDF, Word (.docx), PNG, JPEG, WebP, TXT বা MD ফাইল আপলোড করা যাবে।',
  };
}

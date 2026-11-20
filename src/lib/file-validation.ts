export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export type SupportedBinaryMimeType =
  | 'application/pdf'
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

function hasPrefix(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[i] !== signature[i]) return false;
  }
  return true;
}

/**
 * Inspects file magic bytes to detect supported binary formats (PDF, PNG, JPEG, WebP).
 */
export function detectBinaryMimeFromMagicBytes(
  bytes: Uint8Array
): SupportedBinaryMimeType | null {
  // PDF: "%PDF-" (25 50 44 46 2D)
  if (hasPrefix(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return 'application/pdf';
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
  detectedMime: SupportedBinaryMimeType
): boolean {
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
  if (!ALLOWED_BINARY_MIME_TYPES.has(declaredMime)) {
    return false;
  }
  if (declaredMime === 'image/jpg') {
    return detectedMime === 'image/jpeg';
  }
  return declaredMime === detectedMime;
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
  if (bytes.byteLength === 0) {
    return {
      ok: false,
      code: 'EMPTY_FILE',
      error: 'নির্বাচিত ফাইলটি খালি। অনুগ্রহ করে একটি বৈধ PDF, ছবি বা টেক্সট ফাইল আপলোড করুন।',
    };
  }

  if (bytes.byteLength > maxBytes) {
    return {
      ok: false,
      code: 'FILE_TOO_LARGE',
      error: 'ফাইলের আকার সর্বোচ্চ ১৫ মেগাবাইটের মধ্যে হতে হবে।',
    };
  }

  const ext = getExtension(fileName);
  const declaredMime = normalizeDeclaredMime(declaredMimeType);

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
      detectBinaryMimeFromMagicBytes(bytes) !== null ||
      !looksLikePlainText(bytes)
    ) {
      return {
        ok: false,
        code: 'INVALID_FILE_TYPE',
        error:
          'ফাইলটির ভেতরের ফরম্যাট বৈধ টেক্সট নয়। অনুগ্রহ করে সঠিক PDF, ছবি (PNG/JPEG/WebP) বা টেক্সট ফাইল আপলোড করুন।',
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

  // For PDF and image uploads, verify actual magic bytes against MIME & extension
  const detectedMime = detectBinaryMimeFromMagicBytes(bytes);
  if (!detectedMime) {
    return {
      ok: false,
      code: 'INVALID_FILE_TYPE',
      error:
        'অসমর্থিত বা ত্রুটিপূর্ণ ফাইল। শুধুমাত্র বৈধ PDF, PNG, JPEG, WebP অথবা TXT/MD ফাইল আপলোড করা যাবে।',
    };
  }

  if (
    !isDeclaredMimeCompatibleWithBinaryMime(declaredMime, detectedMime) ||
    !isExtensionCompatibleWithBinaryMime(ext, detectedMime)
  ) {
    return {
      ok: false,
      code: 'INVALID_FILE_TYPE',
      error:
        'ফাইলের ধরন ও ভেতরের ফরম্যাট মিলছে না। অনুগ্রহ করে সঠিক PDF বা ছবি ফাইল নির্বাচন করুন।',
    };
  }

  return {
    ok: true,
    kind: 'binary',
    mimeType: detectedMime,
  };
}

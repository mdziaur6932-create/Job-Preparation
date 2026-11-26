'use client';

const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);

const MAX_RAW_IMAGE_BYTES = 18 * 1024 * 1024; // 18 MB raw phone photo ceiling before client downscale
const MAX_PAYLOAD_IMAGE_BYTES = 3.2 * 1024 * 1024; // Keep POST JSON payload fast and well under limits
const MAX_CANVAS_DIMENSION = 2048;

export interface PreparedPaperCuttingImage {
  imageBase64: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  previewUrl: string;
  fileName: string;
  byteSize: number;
}

function inferImageMimeType(
  file: File
): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  const declared = (file.type || '').trim().toLowerCase();
  if (declared === 'image/jpg' || declared === 'image/jpeg') return 'image/jpeg';
  if (declared === 'image/png') return 'image/png';
  if (declared === 'image/webp') return 'image/webp';

  const name = file.name.toLowerCase();
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.webp')) return 'image/webp';
  return null;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function loadImageElement(objectUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('ছবিটি পড়া যায়নি।'));
    img.src = objectUrl;
  });
}

async function compressImageViaCanvas(
  objectUrl: string,
  maxDimension: number,
  quality: number
): Promise<{ base64: string; mimeType: 'image/jpeg'; byteSize: number }> {
  const img = await loadImageElement(objectUrl);
  const scale = Math.min(
    1,
    maxDimension / Math.max(img.naturalWidth || 1, img.naturalHeight || 1)
  );
  const targetWidth = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
  const targetHeight = Math.max(1, Math.round((img.naturalHeight || 1) * scale));

  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('ব্রাউজারে ছবি প্রসেসিং ক্যানভাস তৈরি করা যায়নি।');
  }

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, targetWidth, targetHeight);
  ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  const commaIdx = dataUrl.indexOf(',');
  const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
  const byteSize = Math.floor((base64.length * 3) / 4);
  return { base64, mimeType: 'image/jpeg', byteSize };
}

/**
 * Validates and prepares a newspaper cutting image file for /api/ai/paper-cutting.
 * Automatically downscales oversized phone photos while keeping text sharp for OCR/Vision.
 */
export async function prepareImageForPaperCuttingApi(
  file: File
): Promise<PreparedPaperCuttingImage> {
  if (!file || file.size <= 0) {
    throw new Error('ফাইলটি খালি। অনুগ্রহ করে একটি সঠিক ছবি (JPG, PNG বা WebP) দিন।');
  }
  if (file.size > MAX_RAW_IMAGE_BYTES) {
    throw new Error(
      'ছবিটির আকার ১৮ MB-এর বেশি। অনুগ্রহ করে ছোট আকারের ছবি নির্বাচন করুন।'
    );
  }

  const normalizedMime = inferImageMimeType(file);
  if (
    !normalizedMime ||
    (file.type && !ALLOWED_IMAGE_MIME_TYPES.has(file.type.toLowerCase()))
  ) {
    throw new Error(
      `"${file.name}" সমর্থিত ছবি নয়। শুধু JPG, PNG অথবা WebP ছবি আপলোড করা যাবে।`
    );
  }

  const previewUrl = URL.createObjectURL(file);

  // If the file is already compact enough, send original bytes directly for maximum text fidelity
  if (file.size <= MAX_PAYLOAD_IMAGE_BYTES) {
    const buffer = await file.arrayBuffer();
    return {
      imageBase64: arrayBufferToBase64(buffer),
      mimeType: normalizedMime,
      previewUrl,
      fileName: file.name,
      byteSize: file.size,
    };
  }

  // Otherwise gently downscale to <= 2048px JPEG so text stays crisp and API upload is fast
  try {
    let compressed = await compressImageViaCanvas(
      previewUrl,
      MAX_CANVAS_DIMENSION,
      0.86
    );
    if (compressed.byteSize > MAX_PAYLOAD_IMAGE_BYTES) {
      compressed = await compressImageViaCanvas(previewUrl, 1600, 0.78);
    }
    return {
      imageBase64: compressed.base64,
      mimeType: compressed.mimeType,
      previewUrl,
      fileName: file.name,
      byteSize: compressed.byteSize,
    };
  } catch {
    URL.revokeObjectURL(previewUrl);
    throw new Error(
      'বড় ছবিটি কমপ্রেস করতে সমস্যা হয়েছে। অনুগ্রহ করে JPG বা PNG ফরম্যাটে পুনরায় চেষ্টা করুন।'
    );
  }
}

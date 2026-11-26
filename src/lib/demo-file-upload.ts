'use client';

import { prepareImageForPaperCuttingApi } from './image-upload-utils';

export interface PreparedDemoPaperFile {
  fileName: string;
  fileType: 'image' | 'pdf';
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';
  base64: string;
  byteSize: number;
  previewUrl: string | null;
}

const MAX_DEMO_PDF_BYTES = 10 * 1024 * 1024; // 10 MB direct PDF analysis ceiling

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

/**
 * Validates and prepares uploaded Demo Question files (JPG/PNG/WebP photos or PDF)
 * for /api/ai/analyze-demo-paper.
 */
export async function prepareDemoPaperFiles(
  fileList: File[]
): Promise<PreparedDemoPaperFile[]> {
  if (!fileList || fileList.length === 0) {
    throw new Error('অন্তত একটি ডেমো প্রশ্নের ফটো বা PDF ফাইল নির্বাচন করুন।');
  }

  const sliced = fileList.slice(0, 6);
  const prepared: PreparedDemoPaperFile[] = [];

  for (const file of sliced) {
    const lowerName = file.name.toLowerCase();
    const isPdf =
      file.type.toLowerCase() === 'application/pdf' || lowerName.endsWith('.pdf');

    if (isPdf) {
      if (file.size <= 0) {
        throw new Error(`"${file.name}" ফাইলটি খালি।`);
      }
      if (file.size > MAX_DEMO_PDF_BYTES) {
        throw new Error(
          `"${file.name}" PDF ফাইলটি ১০ MB-এর বেশি। অনুগ্রহ করে ছোট আকারের নমুনা প্রশ্নের PDF দিন বা পৃষ্ঠার ফটো আপলোড করুন।`
        );
      }
      const buffer = await file.arrayBuffer();
      const head = new Uint8Array(buffer.slice(0, 5));
      const signature = String.fromCharCode(...head);
      if (signature !== '%PDF-') {
        throw new Error(`"${file.name}" সঠিক PDF ফাইল নয়।`);
      }
      prepared.push({
        fileName: file.name,
        fileType: 'pdf',
        mimeType: 'application/pdf',
        base64: arrayBufferToBase64(buffer),
        byteSize: file.size,
        previewUrl: null,
      });
    } else {
      const img = await prepareImageForPaperCuttingApi(file);
      prepared.push({
        fileName: img.fileName,
        fileType: 'image',
        mimeType: img.mimeType,
        base64: img.imageBase64,
        byteSize: img.byteSize,
        previewUrl: img.previewUrl,
      });
    }
  }

  return prepared;
}

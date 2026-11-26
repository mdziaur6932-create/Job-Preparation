import type { WorkspaceData } from '@/src/types/system';

export type SwCacheStrategy =
  | 'navigation'
  | 'asset'
  | 'pdf'
  | 'font'
  | 'bypass';

export const OFFLINE_SCOPE_GUEST = 'guest';

const BYPASS_HOST_PATTERNS = [
  /firestore\.googleapis\.com/i,
  /identitytoolkit\.googleapis\.com/i,
  /securetoken\.googleapis\.com/i,
  /accounts\.google\.com/i,
  /www\.googleapis\.com/i,
  /oauth2\.googleapis\.com/i,
  /firebaseinstallations\.googleapis\.com/i,
];

/**
 * Resolves an isolated offline cache namespace for Guest Mode vs each signed-in
 * Firebase user UID so offline snapshots and cached PDFs never leak across accounts.
 */
export function resolveOfflineScopeKey(uid: string | null | undefined): string {
  const clean = typeof uid === 'string' ? uid.trim() : '';
  return clean.length > 0 ? `user:${clean}` : OFFLINE_SCOPE_GUEST;
}

/**
 * Pure request classifier mirroring `public/sw.js` so cache routing rules are
 * deterministically verified by unit tests.
 */
export function classifyServiceWorkerRequest(params: {
  url: string;
  origin: string;
  method?: string;
  mode?: string;
}): SwCacheStrategy {
  const method = (params.method ?? 'GET').toUpperCase();
  if (method !== 'GET') return 'bypass';

  let parsed: URL;
  try {
    parsed = new URL(params.url);
  } catch {
    return 'bypass';
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'bypass';
  }

  if (BYPASS_HOST_PATTERNS.some((re) => re.test(parsed.hostname))) {
    return 'bypass';
  }

  if (
    parsed.hostname === 'fonts.googleapis.com' ||
    parsed.hostname === 'fonts.gstatic.com'
  ) {
    return 'font';
  }

  if (parsed.origin !== params.origin) {
    return 'bypass';
  }

  const pathname = parsed.pathname;

  if (
    pathname.startsWith('/api/') ||
    pathname.startsWith('/_next/webpack-hmr') ||
    pathname === '/sw.js'
  ) {
    return 'bypass';
  }

  if (/\.(?:pdf|docx)$/i.test(pathname) || pathname.startsWith('/assets/')) {
    return 'pdf';
  }

  if (params.mode === 'navigate') {
    return 'navigation';
  }

  if (
    pathname.startsWith('/_next/static/') ||
    pathname === '/manifest.webmanifest' ||
    /\.(?:js|css|woff2?|ttf|eot|png|jpg|jpeg|webp|svg|ico)$/i.test(pathname)
  ) {
    return 'asset';
  }

  return 'bypass';
}

export interface OfflineStudySummary {
  booksCount: number;
  chunksCount: number;
  questionsCount: number;
  examsCount: number;
  gkCount: number;
  studyTasksCount: number;
  estimatedTextBytes: number;
}

/**
 * Summarizes the study material inventory that will remain available offline.
 */
export function summarizeOfflineStudyMaterials(
  data: WorkspaceData
): OfflineStudySummary {
  const chunksCount = data.books.reduce((sum, b) => sum + b.chunks.length, 0);
  let estimatedTextBytes = 0;
  try {
    const serialized = JSON.stringify(data);
    estimatedTextBytes = new TextEncoder().encode(serialized).byteLength;
  } catch {
    estimatedTextBytes = 0;
  }

  return {
    booksCount: data.books.length,
    chunksCount,
    questionsCount: data.questions.length,
    examsCount: data.exams.length,
    gkCount: data.gkItems.length,
    studyTasksCount: data.studyTasks.length,
    estimatedTextBytes,
  };
}

/**
 * Formats byte counts cleanly for display in the Offline Library status bar.
 */
export function formatOfflineBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 100 ? 0 : 1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb >= 100 ? 0 : 2)} MB`;
}

/**
 * Extracts unique same-origin JS/CSS/font/manifest URLs currently loaded in the
 * document so the Service Worker can immediately warm its cache on first visit.
 */
export function collectWarmableAssetUrls(
  urls: string[],
  origin: string
): string[] {
  const seen = new Set<string>(['/']);
  for (const raw of urls) {
    if (!raw || typeof raw !== 'string') continue;
    try {
      const resolved = new URL(raw, origin);
      const strategy = classifyServiceWorkerRequest({
        url: resolved.href,
        origin,
        method: 'GET',
      });
      if (strategy === 'asset' || strategy === 'font') {
        seen.add(resolved.href);
      }
    } catch {
      // Ignore malformed URLs
    }
  }
  return Array.from(seen);
}

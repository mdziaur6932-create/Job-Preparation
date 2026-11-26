import type { Metadata, Viewport } from 'next';
import {
  Hind_Siliguri,
  Plus_Jakarta_Sans,
  JetBrains_Mono,
} from 'next/font/google';
import 'katex/dist/katex.min.css';
import './globals.css';
import { PWAOfflineRuntime } from '@/src/components/pwa/PWAOfflineRuntime';

const hindSiliguri = Hind_Siliguri({
  subsets: ['bengali', 'latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-hind-siliguri',
  display: 'swap',
});

const plusJakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-plus-jakarta',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

export const viewport: Viewport = {
  themeColor: '#1d4ed8',
  width: 'device-width',
  initialScale: 1,
};

export const metadata: Metadata = {
  title: 'প্রস্তুতি AI — Personal AI Job Preparation & Examination System',
  description:
    'Personal AI Job Preparation & Examination System featuring PDF Book Library with OCR, RAG Smart Reader, AI Question Lab & Bank, Timed Exam Center with Negative Marking, AI Evaluation, Current GK, Study Planner, Mistake Notebook, and Performance Analytics.',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'প্রস্তুতি AI',
  },
  icons: {
    icon: '/icon.svg',
    apple: '/apple-touch-icon.png',
  },
  openGraph: {
    title: 'প্রস্তুতি AI — Personal AI Job Preparation & Examination System',
    description:
      'Personal AI-powered study and examination platform with RAG + pgvector Knowledge Base, MCQ & Written Exam Center, and AI Evaluation.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'প্রস্তুতি AI — Personal AI Job Preparation & Examination System',
    description:
      'Personal AI-powered study and examination platform with RAG + pgvector Knowledge Base, MCQ & Written Exam Center, and AI Evaluation.',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="bn"
      className={`${hindSiliguri.variable} ${plusJakarta.variable} ${jetbrainsMono.variable}`}
    >
      <body
        suppressHydrationWarning
        className="bg-slate-50 text-slate-900 antialiased selection:bg-blue-100 selection:text-blue-900"
      >
        <PWAOfflineRuntime />
        {children}
      </body>
    </html>
  );
}

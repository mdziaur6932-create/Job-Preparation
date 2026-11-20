'use client';

import React, { useState } from 'react';
import {
  BookOpen,
  FileSearch,
  FlaskConical,
  ClipboardCheck,
  Award,
  Globe,
  CalendarCheck,
  BarChart3,
  Menu,
  X,
  LogIn,
  LogOut,
} from 'lucide-react';
import { useWorkspace } from './WorkspaceProvider';
import type { ModuleId } from '@/src/types/system';

interface NavModule {
  id: ModuleId;
  index: string;
  titleEn: string;
  titleBn: string;
  icon: React.ComponentType<{ className?: string }>;
}

export const MODULES: NavModule[] = [
  {
    id: 'library',
    index: '01',
    titleEn: 'Book Library',
    titleBn: 'বইয়ের লাইব্রেরি',
    icon: BookOpen,
  },
  {
    id: 'reader',
    index: '02',
    titleEn: 'Smart Reader',
    titleBn: 'স্মার্ট রিডার',
    icon: FileSearch,
  },
  {
    id: 'question-lab',
    index: '03',
    titleEn: 'AI Question Lab',
    titleBn: 'প্রশ্ন ল্যাব ও ব্যাংক',
    icon: FlaskConical,
  },
  {
    id: 'exam-center',
    index: '04',
    titleEn: 'Exam Center',
    titleBn: 'পরীক্ষা কেন্দ্র',
    icon: ClipboardCheck,
  },
  {
    id: 'evaluation',
    index: '05',
    titleEn: 'AI Evaluation',
    titleBn: 'মূল্যায়ন ও ফলাফল',
    icon: Award,
  },
  {
    id: 'current-gk',
    index: '06',
    titleEn: 'Current GK',
    titleBn: 'সাম্প্রতিক সাধারণ জ্ঞান',
    icon: Globe,
  },
  {
    id: 'planner',
    index: '07',
    titleEn: 'Study Planner',
    titleBn: 'স্টাডি প্ল্যানার ও ভুল নোটবুক',
    icon: CalendarCheck,
  },
  {
    id: 'performance',
    index: '08',
    titleEn: 'Performance',
    titleBn: 'পারফরম্যান্স ও AI শিক্ষক',
    icon: BarChart3,
  },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const {
    data,
    user,
    syncing,
    syncError,
    activeModule,
    setActiveModule,
    signInWithGoogle,
    signOutUser,
  } = useWorkspace();

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const currentMod =
    MODULES.find((m) => m.id === activeModule) ?? MODULES[0];

  const unmasteredMistakes = data.mistakes.filter((m) => !m.mastered).length;
  const pendingTasks = data.studyTasks.filter((t) => !t.completed).length;

  const getModuleCount = (id: ModuleId): number | null => {
    switch (id) {
      case 'library':
        return data.books.length;
      case 'question-lab':
        return data.questions.length;
      case 'exam-center':
        return data.exams.length;
      case 'evaluation':
        return data.attempts.length;
      case 'current-gk':
        return data.gkItems.filter((g) => !g.isArchived).length;
      case 'planner':
        return pendingTasks + unmasteredMistakes;
      default:
        return null;
    }
  };

  const renderSidebarNav = () => (
    <nav aria-label="প্রধান মডিউল নেভিগেশন" className="flex-1 overflow-y-auto px-3 py-4">
      <div className="mb-2 px-3 text-xs font-medium text-slate-500">
        ৮টি প্রধান মডিউল
      </div>
      <ul className="space-y-1">
        {MODULES.map((mod) => {
          const Icon = mod.icon;
          const active = activeModule === mod.id;
          const count = getModuleCount(mod.id);
          return (
            <li key={mod.id}>
              <button
                type="button"
                onClick={() => {
                  setActiveModule(mod.id);
                  setMobileMenuOpen(false);
                }}
                aria-current={active ? 'page' : undefined}
                className={`group flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
                  active
                    ? 'bg-blue-700 text-white'
                    : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900'
                }`}
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <Icon
                    className={`h-4 w-4 shrink-0 ${
                      active ? 'text-blue-100' : 'text-slate-400 group-hover:text-slate-600'
                    }`}
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold leading-tight">
                      {mod.index}. {mod.titleEn}
                    </span>
                    <span
                      className={`block truncate text-xs leading-tight mt-0.5 ${
                        active ? 'text-blue-100' : 'text-slate-500'
                      }`}
                    >
                      {mod.titleBn}
                    </span>
                  </span>
                </span>
                {count !== null && (
                  <span
                    className={`ml-2 shrink-0 font-mono text-xs tabular-nums ${
                      active ? 'text-blue-100' : 'text-slate-400'
                    }`}
                  >
                    {count}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );

  return (
    <div className="flex min-h-screen bg-slate-50 text-slate-900">
      {/* Desktop Sidebar (272px fixed) */}
      <aside className="hidden lg:flex lg:w-[272px] lg:shrink-0 lg:flex-col border-r border-slate-200 bg-white">
        <div className="flex h-16 items-center border-b border-slate-200 px-6">
          <button
            type="button"
            onClick={() => setActiveModule('library')}
            className="text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded"
          >
            <span className="block font-display text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap">
              প্রস্তুতি AI
            </span>
          </button>
        </div>

        {renderSidebarNav()}

        {/* Account & Workspace Summary Footer */}
        <div className="border-t border-slate-200 p-4">
          <div className="text-xs text-slate-500">
            <span>{data.books.length} বই</span>
            <span aria-hidden="true" className="mx-1.5">·</span>
            <span>{data.questions.length} প্রশ্ন</span>
            <span aria-hidden="true" className="mx-1.5">·</span>
            <span>{data.attempts.length} পরীক্ষা</span>
          </div>
          {user ? (
            <div className="mt-3 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold text-slate-900">
                  {user.displayName || user.email}
                </p>
                <p className="truncate text-xs text-slate-500">
                  {syncing ? 'সিঙ্ক হচ্ছে...' : 'ক্লাউড অ্যাকাউন্ট সংযুক্ত'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void signOutUser()}
                aria-label="সাইন আউট"
                className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900 transition-colors shrink-0"
              >
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <p className="mt-2 text-xs text-slate-500 leading-relaxed">
              ব্যক্তিগত ক্লাউড সংরক্ষণের জন্য উপরে Google দিয়ে সাইন-ইন করুন।
            </p>
          )}
        </div>
      </aside>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div
            className="fixed inset-0 bg-slate-900/40"
            onClick={() => setMobileMenuOpen(false)}
            aria-hidden="true"
          />
          <div className="relative z-10 flex w-[280px] max-w-[85vw] flex-col bg-white shadow-xl">
            <div className="flex h-14 items-center justify-between border-b border-slate-200 px-4">
              <span className="font-display text-base font-bold text-slate-900">
                প্রস্তুতি AI
              </span>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                aria-label="মেনু বন্ধ করুন"
                className="rounded-md p-2 text-slate-500 hover:bg-slate-100"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            {renderSidebarNav()}
          </div>
        </div>
      )}

      {/* Main Content Shell */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Clean Contextual Top Bar (<= 64px height, strictly < 15% mobile viewport) */}
        <header className="sticky top-0 z-30 flex h-14 lg:h-16 items-center justify-between gap-4 border-b border-slate-200 bg-white px-4 lg:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="মডিউল মেনু খুলুন"
              className="rounded-md p-2 text-slate-600 hover:bg-slate-100 lg:hidden shrink-0"
            >
              <Menu className="h-5 w-5" />
            </button>
            <div className="flex min-w-0 items-center gap-2 text-sm">
              <span className="hidden sm:inline text-slate-400 whitespace-nowrap shrink-0">
                প্রস্তুতি AI
              </span>
              <span
                aria-hidden="true"
                className="hidden sm:inline text-slate-300"
              >
                /
              </span>
              <span className="truncate font-semibold text-slate-900">
                {currentMod.index}. {currentMod.titleEn}
              </span>
              <span
                aria-hidden="true"
                className="hidden md:inline text-slate-300"
              >
                ·
              </span>
              <span className="hidden md:inline truncate text-slate-500">
                {currentMod.titleBn}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {user ? (
              <button
                type="button"
                onClick={() => setActiveModule('exam-center')}
                className="rounded-lg bg-blue-700 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-800 transition-colors whitespace-nowrap shrink-0"
              >
                নতুন পরীক্ষা দিন
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void signInWithGoogle()}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-700 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-800 transition-colors whitespace-nowrap shrink-0"
              >
                <LogIn className="h-3.5 w-3.5" />
                <span>Google সাইন-ইন</span>
              </button>
            )}
          </div>
        </header>

        {syncError && (
          <div
            role="alert"
            className="border-b border-red-200 bg-red-50 px-4 py-2.5 text-xs font-medium text-red-800 lg:px-8"
          >
            {syncError}
          </div>
        )}

        <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-6 lg:px-8 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}

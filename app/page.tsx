'use client';

import React from 'react';
import {
  WorkspaceProvider,
  useWorkspace,
} from '@/src/components/WorkspaceProvider';
import { AppShell } from '@/src/components/AppShell';
import { BookLibraryView } from '@/src/components/modules/BookLibraryView';
import { SmartReaderView } from '@/src/components/modules/SmartReaderView';
import { QuestionLabView } from '@/src/components/modules/QuestionLabView';
import { ExamCenterView } from '@/src/components/modules/ExamCenterView';
import { EvaluationView } from '@/src/components/modules/EvaluationView';
import { CurrentGkView } from '@/src/components/modules/CurrentGkView';
import { StudyPlannerView } from '@/src/components/modules/StudyPlannerView';
import { PerformanceView } from '@/src/components/modules/PerformanceView';

function ModuleRouter() {
  const { activeModule } = useWorkspace();

  switch (activeModule) {
    case 'library':
      return <BookLibraryView />;
    case 'reader':
      return <SmartReaderView />;
    case 'question-lab':
      return <QuestionLabView />;
    case 'exam-center':
      return <ExamCenterView />;
    case 'evaluation':
      return <EvaluationView />;
    case 'current-gk':
      return <CurrentGkView />;
    case 'planner':
      return <StudyPlannerView />;
    case 'performance':
      return <PerformanceView />;
    default:
      return <BookLibraryView />;
  }
}

export default function HomePage() {
  return (
    <WorkspaceProvider>
      <AppShell>
        <ModuleRouter />
      </AppShell>
    </WorkspaceProvider>
  );
}

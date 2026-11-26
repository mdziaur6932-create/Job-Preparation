'use client';

import React from 'react';
import {
  WorkspaceProvider,
  useWorkspace,
} from '@/src/components/WorkspaceProvider';
import { AppShell } from '@/src/components/AppShell';
import { FirestoreErrorBoundary } from '@/src/components/FirestoreErrorBoundary';
import { BookLibraryView } from '@/src/components/modules/BookLibraryView';
import { SmartReaderView } from '@/src/components/modules/SmartReaderView';
import { QuestionLabView } from '@/src/components/modules/QuestionLabView';
import { ExamCenterView } from '@/src/components/modules/ExamCenterView';
import { EvaluationView } from '@/src/components/modules/EvaluationView';
import { CurrentGkView } from '@/src/components/modules/CurrentGkView';
import { StudyPlannerView } from '@/src/components/modules/StudyPlannerView';
import { PerformanceView } from '@/src/components/modules/PerformanceView';
import { OcrStudioView } from '@/src/components/modules/OcrStudioView';

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
    case 'ocr-studio':
      return <OcrStudioView />;
    default:
      return <BookLibraryView />;
  }
}

export default function HomePage() {
  return (
    <FirestoreErrorBoundary>
      <WorkspaceProvider>
        <AppShell>
          <ModuleRouter />
        </AppShell>
      </WorkspaceProvider>
    </FirestoreErrorBoundary>
  );
}

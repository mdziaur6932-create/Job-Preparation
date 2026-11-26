'use client';

import React from 'react';
import { Plus, RotateCcw, Trash2, FileSpreadsheet } from 'lucide-react';
import {
  cloneDefaultWrittenBlueprint,
  summarizeWrittenBlueprint,
  type WrittenSectionBlueprint,
} from '@/src/lib/job-exam-paper';
import {
  SYLLABUS_SUBJECT_GROUPS,
  type SyllabusSubjectGroup,
} from '@/src/lib/syllabus-topic-tagger';
import { toBengaliNumber } from '@/src/lib/file-validation';

interface WrittenBlueprintEditorProps {
  sections: WrittenSectionBlueprint[];
  onChange: (next: WrittenSectionBlueprint[]) => void;
  testIdPrefix?: string;
}

export function WrittenBlueprintEditor({
  sections,
  onChange,
  testIdPrefix = 'written-blueprint',
}: WrittenBlueprintEditorProps) {
  const summary = summarizeWrittenBlueprint(sections);

  const updateSection = (
    id: string,
    patch: Partial<WrittenSectionBlueprint>
  ) => {
    onChange(
      sections.map((sec) => (sec.id === id ? { ...sec, ...patch } : sec))
    );
  };

  const removeSection = (id: string) => {
    if (sections.length <= 1) return;
    onChange(sections.filter((sec) => sec.id !== id));
  };

  const addSection = () => {
    if (sections.length >= 10) return;
    const next: WrittenSectionBlueprint = {
      id: `sec-custom-${Date.now()}`,
      subjectGroup: 'সাধারণ জ্ঞান ও বিজ্ঞান',
      title: 'অতিরিক্ত লিখিত অংশ',
      questionCount: 2,
      subQuestionsPerItem: 0,
      marksPerQuestion: 5,
      isChoiceOne: false,
      itemStyle: 'office_descriptive',
    };
    onChange([...sections, next]);
  };

  return (
    <div
      data-testid={`${testIdPrefix}-editor`}
      className="rounded-xl border border-amber-200/80 bg-amber-50/40 p-3.5 space-y-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="flex items-center gap-1.5 text-xs font-bold text-slate-900">
            <FileSpreadsheet className="h-3.5 w-3.5 text-amber-700" />
            <span>লিখিত পরীক্ষার সেকশন ও উপ-প্রশ্ন কাঠামো (Blueprint)</span>
          </div>
          <p className="mt-0.5 text-[11px] text-slate-600">
            প্রতিটি বিষয়ে কয়টি প্রশ্ন, উপ-প্রশ্ন (ক–ঙ), প্রতি প্রশ্নের নম্বর এবং “যেকোনো ১টি” (অথবা) বিকল্প কাস্টমাইজ করুন।
          </p>
        </div>

        <div className="flex items-center gap-2 text-[11px] font-mono tabular-nums">
          <span
            data-testid={`${testIdPrefix}-summary`}
            className="rounded-md border border-amber-300 bg-white px-2 py-1 font-semibold text-amber-900"
          >
            মোট {toBengaliNumber(summary.totalQuestions)} প্রশ্ন · পূর্ণমান{' '}
            {toBengaliNumber(summary.totalMarks)}
          </span>
          <button
            type="button"
            onClick={() => onChange(cloneDefaultWrittenBlueprint())}
            title="১০০ নম্বরের আদর্শ লিখিত ছক বসাও"
            className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1 font-sans text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
          >
            <RotateCcw className="h-3 w-3" />
            <span>১০০ নম্বর ছক</span>
          </button>
        </div>
      </div>

      <div className="space-y-2 max-h-64 overflow-y-auto pr-0.5">
        {sections.map((sec, idx) => (
          <div
            key={sec.id}
            data-testid={`${testIdPrefix}-row-${idx}`}
            className="rounded-lg border border-slate-200 bg-white p-2.5 space-y-2"
          >
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label={`সেকশন ${idx + 1} বিষয়`}
                value={sec.subjectGroup}
                onChange={(e) =>
                  updateSection(sec.id, {
                    subjectGroup: e.target.value as SyllabusSubjectGroup,
                  })
                }
                className="rounded-md border border-slate-300 bg-slate-50 px-2 py-1 text-[11px] font-semibold text-slate-800 focus:border-blue-600 focus:outline-none"
              >
                {SYLLABUS_SUBJECT_GROUPS.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>

              <input
                type="text"
                aria-label={`সেকশন ${idx + 1} শিরোনাম`}
                value={sec.title}
                onChange={(e) =>
                  updateSection(sec.id, { title: e.target.value })
                }
                className="min-w-[140px] flex-1 rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-900 focus:border-blue-600 focus:outline-none"
              />

              {sections.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeSection(sec.id)}
                  aria-label={`সেকশন ${sec.title} বাদ দিন`}
                  className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-slate-700">
              <label className="inline-flex items-center gap-1">
                <span>প্রশ্ন:</span>
                <input
                  type="number"
                  min={1}
                  max={15}
                  value={sec.questionCount}
                  onChange={(e) =>
                    updateSection(sec.id, {
                      questionCount: Math.min(
                        15,
                        Math.max(1, Number(e.target.value) || 1)
                      ),
                    })
                  }
                  className="w-12 rounded border border-slate-300 px-1.5 py-0.5 font-mono text-xs tabular-nums text-slate-900"
                />
              </label>

              <label className="inline-flex items-center gap-1">
                <span>উপ-প্রশ্ন (ক–ঙ):</span>
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={sec.subQuestionsPerItem}
                  onChange={(e) =>
                    updateSection(sec.id, {
                      subQuestionsPerItem: Math.min(
                        10,
                        Math.max(0, Number(e.target.value) || 0)
                      ),
                    })
                  }
                  className="w-12 rounded border border-slate-300 px-1.5 py-0.5 font-mono text-xs tabular-nums text-slate-900"
                />
              </label>

              <label className="inline-flex items-center gap-1">
                <span>নম্বর/প্রশ্ন:</span>
                <input
                  type="number"
                  min={1}
                  max={30}
                  step="0.5"
                  value={sec.marksPerQuestion}
                  onChange={(e) =>
                    updateSection(sec.id, {
                      marksPerQuestion: Math.min(
                        30,
                        Math.max(1, Number(e.target.value) || 1)
                      ),
                    })
                  }
                  className="w-14 rounded border border-slate-300 px-1.5 py-0.5 font-mono text-xs tabular-nums text-slate-900"
                />
              </label>

              <label className="inline-flex items-center gap-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={sec.isChoiceOne}
                  onChange={(e) =>
                    updateSection(sec.id, {
                      isChoiceOne: e.target.checked,
                      subQuestionsPerItem:
                        e.target.checked && sec.subQuestionsPerItem < 2
                          ? 2
                          : sec.subQuestionsPerItem,
                      itemStyle: e.target.checked
                        ? 'choice_essay'
                        : sec.itemStyle,
                    })
                  }
                  className="h-3.5 w-3.5 rounded border-slate-300 text-amber-700"
                />
                <span>অথবা (যেকোনো ১টি)</span>
              </label>

              <span className="ml-auto font-mono font-semibold text-slate-600 tabular-nums">
                = {toBengaliNumber(Number((sec.questionCount * sec.marksPerQuestion).toFixed(1)))} নম্বর
              </span>
            </div>
          </div>
        ))}
      </div>

      {sections.length < 10 && (
        <button
          type="button"
          onClick={addSection}
          className="inline-flex items-center gap-1 rounded-md border border-dashed border-amber-400 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-amber-900 hover:bg-amber-50"
        >
          <Plus className="h-3.5 w-3.5" />
          <span>নতুন লিখিত সেকশন যোগ করুন</span>
        </button>
      )}
    </div>
  );
}

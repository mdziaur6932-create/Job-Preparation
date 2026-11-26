import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clusterExamBlocksByQuestion,
  estimateMcqClusterWordMetricsPt,
  MAX_MCQ_LINE_SPACING,
  MIN_MCQ_LINE_SPACING,
  optimizeMcqAdaptivePagination,
  type McqClusterMetrics,
} from './mcq-adaptive-pagination';
import { parseExamDocumentForDisplay } from './exam-text-formatter';
import { groupDisplayItemsWithOptionBlocks } from './exam-option-layout';
import { attachInlineAnswersToOptionGroups } from './mcq-page-makeup-spec';

test('70-question MCQ exam fits cleanly into 3 balanced pages with zero spillover onto Page 4 and per-column spacing in [1.00, 1.50]', () => {
  // Mirrors the user's 70-question সংস্কৃতি বিষয়ক মন্ত্রণালয় PDF:
  // Page 1 usable height = 910 - 95 header = 815px (11 questions/col)
  // Page 2 & 3 usable height = 910px (12 questions/col)
  const items: McqClusterMetrics[] = Array.from({ length: 70 }, (_, idx) => {
    // Slightly varied heights (like 2-line math questions & Q18 with note)
    const isTall = idx === 17 || idx === 41 || idx === 48 || idx === 65;
    const heightAt100 = isTall ? 84 : 69;
    const heightAt150 = isTall ? 120 : 98;
    return { heightAt100, heightAt150 };
  });

  const pages = optimizeMcqAdaptivePagination({
    headerHeight: 95,
    items,
    pageContentHeight: 910,
    layoutMode: 'double',
    itemGap: 2,
  });

  // Must fit ALL 70 questions into exactly 3 pages (NO Page 4 spillover!)
  assert.equal(pages.length, 3);

  const flattened = pages.flatMap((p) => [...p.col1Indices, ...p.col2Indices]);
  assert.equal(flattened.length, 70);
  assert.deepEqual(
    flattened,
    Array.from({ length: 70 }, (_, i) => i)
  );

  // Every single column must keep line spacing strictly within [1.00, 1.50]
  for (const page of pages) {
    assert.ok(
      page.col1LineSpacing >= MIN_MCQ_LINE_SPACING &&
        page.col1LineSpacing <= MAX_MCQ_LINE_SPACING,
      `Page ${page.pageNumber} Col 1 spacing ${page.col1LineSpacing} out of [1.00, 1.50]`
    );
    assert.ok(
      page.col2LineSpacing >= MIN_MCQ_LINE_SPACING &&
        page.col2LineSpacing <= MAX_MCQ_LINE_SPACING,
      `Page ${page.pageNumber} Col 2 spacing ${page.col2LineSpacing} out of [1.00, 1.50]`
    );
    assert.ok(page.col1Indices.length >= 10, `Page ${page.pageNumber} Col 1 too sparse`);
    assert.ok(page.col2Indices.length >= 10, `Page ${page.pageNumber} Col 2 too sparse`);
  }
});

test('MCQ exam with long explanations (ব্যাখ্যা:) and tables eliminates sparse trailing spillover page and stays inside [1.00, 1.50]', () => {
  // 28 questions with mixed explanations & 2 tables: at fixed 1.25 they would spill 3 items onto Page 3,
  // but with adaptive spacing [1.00, 1.50] they fit cleanly on 2 balanced pages!
  const items: McqClusterMetrics[] = Array.from({ length: 28 }, (_, idx) => {
    if (idx === 4 || idx === 19) {
      // Explanation with embedded Markdown table (fixed height part doesn't scale as much)
      return { heightAt100: 175, heightAt150: 205 };
    }
    if (idx % 3 === 0) {
      // Question with multi-line explanation
      return { heightAt100: 128, heightAt150: 184 };
    }
    return { heightAt100: 76, heightAt150: 110 };
  });

  const pages = optimizeMcqAdaptivePagination({
    headerHeight: 90,
    items,
    pageContentHeight: 910,
    layoutMode: 'double',
    itemGap: 2,
  });

  assert.equal(pages.length, 2, 'Should pack all 28 explained questions onto 2 balanced pages');
  const flattened = pages.flatMap((p) => [...p.col1Indices, ...p.col2Indices]);
  assert.equal(flattened.length, 28);

  for (const page of pages) {
    assert.ok(page.col1LineSpacing >= 1.0 && page.col1LineSpacing <= 1.5);
    assert.ok(page.col2LineSpacing >= 1.0 && page.col2LineSpacing <= 1.5);
    assert.ok(page.col1Indices.length > 0 && page.col2Indices.length > 0);
  }
});

test('Short single-page MCQ exam balances Left and Right columns cleanly without over-stretching to 1.50', () => {
  const items: McqClusterMetrics[] = Array.from({ length: 10 }, () => ({
    heightAt100: 68,
    heightAt150: 96,
  }));

  const pages = optimizeMcqAdaptivePagination({
    headerHeight: 95,
    items,
    pageContentHeight: 910,
    layoutMode: 'double',
    itemGap: 2,
  });

  assert.equal(pages.length, 1);
  assert.equal(pages[0].col1Indices.length, 5);
  assert.equal(pages[0].col2Indices.length, 5);
  assert.ok(pages[0].col1LineSpacing >= 1.0 && pages[0].col1LineSpacing <= 1.3);
  assert.ok(pages[0].col2LineSpacing >= 1.0 && pages[0].col2LineSpacing <= 1.3);
});

test('clusterExamBlocksByQuestion + estimateMcqClusterWordMetricsPt keeps subject headings glued to next question', () => {
  const sample = [
    'সংস্কৃতি বিষয়ক মন্ত্রণালয়-২০২৫',
    'পদের নাম: বুকস্টার্টার',
    'সময়: ১ ঘণ্টা   পূর্ণমান: ৭০',
    '',
    'বাংলা',
    '01. কোন বানানটি শুদ্ধ?',
    'ক. দায়িত্ব',
    'খ. দ্বায়িত্ব',
    'গ. দায়ীতু',
    'ঘ. দ্বায়িত্য',
    'উত্তর: ক',
    'English',
    '02. What is the synonym of Benevolent?',
    'a) Kind',
    'b) Cruel',
    'c) Angry',
    'd) Weak',
    'Answer: A',
  ].join('\n');

  const parsed = parseExamDocumentForDisplay(sample);
  const grouped = groupDisplayItemsWithOptionBlocks(parsed.bodyItems, 24);
  const enhanced = attachInlineAnswersToOptionGroups(grouped, 2);
  const clusters = clusterExamBlocksByQuestion(enhanced);

  assert.equal(clusters.length, 2);
  assert.equal(clusters[0].blocks[0].kind, 'text'); // 'বাংলা' glued to Q01
  assert.equal(clusters[1].blocks[0].kind, 'text'); // 'English' glued to Q02

  const metrics = estimateMcqClusterWordMetricsPt(clusters[0], 2);
  assert.ok(metrics.heightAt100 > 30);
  assert.ok(metrics.heightAt150 > metrics.heightAt100);
});

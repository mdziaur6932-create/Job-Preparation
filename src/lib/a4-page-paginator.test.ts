import test from 'node:test';
import assert from 'node:assert/strict';
import { paginateMeasuredBlocksIntoA4Pages } from './a4-page-paginator';

test('single-column A4 paginator breaks onto discrete pages when questions exceed usable page height', () => {
  const pages = paginateMeasuredBlocksIntoA4Pages({
    headerHeightPx: 140,
    itemHeightsPx: [180, 180, 180, 180, 180, 180, 180, 180],
    layoutMode: 'single',
    pageContentHeightPx: 900,
    itemGapPx: 12,
  });

  // Page 1 usable = 900 - 140 = 760 -> fits 3 items (180 + 192 + 192 = 564) or 4 items (756 <= 760!)
  assert.equal(pages.length, 2);
  assert.equal(pages[0].pageNumber, 1);
  assert.equal(pages[0].isFirstPage, true);
  assert.deepEqual(pages[0].col1Indices, [0, 1, 2, 3]);
  assert.deepEqual(pages[0].col2Indices, []);

  assert.equal(pages[1].pageNumber, 2);
  assert.equal(pages[1].isFirstPage, false);
  assert.deepEqual(pages[1].col1Indices, [4, 5, 6, 7]);
});

test('2-column A4 paginator fills left column, then right column, then breaks onto Page 2', () => {
  const pages = paginateMeasuredBlocksIntoA4Pages({
    headerHeightPx: 150,
    itemHeightsPx: [200, 200, 200, 200, 200, 200, 200, 200, 200],
    layoutMode: 'double',
    pageContentHeightPx: 800,
    itemGapPx: 10,
  });

  // Page 1 limit = 800 - 150 = 650 -> fits 3 items per column (200 + 210 + 210 = 620 <= 650)
  // Left col: 0,1,2 | Right col: 3,4,5 | Page 2 Left col: 6,7,8
  assert.equal(pages.length, 2);
  assert.deepEqual(pages[0].col1Indices, [0, 1, 2]);
  assert.deepEqual(pages[0].col2Indices, [3, 4, 5]);
  assert.deepEqual(pages[1].col1Indices, [6, 7, 8]);
  assert.deepEqual(pages[1].col2Indices, []);
});

test('always returns at least 1 page and never drops oversized blocks', () => {
  const empty = paginateMeasuredBlocksIntoA4Pages({
    headerHeightPx: 100,
    itemHeightsPx: [],
    layoutMode: 'single',
    pageContentHeightPx: 900,
  });
  assert.equal(empty.length, 1);

  const oversized = paginateMeasuredBlocksIntoA4Pages({
    headerHeightPx: 100,
    itemHeightsPx: [1400, 300],
    layoutMode: 'single',
    pageContentHeightPx: 900,
  });
  assert.equal(oversized.length, 2);
  assert.deepEqual(oversized[0].col1Indices, [0]);
  assert.deepEqual(oversized[1].col1Indices, [1]);
});

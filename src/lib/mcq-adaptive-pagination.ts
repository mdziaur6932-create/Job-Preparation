import {
  isExamSubjectHeadingLine,
} from './exam-option-layout';
import {
  estimateTextWidthInches,
  type McqEnhancedDisplayBlock,
} from './mcq-page-makeup-spec';

export const MIN_MCQ_LINE_SPACING = 1.0;
export const MAX_MCQ_LINE_SPACING = 1.5;
export const DEFAULT_MCQ_LINE_SPACING = 1.15;

export interface ExamQuestionCluster {
  id: string;
  blocks: McqEnhancedDisplayBlock[];
}

export interface McqClusterMetrics {
  /** Exact rendered height (in px, pt, or twips) at lineSpacing = 1.00 */
  heightAt100: number;
  /** Exact rendered height (in px, pt, or twips) at lineSpacing = 1.50 */
  heightAt150: number;
}

export interface McqAdaptivePaginationInput {
  headerHeight: number;
  items: McqClusterMetrics[];
  pageContentHeight: number;
  layoutMode: 'single' | 'double';
  itemGap?: number;
  minLineSpacing?: number;
  maxLineSpacing?: number;
  preferredLineSpacing?: number;
}

export interface McqAdaptivePage {
  pageNumber: number;
  isFirstPage: boolean;
  col1Indices: number[];
  col2Indices: number[];
  col1LineSpacing: number;
  col2LineSpacing: number;
}

/**
 * Groups parsed MCQ/exam blocks into atomic question clusters so a question stem
 * never detaches from its options/answer/explanation and a subject heading
 * (`বাংলা`, `English`, `সাধারণ জ্ঞান`) always stays glued to its first question.
 */
export function clusterExamBlocksByQuestion(
  blocks: McqEnhancedDisplayBlock[]
): ExamQuestionCluster[] {
  const clusters: ExamQuestionCluster[] = [];
  let current: McqEnhancedDisplayBlock[] = [];
  let pendingHeadingBlocks: McqEnhancedDisplayBlock[] = [];

  for (const block of blocks) {
    if (block.kind === 'spacer') {
      continue;
    }
    if (block.kind === 'center_block') {
      if (current.length > 0) {
        clusters.push({ id: `cluster-${clusters.length}`, blocks: current });
        current = [];
      }
      clusters.push({
        id: `cluster-${clusters.length}`,
        blocks: [...pendingHeadingBlocks, block],
      });
      pendingHeadingBlocks = [];
      continue;
    }
    if (block.kind === 'text' && isExamSubjectHeadingLine(block.text)) {
      if (current.length > 0) {
        clusters.push({ id: `cluster-${clusters.length}`, blocks: current });
        current = [];
      }
      pendingHeadingBlocks.push(block);
      continue;
    }
    if (block.kind === 'question') {
      if (current.length > 0) {
        clusters.push({ id: `cluster-${clusters.length}`, blocks: current });
      }
      current = [...pendingHeadingBlocks, block];
      pendingHeadingBlocks = [];
      continue;
    }
    if (pendingHeadingBlocks.length > 0) {
      current = [...pendingHeadingBlocks, block];
      pendingHeadingBlocks = [];
    } else {
      current.push(block);
    }
  }

  if (current.length > 0) {
    clusters.push({ id: `cluster-${clusters.length}`, blocks: current });
  } else if (pendingHeadingBlocks.length > 0) {
    clusters.push({ id: `cluster-${clusters.length}`, blocks: pendingHeadingBlocks });
  }

  return clusters;
}

interface SliceMetrics {
  feasible: boolean;
  count: number;
  minH: number;
  maxH: number;
  slope: number;
  spacing: number;
  filledH: number;
}

function quantizeSpacingSafe(
  rawSpacing: number,
  minLS: number,
  maxLS: number,
  minH: number,
  slope: number,
  hardLimit: number
): number {
  const clamped = Math.max(minLS, Math.min(maxLS, rawSpacing));
  let q = Math.floor(clamped * 100 + 1e-6) / 100;
  if (q < minLS) q = minLS;

  // Check if stepping up by +0.01 stays safely within hardLimit and gets closer to clamped
  const stepUp = Math.round((q + 0.01) * 100) / 100;
  if (
    stepUp <= maxLS &&
    Math.abs(stepUp - clamped) < Math.abs(q - clamped) &&
    minH + slope * (stepUp - minLS) <= hardLimit
  ) {
    q = stepUp;
  }

  // Never overflow hardLimit unless even minLS exceeds it (single mega-item)
  while (q > minLS && minH + slope * (q - minLS) > hardLimit + 0.01) {
    q = Math.round((q - 0.01) * 100) / 100;
  }

  return Math.max(minLS, Math.min(maxLS, Number(q.toFixed(2))));
}

function evaluateSlice(
  start: number,
  end: number,
  prefixH100: number[],
  prefixH150: number[],
  colLimit: number,
  itemGap: number,
  minLS: number,
  maxLS: number,
  preferredLS: number,
  targetFillHeight?: number
): SliceMetrics {
  const count = end - start;
  if (count <= 0) {
    return {
      feasible: true,
      count: 0,
      minH: 0,
      maxH: 0,
      slope: 0,
      spacing: preferredLS,
      filledH: 0,
    };
  }

  const sumH100 = prefixH100[end] - prefixH100[start];
  const sumH150 = prefixH150[end] - prefixH150[start];
  const gapTotal = (count - 1) * itemGap;
  const minH = sumH100 + gapTotal;
  const maxH = Math.max(minH, sumH150 + gapTotal);
  const lsSpan = Math.max(0.01, maxLS - minLS);
  const slope = Math.max(0, (maxH - minH) / lsSpan);

  // Single giant cluster (e.g. massive explanation + table) is always allowed alone in a column at minLS
  if (minH > colLimit + 0.5 && count > 1) {
    return {
      feasible: false,
      count,
      minH,
      maxH,
      slope,
      spacing: minLS,
      filledH: minH,
    };
  }

  const bottomSafety = Math.min(6, colLimit * 0.008);
  const desiredFill =
    targetFillHeight !== undefined
      ? Math.min(colLimit - bottomSafety, targetFillHeight)
      : colLimit - bottomSafety;

  let rawSpacing = preferredLS;
  if (slope > 0.25) {
    rawSpacing = minLS + (desiredFill - minH) / slope;
  }

  const spacing = quantizeSpacingSafe(
    rawSpacing,
    minLS,
    maxLS,
    minH,
    slope,
    colLimit
  );
  const filledH = minH + slope * (spacing - minLS);

  return {
    feasible: true,
    count,
    minH,
    maxH,
    slope,
    spacing,
    filledH,
  };
}

/**
 * Pure, deterministic adaptive MCQ page-makeup & column-balancing optimizer.
 *
 * Implements authentic Bangladeshi job-solution book typesetting:
 * 1. Computes the minimum feasible page count `P_min` where ALL question clusters fit
 *    within `lineSpacing >= 1.00` (eliminating sparse leftover spillover onto an extra page).
 * 2. Partitions questions across the `2 * P_min` columns (or `P_min` columns in 1-col mode)
 *    via exact dynamic programming + per-page Left/Right symmetry polish.
 * 3. Assigns each column its own precise line spacing in `[1.00, 1.50]` (e.g., `1.05`, `1.00`,
 *    `1.04`, `1.05`) so Left and Right columns finish evenly at the same visual bottom edge,
 *    both for dense MCQ-only sheets and exams containing long explanations (`ব্যাখ্যা:`) or tables.
 */
export function optimizeMcqAdaptivePagination(
  input: McqAdaptivePaginationInput
): McqAdaptivePage[] {
  const {
    headerHeight,
    items,
    pageContentHeight,
    layoutMode,
    itemGap = 2,
    minLineSpacing = MIN_MCQ_LINE_SPACING,
    maxLineSpacing = MAX_MCQ_LINE_SPACING,
    preferredLineSpacing = DEFAULT_MCQ_LINE_SPACING,
  } = input;

  const n = items.length;
  const safePageH = Math.max(240, pageContentHeight);
  const safeHeaderH = Math.max(0, headerHeight);
  const firstPageLimit = Math.max(180, safePageH - safeHeaderH);
  const safeMinLS = Math.max(1.0, Number(minLineSpacing.toFixed(2)));
  const safeMaxLS = Math.max(safeMinLS, Math.min(1.5, Number(maxLineSpacing.toFixed(2))));
  const safePrefLS = Math.max(
    safeMinLS,
    Math.min(safeMaxLS, Number(preferredLineSpacing.toFixed(2)))
  );

  if (n === 0) {
    return [
      {
        pageNumber: 1,
        isFirstPage: true,
        col1Indices: [],
        col2Indices: [],
        col1LineSpacing: safePrefLS,
        col2LineSpacing: safePrefLS,
      },
    ];
  }

  // Prefix sums for O(1) slice evaluation
  const prefixH100 = new Array<number>(n + 1).fill(0);
  const prefixH150 = new Array<number>(n + 1).fill(0);
  for (let i = 0; i < n; i += 1) {
    const h100 =
      Number.isFinite(items[i].heightAt100) && items[i].heightAt100 > 0
        ? items[i].heightAt100
        : 48;
    const h150 =
      Number.isFinite(items[i].heightAt150) && items[i].heightAt150 >= h100
        ? items[i].heightAt150
        : h100 * 1.32;
    prefixH100[i + 1] = prefixH100[i] + h100;
    prefixH150[i + 1] = prefixH150[i] + h150;
  }

  const slotCapacityAt = (slotIdx: number): number => {
    if (layoutMode === 'double') {
      return slotIdx < 2 ? firstPageLimit : safePageH;
    }
    return slotIdx === 0 ? firstPageLimit : safePageH;
  };

  // Step 1: Exact minimum feasible column count at minLineSpacing (1.00) via greedy order-preserving packing
  let minColsNeeded = 0;
  let cursor = 0;
  while (cursor < n) {
    const cap = slotCapacityAt(minColsNeeded);
    let end = cursor + 1;
    while (end < n) {
      const nextCount = end + 1 - cursor;
      const nextMinH =
        prefixH100[end + 1] - prefixH100[cursor] + (nextCount - 1) * itemGap;
      if (nextMinH <= cap + 0.5) {
        end += 1;
      } else {
        break;
      }
    }
    cursor = end;
    minColsNeeded += 1;
  }

  const totalPages =
    layoutMode === 'double'
      ? Math.max(1, Math.ceil(minColsNeeded / 2))
      : Math.max(1, minColsNeeded);
  const totalSlots = layoutMode === 'double' ? totalPages * 2 : totalPages;

  // Special case: short single-page 2-column exam that doesn't fill a full page even at comfortable spacing
  if (layoutMode === 'double' && totalPages === 1) {
    const allMinH = prefixH100[n] + Math.max(0, n - 1) * itemGap;
    const allMaxH = prefixH150[n] + Math.max(0, n - 1) * itemGap;
    const pageTotalCap = firstPageLimit * 2;
    const isShortSinglePage = allMaxH < pageTotalCap * 0.88 && allMinH < firstPageLimit * 1.45;

    let bestMid = Math.ceil(n / 2);
    let bestScore = Number.POSITIVE_INFINITY;
    let bestLeftS = safePrefLS;
    let bestRightS = safePrefLS;

    for (let mid = 1; mid <= n; mid += 1) {
      if (isShortSinglePage) {
        // Choose balanced Left/Right split at preferred spacing, then tune Right to match Left's bottom height!
        const leftCheck = evaluateSlice(
          0,
          mid,
          prefixH100,
          prefixH150,
          firstPageLimit,
          itemGap,
          safeMinLS,
          safeMaxLS,
          safePrefLS
        );
        if (!leftCheck.feasible) continue;

        // Keep comfortable spacing on short sheets (avoid stretching 3 questions to 1.50 across a huge page)
        const leftPrefH =
          leftCheck.minH + leftCheck.slope * (safePrefLS - safeMinLS);
        const leftTargetH = Math.min(firstPageLimit - 4, leftPrefH);
        const leftEval = evaluateSlice(
          0,
          mid,
          prefixH100,
          prefixH150,
          firstPageLimit,
          itemGap,
          safeMinLS,
          safeMaxLS,
          safePrefLS,
          leftTargetH
        );
        const rightEval = evaluateSlice(
          mid,
          n,
          prefixH100,
          prefixH150,
          firstPageLimit,
          itemGap,
          safeMinLS,
          safeMaxLS,
          safePrefLS,
          leftEval.filledH
        );
        if (!rightEval.feasible) continue;

        const heightDiff = Math.abs(leftEval.filledH - rightEval.filledH);
        const spacingDiff = Math.abs(leftEval.spacing - rightEval.spacing);
        const rightOverflowLeft = rightEval.filledH > leftEval.filledH + 10 ? 18 : 0;
        const emptyColPenalty = mid === n && n > 1 ? 500 : 0;
        const score =
          (heightDiff / firstPageLimit) * 140 +
          spacingDiff * 35 +
          rightOverflowLeft +
          emptyColPenalty;

        if (score < bestScore) {
          bestScore = score;
          bestMid = mid;
          bestLeftS = leftEval.spacing;
          bestRightS = rightEval.spacing;
        }
      } else {
        // Near-full single page: fill cleanly to page bottom with matched Left & Right baselines!
        const leftEval = evaluateSlice(
          0,
          mid,
          prefixH100,
          prefixH150,
          firstPageLimit,
          itemGap,
          safeMinLS,
          safeMaxLS,
          safePrefLS
        );
        const rightEval = evaluateSlice(
          mid,
          n,
          prefixH100,
          prefixH150,
          firstPageLimit,
          itemGap,
          safeMinLS,
          safeMaxLS,
          safePrefLS
        );
        if (!leftEval.feasible || !rightEval.feasible) continue;

        const leftUnder = Math.max(0, (firstPageLimit - leftEval.filledH) / firstPageLimit);
        const rightUnder = Math.max(0, (firstPageLimit - rightEval.filledH) / firstPageLimit);
        const heightDiff = Math.abs(leftEval.filledH - rightEval.filledH) / firstPageLimit;
        const spacingDiff = Math.abs(leftEval.spacing - rightEval.spacing);
        const score =
          (leftUnder * leftUnder + rightUnder * rightUnder) * 180 +
          heightDiff * 130 +
          spacingDiff * 40;

        if (score < bestScore) {
          bestScore = score;
          bestMid = mid;
          bestLeftS = leftEval.spacing;
          bestRightS = rightEval.spacing;
        }
      }
    }

    const col1Indices: number[] = [];
    for (let i = 0; i < bestMid; i += 1) col1Indices.push(i);
    const col2Indices: number[] = [];
    for (let i = bestMid; i < n; i += 1) col2Indices.push(i);

    return [
      {
        pageNumber: 1,
        isFirstPage: true,
        col1Indices,
        col2Indices,
        col1LineSpacing: bestLeftS,
        col2LineSpacing: col2Indices.length > 0 ? bestRightS : bestLeftS,
      },
    ];
  }

  // Step 2: Estimate harmonious global target line spacing across all slots
  let totalSlotCap = 0;
  for (let s = 0; s < totalSlots; s += 1) {
    totalSlotCap += slotCapacityAt(s);
  }
  const totalMinH = prefixH100[n] + Math.max(0, n - totalSlots) * itemGap;
  const totalSlope = Math.max(
    0.01,
    (prefixH150[n] - prefixH100[n]) / Math.max(0.01, safeMaxLS - safeMinLS)
  );
  const globalTargetS = Math.max(
    safeMinLS,
    Math.min(safeMaxLS, safeMinLS + (totalSlotCap * 0.96 - totalMinH) / totalSlope)
  );

  // Step 3: Exact Dynamic Programming over (slot k, prefix end i)
  const INF = 1e15;
  const dp: number[][] = Array.from({ length: totalSlots + 1 }, () =>
    new Array<number>(n + 1).fill(INF)
  );
  const prevIdx: number[][] = Array.from({ length: totalSlots + 1 }, () =>
    new Array<number>(n + 1).fill(-1)
  );
  const chosenSpacing: number[][] = Array.from({ length: totalSlots + 1 }, () =>
    new Array<number>(n + 1).fill(safePrefLS)
  );

  dp[0][0] = 0;

  for (let slot = 0; slot < totalSlots; slot += 1) {
    const cap = slotCapacityAt(slot);
    const isLastSlot = slot === totalSlots - 1;

    for (let start = 0; start <= n; start += 1) {
      if (dp[slot][start] >= INF * 0.5) continue;

      // Allow empty trailing slot only if items are already exhausted
      if (start === n) {
        const emptyCost = isLastSlot ? 120 : 600;
        if (dp[slot][start] + emptyCost < dp[slot + 1][n]) {
          dp[slot + 1][n] = dp[slot][start] + emptyCost;
          prevIdx[slot + 1][n] = start;
          chosenSpacing[slot + 1][n] = safePrefLS;
        }
        continue;
      }

      for (let end = start + 1; end <= n; end += 1) {
        const ev = evaluateSlice(
          start,
          end,
          prefixH100,
          prefixH150,
          cap,
          itemGap,
          safeMinLS,
          safeMaxLS,
          safePrefLS
        );
        if (!ev.feasible) {
          // Since heights are strictly positive, any larger `end` will also be infeasible!
          break;
        }

        const underfill = Math.max(0, (cap - ev.filledH) / cap);
        const spacingDev = Math.abs(ev.spacing - globalTargetS);
        // Slightly discourage pinning at exact extremes unless needed for exact fit
        const extremePenalty =
          ev.spacing >= safeMaxLS - 0.005 ? 6 : ev.spacing <= safeMinLS + 0.005 ? 1.5 : 0;

        const slotCost =
          underfill * underfill * 220 +
          spacingDev * spacingDev * 55 +
          extremePenalty;

        const candidate = dp[slot][start] + slotCost;
        if (candidate < dp[slot + 1][end]) {
          dp[slot + 1][end] = candidate;
          prevIdx[slot + 1][end] = start;
          chosenSpacing[slot + 1][end] = ev.spacing;
        }
      }
    }
  }

  // Reconstruct slot ranges
  const slotStarts = new Array<number>(totalSlots).fill(0);
  const slotEnds = new Array<number>(totalSlots).fill(0);
  const slotSpacings = new Array<number>(totalSlots).fill(safePrefLS);

  if (dp[totalSlots][n] < INF * 0.5) {
    let currEnd = n;
    for (let slot = totalSlots - 1; slot >= 0; slot -= 1) {
      const s = Math.max(0, prevIdx[slot + 1][currEnd]);
      slotStarts[slot] = s;
      slotEnds[slot] = currEnd;
      slotSpacings[slot] = chosenSpacing[slot + 1][currEnd];
      currEnd = s;
    }
  } else {
    // Ultra-safe deterministic fallback (never fails even on degenerate inputs)
    let fallbackCursor = 0;
    for (let slot = 0; slot < totalSlots; slot += 1) {
      const cap = slotCapacityAt(slot);
      slotStarts[slot] = fallbackCursor;
      let end = fallbackCursor;
      while (end < n) {
        const nextEv = evaluateSlice(
          fallbackCursor,
          end + 1,
          prefixH100,
          prefixH150,
          cap,
          itemGap,
          safeMinLS,
          safeMaxLS,
          safePrefLS
        );
        if (nextEv.feasible) {
          end += 1;
        } else {
          break;
        }
      }
      if (end === fallbackCursor && fallbackCursor < n) {
        end = fallbackCursor + 1;
      }
      slotEnds[slot] = end;
      const finalEv = evaluateSlice(
        fallbackCursor,
        end,
        prefixH100,
        prefixH150,
        cap,
        itemGap,
        safeMinLS,
        safeMaxLS,
        safePrefLS
      );
      slotSpacings[slot] = finalEv.spacing;
      fallbackCursor = end;
    }
    if (fallbackCursor < n) {
      slotEnds[totalSlots - 1] = n;
    }
  }

  // Step 4: Per-page Left/Right symmetry polish (matches Left & Right bottom baselines cleanly!)
  const pages: McqAdaptivePage[] = [];

  if (layoutMode === 'single') {
    for (let p = 0; p < totalPages; p += 1) {
      const indices: number[] = [];
      for (let idx = slotStarts[p]; idx < slotEnds[p]; idx += 1) {
        indices.push(idx);
      }
      pages.push({
        pageNumber: p + 1,
        isFirstPage: p === 0,
        col1Indices: indices,
        col2Indices: [],
        col1LineSpacing: slotSpacings[p],
        col2LineSpacing: slotSpacings[p],
      });
    }
    return pages;
  }

  for (let p = 0; p < totalPages; p += 1) {
    const leftSlot = p * 2;
    const rightSlot = p * 2 + 1;
    const pageStart = slotStarts[leftSlot];
    const pageEnd = slotEnds[rightSlot];
    const cap = slotCapacityAt(leftSlot);
    const pageCount = pageEnd - pageStart;

    let bestMid = slotEnds[leftSlot];
    let bestLeftS = slotSpacings[leftSlot];
    let bestRightS = slotSpacings[rightSlot];
    let bestPairCost = Number.POSITIVE_INFINITY;

    if (pageCount > 1) {
      const pageTotalMaxH =
        prefixH150[pageEnd] - prefixH150[pageStart] + (pageCount - 1) * itemGap;
      const isUnderfilledLastPage =
        p === totalPages - 1 && pageTotalMaxH < cap * 2 * 0.88;

      for (let mid = pageStart + 1; mid <= pageEnd; mid += 1) {
        const leftEval = evaluateSlice(
          pageStart,
          mid,
          prefixH100,
          prefixH150,
          cap,
          itemGap,
          safeMinLS,
          safeMaxLS,
          safePrefLS
        );
        if (!leftEval.feasible) break;

        let effectiveLeft = leftEval;
        let effectiveRight = evaluateSlice(
          mid,
          pageEnd,
          prefixH100,
          prefixH150,
          cap,
          itemGap,
          safeMinLS,
          safeMaxLS,
          safePrefLS
        );
        if (!effectiveRight.feasible) continue;

        if (isUnderfilledLastPage) {
          // On a partially filled last page, match Left and Right column heights evenly
          const targetBalancedH = Math.min(
            cap - 4,
            Math.max(effectiveLeft.minH, (effectiveLeft.filledH + effectiveRight.filledH) / 2)
          );
          effectiveLeft = evaluateSlice(
            pageStart,
            mid,
            prefixH100,
            prefixH150,
            cap,
            itemGap,
            safeMinLS,
            safeMaxLS,
            safePrefLS,
            targetBalancedH
          );
          effectiveRight = evaluateSlice(
            mid,
            pageEnd,
            prefixH100,
            prefixH150,
            cap,
            itemGap,
            safeMinLS,
            safeMaxLS,
            safePrefLS,
            effectiveLeft.filledH
          );
        } else {
          // On full pages, refine the slightly shorter column's spacing (within [1.00, 1.50])
          // so Left and Right columns finish at the exact same bottom baseline!
          const matchedTargetH = Math.min(
            cap - 4,
            Math.max(effectiveLeft.filledH, effectiveRight.filledH)
          );
          effectiveLeft = evaluateSlice(
            pageStart,
            mid,
            prefixH100,
            prefixH150,
            cap,
            itemGap,
            safeMinLS,
            safeMaxLS,
            safePrefLS,
            matchedTargetH
          );
          effectiveRight = evaluateSlice(
            mid,
            pageEnd,
            prefixH100,
            prefixH150,
            cap,
            itemGap,
            safeMinLS,
            safeMaxLS,
            safePrefLS,
            matchedTargetH
          );
        }

        const heightDiff = Math.abs(effectiveLeft.filledH - effectiveRight.filledH) / cap;
        const spacingDiff = Math.abs(effectiveLeft.spacing - effectiveRight.spacing);
        const leftUnder = Math.max(0, (cap - effectiveLeft.filledH) / cap);
        const rightUnder = Math.max(0, (cap - effectiveRight.filledH) / cap);
        const emptyRightPenalty = mid === pageEnd ? 300 : 0;

        const pairCost =
          heightDiff * 150 +
          spacingDiff * 45 +
          (leftUnder * leftUnder + rightUnder * rightUnder) * (isUnderfilledLastPage ? 40 : 160) +
          emptyRightPenalty;

        if (pairCost < bestPairCost) {
          bestPairCost = pairCost;
          bestMid = mid;
          bestLeftS = effectiveLeft.spacing;
          bestRightS = effectiveRight.spacing;
        }
      }
    }

    const col1Indices: number[] = [];
    for (let idx = pageStart; idx < bestMid; idx += 1) col1Indices.push(idx);
    const col2Indices: number[] = [];
    for (let idx = bestMid; idx < pageEnd; idx += 1) col2Indices.push(idx);

    pages.push({
      pageNumber: p + 1,
      isFirstPage: p === 0,
      col1Indices,
      col2Indices,
      col1LineSpacing: bestLeftS,
      col2LineSpacing: col2Indices.length > 0 ? bestRightS : bestLeftS,
    });
  }

  return pages;
}

/**
 * Estimates a question cluster's height in points (pt) for Microsoft Word (.docx)
 * at line spacing 1.00 and 1.50 inside a 3.35" (2-col) or 6.90" (1-col) MCQ column.
 */
export function estimateMcqClusterWordMetricsPt(
  cluster: ExamQuestionCluster,
  layoutColumns: 1 | 2
): McqClusterMetrics {
  const usableColIn = layoutColumns === 2 ? 3.25 : 6.8;
  const stemAvailIn = Math.max(1.5, usableColIn - 0.35);
  const singleLinePtAt100 = 13.0; // ~10.5pt SolaimanLipi / 11pt TNR single-spaced line height
  const singleLinePtAt150 = 19.5; // 1.5x multiple line height

  let textLines = 0;
  let fixedPt = 0;

  for (const block of cluster.blocks) {
    switch (block.kind) {
      case 'spacer':
        break;
      case 'question': {
        const w = estimateTextWidthInches(block.text);
        textLines += Math.max(1, Math.ceil(w / stemAvailIn));
        break;
      }
      case 'option_group': {
        for (const row of block.rows) {
          const maxCellLines = row.reduce((acc, opt) => {
            const cellAvailIn =
              block.columns === 2
                ? layoutColumns === 2
                  ? 1.28
                  : 3.1
                : stemAvailIn - 0.22;
            const lines = Math.max(1, Math.ceil(estimateTextWidthInches(opt.text) / cellAvailIn));
            return Math.max(acc, lines);
          }, 1);
          textLines += maxCellLines;
        }
        break;
      }
      case 'option': {
        const w = estimateTextWidthInches(block.text);
        textLines += Math.max(1, Math.ceil(w / Math.max(1.4, stemAvailIn - 0.22)));
        break;
      }
      case 'solution':
      case 'explanation':
      case 'highlight':
      case 'math':
      case 'reference': {
        const text = 'label' in block ? `${block.label}: ${block.text}` : block.text;
        const w = estimateTextWidthInches(text);
        textLines += Math.max(1, Math.ceil(w / stemAvailIn));
        break;
      }
      case 'ai_badge': {
        textLines += 1;
        break;
      }
      case 'text': {
        if (isExamSubjectHeadingLine(block.text)) {
          textLines += 1;
          fixedPt += 4;
        } else {
          const w = estimateTextWidthInches(block.text);
          textLines += Math.max(1, Math.ceil(w / stemAvailIn));
        }
        break;
      }
      case 'center_block': {
        textLines += Math.max(1, block.lines.length);
        fixedPt += 8;
        break;
      }
      case 'table': {
        fixedPt += 16 + (block.rows.length + 1) * 18;
        break;
      }
      case 'diagram': {
        fixedPt += 42;
        break;
      }
      case 'image': {
        fixedPt += 96;
        break;
      }
    }
  }

  const heightAt100 = Math.max(13, fixedPt + textLines * singleLinePtAt100);
  const heightAt150 = Math.max(heightAt100, fixedPt + textLines * singleLinePtAt150);
  return { heightAt100, heightAt150 };
}

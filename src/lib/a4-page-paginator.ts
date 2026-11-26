export type PaginatedA4LayoutMode = 'single' | 'double';

export interface PaginatedA4Page {
  pageNumber: number;
  isFirstPage: boolean;
  col1Indices: number[];
  col2Indices: number[];
}

export interface PaginateA4Input {
  headerHeightPx: number;
  itemHeightsPx: number[];
  layoutMode: PaginatedA4LayoutMode;
  /** Usable inner vertical body height of one A4 Narrow page (excluding margins & running header/footer). */
  pageContentHeightPx: number;
  /** Vertical spacing gap between consecutive items in a column. */
  itemGapPx?: number;
}

/**
 * Standard 96-DPI usable body height for an A4 portrait sheet (297mm = 1122.5px)
 * with Narrow margins (11.5mm top + 11mm bottom = 85px) and compact editorial header/footer (~58px).
 */
export const DEFAULT_A4_CONTENT_HEIGHT_PX = 976;

/**
 * Pure deterministic Microsoft Word–style A4 page packer.
 * Places measured exam question clusters (or prose/table blocks) into discrete
 * A4 pages without splitting an atomic cluster across a page break.
 *
 * - In `single` mode: fills `col1Indices` top-to-bottom per page.
 * - In `double` mode: fills left column (`col1Indices`), then right column (`col2Indices`),
 *   then inserts a page break onto the next A4 page.
 */
export function paginateMeasuredBlocksIntoA4Pages(
  input: PaginateA4Input
): PaginatedA4Page[] {
  const {
    headerHeightPx,
    itemHeightsPx,
    layoutMode,
    pageContentHeightPx,
    itemGapPx = 12,
  } = input;

  const safePageH = Math.max(240, Math.round(pageContentHeightPx));
  const safeHeaderH = Math.max(0, Math.round(headerHeightPx));
  const firstPageLimit = Math.max(180, safePageH - safeHeaderH);

  if (itemHeightsPx.length === 0) {
    return [
      {
        pageNumber: 1,
        isFirstPage: true,
        col1Indices: [],
        col2Indices: [],
      },
    ];
  }

  const pages: PaginatedA4Page[] = [];
  let currentPage: PaginatedA4Page = {
    pageNumber: 1,
    isFirstPage: true,
    col1Indices: [],
    col2Indices: [],
  };

  let activeCol: 1 | 2 = 1;
  let usedHeight = 0;

  const getCurrentColLimit = () =>
    currentPage.isFirstPage ? firstPageLimit : safePageH;

  const startNextPage = () => {
    pages.push(currentPage);
    currentPage = {
      pageNumber: pages.length + 1,
      isFirstPage: false,
      col1Indices: [],
      col2Indices: [],
    };
    activeCol = 1;
    usedHeight = 0;
  };

  for (let idx = 0; idx < itemHeightsPx.length; idx += 1) {
    const rawH = itemHeightsPx[idx];
    const itemH = Number.isFinite(rawH) && rawH > 0 ? Math.ceil(rawH) : 64;
    const activeList =
      activeCol === 1 ? currentPage.col1Indices : currentPage.col2Indices;
    const gapNeeded = activeList.length > 0 ? itemGapPx : 0;
    const colLimit = getCurrentColLimit();

    if (activeList.length > 0 && usedHeight + gapNeeded + itemH > colLimit) {
      if (layoutMode === 'double' && activeCol === 1) {
        activeCol = 2;
        usedHeight = 0;
      } else {
        startNextPage();
      }
    }

    const targetList =
      activeCol === 1 ? currentPage.col1Indices : currentPage.col2Indices;
    const nextGap = targetList.length > 0 ? itemGapPx : 0;
    targetList.push(idx);
    usedHeight += nextGap + itemH;
  }

  pages.push(currentPage);
  return pages;
}

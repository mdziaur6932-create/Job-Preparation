import test from 'node:test';
import assert from 'node:assert/strict';
import type { Book } from '../types/system';
import {
  buildUnifiedSeriesGroupsWithOverrides,
  buildVirtualMasterBookCatalog,
  detectBookContentFormat,
} from './book-catalog-organization';

function makeBook(
  id: number,
  title: string,
  category: Book['category'],
  content: string,
  totalPages = 60
): Book {
  return {
    id,
    title,
    author: 'সংকলক',
    subject: 'সমন্বিত',
    category,
    totalPages,
    extractionMethod: 'text',
    ocrCompleted: true,
    createdAt: `2026-0${Math.min(9, id)}-01`,
    chunks: [
      {
        id: id * 100,
        bookId: id,
        bookTitle: title,
        chapter: 'পরীক্ষা ১',
        pageNumber: 1,
        chunkIndex: 0,
        content,
      },
    ],
  };
}

test('buildVirtualMasterBookCatalog groups monthly Job Solution MCQ parts into 1 Master Book while keeping Written separate', () => {
  const books: Book[] = [
    makeBook(1, '01. Job Solution - January 2026 (MCQ)', 'রিসেন্ট জব সলুশন', '১. প্রশ্ন?\nক. ক খ. খ গ. গ ঘ. ঘ\nউত্তর: ক', 132),
    makeBook(2, '04. Job Solution - April 2026 (MCQ)', 'রিসেন্ট জব সলুশন', '১. প্রশ্ন?\nক. ক খ. খ গ. গ ঘ. ঘ\nউত্তর: খ', 67),
    makeBook(3, '05. Job Solution - May 2026 (MCQ)', 'রিসেন্ট জব সলুশন', '১. প্রশ্ন?\nক. ক খ. খ গ. গ ঘ. ঘ\nউত্তর: গ', 65),
    makeBook(4, '01. Job Solution - January 2026 (Written)', 'রিসেন্ট জব সলুশন', '১. টীকা লিখুন [5]\n২. অনুবাদ করুন [10]', 80),
    makeBook(5, '02. Job Solution - February 2026 (Written)', 'রিসেন্ট জব সলুশন', '১. রচনা লিখুন [15]', 72),
    makeBook(6, 'বাংলাদেশের সংবিধান গাইড', 'বিষয়ভিত্তিক মূল বই', 'বাংলাদেশের সংবিধান ১৯৭২ সালে প্রণীত হয়।', 240),
  ];

  const catalog = buildVirtualMasterBookCatalog(books);
  assert.equal(catalog.length, 3, 'Should produce 2 Virtual Master Books (MCQ + Written) + 1 standalone book');

  const mcqMaster = catalog.find((c) => c.format === 'MCQ');
  const writtenMaster = catalog.find((c) => c.format === 'Written');
  const textbook = catalog.find((c) => c.format === 'Textbook');

  assert.ok(mcqMaster, 'MCQ Virtual Master Book must exist');
  assert.equal(mcqMaster.isVirtualSeries, true);
  assert.equal(mcqMaster.books.length, 3);
  assert.deepEqual(
    mcqMaster.books.map((b) => b.id),
    [1, 2, 3],
    'Parts should be ordered chronologically 01 -> 04 -> 05'
  );
  assert.equal(mcqMaster.totalPages, 132 + 67 + 65);

  assert.ok(writtenMaster, 'Written Virtual Master Book must be strictly separate from MCQ');
  assert.equal(writtenMaster.isVirtualSeries, true);
  assert.equal(writtenMaster.books.length, 2);
  assert.equal(writtenMaster.totalPages, 152);

  assert.ok(textbook);
  assert.equal(textbook.isVirtualSeries, false);
});

test('custom Virtual Master Book overrides unify arbitrarily named parts in both Catalog and Smart Reader series', () => {
  const b1 = makeBook(10, 'অগ্রদূত বাংলা খণ্ড ক', 'BCS', '১. প্রশ্ন?\nক. ১ খ. ২ গ. ৩ ঘ. ৪', 90);
  const b2 = makeBook(11, 'অগ্রদূত বাংলা সাহিত্য অংশ', 'BCS', '১. প্রশ্ন?\nক. ১ খ. ২ গ. ৩ ঘ. ৪', 110);

  const overrides = {
    customMasterByBookId: {
      '10': 'অগ্রদূত বাংলা কমপ্লিট (ভার্চুয়াল সিরিজ)',
      '11': 'অগ্রদূত বাংলা কমপ্লিট (ভার্চুয়াল সিরিজ)',
    },
    customFormatByBookId: {
      '10': 'MCQ' as const,
      '11': 'MCQ' as const,
    },
  };

  const catalog = buildVirtualMasterBookCatalog([b1, b2], overrides);
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].title, 'অগ্রদূত বাংলা কমপ্লিট (ভার্চুয়াল সিরিজ)');
  assert.equal(catalog[0].books.length, 2);
  assert.equal(catalog[0].totalPages, 200);

  const readerSeries = buildUnifiedSeriesGroupsWithOverrides([b1, b2], overrides);
  assert.equal(readerSeries.length, 1);
  assert.equal(readerSeries[0].isMultiPart, true);
  assert.equal(readerSeries[0].combinedChunks.length, 2);
  assert.equal(readerSeries[0].combinedChunks[1].pageNumber, 91);
});

test('detectBookContentFormat distinguishes MCQ, Written, Combined, and Textbook cleanly', () => {
  const mcq = makeBook(1, 'রিসেন্ট জব সলুশন (MCQ)', 'রিসেন্ট জব সলুশন', 'ক. ১ খ. ২ গ. ৩ ঘ. ৪');
  const written = makeBook(2, 'রিসেন্ট জব সলুশন (Written)', 'রিসেন্ট জব সলুশন', 'টীকা লিখুন [5]');
  const combined = makeBook(3, 'বিসিএস প্রিলি ও লিখিত (MCQ + Written)', 'BCS', 'প্রশ্ন');
  const textbook = makeBook(4, 'সংবিধানের ইতিহাস', 'বিষয়ভিত্তিক মূল বই', 'সংবিধান প্রণয়ন কমিটি গঠিত হয়।');

  assert.equal(detectBookContentFormat(mcq), 'MCQ');
  assert.equal(detectBookContentFormat(written), 'Written');
  assert.equal(detectBookContentFormat(combined), 'Combined');
  assert.equal(detectBookContentFormat(textbook), 'Textbook');
});

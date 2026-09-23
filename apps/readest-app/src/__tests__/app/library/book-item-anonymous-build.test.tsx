import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Book } from '@/types/book';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ appService: { isMobile: true } }),
}));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: () => ({ settings: {} }),
}));
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string) => key,
}));
vi.mock('@/hooks/useResponsiveSize', () => ({ useResponsiveSize: (size: number) => size }));
vi.mock('@/services/environment', () => ({ isAnonymousBuild: () => true }));
vi.mock('@/services/sync/cloudSyncProvider', () => ({
  isReadestCloudStorageActive: () => true,
}));
vi.mock('@/components/BookCover', () => ({ default: () => <div>cover</div> }));
vi.mock('@/app/library/components/ReadingProgress', () => ({ default: () => null }));

const BookItem = (await import('@/app/library/components/BookItem')).default;

const book: Book = {
  hash: 'book-1',
  format: 'EPUB',
  title: 'Local Book',
  author: 'Author',
  createdAt: 0,
  updatedAt: 0,
};

describe('BookItem in anonymous personal builds', () => {
  afterEach(() => cleanup());

  it('does not show the Readest Cloud upload action', () => {
    render(
      <BookItem
        book={book}
        mode='grid'
        coverFit='crop'
        isSelectMode={false}
        bookSelected={false}
        transferProgress={null}
        handleBookUpload={vi.fn()}
        handleBookDownload={vi.fn()}
        showBookDetailsModal={vi.fn()}
        showTimeRemaining={false}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Upload Book' })).toBeNull();
  });
});

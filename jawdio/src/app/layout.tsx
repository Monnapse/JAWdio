'use client';

import './globals.css';

import type { CSSProperties, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LayoutGrid, Menu, Minus, Copy, Square, X } from 'lucide-react';
import { usePathname } from 'next/navigation';

import AudioLibrary from '@/components/AudioLibrary';
import Sidebar from '@/components/Sidebar';
import UpdateShield from '@/components/UpdateShield';
import { AudioProvider } from '@/context/AudioContext';

type ShellVars = CSSProperties & {
  '--library-width'?: string;
};

type WindowChromeStyle = CSSProperties & {
  WebkitAppRegion?: 'drag' | 'no-drag';
};

const pageMetadata: Record<string, { title: string; tag: string }> = {
  '/': { title: 'Overview', tag: 'Performance Deck' },
  '/soundboard': { title: 'Soundboard', tag: 'Full Board' },
  '/studio': { title: 'Clipper', tag: 'Buffer + Transcript' },
  '/live': { title: 'Clipper', tag: 'Unified Workflow' },
  '/settings': { title: 'Routing', tag: 'Mixer Setup' },
};

const dragStyle: WindowChromeStyle = { WebkitAppRegion: 'drag' };
const noDragStyle: WindowChromeStyle = { WebkitAppRegion: 'no-drag' };

export default function RootLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isLibraryOpen, setIsLibraryOpen] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [rightWidth, setRightWidth] = useState(440);
  const isDraggingRight = useRef(false);

  const startResizingRight = useCallback(() => {
    isDraggingRight.current = true;
    document.body.style.cursor = 'col-resize';
  }, []);

  useEffect(() => {
    const syncShellWidth = window.setTimeout(() => {
      const storedLibraryOpen = window.localStorage.getItem('jawdio-library-open');
      const storedWidth = window.localStorage.getItem('jawdio-library-width');
      const parsedWidth = Number.parseInt(storedWidth ?? '', 10);

      if (storedLibraryOpen !== null) {
        setIsLibraryOpen(storedLibraryOpen === 'true');
      } else {
        const shouldOpenByDefault = window.innerWidth >= 1280;
        setIsLibraryOpen(shouldOpenByDefault);
        window.localStorage.setItem(
          'jawdio-library-open',
          JSON.stringify(shouldOpenByDefault),
        );
      }

      if (Number.isFinite(parsedWidth)) {
        setRightWidth(parsedWidth);
      }
    }, 0);

    const handleMouseMove = (event: MouseEvent) => {
      if (!isDraggingRight.current) {
        return;
      }

      const nextWidth = Math.max(340, Math.min(760, window.innerWidth - event.clientX));
      setRightWidth(nextWidth);
      window.localStorage.setItem('jawdio-library-width', String(nextWidth));
    };

    const handleMouseUp = () => {
      if (!isDraggingRight.current) {
        return;
      }

      isDraggingRight.current = false;
      document.body.style.cursor = 'default';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.clearTimeout(syncShellWidth);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  const handleWindowAction = (action: 'close' | 'minimize' | 'maximize') => {
    window.electronAPI?.sendWindowAction(action);

    if (action === 'maximize') {
      setIsMaximized((current) => !current);
    }
  };

  const toggleLibraryPane = useCallback(() => {
    setIsLibraryOpen((current) => {
      const nextValue = !current;
      window.localStorage.setItem('jawdio-library-open', JSON.stringify(nextValue));
      return nextValue;
    });
  }, []);

  const showLibraryPane = pathname !== '/settings' && pathname !== '/soundboard';
  const pageMeta = useMemo(
    () => pageMetadata[pathname] ?? { title: 'JAWDIO', tag: 'Broadcast Suite' },
    [pathname],
  );
  const libraryPaneStyle: ShellVars = { '--library-width': `${rightWidth}px` };

  return (
    <html lang="en">
      <body className="antialiased select-none">
        <AudioProvider>
          <div className="jawdio-layout">
            <Sidebar isOpen={isSidebarOpen} toggle={() => setIsSidebarOpen((current) => !current)} />

            <div className="content-area">
              <header
                className="border-b border-[var(--line)] bg-[rgba(8,14,22,0.84)] px-4 py-3 backdrop-blur-xl sm:px-6"
                style={dragStyle}
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="flex min-w-0 items-center gap-3 sm:gap-4">
                    <button
                      type="button"
                      onClick={() => setIsSidebarOpen((current) => !current)}
                      className="rounded-full border border-[var(--line)] bg-[rgba(255,255,255,0.03)] p-2 text-[var(--text-base)] transition hover:border-[var(--line-strong)] hover:text-[var(--text-strong)] xl:hidden"
                      style={noDragStyle}
                    >
                      <Menu size={17} />
                    </button>

                    <div className="min-w-0">
                      <p className="eyebrow mb-1">JAWDIO Broadcast Suite</p>
                      <div className="flex min-w-0 items-center gap-3">
                        <h1 className="truncate font-[var(--font-display)] text-xl font-semibold tracking-[-0.04em] text-[var(--text-strong)]">
                          {pageMeta.title}
                        </h1>
                        <span className="hidden rounded-full border border-[rgba(45,212,191,0.24)] bg-[rgba(45,212,191,0.1)] px-3 py-1 text-xs text-[var(--accent)] sm:inline-flex">
                          {pageMeta.tag}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2" style={noDragStyle}>
                    {showLibraryPane && (
                      <button
                        type="button"
                        onClick={toggleLibraryPane}
                        aria-pressed={isLibraryOpen}
                        className={`rounded-full border p-2 transition ${
                          isLibraryOpen
                            ? 'border-[rgba(45,212,191,0.28)] bg-[rgba(45,212,191,0.1)] text-[var(--accent)]'
                            : 'border-[var(--line)] bg-[rgba(255,255,255,0.03)] text-[var(--text-base)] hover:border-[var(--line-strong)] hover:text-[var(--text-strong)]'
                        }`}
                      >
                        <LayoutGrid size={16} />
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => handleWindowAction('minimize')}
                      className="rounded-full border border-transparent p-2 text-[var(--text-muted)] transition hover:border-[var(--line)] hover:bg-[rgba(255,255,255,0.04)] hover:text-[var(--text-strong)]"
                    >
                      <Minus size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleWindowAction('maximize')}
                      className="rounded-full border border-transparent p-2 text-[var(--text-muted)] transition hover:border-[var(--line)] hover:bg-[rgba(255,255,255,0.04)] hover:text-[var(--text-strong)]"
                    >
                      {isMaximized ? <Copy size={12} /> : <Square size={12} />}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleWindowAction('close')}
                      className="rounded-full border border-transparent p-2 text-[var(--text-muted)] transition hover:border-[rgba(251,113,133,0.22)] hover:bg-[rgba(251,113,133,0.1)] hover:text-[var(--danger)]"
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
              </header>

              <UpdateShield />

              <main className="flex min-h-0 flex-1 flex-col overflow-hidden xl:flex-row">
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                  <div className="flex-1 overflow-y-auto px-4 pb-6 pt-4 sm:px-6 xl:px-8">
                    <div className="mx-auto h-full w-full max-w-[1520px]">{children}</div>
                  </div>
                </div>

                {showLibraryPane && (
                  <aside
                    className={`${isLibraryOpen ? 'flex' : 'hidden'} shell-library relative shrink-0 flex-col border-t border-[var(--line)] bg-[rgba(8,12,18,0.72)] backdrop-blur-2xl xl:border-l xl:border-t-0`}
                    style={libraryPaneStyle}
                  >
                    <div
                      onMouseDown={startResizingRight}
                      className="shell-resizer left-0 hidden xl:block"
                    />

                    <div className="m-4 mb-3 rounded-[1.55rem] border border-[var(--line)] bg-[rgba(255,255,255,0.03)] px-4 py-4">
                      <p className="eyebrow mb-2">Global Board</p>
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <h2 className="font-[var(--font-display)] text-xl font-semibold tracking-[-0.04em] text-[var(--text-strong)]">
                            Sound Pads
                          </h2>
                          <p className="mt-1 text-sm text-[var(--text-muted)]">
                            Always-armed playback rack with drag-and-drop organization.
                          </p>
                        </div>
                        <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-[rgba(45,212,191,0.2)] bg-[rgba(45,212,191,0.1)] text-[var(--accent)]">
                          <LayoutGrid size={18} />
                        </div>
                      </div>
                    </div>

                    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
                      <AudioLibrary variant="panel" />
                    </div>
                  </aside>
                )}
              </main>
            </div>
          </div>
        </AudioProvider>
      </body>
    </html>
  );
}

'use client';

import './globals.css';

import type { CSSProperties, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LayoutGrid, Maximize2, Menu, Minimize2, Minus, Copy, Square, X } from 'lucide-react';
import { usePathname } from 'next/navigation';

import AudioLibrary from '@/components/AudioLibrary';
import Sidebar from '@/components/Sidebar';
import UpdateShield from '@/components/UpdateShield';
import { AudioProvider, useAudio } from '@/context/AudioContext';

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
  '/setup': { title: 'Setup', tag: 'Audio Lanes' },
  '/auto-clipper': { title: 'Auto-Clipper', tag: 'AI Detector' },
};

const dragStyle: WindowChromeStyle = { WebkitAppRegion: 'drag' };
const noDragStyle: WindowChromeStyle = { WebkitAppRegion: 'no-drag' };

/**
 * Wires global keyboard shortcuts that depend on AudioContext. Lives inside
 * AudioProvider so it can call useAudio.
 *
 * Shortcuts:
 *   Escape          — Stop all currently-playing sounds
 *   Ctrl/Cmd + Shift + D — Toggle compact density on <body>
 */
function GlobalShortcuts() {
  const { handleStopClick } = useAudio();

  useEffect(() => {
    const stored = window.localStorage.getItem('jawdio-density');

    if (stored === 'compact') {
      document.body.classList.add('density-compact');
    }
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Skip when the user is typing in a field — Escape shouldn't fire then.
      const target = event.target as HTMLElement | null;
      const isInField =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable === true;

      if (event.key === 'Escape' && !isInField) {
        event.preventDefault();
        void handleStopClick();
        return;
      }

      const isDensityToggle =
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === 'd';

      if (isDensityToggle) {
        event.preventDefault();
        const next = document.body.classList.toggle('density-compact');
        window.localStorage.setItem('jawdio-density', next ? 'compact' : 'comfortable');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleStopClick]);

  return null;
}

export default function RootLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isLibraryOpen, setIsLibraryOpen] = useState(false);
  const [isLibraryMaximized, setIsLibraryMaximized] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [isElectronHost, setIsElectronHost] = useState(false);
  const [rightWidth, setRightWidth] = useState(440);
  const isDraggingRight = useRef(false);

  const startResizingRight = useCallback(() => {
    isDraggingRight.current = true;
    document.body.style.cursor = 'col-resize';
  }, []);

  useEffect(() => {
    // Detect Electron once on mount. The setState-in-effect pattern is the
    // accepted way to read `window.electronAPI` while avoiding SSR hydration
    // mismatches — the initial server render assumes "not electron" and we
    // upgrade on the client.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsElectronHost(Boolean(window.electronAPI));
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

  const showLibraryPane =
    pathname !== '/settings' &&
    pathname !== '/soundboard' &&
    pathname !== '/setup' &&
    pathname !== '/auto-clipper';
  const pageMeta = useMemo(
    () => pageMetadata[pathname] ?? { title: 'JAWdio', tag: 'Broadcast Suite' },
    [pathname],
  );
  const libraryPaneStyle: ShellVars = { '--library-width': `${rightWidth}px` };

  return (
    <html lang="en">
      <head>
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover"
        />
      </head>
      <body className="antialiased select-none">
        <AudioProvider>
          <GlobalShortcuts />
          <div className="jawdio-layout">
            <Sidebar isOpen={isSidebarOpen} toggle={() => setIsSidebarOpen((current) => !current)} />

            <div className="content-area">
              <header
                className="border-b border-[var(--line)] bg-[rgba(4,17,30,0.86)] px-3 py-1.5 backdrop-blur-xl sm:px-4"
                style={dragStyle}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setIsSidebarOpen((current) => !current)}
                      className="rounded-md border border-[var(--line)] bg-[rgba(255,255,255,0.04)] p-1.5 text-[var(--text-base)] transition hover:border-[var(--line-strong)] hover:text-[var(--text-strong)] xl:hidden"
                      style={noDragStyle}
                    >
                      <Menu size={15} />
                    </button>

                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        <h1 className="truncate font-[var(--font-display)] text-[0.95rem] font-semibold tracking-[-0.03em] text-[var(--text-strong)]">
                          {pageMeta.title}
                        </h1>
                        <span className="hidden rounded-full border border-[rgba(62,162,230,0.28)] bg-[rgba(62,162,230,0.1)] px-2 py-[1px] text-[10px] uppercase tracking-[0.14em] text-[var(--accent)] sm:inline-flex">
                          {pageMeta.tag}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1" style={noDragStyle}>
                    {showLibraryPane && (
                      <button
                        type="button"
                        onClick={toggleLibraryPane}
                        aria-pressed={isLibraryOpen}
                        title="Toggle pad library"
                        className={`rounded-md border p-1.5 transition ${
                          isLibraryOpen
                            ? 'border-[rgba(62,162,230,0.34)] bg-[rgba(62,162,230,0.12)] text-[var(--accent)]'
                            : 'border-[var(--line)] bg-[rgba(255,255,255,0.04)] text-[var(--text-base)] hover:border-[var(--line-strong)] hover:text-[var(--text-strong)]'
                        }`}
                      >
                        <LayoutGrid size={14} />
                      </button>
                    )}

                    {isElectronHost && (
                      <>
                        <button
                          type="button"
                          onClick={() => handleWindowAction('minimize')}
                          title="Minimize"
                          className="rounded-md border border-transparent p-1.5 text-[var(--text-muted)] transition hover:border-[var(--line)] hover:bg-[rgba(255,255,255,0.05)] hover:text-[var(--text-strong)]"
                        >
                          <Minus size={13} />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleWindowAction('maximize')}
                          title={isMaximized ? 'Restore' : 'Maximize'}
                          className="rounded-md border border-transparent p-1.5 text-[var(--text-muted)] transition hover:border-[var(--line)] hover:bg-[rgba(255,255,255,0.05)] hover:text-[var(--text-strong)]"
                        >
                          {isMaximized ? <Copy size={11} /> : <Square size={11} />}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleWindowAction('close')}
                          title="Close"
                          className="rounded-md border border-transparent p-1.5 text-[var(--text-muted)] transition hover:border-[rgba(229,115,115,0.32)] hover:bg-[rgba(229,115,115,0.16)] hover:text-[var(--danger)]"
                        >
                          <X size={13} />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </header>

              <UpdateShield />

              <main className="flex min-h-0 flex-1 flex-col overflow-hidden xl:flex-row">
                <div
                  className={`${
                    isLibraryMaximized ? 'hidden' : 'flex'
                  } min-h-0 flex-1 flex-col overflow-hidden`}
                >
                  <div className="flex-1 overflow-y-auto px-3 pb-4 pt-3 sm:px-4 xl:px-5">
                    <div className="mx-auto h-full w-full max-w-[1520px]">{children}</div>
                  </div>
                </div>

                {showLibraryPane && (
                  <aside
                    className={`${isLibraryOpen ? 'flex' : 'hidden'} ${
                      isLibraryMaximized
                        ? 'flex-1 max-h-none'
                        : 'shell-library'
                    } relative shrink-0 flex-col border-t border-[var(--line)] bg-[rgba(8,24,42,0.74)] backdrop-blur-2xl xl:border-l xl:border-t-0`}
                    style={isLibraryMaximized ? undefined : libraryPaneStyle}
                  >
                    {!isLibraryMaximized && (
                      <div
                        onMouseDown={startResizingRight}
                        className="shell-resizer left-0 hidden xl:block"
                      />
                    )}

                    <div className="mx-3 mt-3 mb-2 flex items-center justify-between gap-2 rounded-lg border border-[var(--line)] bg-[rgba(255,255,255,0.035)] px-3 py-2">
                      <div className="min-w-0">
                        <p className="eyebrow mb-0.5">Library</p>
                        <h2 className="truncate font-[var(--font-display)] text-sm font-semibold tracking-[-0.02em] text-[var(--text-strong)]">
                          Sound Pads
                        </h2>
                      </div>
                      <button
                        type="button"
                        onClick={() => setIsLibraryMaximized((value) => !value)}
                        title={
                          isLibraryMaximized
                            ? 'Restore the main view'
                            : 'Expand the library to fill the screen'
                        }
                        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition ${
                          isLibraryMaximized
                            ? 'border-[rgba(62,162,230,0.5)] bg-[rgba(62,162,230,0.2)] text-[var(--accent)]'
                            : 'border-[rgba(62,162,230,0.28)] bg-[rgba(62,162,230,0.1)] text-[var(--accent)] hover:bg-[rgba(62,162,230,0.2)]'
                        }`}
                      >
                        {isLibraryMaximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                      </button>
                    </div>

                    <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
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

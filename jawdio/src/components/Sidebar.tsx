'use client';

import type { CSSProperties } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutGrid, MicVocal, Settings2, Square } from 'lucide-react';

import { useAudio } from '@/context/AudioContext';
import { JAWDIO_VERSION } from '@/lib/version';

type SidebarVars = CSSProperties & {
  '--sidebar-width'?: string;
};

export default function Sidebar({
  isOpen,
  toggle,
}: {
  isOpen: boolean;
  toggle: () => void;
}) {
  const pathname = usePathname();
  const { handleStopClick, isHost, sounds, status } = useAudio();

  const [width, setWidth] = useState(296);
  const isDragging = useRef(false);

  const startResizing = useCallback(() => {
    isDragging.current = true;
    document.body.style.cursor = 'col-resize';
  }, []);

  useEffect(() => {
    const syncSidebarWidth = window.setTimeout(() => {
      const storedWidth = window.localStorage.getItem('jawdio-sidebar-width');
      const parsedWidth = Number.parseInt(storedWidth ?? '', 10);

      if (Number.isFinite(parsedWidth)) {
        setWidth(parsedWidth);
      }
    }, 0);

    const handleMouseMove = (event: MouseEvent) => {
      if (!isDragging.current) {
        return;
      }

      const nextWidth = Math.max(248, Math.min(420, event.clientX));
      setWidth(nextWidth);
      window.localStorage.setItem('jawdio-sidebar-width', String(nextWidth));
    };

    const handleMouseUp = () => {
      if (!isDragging.current) {
        return;
      }

      isDragging.current = false;
      document.body.style.cursor = 'default';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.clearTimeout(syncSidebarWidth);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  const navigationItems = useMemo(
    () =>
      [
        { href: '/', label: 'Overview', description: 'Show dashboard', icon: LayoutGrid },
        {
          href: '/studio',
          label: 'Clipper',
          description: 'Buffer, transcript, and edit in one deck',
          icon: MicVocal,
        },
        isHost
          ? {
              href: '/settings',
              label: 'Routing',
              description: 'Configure outputs and monitoring',
              icon: Settings2,
            }
          : null,
      ].filter(Boolean) as Array<{
        href: string;
        label: string;
        description: string;
        icon: typeof LayoutGrid;
      }>,
    [isHost],
  );

  const sidebarStyle: SidebarVars = { '--sidebar-width': `${width}px` };

  return (
    <aside
      className={`shell-sidebar fixed inset-y-0 left-0 z-50 flex shrink-0 border-r border-[var(--line)] bg-[rgba(6,10,16,0.92)] backdrop-blur-2xl transition-transform duration-300 xl:static xl:translate-x-0 ${
        isOpen ? 'translate-x-0' : '-translate-x-full'
      }`}
      style={sidebarStyle}
    >
      <div className="relative flex h-full w-full flex-col overflow-hidden">
        <div className="border-b border-[var(--line)] px-5 pb-5 pt-6">
          <div className="flex items-center justify-between gap-3">
            <Image
              src="/jawdio.png"
              alt="JAWdio"
              width={150}
              height={54}
              className="h-auto w-[150px]"
              priority
            />
            <span className="rounded-full border border-[rgba(45,212,191,0.22)] bg-[rgba(45,212,191,0.1)] px-3 py-1 text-xs text-[var(--accent)]">
              v{JAWDIO_VERSION}
            </span>
          </div>

          <div className="mt-5 grid grid-cols-2 gap-3">
            <div className="metric-card min-w-0">
              <span className="metric-label">Mode</span>
              <strong className="metric-value text-[1.1rem]">{isHost ? 'Host' : 'Remote'}</strong>
            </div>
            <div className="metric-card min-w-0">
              <span className="metric-label">Pads</span>
              <strong className="metric-value text-[1.1rem]">{sounds.length}</strong>
            </div>
          </div>

          <p className="mt-4 text-sm text-[var(--text-muted)]">{status}</p>
        </div>

        <nav className="flex-1 space-y-2 overflow-y-auto px-4 py-5">
          {navigationItems.map((item) => {
            const Icon = item.icon;
            const isActive = pathname === item.href;

            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => {
                  if (window.innerWidth < 1280) {
                    toggle();
                  }
                }}
                className={`group flex items-start gap-3 rounded-[1.35rem] border px-4 py-4 transition ${
                  isActive
                    ? 'border-[rgba(45,212,191,0.28)] bg-[rgba(45,212,191,0.1)]'
                    : 'border-transparent bg-transparent hover:border-[var(--line)] hover:bg-[rgba(255,255,255,0.04)]'
                }`}
              >
                <div
                  className={`mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border ${
                    isActive
                      ? 'border-[rgba(45,212,191,0.24)] bg-[rgba(45,212,191,0.12)] text-[var(--accent)]'
                      : 'border-[var(--line)] bg-[rgba(255,255,255,0.03)] text-[var(--text-muted)] group-hover:text-[var(--text-strong)]'
                  }`}
                >
                  <Icon size={18} />
                </div>
                <div className="min-w-0">
                  <p
                    className={`font-[var(--font-display)] text-lg font-semibold tracking-[-0.04em] ${
                      isActive ? 'text-[var(--text-strong)]' : 'text-[var(--text-base)]'
                    }`}
                  >
                    {item.label}
                  </p>
                  <p className="mt-1 text-sm text-[var(--text-muted)]">{item.description}</p>
                </div>
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-[var(--line)] p-4">
          <button
            type="button"
            onClick={() => void handleStopClick()}
            className="danger-button w-full justify-center"
          >
            <Square size={14} fill="currentColor" />
            Stop All Sounds
          </button>
        </div>
      </div>

      <div onMouseDown={startResizing} className="shell-resizer right-0 hidden xl:block" />
    </aside>
  );
}

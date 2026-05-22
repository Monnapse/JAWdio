'use client';

import type { CSSProperties } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutGrid, MicVocal, Settings2, Sparkles, Square, Volume2, Wand2 } from 'lucide-react';

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

  const [width, setWidth] = useState(232);
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

      const nextWidth = Math.max(196, Math.min(340, event.clientX));
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
        { href: '/', label: 'Overview', icon: LayoutGrid },
        { href: '/soundboard', label: 'Soundboard', icon: Volume2 },
        { href: '/studio', label: 'Clipper', icon: MicVocal },
        isHost
          ? { href: '/auto-clipper', label: 'Auto-Clipper', icon: Sparkles }
          : null,
        isHost ? { href: '/setup', label: 'Setup', icon: Wand2 } : null,
        isHost ? { href: '/settings', label: 'Routing', icon: Settings2 } : null,
      ].filter(Boolean) as Array<{
        href: string;
        label: string;
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
        <div className="border-b border-[var(--line)] px-3 pb-3 pt-3">
          <div className="flex items-center justify-between gap-2">
            <Image
              src="/jawdio.png"
              alt="JAWdio"
              width={120}
              height={42}
              className="h-auto w-[112px]"
              priority
            />
            <span className="rounded-full border border-[rgba(62,162,230,0.28)] bg-[rgba(62,162,230,0.1)] px-2 py-[1px] text-[10px] uppercase tracking-[0.14em] text-[var(--accent)]">
              v{JAWDIO_VERSION}
            </span>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <div className="metric-card min-w-0">
              <span className="metric-label">Mode</span>
              <strong className="metric-value text-[0.95rem]">{isHost ? 'Host' : 'Remote'}</strong>
            </div>
            <div className="metric-card min-w-0">
              <span className="metric-label">Pads</span>
              <strong className="metric-value text-[0.95rem]">{sounds.length}</strong>
            </div>
          </div>

          <p className="mt-2 truncate text-[11px] text-[var(--text-muted)]" title={status}>
            {status}
          </p>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto px-2 py-3">
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
                className={`group flex items-center gap-2 rounded-md border px-2.5 py-2 text-sm transition ${
                  isActive
                    ? 'border-[rgba(62,162,230,0.34)] bg-[rgba(62,162,230,0.12)] text-[var(--text-strong)]'
                    : 'border-transparent text-[var(--text-base)] hover:border-[var(--line)] hover:bg-[rgba(255,255,255,0.04)] hover:text-[var(--text-strong)]'
                }`}
              >
                <Icon
                  size={15}
                  className={isActive ? 'text-[var(--accent)]' : 'text-[var(--text-muted)] group-hover:text-[var(--text-strong)]'}
                />
                <span className="font-[var(--font-display)] font-semibold tracking-[-0.02em]">
                  {item.label}
                </span>
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-[var(--line)] p-2">
          <button
            type="button"
            onClick={() => void handleStopClick()}
            title="Stop all sounds (Esc)"
            className="danger-button w-full justify-center"
          >
            <Square size={12} fill="currentColor" />
            Stop All
            <span className="ml-1 rounded border border-[rgba(229,115,115,0.32)] bg-[rgba(229,115,115,0.16)] px-1.5 py-[1px] text-[10px] tracking-[0.08em]">
              Esc
            </span>
          </button>
        </div>
      </div>

      <div onMouseDown={startResizing} className="shell-resizer right-0 hidden xl:block" />
    </aside>
  );
}

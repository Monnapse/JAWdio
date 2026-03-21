'use client';

import Image from 'next/image';
import Link from 'next/link';
import { LayoutGrid, MicVocal, Settings2, Volume2 } from 'lucide-react';
import { useMemo } from 'react';

import { useAudio } from '@/context/AudioContext';

const featureCards = [
  {
    href: '/studio',
    label: 'Clipper',
    title: 'Buffer, monitor speech, and finish every clip in one workspace.',
    icon: MicVocal,
    accent: 'rgba(45,212,191,0.18)',
  },
  {
    href: '/settings',
    label: 'Routing',
    title: 'Dial in the monitoring path and virtual output chain.',
    icon: Settings2,
    accent: 'rgba(247,185,85,0.16)',
  },
];

export default function DashboardPage() {
  const { sounds, isHost, cableName, status } = useAudio();

  const categoryCount = useMemo(
    () => new Set(sounds.map((sound) => sound.category)).size || 1,
    [sounds],
  );

  return (
    <div className="flex min-h-full flex-col gap-6 py-2">
      <section className="panel-surface relative overflow-hidden p-6 sm:p-8">
        <div className="absolute inset-y-0 right-0 hidden w-1/2 bg-[radial-gradient(circle_at_top_right,rgba(45,212,191,0.16),transparent_58%)] lg:block" />
        <div className="relative grid gap-8 lg:grid-cols-[1.2fr_0.8fr] lg:items-center">
          <div>
            <p className="eyebrow mb-3">Broadcast Soundboard</p>
            <h2 className="max-w-3xl font-[var(--font-display)] text-4xl font-semibold tracking-[-0.05em] text-[var(--text-strong)] sm:text-5xl">
              A cleaner, faster control surface for live moments.
            </h2>
            <p className="mt-4 max-w-2xl text-base text-[var(--text-muted)] sm:text-lg">
              Route audio, build instant pads, and capture show-ready moments from a unified
              clipper built to feel like premium production software.
            </p>

            <div className="mt-6 flex flex-wrap gap-3">
              <span className="rounded-full border border-[rgba(45,212,191,0.24)] bg-[rgba(45,212,191,0.08)] px-4 py-2 text-sm text-[var(--accent)]">
                {status}
              </span>
              <span className="rounded-full border border-[var(--line)] bg-[rgba(255,255,255,0.04)] px-4 py-2 text-sm text-[var(--text-base)]">
                Virtual route: {cableName}
              </span>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
            <div className="panel-soft flex items-center gap-4 p-4">
              <div className="flex h-14 w-14 items-center justify-center rounded-[1.35rem] border border-[rgba(45,212,191,0.22)] bg-[rgba(45,212,191,0.1)]">
                <Image
                  src="/jawdio.png"
                  alt="JAWdio"
                  width={120}
                  height={40}
                  className="h-auto w-[86px]"
                  priority
                />
              </div>
              <div>
                <p className="eyebrow mb-1">Board Status</p>
                <p className="text-base text-[var(--text-strong)]">
                  {isHost ? 'Host system armed and ready.' : 'Connected as a remote client.'}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="metric-card">
                <span className="metric-label">Loaded Pads</span>
                <strong className="metric-value">{sounds.length}</strong>
              </div>
              <div className="metric-card">
                <span className="metric-label">Folders</span>
                <strong className="metric-value">{categoryCount}</strong>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-5 2xl:grid-cols-[1fr_0.78fr]">
        <div className="grid gap-5 md:grid-cols-2">
          {featureCards.map((card) => {
            const Icon = card.icon;

            return (
              <Link
                key={card.href}
                href={card.href}
                className="panel-surface group relative overflow-hidden p-6 transition duration-200 hover:-translate-y-1"
              >
                <div
                  className="absolute inset-x-0 top-0 h-px"
                  style={{
                    background: `linear-gradient(90deg, transparent, ${card.accent}, transparent)`,
                  }}
                />
                <div
                  className="flex h-14 w-14 items-center justify-center rounded-[1.35rem] border"
                  style={{ borderColor: card.accent, background: card.accent }}
                >
                  <Icon size={24} className="text-[var(--text-strong)]" />
                </div>
                <p className="eyebrow mt-6 mb-2">{card.label}</p>
                <h3 className="font-[var(--font-display)] text-2xl font-semibold tracking-[-0.04em] text-[var(--text-strong)]">
                  {card.title}
                </h3>
                <p className="mt-3 text-sm text-[var(--text-muted)]">
                  Open the workspace and keep your board visible in the side rack while you work.
                </p>
              </Link>
            );
          })}
        </div>

        <section className="panel-surface p-6">
          <p className="eyebrow mb-3">Signal Path</p>
          <h3 className="font-[var(--font-display)] text-2xl font-semibold tracking-[-0.04em] text-[var(--text-strong)]">
            Build a dependable on-air chain.
          </h3>
          <div className="mt-5 space-y-4">
            <div className="panel-soft flex items-start gap-4 p-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-[1.2rem] border border-[var(--line)] bg-[rgba(255,255,255,0.04)] text-[var(--accent)]">
                <LayoutGrid size={18} />
              </div>
              <div>
                <p className="text-sm font-semibold text-[var(--text-strong)]">
                  Organize pads by show segment.
                </p>
                <p className="mt-1 text-sm text-[var(--text-muted)]">
                  Keep drops, music beds, reactions, and callbacks separated for muscle memory.
                </p>
              </div>
            </div>

            <div className="panel-soft flex items-start gap-4 p-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-[1.2rem] border border-[var(--line)] bg-[rgba(255,255,255,0.04)] text-[var(--warm)]">
                <Volume2 size={18} />
              </div>
              <div>
                <p className="text-sm font-semibold text-[var(--text-strong)]">
                  Monitor locally while routing to virtual cable.
                </p>
                <p className="mt-1 text-sm text-[var(--text-muted)]">
                  Use Routing to send the same event to your broadcast chain and your own speakers.
                </p>
              </div>
            </div>

            {isHost && (
              <Link href="/settings" className="ghost-button w-full justify-center">
                <Settings2 size={16} />
                Open Routing Controls
              </Link>
            )}
          </div>
        </section>
      </section>
    </div>
  );
}

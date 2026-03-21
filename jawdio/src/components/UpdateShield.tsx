'use client';

import { Download } from 'lucide-react';

import { useAudio } from '@/context/AudioContext';
import { GITHUB_REPO, JAWDIO_VERSION } from '@/lib/version';

export default function UpdateShield() {
  const { hasUpdate, latestVersion } = useAudio();

  if (!hasUpdate) {
    return null;
  }

  return (
    <div className="border-b border-[rgba(247,185,85,0.22)] bg-[rgba(247,185,85,0.08)] px-4 py-3 sm:px-6">
      <div className="mx-auto flex max-w-[1520px] flex-wrap items-center justify-between gap-3">
        <div>
          <p className="eyebrow mb-1 text-[var(--warm)]">Update Available</p>
          <p className="text-sm text-[var(--text-strong)]">
            Version {latestVersion} is ready. You&apos;re currently running {JAWDIO_VERSION}.
          </p>
        </div>
        <a
          href={`https://github.com/${GITHUB_REPO}/releases`}
          target="_blank"
          rel="noreferrer"
          className="ghost-button text-sm"
        >
          <Download size={16} />
          View Release
        </a>
      </div>
    </div>
  );
}

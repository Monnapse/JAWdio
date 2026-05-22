'use client';

import {
  CheckCircle2,
  Circle,
  Copy,
  Cpu,
  Download,
  Gamepad2,
  MessageCircle,
  Smartphone,
  Volume2,
  Wand2,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { useAudio } from '@/context/AudioContext';
import {
  CABLE_DEFINITIONS,
  type CableDefinition,
  type LaneId,
} from '@/lib/audio-routing';

const LANE_ICON: Record<LaneId, typeof Volume2> = {
  soundboard: Volume2,
  game: Gamepad2,
  voicechat: MessageCircle,
};

interface LaneStatus {
  definition: CableDefinition;
  installed: boolean;
  outputReady: boolean;
}

export default function SetupPage() {
  const { applyRecommendedRouting, detectedCables, isHost } = useAudio();

  const [lanUrls, setLanUrls] = useState<LanUrl[]>([]);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI?.getLanUrls) {
      return;
    }

    let cancelled = false;

    window.electronAPI
      .getLanUrls()
      .then((urls) => {
        if (!cancelled) {
          setLanUrls(urls);
        }
      })
      .catch((error) => {
        console.error('Failed to resolve LAN URLs:', error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const copyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedUrl(url);
      window.setTimeout(() => {
        setCopiedUrl((current) => (current === url ? null : current));
      }, 1800);
    } catch (error) {
      console.error('Clipboard copy failed:', error);
    }
  };

  const laneStatuses = useMemo<LaneStatus[]>(
    () =>
      CABLE_DEFINITIONS.map((definition) => {
        const detected = detectedCables.find(
          (cable) => cable.laneId === definition.laneId,
        );
        return {
          definition,
          installed: Boolean(detected),
          outputReady: Boolean(detected?.outputDeviceId),
        };
      }),
    [detectedCables],
  );

  const installedCount = laneStatuses.filter((lane) => lane.installed).length;
  const allInstalled = installedCount === laneStatuses.length;
  const partialInstall = installedCount > 0 && !allInstalled;

  if (!isHost) {
    return (
      <div className="flex min-h-full items-center justify-center py-8">
        <section className="panel-surface w-full max-w-2xl p-8 text-center">
          <p className="eyebrow mb-3">Host Only</p>
          <h2 className="font-[var(--font-display)] text-3xl font-semibold tracking-[-0.04em] text-[var(--text-strong)]">
            Setup runs on the desktop host.
          </h2>
          <p className="mt-3 text-sm text-[var(--text-muted)]">
            Open JAWdio on the machine you stream from to install and assign audio routes.
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col gap-6 py-2">
      <section className="panel-surface p-6 sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="max-w-3xl">
            <p className="eyebrow mb-3">Setup</p>
            <h1 className="font-[var(--font-display)] text-3xl font-semibold tracking-[-0.05em] text-[var(--text-strong)] sm:text-4xl">
              Get JAWdio onto its own audio lanes.
            </h1>
            <p className="mt-4 text-base text-[var(--text-muted)]">
              JAWdio needs up to three audio routes so OBS can record your mic, soundboard, game,
              and voice chat as separate tracks. Install whichever lanes you want, then hit Apply
              Recommended Routing.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="metric-card">
              <span className="metric-label">Lanes installed</span>
              <strong className="metric-value">
                {installedCount}/{laneStatuses.length}
              </strong>
            </div>
            <div className="metric-card">
              <span className="metric-label">Status</span>
              <strong className="metric-value text-[1.05rem]">
                {allInstalled ? 'Ready' : partialInstall ? 'Partial' : 'Empty'}
              </strong>
            </div>
          </div>
        </div>
      </section>

      <section className="panel-surface p-6">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-[1.2rem] border border-[rgba(45,212,191,0.24)] bg-[rgba(45,212,191,0.1)] text-[var(--accent)]">
            <Cpu size={18} />
          </div>
          <div>
            <p className="eyebrow mb-1">Step 1</p>
            <h2 className="font-[var(--font-display)] text-2xl font-semibold tracking-[-0.04em] text-[var(--text-strong)]">
              Install the audio lanes you need.
            </h2>
          </div>
        </div>

        <ul className="space-y-3">
          {laneStatuses.map(({ definition, installed, outputReady }) => {
            const Icon = LANE_ICON[definition.laneId];

            return (
              <li
                key={definition.laneId}
                className="rounded-[1.2rem] border border-[var(--line)] bg-[rgba(255,255,255,0.02)] p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="flex flex-1 min-w-0 items-start gap-3">
                    <div
                      className={`mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border ${
                        installed
                          ? 'border-[rgba(45,212,191,0.28)] bg-[rgba(45,212,191,0.12)] text-[var(--accent)]'
                          : 'border-[var(--line)] bg-[rgba(255,255,255,0.03)] text-[var(--text-muted)]'
                      }`}
                    >
                      <Icon size={18} />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        {installed ? (
                          <CheckCircle2 size={16} className="text-[var(--accent)]" />
                        ) : (
                          <Circle size={16} className="text-[var(--text-muted)]" />
                        )}
                        <h3 className="font-[var(--font-display)] text-lg font-semibold tracking-[-0.03em] text-[var(--text-strong)]">
                          {definition.friendlyName}
                        </h3>
                      </div>
                      <p className="mt-1 text-sm text-[var(--text-muted)]">
                        {definition.description}
                      </p>
                      <p className="mt-2 text-xs text-[var(--text-muted)]">
                        Powered by{' '}
                        <span className="text-[var(--text-strong)]">{definition.productName}</span>
                        .
                        {installed && !outputReady && (
                          <span className="ml-2 text-[var(--warm)]">
                            Recording side not detected — reboot Windows after install if you just
                            ran it.
                          </span>
                        )}
                      </p>
                    </div>
                  </div>

                  {installed ? (
                    <span className="inline-flex items-center gap-2 self-start rounded-full border border-[rgba(45,212,191,0.32)] bg-[rgba(45,212,191,0.1)] px-3 py-1.5 text-xs text-[var(--accent)]">
                      <CheckCircle2 size={14} />
                      Installed
                    </span>
                  ) : (
                    <a
                      href={definition.installUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="ghost-button inline-flex items-center gap-2 self-start"
                    >
                      <Download size={16} />
                      Install
                    </a>
                  )}
                </div>
              </li>
            );
          })}
        </ul>

        <p className="mt-4 text-xs text-[var(--text-muted)]">
          After running an installer, Windows usually requires a reboot before the new device shows
          up. JAWdio rescans devices automatically — if a lane stays missing after reboot, try the
          install link again.
        </p>
      </section>

      <section className="panel-surface p-6">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-[1.2rem] border border-[rgba(247,185,85,0.24)] bg-[rgba(247,185,85,0.1)] text-[var(--warm)]">
            <Wand2 size={18} />
          </div>
          <div>
            <p className="eyebrow mb-1">Step 2</p>
            <h2 className="font-[var(--font-display)] text-2xl font-semibold tracking-[-0.04em] text-[var(--text-strong)]">
              Apply recommended JAWdio routing.
            </h2>
          </div>
        </div>

        <p className="text-sm text-[var(--text-muted)]">
          This points JAWdio&apos;s broadcast output at the Soundboard route, picks a physical
          output for local monitoring, and turns Hear Pads Locally on so you can still hear pads on
          your headphones while OBS records them silently.
        </p>

        <button
          type="button"
          onClick={() => void applyRecommendedRouting()}
          disabled={!laneStatuses[0].installed}
          className="accent-button mt-5 inline-flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Wand2 size={16} />
          Apply Recommended Routing
        </button>

        {!laneStatuses[0].installed && (
          <p className="mt-3 text-xs text-[var(--warm)]">
            Install the Soundboard route first — JAWdio needs at least that lane to broadcast.
          </p>
        )}
      </section>

      <section className="panel-surface p-6">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-[1.2rem] border border-[var(--line)] bg-[rgba(255,255,255,0.04)] text-[var(--text-strong)]">
            <Gamepad2 size={18} />
          </div>
          <div>
            <p className="eyebrow mb-1">Step 3 (optional)</p>
            <h2 className="font-[var(--font-display)] text-2xl font-semibold tracking-[-0.04em] text-[var(--text-strong)]">
              Point Fortnite at the game and voice chat lanes.
            </h2>
          </div>
        </div>

        <p className="text-sm text-[var(--text-muted)]">
          Only needed if you want OBS to record game and voice chat on separate tracks. Inside
          Fortnite, open <span className="text-[var(--text-strong)]">Settings → Audio</span> and
          set:
        </p>

        <ul className="mt-4 space-y-2 text-sm text-[var(--text-muted)]">
          <li>
            <span className="text-[var(--text-strong)]">Audio Output Device:</span> Game audio
            route (the lane labelled <em>Game audio route</em> above).
          </li>
          <li>
            <span className="text-[var(--text-strong)]">Voice Chat Output Device:</span> Voice chat
            route (the lane labelled <em>Voice chat route</em> above).
          </li>
          <li>
            <span className="text-[var(--text-strong)]">Voice Chat Input Device:</span> Your
            physical microphone (not a JAWdio lane).
          </li>
        </ul>

        <p className="mt-4 text-xs text-[var(--text-muted)]">
          In OBS, add an <span className="text-[var(--text-strong)]">Audio Output Capture</span>{' '}
          source for each lane, then assign each source to a different track in Advanced Audio
          Properties. Settings → Output → Recording should be set to MKV with tracks 1–4 ticked.
        </p>
      </section>

      <section className="panel-surface p-6">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-[1.2rem] border border-[rgba(62,162,230,0.24)] bg-[rgba(62,162,230,0.1)] text-[var(--accent)]">
            <Smartphone size={18} />
          </div>
          <div>
            <p className="eyebrow mb-1">Optional</p>
            <h2 className="font-[var(--font-display)] text-2xl font-semibold tracking-[-0.04em] text-[var(--text-strong)]">
              Open JAWdio from another device.
            </h2>
          </div>
        </div>

        <p className="text-sm text-[var(--text-muted)]">
          Type one of these addresses into a browser on your phone or another computer (on the
          same Wi-Fi) to trigger pads or use the Clipper from that device. The host has to stay
          running for these URLs to work.
        </p>

        {lanUrls.length === 0 ? (
          <p className="mt-4 text-xs text-[var(--text-muted)]">
            No network addresses found yet. If you just connected to Wi-Fi, give it a few
            seconds and revisit this page.
          </p>
        ) : (
          <ul className="mt-4 space-y-2">
            {lanUrls.map((entry) => (
              <li
                key={`${entry.label}-${entry.url}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--line)] bg-[rgba(255,255,255,0.02)] px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="eyebrow mb-0.5">{entry.label}</p>
                  <code className="block truncate text-sm text-[var(--text-strong)]">
                    {entry.url}
                  </code>
                </div>
                <button
                  type="button"
                  onClick={() => void copyUrl(entry.url)}
                  className="ghost-button shrink-0"
                >
                  <Copy size={13} />
                  {copiedUrl === entry.url ? 'Copied!' : 'Copy'}
                </button>
              </li>
            ))}
          </ul>
        )}

        <p className="mt-3 text-xs text-[var(--text-muted)]">
          Remote devices act as <span className="text-[var(--text-strong)]">controllers</span>{' '}
          for the host — they fire pads and drive the Clipper, but the actual audio capture,
          rolling buffer, and clip saves all happen on the host machine. No microphone access
          or HTTPS is needed on the remote.
        </p>
      </section>
    </div>
  );
}

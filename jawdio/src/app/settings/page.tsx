'use client';

import { Headphones, Mic, Music, Speaker, Waves } from 'lucide-react';

import { useAudio } from '@/context/AudioContext';

export default function SettingsPage() {
  const {
    activeMicId,
    cableName,
    handleMicChange,
    hearOwnSounds,
    isHost,
    micVolume,
    mics,
    outputs,
    setHearOwnSounds,
    setMicVolume,
    setSoundVolume,
    soundVolume,
  } = useAudio();

  if (!isHost) {
    return (
      <div className="flex min-h-full items-center justify-center py-8">
        <section className="panel-surface w-full max-w-2xl p-8 text-center">
          <p className="eyebrow mb-3">Host Only</p>
          <h2 className="font-[var(--font-display)] text-3xl font-semibold tracking-[-0.04em] text-[var(--text-strong)]">
            Routing controls are only available on the desktop host.
          </h2>
          <p className="mt-3 text-sm text-[var(--text-muted)]">
            Open this page from the Electron app to choose microphones, monitoring, and output
            routing.
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col gap-6 py-2">
      <section className="panel-surface p-6 sm:p-8">
        <p className="eyebrow mb-3">Mixer & Routing</p>
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="max-w-3xl">
            <h2 className="font-[var(--font-display)] text-3xl font-semibold tracking-[-0.05em] text-[var(--text-strong)] sm:text-4xl">
              Fine-tune the path from microphone to board to broadcast chain.
            </h2>
            <p className="mt-4 text-base text-[var(--text-muted)]">
              These controls define how your mic, soundboard playback, and local monitoring work
              together in the host deck.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="metric-card">
              <span className="metric-label">Inputs</span>
              <strong className="metric-value">{mics.length}</strong>
            </div>
            <div className="metric-card">
              <span className="metric-label">Outputs</span>
              <strong className="metric-value">{outputs.length}</strong>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-5 2xl:grid-cols-[1.1fr_0.9fr]">
        <div className="space-y-5">
          <div className="panel-surface p-6">
            <div className="mb-5 flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-[1.2rem] border border-[rgba(45,212,191,0.24)] bg-[rgba(45,212,191,0.1)] text-[var(--accent)]">
                <Mic size={18} />
              </div>
              <div>
                <p className="eyebrow mb-1">Input Source</p>
                <h3 className="font-[var(--font-display)] text-2xl font-semibold tracking-[-0.04em] text-[var(--text-strong)]">
                  Choose the live microphone feed.
                </h3>
              </div>
            </div>

            <select
              value={activeMicId}
              onChange={(event) => void handleMicChange(event.target.value)}
              className="select-field"
            >
              <option value="none">Disable microphone routing</option>
              {mics.map((mic) => (
                <option key={mic.deviceId} value={mic.deviceId}>
                  {mic.label || `Microphone ${mic.deviceId.slice(0, 6)}`}
                </option>
              ))}
            </select>
          </div>

          <div className="grid gap-5 md:grid-cols-2">
            <div className="panel-surface p-6">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-[var(--line)] bg-[rgba(255,255,255,0.04)] text-[var(--accent)]">
                    <Waves size={17} />
                  </div>
                  <div>
                    <p className="eyebrow mb-1">Mic Level</p>
                    <p className="text-sm text-[var(--text-strong)]">Input monitor gain</p>
                  </div>
                </div>
                <span className="rounded-full border border-[var(--line)] px-3 py-1 text-xs text-[var(--text-base)]">
                  {Math.round(micVolume * 100)}%
                </span>
              </div>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={micVolume}
                onChange={(event) => setMicVolume(Number.parseFloat(event.target.value))}
                className="range-accent mt-6 w-full"
              />
            </div>

            <div className="panel-surface p-6">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-[var(--line)] bg-[rgba(255,255,255,0.04)] text-[var(--warm)]">
                    <Music size={17} />
                  </div>
                  <div>
                    <p className="eyebrow mb-1">Board Level</p>
                    <p className="text-sm text-[var(--text-strong)]">Pad playback gain</p>
                  </div>
                </div>
                <span className="rounded-full border border-[var(--line)] px-3 py-1 text-xs text-[var(--text-base)]">
                  {Math.round(soundVolume * 100)}%
                </span>
              </div>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={soundVolume}
                onChange={(event) => setSoundVolume(Number.parseFloat(event.target.value))}
                className="range-accent mt-6 w-full"
              />
            </div>
          </div>
        </div>

        <div className="space-y-5">
          <div className="panel-surface p-6">
            <div className="mb-5 flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-[1.2rem] border border-[rgba(247,185,85,0.24)] bg-[rgba(247,185,85,0.1)] text-[var(--warm)]">
                <Speaker size={18} />
              </div>
              <div>
                <p className="eyebrow mb-1">Broadcast Output</p>
                <h3 className="font-[var(--font-display)] text-2xl font-semibold tracking-[-0.04em] text-[var(--text-strong)]">
                  Virtual cable destination
                </h3>
              </div>
            </div>

            <div className="panel-soft p-5">
              <p className="text-sm text-[var(--text-muted)]">Primary route</p>
              <p className="mt-2 font-[var(--font-display)] text-2xl font-semibold tracking-[-0.04em] text-[var(--text-strong)]">
                {cableName}
              </p>
            </div>
          </div>

          <div className="panel-surface p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-[1.2rem] border border-[var(--line)] bg-[rgba(255,255,255,0.04)] text-[var(--text-base)]">
                  <Headphones size={18} />
                </div>
                <div>
                  <p className="eyebrow mb-1">Local Monitoring</p>
                  <h3 className="font-[var(--font-display)] text-2xl font-semibold tracking-[-0.04em] text-[var(--text-strong)]">
                    Hear pads in your own speakers too.
                  </h3>
                  <p className="mt-2 text-sm text-[var(--text-muted)]">
                    This only adds a second local copy of pad playback. It does not mute whatever
                    is already monitoring the broadcast cable in Windows, OBS, or your audio gear.
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setHearOwnSounds(!hearOwnSounds)}
                className={`relative inline-flex h-8 w-14 items-center rounded-full border transition ${
                  hearOwnSounds
                    ? 'border-[rgba(45,212,191,0.4)] bg-[rgba(45,212,191,0.25)]'
                    : 'border-[var(--line)] bg-[rgba(255,255,255,0.05)]'
                }`}
              >
                <span
                  className={`h-5 w-5 rounded-full bg-white transition ${
                    hearOwnSounds ? 'translate-x-8' : 'translate-x-1.5'
                  }`}
                />
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

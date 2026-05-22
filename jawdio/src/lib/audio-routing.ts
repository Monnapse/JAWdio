/**
 * Audio routing definitions for JAWdio's Setup wizard.
 *
 * JAWdio's "lanes" are the audio buses we need on the user's machine to put
 * mic / soundboard / game / voice chat onto separate OBS tracks. Each lane maps
 * to a virtual audio cable. We detect them by matching Windows device labels.
 *
 * To swap the wizard from "guide the free download" to "bundled installer",
 * change only the `installUrl` field — the rest of the app keeps working.
 */

export type LaneId = 'soundboard' | 'game' | 'voicechat';

export interface CableDefinition {
  /** Internal id of the JAWdio lane this cable powers. */
  laneId: LaneId;
  /** Human label shown in JAWdio (never the raw VB-Audio name). */
  friendlyName: string;
  /** Short caption explaining what the lane is for. */
  description: string;
  /**
   * Substrings (lowercase) that, when matched against a Windows device label,
   * indicate the underlying cable is installed. First match wins.
   */
  matchHints: string[];
  /** Marketing name of the third-party product we expect to provide this lane. */
  productName: string;
  /** Where the user goes to install it (free path). Will be replaced by the bundled installer later. */
  installUrl: string;
}

/**
 * Ordered list of lanes JAWdio's v1 supports. Order matters — the Setup page
 * walks the user top-to-bottom.
 */
export const CABLE_DEFINITIONS: CableDefinition[] = [
  {
    laneId: 'soundboard',
    friendlyName: 'Soundboard route',
    description: 'Carries JAWdio pad audio so OBS can record it on its own track.',
    matchHints: ['cable input (vb-audio virtual cable)', 'vb-audio virtual cable'],
    productName: 'VB-Cable (free)',
    installUrl: 'https://vb-audio.com/Cable/',
  },
  {
    laneId: 'game',
    friendlyName: 'Game audio route',
    description: 'Carries Fortnite game/SFX/music so OBS gets it on its own track.',
    matchHints: ['cable-a input', 'vb-audio cable a'],
    productName: 'VB-Cable A (donation pack)',
    installUrl: 'https://vb-audio.com/Cable/index.htm#DownloadCableAB',
  },
  {
    laneId: 'voicechat',
    friendlyName: 'Voice chat route',
    description: 'Carries teammate voices so OBS can record them on their own track (also lets the Clipper isolate them).',
    matchHints: ['cable-b input', 'vb-audio cable b'],
    productName: 'VB-Cable B (donation pack)',
    installUrl: 'https://vb-audio.com/Cable/index.htm#DownloadCableAB',
  },
];

export interface DetectedCable {
  /** Lane this cable populates. */
  laneId: LaneId;
  /** The matching Windows playback device (the "Input" side that apps play TO). */
  inputDeviceId: string;
  inputDeviceLabel: string;
  /** The matching Windows recording device (the "Output" side that OBS or the Clipper records FROM). */
  outputDeviceId: string | null;
  outputDeviceLabel: string | null;
}

const findFirstMatch = (devices: MediaDeviceInfo[], hints: string[]) => {
  for (const hint of hints) {
    const match = devices.find((device) => device.label.toLowerCase().includes(hint));

    if (match) {
      return match;
    }
  }

  return null;
};

/**
 * Inspect the list of enumerated audio devices and return one DetectedCable per
 * lane that's actually installed. The pairing rule is "Input device on the
 * playback side, Output device on the recording side, both matched by the same
 * label hints." If only the playback side is present (or vice versa) the cable
 * is treated as half-installed and the missing side is reported as null so the
 * UI can flag it for repair.
 */
export const detectInstalledCables = (
  audioOutputs: MediaDeviceInfo[],
  audioInputs: MediaDeviceInfo[],
): DetectedCable[] => {
  const detected: DetectedCable[] = [];

  for (const definition of CABLE_DEFINITIONS) {
    const playback = findFirstMatch(audioOutputs, definition.matchHints);

    if (!playback) {
      continue;
    }

    const recording = findFirstMatch(audioInputs, definition.matchHints);

    detected.push({
      laneId: definition.laneId,
      inputDeviceId: playback.deviceId,
      inputDeviceLabel: playback.label,
      outputDeviceId: recording?.deviceId ?? null,
      outputDeviceLabel: recording?.label ?? null,
    });
  }

  return detected;
};

export const getCableDefinition = (laneId: LaneId): CableDefinition => {
  const match = CABLE_DEFINITIONS.find((cable) => cable.laneId === laneId);

  if (!match) {
    throw new Error(`Unknown JAWdio audio lane: ${laneId}`);
  }

  return match;
};

/**
 * Friendly rename for any device label that matches a known cable. Falls back
 * to the original label so unknown devices (a real headset, monitor speakers,
 * etc.) keep their normal Windows name.
 */
export const friendlyDeviceLabel = (label: string): string => {
  const lowered = label.toLowerCase();

  for (const definition of CABLE_DEFINITIONS) {
    for (const hint of definition.matchHints) {
      if (lowered.includes(hint)) {
        return definition.friendlyName;
      }
    }
  }

  return label;
};

const getAudioContextConstructor = () => {
  const AudioContextCtor = window.AudioContext ?? window.webkitAudioContext;

  if (!AudioContextCtor) {
    throw new Error("Web Audio API is unavailable in this environment.");
  }

  return AudioContextCtor;
};

export const createAudioContext = () => new (getAudioContextConstructor())();

export const encodeWav = (audioBuffer: AudioBuffer) => {
  const channelCount = audioBuffer.numberOfChannels;
  const wavLength = audioBuffer.length * channelCount * 2 + 44;
  const buffer = new ArrayBuffer(wavLength);
  const view = new DataView(buffer);
  const channels = Array.from({ length: channelCount }, (_, index) =>
    audioBuffer.getChannelData(index),
  );

  let offset = 0;
  let position = 0;

  const setUint16 = (value: number) => {
    view.setUint16(offset, value, true);
    offset += 2;
  };

  const setUint32 = (value: number) => {
    view.setUint32(offset, value, true);
    offset += 4;
  };

  setUint32(0x46464952);
  setUint32(wavLength - 8);
  setUint32(0x45564157);
  setUint32(0x20746d66);
  setUint32(16);
  setUint16(1);
  setUint16(channelCount);
  setUint32(audioBuffer.sampleRate);
  setUint32(audioBuffer.sampleRate * channelCount * 2);
  setUint16(channelCount * 2);
  setUint16(16);
  setUint32(0x61746164);
  setUint32(wavLength - 44);

  while (position < audioBuffer.length) {
    for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
      const sample = Math.max(-1, Math.min(1, channels[channelIndex][position]));
      const scaled = sample < 0 ? sample * 32768 : sample * 32767;
      view.setInt16(offset, scaled, true);
      offset += 2;
    }

    position += 1;
  }

  return new Blob([buffer], { type: "audio/wav" });
};

export const sliceAndExportAudio = async (
  blob: Blob,
  startSeconds: number,
  endSeconds: number,
) => {
  const audioContext = createAudioContext();

  try {
    const arrayBuffer = await blob.arrayBuffer();
    const decodedData = await audioContext.decodeAudioData(arrayBuffer);
    const safeStart = Math.max(0, Math.min(startSeconds, decodedData.duration));
    const safeEnd = Math.max(safeStart + 0.05, Math.min(endSeconds, decodedData.duration));

    const sampleRate = decodedData.sampleRate;
    const startOffset = Math.max(0, Math.floor(sampleRate * safeStart));
    const endOffset = Math.max(startOffset + 1, Math.floor(sampleRate * safeEnd));
    const frameCount = Math.max(1, Math.min(decodedData.length, endOffset) - startOffset);

    const offlineContext = new OfflineAudioContext(
      decodedData.numberOfChannels,
      frameCount,
      sampleRate,
    );

    const source = offlineContext.createBufferSource();
    source.buffer = decodedData;
    source.connect(offlineContext.destination);
    source.start(0, safeStart, frameCount / sampleRate);

    const renderedBuffer = await offlineContext.startRendering();
    return encodeWav(renderedBuffer);
  } finally {
    if (audioContext.state !== "closed") {
      await audioContext.close();
    }
  }
};

"use client";
import { useState, useRef, useEffect } from "react";
import { useAudio } from "@/context/AudioContext";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.esm.js";
import {
  Bookmark,
  Scissors,
  Save,
  Play,
  Pause,
  Loader2,
  Type,
} from "lucide-react";

const encodeWAV = (audioBuffer: AudioBuffer) => {
  const numOfChan = audioBuffer.numberOfChannels;
  const length = audioBuffer.length * numOfChan * 2 + 44;
  const buffer = new ArrayBuffer(length);
  const view = new DataView(buffer);
  const channels = [];
  let offset = 0;
  let pos = 0;

  const setUint16 = (data: number) => {
    view.setUint16(offset, data, true);
    offset += 2;
  };
  const setUint32 = (data: number) => {
    view.setUint32(offset, data, true);
    offset += 4;
  };

  setUint32(0x46464952);
  setUint32(length - 8);
  setUint32(0x45564157);
  setUint32(0x20746d66);
  setUint32(16);
  setUint16(1);
  setUint16(numOfChan);
  setUint32(audioBuffer.sampleRate);
  setUint32(audioBuffer.sampleRate * 2 * numOfChan);
  setUint16(numOfChan * 2);
  setUint16(16);
  setUint32(0x61746164);
  setUint32(length - pos - 4);

  for (let i = 0; i < audioBuffer.numberOfChannels; i++)
    channels.push(audioBuffer.getChannelData(i));

  while (pos < audioBuffer.length) {
    for (let i = 0; i < numOfChan; i++) {
      let sample = Math.max(-1, Math.min(1, channels[i][pos]));
      sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0;
      view.setInt16(offset, sample, true);
      offset += 2;
    }
    pos++;
  }
  return new Blob([buffer], { type: "audio/wav" });
};

const sliceAndExportAudio = async (blob: Blob, start: number, end: number) => {
  const audioCtx = new (
    window.AudioContext || (window as any).webkitAudioContext
  )();
  const arrayBuffer = await blob.arrayBuffer();
  const decodedData = await audioCtx.decodeAudioData(arrayBuffer);

  const sampleRate = decodedData.sampleRate;
  const channels = decodedData.numberOfChannels;
  const startOffset = Math.floor(sampleRate * start);
  let endOffset = Math.floor(sampleRate * end);

  if (endOffset <= startOffset) endOffset = startOffset + sampleRate;
  const frameCount = Math.max(1, endOffset - startOffset);

  const offlineCtx = new OfflineAudioContext(channels, frameCount, sampleRate);
  const source = offlineCtx.createBufferSource();
  source.buffer = decodedData;
  source.connect(offlineCtx.destination);
  source.start(0, start, frameCount / sampleRate);

  const renderedBuffer = await offlineCtx.startRendering();

  if (audioCtx.state !== "closed") await audioCtx.close();

  return encodeWAV(renderedBuffer);
};

export default function StudioPage() {
  const { mics, outputs, loadSounds, isHost } = useAudio();
  const [selectedDevice, setSelectedDevice] = useState("none");
  const [bufferTime] = useState(60);
  const [desktopSources, setDesktopSources] = useState<
    { id: string; name: string }[]
  >([]);

  const [isEngineRunning, setIsEngineRunning] = useState(false);
  const originalStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const volumeHistoryRef = useRef<number[]>(new Array(100).fill(0));

  const headerChunkRef = useRef<Blob | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const [workingBlob, setWorkingBlob] = useState<Blob | null>(null);
  const [clipName, setClipName] = useState("");
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [isTranscribing, setIsTranscribing] = useState(false);

  const waveformRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const wsRegionsRef = useRef<any>(null);

  const toggleEngineRef = useRef<() => void>(() => {});
  const markClipRef = useRef<() => void>(() => {});

  // Fetch Desktop Sources on Mount
  useEffect(() => {
    const elApi = (window as any).electronAPI;
    if (isHost && elApi && elApi.getDesktopSources) {
      elApi.getDesktopSources().then(setDesktopSources);
    }
  }, [isHost]);

  useEffect(() => {
    if (workingBlob && waveformRef.current) {
      if (wsRef.current) wsRef.current.destroy();

      wsRef.current = WaveSurfer.create({
        container: waveformRef.current,
        waveColor: "#4f46e5",
        progressColor: "#818cf8",
        cursorColor: "#ffffff",
        barWidth: 2,
        barGap: 1,
        height: 120,
        normalize: true,
      });

      wsRegionsRef.current = wsRef.current.registerPlugin(
        RegionsPlugin.create(),
      );

      const url = URL.createObjectURL(workingBlob);
      wsRef.current.load(url);

      wsRef.current.on("decode", () => {
        const duration = wsRef.current!.getDuration();
        setTrimStart(0);
        setTrimEnd(duration);

        wsRegionsRef.current.addRegion({
          start: 0,
          end: duration,
          color: "rgba(79, 70, 229, 0.3)",
          drag: true,
          resize: true,
        });
      });

      wsRegionsRef.current.on("region-updated", (region: any) => {
        setTrimStart(region.start);
        setTrimEnd(region.end);
      });

      wsRef.current.on("play", () => setIsPlaying(true));
      wsRef.current.on("pause", () => setIsPlaying(false));
      wsRef.current.on("timeupdate", (currentTime) => {
        if (trimEnd > 0 && currentTime >= trimEnd) {
          wsRef.current!.pause();
          wsRef.current!.setTime(trimStart);
        }
      });

      return () => {
        if (wsRef.current) wsRef.current.destroy();
      };
    }
  }, [workingBlob]);

  toggleEngineRef.current = async () => {
    if (isEngineRunning) {
      mediaRecorderRef.current?.stop();
      originalStreamRef.current?.getTracks().forEach((t) => t.stop()); // Ensure video track turns off
      setIsEngineRunning(false);

      if (animationFrameRef.current)
        cancelAnimationFrame(animationFrameRef.current);

      if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
        audioCtxRef.current.close().catch(() => {});
      }

      const canvas = canvasRef.current;
      if (canvas)
        canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    if (selectedDevice === "none") return alert("Select a capture source!");

    try {
      let stream: MediaStream;

      if (selectedDevice.startsWith("desktop:")) {
        const sourceId = selectedDevice.replace("desktop:", "");
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            mandatory: { chromeMediaSource: "desktop" },
          } as any,
          video: {
            mandatory: {
              chromeMediaSource: "desktop",
              chromeMediaSourceId: sourceId,
            },
          } as any,
        });
      } else {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: { exact: selectedDevice },
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
      }

      originalStreamRef.current = stream;

      // Extract ONLY the audio track for processing so we don't encode a massive video file
      const audioTrack = stream.getAudioTracks()[0];
      if (!audioTrack) {
        stream.getTracks().forEach((t) => t.stop());
        return alert(
          "Failed to grab audio track! If capturing a window, make sure it produces sound, or capture the Entire Screen.",
        );
      }
      const audioStream = new MediaStream([audioTrack]);

      const audioCtx = new (
        window.AudioContext || (window as any).webkitAudioContext
      )();
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(audioStream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      const updateLevel = () => {
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const avg = sum / dataArray.length;

        volumeHistoryRef.current.push(avg);
        volumeHistoryRef.current.shift();

        const canvas = canvasRef.current;
        if (canvas) {
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            const barWidth = canvas.width / volumeHistoryRef.current.length;

            volumeHistoryRef.current.forEach((val, index) => {
              const barHeight = (val / 128) * canvas.height;
              ctx.fillStyle = "#4f46e5";
              ctx.fillRect(
                index * barWidth,
                canvas.height - barHeight,
                barWidth - 1,
                barHeight,
              );
            });
          }
        }
        animationFrameRef.current = requestAnimationFrame(updateLevel);
      };
      updateLevel();

      const recorder = new MediaRecorder(audioStream, {
        mimeType: "audio/webm",
      });
      chunksRef.current = [];
      headerChunkRef.current = null;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          if (!headerChunkRef.current) {
            headerChunkRef.current = e.data;
          } else {
            chunksRef.current.push(e.data);
            if (chunksRef.current.length > bufferTime)
              chunksRef.current.shift();
          }
        }
      };

      recorder.start(1000);
      mediaRecorderRef.current = recorder;
      setIsEngineRunning(true);
    } catch (err) {
      console.error(err);
      alert("Capture failed.");
    }
  };

  markClipRef.current = async () => {
    if (!headerChunkRef.current)
      return alert("Engine hasn't captured enough data yet.");
    const webmBlob = new Blob([headerChunkRef.current, ...chunksRef.current], {
      type: "audio/webm",
    });

    try {
      const audioCtx = new (
        window.AudioContext || (window as any).webkitAudioContext
      )();
      const arrayBuffer = await webmBlob.arrayBuffer();
      const decodedData = await audioCtx.decodeAudioData(arrayBuffer);

      const wavBlob = encodeWAV(decodedData);
      if (audioCtx.state !== "closed") await audioCtx.close();

      setWorkingBlob(wavBlob);
      setClipName("New Clip");
      setTranscript("");

      await fetch("http://127.0.0.1:8080/handoff", {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: wavBlob,
      }).catch((e) => console.error("Handoff push failed:", e));
    } catch (err) {
      console.error("Desktop failed to encode WAV for handoff:", err);
      alert("Failed to process audio for remote handoff.");
    }
  };

  useEffect(() => {
    const elApi = (window as any).electronAPI;
    if (isHost && elApi && elApi.onEngineCommand) {
      elApi.onEngineCommand((cmd: string) => {
        if (cmd === "toggle") toggleEngineRef.current();
        if (cmd === "mark") markClipRef.current();
      });
    }
  }, [isHost]);

  const handleToggleClick = async () => {
    if (isHost) {
      await toggleEngineRef.current();
    } else {
      try {
        await fetch(`http://${window.location.hostname}:8080/engine/toggle`);
        setIsEngineRunning(!isEngineRunning);
      } catch (err) {
        alert("Failed to reach desktop client. Ensure JAWdio is running.");
      }
    }
  };

  const handleMarkClick = async () => {
    if (!isEngineRunning && !isHost)
      return alert("Start the remote engine first.");
    if (isHost) {
      markClipRef.current();
    } else {
      try {
        await fetch(`http://${window.location.hostname}:8080/engine/mark`);
        setTimeout(async () => {
          try {
            const res = await fetch(
              `http://${window.location.hostname}:8080/handoff?t=${Date.now()}`,
            );
            if (res.ok) {
              const blob = await res.blob();
              setWorkingBlob(blob);
              setClipName("Remote Clip");
              setTranscript("");
            } else {
              alert("Desktop hasn't created buffer yet.");
            }
          } catch (e) {
            console.error("Failed to grab remote buffer", e);
          }
        }, 1500);
      } catch (err) {
        console.error(err);
      }
    }
  };

  const transcribeClip = async () => {
    if (!workingBlob) return;
    setIsTranscribing(true);
    try {
      const finalWavBlob = await sliceAndExportAudio(
        workingBlob,
        trimStart,
        trimEnd,
      );
      const fd = new FormData();
      fd.append("file", finalWavBlob, "transcribe.wav");

      const res = await fetch("/api/transcribe", { method: "POST", body: fd });
      const data = await res.json();

      if (data.text) setTranscript(data.text);
      else setTranscript("Transcription failed or returned no text.");
    } catch (e) {
      setTranscript("Error connecting to transcription service.");
    }
    setIsTranscribing(false);
  };

  const saveClipDestructive = async () => {
    if (!workingBlob || !clipName) return;
    setIsSaving(true);
    try {
      const finalWavBlob = await sliceAndExportAudio(
        workingBlob,
        trimStart,
        trimEnd,
      );
      const file = new File(
        [finalWavBlob],
        `${clipName.replace(/[^a-z0-9]/gi, "_")}_${Date.now()}.wav`,
        { type: "audio/wav" },
      );

      const fd = new FormData();
      fd.append("file", file);
      // Change from 'Studio Clips' to 'Uncategorized'
      fd.append("category", "Uncategorized");

      await fetch("/api/upload", { method: "POST", body: fd });
      loadSounds();
    } catch (err) {
      console.error(err);
      alert("Failed to render audio. It might be too short or corrupted.");
    }
    setIsSaving(false);
  };

  return (
    <div className="p-8 lg:p-12 max-w-6xl mx-auto h-full flex flex-col pb-24">
      <div className="mb-12">
        <h2 className="text-4xl font-black italic tracking-tighter uppercase">
          Clipper Studio
        </h2>
        <p className="text-white/20 text-[10px] font-black uppercase tracking-[0.2em] mt-1">
          Rolling Buffer & WAV Editor
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 flex-1 min-h-0">
        <div className="lg:col-span-1 space-y-6">
          <div className="bg-[#16161a] p-8 border border-white/5 flex flex-col items-center">
            <select
              className="w-full bg-[#09090b] text-white p-3 border border-white/10 outline-none text-xs font-bold mb-6"
              value={selectedDevice}
              onChange={(e) => setSelectedDevice(e.target.value)}
              disabled={isEngineRunning || !isHost}
            >
              <option value="none">
                {!isHost
                  ? "Managed by Host Desktop..."
                  : "Select Capture Source..."}
              </option>
              {isHost && (
                <>
                  <optgroup label="Screens & Apps">
                    {desktopSources.map((s) => (
                      <option key={s.id} value={`desktop:${s.id}`}>
                        {s.name}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Inputs (Microphones / Virtual Cables)">
                    {mics.map((m) => (
                      <option key={m.deviceId} value={m.deviceId}>
                        {m.label}
                      </option>
                    ))}
                  </optgroup>
                </>
              )}
            </select>

            <div className="w-full h-16 bg-[#09090b] border border-white/5 mb-6 overflow-hidden relative flex items-center justify-center">
              {!isEngineRunning && (
                <span className="absolute text-[8px] font-black uppercase text-white/20 z-10 tracking-widest">
                  ENGINE OFF
                </span>
              )}
              <canvas
                ref={canvasRef}
                width={300}
                height={64}
                className="w-full h-full opacity-80"
              />
            </div>

            <button
              onClick={handleToggleClick}
              className={`w-full py-4 font-black text-[10px] uppercase tracking-widest transition-all mb-4 border ${
                isEngineRunning
                  ? "bg-red-500/10 text-red-500 border-red-500/50 hover:bg-red-500/20"
                  : "bg-emerald-500/10 text-emerald-500 border-emerald-500/50 hover:bg-emerald-500/20"
              }`}
            >
              {isEngineRunning ? "STOP ENGINE" : "START ROLLING BUFFER"}
            </button>

            <button
              onClick={handleMarkClick}
              disabled={!isEngineRunning && isHost}
              className={`w-32 h-32 rounded-full flex flex-col items-center justify-center gap-2 transition-all shadow-2xl ${
                isEngineRunning || !isHost
                  ? "bg-indigo-600 hover:bg-indigo-500 text-white cursor-pointer active:scale-95"
                  : "bg-white/5 text-white/20 cursor-not-allowed"
              }`}
            >
              <Bookmark size={32} />
              <span className="text-[10px] font-black uppercase tracking-widest">
                MARK CLIP
              </span>
            </button>
          </div>
        </div>

        <div className="lg:col-span-2 space-y-6">
          <div className="bg-[#16161a] p-8 border border-white/5 h-full flex flex-col">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <Scissors size={18} className="text-indigo-500" />
                <label className="text-xs font-black uppercase tracking-widest text-white/60">
                  Trim & Render (Drag to Cut)
                </label>
              </div>
            </div>

            {workingBlob ? (
              <div className="flex-1 flex flex-col gap-6 animate-in fade-in duration-300">
                <input
                  type="text"
                  value={clipName}
                  onChange={(e) => setClipName(e.target.value)}
                  className="w-full bg-[#09090b] border border-white/10 p-4 text-white text-xl font-black italic outline-none focus:border-indigo-500"
                  placeholder="Name your clip..."
                />

                <div className="bg-[#09090b] border border-white/10 rounded-xl overflow-hidden relative">
                  <div ref={waveformRef} className="w-full h-32" />
                </div>

                <div className="grid grid-cols-4 gap-4">
                  <div className="col-span-2 bg-[#09090b] border border-white/5 p-3 flex justify-between items-center text-[10px] font-black uppercase text-white/40">
                    <span>Trim Window:</span>
                    <span className="text-indigo-400">
                      {(trimEnd - trimStart).toFixed(2)}s
                    </span>
                  </div>
                  <button
                    onClick={() => wsRef.current?.playPause()}
                    className="col-span-2 bg-indigo-600 hover:bg-indigo-500 py-3 flex items-center justify-center text-white"
                  >
                    {isPlaying ? <Pause size={20} /> : <Play size={20} />}
                  </button>
                </div>

                <div className="bg-[#09090b] border border-white/5 p-4 relative">
                  <button
                    onClick={transcribeClip}
                    disabled={isTranscribing}
                    className="absolute top-4 right-4 bg-white/5 hover:bg-white/10 text-[9px] font-black uppercase tracking-widest px-3 py-1.5 text-white/60 transition-colors flex items-center gap-2"
                  >
                    {isTranscribing ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Type size={12} />
                    )}
                    Transcribe Trim
                  </button>
                  <label className="block text-[10px] font-black uppercase tracking-widest text-white/40 mb-3">
                    Auto-Transcript
                  </label>
                  <p className="text-sm font-bold text-white/70 min-h-[40px] italic">
                    {transcript ||
                      "Click 'Transcribe Trim' to generate text from your current selection..."}
                  </p>
                </div>

                <button
                  onClick={saveClipDestructive}
                  disabled={isSaving}
                  className="w-full mt-auto py-4 bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-600/50 disabled:cursor-not-allowed text-white font-black text-[10px] uppercase tracking-widest transition-all flex items-center justify-center gap-2"
                >
                  {isSaving ? (
                    <>
                      <Loader2 size={16} className="animate-spin" /> Rendering
                      WAV...
                    </>
                  ) : (
                    <>
                      <Save size={16} /> Save to Soundboard
                    </>
                  )}
                </button>
              </div>
            ) : (
              <div className="flex-1 bg-[#09090b] border border-white/5 rounded-xl flex items-center justify-center text-white/20 text-xs font-bold uppercase tracking-widest">
                Start the engine and hit MARK to pull audio here.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

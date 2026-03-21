"use client";
import { useState, useRef, useEffect } from "react";
import { useAudio } from "@/context/AudioContext";
import { Scissors, Key, Mic, Square, Loader2, Save } from "lucide-react";

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
  
  let startOffset = Math.min(Math.floor(sampleRate * start), decodedData.length - 1);
  if (startOffset < 0) startOffset = 0;
  
  let endOffset = Math.min(Math.floor(sampleRate * end), decodedData.length);

  if (endOffset <= startOffset) endOffset = startOffset + sampleRate;
  
  const frameCount = Math.max(1, endOffset - startOffset);
  const offlineCtx = new OfflineAudioContext(channels, frameCount, sampleRate);
  
  const source = offlineCtx.createBufferSource();
  source.buffer = decodedData;
  source.connect(offlineCtx.destination);
  
  source.start(0, startOffset / sampleRate, frameCount / sampleRate);

  const renderedBuffer = await offlineCtx.startRendering();
  if (audioCtx.state !== "closed") await audioCtx.close();
  return encodeWAV(renderedBuffer);
};

interface WordObj {
  word: string;
  start: number;
  end: number;
  id: string;
}

export default function LiveClipperPage() {
  const { mics, isHost, loadSounds } = useAudio();
  const [desktopSources, setDesktopSources] = useState<
    { id: string; name: string }[]
  >([]);
  const [selectedDevice, setSelectedDevice] = useState("none");

  const [apiKey, setApiKey] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [finalWords, setFinalWords] = useState<WordObj[]>([]);
  const [interimWords, setInterimWords] = useState<WordObj[]>([]);

  const [selectionRange, setSelectionRange] = useState<{
    start: number;
    end: number;
    top: number;
    left: number;
  } | null>(null);
  const [clipName, setClipName] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const originalStreamRef = useRef<MediaStream | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const savedKey = localStorage.getItem("deepgram-key");
    const envKey = process.env.NEXT_PUBLIC_DEEPGRAM_API_KEY;

    if (savedKey) {
      setApiKey(savedKey);
    } else if (envKey) {
      setApiKey(envKey);
    }

    const elApi = (window as any).electronAPI;
    if (isHost && elApi && elApi.getDesktopSources) {
      elApi.getDesktopSources().then(setDesktopSources);
    }
  }, [isHost]);

  const saveApiKey = (key: string) => {
    setApiKey(key);
    localStorage.setItem("deepgram-key", key);
  };

  const startListening = async () => {
    if (!apiKey) return alert("Please enter a Deepgram API Key first.");
    if (selectedDevice === "none") return alert("Select a capture source!");

    setFinalWords([]);
    setInterimWords([]);
    chunksRef.current = [];
    setSelectionRange(null);

    try {
      let stream: MediaStream;
      if (selectedDevice.startsWith("desktop:")) {
        const sourceId = selectedDevice.replace("desktop:", "");
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { mandatory: { chromeMediaSource: "desktop" } } as any,
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

      const audioTrack = stream.getAudioTracks()[0];
      if (!audioTrack) throw new Error("No audio track found.");

      const audioStream = new MediaStream([audioTrack]);
      originalStreamRef.current = stream;

      const socket = new WebSocket(
        "wss://api.deepgram.com/v1/listen?model=nova-2&smart_format=true",
        ["token", apiKey],
      );
      socketRef.current = socket;

      socket.onopen = () => {
        const recorder = new MediaRecorder(audioStream, {
          mimeType: "audio/webm",
        });

        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) {
            chunksRef.current.push(e.data);
            if (socket.readyState === 1) {
              socket.send(e.data);
            }
          }
        };

        recorder.start(250);
        mediaRecorderRef.current = recorder;
        setIsListening(true);
      };

      socket.onmessage = (message) => {
        const data = JSON.parse(message.data);
        const transcriptObj = data.channel?.alternatives[0];
        if (!transcriptObj) return;

        const words = transcriptObj.words.map((w: any) => ({
          word: w.punctuated_word || w.word,
          start: w.start,
          end: w.end,
          id: `${w.start}-${w.end}-${Math.random()}`,
        }));

        if (data.is_final) {
          setFinalWords((prev) => [...prev, ...words]);
          setInterimWords([]);
        } else {
          setInterimWords(words);
        }

        if (containerRef.current) {
          containerRef.current.scrollTop = containerRef.current.scrollHeight;
        }
      };
    } catch (err) {
      console.error(err);
      alert("Failed to start listening stream.");
    }
  };

  const stopListening = () => {
    if (mediaRecorderRef.current) mediaRecorderRef.current.stop();
    if (originalStreamRef.current)
      originalStreamRef.current.getTracks().forEach((t) => t.stop());
    if (socketRef.current) socketRef.current.close();
    setIsListening(false);
  };

  const handleSelection = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !containerRef.current) {
      setSelectionRange(null);
      return;
    }

    try {
      const allSpans = Array.from(
        containerRef.current.querySelectorAll("span[data-start]")
      );
      
      const selectedSpans = allSpans.filter((span) =>
        selection.containsNode(span, true)
      );

      if (selectedSpans.length === 0) {
        setSelectionRange(null);
        return;
      }

      const firstSpan = selectedSpans[0];
      const lastSpan = selectedSpans[selectedSpans.length - 1];

      const actualStart = parseFloat(firstSpan.getAttribute("data-start") || "0");
      const actualEnd = parseFloat(lastSpan.getAttribute("data-end") || "0");

      const selectedText = selectedSpans.map(span => span.textContent).join(" ");
      setClipName(selectedText.trim());

      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();

      setSelectionRange({
        start: actualStart - 0.5, 
        end: actualEnd + 0.4,      
        top: rect.top - 70,
        left: rect.left + rect.width / 2 - 128,
      });
    } catch (e) {
      console.error("Selection failed:", e);
      setSelectionRange(null);
    }
  };

  const renderSelectedAudio = async () => {
    if (!selectionRange) return;
    setIsSaving(true);

    try {
      const fullWebmBlob = new Blob(chunksRef.current, { type: "audio/webm" });
      const finalWavBlob = await sliceAndExportAudio(
        fullWebmBlob,
        selectionRange.start,
        selectionRange.end,
      );

      const finalName = clipName.trim() || `LiveClip_${Date.now()}`;
      const file = new File(
        [finalWavBlob],
        `${finalName.replace(/[^a-z0-9]/gi, "_")}.wav`,
        { type: "audio/wav" },
      );

      const fd = new FormData();
      fd.append("file", file);
      fd.append("category", "Uncategorized");

      await fetch("/api/upload", { method: "POST", body: fd });
      loadSounds();
      setSelectionRange(null);
      setClipName("");
      alert("Saved to Soundboard successfully!");
    } catch (err) {
      console.error(err);
      alert(
        "Failed to render the selection. Try selecting a slightly larger area.",
      );
    }

    setIsSaving(false);
  };

  return (
    <div className="p-8 lg:p-12 max-w-6xl mx-auto pb-24 h-screen flex flex-col">
      <div className="mb-8">
        <h2 className="text-4xl font-black italic tracking-tighter uppercase">
          Live Text Clipper
        </h2>
        <p className="text-white/20 text-[10px] font-black uppercase tracking-[0.2em] mt-1">
          Real-time STT & Text-based Editing
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 flex-1 min-h-0">
        <div className="lg:col-span-1 space-y-6 flex flex-col">
          <div className="bg-[#16161a] p-6 border border-white/5">
            {!process.env.NEXT_PUBLIC_DEEPGRAM_API_KEY && (
              <>
                <label className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-white/40 mb-3">
                  <Key size={14} /> Deepgram API Key
                </label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => saveApiKey(e.target.value)}
                  placeholder="Enter Deepgram Key..."
                  className="w-full bg-[#09090b] border border-white/10 p-3 text-white text-xs outline-none focus:border-brand-500 mb-6"
                />
              </>
            )}

            <label className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-white/40 mb-3">
              <Mic size={14} /> Target Source
            </label>
            <select
              className="w-full bg-[#09090b] text-white p-3 border border-white/10 outline-none focus:border-brand-500 text-xs font-bold mb-6"
              value={selectedDevice}
              onChange={(e) => setSelectedDevice(e.target.value)}
              disabled={isListening || !isHost}
            >
              <option value="none">Select Capture Source...</option>
              {isHost && (
                <>
                  <optgroup label="Screens & Apps">
                    {desktopSources.map((s) => (
                      <option key={s.id} value={`desktop:${s.id}`}>
                        {s.name}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Microphones">
                    {mics.map((m) => (
                      <option key={m.deviceId} value={m.deviceId}>
                        {m.label}
                      </option>
                    ))}
                  </optgroup>
                </>
              )}
            </select>

            <button
              onClick={isListening ? stopListening : startListening}
              className={`w-full py-4 font-black text-[10px] uppercase tracking-widest transition-all flex items-center justify-center gap-2 border ${
                isListening
                  ? "bg-red-500/10 text-red-500 border-red-500/50 hover:bg-red-500/20"
                  : "bg-brand-500/10 text-brand-500 border-brand-500/50 hover:bg-brand-500/20"
              }`}
            >
              {isListening ? (
                <>
                  <Square size={14} /> Stop Listening
                </>
              ) : (
                <>
                  <Mic size={14} /> Start Listening
                </>
              )}
            </button>
          </div>
        </div>

        <div className="lg:col-span-3 bg-[#16161a] border border-white/5 relative flex flex-col h-full min-h-0">
          <div className="p-4 border-b border-white/5 bg-[#0f0f13] flex justify-between items-center">
            <span className="text-[10px] font-black uppercase tracking-widest text-white/40">
              {isListening ? (
                <span className="text-brand-500 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-brand-500 animate-pulse" />{" "}
                  Live Transcript
                </span>
              ) : (
                "Offline"
              )}
            </span>
            <span className="text-[10px] font-black uppercase tracking-widest text-white/40">
              Highlight text to extract audio
            </span>
          </div>

          <div
            ref={containerRef}
            onMouseUp={handleSelection}
            className="flex-1 p-8 overflow-y-auto select-text font-medium text-2xl leading-relaxed text-white/80 selection:bg-brand-500/40 selection:text-white">
            {finalWords.length === 0 &&
              interimWords.length === 0 &&
              !isListening && (
                <div className="h-full flex items-center justify-center text-white/10 font-bold italic text-xl">
                  Start the engine to see live text...
                </div>
              )}

            {finalWords.map((w) => (
              <span
                key={w.id}
                data-start={w.start}
                data-end={w.end}
                className="mr-1.5 hover:bg-white/5 transition-colors cursor-text"
              >
                {w.word}
              </span>
            ))}

            {interimWords.map((w) => (
              <span
                key={w.id}
                data-start={w.start}
                data-end={w.end}
                className="mr-1.5 text-white/40"
              >
                {w.word}
              </span>
            ))}
          </div>

          {selectionRange && (
            <div
              className="fixed z-50 bg-[#09090b] border border-white/20 p-3 shadow-2xl animate-in zoom-in-95 duration-100 flex flex-col gap-3 w-64"
              style={{ top: selectionRange.top, left: selectionRange.left }}
            >
              <input
                type="text"
                value={clipName}
                onChange={(e) => setClipName(e.target.value)}
                placeholder="Name your clip..."
                autoFocus
                className="w-full bg-[#16161a] border border-white/10 p-2 text-white text-xs outline-none focus:border-brand-500"
              />
              <button
                onClick={renderSelectedAudio}
                disabled={isSaving}
                className="w-full py-2 bg-brand-600 hover:bg-brand-500 text-white text-[10px] font-black uppercase tracking-widest flex items-center justify-center gap-2"
              >
                {isSaving ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Save size={14} />
                )}
                {isSaving ? "Rendering..." : "Save to Board"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
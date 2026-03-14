'use client';
import { useState, useRef, useEffect } from 'react';
import { useAudio } from '@/context/AudioContext';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js';
import { Bookmark, Scissors, Save, Play, Pause, Loader2, Type } from 'lucide-react';
import AudioLibrary from '@/components/AudioLibrary';

// --- STUDIO-GRADE AUDIO ENCODER ---
const encodeWAV = (audioBuffer: AudioBuffer) => {
  const numOfChan = audioBuffer.numberOfChannels;
  const length = audioBuffer.length * numOfChan * 2 + 44;
  const buffer = new ArrayBuffer(length);
  const view = new DataView(buffer);
  const channels = [];
  let offset = 0; let pos = 0;

  const setUint16 = (data: number) => { view.setUint16(offset, data, true); offset += 2; };
  const setUint32 = (data: number) => { view.setUint32(offset, data, true); offset += 4; };

  setUint32(0x46464952); setUint32(length - 8); setUint32(0x45564157); setUint32(0x20746d66);
  setUint32(16); setUint16(1); setUint16(numOfChan); setUint32(audioBuffer.sampleRate);
  setUint32(audioBuffer.sampleRate * 2 * numOfChan); setUint16(numOfChan * 2); setUint16(16);
  setUint32(0x61746164); setUint32(length - pos - 4);

  for (let i = 0; i < audioBuffer.numberOfChannels; i++) channels.push(audioBuffer.getChannelData(i));

  while (pos < audioBuffer.length) {
    for (let i = 0; i < numOfChan; i++) {
      let sample = Math.max(-1, Math.min(1, channels[i][pos]));
      sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0;
      view.setInt16(offset, sample, true); offset += 2;
    }
    pos++;
  }
  return new Blob([buffer], { type: 'audio/wav' });
};

const sliceAndExportAudio = async (blob: Blob, start: number, end: number) => {
  const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
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
  audioCtx.close();
  return encodeWAV(renderedBuffer);
};


export default function StudioPage() {
  const { mics, outputs, loadSounds } = useAudio();
  const [selectedDevice, setSelectedDevice] = useState('none');
  const [bufferTime] = useState(60); 
  
  const [isEngineRunning, setIsEngineRunning] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  
  // Audio Visualizer Refs (Live Scrolling Radar)
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

  // Initialize WaveSurfer with Draggable Regions
  useEffect(() => {
    if (workingBlob && waveformRef.current) {
      if (wsRef.current) wsRef.current.destroy();

      wsRef.current = WaveSurfer.create({
        container: waveformRef.current, waveColor: '#4f46e5', progressColor: '#818cf8',
        cursorColor: '#ffffff', barWidth: 2, barGap: 1, height: 120, normalize: true,
      });

      // Register the Draggable Regions Plugin
      wsRegionsRef.current = wsRef.current.registerPlugin(RegionsPlugin.create());

      const url = URL.createObjectURL(workingBlob);
      wsRef.current.load(url);

      wsRef.current.on('decode', () => {
        const duration = wsRef.current!.getDuration();
        setTrimStart(0);
        setTrimEnd(duration);
        
        // Add the draggable overlay
        wsRegionsRef.current.addRegion({
          start: 0,
          end: duration,
          color: 'rgba(79, 70, 229, 0.3)',
          drag: true, resize: true,
        });
      });

      // Listen for when the user drags the edges!
      wsRegionsRef.current.on('region-updated', (region: any) => {
        setTrimStart(region.start);
        setTrimEnd(region.end);
      });

      wsRef.current.on('play', () => setIsPlaying(true));
      wsRef.current.on('pause', () => setIsPlaying(false));
      wsRef.current.on('timeupdate', (currentTime) => {
        if (trimEnd > 0 && currentTime >= trimEnd) {
          wsRef.current!.pause();
          wsRef.current!.setTime(trimStart);
        }
      });

      return () => { if (wsRef.current) wsRef.current.destroy(); };
    }
  }, [workingBlob]);

  const toggleEngine = async () => {
    if (isEngineRunning) {
      mediaRecorderRef.current?.stop();
      mediaRecorderRef.current?.stream.getTracks().forEach(t => t.stop());
      setIsEngineRunning(false);
      
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      if (audioCtxRef.current) audioCtxRef.current.close();
      
      // Clear the canvas
      const canvas = canvasRef.current;
      if (canvas) canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    if (selectedDevice === 'none') return alert("Select a Virtual Audio Cable Input to capture desktop audio!");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: selectedDevice }, echoCancellation: false, noiseSuppression: false }
      });
      
      // --- LIVE SCROLLING RADAR CANVAS ---
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      const updateLevel = () => {
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const avg = sum / dataArray.length;
        
        // Push new volume, shift old volume to create a scrolling effect
        volumeHistoryRef.current.push(avg);
        volumeHistoryRef.current.shift();

        const canvas = canvasRef.current;
        if (canvas) {
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            const barWidth = canvas.width / volumeHistoryRef.current.length;
            
            volumeHistoryRef.current.forEach((val, index) => {
              const barHeight = (val / 128) * canvas.height;
              ctx.fillStyle = '#4f46e5'; // Indigo color
              ctx.fillRect(index * barWidth, canvas.height - barHeight, barWidth - 1, barHeight);
            });
          }
        }
        animationFrameRef.current = requestAnimationFrame(updateLevel);
      };
      updateLevel();
      // -----------------------------------

      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      chunksRef.current = [];
      headerChunkRef.current = null;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          if (!headerChunkRef.current) {
            headerChunkRef.current = e.data; 
          } else {
            chunksRef.current.push(e.data);
            if (chunksRef.current.length > bufferTime) chunksRef.current.shift(); 
          }
        }
      };

      recorder.start(1000);
      mediaRecorderRef.current = recorder;
      setIsEngineRunning(true);
    } catch (err) {
      console.error(err);
      alert("Failed to hook into audio. Remember to select a Virtual Cable!");
    }
  };

  const markClip = () => {
    if (!headerChunkRef.current) return alert("Engine hasn't captured enough data yet.");
    const blob = new Blob([headerChunkRef.current, ...chunksRef.current], { type: 'audio/webm' });
    setWorkingBlob(blob);
    setClipName("New Clip");
    setTranscript("");
  };

  const transcribeClip = async () => {
    if (!workingBlob) return;
    setIsTranscribing(true);
    try {
      const finalWavBlob = await sliceAndExportAudio(workingBlob, trimStart, trimEnd);
      const fd = new FormData();
      fd.append('file', finalWavBlob, 'transcribe.wav');

      const res = await fetch('/api/transcribe', { method: 'POST', body: fd });
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
      const finalWavBlob = await sliceAndExportAudio(workingBlob, trimStart, trimEnd);
      const file = new File([finalWavBlob], `${clipName.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}.wav`, { type: 'audio/wav' });
      
      const fd = new FormData();
      fd.append('file', file);
      fd.append('category', 'Studio Clips'); 

      await fetch('/api/upload', { method: 'POST', body: fd });
      setWorkingBlob(null);
      loadSounds(); 
    } catch (err) {
      console.error(err);
      alert("Failed to render audio. It might be too short or corrupted.");
    }
    setIsSaving(false);
  };

  return (
    <div className="p-8 lg:p-12 max-w-6xl mx-auto pb-24">
      <div className="mb-12">
        <h2 className="text-4xl font-black italic tracking-tighter uppercase">Clipper Studio</h2>
        <p className="text-white/20 text-[10px] font-black uppercase tracking-[0.2em] mt-1">Rolling Buffer & WAV Editor</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* ENGINE */}
        <div className="lg:col-span-1 space-y-6">
          <div className="bg-[#16161a] p-8 border border-white/5 flex flex-col items-center">
            
            <select 
              className="w-full bg-[#09090b] text-white p-3 border border-white/10 outline-none text-xs font-bold mb-6"
              value={selectedDevice} onChange={(e) => setSelectedDevice(e.target.value)} disabled={isEngineRunning}
            >
              <option value="none">Select Capture Source...</option>
              <optgroup label="Inputs (Microphones / Virtual Cables)">
                {mics.map(m => <option key={m.deviceId} value={m.deviceId}>{m.label}</option>)}
              </optgroup>
              <optgroup label="Outputs (Usually blocked by browser!)">
                {outputs.map(o => <option key={o.deviceId} value={o.deviceId}>{o.label}</option>)}
              </optgroup>
            </select>

            {/* LIVE SCROLLING RADAR CANVAS */}
            <div className="w-full h-16 bg-[#09090b] border border-white/5 mb-6 overflow-hidden relative flex items-center justify-center">
              {!isEngineRunning && <span className="absolute text-[8px] font-black uppercase text-white/20 z-10 tracking-widest">ENGINE OFF</span>}
              <canvas ref={canvasRef} width={300} height={64} className="w-full h-full opacity-80" />
            </div>

            <button 
              onClick={toggleEngine}
              className={`w-full py-4 font-black text-[10px] uppercase tracking-widest transition-all mb-4 border ${
                isEngineRunning ? 'bg-red-500/10 text-red-500 border-red-500/50 hover:bg-red-500/20' : 'bg-emerald-500/10 text-emerald-500 border-emerald-500/50 hover:bg-emerald-500/20'
              }`}
            >
              {isEngineRunning ? 'STOP ENGINE' : 'START ROLLING BUFFER'}
            </button>

            <button 
              onClick={markClip} disabled={!isEngineRunning}
              className={`w-32 h-32 rounded-full flex flex-col items-center justify-center gap-2 transition-all shadow-2xl ${
                isEngineRunning ? 'bg-indigo-600 hover:bg-indigo-500 text-white cursor-pointer active:scale-95' : 'bg-white/5 text-white/20 cursor-not-allowed'
              }`}
            >
              <Bookmark size={32} />
              <span className="text-[10px] font-black uppercase tracking-widest">MARK CLIP</span>
            </button>
          </div>
        </div>

        {/* EDITOR */}
        <div className="lg:col-span-2 space-y-6">
          <div className="bg-[#16161a] p-8 border border-white/5 h-full flex flex-col">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <Scissors size={18} className="text-indigo-500" />
                <label className="text-xs font-black uppercase tracking-widest text-white/60">Trim & Render (Drag to Cut)</label>
              </div>
            </div>

            {workingBlob ? (
              <div className="flex-1 flex flex-col gap-6 animate-in fade-in duration-300">
                <input 
                  type="text" value={clipName} onChange={(e) => setClipName(e.target.value)}
                  className="w-full bg-[#09090b] border border-white/10 p-4 text-white text-xl font-black italic outline-none focus:border-indigo-500"
                  placeholder="Name your clip..."
                />
                
                <div className="bg-[#09090b] border border-white/10 rounded-xl overflow-hidden relative">
                  {/* WaveSurfer will draw the waveform AND the draggable region overlay here */}
                  <div ref={waveformRef} className="w-full h-32" />
                </div>

                <div className="grid grid-cols-4 gap-4">
                  <div className="col-span-2 bg-[#09090b] border border-white/5 p-3 flex justify-between items-center text-[10px] font-black uppercase text-white/40">
                    <span>Trim Window:</span>
                    <span className="text-indigo-400">{(trimEnd - trimStart).toFixed(2)}s</span>
                  </div>
                  <button onClick={() => wsRef.current?.playPause()} className="col-span-2 bg-indigo-600 hover:bg-indigo-500 py-3 flex items-center justify-center text-white">
                    {isPlaying ? <Pause size={20} /> : <Play size={20} />}
                  </button>
                </div>

                {/* Transcription Box */}
                <div className="bg-[#09090b] border border-white/5 p-4 relative">
                  <button 
                    onClick={transcribeClip} disabled={isTranscribing}
                    className="absolute top-4 right-4 bg-white/5 hover:bg-white/10 text-[9px] font-black uppercase tracking-widest px-3 py-1.5 text-white/60 transition-colors flex items-center gap-2"
                  >
                    {isTranscribing ? <Loader2 size={12} className="animate-spin" /> : <Type size={12} />} 
                    Transcribe Trim
                  </button>
                  <label className="block text-[10px] font-black uppercase tracking-widest text-white/40 mb-3">Auto-Transcript</label>
                  <p className="text-sm font-bold text-white/70 min-h-[40px] italic">
                    {transcript || "Click 'Transcribe Trim' to generate text from your current selection..."}
                  </p>
                </div>

                <button onClick={saveClipDestructive} disabled={isSaving} className="w-full mt-auto py-4 bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-600/50 disabled:cursor-not-allowed text-white font-black text-[10px] uppercase tracking-widest transition-all flex items-center justify-center gap-2">
                  {isSaving ? <><Loader2 size={16} className="animate-spin" /> Rendering WAV...</> : <><Save size={16} /> Save to Studio Clips</>}
                </button>
              </div>
            ) : (
              <div className="flex-1 bg-[#09090b] border border-white/5 rounded-xl flex items-center justify-center text-white/20 text-xs font-bold uppercase tracking-widest">
                Start the engine and hit MARK to pull audio here.
              </div>
            )}
          </div>
        </div>

        <div className="lg:col-span-3 bg-[#16161a] p-8 border border-white/5 mt-6">
            <AudioLibrary filterMode="studio" />
        </div>
      </div>
    </div>
  );
}
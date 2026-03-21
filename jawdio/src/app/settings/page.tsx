'use client';
import { useAudio } from '@/context/AudioContext';
import { Mic, Music, Speaker, Headphones } from 'lucide-react';

export default function SettingsPage() {
  const { 
    mics, handleMicChange, activeMicId, 
    micVolume, setMicVolume, 
    soundVolume, setSoundVolume, 
    cableName, hearOwnSounds, setHearOwnSounds
  } = useAudio();

  return (
    <div className="p-8 lg:p-12 max-w-4xl mx-auto pb-24">
      <div className="mb-12">
        <h2 className="text-4xl font-black italic tracking-tighter">MIXER</h2>
        <p className="text-white/20 text-[10px] font-black uppercase tracking-[0.2em] mt-1">Audio I/O Configuration</p>
      </div>
      
      <div className="space-y-6">
        <div className="bg-[#16161a] p-8 border border-white/5">
          <div className="flex items-center gap-3 mb-6">
            <Mic size={18} className="text-brand-500" />
            <label className="text-xs font-black uppercase tracking-widest text-white/60">Input Device</label>
          </div>
          <select 
            onChange={(e) => handleMicChange(e.target.value)}
            value={activeMicId}
            className="w-full bg-[#09090b] text-white p-4 border border-white/10 focus:border-brand-500 outline-none transition-all font-bold"
          >
            <option value="none">Device: Off</option>
            {mics.map((mic) => (
              <option key={mic.deviceId} value={mic.deviceId}>
                {mic.label || `Microphone (${mic.deviceId.substring(0, 5)})`}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-[#16161a] p-8 border border-white/5">
            <div className="flex justify-between items-center mb-6">
              <div className="flex items-center gap-3">
                <Mic size={18} className="text-brand-500" />
                <label className="text-xs font-black uppercase tracking-widest text-white/60">Mic Level</label>
              </div>
              <span className="text-[10px] font-black text-brand-400">{Math.round(micVolume * 100)}%</span>
            </div>
            <input 
              type="range" min="0" max="1" step="0.01" 
              value={micVolume} 
              onChange={(e) => setMicVolume(parseFloat(e.target.value))} 
              className="w-full h-1.5 bg-[#09090b] appearance-none cursor-pointer accent-brand-500" 
            />
          </div>

          <div className="bg-[#16161a] p-8 border border-white/5">
            <div className="flex justify-between items-center mb-6">
              <div className="flex items-center gap-3">
                <Music size={18} className="text-brand-500" />
                <label className="text-xs font-black uppercase tracking-widest text-white/60">Deck Level</label>
              </div>
              <span className="text-[10px] font-black text-brand-400">{Math.round(soundVolume * 100)}%</span>
            </div>
            <input 
              type="range" min="0" max="1" step="0.01" 
              value={soundVolume} 
              onChange={(e) => setSoundVolume(parseFloat(e.target.value))} 
              className="w-full h-1.5 bg-[#09090b] appearance-none cursor-pointer accent-brand-500" 
            />
          </div>
        </div>

        <div className="bg-[#16161a] p-8 border border-white/5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 pr-4">
              <Headphones size={18} className="text-brand-500" />
              <div>
                <label className="text-xs font-black uppercase tracking-widest text-white/60 block">Hear My Own Sounds</label>
                <span className="text-[10px] font-bold text-white/40 block mt-1">
                  Play soundboard audio through your local speakers while simultaneously broadcasting it to the Virtual Cable.
                </span>
              </div>
            </div>
            <button 
              onClick={() => setHearOwnSounds(!hearOwnSounds)}
              className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${hearOwnSounds ? 'bg-brand-500' : 'bg-[#09090b] border border-white/10'}`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${hearOwnSounds ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>
        </div>

        <div className="bg-brand-500/5 p-8 border border-brand-500/10">
          <div className="flex items-center gap-3 mb-2">
            <Speaker size={18} className="text-brand-400" />
            <p className="text-[10px] font-black uppercase tracking-widest text-brand-400/60">Output Destination</p>
          </div>
          <p className="text-xl font-black italic text-brand-400">{cableName}</p>
        </div>
      </div>
    </div>
  );
}
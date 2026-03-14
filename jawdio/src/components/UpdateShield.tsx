'use client';
import { useAudio } from '@/context/AudioContext';
import { JAWDIO_VERSION, GITHUB_REPO } from '@/lib/version'; // Import them here too!
import { Download } from 'lucide-react';

export default function UpdateShield() {
  const { hasUpdate, latestVersion } = useAudio();

  if (!hasUpdate) return null;

  return (
    <div className="bg-indigo-600 p-3 flex items-center justify-between px-8 animate-in slide-in-from-top duration-500">
      <div className="flex items-center gap-3">
        <span className="bg-white/20 text-white text-[10px] font-black px-2 py-0.5 rounded-full uppercase tracking-tighter">New Update</span>
        <p className="text-sm font-bold text-white">
          v{latestVersion} is available. (You are on v{JAWDIO_VERSION})
        </p>
      </div>
      <a 
        href={`https://github.com/${GITHUB_REPO}/releases`} 
        target="_blank"
        className="flex items-center gap-2 bg-white text-indigo-600 px-4 py-1.5 rounded-full font-black text-xs hover:bg-zinc-100 transition-all active:scale-95"
      >
        <Download size={14} /> GET UPDATE
      </a>
    </div>
  );
}
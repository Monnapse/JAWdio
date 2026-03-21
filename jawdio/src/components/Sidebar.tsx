'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAudio } from '@/context/AudioContext';
import { LayoutGrid, Settings2, Square, MicVocal, Type } from 'lucide-react';
import { useState, useRef, useEffect, useCallback } from 'react';

export default function Sidebar({ isOpen, toggle }: { isOpen: boolean, toggle: () => void }) {
  const pathname = usePathname();
  const { isHost, handleStopClick } = useAudio();
  
  const [width, setWidth] = useState(288);
  const isDragging = useRef(false);

  const startResizing = useCallback(() => {
    isDragging.current = true;
    document.body.style.cursor = 'col-resize';
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      let newWidth = e.clientX;
      if (newWidth < 220) newWidth = 220;
      if (newWidth > 500) newWidth = 500;
      setWidth(newWidth);
    };
    const handleMouseUp = () => {
      if (isDragging.current) {
        isDragging.current = false;
        document.body.style.cursor = 'default';
      }
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  return (
    <aside 
      className={`fixed inset-y-0 left-0 z-50 bg-[#0a0a0c]/95 backdrop-blur-2xl border-r border-white/5 transform transition-transform duration-300 lg:relative lg:translate-x-0 flex flex-shrink-0 shadow-2xl ${isOpen ? 'translate-x-0' : '-translate-x-full'}`}
      style={{ width: `${width}px` }}
    >
      <div className="flex flex-col h-full w-full overflow-hidden relative">
        <div className="p-8 flex flex-col items-start gap-3">
          <img 
            src="/jawdio.svg" 
            alt="JAWdio Logo" 
            className="w-[140px] h-auto object-contain drop-shadow-lg"
          />
          <p className="text-[9px] uppercase tracking-[0.3em] text-white/30 font-black ml-1">v1.0.4 // Production</p>
        </div>

        <nav className="flex-1 px-4 space-y-1">
          <Link href="/" onClick={() => {if(window.innerWidth < 1024) toggle()}} className={`flex items-center gap-4 px-5 py-3.5 rounded-xl font-bold transition-all duration-200 ${pathname === '/' ? 'bg-brand-500/10 text-brand-400 border border-brand-500/20' : 'text-white/40 hover:bg-white/5 hover:text-white border border-transparent'}`}>
            <LayoutGrid size={18} /> Dashboard
          </Link>
          
          <Link href="/studio" onClick={() => {if(window.innerWidth < 1024) toggle()}} className={`flex items-center gap-4 px-5 py-3.5 rounded-xl font-bold transition-all duration-200 ${pathname === '/studio' ? 'bg-brand-500/10 text-brand-400 border border-brand-500/20' : 'text-white/40 hover:bg-white/5 hover:text-white border border-transparent'}`}>
            <MicVocal size={18} /> Clipper Studio
          </Link>

          <Link href="/live" onClick={() => {if(window.innerWidth < 1024) toggle()}} className={`flex items-center gap-4 px-5 py-3.5 rounded-xl font-bold transition-all duration-200 ${pathname === '/live' ? 'bg-brand-500/10 text-brand-400 border border-brand-500/20' : 'text-white/40 hover:bg-white/5 hover:text-white border border-transparent'}`}>
            <Type size={18} /> Live Text Clipper
          </Link>

          {isHost && (
            <Link href="/settings" onClick={() => {if(window.innerWidth < 1024) toggle()}} className={`flex items-center gap-4 px-5 py-3.5 rounded-xl font-bold transition-all duration-200 ${pathname === '/settings' ? 'bg-brand-500/10 text-brand-400 border border-brand-500/20' : 'text-white/40 hover:bg-white/5 hover:text-white border border-transparent'}`}>
              <Settings2 size={18} /> Settings
            </Link>
          )}
        </nav>

        <div className="p-6 border-t border-white/5 bg-[#070709]">
          <button onClick={handleStopClick} className="w-full py-4 rounded-xl bg-[#121216] hover:bg-red-500/10 text-white/40 hover:text-red-500 transition-all duration-200 font-black border border-white/5 hover:border-red-500/20 flex items-center justify-center gap-3 text-[11px] tracking-widest shadow-lg">
            <Square size={14} fill="currentColor" /> STOP ALL SOUNDS
          </button>
        </div>
      </div>
      
      <div 
        onMouseDown={startResizing}
        className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-brand-500/50 transition-colors z-[100]"
      />
    </aside>
  );
}
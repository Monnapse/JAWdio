'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAudio } from '@/context/AudioContext';
import { LayoutGrid, Settings2, Square, MicVocal, Type } from 'lucide-react';
import { useState, useRef, useEffect, useCallback } from 'react';

export default function Sidebar({ isOpen, toggle }: { isOpen: boolean, toggle: () => void }) {
  const pathname = usePathname();
  const { isHost, handleStopClick } = useAudio();
  
  // Resizer state (288px is the equivalent of w-72)
  const [width, setWidth] = useState(288);
  const isDragging = useRef(false);

  const startResizing = useCallback(() => {
    isDragging.current = true;
    document.body.style.cursor = 'col-resize';
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      // Mouse X from the left edge determines the width
      let newWidth = e.clientX;
      if (newWidth < 200) newWidth = 200; // Minimum width
      if (newWidth > 600) newWidth = 600; // Maximum width
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
      className={`fixed inset-y-0 left-0 z-50 bg-[#0f0f13] border-r border-white/5 transform transition-transform duration-300 lg:relative lg:translate-x-0 flex flex-shrink-0 ${isOpen ? 'translate-x-0' : '-translate-x-full'}`}
      style={{ width: `${width}px` }}
    >
      <div className="flex flex-col h-full w-full overflow-hidden relative">
        <div className="p-8">
          <h1 className="text-3xl font-black italic text-white tracking-tighter">JAW<span className="text-indigo-500">dio</span></h1>
          <p className="text-[9px] uppercase tracking-[0.3em] text-white/20 font-black mt-2">v1.0.4 // Production</p>
        </div>

        <nav className="flex-1 px-4 space-y-2">
          <Link href="/" onClick={() => {if(window.innerWidth < 1024) toggle()}} className={`flex items-center gap-4 px-5 py-4 rounded-2xl font-bold transition-all ${pathname === '/' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20' : 'text-white/30 hover:bg-white/5 hover:text-white'}`}>
            <LayoutGrid size={20} /> Dashboard
          </Link>
          
          <Link href="/studio" onClick={() => {if(window.innerWidth < 1024) toggle()}} className={`flex items-center gap-4 px-5 py-4 rounded-2xl font-bold transition-all ${pathname === '/studio' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20' : 'text-white/30 hover:bg-white/5 hover:text-white'}`}>
            <MicVocal size={20} /> Clipper Studio
          </Link>

          <Link href="/live" className="flex items-center gap-4 px-4 py-3 text-emerald-500/60 hover:text-emerald-400 hover:bg-emerald-500/5 rounded-xl transition-all group">
            <Type size={18} className="group-hover:text-emerald-400" />
            <span className="text-xs font-black tracking-widest uppercase">Live Text Clipper</span>
          </Link>

          {isHost && (
            <Link href="/settings" onClick={() => {if(window.innerWidth < 1024) toggle()}} className={`flex items-center gap-4 px-5 py-4 rounded-2xl font-bold transition-all ${pathname === '/settings' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20' : 'text-white/30 hover:bg-white/5 hover:text-white'}`}>
              <Settings2 size={20} /> Settings
            </Link>
          )}
        </nav>

        <div className="p-6">
          <button onClick={handleStopClick} className="w-full py-4 rounded-2xl bg-white/5 hover:bg-red-500/10 text-white/40 hover:text-red-500 transition-all font-bold border border-white/5 flex items-center justify-center gap-3 text-xs tracking-widest">
            <Square size={14} fill="currentColor" /> STOP ALL
          </button>
        </div>
      </div>
      
      {/* Sidebar Resize Handle */}
      <div 
        onMouseDown={startResizing}
        className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-indigo-500 transition-colors z-[100]"
      />
    </aside>
  );
}
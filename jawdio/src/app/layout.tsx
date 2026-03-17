'use client';
import './globals.css';
import { useState, useRef, useEffect, useCallback } from 'react';
import { usePathname } from 'next/navigation';
import { AudioProvider } from '@/context/AudioContext';
import Sidebar from '@/components/Sidebar';
import { X, Minus, Square, Copy, Menu, LayoutGrid } from 'lucide-react';
import UpdateShield from '@/components/UpdateShield';
import AudioLibrary from '@/components/AudioLibrary';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const pathname = usePathname();

  // Resizer state for the Right Pane Soundboard
  const [rightWidth, setRightWidth] = useState(450);
  const isDraggingRight = useRef(false);

  const startResizingRight = useCallback(() => {
    isDraggingRight.current = true;
    document.body.style.cursor = 'col-resize';
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRight.current) return;
      // Screen width minus Mouse X gives us distance from the right edge
      let newWidth = window.innerWidth - e.clientX;
      if (newWidth < 300) newWidth = 300; // Minimum width
      if (newWidth > 800) newWidth = 800; // Maximum width
      setRightWidth(newWidth);
    };
    const handleMouseUp = () => {
      if (isDraggingRight.current) {
        isDraggingRight.current = false;
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

  const handleAction = (action: 'close' | 'minimize' | 'maximize') => {
    if (window.electronAPI && typeof window.electronAPI.sendWindowAction === 'function') {
      window.electronAPI.sendWindowAction(action);
      if (action === 'maximize') setIsMaximized(!isMaximized);
    }
  };

  const showLibraryPane = pathname !== '/settings';

  return (
    <html lang="en">
      <body className="antialiased select-none">
        <AudioProvider>
          <div className="jawdio-layout">
            <Sidebar isOpen={isSidebarOpen} toggle={() => setIsSidebarOpen(!isSidebarOpen)} />
            
            <div className="content-area flex flex-col min-w-0">
              {/* Square Header */}
              <header 
                className="h-12 flex items-center justify-between px-6 bg-[#0f0f13] border-b border-white/5 shrink-0" 
                style={{ WebkitAppRegion: 'drag' } as any}
              >
                <div className="flex items-center gap-4">
                  <button 
                    onClick={() => setIsSidebarOpen(!isSidebarOpen)} 
                    className="lg:hidden p-1 text-white/30 hover:text-white"
                    style={{ WebkitAppRegion: 'no-drag' } as any}
                  >
                    <Menu size={18} />
                  </button>
                  <span className="text-[9px] font-black italic tracking-[0.3em] text-white/20">JAWDIO // CORE_ENGINE</span>
                </div>
                
                <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as any}>
                  <button onClick={() => handleAction('minimize')} className="p-2 hover:bg-white/5 text-white/20 hover:text-white transition-colors">
                    <Minus size={14}/>
                  </button>
                  <button onClick={() => handleAction('maximize')} className="p-2 hover:bg-white/5 text-white/20 hover:text-white transition-colors">
                    {isMaximized ? <Copy size={12}/> : <Square size={12}/>}
                  </button>
                  <button onClick={() => handleAction('close')} className="p-2 hover:bg-red-500/10 text-white/20 hover:text-red-500 transition-colors">
                    <X size={14}/>
                  </button>
                </div>
              </header>

              <UpdateShield />

              {/* SPLIT SCREEN MAIN AREA */}
              <main className="flex-1 flex overflow-hidden">
                
                {/* LEFT PANE: Dynamic Content (Clippers, Dashboard) */}
                <div className="flex-1 overflow-y-auto relative bg-[#09090b] min-w-0">
                  {children}
                </div>

                {/* RIGHT PANE: Persistent Audio Library */}
                {showLibraryPane && (
                  <div 
                    className="bg-[#0b0b0e] border-l border-white/5 flex flex-col overflow-hidden shadow-2xl z-10 shrink-0 relative"
                    style={{ width: `${rightWidth}px` }}
                  >
                    {/* Right Pane Resize Handle */}
                    <div 
                      onMouseDown={startResizingRight}
                      className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-indigo-500 transition-colors z-[100]"
                    />

                    <div className="p-4 border-b border-white/5 bg-[#0f0f13] flex items-center gap-3 shrink-0">
                      <LayoutGrid size={16} className="text-indigo-500" />
                      <span className="text-[10px] font-black uppercase tracking-widest text-white/40">
                        Global Soundboard
                      </span>
                    </div>
                    <div className="flex-1 overflow-y-auto p-6 relative">
                      <AudioLibrary />
                    </div>
                  </div>
                )}
                
              </main>
            </div>
          </div>
        </AudioProvider>
      </body>
    </html>
  );
}
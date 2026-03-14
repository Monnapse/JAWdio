'use client';
import './globals.css';
import { useState } from 'react';
import { AudioProvider } from '@/context/AudioContext';
import Sidebar from '@/components/Sidebar';
import { X, Minus, Square, Copy, Menu } from 'lucide-react';
import UpdateShield from '@/components/UpdateShield';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);

  const handleAction = (action: 'close' | 'minimize' | 'maximize') => {
    if (window.electronAPI && typeof window.electronAPI.sendWindowAction === 'function') {
      window.electronAPI.sendWindowAction(action);
      if (action === 'maximize') setIsMaximized(!isMaximized);
    }
  };

  return (
    <html lang="en">
      <body className="antialiased select-none">
        <AudioProvider>
          <div className="jawdio-layout">
            <Sidebar isOpen={isSidebarOpen} toggle={() => setIsSidebarOpen(!isSidebarOpen)} />
            
            <div className="content-area">
              {/* Square Header */}
              <header 
                className="h-12 flex items-center justify-between px-6 bg-[#0f0f13] border-b border-white/5" 
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

              <main className="flex-1 overflow-y-auto">
                {children}
              </main>
            </div>
          </div>
        </AudioProvider>
      </body>
    </html>
  );
}
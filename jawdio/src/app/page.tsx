'use client';
import { MicVocal, Type } from 'lucide-react';
import Link from 'next/link';
import Image from 'next/image';

export default function DashboardPage() {
  return (
    <div className="p-8 lg:p-12 h-full flex flex-col items-center justify-center text-center relative overflow-hidden">
      {/* Subtle background glow */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-indigo-600/5 rounded-full blur-[120px] pointer-events-none"></div>

      <div className="mb-10 relative group z-10">
        <div className="absolute inset-0 bg-indigo-500/20 blur-3xl rounded-full group-hover:bg-indigo-500/30 transition-all duration-700"></div>
        <Image 
          src="/jawdio.png" 
          alt="JAWdio Logo" 
          width={280} 
          height={100} 
          className="relative object-contain drop-shadow-[0_0_25px_rgba(99,102,241,0.2)] transition-transform duration-500 hover:scale-105" 
          priority 
        />
      </div>
      
      <p className="text-white/50 text-sm font-medium max-w-md mx-auto mb-14 z-10">
        Your global soundboard is always active on the right. Select a tool below to start clipping.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 w-full max-w-2xl z-10">
        <Link href="/studio" className="p-8 bg-[#121216]/80 backdrop-blur-xl border border-white/5 hover:border-indigo-500/50 hover:bg-[#16161a] hover:shadow-[0_0_30px_rgba(99,102,241,0.1)] transition-all duration-300 rounded-3xl flex flex-col items-center gap-5 group">
          <div className="p-4 bg-white/5 rounded-2xl group-hover:bg-indigo-500/10 transition-colors">
            <MicVocal size={32} className="text-white/40 group-hover:text-indigo-400 transition-colors" />
          </div>
          <div className="text-center">
            <h3 className="font-black italic uppercase tracking-tight text-white/90 group-hover:text-white text-lg">Clipper Studio</h3>
            <p className="text-[10px] font-bold uppercase tracking-widest text-white/40 mt-2">Audio-based Editing</p>
          </div>
        </Link>

        <Link href="/live" className="p-8 bg-[#121216]/80 backdrop-blur-xl border border-white/5 hover:border-emerald-500/50 hover:bg-[#16161a] hover:shadow-[0_0_30px_rgba(16,185,129,0.1)] transition-all duration-300 rounded-3xl flex flex-col items-center gap-5 group">
          <div className="p-4 bg-white/5 rounded-2xl group-hover:bg-emerald-500/10 transition-colors">
            <Type size={32} className="text-white/40 group-hover:text-emerald-400 transition-colors" />
          </div>
          <div className="text-center">
            <h3 className="font-black italic uppercase tracking-tight text-white/90 group-hover:text-white text-lg">Live Text Clipper</h3>
            <p className="text-[10px] font-bold uppercase tracking-widest text-white/40 mt-2">Real-time STT Editing</p>
          </div>
        </Link>
      </div>
    </div>
  );
}
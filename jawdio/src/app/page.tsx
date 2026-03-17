'use client';
import { MicVocal, Type } from 'lucide-react';
import Link from 'next/link';

export default function DashboardPage() {
  return (
    <div className="p-8 lg:p-12 h-full flex flex-col items-center justify-center text-center">
      <div className="w-20 h-20 rounded-3xl bg-indigo-500/10 flex items-center justify-center mb-8 border border-indigo-500/20">
        <div className="text-indigo-500 font-black italic text-4xl">J</div>
      </div>
      
      <h1 className="text-3xl font-black italic uppercase tracking-tighter mb-4">
        Welcome to <span className="text-indigo-500">JAWdio</span>
      </h1>
      <p className="text-white/40 text-sm font-bold max-w-md mx-auto mb-12">
        Your global soundboard is always active on the right. Select a tool below to start clipping.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 w-full max-w-2xl">
        <Link href="/studio" className="p-6 bg-[#16161a] border border-white/5 hover:border-indigo-500/40 hover:bg-[#1c1c21] transition-all rounded-2xl flex flex-col items-center gap-4 group">
          <MicVocal size={32} className="text-white/20 group-hover:text-indigo-400 transition-colors" />
          <div className="text-center">
            <h3 className="font-black italic uppercase tracking-tight text-white/80 group-hover:text-white">Clipper Studio</h3>
            <p className="text-[10px] font-bold uppercase tracking-widest text-white/40 mt-1">Audio-based Editing</p>
          </div>
        </Link>

        <Link href="/live" className="p-6 bg-[#16161a] border border-white/5 hover:border-emerald-500/40 hover:bg-[#1c1c21] transition-all rounded-2xl flex flex-col items-center gap-4 group">
          <Type size={32} className="text-white/20 group-hover:text-emerald-400 transition-colors" />
          <div className="text-center">
            <h3 className="font-black italic uppercase tracking-tight text-white/80 group-hover:text-white">Live Text Clipper</h3>
            <p className="text-[10px] font-bold uppercase tracking-widest text-white/40 mt-1">Real-time STT Editing</p>
          </div>
        </Link>
      </div>
    </div>
  );
}
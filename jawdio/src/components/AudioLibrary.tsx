'use client';
import { useState, useEffect, useMemo, useCallback } from 'react';
import { useAudio } from '@/context/AudioContext';
import { 
  Search, FolderPlus, Trash2, UploadCloud, X, 
  ChevronRight, ChevronDown, Keyboard, Type, Move, Scissors
} from 'lucide-react';

export default function AudioLibrary() {
  const { sounds, loadSounds, handleButtonClick, handleDeleteSound, hotkeys, setHotkeys } = useAudio();
  const [library, setLibrary] = useState<Record<string, any[]>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [searchQuery, setSearchQuery] = useState("");
  
  const [isDraggingExternal, setIsDraggingExternal] = useState(false);
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [newCatName, setNewCatName] = useState("");
  const [renameValue, setRenameValue] = useState("");
  const [targetFile, setTargetFile] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, file: string } | null>(null);
  const [bindingTarget, setBindingTarget] = useState<string | null>(null);

  const fetchLibrary = useCallback(async () => {
    const res = await fetch(`/api/sounds?t=${Date.now()}`);
    const data = await res.json();
    setLibrary(data.library);
    if (Object.keys(expanded).length === 0) {
      const exp: any = {};
      Object.keys(data.library).forEach(k => exp[k] = true);
      setExpanded(exp);
    }
  }, [expanded]);

  useEffect(() => { fetchLibrary(); }, [sounds, fetchLibrary]);

  useEffect(() => {
    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer?.types.includes('Files')) setIsDraggingExternal(true);
    };
    const handleDragLeave = () => setIsDraggingExternal(false);
    const handleDrop = async (e: DragEvent) => {
      e.preventDefault();
      setIsDraggingExternal(false);
      
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          if (file.name.endsWith('.mp3') || file.name.endsWith('.wav')) {
            const fd = new FormData();
            fd.append('file', file);
            fd.append('category', 'Uncategorized');
            await fetch('/api/upload', { method: 'POST', body: fd });
          }
        }
        loadSounds();
      }
    };

    window.addEventListener('dragover', handleDragOver);
    window.addEventListener('dragleave', handleDragLeave);
    window.addEventListener('drop', handleDrop);
    return () => {
      window.removeEventListener('dragover', handleDragOver);
      window.removeEventListener('dragleave', handleDragLeave);
      window.removeEventListener('drop', handleDrop);
    };
  }, [loadSounds]);

  const onDragStart = (e: React.DragEvent, filename: string) => {
    e.dataTransfer.setData("filename", filename);
  };

  const onDropOnCategory = async (e: React.DragEvent, toCategory: string) => {
    e.preventDefault();
    const filename = e.dataTransfer.getData("filename");
    if (filename) {
      await fetch('/api/sounds', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'MOVE_SOUND', filename, toCategory }) 
      });
      fetchLibrary();
      loadSounds();
    }
  };

  useEffect(() => {
    if (!bindingTarget) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
      let keys = [];
      if (e.ctrlKey) keys.push('CommandOrControl');
      if (e.altKey) keys.push('Alt');
      if (e.shiftKey) keys.push('Shift');
      const finalKey = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      keys.push(finalKey);
      const hotkeyStr = keys.join('+');
      saveHotkey(bindingTarget, hotkeyStr);
      setBindingTarget(null);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [bindingTarget, hotkeys]);

  const saveHotkey = (file: string, keyStr: string | null) => {
    const newHotkeys = { ...hotkeys };
    if (keyStr) newHotkeys[file] = keyStr;
    else delete newHotkeys[file];
    setHotkeys(newHotkeys);
    localStorage.setItem('jawdio-hotkeys', JSON.stringify(newHotkeys));
    if (window.electronAPI) {
      window.electronAPI.clearHotkeys();
      Object.entries(newHotkeys).forEach(([f, k]) => window.electronAPI.registerHotkey(k as string, f));
    }
  };

  const handleRename = async () => {
    if (!renameValue || !targetFile) return;
    await fetch('/api/sounds', { 
      method: 'POST', 
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'RENAME_SOUND', filename: targetFile, newName: renameValue }) 
    });
    setShowRenameModal(false); setTargetFile(null); fetchLibrary(); loadSounds();
  };

  const filteredLibrary = useMemo(() => {
    const filtered: Record<string, any[]> = {};
    Object.entries(library).forEach(([cat, items]) => {
      const matches = items.filter(i => {
         if (!searchQuery) return true;
         return i.name.toLowerCase().includes(searchQuery.toLowerCase());
      });
      if (matches.length > 0) filtered[cat] = matches;
    });
    return filtered;
  }, [library, searchQuery]);

  return (
    <div className="space-y-8 relative pb-24" onClick={() => setContextMenu(null)}>
      
      {isDraggingExternal && (
        <div className="fixed inset-0 bg-[#09090b]/80 backdrop-blur-md border-[6px] border-dashed border-brand-500/50 z-[1000] flex items-center justify-center pointer-events-none transition-all duration-300">
          <div className="bg-[#121216] p-12 rounded-[2rem] border border-white/10 shadow-[0_0_50px_rgba(0,135,255,0.2)] flex flex-col items-center gap-5 animate-in zoom-in-95 duration-200">
            <UploadCloud size={72} className="text-brand-400 animate-bounce" />
            <h2 className="text-3xl font-black italic text-white uppercase tracking-tighter drop-shadow-md">Import into JAWdio</h2>
            <p className="text-white/50 text-xs font-bold uppercase tracking-widest bg-white/5 px-4 py-2 rounded-full">Drop to add to Uncategorized</p>
          </div>
        </div>
      )}

      {bindingTarget && (
        <div className="fixed bottom-10 left-1/2 -translate-x-1/2 bg-brand-600 px-8 py-5 rounded-2xl shadow-[0_10px_40px_rgba(0,135,255,0.4)] z-[300] flex items-center gap-5 border border-white/20 animate-in slide-in-from-bottom-8">
          <Keyboard size={20} className="text-white animate-pulse" />
          <span className="text-sm font-black uppercase tracking-widest text-white">Press Key to Bind</span>
          <button onClick={() => setBindingTarget(null)} className="ml-4 p-1 hover:bg-white/20 rounded-lg transition-colors"><X size={18} className="text-white" /></button>
        </div>
      )}

      {showRenameModal && (
        <div 
          className="fixed inset-0 bg-[#000000]/80 backdrop-blur-md z-[500] flex items-center justify-center p-6 animate-in fade-in duration-200"
          onClick={() => setShowRenameModal(false)}
        >
          <div 
            className="bg-[#121216] p-8 rounded-3xl border border-white/10 shadow-2xl w-full max-w-sm"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-xl font-black italic text-white mb-6 uppercase tracking-tighter">Rename Sound</h3>
            <input 
              type="text" 
              value={renameValue} 
              onChange={(e) => setRenameValue(e.target.value)} 
              onKeyDown={(e) => e.key === 'Enter' && handleRename()} 
              className="w-full bg-[#09090b] border border-white/10 rounded-xl p-4 text-white font-bold mb-6 focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none transition-all" 
              autoFocus
            />
            <div className="flex gap-3">
              <button onClick={() => setShowRenameModal(false)} className="flex-1 py-3.5 rounded-xl border border-white/5 bg-white/5 hover:bg-white/10 text-xs font-black uppercase text-white/60 transition-colors">Cancel</button>
              <button onClick={handleRename} className="flex-1 py-3.5 rounded-xl bg-brand-600 hover:bg-brand-500 shadow-lg shadow-brand-500/20 text-white text-xs font-black uppercase transition-colors">Save</button>
            </div>
          </div>
        </div>
      )}

      <div className="flex justify-between items-center gap-6">
        <div className="relative w-full max-w-md group">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-white/30 group-focus-within:text-brand-400 transition-colors" size={18} />
          <input type="text" placeholder="Search your sounds..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="w-full bg-[#121216] border border-white/5 p-3.5 pl-12 text-sm text-white font-medium rounded-2xl focus:border-brand-500/50 focus:bg-[#16161a] outline-none transition-all shadow-inner" />
        </div>
        <button onClick={() => setShowCategoryModal(true)} className="px-5 py-3.5 bg-[#121216] border border-white/5 hover:border-brand-500/30 hover:bg-brand-500/5 text-white/60 hover:text-brand-400 rounded-2xl flex items-center gap-2 text-[11px] font-black uppercase transition-all shadow-sm">
          <FolderPlus size={16} /> New Category
        </button>
      </div>

      <div className="space-y-10">
        {Object.entries(filteredLibrary).map(([catName, catSounds]) => (
          <div key={catName} onDragOver={(e) => e.preventDefault()} onDrop={(e) => onDropOnCategory(e, catName)}>
            <div className="flex items-center justify-between pb-3 mb-5 cursor-pointer group" onClick={() => setExpanded({...expanded, [catName]: !expanded[catName]})}>
              <div className="flex items-center gap-3">
                <div className="text-brand-500/70 group-hover:text-brand-400 transition-colors bg-brand-500/10 p-1.5 rounded-lg">
                  {expanded[catName] ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                </div>
                <h3 className="text-xl font-black italic tracking-tight uppercase text-white/90 group-hover:text-white">{catName}</h3>
              </div>
              <div className="h-px flex-1 bg-gradient-to-r from-white/5 to-transparent ml-6"></div>
            </div>

            {expanded[catName] && (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-4">
                {catSounds.map((sound) => (
                  <div
                    key={sound.filename} draggable onDragStart={(e) => onDragStart(e, sound.filename)}
                    onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setContextMenu({ x: e.clientX, y: e.clientY, file: sound.filename }); }}
                    onClick={() => handleButtonClick(sound.filename, false, () => {})}
                    className="relative aspect-square flex flex-col items-center justify-center p-4 bg-[#121216] border border-white/5 hover:border-brand-500/50 hover:bg-[#16161a] hover:shadow-[0_4px_20px_rgba(0,135,255,0.1)] rounded-2xl cursor-pointer group transition-all duration-200"
                  >
                    {hotkeys[sound.filename] && (
                      <span className="absolute top-3 left-3 text-[10px] font-black bg-brand-500/20 text-brand-400 px-2 py-1 rounded-md border border-brand-500/20">{hotkeys[sound.filename].replace('CommandOrControl', 'CTRL')}</span>
                    )}
                    <span className="text-sm font-bold text-white/70 group-hover:text-white text-center leading-tight select-none mt-2 transition-colors">{sound.name}</span>
                    <div className="absolute bottom-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity bg-white/5 p-1.5 rounded-lg"><Move size={12} className="text-white/60" /></div>
                  </div>
                ))}
                
                <label className="aspect-square flex flex-col items-center justify-center p-4 rounded-2xl border-2 border-dashed border-white/5 hover:border-brand-500/40 hover:bg-brand-500/5 transition-all cursor-pointer group">
                  <div className="bg-white/5 p-3 rounded-full mb-3 group-hover:bg-brand-500/20 group-hover:scale-110 transition-all">
                    <UploadCloud size={20} className="text-white/40 group-hover:text-brand-400" />
                  </div>
                  <span className="text-[10px] font-black uppercase text-white/30 group-hover:text-brand-400 text-center transition-colors">Add to {catName}</span>
                  <input type="file" className="hidden" onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      const fd = new FormData(); fd.append('file', file); fd.append('category', catName);
                      await fetch('/api/upload', { method: 'POST', body: fd }); loadSounds();
                    }
                  }} />
                </label>
              </div>
            )}
          </div>
        ))}
      </div>

      {contextMenu && (
        <div 
          className="fixed bg-[#121216]/95 backdrop-blur-xl border border-white/10 rounded-2xl shadow-[0_10px_40px_rgba(0,0,0,0.5)] py-2 w-60 z-[600] overflow-hidden animate-in fade-in zoom-in-95 duration-100" 
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-4 py-2 text-[10px] font-black text-white/30 uppercase tracking-widest border-b border-white/5 mb-1 bg-[#09090b]/50">Sound Actions</div>
          
          <button onClick={() => { setBindingTarget(contextMenu.file); setContextMenu(null); }} className="w-full text-left px-5 py-3 text-sm font-semibold text-white/70 hover:text-white hover:bg-brand-600 flex items-center gap-3 transition-colors">
            <Keyboard size={16} className="opacity-70" /> Set Keybind
          </button>
          
          {hotkeys[contextMenu.file] && (
            <button onClick={() => { saveHotkey(contextMenu.file, null); setContextMenu(null); }} className="w-full text-left px-5 py-3 text-sm font-semibold text-amber-500/80 hover:text-amber-50 hover:bg-amber-600 flex items-center gap-3 transition-colors">
              <Scissors size={16} className="opacity-70" /> Remove Keybind
            </button>
          )}
          
          <button onClick={() => { 
            setTargetFile(contextMenu.file); 
            setRenameValue(contextMenu.file.split('/').pop()?.replace(/\.[^/.]+$/, "") || ""); 
            setShowRenameModal(true); 
            setContextMenu(null); 
          }} className="w-full text-left px-5 py-3 text-sm font-semibold text-white/70 hover:text-white hover:bg-white/10 flex items-center gap-3 transition-colors border-t border-white/5">
            <Type size={16} className="opacity-70" /> Rename
          </button>
          
          <button onClick={() => { 
            const fileToDelete = contextMenu.file; 
            setContextMenu(null); 
            setTimeout(() => {
              if(confirm('Are you sure you want to delete this sound?')) {
                handleDeleteSound(fileToDelete);
              }
            }, 50);
          }} className="w-full text-left px-5 py-3 text-sm font-semibold text-red-500/80 hover:text-red-50 hover:bg-red-600 flex items-center gap-3 transition-colors border-t border-white/5">
            <Trash2 size={16} className="opacity-70" /> Delete
          </button>
        </div>
      )}
    </div>
  );
}
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
  
  // Modals & UI States
  const [isDraggingExternal, setIsDraggingExternal] = useState(false);
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [newCatName, setNewCatName] = useState("");
  const [renameValue, setRenameValue] = useState("");
  const [targetFile, setTargetFile] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, file: string } | null>(null);
  const [bindingTarget, setBindingTarget] = useState<string | null>(null);

  const fetchLibrary = useCallback(async () => {
    const res = await fetch('/api/sounds');
    const data = await res.json();
    setLibrary(data.library);
    if (Object.keys(expanded).length === 0) {
      const exp: any = {};
      Object.keys(data.library).forEach(k => exp[k] = true);
      setExpanded(exp);
    }
  }, [expanded]);

  useEffect(() => { fetchLibrary(); }, [sounds, fetchLibrary]);

  // --- GLOBAL EXTERNAL DRAG & DROP ---
  useEffect(() => {
    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer?.types.includes('Files')) {
        setIsDraggingExternal(true);
      }
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

  // --- INTERNAL DRAG & DROP (Moving Categories) ---
  const onDragStart = (e: React.DragEvent, filename: string) => {
    e.dataTransfer.setData("filename", filename);
  };

  const onDropOnCategory = async (e: React.DragEvent, toCategory: string) => {
    e.preventDefault();
    const filename = e.dataTransfer.getData("filename");
    if (filename) {
      await fetch('/api/sounds', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, // Added Header
        body: JSON.stringify({ action: 'MOVE_SOUND', filename, toCategory }) 
      });
      fetchLibrary();
      loadSounds();
    }
  };

  // --- HOTKEY LOGIC ---
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
      headers: { 'Content-Type': 'application/json' }, // Added Header
      body: JSON.stringify({ action: 'RENAME_SOUND', filename: targetFile, newName: renameValue }) 
    });
    setShowRenameModal(false); setTargetFile(null); fetchLibrary(); loadSounds();
  };

  const filteredLibrary = useMemo(() => {
    if (!searchQuery) return library;
    const filtered: Record<string, any[]> = {};
    Object.entries(library).forEach(([cat, items]) => {
      const matches = items.filter(i => i.name.toLowerCase().includes(searchQuery.toLowerCase()));
      if (matches.length > 0) filtered[cat] = matches;
    });
    return filtered;
  }, [library, searchQuery]);

  return (
    <div className="space-y-8 relative pb-24" onClick={() => setContextMenu(null)}>
      
      {/* GLOBAL DROP OVERLAY */}
      {isDraggingExternal && (
        <div className="fixed inset-0 bg-indigo-600/10 backdrop-blur-md border-4 border-dashed border-indigo-500/50 z-[1000] flex items-center justify-center pointer-events-none">
          <div className="bg-[#0f0f13] p-10 rounded-3xl border border-white/10 shadow-2xl flex flex-col items-center gap-4 animate-in zoom-in-95 duration-200">
            <UploadCloud size={64} className="text-indigo-500 animate-bounce" />
            <h2 className="text-2xl font-black italic text-white uppercase tracking-tighter">Import into JAWdio</h2>
            <p className="text-white/40 text-xs font-bold uppercase tracking-widest">Drop to add to Uncategorized</p>
          </div>
        </div>
      )}

      {/* BINDING PILL */}
      {bindingTarget && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 bg-indigo-600 px-6 py-4 rounded-full shadow-2xl z-[300] flex items-center gap-4 border border-white/20 animate-in slide-in-from-bottom">
          <Keyboard size={18} className="text-white animate-pulse" />
          <span className="text-xs font-black uppercase tracking-widest text-white">Press Key to Bind</span>
          <button onClick={() => setBindingTarget(null)}><X size={16} className="text-white/60" /></button>
        </div>
      )}

      {/* RENAME MODAL - Fixed bubbling and removed autoFocus */}
      {showRenameModal && (
        <div 
          className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[500] flex items-center justify-center p-6"
          onClick={() => setShowRenameModal(false)}
        >
          <div 
            className="bg-[#1a1a1f] p-8 border border-white/5 w-full max-w-sm"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-xl font-black italic text-white mb-6 uppercase tracking-tighter">Rename Sound</h3>
            <input 
              type="text" 
              value={renameValue} 
              onChange={(e) => setRenameValue(e.target.value)} 
              onKeyDown={(e) => e.key === 'Enter' && handleRename()} 
              className="w-full bg-[#09090b] border border-white/10 p-4 text-white font-bold mb-6 focus:border-indigo-500 outline-none" 
            />
            <div className="flex gap-3">
              <button onClick={() => setShowRenameModal(false)} className="flex-1 py-3 text-[10px] font-black uppercase text-white/40">Cancel</button>
              <button onClick={handleRename} className="flex-1 py-3 bg-indigo-600 text-white text-[10px] font-black uppercase">Save</button>
            </div>
          </div>
        </div>
      )}

      {/* SEARCH & ACTIONS */}
      <div className="flex justify-between items-center gap-6">
        <div className="relative w-96 group">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-white/20 group-focus-within:text-indigo-500" size={18} />
          <input type="text" placeholder="Search sounds..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="w-full bg-[#16161a] border border-white/5 p-4 pl-12 text-white font-bold rounded-xl focus:border-indigo-500 outline-none" />
        </div>
        <button onClick={() => setShowCategoryModal(true)} className="px-5 py-3 bg-white/5 border border-white/10 text-white/40 hover:text-white flex items-center gap-2 text-[10px] font-black uppercase transition-all">
          <FolderPlus size={14} /> New Category
        </button>
      </div>

      {/* GRID */}
      <div className="space-y-12">
        {Object.entries(filteredLibrary).map(([catName, catSounds]) => (
          <div key={catName} onDragOver={(e) => e.preventDefault()} onDrop={(e) => onDropOnCategory(e, catName)}>
            <div className="flex items-center justify-between border-b border-white/5 pb-4 mb-6 cursor-pointer" onClick={() => setExpanded({...expanded, [catName]: !expanded[catName]})}>
              <div className="flex items-center gap-3">
                <div className="text-indigo-500">{expanded[catName] ? <ChevronDown size={18} /> : <ChevronRight size={18} />}</div>
                <h3 className="text-lg font-black italic tracking-tight uppercase">{catName}</h3>
              </div>
            </div>

            {expanded[catName] && (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6 gap-5">
                {catSounds.map((sound) => (
                  <div
                    key={sound.filename} draggable onDragStart={(e) => onDragStart(e, sound.filename)}
                    onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setContextMenu({ x: e.clientX, y: e.clientY, file: sound.filename }); }}
                    onClick={() => handleButtonClick(sound.filename, false, () => {})}
                    className="relative aspect-square flex flex-col items-center justify-center p-5 bg-[#16161a] border border-white/5 hover:border-indigo-500/40 hover:bg-[#1c1c21] cursor-pointer group"
                  >
                    {hotkeys[sound.filename] && (
                      <span className="absolute top-3 left-3 text-[9px] font-black bg-indigo-500/20 text-indigo-400 px-2 py-0.5 rounded-md">{hotkeys[sound.filename].replace('CommandOrControl', 'CTRL')}</span>
                    )}
                    <span className="text-sm font-bold text-white/70 text-center leading-tight select-none">{sound.name}</span>
                    <div className="absolute bottom-3 right-3 opacity-0 group-hover:opacity-40 transition-opacity"><Move size={12} className="text-white" /></div>
                  </div>
                ))}
                
                {/* Upload Tile */}
                <label className="aspect-square flex flex-col items-center justify-center p-5 border-2 border-dashed border-white/5 hover:border-indigo-500/40 hover:bg-indigo-500/5 transition-all cursor-pointer group">
                  <UploadCloud size={20} className="text-white/10 group-hover:text-indigo-500 mb-2" />
                  <span className="text-[8px] font-black uppercase text-white/10 group-hover:text-white text-center">Add to {catName}</span>
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

      {/* CONTEXT MENU - Fixed bubbling & setTimeout delay for confirm() */}
      {contextMenu && (
        <div 
          className="fixed bg-[#1a1a1f] border border-white/10 shadow-2xl py-2 w-56 z-[600] overflow-hidden" 
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-4 py-2 text-[9px] font-black text-white/20 uppercase tracking-widest border-b border-white/5 mb-1">Actions</div>
          
          <button onClick={() => { setBindingTarget(contextMenu.file); setContextMenu(null); }} className="w-full text-left px-4 py-2.5 text-xs font-bold text-white/60 hover:text-white hover:bg-indigo-600 flex items-center gap-3">
            <Keyboard size={14}/> Set Keybind
          </button>
          
          {hotkeys[contextMenu.file] && (
            <button onClick={() => { saveHotkey(contextMenu.file, null); setContextMenu(null); }} className="w-full text-left px-4 py-2.5 text-xs font-bold text-amber-500/60 hover:text-amber-500 hover:bg-amber-500/10 flex items-center gap-3">
              <Scissors size={14}/> Remove Keybind
            </button>
          )}
          
          <button onClick={() => { 
            setTargetFile(contextMenu.file); 
            setRenameValue(contextMenu.file.split('/').pop()?.replace(/\.[^/.]+$/, "") || ""); 
            setShowRenameModal(true); 
            setContextMenu(null); 
          }} className="w-full text-left px-4 py-2.5 text-xs font-bold text-white/60 hover:text-white hover:bg-indigo-600 flex items-center gap-3">
            <Type size={14}/> Rename
          </button>
          
         <button onClick={(e) => { 
            e.stopPropagation();
            const fileToDelete = contextMenu.file; // <--- Safely capture the file path first
            setContextMenu(null); 
            
            setTimeout(() => {
              if(confirm('Are you sure you want to delete this sound?')) {
                handleDeleteSound(fileToDelete);
              }
            }, 50);
          }} className="w-full text-left px-4 py-2.5 text-xs font-bold text-red-500/60 hover:text-red-500 hover:bg-red-500/10 flex items-center gap-3">
            <Trash2 size={14}/> Delete
          </button>
        </div>
      )}
    </div>
  );
}
"use client";
import { useState, useEffect } from "react";
import { useAudio } from "@/context/AudioContext";
import { UploadCloud, Pencil, Check, X } from "lucide-react";

export default function SoundboardPage() {
  const {
    isHost,
    sounds,
    loadSounds,
    handleButtonClick,
    handleDeleteSound,
    hotkeys,
    setHotkeys,
  } = useAudio();
  const [isUploading, setIsUploading] = useState(false);
  const [isEditMode, setIsEditMode] = useState(false);
  const [bindingTarget, setBindingTarget] = useState<string | null>(null);

  useEffect(() => {
    if (!bindingTarget) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;
      let keys = [];
      if (e.ctrlKey) keys.push("CommandOrControl");
      if (e.altKey) keys.push("Alt");
      if (e.shiftKey) keys.push("Shift");
      let finalKey = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      keys.push(finalKey);
      const hotkeyStr = keys.join("+");
      const newHotkeys = { ...hotkeys, [bindingTarget]: hotkeyStr };
      setHotkeys(newHotkeys);
      localStorage.setItem("jawdio-hotkeys", JSON.stringify(newHotkeys));
      if (window.electronAPI) {
        window.electronAPI.clearHotkeys();
        Object.entries(newHotkeys).forEach(([f, k]) =>
          window.electronAPI.registerHotkey(k as string, f),
        );
      }
      setBindingTarget(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [bindingTarget, hotkeys, setHotkeys]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsUploading(true);
    const fd = new FormData();
    fd.append("file", file);
    await fetch("/api/upload", { method: "POST", body: fd });
    loadSounds();
    setIsUploading(false);
  };

  return (
    <div className="p-8 lg:p-12 max-w-[1400px] mx-auto">
      {bindingTarget && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-xl z-[100] flex items-center justify-center p-6">
          <div className="bg-[#1a1a1f] p-10 rounded-[2.5rem] border border-white/5 text-center shadow-2xl max-w-sm w-full">
            <h2 className="text-2xl font-bold text-white mb-8">
              Binding: {bindingTarget}
            </h2>
            <div className="flex gap-3">
              <button
                onClick={() => setBindingTarget(null)}
                className="flex-1 py-4 bg-white/5 rounded-2xl text-white font-bold"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const nh = { ...hotkeys };
                  delete nh[bindingTarget];
                  setHotkeys(nh);
                  localStorage.setItem("jawdio-hotkeys", JSON.stringify(nh));
                  if (window.electronAPI) {
                    window.electronAPI.clearHotkeys();
                    Object.entries(nh).forEach(([f, k]) =>
                      window.electronAPI.registerHotkey(k as string, f),
                    );
                  }
                  setBindingTarget(null);
                }}
                className="flex-1 py-4 bg-red-500/10 text-red-500 rounded-2xl font-bold"
              >
                Unbind
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-col sm:flex-row justify-between items-center gap-6 mb-12">
        <h2 className="text-4xl font-black italic tracking-tighter">LIBRARY</h2>
        <div className="flex gap-3">
          <button
            onClick={() => setIsEditMode(!isEditMode)}
            className={`px-6 py-3 rounded-2xl font-black text-[10px] uppercase tracking-widest border transition-all flex items-center gap-2 ${isEditMode ? "bg-indigo-600 border-indigo-500 text-white shadow-lg shadow-indigo-600/20" : "bg-white/5 border-white/5 text-white/40 hover:text-white"}`}
          >
            {isEditMode ? <Check size={14} /> : <Pencil size={14} />}{" "}
            {isEditMode ? "Finish" : "Edit"}
          </button>
          <label className="cursor-pointer px-6 py-3 rounded-2xl font-black text-[10px] uppercase tracking-widest bg-indigo-600 hover:bg-indigo-500 text-white flex items-center gap-2 shadow-lg shadow-indigo-600/20">
            <UploadCloud size={14} /> {isUploading ? "..." : "Import"}
            <input
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={handleFileUpload}
            />
          </label>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6 gap-6">
        {sounds.map((sound) => (
          <button
            key={sound.filename}
            onClick={() =>
              handleButtonClick(sound.filename, isEditMode, setBindingTarget)
            }
            className={`
    relative aspect-square flex flex-col items-center justify-center p-6 rounded-xl transition-all duration-200
    ${
      isEditMode
        ? "bg-indigo-500/5 border-2 border-dashed border-indigo-500/20 shadow-inner"
        : "bg-[#16161a] border border-white/5 hover:border-indigo-500/40 hover:bg-[#1c1c21]"
    }
  `}
          >
            {isEditMode && (
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`Delete ${sound.filename}?`))
                    handleDeleteSound(sound.filename);
                }}
                className="absolute top-4 right-4 text-white/20 hover:text-red-500 transition-colors"
              >
                <X size={16} />
              </div>
            )}
            {hotkeys[sound.filename] && (
              <span className="absolute top-4 left-4 text-[9px] font-black bg-white/5 px-2 py-1 rounded-full text-white/30">
                {hotkeys[sound.filename].replace("CommandOrControl", "CTRL")}
              </span>
            )}
            <span className="text-sm font-bold text-white/80 text-center leading-tight px-2 capitalize">
              {sound.name}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

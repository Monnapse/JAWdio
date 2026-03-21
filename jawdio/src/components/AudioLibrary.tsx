'use client';

import {
  FolderPlus,
  GripVertical,
  Keyboard,
  MoreHorizontal,
  PencilLine,
  Search,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react';
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import { useAudio } from '@/context/AudioContext';

interface LibrarySound {
  name: string;
  filename: string;
  category: string;
}

type LibraryState = Record<string, LibrarySound[]>;

interface ContextMenuState {
  x: number;
  y: number;
  file: string;
  name: string;
}

const SUPPORTED_UPLOAD_TYPES = '.mp3,.wav,.m4a,.ogg';

export default function AudioLibrary() {
  const {
    sounds,
    loadSounds,
    handleButtonClick,
    handleDeleteSound,
    hotkeys,
    setHotkeys,
  } = useAudio();

  const [library, setLibrary] = useState<LibraryState>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const deferredSearchQuery = useDeferredValue(searchQuery);

  const [isDraggingExternal, setIsDraggingExternal] = useState(false);
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [renameValue, setRenameValue] = useState('');
  const [targetFile, setTargetFile] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LibrarySound | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [bindingTarget, setBindingTarget] = useState<string | null>(null);

  const dragDepthRef = useRef(0);
  const refreshLibrary = useCallback(async () => {
    const response = await fetch(`/api/sounds?t=${Date.now()}`);

    if (!response.ok) {
      throw new Error(`Failed to load library: ${response.status}`);
    }

    const data = (await response.json()) as { library: LibraryState };
    setLibrary(data.library);
    setExpanded((current) => {
      const nextExpanded: Record<string, boolean> = { ...current };

      Object.keys(data.library).forEach((category) => {
        if (!(category in nextExpanded)) {
          nextExpanded[category] = true;
        }
      });

      Object.keys(nextExpanded).forEach((category) => {
        if (!(category in data.library)) {
          delete nextExpanded[category];
        }
      });

      if (Object.keys(current).length === 0) {
        return Object.fromEntries(
          Object.keys(data.library).map((category) => [category, true]),
        );
      }

      return nextExpanded;
    });
  }, []);

  useEffect(() => {
    const refreshTimer = window.setTimeout(() => {
      void refreshLibrary();
    }, 0);

    return () => window.clearTimeout(refreshTimer);
  }, [refreshLibrary, sounds]);

  const saveHotkey = useCallback(
    (file: string, keyString: string | null) => {
      const nextHotkeys = { ...hotkeys };

      if (keyString) {
        nextHotkeys[file] = keyString;
      } else {
        delete nextHotkeys[file];
      }

      setHotkeys(nextHotkeys);
      localStorage.setItem('jawdio-hotkeys', JSON.stringify(nextHotkeys));

      if (window.electronAPI) {
        window.electronAPI.clearHotkeys();
        Object.entries(nextHotkeys).forEach(([filename, hotkey]) => {
          window.electronAPI?.registerHotkey(hotkey, filename);
        });
      }
    },
    [hotkeys, setHotkeys],
  );

  useEffect(() => {
    if (!bindingTarget) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();

      if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) {
        return;
      }

      const keys: string[] = [];

      if (event.ctrlKey) {
        keys.push('CommandOrControl');
      }

      if (event.altKey) {
        keys.push('Alt');
      }

      if (event.shiftKey) {
        keys.push('Shift');
      }

      keys.push(event.key.length === 1 ? event.key.toUpperCase() : event.key);
      saveHotkey(bindingTarget, keys.join('+'));
      setBindingTarget(null);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [bindingTarget, saveHotkey]);

  const uploadFiles = useCallback(
    async (files: FileList | File[], category: string) => {
      for (const file of Array.from(files)) {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('category', category);

        const response = await fetch('/api/upload', { method: 'POST', body: formData });

        if (!response.ok) {
          const error = (await response.json().catch(() => null)) as
            | { error?: string }
            | null;
          throw new Error(error?.error ?? 'Upload failed.');
        }
      }

      await Promise.all([refreshLibrary(), loadSounds()]);
    },
    [loadSounds, refreshLibrary],
  );

  useEffect(() => {
    const handleDragEnter = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) {
        return;
      }

      dragDepthRef.current += 1;
      setIsDraggingExternal(true);
    };

    const handleDragOver = (event: DragEvent) => {
      event.preventDefault();
    };

    const handleDragLeave = () => {
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);

      if (dragDepthRef.current === 0) {
        setIsDraggingExternal(false);
      }
    };

    const handleDrop = async (event: DragEvent) => {
      event.preventDefault();
      dragDepthRef.current = 0;
      setIsDraggingExternal(false);

      if (!event.dataTransfer?.files.length) {
        return;
      }

      try {
        await uploadFiles(event.dataTransfer.files, 'Uncategorized');
      } catch (error) {
        console.error(error);
        alert('One or more files could not be uploaded.');
      }
    };

    window.addEventListener('dragenter', handleDragEnter);
    window.addEventListener('dragover', handleDragOver);
    window.addEventListener('dragleave', handleDragLeave);
    window.addEventListener('drop', handleDrop);

    return () => {
      window.removeEventListener('dragenter', handleDragEnter);
      window.removeEventListener('dragover', handleDragOver);
      window.removeEventListener('dragleave', handleDragLeave);
      window.removeEventListener('drop', handleDrop);
    };
  }, [uploadFiles]);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setContextMenu(null);
      }
    };

    window.addEventListener('keydown', handleEscape);

    return () => {
      window.removeEventListener('keydown', handleEscape);
    };
  }, [contextMenu]);

  const filteredLibrary = useMemo(() => {
    const normalizedQuery = deferredSearchQuery.trim().toLowerCase();

    if (!normalizedQuery) {
      return library;
    }

    return Object.fromEntries(
      Object.entries(library)
        .map(([category, items]) => [
          category,
          items.filter((item) => item.name.toLowerCase().includes(normalizedQuery)),
        ])
        .filter(([, items]) => items.length > 0),
    ) as LibraryState;
  }, [deferredSearchQuery, library]);

  const categories = Object.entries(filteredLibrary);
  const totalSounds = Object.values(library).reduce((sum, items) => sum + items.length, 0);
  const totalCategories = Object.keys(library).length;

  const handleCreateCategory = async () => {
    const trimmedName = newCategoryName.trim();

    if (!trimmedName) {
      return;
    }

    const response = await fetch('/api/sounds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'CREATE_CATEGORY', name: trimmedName }),
    });

    if (!response.ok) {
      const error = (await response.json().catch(() => null)) as { error?: string } | null;
      alert(error?.error ?? 'Category creation failed.');
      return;
    }

    setNewCategoryName('');
    setShowCategoryModal(false);
    await Promise.all([refreshLibrary(), loadSounds()]);
  };

  const handleRename = async () => {
    if (!renameValue.trim() || !targetFile) {
      return;
    }

    const response = await fetch('/api/sounds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'RENAME_SOUND',
        filename: targetFile,
        newName: renameValue.trim(),
      }),
    });

    if (!response.ok) {
      const error = (await response.json().catch(() => null)) as { error?: string } | null;
      alert(error?.error ?? 'Rename failed.');
      return;
    }

    setShowRenameModal(false);
    setTargetFile(null);
    setRenameValue('');
    await Promise.all([refreshLibrary(), loadSounds()]);
  };

  const handleDropOnCategory = async (
    event: React.DragEvent<HTMLElement>,
    category: string,
  ) => {
    event.preventDefault();

    if (event.dataTransfer.files.length > 0) {
      try {
        await uploadFiles(event.dataTransfer.files, category);
      } catch (error) {
        console.error(error);
        alert('Those files could not be uploaded.');
      }

      return;
    }

    const filename = event.dataTransfer.getData('filename');

    if (!filename) {
      return;
    }

    const response = await fetch('/api/sounds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'MOVE_SOUND', filename, toCategory: category }),
    });

    if (!response.ok) {
      const error = (await response.json().catch(() => null)) as { error?: string } | null;
      alert(error?.error ?? 'Sound move failed.');
      return;
    }

    await Promise.all([refreshLibrary(), loadSounds()]);
  };

  const handleDeleteConfirmed = async () => {
    if (!deleteTarget) {
      return;
    }

    try {
      await handleDeleteSound(deleteTarget.filename);
      await refreshLibrary();
      setDeleteTarget(null);
    } catch (error) {
      console.error(error);
      alert('Delete failed.');
    }
  };

  const openContextMenu = (
    event: React.MouseEvent<HTMLElement>,
    sound: LibrarySound,
  ) => {
    event.preventDefault();
    event.stopPropagation();

    const menuWidth = 240;
    const menuHeight = 210;
    const nextX = Math.min(event.clientX, window.innerWidth - menuWidth - 20);
    const nextY = Math.min(event.clientY, window.innerHeight - menuHeight - 20);

    setContextMenu({
      x: Math.max(16, nextX),
      y: Math.max(16, nextY),
      file: sound.filename,
      name: sound.name,
    });
  };

  return (
    <div className="space-y-6 pb-16">
      {isDraggingExternal && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-[rgba(4,8,14,0.76)] backdrop-blur-xl">
          <div className="w-[min(92vw,28rem)] rounded-[2rem] border border-[var(--line-strong)] bg-[linear-gradient(180deg,rgba(16,28,40,0.98),rgba(10,18,28,0.98))] p-10 text-center shadow-[0_30px_120px_rgba(0,0,0,0.55)]">
            <div className="mx-auto mb-5 flex h-20 w-20 items-center justify-center rounded-[1.5rem] border border-[rgba(45,212,191,0.35)] bg-[rgba(45,212,191,0.12)]">
              <UploadCloud className="h-9 w-9 text-[var(--accent)]" />
            </div>
            <p className="eyebrow mb-3">Import Sounds</p>
            <h2 className="font-[var(--font-display)] text-3xl font-semibold tracking-[-0.04em] text-[var(--text-strong)]">
              Drop audio anywhere to load it into the board.
            </h2>
            <p className="mt-3 text-sm text-[var(--text-muted)]">
              Files land in <span className="text-[var(--text-strong)]">Uncategorized</span> by
              default, and you can drag them into folders after import.
            </p>
          </div>
        </div>
      )}

      {bindingTarget && (
        <div className="fixed bottom-8 left-1/2 z-[220] flex w-[min(calc(100vw-2rem),32rem)] -translate-x-1/2 items-center gap-4 rounded-[1.6rem] border border-[rgba(45,212,191,0.35)] bg-[rgba(10,20,28,0.96)] px-5 py-4 shadow-[0_24px_70px_rgba(0,0,0,0.45)] backdrop-blur-xl">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[rgba(45,212,191,0.12)] text-[var(--accent)]">
            <Keyboard size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="eyebrow mb-1">Hotkey Capture</p>
            <p className="text-sm text-[var(--text-strong)]">
              Press the shortcut you want to bind.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setBindingTarget(null)}
            className="rounded-full border border-[var(--line)] p-2 text-[var(--text-muted)] transition hover:border-[var(--line-strong)] hover:text-[var(--text-strong)]"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {showCategoryModal && (
        <div
          className="fixed inset-0 z-[250] flex items-center justify-center bg-[rgba(3,6,10,0.78)] p-6 backdrop-blur-lg"
          onClick={() => setShowCategoryModal(false)}
        >
          <div
            className="panel-surface w-full max-w-md p-8"
            onClick={(event) => event.stopPropagation()}
          >
            <p className="eyebrow mb-3">New Category</p>
            <h3 className="font-[var(--font-display)] text-2xl font-semibold tracking-[-0.04em] text-[var(--text-strong)]">
              Add a new folder to the board.
            </h3>
            <input
              type="text"
              value={newCategoryName}
              onChange={(event) => setNewCategoryName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  void handleCreateCategory();
                }
              }}
              placeholder="Crowd moments"
              className="field mt-6"
              autoFocus
            />
            <div className="mt-6 flex gap-3">
              <button
                type="button"
                onClick={() => setShowCategoryModal(false)}
                className="ghost-button flex-1"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleCreateCategory()}
                className="accent-button flex-1"
              >
                Create Category
              </button>
            </div>
          </div>
        </div>
      )}

      {showRenameModal && (
        <div
          className="fixed inset-0 z-[250] flex items-center justify-center bg-[rgba(3,6,10,0.78)] p-6 backdrop-blur-lg"
          onClick={() => setShowRenameModal(false)}
        >
          <div
            className="panel-surface w-full max-w-md p-8"
            onClick={(event) => event.stopPropagation()}
          >
            <p className="eyebrow mb-3">Rename Sound</p>
            <h3 className="font-[var(--font-display)] text-2xl font-semibold tracking-[-0.04em] text-[var(--text-strong)]">
              Update the label used on the pad.
            </h3>
            <input
              type="text"
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  void handleRename();
                }
              }}
              className="field mt-6"
              autoFocus
            />
            <div className="mt-6 flex gap-3">
              <button
                type="button"
                onClick={() => setShowRenameModal(false)}
                className="ghost-button flex-1"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleRename()}
                className="accent-button flex-1"
              >
                Save Name
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div
          className="fixed inset-0 z-[250] flex items-center justify-center bg-[rgba(3,6,10,0.78)] p-6 backdrop-blur-lg"
          onClick={() => setDeleteTarget(null)}
        >
          <div
            className="panel-surface w-full max-w-md p-8"
            onClick={(event) => event.stopPropagation()}
          >
            <p className="eyebrow mb-3 text-[var(--danger)]">Delete Sound</p>
            <h3 className="font-[var(--font-display)] text-2xl font-semibold tracking-[-0.04em] text-[var(--text-strong)]">
              Remove &quot;{deleteTarget.name}&quot; from the board?
            </h3>
            <p className="mt-3 text-sm text-[var(--text-muted)]">
              This deletes the audio file from the library, not just the visual card.
            </p>
            <div className="mt-6 flex gap-3">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="ghost-button flex-1"
              >
                Keep Sound
              </button>
              <button
                type="button"
                onClick={() => void handleDeleteConfirmed()}
                className="danger-button flex-1"
              >
                Delete Permanently
              </button>
            </div>
          </div>
        </div>
      )}

      <section className="panel-surface overflow-hidden p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="eyebrow mb-2">Global Library</p>
            <h2 className="font-[var(--font-display)] text-2xl font-semibold tracking-[-0.04em] text-[var(--text-strong)]">
              Curate instant-access pads, drops, and show moments.
            </h2>
          </div>
          <div className="grid w-full gap-3 sm:w-auto sm:grid-cols-2">
            <div className="metric-card min-w-0">
              <span className="metric-label">Sounds</span>
              <strong className="metric-value">{totalSounds}</strong>
            </div>
            <div className="metric-card min-w-0">
              <span className="metric-label">Categories</span>
              <strong className="metric-value">{totalCategories}</strong>
            </div>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <div className="search-shell min-w-[13rem] flex-1">
            <Search size={17} className="text-[var(--text-muted)]" />
            <input
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search sounds, names, and moments"
              className="search-field"
            />
          </div>
          <button
            type="button"
            onClick={() => setShowCategoryModal(true)}
            className="ghost-button inline-flex items-center gap-2"
          >
            <FolderPlus size={16} />
            New Category
          </button>
        </div>
      </section>

      {categories.length > 0 ? (
        <div className="space-y-5">
          {categories.map(([categoryName, categorySounds]) => (
            <section
              key={categoryName}
              className="panel-surface p-4"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => void handleDropOnCategory(event, categoryName)}
            >
              <button
                type="button"
                onClick={() =>
                  setExpanded((current) => ({
                    ...current,
                    [categoryName]: !current[categoryName],
                  }))
                }
                className="flex w-full flex-col items-start justify-between gap-3 pb-3 text-left sm:flex-row sm:items-center"
              >
                <div>
                  <p className="eyebrow mb-1">Category</p>
                  <h3 className="font-[var(--font-display)] text-xl font-semibold tracking-[-0.04em] text-[var(--text-strong)]">
                    {categoryName}
                  </h3>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="rounded-full border border-[var(--line)] bg-[rgba(255,255,255,0.04)] px-3 py-1 text-xs text-[var(--text-muted)]">
                    {categorySounds.length} pads
                  </span>
                  <span className="rounded-full border border-[var(--line)] px-3 py-1 text-xs text-[var(--text-muted)]">
                    {expanded[categoryName] ? 'Collapse' : 'Expand'}
                  </span>
                </div>
              </button>

              {expanded[categoryName] && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                  {categorySounds.map((sound) => (
                    <div
                      key={sound.filename}
                      onContextMenu={(event) => openContextMenu(event, sound)}
                      onClick={() => void handleButtonClick(sound.filename, false, () => undefined)}
                      className="group relative overflow-hidden rounded-[1.45rem] border border-[var(--line)] bg-[linear-gradient(180deg,rgba(16,26,38,0.95),rgba(10,16,24,0.95))] p-4 text-left transition duration-200 hover:-translate-y-0.5 hover:border-[rgba(45,212,191,0.28)] hover:shadow-[0_18px_40px_rgba(0,0,0,0.35)]"
                    >
                      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,rgba(45,212,191,0.55),transparent)] opacity-0 transition group-hover:opacity-100" />
                      <div className="flex items-start justify-between gap-3">
                        <button
                          type="button"
                          draggable
                          onDragStart={(event) => {
                            event.stopPropagation();
                            event.dataTransfer.setData('filename', sound.filename);
                          }}
                          onClick={(event) => event.stopPropagation()}
                          className="flex h-11 w-11 cursor-grab items-center justify-center rounded-2xl border border-[rgba(45,212,191,0.18)] bg-[rgba(45,212,191,0.1)] text-[var(--accent)] active:cursor-grabbing"
                        >
                          <GripVertical size={18} />
                        </button>
                        <button
                          type="button"
                          onClick={(event) => openContextMenu(event, sound)}
                          onPointerDown={(event) => event.stopPropagation()}
                          onMouseDown={(event) => event.stopPropagation()}
                          onContextMenu={(event) => openContextMenu(event, sound)}
                          className="rounded-full border border-transparent p-2 text-[var(--text-muted)] opacity-100 transition hover:border-[var(--line)] hover:text-[var(--text-strong)] md:opacity-0 md:group-hover:opacity-100"
                        >
                          <MoreHorizontal size={16} />
                        </button>
                      </div>

                      <div className="mt-6">
                        <p className="line-clamp-2 text-sm font-medium text-[var(--text-strong)]">
                          {sound.name}
                        </p>
                        <p className="mt-2 text-xs text-[var(--text-muted)]">
                          Click to fire instantly
                        </p>
                      </div>

                      {hotkeys[sound.filename] && (
                        <span className="mt-5 inline-flex rounded-full border border-[rgba(245,158,11,0.25)] bg-[rgba(245,158,11,0.12)] px-2.5 py-1 text-[11px] font-medium text-[var(--warm)]">
                          {hotkeys[sound.filename].replace('CommandOrControl', 'CTRL')}
                        </span>
                      )}
                    </div>
                  ))}

                  <label className="flex min-h-[12rem] cursor-pointer flex-col items-center justify-center rounded-[1.45rem] border border-dashed border-[var(--line-strong)] bg-[rgba(255,255,255,0.02)] px-4 text-center transition hover:border-[rgba(45,212,191,0.35)] hover:bg-[rgba(45,212,191,0.05)]">
                    <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-[rgba(45,212,191,0.18)] bg-[rgba(45,212,191,0.1)] text-[var(--accent)]">
                      <UploadCloud size={18} />
                    </div>
                    <p className="text-sm font-medium text-[var(--text-strong)]">
                      Add files to {categoryName}
                    </p>
                    <p className="mt-1 text-xs text-[var(--text-muted)]">
                      Supports MP3, WAV, M4A, and OGG
                    </p>
                    <input
                      type="file"
                      accept={SUPPORTED_UPLOAD_TYPES}
                      className="hidden"
                      onChange={(event) => {
                        if (event.target.files?.length) {
                          void uploadFiles(event.target.files, categoryName);
                        }
                      }}
                    />
                  </label>
                </div>
              )}
            </section>
          ))}
        </div>
      ) : (
        <section className="panel-surface flex min-h-[18rem] flex-col items-center justify-center p-8 text-center">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-[1.5rem] border border-[rgba(45,212,191,0.2)] bg-[rgba(45,212,191,0.08)] text-[var(--accent)]">
            <UploadCloud size={24} />
          </div>
          <h3 className="font-[var(--font-display)] text-2xl font-semibold tracking-[-0.04em] text-[var(--text-strong)]">
            Your soundboard is ready for its first drop.
          </h3>
          <p className="mt-2 max-w-md text-sm text-[var(--text-muted)]">
            Drag audio files into the app or create a fresh category to start building a polished
            on-air library.
          </p>
        </section>
      )}

      {contextMenu &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed inset-0 z-[240]"
            onMouseDown={() => setContextMenu(null)}
            onContextMenu={(event) => event.preventDefault()}
          >
            <div
              className="absolute w-60 overflow-hidden rounded-[1.35rem] border border-[var(--line-strong)] bg-[rgba(10,18,28,0.96)] p-2 shadow-[0_30px_80px_rgba(0,0,0,0.45)] backdrop-blur-xl"
              style={{ top: contextMenu.y, left: contextMenu.x }}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="border-b border-[var(--line)] px-3 py-2">
                <p className="eyebrow mb-1">Sound Actions</p>
                <p className="truncate text-sm text-[var(--text-strong)]">{contextMenu.name}</p>
              </div>

              <button
                type="button"
                onClick={() => {
                  setBindingTarget(contextMenu.file);
                  setContextMenu(null);
                }}
                className="menu-action"
              >
                <Keyboard size={16} />
                Set Hotkey
              </button>

              {hotkeys[contextMenu.file] && (
                <button
                  type="button"
                  onClick={() => {
                    saveHotkey(contextMenu.file, null);
                    setContextMenu(null);
                  }}
                  className="menu-action"
                >
                  <X size={16} />
                  Clear Hotkey
                </button>
              )}

              <button
                type="button"
                onClick={() => {
                  setTargetFile(contextMenu.file);
                  setRenameValue(contextMenu.name);
                  setShowRenameModal(true);
                  setContextMenu(null);
                }}
                className="menu-action"
              >
                <PencilLine size={16} />
                Rename
              </button>

              <button
                type="button"
                onClick={() => {
                  const sound =
                    Object.values(library)
                      .flat()
                      .find((item) => item.filename === contextMenu.file) ?? null;
                  setDeleteTarget(sound);
                  setContextMenu(null);
                }}
                className="menu-action text-[var(--danger)] hover:bg-[rgba(244,63,94,0.14)] hover:text-[var(--danger)]"
              >
                <Trash2 size={16} />
                Delete
              </button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

'use client';

import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  Folder,
  FolderPlus,
  GripVertical,
  Home,
  Keyboard,
  ListMusic,
  MoreHorizontal,
  PencilLine,
  Plus,
  Search,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react';
import {
  Fragment,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import type { SoundFile, SoundLibraryState } from '@/context/AudioContext';
import { useAudio } from '@/context/AudioContext';
import {
  formatDuration,
  formatLoudness,
  useSoundMetrics,
  type SoundMetrics,
} from '@/lib/sound-metrics';

type SortMode =
  | 'name-asc'
  | 'name-desc'
  | 'date-newest'
  | 'date-oldest'
  | 'length-longest'
  | 'length-shortest'
  | 'loud-loudest'
  | 'loud-quietest';

const SORT_OPTIONS: Array<{ value: SortMode; label: string }> = [
  { value: 'name-asc', label: 'Name (A → Z)' },
  { value: 'name-desc', label: 'Name (Z → A)' },
  { value: 'date-newest', label: 'Newest first' },
  { value: 'date-oldest', label: 'Oldest first' },
  { value: 'length-longest', label: 'Longest first' },
  { value: 'length-shortest', label: 'Shortest first' },
  { value: 'loud-loudest', label: 'Loudest first' },
  { value: 'loud-quietest', label: 'Quietest first' },
];

const SORT_STORAGE_KEY = 'jawdio-library-sort';

/**
 * Pick the sort comparator. Metric-based sorts push unmeasured pads to the end
 * so a fresh library never looks "empty" before analysis completes.
 */
const sortSounds = (
  sounds: SoundFile[],
  mode: SortMode,
  metrics: Map<string, SoundMetrics>,
): SoundFile[] => {
  const copy = sounds.slice();
  const getDur = (s: SoundFile) => metrics.get(s.filename)?.durationSec;
  const getLoud = (s: SoundFile) => metrics.get(s.filename)?.loudnessDb;
  const tieByName = (a: SoundFile, b: SoundFile) => a.name.localeCompare(b.name);

  copy.sort((a, b) => {
    switch (mode) {
      case 'name-asc':
        return tieByName(a, b);
      case 'name-desc':
        return tieByName(b, a);
      case 'date-newest':
        return (b.createdAt ?? 0) - (a.createdAt ?? 0) || tieByName(a, b);
      case 'date-oldest':
        return (a.createdAt ?? 0) - (b.createdAt ?? 0) || tieByName(a, b);
      case 'length-longest': {
        const da = getDur(a);
        const db = getDur(b);
        if (da === undefined && db === undefined) return tieByName(a, b);
        if (da === undefined) return 1;
        if (db === undefined) return -1;
        return db - da || tieByName(a, b);
      }
      case 'length-shortest': {
        const da = getDur(a);
        const db = getDur(b);
        if (da === undefined && db === undefined) return tieByName(a, b);
        if (da === undefined) return 1;
        if (db === undefined) return -1;
        return da - db || tieByName(a, b);
      }
      case 'loud-loudest': {
        const la = getLoud(a);
        const lb = getLoud(b);
        if (la === undefined && lb === undefined) return tieByName(a, b);
        if (la === undefined) return 1;
        if (lb === undefined) return -1;
        return lb - la || tieByName(a, b);
      }
      case 'loud-quietest': {
        const la = getLoud(a);
        const lb = getLoud(b);
        if (la === undefined && lb === undefined) return tieByName(a, b);
        if (la === undefined) return 1;
        if (lb === undefined) return -1;
        return la - lb || tieByName(a, b);
      }
      default:
        return tieByName(a, b);
    }
  });
  return copy;
};

interface ContextMenuState {
  x: number;
  y: number;
  file: string;
  name: string;
  category: string;
  view: 'actions' | 'move';
}

interface FolderMenuState {
  x: number;
  y: number;
  path: string;
  name: string;
  view: 'actions' | 'move';
}

const SUPPORTED_UPLOAD_TYPES = '.mp3,.wav,.m4a,.ogg';

/**
 * Recursive folder node used to render the library as a file-tree. Each node
 * holds the slash-path that identifies it on disk, the leaf name we display,
 * the sounds directly inside, and any child folders. The "Uncategorized"
 * folder is a regular top-level child (sorted first by convention).
 */
interface FolderNode {
  path: string;
  name: string;
  depth: number;
  sounds: SoundFile[];
  children: FolderNode[];
}

const buildFolderTree = (library: SoundLibraryState): FolderNode => {
  const root: FolderNode = {
    path: '',
    name: '',
    depth: -1,
    sounds: [],
    children: [],
  };

  const ensureFolder = (folderPath: string): FolderNode => {
    if (!folderPath) return root;

    const segments = folderPath.split('/').filter(Boolean);
    let current = root;
    let cumulative = '';

    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      cumulative = cumulative ? `${cumulative}/${segment}` : segment;
      let child = current.children.find((node) => node.path === cumulative);
      if (!child) {
        child = {
          path: cumulative,
          name: segment,
          depth: i,
          sounds: [],
          children: [],
        };
        current.children.push(child);
      }
      current = child;
    }

    return current;
  };

  for (const [folderPath, sounds] of Object.entries(library)) {
    const node = ensureFolder(folderPath);
    node.sounds = sounds;
  }

  const sortChildren = (node: FolderNode) => {
    node.children.sort((a, b) => {
      if (a.path === 'Uncategorized') return -1;
      if (b.path === 'Uncategorized') return 1;
      return a.name.localeCompare(b.name);
    });
    node.children.forEach(sortChildren);
  };
  sortChildren(root);

  return root;
};

/**
 * Flatten the tree into a single ordered list of folder descriptors. Used by
 * the Move-to picker to render every destination as an indented row without
 * having to manage a sub-menu component.
 */
const flattenFolders = (root: FolderNode): Array<{ path: string; depth: number; name: string }> => {
  const out: Array<{ path: string; depth: number; name: string }> = [];
  const walk = (node: FolderNode) => {
    for (const child of node.children) {
      out.push({ path: child.path, depth: child.depth, name: child.name });
      walk(child);
    }
  };
  walk(root);
  return out;
};

/**
 * Short "saved X ago" label for pad chips. Returns null when the timestamp
 * is missing or too old to display compactly (over ~30 days we just give up
 * and show nothing).
 */
const formatRelativeSavedAt = (timestamp: number | undefined, now: number): string | null => {
  if (!timestamp || !Number.isFinite(timestamp)) return null;
  const deltaMs = Math.max(0, now - timestamp);
  const seconds = Math.round(deltaMs / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days <= 30) return `${days}d ago`;
  return null;
};

export default function AudioLibrary({
  variant = 'panel',
}: {
  variant?: 'panel' | 'page';
}) {
  const {
    soundLibrary,
    refreshSoundLibrary,
    handleButtonClick,
    handleDeleteSound,
    hotkeys,
    setHotkeys,
  } = useAudio();

  const [searchQuery, setSearchQuery] = useState('');
  const deferredSearchQuery = useDeferredValue(searchQuery);

  const [isDraggingExternal, setIsDraggingExternal] = useState(false);
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [renameValue, setRenameValue] = useState('');
  const [targetFile, setTargetFile] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SoundFile | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [folderMenu, setFolderMenu] = useState<FolderMenuState | null>(null);
  const [folderDeleteTarget, setFolderDeleteTarget] = useState<{
    path: string;
    name: string;
  } | null>(null);
  const [bindingTarget, setBindingTarget] = useState<string | null>(null);
  // Organize mode flips pad taps from "play" to "open menu" — critical on
  // touch devices where there's no right-click and HTML5 drag-and-drop is
  // unreliable.
  const [isOrganizing, setIsOrganizing] = useState(false);
  // File-explorer navigation: the empty string is the soundboard root. Click
  // a folder to push its path here; the breadcrumb / Up button rewinds it.
  const [currentPath, setCurrentPath] = useState<string>('');
  // Wall-clock tick so "saved X ago" badges stay current. We bump it every
  // 30 seconds, which is dense enough that minute boundaries don't visibly
  // lag and sparse enough that the render churn is negligible.
  const [nowMs, setNowMs] = useState(() => Date.now());
  // Active sort mode for pad lists (both folder view and search results). We
  // persist it so the user's preference survives reloads.
  const [sortMode, setSortMode] = useState<SortMode>('name-asc');

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(SORT_STORAGE_KEY);
      if (stored && SORT_OPTIONS.some((opt) => opt.value === stored)) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSortMode(stored as SortMode);
      }
    } catch {}
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(SORT_STORAGE_KEY, sortMode);
    } catch {}
  }, [sortMode]);

  // Flat filename list of every sound in the library, used to lazily decode
  // each file once for duration + loudness metrics.
  const allSoundFilenames = useMemo(
    () =>
      Object.values(soundLibrary)
        .flat()
        .map((sound) => sound.filename),
    [soundLibrary],
  );
  const soundMetrics = useSoundMetrics(allSoundFilenames);

  const dragDepthRef = useRef(0);
  const isPage = variant === 'page';
  const library = soundLibrary;

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

      await refreshSoundLibrary();
    },
    [refreshSoundLibrary],
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
    if (!contextMenu && !folderMenu) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setContextMenu(null);
        setFolderMenu(null);
      }
    };

    window.addEventListener('keydown', handleEscape);

    return () => {
      window.removeEventListener('keydown', handleEscape);
    };
  }, [contextMenu, folderMenu]);

  // Build the folder tree once from the unfiltered library so the navigation
  // model (current folder, breadcrumbs) is stable when the user types into
  // search. Search results are computed separately as a flat match list.
  const fullTree = useMemo(() => buildFolderTree(library), [library]);
  const allFolders = useMemo(() => flattenFolders(fullTree), [fullTree]);
  const hasAnyFolder = fullTree.children.length > 0;
  const totalSounds = Object.values(library).reduce((sum, items) => sum + items.length, 0);
  const totalCategories = Object.keys(library).length;

  // Resolve the currently-navigated folder by walking the tree. If the saved
  // path no longer exists (e.g. user deleted the folder we were inside), fall
  // back to the root so the UI doesn't go blank.
  const currentNode = useMemo(() => {
    if (!currentPath) return fullTree;

    const segments = currentPath.split('/').filter(Boolean);
    let node: FolderNode | undefined = fullTree;

    for (const segment of segments) {
      node = node?.children.find(
        (child) => child.name === segment || child.path === segment,
      );
      if (!node) return null;
    }

    return node ?? null;
  }, [currentPath, fullTree]);

  // If the current folder vanished (e.g. it was deleted from the host), bounce
  // back to the root automatically. The setState-in-effect is intentional here:
  // we need a render to commit before we can detect "this folder no longer
  // exists in the library" and reroute.
  useEffect(() => {
    if (currentPath && !currentNode) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCurrentPath('');
    }
  }, [currentNode, currentPath]);

  // Breadcrumb segments — clickable steps from root to the current folder.
  const breadcrumbs = useMemo(() => {
    if (!currentPath) return [] as Array<{ label: string; path: string }>;
    const segments = currentPath.split('/').filter(Boolean);
    return segments.map((segment, index) => ({
      label: segment,
      path: segments.slice(0, index + 1).join('/'),
    }));
  }, [currentPath]);

  // Search override: when the user types a query, show a flat list of every
  // matching pad from anywhere in the tree (not just the current folder).
  // Folder cards disappear while searching so the result list isn't crowded.
  const normalizedSearchQuery = deferredSearchQuery.trim().toLowerCase();
  const isSearching = normalizedSearchQuery.length > 0;
  const searchMatches = useMemo(() => {
    if (!isSearching) return [] as SoundFile[];
    const matches: SoundFile[] = [];
    for (const folderSounds of Object.values(library)) {
      for (const sound of folderSounds) {
        if (sound.name.toLowerCase().includes(normalizedSearchQuery)) {
          matches.push(sound);
        }
      }
    }
    return sortSounds(matches, sortMode, soundMetrics);
  }, [isSearching, library, normalizedSearchQuery, sortMode, soundMetrics]);

  // Sorted view of whatever sounds live in the currently-navigated folder.
  // Folders inside the current node keep their existing alphabetical order
  // because they don't carry length/loudness metrics of their own.
  const sortedCurrentSounds = useMemo(
    () => (currentNode ? sortSounds(currentNode.sounds, sortMode, soundMetrics) : []),
    [currentNode, sortMode, soundMetrics],
  );
  const boardGridClassName = isPage
    ? 'grid gap-1.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6'
    : 'grid gap-1.5 [grid-template-columns:repeat(auto-fit,minmax(6.5rem,1fr))]';

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
    await refreshSoundLibrary();
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
    await refreshSoundLibrary();
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

    await refreshSoundLibrary();
  };

  const handleDeleteConfirmed = async () => {
    if (!deleteTarget) {
      return;
    }

    try {
      await handleDeleteSound(deleteTarget.filename);
      setDeleteTarget(null);
    } catch (error) {
      console.error(error);
      alert('Delete failed.');
    }
  };

  const openContextMenu = (
    event: React.MouseEvent<HTMLElement>,
    sound: SoundFile,
  ) => {
    event.preventDefault();
    event.stopPropagation();

    const menuWidth = 264;
    const menuHeight = 280;
    const nextX = Math.min(event.clientX, window.innerWidth - menuWidth - 20);
    const nextY = Math.min(event.clientY, window.innerHeight - menuHeight - 20);

    setContextMenu({
      x: Math.max(16, nextX),
      y: Math.max(16, nextY),
      file: sound.filename,
      name: sound.name,
      category: sound.category,
      view: 'actions',
    });
  };

  const openFolderMenu = (
    event: React.MouseEvent<HTMLElement>,
    folder: FolderNode,
  ) => {
    event.preventDefault();
    event.stopPropagation();

    const menuWidth = 272;
    const menuHeight = 280;
    const nextX = Math.min(event.clientX, window.innerWidth - menuWidth - 20);
    const nextY = Math.min(event.clientY, window.innerHeight - menuHeight - 20);

    setFolderMenu({
      x: Math.max(16, nextX),
      y: Math.max(16, nextY),
      path: folder.path,
      name: folder.name,
      view: 'actions',
    });
  };

  const renameFolder = useCallback(
    async (path: string, newName: string) => {
      const trimmedName = newName.trim();
      if (!trimmedName) return;

      const response = await fetch('/api/sounds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'RENAME_CATEGORY', path, newName: trimmedName }),
      });

      if (!response.ok) {
        const error = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        alert(error?.error ?? 'Folder rename failed.');
        return;
      }

      // If the renamed folder was on the navigation path, rebuild currentPath
      // so the user stays "inside" it rather than getting bounced to root.
      setCurrentPath((current) => {
        if (!current) return current;
        const segments = current.split('/').filter(Boolean);
        const targetSegments = path.split('/').filter(Boolean);
        if (
          targetSegments.every((seg, idx) => segments[idx] === seg)
        ) {
          segments[targetSegments.length - 1] = trimmedName;
          return segments.join('/');
        }
        return current;
      });

      await refreshSoundLibrary();
    },
    [refreshSoundLibrary],
  );

  const moveFolderToParent = useCallback(
    async (fromPath: string, toParentPath: string) => {
      const response = await fetch('/api/sounds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'MOVE_CATEGORY',
          fromPath,
          toParentPath,
        }),
      });

      if (!response.ok) {
        const error = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        alert(error?.error ?? 'Folder move failed.');
        return;
      }

      // If we were inside the folder that got moved, rewrite currentPath to
      // its new home so navigation isn't lost.
      setCurrentPath((current) => {
        if (!current) return current;
        const leaf = fromPath.split('/').pop() ?? fromPath;
        const newPath =
          toParentPath === 'Uncategorized' || !toParentPath
            ? leaf
            : `${toParentPath}/${leaf}`;
        if (current === fromPath) return newPath;
        if (current.startsWith(`${fromPath}/`)) {
          return `${newPath}${current.slice(fromPath.length)}`;
        }
        return current;
      });

      await refreshSoundLibrary();
    },
    [refreshSoundLibrary],
  );

  const deleteFolder = useCallback(
    async (path: string) => {
      const response = await fetch('/api/sounds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'DELETE_CATEGORY', name: path }),
      });

      if (!response.ok) {
        const error = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        alert(error?.error ?? 'Folder delete failed.');
        return;
      }

      // If we were inside the now-gone folder, step back to its parent so
      // the next render has a valid currentPath.
      setCurrentPath((current) => {
        if (!current) return current;
        if (current === path || current.startsWith(`${path}/`)) {
          const segments = path.split('/').filter(Boolean);
          segments.pop();
          return segments.join('/');
        }
        return current;
      });

      await refreshSoundLibrary();
    },
    [refreshSoundLibrary],
  );

  const moveSoundToCategory = useCallback(
    async (filename: string, toCategory: string) => {
      const response = await fetch('/api/sounds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'MOVE_SOUND', filename, toCategory }),
      });

      if (!response.ok) {
        const error = (await response.json().catch(() => null)) as { error?: string } | null;
        alert(error?.error ?? 'Sound move failed.');
        return;
      }

      await refreshSoundLibrary();
    },
    [refreshSoundLibrary],
  );

  const createCategoryAndMove = useCallback(
    async (filename: string, name: string) => {
      const trimmedName = name.trim();
      if (!trimmedName) return;

      const createResponse = await fetch('/api/sounds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'CREATE_CATEGORY', name: trimmedName }),
      });

      if (!createResponse.ok) {
        const error = (await createResponse.json().catch(() => null)) as
          | { error?: string }
          | null;
        alert(error?.error ?? 'Category creation failed.');
        return;
      }

      await moveSoundToCategory(filename, trimmedName);
    },
    [moveSoundToCategory],
  );

  /**
   * Renders a single sound pad card. Shared between the current-folder view
   * and the cross-tree search results.
   */
  const renderPad = (sound: SoundFile, opts: { showPath?: boolean } = {}) => (
    <div
      key={sound.filename}
      onContextMenu={(event) => openContextMenu(event, sound)}
      onClick={(event) => {
        if (isOrganizing) {
          openContextMenu(event, sound);
          return;
        }
        void handleButtonClick(sound.filename, false, () => undefined);
      }}
      title={sound.name}
      className={`sound-pad group ${
        isOrganizing
          ? 'border-[rgba(62,162,230,0.45)] shadow-[0_0_0_1px_rgba(62,162,230,0.25)_inset]'
          : ''
      }`}
    >
      <div className="flex items-start justify-between gap-1.5">
        <button
          type="button"
          draggable
          onDragStart={(event) => {
            event.stopPropagation();
            event.dataTransfer.setData('filename', sound.filename);
          }}
          onClick={(event) => event.stopPropagation()}
          title="Drag to move between folders"
          className="flex h-6 w-6 shrink-0 cursor-grab items-center justify-center rounded-md border border-[rgba(62,162,230,0.22)] bg-[rgba(62,162,230,0.1)] text-[var(--accent)] active:cursor-grabbing"
        >
          <GripVertical size={11} />
        </button>
        <button
          type="button"
          onClick={(event) => openContextMenu(event, sound)}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => openContextMenu(event, sound)}
          title="More actions"
          className="rounded-md border border-transparent p-1 text-[var(--text-muted)] transition hover:border-[var(--line)] hover:text-[var(--text-strong)]"
        >
          <MoreHorizontal size={12} />
        </button>
      </div>

      <div className="mt-auto">
        <p className="line-clamp-2 text-[11.5px] font-medium leading-[1.15] text-[var(--text-strong)]">
          {sound.name}
        </p>
        {opts.showPath && sound.category && sound.category !== 'Uncategorized' && (
          <p className="mt-0.5 truncate text-[9.5px] text-[var(--text-muted)]" title={sound.category}>
            in {sound.category}
          </p>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {hotkeys[sound.filename] && (
            <span className="inline-flex rounded border border-[rgba(246,196,75,0.3)] bg-[rgba(246,196,75,0.12)] px-1.5 py-[1px] text-[9px] font-medium tracking-[0.04em] text-[var(--warm)]">
              {hotkeys[sound.filename].replace('CommandOrControl', 'CTRL')}
            </span>
          )}
          {(() => {
            const metric = soundMetrics.get(sound.filename);
            if (!metric) return null;
            return (
              <>
                <span
                  className="inline-flex rounded border border-[rgba(62,162,230,0.3)] bg-[rgba(62,162,230,0.1)] px-1.5 py-[1px] text-[9px] font-medium tracking-[0.02em] text-[var(--accent)]"
                  title={`Length: ${metric.durationSec.toFixed(2)}s`}
                >
                  {formatDuration(metric.durationSec)}
                </span>
                <span
                  className="inline-flex rounded border border-[rgba(155,212,255,0.3)] bg-[rgba(155,212,255,0.08)] px-1.5 py-[1px] text-[9px] font-medium tracking-[0.02em] text-[var(--text-strong)]"
                  title={`Loudness (RMS): ${formatLoudness(metric.loudnessDb)}`}
                >
                  {formatLoudness(metric.loudnessDb)}
                </span>
              </>
            );
          })()}
          {(() => {
            const stamp = formatRelativeSavedAt(sound.createdAt, nowMs);
            return stamp ? (
              <span
                className="inline-flex rounded border border-[var(--line)] bg-[rgba(255,255,255,0.04)] px-1.5 py-[1px] text-[9px] font-medium tracking-[0.02em] text-[var(--text-muted)]"
                title={
                  sound.createdAt
                    ? new Date(sound.createdAt).toLocaleString()
                    : undefined
                }
              >
                {stamp}
              </span>
            ) : null;
          })()}
        </div>
      </div>
    </div>
  );

  /**
   * Folder card — visually a sibling of a pad card but with a folder icon
   * and total counts. Tap to navigate into the folder.
   */
  const renderFolderCard = (folder: FolderNode) => {
    const padCount = folder.sounds.length;
    const subCount = folder.children.length;

    return (
      <div
        key={folder.path}
        onClick={() => setCurrentPath(folder.path)}
        onContextMenu={(event) => openFolderMenu(event, folder)}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => void handleDropOnCategory(event, folder.path)}
        title={`Open ${folder.path}`}
        className="sound-pad group items-stretch cursor-pointer border-[rgba(62,162,230,0.32)] bg-[linear-gradient(180deg,rgba(20,52,86,0.92),rgba(10,28,48,0.92))]"
      >
        <div className="flex items-start justify-between gap-1.5">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-[rgba(62,162,230,0.32)] bg-[rgba(62,162,230,0.18)] text-[var(--accent)]">
            <Folder size={12} />
          </span>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={(event) => openFolderMenu(event, folder)}
              onContextMenu={(event) => openFolderMenu(event, folder)}
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              title="Folder actions"
              className="rounded-md border border-transparent p-1 text-[var(--text-muted)] transition hover:border-[var(--line)] hover:text-[var(--text-strong)]"
            >
              <MoreHorizontal size={12} />
            </button>
            <ChevronRight size={12} className="text-[var(--text-muted)]" />
          </div>
        </div>

        <div className="mt-auto text-left">
          <p className="line-clamp-2 text-[11.5px] font-medium leading-[1.15] text-[var(--text-strong)]">
            {folder.name}
          </p>
          <p className="mt-0.5 text-[9.5px] text-[var(--text-muted)]">
            {padCount} pad{padCount === 1 ? '' : 's'}
            {subCount > 0 ? ` · ${subCount} folder${subCount === 1 ? '' : 's'}` : ''}
          </p>
        </div>
      </div>
    );
  };

  return (
    <div className={isPage ? 'space-y-3 pb-6' : 'space-y-2.5 pb-8'}>
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
            <p className="eyebrow mb-3">New Folder</p>
            <h3 className="font-[var(--font-display)] text-2xl font-semibold tracking-[-0.04em] text-[var(--text-strong)]">
              Add a new folder to the board.
            </h3>
            <p className="mt-2 text-sm text-[var(--text-muted)]">
              Use <span className="text-[var(--text-strong)]">/</span> to nest — for example{' '}
              <code className="rounded bg-[rgba(255,255,255,0.06)] px-1 py-[1px] text-[11px]">
                Drops/Air horns
              </code>{' '}
              creates an &ldquo;Air horns&rdquo; folder inside a parent &ldquo;Drops&rdquo; folder.
            </p>
            <input
              type="text"
              value={newCategoryName}
              onChange={(event) => setNewCategoryName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  void handleCreateCategory();
                }
              }}
              placeholder="Drops/Air horns"
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

      {isPage ? (
        <section className="panel-surface relative overflow-hidden p-3 sm:p-4">
          <div className="relative flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-[var(--font-display)] text-base font-semibold tracking-[-0.03em] text-[var(--text-strong)]">
                Soundboard
              </h2>
              <span className="metric-label">
                {totalSounds} pads · {totalCategories} categories
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="search-shell min-w-[12rem] flex-1">
                <Search size={14} className="text-[var(--text-muted)]" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Search pads"
                  className="search-field"
                />
              </div>
              <label
                className="ghost-button cursor-pointer px-2 py-1.5"
                title="Sort pads"
              >
                <ListMusic size={13} />
                <select
                  value={sortMode}
                  onChange={(event) => setSortMode(event.target.value as SortMode)}
                  className="cursor-pointer bg-transparent text-[12px] font-medium text-[var(--text-strong)] outline-none"
                >
                  {SORT_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value} className="bg-[var(--bg)] text-[var(--text-strong)]">
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={() => setIsOrganizing((value) => !value)}
                title={isOrganizing ? 'Tap pads to manage them' : 'Tap pads to play them'}
                className={`ghost-button ${
                  isOrganizing
                    ? 'border-[rgba(62,162,230,0.45)] bg-[rgba(62,162,230,0.14)] text-[var(--accent)]'
                    : ''
                }`}
              >
                <ListMusic size={13} />
                {isOrganizing ? 'Done' : 'Organize'}
              </button>
              <button
                type="button"
                onClick={() => setShowCategoryModal(true)}
                className="ghost-button"
              >
                <FolderPlus size={13} />
                Category
              </button>
            </div>
          </div>
        </section>
      ) : (
        <section className="panel-surface overflow-hidden p-2.5">
          <div className="flex items-center gap-2">
            <div className="search-shell min-w-0 flex-1">
              <Search size={13} className="text-[var(--text-muted)]" />
              <input
                type="text"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search pads"
                className="search-field text-[13px]"
              />
            </div>
            <label
              className="ghost-button shrink-0 cursor-pointer px-1.5 py-1.5"
              title="Sort pads"
            >
              <select
                value={sortMode}
                onChange={(event) => setSortMode(event.target.value as SortMode)}
                className="cursor-pointer bg-transparent text-[12px] font-medium text-[var(--text-strong)] outline-none"
              >
                {SORT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value} className="bg-[var(--bg)] text-[var(--text-strong)]">
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => setIsOrganizing((value) => !value)}
              title={isOrganizing ? 'Tap pads to manage them' : 'Tap pads to play them'}
              className={`ghost-button shrink-0 px-2 py-1.5 ${
                isOrganizing
                  ? 'border-[rgba(62,162,230,0.45)] bg-[rgba(62,162,230,0.14)] text-[var(--accent)]'
                  : ''
              }`}
            >
              <ListMusic size={13} />
            </button>
            <button
              type="button"
              onClick={() => setShowCategoryModal(true)}
              title="New category"
              className="ghost-button shrink-0 px-2 py-1.5"
            >
              <FolderPlus size={13} />
            </button>
          </div>
        </section>
      )}

      {isOrganizing && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-[rgba(62,162,230,0.4)] bg-[rgba(62,162,230,0.1)] px-3 py-2 text-xs text-[var(--accent)]">
          <span>
            Organize mode: tapping a pad opens its menu instead of playing the sound.
          </span>
          <button
            type="button"
            onClick={() => setIsOrganizing(false)}
            className="rounded-md border border-[rgba(62,162,230,0.4)] px-2 py-[2px] text-[11px] font-semibold text-[var(--accent)]"
          >
            Done
          </button>
        </div>
      )}

      {isSearching ? (
        <section className={`panel-surface ${isPage ? 'p-2.5' : 'p-2'}`}>
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-sm font-semibold tracking-[-0.02em] text-[var(--text-strong)]">
              Search results
            </p>
            <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--text-muted)]">
              {searchMatches.length} match{searchMatches.length === 1 ? '' : 'es'}
            </span>
          </div>
          {searchMatches.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-[var(--text-muted)]">
              No pads match &ldquo;{searchQuery}&rdquo;.
            </p>
          ) : (
            <div className={boardGridClassName}>
              {searchMatches.map((sound) => renderPad(sound, { showPath: true }))}
            </div>
          )}
        </section>
      ) : currentNode ? (
        <section
          className={`panel-surface ${isPage ? 'p-2.5' : 'p-2'}`}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) =>
            void handleDropOnCategory(event, currentNode.path || 'Uncategorized')
          }
        >
          {/* Breadcrumb header. */}
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setCurrentPath('')}
              title="Soundboard root"
              className={`flex items-center gap-1 rounded-md border px-1.5 py-1 text-[11px] font-medium transition ${
                currentPath
                  ? 'border-[var(--line)] bg-[rgba(255,255,255,0.04)] text-[var(--text-muted)] hover:text-[var(--text-strong)]'
                  : 'border-[rgba(62,162,230,0.35)] bg-[rgba(62,162,230,0.12)] text-[var(--text-strong)]'
              }`}
            >
              <Home size={11} />
              Soundboard
            </button>
            {breadcrumbs.map((crumb, index) => {
              const isCurrent = index === breadcrumbs.length - 1;
              return (
                <Fragment key={crumb.path}>
                  <ChevronRight size={11} className="text-[var(--text-muted)]" />
                  <button
                    type="button"
                    onClick={() => setCurrentPath(crumb.path)}
                    title={crumb.path}
                    className={`truncate rounded-md border px-1.5 py-1 text-[11px] font-medium transition ${
                      isCurrent
                        ? 'border-[rgba(62,162,230,0.35)] bg-[rgba(62,162,230,0.12)] text-[var(--text-strong)]'
                        : 'border-[var(--line)] bg-[rgba(255,255,255,0.04)] text-[var(--text-muted)] hover:text-[var(--text-strong)]'
                    }`}
                  >
                    {crumb.label}
                  </button>
                </Fragment>
              );
            })}
            <span className="ml-auto text-[10px] uppercase tracking-[0.14em] text-[var(--text-muted)]">
              {currentNode.children.length} folder
              {currentNode.children.length === 1 ? '' : 's'} ·{' '}
              {currentNode.sounds.length} pad
              {currentNode.sounds.length === 1 ? '' : 's'}
            </span>
          </div>

          {/* Up-one-folder shortcut, only when we're nested. */}
          {currentPath && (
            <button
              type="button"
              onClick={() => {
                const segments = currentPath.split('/').filter(Boolean);
                segments.pop();
                setCurrentPath(segments.join('/'));
              }}
              className="ghost-button mb-2 px-2 py-1 text-[11px]"
            >
              <ArrowLeft size={12} />
              Up to {breadcrumbs.length > 1 ? breadcrumbs[breadcrumbs.length - 2].label : 'Soundboard'}
            </button>
          )}

          {currentNode.children.length === 0 && currentNode.sounds.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-[var(--text-muted)]">
              This folder is empty. Drop audio here, or use the New Folder button to add a
              subfolder.
            </p>
          ) : (
            <div className={boardGridClassName}>
              {currentNode.children.map((folder) => renderFolderCard(folder))}
              {sortedCurrentSounds.map((sound) => renderPad(sound))}

              <label className="flex min-h-[4.6rem] cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed border-[var(--line-strong)] bg-[rgba(255,255,255,0.02)] px-2 py-2 text-center transition hover:border-[rgba(62,162,230,0.35)] hover:bg-[rgba(62,162,230,0.06)]">
                <div className="flex h-6 w-6 items-center justify-center rounded-md border border-[rgba(62,162,230,0.22)] bg-[rgba(62,162,230,0.1)] text-[var(--accent)]">
                  <UploadCloud size={12} />
                </div>
                <p className="text-[10.5px] font-medium text-[var(--text-strong)]">
                  Add to {currentNode.name || 'Soundboard'}
                </p>
                <input
                  type="file"
                  accept={SUPPORTED_UPLOAD_TYPES}
                  className="hidden"
                  onChange={(event) => {
                    if (event.target.files?.length) {
                      void uploadFiles(event.target.files, currentPath || 'Uncategorized');
                    }
                  }}
                />
              </label>
            </div>
          )}
        </section>
      ) : !hasAnyFolder ? (
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
      ) : null}

      {contextMenu &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed inset-0 z-[240]"
            onMouseDown={() => setContextMenu(null)}
            onContextMenu={(event) => event.preventDefault()}
          >
            <div
              className="absolute w-[17rem] max-h-[80vh] overflow-hidden rounded-[1rem] border border-[var(--line-strong)] bg-[rgba(10,18,28,0.97)] shadow-[0_30px_80px_rgba(0,0,0,0.45)] backdrop-blur-xl"
              style={{ top: contextMenu.y, left: contextMenu.x }}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-2 border-b border-[var(--line)] px-3 py-2.5">
                {contextMenu.view === 'move' && (
                  <button
                    type="button"
                    onClick={() =>
                      setContextMenu((current) =>
                        current ? { ...current, view: 'actions' } : current,
                      )
                    }
                    title="Back"
                    className="mt-0.5 rounded-md border border-[var(--line)] p-1 text-[var(--text-muted)] transition hover:text-[var(--text-strong)]"
                  >
                    <ArrowLeft size={13} />
                  </button>
                )}
                <div className="min-w-0 flex-1">
                  <p className="eyebrow mb-1">
                    {contextMenu.view === 'move' ? 'Move To' : 'Sound Actions'}
                  </p>
                  <p className="truncate text-sm text-[var(--text-strong)]">
                    {contextMenu.name}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setContextMenu(null)}
                  title="Close"
                  className="mt-0.5 rounded-md border border-transparent p-1 text-[var(--text-muted)] transition hover:border-[var(--line)] hover:text-[var(--text-strong)]"
                >
                  <X size={13} />
                </button>
              </div>

              {contextMenu.view === 'actions' && (
                <div className="p-2">
                  <button
                    type="button"
                    onClick={() =>
                      setContextMenu((current) =>
                        current ? { ...current, view: 'move' } : current,
                      )
                    }
                    className="menu-action"
                  >
                    <ListMusic size={16} />
                    Move to…
                    <ArrowRight
                      size={14}
                      className="ml-auto text-[var(--text-muted)]"
                    />
                  </button>

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
                    className="menu-action text-[var(--danger)] hover:bg-[rgba(229,115,115,0.18)] hover:text-[var(--danger)]"
                  >
                    <Trash2 size={16} />
                    Delete
                  </button>
                </div>
              )}

              {contextMenu.view === 'move' && (
                <div className="flex max-h-[60vh] flex-col overflow-y-auto p-2">
                  {allFolders.map((folder) => {
                    const isCurrent = folder.path === contextMenu.category;
                    // Indent nested folders so the picker reads as a tree.
                    const indent = `${0.25 + folder.depth * 0.75}rem`;
                    return (
                      <button
                        key={folder.path}
                        type="button"
                        disabled={isCurrent}
                        onClick={() => {
                          void moveSoundToCategory(contextMenu.file, folder.path);
                          setContextMenu(null);
                        }}
                        className={`menu-action ${
                          isCurrent ? 'cursor-not-allowed opacity-60' : ''
                        }`}
                        style={{ paddingLeft: indent }}
                        title={folder.path}
                      >
                        <ListMusic size={16} className="shrink-0" />
                        <span className="min-w-0 flex-1 truncate text-left">
                          {folder.name}
                        </span>
                        {isCurrent && (
                          <span className="ml-2 inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.14em] text-[var(--text-muted)]">
                            <Check size={11} />
                            here
                          </span>
                        )}
                      </button>
                    );
                  })}

                  <div className="my-1 border-t border-[var(--line)]" />

                  <button
                    type="button"
                    onClick={async () => {
                      const target = contextMenu;
                      const parentPath = target.category;
                      setContextMenu(null);
                      const promptName = window.prompt(
                        parentPath === 'Uncategorized' || !parentPath
                          ? 'New folder name (use "/" for nested, e.g. Drops/Air horns)'
                          : `New subfolder inside "${parentPath}"`,
                        '',
                      );
                      if (promptName && promptName.trim()) {
                        const fullPath =
                          parentPath && parentPath !== 'Uncategorized'
                            ? `${parentPath}/${promptName.trim()}`
                            : promptName.trim();
                        await createCategoryAndMove(target.file, fullPath);
                      }
                    }}
                    className="menu-action text-[var(--accent)]"
                  >
                    <Plus size={16} />
                    New folder…
                  </button>
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}

      {folderMenu &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed inset-0 z-[240]"
            onMouseDown={() => setFolderMenu(null)}
            onContextMenu={(event) => event.preventDefault()}
          >
            <div
              className="absolute max-h-[80vh] w-[17rem] overflow-hidden rounded-[1rem] border border-[var(--line-strong)] bg-[rgba(10,18,28,0.97)] shadow-[0_30px_80px_rgba(0,0,0,0.45)] backdrop-blur-xl"
              style={{ top: folderMenu.y, left: folderMenu.x }}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-2 border-b border-[var(--line)] px-3 py-2.5">
                {folderMenu.view === 'move' && (
                  <button
                    type="button"
                    onClick={() =>
                      setFolderMenu((current) =>
                        current ? { ...current, view: 'actions' } : current,
                      )
                    }
                    title="Back"
                    className="mt-0.5 rounded-md border border-[var(--line)] p-1 text-[var(--text-muted)] transition hover:text-[var(--text-strong)]"
                  >
                    <ArrowLeft size={13} />
                  </button>
                )}
                <div className="min-w-0 flex-1">
                  <p className="eyebrow mb-1">
                    {folderMenu.view === 'move' ? 'Move Folder Into' : 'Folder Actions'}
                  </p>
                  <p className="truncate text-sm text-[var(--text-strong)]" title={folderMenu.path}>
                    {folderMenu.path}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setFolderMenu(null)}
                  title="Close"
                  className="mt-0.5 rounded-md border border-transparent p-1 text-[var(--text-muted)] transition hover:border-[var(--line)] hover:text-[var(--text-strong)]"
                >
                  <X size={13} />
                </button>
              </div>

              {folderMenu.view === 'actions' && (
                <div className="p-2">
                  {folderMenu.path !== 'Uncategorized' && (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          const target = folderMenu;
                          setFolderMenu(null);
                          const next = window.prompt(
                            `Rename "${target.name}" to:`,
                            target.name,
                          );
                          if (next && next.trim()) {
                            void renameFolder(target.path, next.trim());
                          }
                        }}
                        className="menu-action"
                      >
                        <PencilLine size={16} />
                        Rename folder
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          setFolderMenu((current) =>
                            current ? { ...current, view: 'move' } : current,
                          )
                        }
                        className="menu-action"
                      >
                        <ListMusic size={16} />
                        Move folder to…
                        <ArrowRight
                          size={14}
                          className="ml-auto text-[var(--text-muted)]"
                        />
                      </button>
                    </>
                  )}

                  <button
                    type="button"
                    onClick={async () => {
                      const target = folderMenu;
                      setFolderMenu(null);
                      const name = window.prompt(
                        `New subfolder inside "${target.path}"`,
                        '',
                      );
                      if (name && name.trim()) {
                        await fetch('/api/sounds', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            action: 'CREATE_CATEGORY',
                            name:
                              target.path === 'Uncategorized'
                                ? name.trim()
                                : `${target.path}/${name.trim()}`,
                          }),
                        });
                        await refreshSoundLibrary();
                      }
                    }}
                    className="menu-action text-[var(--accent)]"
                  >
                    <Plus size={16} />
                    New subfolder…
                  </button>

                  {folderMenu.path !== 'Uncategorized' && (
                    <button
                      type="button"
                      onClick={() => {
                        const target = folderMenu;
                        setFolderMenu(null);
                        setFolderDeleteTarget({ path: target.path, name: target.name });
                      }}
                      className="menu-action text-[var(--danger)] hover:bg-[rgba(229,115,115,0.18)] hover:text-[var(--danger)]"
                    >
                      <Trash2 size={16} />
                      Delete folder
                    </button>
                  )}
                </div>
              )}

              {folderMenu.view === 'move' && (
                <div className="flex max-h-[60vh] flex-col overflow-y-auto p-2">
                  {/* Root option — represents moving the folder back to the top level. */}
                  {(() => {
                    const sourceParent = (() => {
                      const segs = folderMenu.path.split('/').filter(Boolean);
                      segs.pop();
                      return segs.join('/');
                    })();
                    const isCurrent = sourceParent === '';
                    return (
                      <button
                        key="__root"
                        type="button"
                        disabled={isCurrent}
                        onClick={() => {
                          void moveFolderToParent(folderMenu.path, 'Uncategorized');
                          setFolderMenu(null);
                        }}
                        className={`menu-action ${
                          isCurrent ? 'cursor-not-allowed opacity-60' : ''
                        }`}
                      >
                        <Home size={16} className="shrink-0" />
                        <span className="min-w-0 flex-1 truncate text-left">
                          Soundboard (root)
                        </span>
                        {isCurrent && (
                          <span className="ml-2 text-[10px] uppercase tracking-[0.14em] text-[var(--text-muted)]">
                            already here
                          </span>
                        )}
                      </button>
                    );
                  })()}

                  {allFolders
                    .filter((folder) => {
                      // Hide the folder being moved AND any of its descendants
                      // (moving into a descendant would orphan the subtree).
                      if (folder.path === folderMenu.path) return false;
                      if (folder.path.startsWith(`${folderMenu.path}/`)) return false;
                      // Also hide Uncategorized — it's covered by the root option above.
                      if (folder.path === 'Uncategorized') return false;
                      return true;
                    })
                    .map((folder) => {
                      // Mark the folder's current parent so the user sees where
                      // it lives now and can't pick the same destination.
                      const sourceParent = (() => {
                        const segs = folderMenu.path.split('/').filter(Boolean);
                        segs.pop();
                        return segs.join('/');
                      })();
                      const isCurrent = folder.path === sourceParent;
                      const indent = `${0.25 + folder.depth * 0.75}rem`;
                      return (
                        <button
                          key={folder.path}
                          type="button"
                          disabled={isCurrent}
                          onClick={() => {
                            void moveFolderToParent(folderMenu.path, folder.path);
                            setFolderMenu(null);
                          }}
                          className={`menu-action ${
                            isCurrent ? 'cursor-not-allowed opacity-60' : ''
                          }`}
                          style={{ paddingLeft: indent }}
                          title={folder.path}
                        >
                          <Folder size={16} className="shrink-0" />
                          <span className="min-w-0 flex-1 truncate text-left">
                            {folder.name}
                          </span>
                          {isCurrent && (
                            <span className="ml-2 text-[10px] uppercase tracking-[0.14em] text-[var(--text-muted)]">
                              already here
                            </span>
                          )}
                        </button>
                      );
                    })}
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}

      {folderDeleteTarget && (
        <div
          className="fixed inset-0 z-[250] flex items-center justify-center bg-[rgba(3,6,10,0.78)] p-6 backdrop-blur-lg"
          onClick={() => setFolderDeleteTarget(null)}
        >
          <div
            className="panel-surface w-full max-w-md p-8"
            onClick={(event) => event.stopPropagation()}
          >
            <p className="eyebrow mb-3 text-[var(--danger)]">Delete Folder</p>
            <h3 className="font-[var(--font-display)] text-2xl font-semibold tracking-[-0.04em] text-[var(--text-strong)]">
              Remove &quot;{folderDeleteTarget.name}&quot; and everything inside?
            </h3>
            <p className="mt-3 text-sm text-[var(--text-muted)]">
              This permanently deletes the folder, its subfolders, and all their
              audio files from disk. There is no undo.
            </p>
            <div className="mt-6 flex gap-3">
              <button
                type="button"
                onClick={() => setFolderDeleteTarget(null)}
                className="ghost-button flex-1"
              >
                Keep Folder
              </button>
              <button
                type="button"
                onClick={async () => {
                  const target = folderDeleteTarget;
                  setFolderDeleteTarget(null);
                  await deleteFolder(target.path);
                }}
                className="danger-button flex-1"
              >
                Delete Folder
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

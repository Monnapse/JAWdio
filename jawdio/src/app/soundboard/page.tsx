'use client';

import AudioLibrary from '@/components/AudioLibrary';

export default function SoundboardPage() {
  return (
    <div className="flex min-h-full flex-col py-2">
      <AudioLibrary variant="page" />
    </div>
  );
}

'use client';
import AudioLibrary from '@/components/AudioLibrary';

export default function SoundboardPage() {
  return (
    <div className="p-8 lg:p-12 max-w-[1400px] mx-auto">
      <AudioLibrary filterMode="board" />
    </div>
  );
}
import { $ } from "bun";

export interface SilenceEvent {
  type: "start" | "end";
  time: number;
}

export interface AudioSegment {
  index: number;
  start: number;
  duration: number;
}

export interface AsrManifest {
  packageId: string;
  fileId: string;
  sampleRate: 16000;
  channels: 1;
  segments: Array<{
    index: number;
    start: number;
    duration: number;
    url: string;
  }>;
}

/**
 * Detect silence regions in audio file using FFmpeg
 */
export async function detectSilence(
  filePath: string,
  threshold = "-40dB",
  minDur = 0.5
): Promise<SilenceEvent[]> {
  const { stderr } = await $`ffmpeg -i ${filePath} -af silencedetect=n=${threshold}:d=${minDur} -f null -`.quiet();
  const lines = stderr.toString().split("\n");
  const events: SilenceEvent[] = [];

  for (const line of lines) {
    const startMatch = line.match(/silence_start:\s*([0-9.]+)/);
    const endMatch = line.match(/silence_end:\s*([0-9.]+)/);

    if (startMatch) {
      events.push({ type: "start", time: parseFloat(startMatch[1]!) });
    }
    if (endMatch) {
      events.push({ type: "end", time: parseFloat(endMatch[1]!) });
    }
  }

  return events;
}

/**
 * Plan optimal audio chunks based on silence detection
 */
export function planAudioChunks(
  duration: number,
  maxChunk = 120,
  minChunk = 30,
  silenceEvents: SilenceEvent[]
): AudioSegment[] {
  // Extract silence cut points (start of silence regions)
  const silenceCuts = silenceEvents
    .filter(event => event.type === "start")
    .map(event => event.time)
    .filter(time => time > 5 && time < duration - 5);

  const cuts = [0, ...silenceCuts, duration].sort((a, b) => a - b);
  const segments: AudioSegment[] = [];
  let start = 0;
  let index = 0;

  for (const cut of cuts) {
    if (cut - start >= minChunk) {
      const end = Math.min(start + maxChunk, cut);
      segments.push({
        index,
        start,
        duration: +(end - start).toFixed(3)
      });
      start = end;
      index++;
    }
  }

  // Handle remaining duration
  if (duration - start > 5) {
    segments.push({
      index,
      start,
      duration: +(duration - start).toFixed(3)
    });
  }

  return segments;
}

/**
 * Get audio duration using FFprobe
 */
export async function getAudioDuration(filePath: string): Promise<number> {
  const { stdout } = await $`ffprobe -v quiet -show_entries format=duration -of csv=p=0 ${filePath}`;
  return parseFloat(stdout.toString().trim());
}

/**
 * Create ASR package manifest
 */
export function createAsrManifest(
  packageId: string,
  fileId: string,
  segments: AudioSegment[],
  baseUrl: string = ""
): AsrManifest {
  return {
    packageId,
    fileId,
    sampleRate: 16000,
    channels: 1,
    segments: segments.map(segment => ({
      index: segment.index,
      start: segment.start,
      duration: segment.duration,
      url: `${baseUrl}/seg_${segment.index.toString().padStart(3, '0')}.wav`
    }))
  };
}

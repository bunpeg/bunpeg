import { $ } from "bun";

export interface SceneEvent {
  pts_time: number;
  score: number;
}

export interface VisionSegment {
  index: number;
  start: number;
  duration: number;
  url: string;
}

export interface VisionManifest {
  packageId: string;
  preset: string;
  fileId: string;
  resolution: {
    width: number;
    height: number;
  };
  totalDuration: number;
  sceneThreshold: number;
  segments: VisionSegment[];
}

export async function detectScenes(
  inputFile: string,
  threshold: number,
): Promise<SceneEvent[]> {
  const scenes: SceneEvent[] = [];

  try {
    const result = await $`ffmpeg -i ${inputFile} -vf select='gt(scene,${threshold})',showinfo -f null -`.quiet();

    // Parse pts_time from showinfo logs (stderr contains showinfo output)
    const lines = result.stderr?.toString().split('\n') || [];
    for (const line of lines) {
      const match = line.match(/pts_time:(\d+\.?\d*)/);
      const scoreMatch = line.match(/scene:(\d+\.?\d*)/);
      if (match && match[1] && scoreMatch && scoreMatch[1]) {
        const ptsTime = parseFloat(match[1]);
        const score = parseFloat(scoreMatch[1]);
        if (!isNaN(ptsTime) && !isNaN(score)) {
          scenes.push({
            pts_time: ptsTime,
            score: score
          });
        }
      }
    }
  } catch (error) {
    throw new Error(`Failed to detect scenes: ${error}`);
  }

  // Always include start (0) and end
  const duration = await getVideoDuration(inputFile);
  if (scenes.length === 0) {
    throw new Error('No scenes detected. Video may be too static or threshold too high.');
  }
  if (scenes.length > 200) {
    throw new Error('Too many scenes detected (>200). Consider increasing threshold.');
  }

  return [
    { pts_time: 0, score: 1.0 },
    ...scenes,
    { pts_time: duration, score: 0 }
  ].sort((a, b) => a.pts_time - b.pts_time);
}

export function planVisionChunks(scenes: SceneEvent[]): Array<{ start: number, end: number }> {
  const chunks: Array<{ start: number, end: number }> = [];

  for (let i = 0; i < scenes.length - 1; i++) {
    const currentScene = scenes[i];
    const nextScene = scenes[i + 1];

    if (currentScene && nextScene) {
      chunks.push({
        start: currentScene.pts_time,
        end: nextScene.pts_time
      });
    }
  }

  return chunks;
}

export async function getVideoDuration(inputFile: string): Promise<number> {
  // Use ffprobe to get duration
  try {
    const result = await $`ffprobe -v quiet -show_entries format=duration -of csv=p=0 ${inputFile}`.text();
    const duration = parseFloat(result.trim());
    if (isNaN(duration)) {
      throw new Error('Invalid duration returned from ffprobe');
    }
    return duration;
  } catch (error) {
    throw new Error(`Failed to get video duration: ${error}`);
  }
}

export async function getVideoResolution(inputFile: string): Promise<{ width: number, height: number }> {
  // Use ffprobe to get video resolution
  try {
    const result = await $`ffprobe -v quiet -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 ${inputFile}`.text();
    const [widthStr, heightStr] = result.trim().split('x');
    const width = Number(widthStr);
    const height = Number(heightStr);

    if (isNaN(width) || isNaN(height)) {
      throw new Error('Invalid resolution returned from ffprobe');
    }

    return { width, height };
  } catch (error) {
    throw new Error(`Failed to get video resolution: ${error}`);
  }
}

export function createVisionManifest(
  packageId: string,
  fileId: string,
  segments: VisionSegment[],
  resolution: { width: number, height: number },
  totalDuration: number,
  sceneThreshold: number
): VisionManifest {
  return {
    packageId,
    preset: "vision-chunks",
    fileId,
    resolution,
    totalDuration,
    sceneThreshold,
    segments
  };
}

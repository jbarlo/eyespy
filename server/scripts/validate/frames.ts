/**
 * Every frame of a video as a folder of JPEGs plus its average frame rate, from the devshell's ffmpeg. Extracting at
 * a lower rate such as 5 fps would not give the browser's keyframes, because the fps filter's frame for a slot is up to
 * two frames after the seek's. It extracts each video once and keeps the folder and its rate.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { scratch } from "./paths.ts";

/** The video's average frame rate (ffprobe avg_frame_rate, "num/den"). */
function frameRate(video: string): number {
  const out = execFileSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=avg_frame_rate", "-of", "csv=p=0", video],
    { encoding: "utf8" },
  ).trim();
  const [num, den] = (/^(\d+)\/?(\d*)/.exec(out)?.slice(1) ?? []).map((x) => (x === "" ? 1 : Number(x)));
  const fps = (num ?? NaN) / (den ?? 1);
  if (!(fps > 0)) throw new Error(`no frame rate for ${video}: ${out}`);
  return fps;
}

/** The folder of every frame of `video` and the rate to add it at. Extracts the frames on first use. */
export function framesOf(video: string): { readonly dir: string; readonly fps: number } {
  const dir = scratch(`frames/${path.basename(video).replace(/\.[^.]*$/, "")}`);
  const rateFile = `${dir}.fps`;
  if (!existsSync(dir) || !existsSync(rateFile)) {
    const tmp = `${dir}.tmp`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    const args = ["-v", "error", "-i", video, "-fps_mode", "passthrough", "-q:v", "2", path.join(tmp, "%06d.jpg")];
    execFileSync("ffmpeg", args, { stdio: "inherit" });
    rmSync(dir, { recursive: true, force: true });
    renameSync(tmp, dir);
    writeFileSync(rateFile, String(frameRate(video)));
  }
  return { dir, fps: Number(readFileSync(rateFile, "utf8")) };
}

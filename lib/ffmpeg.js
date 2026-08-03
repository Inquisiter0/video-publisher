import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

/**
 * Transcode a raw upload into a 1080x1920 (9:16) H.264/AAC MP4.
 *
 * Scale to fill 1080x1920, then center-crop, so aspect ratio is preserved
 * regardless of the source dimensions. `yuv420p` + `+faststart` are required
 * for the target platforms.
 *
 * @param {string} inputPath  Absolute path to the raw upload.
 * @param {string} outputPath Absolute path for the processed file.
 * @returns {Promise<string>} Resolves with outputPath on success.
 */
export function transcodeForVertical(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', inputPath,
      '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920',
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '23',
      '-profile:v', 'high',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '48000',
      '-movflags', '+faststart',
      '-shortest',
      outputPath,
    ];

    const ffmpeg = spawn(ffmpegPath || 'ffmpeg', args);
    let stderr = '';

    ffmpeg.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    // Fires if the binary itself cannot be spawned (e.g. ffmpeg not on PATH).
    ffmpeg.on('error', reject);

    ffmpeg.on('close', (code) => {
      if (code === 0) resolve(outputPath);
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

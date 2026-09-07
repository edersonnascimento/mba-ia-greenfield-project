import { Injectable } from '@nestjs/common';
import { execFile as execFileCb } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

export interface VideoProbe {
  duration: number;
  width?: number;
  height?: number;
  codec?: string;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
}

interface FfprobeFormat {
  duration?: string;
}

interface FfprobeJson {
  format?: FfprobeFormat;
  streams?: FfprobeStream[];
}

@Injectable()
export class FfmpegService {
  private parseProbe(raw: string): VideoProbe {
    const data = JSON.parse(raw) as FfprobeJson;
    const stream = (data?.streams ?? []).find((s) => s.codec_type === 'video');
    const rawDuration = data?.format?.duration ?? stream?.duration ?? '0';
    const duration = Number.parseFloat(String(rawDuration));
    return {
      duration: Number.isNaN(duration) ? 0 : duration,
      width: stream?.width,
      height: stream?.height,
      codec: stream?.codec_name,
    };
  }

  async probe(sourceUrl: string): Promise<VideoProbe> {
    const { stdout } = await execFile(
      'ffprobe',
      [
        '-v',
        'quiet',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        '-i',
        sourceUrl,
      ],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    return this.parseProbe(stdout.toString());
  }

  async thumbnail(sourceUrl: string, seekSeconds = 0): Promise<Buffer> {
    const seek = `00:00:${String(seekSeconds).padStart(2, '0')}`;
    const dir = await fs.mkdtemp(`${os.tmpdir()}/stthumb-`);
    const file = path.join(dir, 'thumb.jpg');
    try {
      await execFile('ffmpeg', [
        '-ss',
        seek,
        '-i',
        sourceUrl,
        '-frames:v',
        '1',
        '-vf',
        'scale=320:-1',
        '-y',
        file,
      ]);
      return await fs.readFile(file);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
}

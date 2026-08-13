import fs from 'node:fs';
import path from 'node:path';

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code !== 'ESRCH');
  }
}

export class InstanceLock {
  private fileDescriptor?: number;

  constructor(private readonly lockPath: string) {}

  acquire(): void {
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fileDescriptor = fs.openSync(this.lockPath, 'wx', 0o600);
        fs.writeFileSync(fileDescriptor, `${process.pid}\n`, 'utf8');
        this.fileDescriptor = fileDescriptor;
        return;
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST')) throw error;
        const owner = Number.parseInt(fs.readFileSync(this.lockPath, 'utf8').trim(), 10);
        if (Number.isInteger(owner) && owner > 0 && processIsAlive(owner)) {
          throw new Error(`Another RigoHR Attendance Assistant process is already running (PID ${owner}).`);
        }
        try { fs.unlinkSync(this.lockPath); } catch (unlinkError) {
          if (!(unlinkError && typeof unlinkError === 'object' && 'code' in unlinkError && (unlinkError as NodeJS.ErrnoException).code === 'ENOENT')) throw unlinkError;
        }
      }
    }
    throw new Error('Could not acquire the RigoHR Attendance Assistant instance lock.');
  }

  release(): void {
    const fileDescriptor = this.fileDescriptor;
    this.fileDescriptor = undefined;
    if (fileDescriptor === undefined) return;
    try { fs.closeSync(fileDescriptor); } finally {
      try { fs.unlinkSync(this.lockPath); } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) throw error;
      }
    }
  }
}

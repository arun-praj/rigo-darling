import fs from 'node:fs';
import path from 'node:path';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const localEvidenceDir = path.resolve('data/evidence');

function validKey(key: string): boolean {
  if (!key || key.length > 512 || key.startsWith('/') || key.includes('\\')) return false;
  const parts = key.split('/');
  return parts.every((part) => Boolean(part) && part !== '.' && part !== '..' && /^[A-Za-z0-9._-]+$/.test(part));
}

export class EvidenceStore {
  private readonly client?: S3Client;
  private readonly bucket?: string;
  private readonly prefix: string;

  constructor() {
    const endpoint = process.env.R2_ENDPOINT;
    const bucket = process.env.R2_BUCKET || process.env.R2_BUCKET_NAME;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    const rawPrefix = process.env.R2_PREFIX || 'rigohr-attendance';
    this.prefix = rawPrefix.replace(/^\/+|\/+$/g, '');
    if (this.prefix && !validKey(this.prefix)) throw new Error('R2_PREFIX must contain only safe folder names separated by /.');
    const anyR2Setting = [endpoint, bucket, accessKeyId, secretAccessKey].some(Boolean);
    const completeR2Setting = [endpoint, bucket, accessKeyId, secretAccessKey].every(Boolean);
    if (anyR2Setting && !completeR2Setting) throw new Error('R2 configuration is incomplete; set R2_ENDPOINT, R2_BUCKET (or R2_BUCKET_NAME), R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY together.');
    if (endpoint && bucket && accessKeyId && secretAccessKey) {
      this.client = new S3Client({ region: 'auto', endpoint, credentials: { accessKeyId, secretAccessKey } });
      this.bucket = bucket;
    } else {
      fs.mkdirSync(localEvidenceDir, { recursive: true, mode: 0o700 });
    }
  }

  get mode(): 'r2' | 'local' {
    return this.client ? 'r2' : 'local';
  }

  private objectKey(fileName: string): string {
    if (!validKey(fileName) || fileName.includes('/')) throw new Error('Invalid evidence file name.');
    return this.prefix ? `${this.prefix}/${fileName}` : fileName;
  }

  async put(fileName: string, data: Buffer, contentType = 'image/png'): Promise<string> {
    const key = this.objectKey(fileName);
    if (this.client && this.bucket) {
      await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: contentType, CacheControl: 'private, max-age=31536000' }));
    } else {
      const filePath = path.join(localEvidenceDir, key);
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(filePath, data, { mode: 0o600 });
    }
    return this.publicPath(key);
  }

  async get(key: string): Promise<{ data: Buffer; contentType: string } | undefined> {
    if (!validKey(key)) return undefined;
    if (this.client && this.bucket) {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!result.Body) return undefined;
      return { data: Buffer.from(await result.Body.transformToByteArray()), contentType: result.ContentType || 'image/png' };
    }
    const filePath = path.join(localEvidenceDir, key);
    if (!fs.existsSync(filePath)) return undefined;
    return { data: fs.readFileSync(filePath), contentType: 'image/png' };
  }

  publicPath(key: string): string {
    if (!validKey(key)) throw new Error('Invalid evidence object key.');
    return `/evidence?key=${encodeURIComponent(key)}`;
  }
}

export const evidenceStore = new EvidenceStore();

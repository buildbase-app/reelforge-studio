// Types for lib.mjs (plain JS so `pnpm dev:setup` runs before `pnpm install`).
export type EnvEntry = string | [name: string, value: string];
export interface Passwords {
  postgres?: string;
  mysql?: string;
  mysqlRoot?: string;
  minio?: string;
}
export interface EnvOptions {
  chromiumPath?: string;
  port?: number;
  database?: 'sqlite' | 'postgres' | 'mysql';
  minio?: boolean;
  stt?: { command: string; model: string; modelDir: string } | null;
  secretKey?: string;
  bootstrapKey?: string;
  passwords?: Passwords;
}
export interface EnvPlan {
  action: 'create' | 'replace' | 'append' | 'keep';
  content: string;
  added: string[];
  conflicts: string[];
}
export interface ChromiumFound {
  path: string | null;
  source: 'environment' | 'playwright' | 'remotion';
  missing?: string;
}
type Env = Record<string, string | undefined>;

export const STUDIO_PORT: number;
export const SITE_PORT: number;
export const MOCK_LICENCE_PORT: number;
export const MIN_FFMPEG: number[];
export const FFMPEG_ENCODERS: string[];
export const FFMPEG_FILTERS: string[];
export const MIN_FREE_BYTES: number;
export function parseVersion(text: unknown): number[] | null;
export function compareVersions(a: number[], b: number[]): -1 | 0 | 1;
export function parseFfmpegVersion(output: unknown): number[] | null;
export function missingFfmpegFeatures(listing: unknown, wanted: string[]): string[];
export function nodeMeets(nodeVersion: string, nvmrc: string): boolean;
export function generateSecretKey(): string;
export function generateApiKey(): string;
export function generatePassword(): string;
export function parseEnvText(text: unknown): Record<string, string>;
export function envEntries(opts?: EnvOptions): EnvEntry[];
export function databaseEntries(kind: string, passwords?: Passwords): EnvEntry[];
export function minioEntries(passwords?: Passwords): EnvEntry[];
export function sttEntries(stt: { command: string; model: string; modelDir: string }): EnvEntry[];
export function planEnvFile(existing: string | null, entries: EnvEntry[], opts?: { force?: boolean; date?: string }): EnvPlan;
export function mergeEnv(fileVars: Env, shellEnv: Env): Env;
export function envValue(env: Env, name: string): string | undefined;
export function playwrightDirs(opts?: { env?: Env; platform?: string; home?: string }): string[];
export function headlessShellExe(platform?: string, arch?: string): string;
export function findChromium(opts?: { env?: Env; platform?: string; arch?: string; home?: string; repoDir?: string; exists?: (p: string) => boolean; list?: (d: string) => string[] }): ChromiumFound | null;
export function freeBytes(dir: string): number | null;
export function portFree(port: number, host?: string): Promise<boolean>;
export function nextFreePort(start: number, host?: string): Promise<number | null>;
export function gb(bytes: number): string;

import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Packument, Registry } from '../dist/types.js';

export async function tempDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'bussing-test-'));
}

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com' };

export function git(dir: string, ...args: string[]): string {
    return execFileSync('git', ['-C', dir, ...args], { env: GIT_ENV, encoding: 'utf8' }).trim();
}

export async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
    for (const [path, content] of Object.entries(files)) {
        await mkdir(dirname(join(dir, path)), { recursive: true });
        await writeFile(join(dir, path), content);
    }
}

/** Crea un repositorio git con un commit inicial que contiene los archivos dados. */
export async function gitRepo(dir: string, files: Record<string, string>): Promise<string> {
    await mkdir(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    await writeFiles(dir, files);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'inicial');
    return git(dir, 'rev-parse', 'HEAD');
}

/** Agrega un remoto (repositorio bare) y empuja la rama main con upstream. */
export function addRemote(dir: string, bare: string): void {
    execFileSync('git', ['init', '-q', '--bare', bare], { env: GIT_ENV });
    git(dir, 'remote', 'add', 'origin', bare);
    git(dir, 'push', '-q', '-u', 'origin', 'main');
}

export function packageJson(fields: Record<string, unknown>): string {
    return JSON.stringify(fields, null, 2) + '\n';
}

export function fakeRegistry(packuments: Record<string, Packument>, tarballs: Record<string, Map<string, Uint8Array>> = {}): Registry {
    return {
        getPackument: async function (name: string): Promise<Packument | null> {
            return packuments[name] ?? null;
        },
        getTarballFiles: async function (url: string): Promise<Map<string, Uint8Array>> {
            const files = tarballs[url];
            if (files === undefined) throw new Error(`tarball inexistente en el registro falso: ${url}`);
            return files;
        },
    };
}

export function packument(name: string, versions: Record<string, { gitHead?: string }>, latest?: string): Packument {
    const result: Packument = { name, distTags: latest === undefined ? {} : { latest }, versions: {} };
    for (const [version, info] of Object.entries(versions)) {
        result.versions[version] = { version, gitHead: info.gitHead, tarball: `https://registry.example/${name}-${version}.tgz`, integrity: undefined };
    }
    return result;
}

export function filesMap(files: Record<string, string>): Map<string, Uint8Array> {
    return new Map(Object.entries(files).map(function ([path, content]) { return [path, Buffer.from(content)] as const; }));
}

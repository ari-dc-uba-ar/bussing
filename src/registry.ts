// Acceso al registro de npm: metadatos de paquetes y contenido de tarballs, con caché en memoria y opcionalmente en disco.
// No depende de nada propio de bussing salvo los tipos, para poder separarlo como librería común (npm, GitHub).

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { guarantee, is } from 'guarantee-type';
import { Parser, type ReadEntry } from 'tar';
import type { PackageVersions, Packument, PublishedVersion, Registry } from './types.js';

export const DEFAULT_REGISTRY_URL = 'https://registry.npmjs.org/';

const packumentDescription = is.object({
    name: is.string,
    'dist-tags': is.optional.recordString.string,
    versions: is.optional.recordString.object({
        version: is.string,
        gitHead: is.optional.string,
        dist: is.object({
            tarball: is.string,
            integrity: is.optional.string,
        }),
    }),
    time: is.optional.recordString.string,
});

/** Interpreta el documento completo de un paquete del registro. */
export function parsePackument(text: string): Packument {
    const doc = guarantee(packumentDescription, JSON.parse(text));
    const versions: Record<string, PublishedVersion> = {};
    for (const [key, value] of Object.entries(doc.versions ?? {})) {
        versions[key] = { version: value.version, gitHead: value.gitHead, tarball: value.dist.tarball, integrity: value.dist.integrity };
    }
    return { name: doc.name, distTags: doc['dist-tags'] ?? {}, versions, time: doc.time ?? {} };
}

const abbreviatedDescription = is.object({
    name: is.string,
    'dist-tags': is.optional.recordString.string,
    versions: is.optional.recordString.object({ version: is.string }),
});

/** Interpreta el documento abreviado de un paquete (`application/vnd.npm.install-v1+json`). */
export function parseAbbreviated(text: string): PackageVersions {
    const doc = guarantee(abbreviatedDescription, JSON.parse(text));
    return { name: doc.name, distTags: doc['dist-tags'] ?? {}, versions: Object.keys(doc.versions ?? {}) };
}

/** URL del documento de un paquete; en los paquetes con scope la barra se codifica (`@scope%2fname`). */
export function packumentUrl(registryUrl: string, name: string): string {
    const base = registryUrl.endsWith('/') ? registryUrl : registryUrl + '/';
    return base + encodeURIComponent(name).replace(/^%40/, '@');
}

/**
 * Verifica un valor de integridad SRI (`sha512-...`, posiblemente varios separados por espacios).
 * Alcanza con que coincida uno de los algoritmos conocidos; lanza un error si ninguno coincide.
 */
export function verifyIntegrity(data: Uint8Array, integrity: string, source: string): void {
    const known = integrity.split(/\s+/).filter(function (item) { return /^(sha512|sha384|sha256|sha1)-/.test(item); });
    if (known.length === 0) throw new Error(`Integridad con formato no reconocido para ${source}: ${integrity}`);
    for (const item of known) {
        const dash = item.indexOf('-');
        const algorithm = item.slice(0, dash);
        const expected = item.slice(dash + 1);
        if (createHash(algorithm).update(data).digest('base64') === expected) return;
    }
    throw new Error(`La integridad de ${source} no coincide con ${integrity}`);
}

/** Archivos regulares de un tarball (comprimido o no). Se descarta el primer segmento de cada ruta (normalmente `package/`). */
export function readTarball(data: Uint8Array): Promise<Map<string, Uint8Array>> {
    return new Promise(function (resolve, reject) {
        const files = new Map<string, Uint8Array>();
        const parser = new Parser({
            onReadEntry: function (entry: ReadEntry) {
                if (entry.type !== 'File') {
                    entry.resume();
                    return;
                }
                const chunks: Buffer[] = [];
                const path = entry.path.split('/').slice(1).join('/');
                entry.on('data', function (chunk: Buffer) { chunks.push(chunk); });
                entry.on('end', function () { files.set(path, Buffer.concat(chunks)); });
            },
        });
        parser.on('error', reject);
        parser.on('close', function () { resolve(files); });
        parser.end(Buffer.from(data));
    });
}

/** Descripción de un error de fetch, incluida su causa (por ejemplo `ENOTFOUND` cuando no hay red o no se resuelve el nombre). */
export function describeFetchError(err: unknown): string {
    if (!(err instanceof Error)) return String(err);
    const cause: unknown = err.cause;
    if (cause instanceof Error) return `${err.message}: ${'code' in cause && typeof cause.code === 'string' ? cause.code + ' ' : ''}${cause.message}`;
    return err.message;
}

/** Limita la cantidad de tareas que corren a la vez. */
function limiter(concurrency: number): <T>(task: () => Promise<T>) => Promise<T> {
    let running = 0;
    const waiting: (() => void)[] = [];
    return async function <T>(task: () => Promise<T>): Promise<T> {
        if (running >= concurrency) await new Promise<void>(function (resolve) { waiting.push(resolve); });
        running++;
        try {
            return await task();
        } finally {
            running--;
            waiting.shift()?.();
        }
    };
}

async function fetchOk(url: string, accept: string): Promise<Response | null> {
    let response: Response;
    try {
        response = await fetch(url, { headers: { accept } });
    } catch (err) {
        throw new Error(`No se pudo acceder a ${url} (${describeFetchError(err)})`);
    }
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GET ${url}: ${response.status} ${response.statusText}`);
    return response;
}

const cachedDocumentDescription = is.object({ fetchedAt: is.number, body: { nullable: is.string } });

/**
 * Caché en disco: los documentos (completos y abreviados) con la fecha en que se obtuvieron, y los tarballs por su integridad.
 * Un documento `null` registra que el paquete no existe en el registro.
 */
export class DiskCache {
    constructor(private readonly dir: string, private readonly maxAgeMs: number, private readonly now: () => number = Date.now) {}

    private documentPath(kind: 'full' | 'abbreviated', name: string): string {
        return join(this.dir, kind, encodeURIComponent(name) + '.json');
    }

    /** `undefined` si no está guardado o venció; `null` si se guardó que el paquete no existe. */
    async readDocument(kind: 'full' | 'abbreviated', name: string): Promise<string | null | undefined> {
        let text: string;
        try {
            text = await readFile(this.documentPath(kind, name), 'utf8');
        } catch (err) {
            if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return undefined;
            throw err;
        }
        const cached = guarantee(cachedDocumentDescription, JSON.parse(text));
        return this.now() - cached.fetchedAt > this.maxAgeMs ? undefined : cached.body;
    }

    async writeDocument(kind: 'full' | 'abbreviated', name: string, body: string | null): Promise<void> {
        const path = this.documentPath(kind, name);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, JSON.stringify({ fetchedAt: this.now(), body }));
    }

    /** Ruta del tarball según su integridad sha512; `null` si la integridad no tiene sha512 (no se guarda en disco). */
    private tarballPath(integrity: string | undefined): string | null {
        const sha512 = integrity?.split(/\s+/).find(function (item) { return item.startsWith('sha512-'); });
        if (sha512 === undefined) return null;
        return join(this.dir, 'tarballs', Buffer.from(sha512.slice('sha512-'.length), 'base64').toString('hex') + '.tgz');
    }

    async readTarball(integrity: string | undefined): Promise<Uint8Array | undefined> {
        const path = this.tarballPath(integrity);
        if (path === null) return undefined;
        try {
            return new Uint8Array(await readFile(path));
        } catch (err) {
            if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return undefined;
            throw err;
        }
    }

    async writeTarball(integrity: string | undefined, data: Uint8Array): Promise<void> {
        const path = this.tarballPath(integrity);
        if (path === null) return;
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, data);
    }
}

export interface NpmRegistryOptions {
    /** Carpeta del caché en disco; sin ella, el caché es solo en memoria (dura una corrida). */
    cacheDir?: string;
    /** Antigüedad máxima de los documentos guardados en disco (los tarballs no vencen). Por omisión, una hora. */
    maxAgeMs?: number;
    /** Consultas simultáneas al registro. Por omisión, 8. */
    concurrency?: number;
}

export const DEFAULT_CACHE_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Registro de npm accedido por HTTP. Cada documento y cada tarball se pide una sola vez por instancia; con `cacheDir` también
 * se guardan en disco entre corridas.
 */
export function createNpmRegistry(registryUrl: string = DEFAULT_REGISTRY_URL, options: NpmRegistryOptions = {}): Registry {
    const disk = options.cacheDir === undefined ? null : new DiskCache(options.cacheDir, options.maxAgeMs ?? DEFAULT_CACHE_MAX_AGE_MS);
    const limit = limiter(options.concurrency ?? 8);
    const memory = new Map<string, Promise<string | null>>();
    const tarballs = new Map<string, Promise<Map<string, Uint8Array>>>();
    /** Texto del documento (`null` si el paquete no existe), desde la memoria, el disco o el registro. */
    function document(kind: 'full' | 'abbreviated', name: string): Promise<string | null> {
        const key = kind + ' ' + name;
        let pending = memory.get(key);
        if (pending === undefined) {
            pending = (async function (): Promise<string | null> {
                const cached = disk === null ? undefined : await disk.readDocument(kind, name);
                if (cached !== undefined) return cached;
                const accept = kind === 'full' ? 'application/json' : 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8';
                const body = await limit(async function () {
                    const response = await fetchOk(packumentUrl(registryUrl, name), accept);
                    return response === null ? null : response.text();
                });
                if (disk !== null) await disk.writeDocument(kind, name, body);
                return body;
            })();
            memory.set(key, pending);
        }
        return pending;
    }
    return {
        getPackument: async function (name: string): Promise<Packument | null> {
            const text = await document('full', name);
            return text === null ? null : parsePackument(text);
        },
        getVersions: async function (name: string): Promise<PackageVersions | null> {
            // si el documento completo ya se pidió en esta corrida, alcanza con él
            const full = memory.get('full ' + name);
            if (full !== undefined) {
                const text = await full;
                if (text === null) return null;
                const packument = parsePackument(text);
                return { name: packument.name, distTags: packument.distTags, versions: Object.keys(packument.versions) };
            }
            const text = await document('abbreviated', name);
            return text === null ? null : parseAbbreviated(text);
        },
        getTarballFiles: function (tarballUrl: string, integrity: string | undefined): Promise<Map<string, Uint8Array>> {
            let pending = tarballs.get(tarballUrl);
            if (pending === undefined) {
                pending = (async function () {
                    let data = disk === null ? undefined : await disk.readTarball(integrity);
                    if (data === undefined) {
                        data = await limit(async function () {
                            const response = await fetchOk(tarballUrl, 'application/octet-stream');
                            if (response === null) throw new Error(`No existe el tarball ${tarballUrl}`);
                            return new Uint8Array(await response.arrayBuffer());
                        });
                        if (integrity !== undefined) verifyIntegrity(data, integrity, tarballUrl);
                        if (disk !== null) await disk.writeTarball(integrity, data);
                    } else if (integrity !== undefined) {
                        verifyIntegrity(data, integrity, tarballUrl);
                    }
                    return readTarball(data);
                })();
                tarballs.set(tarballUrl, pending);
            }
            return pending;
        },
    };
}

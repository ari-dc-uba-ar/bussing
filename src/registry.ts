// Acceso al registro de npm: metadatos de paquetes y contenido de tarballs.

import { createHash } from 'node:crypto';
import { guarantee, is } from 'guarantee-type';
import { Parser, type ReadEntry } from 'tar';
import type { Packument, PublishedVersion, Registry } from './types.js';

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
});

/** Interpreta el documento de un paquete del registro (el formato completo, no el abreviado). */
export function parsePackument(text: string): Packument {
    const doc = guarantee(packumentDescription, JSON.parse(text));
    const versions: Record<string, PublishedVersion> = {};
    for (const [key, value] of Object.entries(doc.versions ?? {})) {
        versions[key] = { version: value.version, gitHead: value.gitHead, tarball: value.dist.tarball, integrity: value.dist.integrity };
    }
    return { name: doc.name, distTags: doc['dist-tags'] ?? {}, versions };
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

/** Registro de npm accedido por HTTP. Cada paquete y cada tarball se descarga una sola vez por instancia. */
export function createNpmRegistry(registryUrl: string = DEFAULT_REGISTRY_URL): Registry {
    const packuments = new Map<string, Promise<Packument | null>>();
    const tarballs = new Map<string, Promise<Map<string, Uint8Array>>>();
    return {
        getPackument: function (name: string): Promise<Packument | null> {
            let pending = packuments.get(name);
            if (pending === undefined) {
                pending = (async function () {
                    const response = await fetchOk(packumentUrl(registryUrl, name), 'application/json');
                    return response === null ? null : parsePackument(await response.text());
                })();
                packuments.set(name, pending);
            }
            return pending;
        },
        getTarballFiles: function (tarballUrl: string, integrity: string | undefined): Promise<Map<string, Uint8Array>> {
            let pending = tarballs.get(tarballUrl);
            if (pending === undefined) {
                pending = (async function () {
                    const response = await fetchOk(tarballUrl, 'application/octet-stream');
                    if (response === null) throw new Error(`No existe el tarball ${tarballUrl}`);
                    const data = new Uint8Array(await response.arrayBuffer());
                    if (integrity !== undefined) verifyIntegrity(data, integrity, tarballUrl);
                    return readTarball(data);
                })();
                tarballs.set(tarballUrl, pending);
            }
            return pending;
        },
    };
}

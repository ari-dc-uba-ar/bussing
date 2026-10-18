import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { create } from 'tar';
import { createNpmRegistry, describeFetchError, DiskCache, packumentUrl, parseAbbreviated, parsePackument, readTarball, verifyIntegrity } from '../src/registry.js';
import { tempDir, writeFiles } from './helpers.js';

describe('registry', function () {
    it('packumentUrl codifica la barra de los paquetes con scope', function () {
        assert.equal(packumentUrl('https://r.example/', 'like-ar'), 'https://r.example/like-ar');
        assert.equal(packumentUrl('https://r.example', '@scope/pkg'), 'https://r.example/@scope%2Fpkg');
    });
    it('parsePackument toma versiones, gitHead y tarball', function () {
        const packument = parsePackument(JSON.stringify({
            name: 'x',
            'dist-tags': { latest: '1.0.0' },
            versions: { '1.0.0': { name: 'x', version: '1.0.0', gitHead: 'abc', dist: { tarball: 'https://t/x.tgz', integrity: 'sha512-zz' } } },
        }));
        assert.deepEqual(packument, {
            name: 'x',
            distTags: { latest: '1.0.0' },
            versions: { '1.0.0': { version: '1.0.0', gitHead: 'abc', tarball: 'https://t/x.tgz', integrity: 'sha512-zz' } },
            time: {},
        });
    });
    it('parsePackument acepta paquetes despublicados (sin versiones)', function () {
        assert.deepEqual(parsePackument('{"name":"x","time":{}}'), { name: 'x', distTags: {}, versions: {}, time: {} });
    });
    it('parsePackument rechaza documentos mal formados', function () {
        assert.throws(function () { parsePackument('{"versions":{}}'); });
    });
    it('describeFetchError incluye la causa', function () {
        const cause = Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' });
        assert.equal(describeFetchError(new Error('fetch failed', { cause })), 'fetch failed: ENOTFOUND getaddrinfo ENOTFOUND x');
        assert.equal(describeFetchError(new Error('fetch failed', { cause: new Error('otra') })), 'fetch failed: otra');
        assert.equal(describeFetchError(new Error('simple')), 'simple');
        assert.equal(describeFetchError('texto'), 'texto');
    });
    it('verifyIntegrity', function () {
        const data = Buffer.from('contenido');
        const sha512 = 'sha512-' + createHash('sha512').update(data).digest('base64');
        verifyIntegrity(data, `sha1-otro ${sha512}`, 'x');
        assert.throws(function () { verifyIntegrity(data, 'sha512-otro', 'x'); }, /no coincide/);
        assert.throws(function () { verifyIntegrity(data, 'md5-otro', 'x'); }, /no reconocido/);
    });
    it('readTarball devuelve los archivos sin el primer segmento', async function () {
        const dir = await tempDir();
        await writeFiles(dir, { 'package/package.json': '{}', 'package/lib/a.js': 'a' });
        const file = join(dir, 'p.tgz');
        await create({ gzip: true, cwd: dir, file }, ['package']);
        const files = await readTarball(await readFile(file));
        assert.deepEqual([...files.keys()].sort(), ['lib/a.js', 'package.json']);
        assert.equal(Buffer.from(files.get('lib/a.js') ?? []).toString(), 'a');
    });
    it('parseAbbreviated toma las versiones y los dist-tags', function () {
        assert.deepEqual(parseAbbreviated(JSON.stringify({ name: 'x', 'dist-tags': { latest: '1.1.0' }, versions: { '1.0.0': { version: '1.0.0' }, '1.1.0': { version: '1.1.0' } } })), {
            name: 'x', distTags: { latest: '1.1.0' }, versions: ['1.0.0', '1.1.0'],
        });
    });
    it('DiskCache guarda documentos con vencimiento y tarballs por integridad', async function () {
        const dir = await tempDir();
        let now = 1000;
        const cache = new DiskCache(dir, 100, function () { return now; });
        assert.equal(await cache.readDocument('full', '@s/x'), undefined);
        await cache.writeDocument('full', '@s/x', '{"name":"@s/x"}');
        await cache.writeDocument('abbreviated', 'no-existe', null);
        assert.equal(await cache.readDocument('full', '@s/x'), '{"name":"@s/x"}');
        assert.equal(await cache.readDocument('abbreviated', 'no-existe'), null);
        now = 1200;
        assert.equal(await cache.readDocument('full', '@s/x'), undefined);
        const data = Buffer.from('tarball');
        const integrity = 'sha512-' + createHash('sha512').update(data).digest('base64');
        assert.equal(await cache.readTarball(integrity), undefined);
        await cache.writeTarball(integrity, data);
        await cache.writeTarball(undefined, data);
        assert.equal(Buffer.from((await cache.readTarball(integrity)) ?? []).toString(), 'tarball');
        assert.equal(await cache.readTarball('sha1-abc'), undefined);
    });
    it('createNpmRegistry: pide cada cosa una vez, reutiliza el documento completo y guarda en disco', async function () {
        const tarballDir = await tempDir();
        await writeFiles(tarballDir, { 'package/package.json': '{"name":"x"}' });
        const tgz = join(tarballDir, 'x.tgz');
        await create({ gzip: true, cwd: tarballDir, file: tgz }, ['package']);
        const tarball = await readFile(tgz);
        const integrity = 'sha512-' + createHash('sha512').update(tarball).digest('base64');
        const requests: string[] = [];
        const server = createServer(function (request, response) {
            const accept = request.headers.accept ?? '';
            requests.push(`${request.url} ${accept.startsWith('application/vnd.npm.install-v1+json') ? 'abreviado' : 'completo'}`);
            if (request.url === '/x') {
                response.setHeader('content-type', 'application/json');
                response.end(JSON.stringify({ name: 'x', 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { version: '1.0.0', dist: { tarball: `http://localhost:${port}/x.tgz`, integrity } } } }));
            } else if (request.url === '/x.tgz') {
                response.end(tarball);
            } else {
                response.statusCode = 404;
                response.end();
            }
        });
        await new Promise<void>(function (resolve) { server.listen(0, resolve); });
        const address = server.address();
        const port = address !== null && typeof address === 'object' ? address.port : 0;
        try {
            const cacheDir = await tempDir();
            const url = `http://localhost:${port}/`;
            const registry = createNpmRegistry(url, { cacheDir });
            assert.deepEqual(await registry.getVersions('x'), { name: 'x', distTags: { latest: '1.0.0' }, versions: ['1.0.0'] });
            assert.equal((await registry.getPackument('x'))?.versions['1.0.0']?.integrity, integrity);
            assert.deepEqual(await registry.getVersions('x'), { name: 'x', distTags: { latest: '1.0.0' }, versions: ['1.0.0'] });
            assert.equal(await registry.getVersions('nada'), null);
            assert.deepEqual([...(await registry.getTarballFiles(`${url}x.tgz`, integrity)).keys()], ['package.json']);
            assert.deepEqual(requests, ['/x abreviado', '/x completo', '/nada abreviado', '/x.tgz completo']);
            // otra instancia con la misma carpeta: todo sale del disco
            const again = createNpmRegistry(url, { cacheDir });
            assert.equal((await again.getPackument('x'))?.name, 'x');
            assert.equal(await again.getVersions('nada'), null);
            assert.deepEqual([...(await again.getTarballFiles(`${url}x.tgz`, integrity)).keys()], ['package.json']);
            assert.equal(requests.length, 4);
            // la completa ya pedida en esta instancia sirve para las versiones
            const fresh = createNpmRegistry(url);
            await fresh.getPackument('x');
            await fresh.getVersions('x');
            assert.deepEqual(requests.slice(4), ['/x completo']);
        } finally {
            server.close();
        }
    });
});

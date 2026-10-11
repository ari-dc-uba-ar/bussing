import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { create } from 'tar';
import { describeFetchError, packumentUrl, parsePackument, readTarball, verifyIntegrity } from '../src/registry.js';
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
        });
    });
    it('parsePackument acepta paquetes despublicados (sin versiones)', function () {
        assert.deepEqual(parsePackument('{"name":"x","time":{}}'), { name: 'x', distTags: {}, versions: {} });
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
});

import { strict as assert } from 'node:assert';
import { symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkDependencies, checkGit, checkInstallation, checkPublication, compareWithTarball, installedBinContent } from '../src/checks.js';
import { getState } from '../src/git.js';
import { packageMatcher, type NcuConfig } from '../src/ncurc.js';
import { parsePackageJson } from '../src/repos.js';
import { addRemote, fakeRegistry, filesMap, git, gitRepo, packageJson, packument, tempDir, writeFiles } from './helpers.js';

describe('checks', function () {
    describe('checkGit', function () {
        it('advierte si no es un repositorio git', async function () {
            const result = await checkGit(await tempDir());
            assert.equal(result.state, null);
            assert.deepEqual(result.warnings, [{ check: 'git', message: 'no es un repositorio git' }]);
        });
        it('informa archivos sin commitear, rama sin upstream y commits sin pushear', async function () {
            const base = await tempDir();
            const dir = join(base, 'repo');
            await gitRepo(dir, { 'a.txt': 'a\n' });
            await writeFile(join(dir, 'b.txt'), 'b\n');
            assert.deepEqual((await checkGit(dir)).problems, [
                { kind: 'uncommitted', files: ['b.txt'] },
                { kind: 'no-upstream', branch: 'main' },
            ]);
            addRemote(dir, join(base, 'remote.git'));
            git(dir, 'add', '.');
            git(dir, 'commit', '-q', '-m', 'b');
            assert.deepEqual((await checkGit(dir)).problems, [{ kind: 'unpushed', commits: 1 }]);
        });
        it('advierte el HEAD desacoplado', async function () {
            const dir = join(await tempDir(), 'repo');
            const head = await gitRepo(dir, { 'a.txt': 'a\n' });
            git(dir, 'checkout', '-q', head);
            assert.deepEqual((await checkGit(dir)).warnings, [{ check: 'git', message: 'HEAD desacoplado (no está en ninguna rama)' }]);
        });
    });

    describe('checkPublication', function () {
        async function setup(): Promise<{ dir: string; published: string }> {
            const dir = join(await tempDir(), 'repo');
            const published = await gitRepo(dir, { 'package.json': packageJson({ name: 'x', version: '1.0.0' }) });
            return { dir, published };
        }
        const pkg = parsePackageJson(packageJson({ name: 'x', version: '1.0.0' }));
        it('sin problemas si el HEAD es el commit publicado', async function () {
            const { dir, published } = await setup();
            const registry = fakeRegistry({ x: packument('x', { '1.0.0': { gitHead: published } }, '1.0.0') });
            assert.deepEqual(await checkPublication(dir, pkg, await getState(dir), registry), { problems: [], warnings: [] });
        });
        it('versión sin subir si hay commits posteriores a la publicación', async function () {
            const { dir, published } = await setup();
            await writeFile(join(dir, 'b.txt'), 'b');
            git(dir, 'add', '.');
            git(dir, 'commit', '-q', '-m', 'b');
            const registry = fakeRegistry({ x: packument('x', { '1.0.0': { gitHead: published } }, '1.0.0') });
            assert.deepEqual((await checkPublication(dir, pkg, await getState(dir), registry)).problems, [
                { kind: 'version-not-bumped', version: '1.0.0', commitsAfterPublish: 1 },
            ]);
        });
        it('versión sin publicar y paquete no publicado', async function () {
            const { dir } = await setup();
            const state = await getState(dir);
            const older = fakeRegistry({ x: packument('x', { '0.9.0': {} }, '0.9.0') });
            assert.deepEqual((await checkPublication(dir, pkg, state, older)).problems, [{ kind: 'unpublished-version', version: '1.0.0', latest: '0.9.0' }]);
            const noLatest = fakeRegistry({ x: packument('x', {}) });
            assert.deepEqual((await checkPublication(dir, pkg, state, noLatest)).problems, [{ kind: 'unpublished-version', version: '1.0.0', latest: null }]);
            assert.deepEqual((await checkPublication(dir, pkg, state, fakeRegistry({}))).problems, [{ kind: 'not-published', version: '1.0.0' }]);
        });
        it('omite los paquetes privados y advierte si falta name o version', async function () {
            const registry = fakeRegistry({});
            assert.deepEqual(await checkPublication('.', parsePackageJson('{"name":"x","private":true}'), null, registry), { problems: [], warnings: [] });
            assert.equal((await checkPublication('.', parsePackageJson('{"name":"x"}'), null, registry)).warnings.length, 1);
        });
        it('advierte cuando no puede comparar con el commit publicado', async function () {
            const { dir, published } = await setup();
            const state = await getState(dir);
            const sinGitHead = fakeRegistry({ x: packument('x', { '1.0.0': {} }) });
            assert.match((await checkPublication(dir, pkg, state, sinGitHead)).warnings[0]?.message ?? '', /gitHead/);
            const conGitHead = fakeRegistry({ x: packument('x', { '1.0.0': { gitHead: published } }) });
            assert.match((await checkPublication(dir, pkg, null, conGitHead)).warnings[0]?.message ?? '', /no hay commit local/);
            const inexistente = fakeRegistry({ x: packument('x', { '1.0.0': { gitHead: '0123456789012345678901234567890123456789' } }) });
            assert.match((await checkPublication(dir, pkg, state, inexistente)).warnings[0]?.message ?? '', /no está en el repositorio local/);
            // el HEAD local queda detrás del commit publicado
            await writeFile(join(dir, 'b.txt'), 'b');
            git(dir, 'add', '.');
            git(dir, 'commit', '-q', '-m', 'b');
            const posterior = git(dir, 'rev-parse', 'HEAD');
            git(dir, 'reset', '-q', '--hard', published);
            const adelantado = fakeRegistry({ x: packument('x', { '1.0.0': { gitHead: posterior } }) });
            assert.match((await checkPublication(dir, pkg, await getState(dir), adelantado)).warnings[0]?.message ?? '', /no desciende/);
        });
    });

    describe('checkDependencies', function () {
        const ncu = (target: NcuConfig['target'] = 'latest', reject: string | null = null): NcuConfig => ({ reject: reject === null ? null : packageMatcher(reject), filter: null, target });
        const allFields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;
        const pkg = parsePackageJson(packageJson({
            name: 'a',
            dependencies: { b: '^1.2.0', c: '^2.0.0', externo: '^1.0.0', d: 'file:../d', f: '^1.0.0' },
            devDependencies: { e: '^1.0.0', a: '^0.0.1' },
        }));
        const local = new Map([['a', '1.0.0'], ['b', '1.3.0'], ['c', '2.0.0'], ['d', '1.0.0'], ['e', 'no-semver']]);
        const registry = fakeRegistry({
            b: packument('b', { '1.2.0': {}, '1.2.5': {} }, '1.2.5'),
            c: packument('c', { '2.0.0': {} }, '2.0.0'),
            externo: packument('externo', { '1.0.0': {}, '1.4.0': {}, '2.0.0': {} }, '2.0.0'),
        });
        it('informa las desactualizadas respecto de la copia local y de npm, con las dos versiones', async function () {
            const result = await checkDependencies(pkg, local, registry, ncu(), allFields);
            assert.deepEqual(result.problems, [
                { kind: 'outdated-dependency', dependency: 'b', field: 'dependencies', declared: '^1.2.0', local: '1.3.0', published: '1.2.5' },
                { kind: 'outdated-dependency', dependency: 'externo', field: 'dependencies', declared: '^1.0.0', local: null, published: '2.0.0' },
            ]);
            assert.deepEqual(result.warnings.map(function (warning) { return warning.message; }), [
                'd: la versión declarada "file:../d" (dependencies) no es un rango semver',
                'f no está publicado en npm',
                'e: la versión local "no-semver" no es semver',
                'e no está publicado en npm',
            ]);
        });
        it('respeta target y reject de ncu, también para la copia local', async function () {
            const minor = await checkDependencies(pkg, local, registry, ncu('minor'), ['dependencies']);
            assert.deepEqual(minor.problems.map(function (problem) { return problem.kind === 'outdated-dependency' ? [problem.dependency, problem.published] : []; }), [['b', '1.2.5'], ['externo', '1.4.0']]);
            const patch = await checkDependencies(pkg, new Map([['b', '1.3.0']]), registry, ncu('patch'), ['dependencies']);
            assert.deepEqual(patch.problems.map(function (problem) { return problem.kind === 'outdated-dependency' ? [problem.dependency, problem.local, problem.published] : []; }), [['b', '1.3.0', '1.2.5']]);
            const rejected = await checkDependencies(pkg, local, registry, ncu('latest', 'b, externo'), ['dependencies']);
            assert.deepEqual(rejected.problems, []);
        });
        it('solo revisa los campos indicados e informa los errores de npm como advertencias', async function () {
            const failing = fakeRegistry({});
            failing.getVersions = async function () { throw new Error('sin red'); };
            const result = await checkDependencies(pkg, new Map(), failing, ncu(), ['devDependencies']);
            assert.deepEqual(result.problems, []);
            assert.deepEqual(result.warnings.map(function (warning) { return warning.message; }), ['e: no se pudo consultar npm (sin red)']);
        });
    });

    describe('compareWithTarball', function () {
        it('detecta archivos modificados, faltantes y sobrantes; ignora el node_modules interno', async function () {
            const dir = await tempDir();
            await writeFiles(dir, { 'package.json': '{}', 'a.js': 'cambiado', 'extra.js': 'x', 'node_modules/y/index.js': 'y' });
            const tarball = filesMap({ 'package.json': '{}', 'a.js': 'original', 'b.js': 'b' });
            assert.deepEqual(await compareWithTarball(dir, tarball), [
                { path: 'a.js', kind: 'modified' },
                { path: 'b.js', kind: 'missing' },
                { path: 'extra.js', kind: 'extra' },
            ]);
        });
        it('acepta el shebang de los ejecutables con LF en lugar de CRLF (como lo instala npm)', async function () {
            const dir = await tempDir();
            await writeFiles(dir, { 'package.json': '{"bin":{"x":"./bin/x.js"}}', 'bin/x.js': '#!/usr/bin/env node\n\r\nok\r\n', 'other.js': '#!/usr/bin/env node\nok\r\n' });
            const tarball = filesMap({ 'package.json': '{"bin":{"x":"./bin/x.js"}}', 'bin/x.js': '#!/usr/bin/env node\r\n\r\nok\r\n', 'other.js': '#!/usr/bin/env node\r\nok\r\n' });
            assert.deepEqual(await compareWithTarball(dir, tarball), [{ path: 'other.js', kind: 'modified' }]);
        });
        it('installedBinContent no cambia lo que no es un shebang con CRLF', function () {
            assert.equal(Buffer.from(installedBinContent(Buffer.from('a\r\nb'))).toString(), 'a\r\nb');
            assert.equal(Buffer.from(installedBinContent(Buffer.from('#!x\nb'))).toString(), '#!x\nb');
        });
    });

    describe('checkInstallation', function () {
        const tarballUrl = 'https://registry.example/b-1.0.0.tgz';
        const lock = JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/b': { version: '1.0.0', resolved: tarballUrl } } });
        it('sin node_modules no hay nada que revisar', async function () {
            assert.deepEqual(await checkInstallation(await tempDir(), new Set(['b']), fakeRegistry({})), { problems: [], warnings: [] });
        });
        it('detecta enlaces simbólicos y copias', async function () {
            const dir = await tempDir();
            await writeFiles(dir, {
                'package-lock.json': lock,
                'node_modules/b/package.json': '{"version":"1.0.1"}',
                'node_modules/@s/c/package.json': '{}',
                'node_modules/.bin/x': '',
                'target/package.json': '{}',
            });
            await symlink(join(dir, 'target'), join(dir, 'node_modules', 'linked'), 'junction');
            const registry = fakeRegistry({}, { [tarballUrl]: filesMap({ 'package.json': '{"version":"1.0.0"}' }) });
            const result = await checkInstallation(dir, new Set(['b', '@s/c']), registry);
            assert.deepEqual(result.problems, [
                { kind: 'linked-dependency', dependency: 'linked', target: join(dir, 'target') },
                { kind: 'copied-dependency', dependency: 'b', version: '1.0.0', installedVersion: '1.0.1', differences: [{ path: 'package.json', kind: 'modified' }] },
            ]);
            assert.deepEqual(result.warnings.map(function (w) { return w.message; }), ['@s/c no figura en package-lock.json']);
        });
        it('sin problemas si coincide con lo publicado (tarball obtenido del registro si el lock no tiene resolved)', async function () {
            const dir = await tempDir();
            await writeFiles(dir, {
                'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/b': { version: '1.0.0' } } }),
                'node_modules/b/package.json': '{"version":"1.0.0"}',
            });
            const registry = fakeRegistry({ b: packument('b', { '1.0.0': {} }) }, { [tarballUrl]: filesMap({ 'package.json': '{"version":"1.0.0"}' }) });
            assert.deepEqual(await checkInstallation(dir, new Set(['b']), registry), { problems: [], warnings: [] });
        });
        it('advierte cuando no puede verificar', async function () {
            const dir = await tempDir();
            await writeFiles(dir, { 'node_modules/b/package.json': '{}' });
            assert.match((await checkInstallation(dir, new Set(['b']), fakeRegistry({}))).warnings[0]?.message ?? '', /no hay package-lock.json/);
            await writeFile(join(dir, 'package-lock.json'), '{"lockfileVersion":1}');
            assert.match((await checkInstallation(dir, new Set(['b']), fakeRegistry({}))).warnings[0]?.message ?? '', /sin "packages"/);
            await writeFile(join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/b': { version: '1.0.0', resolved: 'file:../b' } } }));
            assert.match((await checkInstallation(dir, new Set(['b']), fakeRegistry({}))).warnings[0]?.message ?? '', /no se encontró el tarball/);
        });
    });
});

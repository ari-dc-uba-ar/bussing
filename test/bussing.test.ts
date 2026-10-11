import { strict as assert } from 'node:assert';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { reviewEnvironment } from '../dist/bussing.js';
import { fakeRegistry, gitRepo, packageJson, packument, tempDir, writeFiles } from './helpers.js';

describe('bussing', function () {
    it('informa con claridad las carpetas inexistentes o que no son carpetas', async function () {
        const dir = await tempDir();
        await writeFile(join(dir, 'archivo'), '');
        await assert.rejects(reviewEnvironment({ roots: [] }), /No se indicó ninguna carpeta/);
        await assert.rejects(reviewEnvironment({ roots: [join(dir, 'no-existe')] }), /La carpeta .*no-existe no existe/);
        await assert.rejects(reviewEnvironment({ roots: [join(dir, 'archivo')] }), /archivo no es una carpeta/);
    });

    it('reviewEnvironment revisa los repositorios y arma el orden de limpieza', async function () {
        const root = await tempDir();
        const baseHead = await gitRepo(join(root, 'base'), { 'package.json': packageJson({ name: 'base', version: '1.1.0' }), '.gitignore': 'node_modules\n' });
        await gitRepo(join(root, 'app'), { 'package.json': packageJson({ name: 'app', version: '1.0.0', private: true, dependencies: { base: '^1.0.0' } }) });
        await gitRepo(join(root, 'dup1'), { 'package.json': packageJson({ name: 'dup', version: '1.0.0', private: true }) });
        await gitRepo(join(root, 'dup2'), { 'package.json': packageJson({ name: 'dup', version: '1.0.0', private: true }) });
        await writeFiles(join(root, 'roto'), { 'package.json': '{ no es json' });
        await writeFiles(join(root, 'no-es-repo'), { 'otro.txt': '' });
        const registry = fakeRegistry({ base: packument('base', { '1.0.0': { gitHead: baseHead } }, '1.0.0') });
        const messages: string[] = [];
        const report = await reviewEnvironment({ roots: [root], registry, log: function (message) { messages.push(message); } });
        assert.deepEqual(report.repos.map(function (repo) { return [repo.name, repo.problems.map(function (p) { return p.kind; })]; }), [
            ['app', ['no-upstream', 'outdated-dependency']],
            ['base', ['no-upstream', 'unpublished-version']],
            ['dup', ['no-upstream']],
            ['dup', ['no-upstream']],
            [null, []],
        ]);
        assert.match(report.repos[4]?.warnings[0]?.message ?? '', /no se pudo leer package.json/);
        assert.deepEqual(report.cleanupOrder.map(function (step) { return [step.level, step.name]; }), [[0, 'base'], [0, 'dup'], [0, 'dup'], [1, 'app']]);
        assert.match(report.warnings[0]?.message ?? '', /el paquete dup está en varios repositorios/);
        assert.equal(messages[0], '5 repositorios encontrados');
    });

    it('no revisa las subcarpetas indicadas en ignore', async function () {
        const root = await tempDir();
        await gitRepo(join(root, 'x'), { 'package.json': packageJson({ name: 'x', version: '1.0.0', private: true }) });
        await gitRepo(join(root, 'viejo'), { 'package.json': packageJson({ name: 'x', version: '0.1.0', private: true }) });
        const report = await reviewEnvironment({ roots: [root], ignore: ['viejo', 'no-esta'], registry: fakeRegistry({}) });
        assert.deepEqual(report.repos.map(function (repo) { return repo.dir; }), [join(root, 'x')]);
        assert.deepEqual(report.ignored, [join(root, 'viejo')]);
        assert.deepEqual(report.warnings, [{ check: 'repo', message: 'ninguna carpeta de repositorio se llama no-esta (ignore)' }]);
    });

    it('advierte las prioridades de paquetes que no están entre los revisados', async function () {
        const root = await tempDir();
        await gitRepo(join(root, 'x'), { 'package.json': packageJson({ name: 'x', version: '1.0.0', private: true }) });
        const report = await reviewEnvironment({ roots: [root], dependencyPriority: { x: 1, otro: -1 }, registry: fakeRegistry({}) });
        assert.deepEqual(report.warnings, [{ check: 'order', message: 'ningún repositorio revisado tiene el paquete otro (prioridad de dependencia)' }]);
    });

    it('"espera dependencias" solo si la dependencia queda antes en el orden', async function () {
        const root = await tempDir();
        await writeFiles(join(root, 'a'), { 'package.json': packageJson({ name: 'a', version: '1.0.0', private: true, devDependencies: { b: '^0.1.0' } }) });
        await writeFiles(join(root, 'b'), { 'package.json': packageJson({ name: 'b', version: '0.2.0', private: true, devDependencies: { a: '^0.9.0' } }) });
        const report = await reviewEnvironment({ roots: [root], registry: fakeRegistry({}) });
        assert.deepEqual(report.cleanupOrder.map(function (step) { return [step.level, step.name, step.mainProblem, step.dependsOn, step.deferred]; }), [
            [0, 'b', 'outdated-dev-dependencies', [], ['a']],
            [1, 'a', 'waiting-dev-dependencies', ['b'], []],
        ]);
    });

    it('un control que falla se informa como advertencia', async function () {
        const root = await tempDir();
        await gitRepo(join(root, 'x'), { 'package.json': packageJson({ name: 'x', version: '1.0.0' }) });
        const registry = fakeRegistry({});
        registry.getPackument = async function () { throw new Error('sin red'); };
        const report = await reviewEnvironment({ roots: [root], registry });
        assert.deepEqual(report.repos[0]?.warnings, [{ check: 'publication', message: 'falló el control: sin red' }]);
    });
});

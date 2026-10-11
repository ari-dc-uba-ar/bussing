import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { describeProblem, EXIT_CODE, formatReport, main, parseArgs, parsePriority, readDefaults } from '../dist/bussing-cli.js';
import type { BussingReport, Problem } from '../dist/types.js';
import { gitRepo, packageJson, tempDir } from './helpers.js';

describe('bussing-cli', function () {
    describe('readDefaults', function () {
        it('sin archivo o vacío no hay valores por omisión', async function () {
            const dir = await tempDir();
            assert.deepEqual(readDefaults(join(dir, 'no-existe.yaml'), 'x'), {});
            await writeFile(join(dir, 'vacio.yaml'), '');
            assert.deepEqual(readDefaults(join(dir, 'vacio.yaml'), 'x'), {});
        });
        it('lee una lista de carpetas o una sola', async function () {
            const dir = await tempDir();
            const file = join(dir, 'd.yaml');
            await writeFile(file, 'path:\n  - repos\n  - /absoluta\nignore: [viejo, otro]\npriority:\n  qa-control: 1\n  require-bro: -1\nregistry: https://r.example/\njson: true\n');
            assert.deepEqual(readDefaults(file, 'x'), {
                path: ['repos', '/absoluta'], ignore: ['viejo', 'otro'], priority: { 'qa-control': 1, 'require-bro': -1 }, registry: 'https://r.example/', json: true,
            });
            await writeFile(file, 'path: repos\nignore: viejo\n');
            assert.deepEqual(readDefaults(file, 'x'), { path: ['repos'], ignore: ['viejo'] });
        });
        it('informa los errores comunes', async function () {
            const dir = await tempDir();
            const file = join(dir, 'd.yaml');
            await writeFile(file, 'paths: [a]\n');
            assert.throws(function () { readDefaults(file, '~/x.yaml'); }, /^Error: ~\/x\.yaml tiene claves desconocidas: paths \(las claves válidas son: path, ignore, priority, registry, json\)$/);
            await writeFile(file, 'path: [a\n');
            assert.throws(function () { readDefaults(file, '~/x.yaml'); }, /^Error: ~\/x\.yaml no es un YAML válido/);
            await writeFile(file, '- a\n');
            assert.throws(function () { readDefaults(file, '~/x.yaml'); }, /^Error: ~\/x\.yaml no contiene claves y valores$/);
            await writeFile(file, 'json: 3\n');
            assert.throws(function () { readDefaults(file, '~/x.yaml'); }, /^Error: ~\/x\.yaml tiene valores de tipo incorrecto \(.*json/);
        });
    });

    describe('parseArgs', function () {
        /** Descarta la línea con la versión. */
        function ignoreOutput(): void { /* nada */ }
        it('los parámetros tienen prioridad sobre los valores por omisión', function () {
            const defaults = { path: ['/d1', '/d2'], ignore: ['v'], priority: { d: 1 }, registry: 'https://d.example/', json: true };
            assert.deepEqual(parseArgs([], defaults, ignoreOutput), { roots: ['/d1', '/d2'], ignore: ['v'], priority: { d: 1 }, registry: 'https://d.example/', json: true });
            assert.deepEqual(parseArgs(['--path', '/a', '-p', '/b', '--ignore', 'x', '--ignore', 'y', '--priority', 'q=2', '--priority', 'r=-1', '--registry', 'https://a.example/'], defaults, ignoreOutput), {
                roots: ['/a', '/b'], ignore: ['x', 'y'], priority: { q: 2, r: -1 }, registry: 'https://a.example/', json: true,
            });
            assert.deepEqual(parseArgs(['-p', '/a', '--json'], {}, ignoreOutput).json, true);
        });
        it('las carpetas relativas son relativas a la carpeta actual', function () {
            assert.deepEqual(parseArgs(['-p', 'a'], {}, ignoreOutput).roots, [join(process.cwd(), 'a')]);
            assert.deepEqual(parseArgs([], { path: ['b'] }, ignoreOutput).roots, [join(process.cwd(), 'b')]);
        });
        it('parsePriority', function () {
            assert.deepEqual(parsePriority('qa-control=1'), ['qa-control', 1]);
            assert.deepEqual(parsePriority('@s/p=-3'), ['@s/p', -3]);
            assert.throws(function () { parsePriority('qa-control'); }, /^Error: --priority qa-control no tiene la forma paquete=número$/);
            assert.throws(function () { parsePriority('x=uno'); }, /no tiene la forma/);
        });
        it('sin carpetas es un error', function () {
            assert.throws(function () { parseArgs([], {}, ignoreOutput); }, /^Error: Falta indicar la carpeta con --path o definir los parámetros predeterminados en ~\/\.bussing\.yaml$/);
        });
    });

    it('describeProblem describe cada tipo de problema', function () {
        const problems: Problem[] = [
            { kind: 'uncommitted', files: ['a', 'b', 'c', 'd', 'e', 'f'] },
            { kind: 'unpushed', commits: 1 },
            { kind: 'no-upstream', branch: 'main' },
            { kind: 'not-published', version: '1.0.0' },
            { kind: 'unpublished-version', version: '1.0.0', latest: null },
            { kind: 'version-not-bumped', version: '1.0.0', commitsAfterPublish: 2 },
            { kind: 'outdated-dependency', dependency: 'b', field: 'dependencies', declared: '^1.0.0', local: '1.1.0' },
            { kind: 'linked-dependency', dependency: 'b', target: '../b' },
            { kind: 'copied-dependency', dependency: 'b', version: '1.0.0', installedVersion: null, differences: [{ path: 'a.js', kind: 'modified' }] },
        ];
        assert.deepEqual(problems.map(describeProblem), [
            '6 archivos sin commitear: a, b, c, d, e, … (1 más)',
            '1 commit sin pushear',
            'la rama main no tiene upstream',
            'el paquete no está publicado en npm (versión local 1.0.0)',
            'versión 1.0.0 sin publicar (en npm: sin latest)',
            'versión 1.0.0 sin subir: 2 commits posteriores a la publicación',
            'dependencia desactualizada: b "^1.0.0" (dependencies), versión local 1.1.0',
            'node_modules/b es un enlace a ../b',
            'node_modules/b no coincide con la versión publicada 1.0.0 (el package.json instalado dice ?): a.js (modified)',
        ]);
    });

    it('formatReport', function () {
        const report: BussingReport = {
            repos: [
                { dir: '/r/a', name: 'a', version: '1.0.0', problems: [{ kind: 'unpushed', commits: 2 }], warnings: [] },
                { dir: '/r/b', name: null, version: null, problems: [], warnings: [{ check: 'repo', message: 'algo' }] },
                { dir: '/r/c', name: 'c', version: null, problems: [], warnings: [] },
            ],
            ignored: ['/r/viejo'],
            cleanupOrder: [
                { name: 'a', dir: '/r/a', level: 0, mainProblem: 'unpushed', dependsOn: [], inCycleWith: [], deferred: ['q'] },
                { name: 'x', dir: '/r/x2', level: 1, mainProblem: null, dependsOn: ['a'], inCycleWith: ['y'], deferred: ['p', 'q'] },
            ],
            warnings: [{ check: 'cross-dependencies', message: 'global' }],
        };
        assert.equal(formatReport(report), [
            '1 repositorio con problemas de 3 revisados (1 ignorado: viejo)',
            '',
            'a@1.0.0  /r/a',
            '  - 2 commits sin pushear',
            '',
            '/r/b',
            '  ? advertencia (repo): algo',
            '',
            'Orden de limpieza (los del mismo número no dependen entre sí):',
            '  1. a  falta pushear  (ciclo: q se actualiza después)',
            '  2. x [x2]  por dependencia  (depende de a; ciclo con y; ciclo: p, q se actualizan después)',
            '',
            'advertencia (cross-dependencies): global',
            '',
        ].join('\n'));
    });

    it('main: errores y ejecución con los valores por omisión', async function () {
        const home = await tempDir();
        const previous = process.env['HOME'];
        const stdoutWrite = process.stdout.write;
        const stderrWrite = process.stderr.write;
        const stdout: string[] = [];
        const stderr: string[] = [];
        process.env['HOME'] = home;
        process.stdout.write = function (chunk: string | Uint8Array) { stdout.push(String(chunk)); return true; };
        process.stderr.write = function (chunk: string | Uint8Array) { stderr.push(String(chunk)); return true; };
        try {
            assert.equal(await main([]), EXIT_CODE.error);
            assert.match(stdout.join(''), /^bussing v\d+\.\d+\.\d+\n$/);
            assert.match(stderr.join(''), /^bussing: Falta indicar la carpeta/);
            stdout.length = 0;
            const repos = join(home, 'repos');
            await mkdir(repos);
            await gitRepo(join(repos, 'x'), { 'package.json': packageJson({ name: 'x', version: '1.0.0', private: true }) });
            await writeFile(join(home, '.bussing.yaml'), `path: ${JSON.stringify(repos)}\njson: true\n`);
            assert.equal(await main([]), EXIT_CODE.problems);
            const report: BussingReport = JSON.parse(stdout.join(''));
            assert.deepEqual(report.repos[0]?.problems, [{ kind: 'no-upstream', branch: 'main' }]);
        } finally {
            process.stdout.write = stdoutWrite;
            process.stderr.write = stderrWrite;
            process.env['HOME'] = previous;
        }
    });
});

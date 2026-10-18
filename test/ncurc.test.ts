import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { allowedByTarget, isChecked, packageMatcher, readNcuConfig, targetVersion, type NcuTarget } from '../src/ncurc.js';
import type { PackageVersions } from '../src/types.js';
import { tempDir, writeFiles } from './helpers.js';

describe('ncurc', function () {
    it('packageMatcher acepta nombres, listas, globs y expresiones regulares', function () {
        const matches = packageMatcher(['qa-control, best-globals', '@types/*', '/^react-/']);
        assert.deepEqual(['qa-control', 'best-globals', '@types/node', 'react-dom', 'react', 'otro'].map(matches), [true, true, true, true, false, false]);
        assert.equal(packageMatcher('a b')('b'), true);
    });

    it('readNcuConfig: la del repositorio tiene prioridad sobre la del usuario, clave por clave', async function () {
        const user = await tempDir();
        const repo = await tempDir();
        await writeFiles(user, { '.ncurc.json': JSON.stringify({ reject: ['x'], target: 'minor' }) });
        await writeFiles(repo, { '.ncurc.yml': 'reject:\n  - y\n' });
        const { config, warnings } = await readNcuConfig(repo, user);
        assert.deepEqual(warnings, []);
        assert.equal(config.target, 'minor');
        assert.deepEqual([isChecked(config, 'x'), isChecked(config, 'y')], [true, false]);
    });

    it('readNcuConfig: sin archivos, valores por omisión; advierte lo que no interpreta', async function () {
        const empty = await tempDir();
        const none = await readNcuConfig(empty, empty);
        assert.deepEqual(none, { config: { reject: null, filter: null, target: 'latest' }, warnings: [] });
        const repo = await tempDir();
        await writeFiles(repo, { '.ncurc.js': 'module.exports = {}', '.ncurc': 'target: "@next"\nfilter: "a"\n' });
        const result = await readNcuConfig(repo, empty);
        assert.deepEqual(result.warnings, [`${join(repo, '.ncurc.js')} contiene código y no se interpreta`]);
        assert.equal(result.config.target, '@next');
        assert.deepEqual([isChecked(result.config, 'a'), isChecked(result.config, 'b')], [true, false]);
        await writeFiles(repo, { '.ncurc': 'target: cualquiera\n' });
        assert.match((await readNcuConfig(repo, empty)).warnings[1] ?? '', /target "cualquiera" de ncu no se reconoce/);
        await writeFiles(repo, { '.ncurc': 'reject: 3\n' });
        assert.match((await readNcuConfig(repo, empty)).warnings[1] ?? '', /no se pudo interpretar/);
    });

    it('targetVersion y allowedByTarget siguen los valores de target de ncu', function () {
        const published: PackageVersions = { name: 'x', distTags: { latest: '2.0.0', next: '3.0.0-beta.1' }, versions: ['1.2.0', '1.2.5', '1.4.0', '2.0.0', '3.0.0-beta.1'] };
        const time = { '1.2.0': '2020', '1.2.5': '2024', '1.4.0': '2021', '2.0.0': '2022', '3.0.0-beta.1': '2023' };
        const targets: NcuTarget[] = ['latest', 'greatest', 'newest', 'minor', 'patch', 'semver', '@next', '@nada'];
        assert.deepEqual(targets.map(function (value) { return targetVersion(value, published, '1.2.0', '^1.2.0', time); }), [
            '2.0.0', '3.0.0-beta.1', '1.2.5', '1.4.0', '1.2.5', '1.4.0', '3.0.0-beta.1', null,
        ]);
        assert.deepEqual([allowedByTarget('minor', '2.0.0', '1.2.0', '^1.2.0'), allowedByTarget('patch', '1.3.0', '1.2.0', '^1.2.0'), allowedByTarget('semver', '1.9.0', '1.2.0', '^1.2.0'), allowedByTarget('latest', '9.0.0', '1.2.0', '^1.2.0')], [false, false, true, true]);
    });
});

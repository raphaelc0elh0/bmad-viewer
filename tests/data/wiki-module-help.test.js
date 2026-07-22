import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildDataModel } from '../../src/data/data-model.js';

describe('wiki module-help.csv fallback', () => {
	let root;

	before(() => {
		root = mkdtempSync(join(tmpdir(), 'bmad-viewer-wiki-'));
		const bmad = join(root, '_bmad');

		// Module `alpha`: only config.yaml + module-help.csv (BMAD v6 layout, skills relocated).
		mkdirSync(join(bmad, 'alpha'), { recursive: true });
		writeFileSync(join(bmad, 'alpha', 'config.yaml'), 'version: 6\n');
		writeFileSync(join(bmad, 'alpha', 'module-help.csv'),
			'module,skill,display-name,menu-code,description,action,args,phase,preceded-by,followed-by,required,output-location,outputs\n' +
			'Alpha,_meta,,,,,,,,,false,,\n' +
			'Alpha,alpha-plan,Plan It,PL,Plan the work before doing it.,,,anytime,,,false,out,a plan\n' +
			'Alpha,alpha-nodesc,,ND,,,,anytime,,,false,,\n');

		// Module `beta`: a real SKILL.md — the manifest fallback must NOT override it.
		mkdirSync(join(bmad, 'beta', 'beta-build'), { recursive: true });
		writeFileSync(join(bmad, 'beta', 'beta-build', 'SKILL.md'), '# Beta Build\n\nDoes beta things.\n');
		writeFileSync(join(bmad, 'beta', 'module-help.csv'),
			'module,skill,display-name,menu-code,description\nBeta,beta-ignored,Ignored,IG,should not appear\n');
	});

	after(() => rmSync(root, { recursive: true, force: true }));

	it('builds skill items from module-help.csv when no SKILL.md exists', () => {
		const { wiki } = buildDataModel(root);
		const alpha = wiki.modules.find((m) => m.id === 'alpha');
		assert.ok(alpha, 'alpha module should be present');
		const items = alpha.groups.flatMap((g) => g.items);
		// _meta is skipped; alpha-plan + alpha-nodesc remain.
		assert.deepEqual(items.map((i) => i.name).sort(), ['Alpha Nodesc', 'Plan It']);
		assert.equal(items.every((i) => i.type === 'skill'), true);
	});

	it('renders the description and menu metadata in the detail HTML', () => {
		const { wiki } = buildDataModel(root);
		const plan = buildDataModel(root).wiki.modules
			.find((m) => m.id === 'alpha').groups.flatMap((g) => g.items)
			.find((i) => i.id === 'alpha/alpha-plan');
		assert.match(plan.html, /Plan the work before doing it\./);
		assert.match(plan.html, /Menu code:<\/strong> PL/);
		assert.match(plan.html, /module-help\.csv/);
		assert.ok(wiki); // sanity
	});

	it('does not override a real SKILL.md with the manifest fallback', () => {
		const { wiki } = buildDataModel(root);
		const beta = wiki.modules.find((m) => m.id === 'beta');
		const items = beta.groups.flatMap((g) => g.items);
		assert.deepEqual(items.map((i) => i.id), ['beta/beta-build']);
		assert.equal(items.some((i) => i.id.includes('beta-ignored')), false);
	});
});

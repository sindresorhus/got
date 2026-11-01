import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import type {FilterData} from '../source/index.js';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

type Item = {id: number; flag: boolean};

for (const [name, file, marker] of [
	['guide', '../documentation/4-pagination.md', 'If you want to stop after emitting the entry,'],
	['type documentation', '../source/core/options.ts', 'If you want to stop **after** emitting the entry,'],
] as const) {
	// eslint-disable-next-line no-await-in-loop -- Each document registers its own test matrix.
	const documentation = await fs.readFile(new URL(file, import.meta.url), 'utf8');
	const section = documentation.split(marker)[1];
	assert.ok(section);
	const predicate = /`(?<predicate>\(\{[^`]*=>[^`]+)`/v.exec(section)?.groups?.predicate;
	assert.ok(predicate);
	const shouldContinue = vm.runInNewContext(`(${predicate})`) as (data: FilterData<Item>) => boolean;

	for (const [scenario, pages, expected] of [
		['the first item is flagged', [[{id: 1, flag: true}, {id: 2, flag: false}]], [1]],
		['a later item is flagged', [[{id: 1, flag: false}, {id: 2, flag: true}, {id: 3, flag: false}]], [1, 2]],
		['the last item of a page is flagged', [[{id: 1, flag: false}, {id: 2, flag: true}], [{id: 3, flag: false}]], [1, 2]],
		['there is no flagged item', [[{id: 1, flag: false}], [{id: 2, flag: false}], []], [1, 2]],
	] as const) {
		test(`the ${name} stop-after example works when ${scenario}`, withServer, async (_t, server, got) => {
			let page = 0;
			server.get('/', (_request, response) => {
				response.json(pages[page++] ?? []);
			});
			const items = await got.paginate.all<Item>('', {
				pagination: {
					stackAllItems: true,
					shouldContinue,
					paginate: ({currentItems}) => currentItems.length > 0 ? {} : false,
				},
			});
			assert.deepStrictEqual(items.map(item => item.id), expected);
		});
	}
}

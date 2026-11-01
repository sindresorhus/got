import assert from 'node:assert/strict';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';
import runExample from './helpers/run-example.js';

const now = Date.now();
const first = {commit: {message: 'first', committer: {date: new Date(now).toISOString()}}};
const second = {commit: {message: 'second', committer: {date: new Date(now - 1000).toISOString()}}};
const old = {commit: {message: 'old', committer: {date: new Date(now - (8 * 86_400_000)).toISOString()}}};

for (const {name, pages, expectedPages, expectedMessages} of [
	{
		name: 'recent pages followed by an empty page', pages: [[first], [second], []], expectedPages: [1, 2, 3], expectedMessages: ['first', 'second'],
	},
	{
		name: 'an old first page', pages: [[old], []], expectedPages: [1], expectedMessages: [],
	},
	{
		name: 'the fifty-commit count limit',
		pages: [Array.from({length: 55}, (_, index) => ({commit: {message: `commit ${index}`, committer: {date: new Date(now).toISOString()}}}))],
		expectedPages: [1],
		expectedMessages: Array.from({length: 50}, (_, index) => `commit ${index}`),
	},
]) {
	test(`the pagination example handles ${name}`, withServer, async (_t, server) => {
		const requests: number[] = [];
		server.get('/', (request, response) => {
			const page = Number(request.query.page ?? 1);
			requests.push(page);
			response.json(pages[page - 1] ?? []);
		});
		const stdout = await runExample('pagination.js', [['\'https://api.github.com/repos/sindresorhus/got/commits\'', JSON.stringify(server.url)]]);
		assert.deepStrictEqual(stdout.trim().split('\n').slice(1), expectedMessages);
		assert.deepStrictEqual(requests, expectedPages);
	});
}

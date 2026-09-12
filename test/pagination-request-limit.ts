import {Buffer} from 'node:buffer';
import test from 'ava';
import ResponseLike from 'responselike';
import got from '../source/index.js';

test('pagination stops at requestLimit without parsing an unused next-page link', async t => {
	const items = await got.paginate.all<number>('https://example.com', {
		pagination: {requestLimit: 1},
		hooks: {
			beforeRequest: [() => new ResponseLike({
				statusCode: 200,
				headers: {link: 'not a link'},
				body: Buffer.from('[1]'),
				url: 'https://example.com',
			})],
		},
	});

	t.deepEqual(items, [1]);
});

for (const requestLimit of [0, 1, 3]) {
	test(`pagination only computes needed next pages with requestLimit ${requestLimit}`, async t => {
		let requests = 0;
		let callbacks = 0;
		const items = await got.paginate.all<number>('https://example.com', {
			hooks: {
				beforeRequest: [() => new ResponseLike({
					statusCode: 200,
					headers: {},
					body: Buffer.from(JSON.stringify([++requests])),
					url: 'https://example.com',
				})],
			},
			pagination: {
				requestLimit,
				paginate() {
					callbacks++;
					return {};
				},
			},
		});

		t.is(requests, requestLimit);
		t.is(items.length, requestLimit);
		t.is(callbacks, Math.max(0, requestLimit - 1));
	});
}

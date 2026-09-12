import test from 'ava';
import withServer from './helpers/with-server.js';

for (const searchParameters of [{page: 2}, 'page=2', new URLSearchParams({page: '2'})]) {
	test(`afterResponse retry applies ${typeof searchParameters === 'string' ? 'string' : searchParameters.constructor.name} search parameters to the new URL`, withServer, async (t, server, got) => {
		server.get('/first', (_request, response) => {
			response.end('first');
		});
		server.get('/next', (request, response) => {
			response.end(request.url);
		});

		const response = await got('first', {
			hooks: {
				afterResponse: [(_response, retryWithMergedOptions) => retryWithMergedOptions({
					url: new URL('/next?old=value', server.url),
					searchParams: searchParameters,
				})],
			},
		});

		t.is(response.body, '/next?page=2');
	});
}

for (const [searchParameters, expectedQuery] of [[undefined, '?old=value'], ['', ''], [{}, ''], [new URLSearchParams([['page', '2'], ['page', '3']]), '?page=2&page=3']] as const) {
	test(`afterResponse retry handles query override ${JSON.stringify(searchParameters)} producing ${expectedQuery}`, withServer, async (t, server, got) => {
		server.get('/first', (_request, response) => {
			response.end('first');
		});
		server.get('/next', (request, response) => {
			response.end(request.url);
		});

		const response = await got('first', {
			hooks: {
				afterResponse: [(_response, retryWithMergedOptions) => retryWithMergedOptions({
					url: new URL('/next?old=value', server.url),
					searchParams: searchParameters,
				})],
			},
		});

		t.is(response.body, `/next${expectedQuery}`);
	});
}

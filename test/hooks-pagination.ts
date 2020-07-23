import test from 'ava';
import withServer from './helpers/with-server';

test('no duplicate hooks in paginated requests', withServer, async (t, server, got) => {
	server.get('/get', (_request, response) => {
		response.end('i <3 unicorns');
	});

	let beforeHookCount = 0;
	let afterHookCount = 0;

	const hooks = {
		beforeRequest: [
			() => {
				beforeHookCount++;
			}
		],
		afterResponse: [
			(response: any) => {
				afterHookCount++;
				return response;
			}
		]
	};

	const instance = got.extend({
		hooks,
		pagination: {
			paginate: () => false,
			countLimit: 2009,
			transform: (response) => [response]
		}
	});

	await instance.paginate.all('/get');

	t.is(beforeHookCount, 1);
	t.is(afterHookCount, 1);
});

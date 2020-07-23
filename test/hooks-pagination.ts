import test from 'ava';
import withServer from './helpers/with-server';

test('no duplicate hook calls in single-page paginated requests', withServer, async (t, server, got) => {
	server.get('/get', (_request, response) => {
		response.end('i <3 koalas');
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

	// Test only one request
	const instance = got.extend({
		hooks,
		pagination: {
			paginate: () => false,
			countLimit: 2009,
			transform: response => [response]
		}
	});

	await instance.paginate.all('get');

	t.is(beforeHookCount, 1);
	t.is(afterHookCount, 1);

	await got.paginate.all('get', {
		hooks,
		pagination: {
			paginate: () => false,
			countLimit: 2009,
			transform: response => [response]
		}
	});

	t.is(beforeHookCount, 2);
	t.is(afterHookCount, 2);
});

test('no duplicate hook calls in sequential paginated requests', withServer, async (t, server, got) => {
	server.get('/get', (_request, response) => {
		response.end('i <3 unicorns');
	});

	let requestNumber = 0;
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

	// Test only two requests, one after another
	const paginate = () => requestNumber++ === 0 ? {} : false;

	const instance = got.extend({
		hooks,
		pagination: {
			paginate,
			countLimit: 2009,
			transform: response => [response]
		}
	});

	await instance.paginate.all('get');

	t.is(beforeHookCount, 2);
	t.is(afterHookCount, 2);
	requestNumber = 0;

	await got.paginate.all('get', {
		hooks,
		pagination: {
			paginate,
			countLimit: 2009,
			transform: response => [response]
		}
	});

	t.is(beforeHookCount, 4);
	t.is(afterHookCount, 4);
});

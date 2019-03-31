import test from 'ava';
import withServer from './helpers/with-server';

const jsonResponse = '{"data":"dog"}';

const defaultHandler = (request, response) => {
	response.end(jsonResponse);
};

test('options.resolveBodyOnly works', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	t.deepEqual(await got('', {responseType: 'json', resolveBodyOnly: true}), {data: 'dog'});
});

test('JSON response', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	t.deepEqual((await got('', {responseType: 'json'})).body, {data: 'dog'});
});

test('Buffer response', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	t.deepEqual((await got('', {responseType: 'buffer'})).body, Buffer.from(jsonResponse));
});

test('Text response', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	t.is((await got('', {responseType: 'text'})).body, jsonResponse);
});

test('JSON response - promise.json()', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	t.deepEqual(await got('').json(), {data: 'dog'});
});

test('Buffer response - promise.buffer()', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	t.deepEqual(await got('').buffer(), Buffer.from(jsonResponse));
});

test('Text response - promise.text()', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	t.is(await got('').text(), jsonResponse);
});

test('throws an error on invalid response type', withServer, async (t, server, got) => {
	server.get('/', defaultHandler);

	await t.throwsAsync(() => got('', {responseType: 'invalid'}), /^Failed to parse body of type 'invalid'/);
});

test('doesn\'t parse responses without a body', withServer, async (t, server, got) => {
	server.get('/no-body', (request, response) => {
		response.end();
	});

	const body = await got('no-body').json();
	t.is(body, '');
});

test('wraps parsing errors', withServer, async (t, server, got) => {
	server.get('/invalid', (request, response) => {
		response.end('/');
	});

	const error = await t.throwsAsync(() => got('invalid', {responseType: 'json'}));
	t.regex(error.message, /Unexpected token/);
	// @ts-ignore
	t.true(error.message.includes(error.hostname), error.message);
	// @ts-ignore
	t.is(error.path, '/invalid');
});

test('parses non-200 responses', withServer, async (t, server, got) => {
	server.get('/non200', (request, response) => {
		response.statusCode = 500;
		response.end(jsonResponse);
	});

	const error = await t.throwsAsync(() => got('non200', {responseType: 'json'}));
	// @ts-ignore
	t.deepEqual(error.response.body, {data: 'dog'});
});

test('ignores errors on invalid non-200 responses', withServer, async (t, server, got) => {
	server.get('/non200-invalid', (request, response) => {
		response.statusCode = 500;
		response.end('Internal error');
	});

	const error = await t.throwsAsync(() => got('non200-invalid', {responseType: 'json'}));
	t.is(error.message, 'Response code 500 (Internal Server Error)');
	// @ts-ignore
	t.is(error.response.body, 'Internal error');
	// @ts-ignore
	t.is(error.path, '/non200-invalid');
});

test('should have statusCode in error', withServer, async (t, server, got) => {
	server.get('/invalid', (request, response) => {
		response.end('/');
	});

	const error = await t.throwsAsync(() => got('invalid', {responseType: 'json'}));
	t.is(error.constructor, got.ParseError);
	// @ts-ignore
	t.is(error.statusCode, 200);
});

test('should set correct headers', withServer, async (t, server, got) => {
	server.post('/headers', (request, response) => {
		response.end(JSON.stringify(request.headers));
	});

	const {body: headers} = await got.post('headers', {responseType: 'json', json: {}});
	t.is(headers['content-type'], 'application/json');
	t.is(headers.accept, 'application/json');
});

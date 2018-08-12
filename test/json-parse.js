import test from 'ava';
import got from '../source';
import {createServer} from './helpers/server';

let s;

test.before('setup', async () => {
	s = await createServer();

	s.on('/', (request, response) => {
		response.end('{"data":"dog"}');
	});

	s.on('/invalid', (request, response) => {
		response.end('/');
	});

	s.on('/no-body', (request, response) => {
		response.statusCode = 200;
		response.end();
	});

	s.on('/non200', (request, response) => {
		response.statusCode = 500;
		response.end('{"data":"dog"}');
	});

	s.on('/non200-invalid', (request, response) => {
		response.statusCode = 500;
		response.end('Internal error');
	});

	s.on('/headers', (request, response) => {
		response.end(JSON.stringify(request.headers));
	});

	await s.listen(s.port);
});

test.after('cleanup', async () => {
	await s.close();
});

test('parses response', async t => {
	t.deepEqual((await got(s.url, {json: true})).body, {data: 'dog'});
});

test('not parses responses without a body', async t => {
	const {body} = await got(`${s.url}/no-body`, {json: true});
	t.is(body, '');
});

test('wraps parsing errors', async t => {
	const error = await t.throwsAsync(got(`${s.url}/invalid`, {json: true}));
	t.regex(error.message, /Unexpected token/);
	t.true(error.message.includes(error.hostname), error.message);
	t.is(error.path, '/invalid');
});

test('parses non-200 responses', async t => {
	const error = await t.throwsAsync(got(`${s.url}/non200`, {json: true}));
	t.deepEqual(error.response.body, {data: 'dog'});
});

test('ignores errors on invalid non-200 responses', async t => {
	const error = await t.throwsAsync(got(`${s.url}/non200-invalid`, {json: true}));
	t.is(error.message, 'Response code 500 (Internal Server Error)');
	t.is(error.response.body, 'Internal error');
	t.is(error.path, '/non200-invalid');
});

test('should have statusCode in error', async t => {
	const error = await t.throwsAsync(got(`${s.url}/invalid`, {json: true}));
	t.is(error.constructor, got.ParseError);
	t.is(error.statusCode, 200);
});

test('should set correct headers', async t => {
	const {body: headers} = await got(`${s.url}/headers`, {json: true, body: {}});
	t.is(headers['content-type'], 'application/json');
	t.is(headers.accept, 'application/json');
});

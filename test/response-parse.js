import test from 'ava';
import got from '../dist';
import {createServer} from './helpers/server';

let s;

const jsonResponse = '{"data":"dog"}';

test.before('setup', async () => {
	s = await createServer();

	s.on('/', (request, response) => {
		response.end(jsonResponse);
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
		response.end(jsonResponse);
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

test('options.resolveBodyOnly works', async t => {
	t.deepEqual(await got(s.url, {responseType: 'json', resolveBodyOnly: true}), {data: 'dog'});
});

test('JSON response', async t => {
	t.deepEqual((await got(s.url, {responseType: 'json'})).body, {data: 'dog'});
});

test('Buffer response', async t => {
	t.deepEqual((await got(s.url, {responseType: 'buffer'})).body, Buffer.from(jsonResponse));
});

test('Text response', async t => {
	t.is((await got(s.url, {responseType: 'text'})).body, jsonResponse);
});

test('JSON response - promise.json()', async t => {
	t.deepEqual(await got(s.url).json(), {data: 'dog'});
});

test('Buffer response - promise.buffer()', async t => {
	t.deepEqual(await got(s.url).buffer(), Buffer.from(jsonResponse));
});

test('Text response - promise.text()', async t => {
	t.is(await got(s.url).text(), jsonResponse);
});

test('throws an error on invalid response type', async t => {
	await t.throwsAsync(() => got(s.url, {responseType: 'invalid'}), /^Failed to parse body of type 'invalid'/);
});

test('doesn\'t parse responses without a body', async t => {
	const body = await got(`${s.url}/no-body`).json();
	t.is(body, '');
});

test('wraps parsing errors', async t => {
	const error = await t.throwsAsync(got(`${s.url}/invalid`, {responseType: 'json'}));
	t.regex(error.message, /Unexpected token/);
	t.true(error.message.includes(error.hostname), error.message);
	t.is(error.path, '/invalid');
});

test('parses non-200 responses', async t => {
	const error = await t.throwsAsync(got(`${s.url}/non200`, {responseType: 'json'}));
	t.deepEqual(error.response.body, {data: 'dog'});
});

test('ignores errors on invalid non-200 responses', async t => {
	const error = await t.throwsAsync(got(`${s.url}/non200-invalid`, {responseType: 'json'}));
	t.is(error.message, 'Response code 500 (Internal Server Error)');
	t.is(error.response.body, 'Internal error');
	t.is(error.path, '/non200-invalid');
});

test('should have statusCode in error', async t => {
	const error = await t.throwsAsync(got(`${s.url}/invalid`, {responseType: 'json'}));
	t.is(error.constructor, got.ParseError);
	t.is(error.statusCode, 200);
});

test('should set correct headers', async t => {
	const {body: headers} = await got(`${s.url}/headers`, {responseType: 'json', json: {}});
	t.is(headers['content-type'], 'application/json');
	t.is(headers.accept, 'application/json');
});

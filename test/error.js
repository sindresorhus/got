import http from 'http';
import test from 'ava';
import sinon from 'sinon';
import proxyquire from 'proxyquire';
import got from '../source';
import {createServer} from './helpers/server';

let s;

test.before('setup', async () => {
	s = await createServer();

	s.on('/', (req, res) => {
		res.statusCode = 404;
		res.end('not');
	});

	s.on('/default-status-message', (req, res) => {
		res.statusCode = 400;
		res.end('body');
	});

	s.on('/custom-status-message', (req, res) => {
		res.statusCode = 400;
		res.statusMessage = 'Something Exploded';
		res.end('body');
	});

	await s.listen(s.port);
});

test('properties', async t => {
	const err = await t.throws(got(s.url));
	t.truthy(err);
	t.truthy(err.response);
	t.false({}.propertyIsEnumerable.call(err, 'response'));
	t.false({}.hasOwnProperty.call(err, 'code'));
	t.is(err.message, 'Response code 404 (Not Found)');
	t.is(err.host, `${s.host}:${s.port}`);
	t.is(err.method, 'GET');
	t.is(err.protocol, 'http:');
	t.is(err.url, err.response.requestUrl);
	t.is(err.headers.connection, 'close');
	t.is(err.response.body, 'not');
});

test('dns message', async t => {
	const err = await t.throws(got('.com', {retries: 0}));
	t.truthy(err);
	t.regex(err.message, /getaddrinfo ENOTFOUND/);
	t.is(err.host, '.com');
	t.is(err.method, 'GET');
});

test('options.body error message', async t => {
	const err = await t.throws(got(s.url, {body: {}}));
	t.regex(err.message, /The `body` option must be a stream\.Readable, string or Buffer/);
});

test('options.body json error message', async t => {
	const err = await t.throws(got(s.url, {body: Buffer.from('test'), json: true}));
	t.regex(err.message, /The `body` option must be a plain Object or Array when the `json` option is used/);
});

test('options.body form error message', async t => {
	const err = await t.throws(got(s.url, {body: Buffer.from('test'), form: true}));
	t.regex(err.message, /The `body` option must be a plain Object when the `form` option is used/);
});

test('default status message', async t => {
	const err = await t.throws(got(`${s.url}/default-status-message`));
	t.is(err.statusCode, 400);
	t.is(err.statusMessage, 'Bad Request');
});

test('custom status message', async t => {
	const err = await t.throws(got(`${s.url}/custom-status-message`));
	t.is(err.statusCode, 400);
	t.is(err.statusMessage, 'Something Exploded');
});

test.serial('http.request error', async t => {
	const stub = sinon.stub(http, 'request').callsFake(() => {
		throw new TypeError('The header content contains invalid characters');
	});
	const err = await t.throws(got(s.url));
	t.true(err instanceof got.RequestError);
	t.is(err.message, 'The header content contains invalid characters');
	stub.restore();
});

test.serial('catch error in mimicResponse', async t => {
	const proxiedGot = proxyquire('..', {
		'mimic-response'() {
			throw new Error('Error in mimic-response');
		}
	});

	const err = await t.throws(proxiedGot(s.url));
	t.is(err.message, 'Error in mimic-response');
});

test.after('cleanup', async () => {
	await s.close();
});

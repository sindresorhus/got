import http from 'http';
import test from 'ava';
import sinon from 'sinon';
import getStream from 'get-stream';
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

	s.on('/body', async (req, res) => {
		const body = await getStream(req);
		res.end(body);
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
	const err = await t.throws(got('.com', {retry: 0}));
	t.truthy(err);
	t.regex(err.message, /getaddrinfo ENOTFOUND/);
	t.is(err.host, '.com');
	t.is(err.method, 'GET');
});

test('options.body error message', async t => {
	await t.throws(got(s.url, {body: {}}), {
		message: 'The `body` option must be a stream.Readable, string or Buffer'
	});
});

test('options.body json error message', async t => {
	await t.throws(got(s.url, {body: Buffer.from('test'), json: true}), {
		message: 'The `body` option must be an Object or Array when the `json` option is used'
	});
});

test('options.body form error message', async t => {
	await t.throws(got(s.url, {body: Buffer.from('test'), form: true}), {
		message: 'The `body` option must be an Object when the `form` option is used'
	});
});

test('no plain object restriction on body', async t => {
	function CustomObject() {
		this.a = 123;
	}

	const {body} = await got(`${s.url}/body`, {body: new CustomObject(), json: true});

	t.deepEqual(body, {a: 123});
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
	await t.throws(got(s.url), {instanceOf: got.RequestError, message: 'The header content contains invalid characters'});
	stub.restore();
});

test.serial('catch error in mimicResponse', async t => {
	const mimicResponse = () => {
		throw new Error('Error in mimic-response');
	};
	mimicResponse['@global'] = true;

	const proxiedGot = proxyquire('..', {
		'mimic-response': mimicResponse
	});

	await t.throws(proxiedGot(s.url), {message: 'Error in mimic-response'});
});

test.after('cleanup', async () => {
	await s.close();
});

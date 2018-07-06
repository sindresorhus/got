import test from 'ava';
import got from '../source';
import {createServer} from './helpers/server';

let s;

test.before('setup', async () => {
	s = await createServer();

	s.on('/', (req, res) => {
		req.resume();
		res.end(JSON.stringify(req.headers));
	});

	await s.listen(s.port);
});

test.after('cleanup', async () => {
	await s.close();
});

test('preserve global defaults', async t => {
	const globalHeaders = (await got(s.url, {json: true})).body;
	const instanceHeaders = (await got.fork()(s.url, {json: true})).body;
	t.deepEqual(instanceHeaders, globalHeaders);
});

test('support instance defaults', async t => {
	const instance = got.fork({
		headers: {
			'user-agent': 'custom-ua-string'
		}
	});
	const headers = (await instance(s.url, {json: true})).body;
	t.is(headers['user-agent'], 'custom-ua-string');
});

test('support invocation overrides', async t => {
	const instance = got.fork({
		headers: {
			'user-agent': 'custom-ua-string'
		}
	});
	const headers = (await instance(s.url, {
		json: true,
		headers: {
			'user-agent': 'different-ua-string'
		}
	})).body;
	t.is(headers['user-agent'], 'different-ua-string');
});

test('curry previous instance defaults', async t => {
	const instanceA = got.fork({
		headers: {
			'x-foo': 'foo'
		}
	});
	const instanceB = instanceA.fork({
		headers: {
			'x-bar': 'bar'
		}
	});
	const headers = (await instanceB(s.url, {json: true})).body;
	t.is(headers['x-foo'], 'foo');
	t.is(headers['x-bar'], 'bar');
});

test('custom endpoint with custom headers (fork)', async t => {
	const options = {headers: {unicorn: 'rainbow'}};
	const handler = (url, options, isStream) => {
		url = `${s.url}` + url;

		const normalizedArgs = got.normalizeArguments(url, options);

		if (isStream || normalizedArgs.stream) {
			return got.asStream(normalizedArgs);
		}

		return got.asPromise(normalizedArgs);
	};

	const instance = got.fork({options, handler});
	const headers = (await instance('/', {
		json: true
	})).body;
	t.is(headers.unicorn, 'rainbow');
});

test('custom endpoint with custom headers (create)', async t => {
	const options = {headers: {unicorn: 'rainbow'}};
	const handler = (url, options, isStream) => {
		url = `${s.url}` + url;

		const normalizedArgs = got.normalizeArguments(url, options);

		if (isStream || normalizedArgs.stream) {
			return got.asStream(normalizedArgs);
		}

		return got.asPromise(normalizedArgs);
	};
	const methods = ['get'];

	const instance = got.create({options, methods, handler});
	const headers = (await instance('/', {
		json: true
	})).body;
	t.is(headers.unicorn, 'rainbow');
	t.is(headers['user-agent'], undefined);
});

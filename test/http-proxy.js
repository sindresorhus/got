import test from 'ava';
import got from '../';
import {
	createServer, createProxy
}
from './helpers/server';

let s;
let p;
const proxyEnvVars = [
	'http_proxy',
	'HTTP_PROXY',
	'https_proxy',
	'HTTPS_PROXY',
	'no_proxy',
	'NO_PROXY'
];

test.before('setup', async() => {
	s = await createServer();

	s.on('/', (req, res) => {
		res.end('ok');
	});

	s.on('/empty', (req, res) => {
		res.end();
	});

	s.on('/404', (req, res) => {
		setTimeout(() => {
			res.statusCode = 404;
			res.end('not');
		}, 10);
	});

	s.on('/?recent=true', (req, res) => {
		res.end('recent');
	});

	await s.listen(s.port);

	p = await createProxy();

	await p.listen(p.port);

	proxyEnvVars.forEach(value => delete process.env[value]);
	process.env.HTTP_PROXY = `http://localhost:${p.port}`;
});

test('simple request using proxy', async t => {
	console.log(`http-proxy.js Proxy: ${process.env.HTTP_PROXY} for ${s.url}`);
	t.is((await got(s.url)).body, 'ok');
});

test('protocol-less URLs using proxy', async t => {
	t.is((await got(s.url.replace(/^http:\/\//, ''))).body, 'ok');
});

test('empty response using proxy', async t => {
	t.is((await got(`${s.url}/empty`)).body, '');
});

test('error with code using proxy', async t => {
	try {
		await got(`${s.url}/404`);
		t.fail('Exception was not thrown');
	}	catch (err) {
		t.is(err.statusCode, 404);
		t.is(err.response.body, 'not');
	}
});

test('buffer on encoding === null using proxy', async t => {
	const data = (await got(s.url, {
		encoding: null
	})).body;
	t.ok(Buffer.isBuffer(data));
});

test('timeout option using proxy', async t => {
	try {
		await got(`${s.url}/404`, {
			timeout: 1,
			retries: 0
		});
		t.fail('Exception was not thrown');
	}	catch (err) {
		t.is(err.code, 'ETIMEDOUT');
	}
});

test('query option using proxy', async t => {
	t.is((await got(s.url, {
		query: {
			recent: true
		}
	})).body, 'recent');
	t.is((await got(s.url, {
		query: 'recent=true'
	})).body, 'recent');
});

test.after('cleanup', async() => {
	await s.close();
	await p.close();
	proxyEnvVars.forEach(value => delete process.env[value]);
});

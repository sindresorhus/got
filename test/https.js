import test from 'ava';
import got from '../source';
import {createSSLServer} from './helpers/server';

let s;

test.before('setup', async () => {
	s = await createSSLServer();

	s.on('/', (request, response) => response.end('ok'));

	await s.listen(s.port);
});

test.after('cleanup', async () => {
	await s.close();
});

test('make request to https server without ca', async t => {
	t.truthy((await got(s.url, {rejectUnauthorized: false})).body);
});

test('make request to https server with ca', async t => {
	const {body} = await got(s.url, {
		ca: s.caRootCert,
		headers: {host: 'sindresorhus.com'}
	});
	t.is(body, 'ok');
});

test('protocol-less URLs default to HTTPS', async t => {
	const {body, requestUrl} = await got(s.url.replace(/^https:\/\//, ''), {
		ca: s.caRootCert,
		headers: {host: 'sindresorhus.com'}
	});
	t.is(body, 'ok');
	t.true(requestUrl.startsWith('https://'));
});

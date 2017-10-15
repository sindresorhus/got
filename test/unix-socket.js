import {format} from 'util';
import http from 'http';
import tempy from 'tempy';
import test from 'ava';
import createTestServer from 'create-test-server';
import pify from 'pify';
import got from '..';

const socketPath = tempy.file({extension: 'socket'});

let s;

test.before('setup', async () => {
	const handler = await createTestServer();

	handler.get('/', (req, res) => {
		res.send('ok');
	});

	handler.get('/foo:bar', (req, res) => {
		res.send('ok');
	});

	s = http.createServer(handler);
	await pify(s.listen.bind(s))(socketPath);
});

test('works', async t => {
	const url = format('http://unix:%s:%s', socketPath, '/');
	t.is((await got(url)).body, 'ok');
});

test('protocol-less works', async t => {
	const url = format('unix:%s:%s', socketPath, '/');
	t.is((await got(url)).body, 'ok');
});

test('address with : works', async t => {
	const url = format('unix:%s:%s', socketPath, '/foo:bar');
	t.is((await got(url)).body, 'ok');
});

test.after('cleanup', async () => {
	await s.close();
});

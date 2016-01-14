import {format} from 'util';
import tempfile from 'tempfile';
import test from 'ava';
import got from '../';
import {createServer} from './helpers/server';

let socketPath = tempfile('.socket');

let s;

test.before('setup', async () => {
	s = await createServer();

	s.on('/', (req, res) => {
		res.end('ok');
	});

	await s.listen(socketPath);
});

test('works', async t => {
	let url = format('http://unix:%s:%s', socketPath, '/');
	t.is((await got(url)).body, 'ok');
});

test('protocol-less works', async t => {
	let url = format('unix:%s:%s', socketPath, '/');
	t.is((await got(url)).body, 'ok');
});

test.after('cleanup', async () => {
	await s.close();
});

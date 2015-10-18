import {format} from 'util';
import tempfile from 'tempfile';
import test from 'ava';
import got from '../';
import {createServer} from './_server';

const socketPath = tempfile('.socket');

let s;

test.before('setup', async t => {
	s = await createServer();

	s.on('/', (req, res) => {
		res.end('ok');
	});

	await s.listen(socketPath);
});

test('works', async t => {
	const url = format('http://unix:%s:%s', socketPath, '/');
	t.is((await got(url)).body, 'ok');
});

test('protocol-less works', async t => {
	const url = format('unix:%s:%s', socketPath, '/');
	t.is((await got(url)).body, 'ok');
});

test.after('cleanup', async t => {
	await s.close();
});

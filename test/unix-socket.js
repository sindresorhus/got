import {format} from 'util';
import tempfile from 'tempfile';
import test from 'ava';
import got from '../';
import {createServer} from './_server';

const s = createServer();
const socketPath = tempfile('.socket');

s.on('/', (req, res) => {
	res.end('ok');
});

test.before('unix-socket - setup', t => {
	s.listen(socketPath, () => t.end());
});

test('unix-socket - request via unix socket', async t => {
	const url = format('http://unix:%s:%s', socketPath, '/');
	t.is((await got(url)).body, 'ok');
});

test('unix-socket - protocol-less request', async t => {
	const url = format('unix:%s:%s', socketPath, '/');
	t.is((await got(url)).body, 'ok');
});

test.after('unix-socket - cleanup', t => {
	s.close();
	t.end();
});

import {format} from 'util';
import tempfile from 'tempfile';
import test from 'ava';
import got from '../';
import {createServer} from './server.js';

const s = createServer();
const socketPath = tempfile('.socket');

s.on('/', (req, res) => {
	res.end('ok');
});

test.before('unix-socket - setup', t => {
	s.listen(socketPath, () => t.end());
});

test('unix-socket - request via unix socket', t => {
	// borrow unix domain socket url format from request module
	const url = format('http://unix:%s:%s', socketPath, '/');

	got(url, (err, data) => {
		t.ifError(err);
		t.is(data, 'ok');
		t.end();
	});
});

test('unix-socket - protocol-less request', t => {
	const url = format('unix:%s:%s', socketPath, '/');

	got(url, (err, data) => {
		t.ifError(err);
		t.is(data, 'ok');
		t.end();
	});
});

test.after('unix-socket - cleanup', t => {
	s.close();
	t.end();
});

import {ClientRequest} from 'http';
import {Transform} from 'stream';
import test from 'ava';
import {createServer} from './helpers/server';
import got from '..';

let s;

test.before('setup', async () => {
	s = await createServer();
	s.on('/', (req, res) => {
		res.statusCode = 200;
		res.end();
	});
	await s.listen(s.port);
});

test('should emit request event as promise', async t => {
	await got(s.url, {json: true}).on('request', req => {
		t.true(req instanceof ClientRequest);
	});
});

test('should emit response event as promise', async t => {
	await got(s.url, {json: true}).on('response', res => {
		t.true(res instanceof Transform);
		t.true(res.readable);
		t.is(res.statusCode, 200);
	});
});

test.after('cleanup', async () => {
	await s.close();
});

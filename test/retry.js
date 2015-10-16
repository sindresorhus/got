import test from 'ava';
import got from '../';
import {createServer} from './_server';

const s = createServer();

s.on('/long', () => {});

let knocks = 0;
s.on('/knock-twice', (req, res) => {
	if (knocks++ === 1) {
		res.end('who`s there?');
	}
});

let trys = 0;
s.on('/try-me', () => {
	trys++;
});

test.before('retry - setup', t => {
	s.listen(s.port, () => t.end());
});

test('retry - timeout errors', async t => {
	t.is((await got(`${s.url}/knock-twice`, {timeout: 1000})).body, 'who`s there?');
});

test('retry - can be disabled with option', async t => {
	try {
		await got(`${s.url}/try-me`, {timeout: 1000, retries: 0});
	} catch (err) {
		t.ok(err);
	}
	t.is(trys, 1);
});

test.after('error - cleanup', t => {
	s.close();
	t.end();
});

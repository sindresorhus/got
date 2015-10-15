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

test.before('retry - setup', t => {
	s.listen(s.port, () => t.end());
});

test('retry - timeout errors', t => {
	got(`${s.url}/knock-twice`, {timeout: 1000}, (err, data) => {
		t.ifError(err);
		t.is(data, 'who`s there?');
		t.end();
	});
});

test.after('error - cleanup', t => {
	s.close();
	t.end();
});

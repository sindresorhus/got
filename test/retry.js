import test from 'ava';
import got from '../source';
import {createServer} from './helpers/server';

let s;
let trys = 0;
let knocks = 0;
let fifth = 0;
let fifthPOST = 0;

test.before('setup', async () => {
	s = await createServer();

	s.on('/long', () => {});

	s.on('/knock-twice', (req, res) => {
		if (knocks++ === 1) {
			res.end('who`s there?');
		}
	});

	s.on('/try-me', () => {
		trys++;
	});

	s.on('/fifth', (req, res) => {
		if (fifth++ === 5) {
			res.end('who`s there?');
		}
	});

	s.on('request', (req, res) => {
		if (req.method === 'POST' && req.url.includes('fifthPOST')) {
			console.log(`Sending back HTTP 503 Service Unavailable ...`);
			fifthPOST++;
			if (fifthPOST === 5) {
				res.end(`All is well now, calm down.`);
			} else {
				res.statusCode = 503;
				res.statusMessage = 'Service Unavailable';
				res.end('You are cool, just make sure you retry this request....');
			}
		}
	});

	await s.listen(s.port);
});

test('can be disabled with option', async t => {
	const err = await t.throws(got(`${s.url}/try-me`, {
		timeout: {connect: 500, socket: 500},
		retries: 0
	}));
	t.truthy(err);
	t.is(trys, 1);
});

test('function gets iter count', async t => {
	await got(`${s.url}/fifth`, {
		timeout: {connect: 500, socket: 500},
		retries: iter => iter < 10
	});
	t.is(fifth, 6);
});

test('function gets iter count for POST verb also', async t => {
	await got(`${s.url}/fifthPOST`, {
		method: 'POST',
		retries: iter => iter < 10
	});
	t.is(fifthPOST, 6);
});

test('falsy value prevents retries', async t => {
	const err = await t.throws(got(`${s.url}/long`, {
		timeout: {connect: 100, socket: 100},
		retries: () => 0
	}));
	t.truthy(err);
});

test('falsy value prevents retries #2', async t => {
	const err = await t.throws(got(`${s.url}/long`, {
		timeout: {connect: 100, socket: 100},
		retries: (iter, err) => {
			t.truthy(err);
			return false;
		}
	}));
	t.truthy(err);
});

test.after('cleanup', async () => {
	await s.close();
});

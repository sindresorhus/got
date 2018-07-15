import test from 'ava';
import delay from 'delay';
import {createServer} from './helpers/server';
import got from '..';

let s;

test.before('setup', async () => {
	s = await createServer();
	s.on('/', async (req, res) => {
		await delay(500);
		res.statusCode = 200;
		res.end(JSON.stringify(req.headers));
	});
	await s.listen(s.port);
});

test('beforeRequest receives normalized options', async t => {
	await got(s.url, {
		json: true,
		hooks: {
			beforeRequest: [
				options => {
					t.is(options.path, '/');
					t.is(options.hostname, 'localhost');
				}
			]
		}
	});
});

test('beforeRequest allows modifications', async t => {
	const res = await got(s.url, {
		json: true,
		hooks: {
			beforeRequest: [
				options => {
					options.headers.foo = 'bar';
				}
			]
		}
	});
	t.is(res.body.foo, 'bar');
});

test('beforeRequest awaits async function', async t => {
	const res = await got(s.url, {
		json: true,
		hooks: {
			beforeRequest: [
				async options => {
					await delay(100);
					options.headers.foo = 'bar';
				}
			]
		}
	});
	t.is(res.body.foo, 'bar');
});

test('beforeRequest rejects when beforeRequest throws', async t => {
	await t.throws(got(s.url, {
		hooks: {
			beforeRequest: [
				() => {
					throw new Error('oops');
				}
			]
		}
	}), {message: 'oops'});
});

test('beforeRequest rejects when beforeRequest rejects', async t => {
	await t.throws(got(s.url, {
		hooks: {
			beforeRequest: [() => Promise.reject(new Error('oops'))]
		}
	}), {message: 'oops'});
});

test('extend got + onAbort hook', async t => {
	let aborted = false;

	const extended = got.extend({
		hooks: {
			onAbort: [
				() => {
					aborted = true;
				}
			]
		}
	});

	const p = extended(s.url);
	p.cancel();

	await t.throws(p);
	await delay(200); // Wait because it may throw before the hook is called

	t.is(aborted, true);
});

test.after('cleanup', async () => {
	await s.close();
});

import test from 'ava';
import delay from 'delay';
import {createServer} from './helpers/server';
import got from '..';

let s;

test.before('setup', async () => {
	s = await createServer();
	const echoHeaders = (req, res) => {
		res.statusCode = 200;
		res.write(JSON.stringify(req.headers));
		res.end();
	};
	s.on('/', echoHeaders);
	await s.listen(s.port);
});

test('beforeRequest receives normalized options', async t => {
	await got(
		s.url,
		{
			json: true,
			hooks: {
				beforeRequest: [
					options => {
						t.is(options.path, '/');
						t.is(options.hostname, 'localhost');
					}
				]
			}
		}
	);
});

test('beforeRequest allows modifications', async t => {
	const res = await got(
		s.url,
		{
			json: true,
			hooks: {
				beforeRequest: [
					options => {
						options.headers.foo = 'bar';
					}
				]
			}
		}
	);
	t.is(res.body.foo, 'bar');
});

test('beforeRequest awaits async function', async t => {
	const res = await got(
		s.url,
		{
			json: true,
			hooks: {
				beforeRequest: [
					async options => {
						await delay(100);
						options.headers.foo = 'bar';
					}
				]
			}
		}
	);
	t.is(res.body.foo, 'bar');
});

test('beforeRequest rejects when beforeRequest throws', async t => {
	await t.throws(
		() => got(s.url, {
			hooks: {
				beforeRequest: [
					() => {
						throw new Error('oops');
					}
				]
			}
		}),
		{
			instanceOf: Error,
			message: 'oops'
		}
	);
});

test('beforeRequest rejects when beforeRequest rejects', async t => {
	await t.throws(
		() => got(s.url, {
			hooks: {
				beforeRequest: [() => Promise.reject(new Error('oops'))]
			}
		}),
		{
			instanceOf: Error,
			message: 'oops'
		}
	);
});

test.after('cleanup', async () => {
	await s.close();
});

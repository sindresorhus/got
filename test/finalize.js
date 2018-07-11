import test from 'ava';
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

test('receives finalized options', async t => {
	await got(
		s.url,
		{
			json: true,
			finalize: options => {
				t.is(options.path, '/');
				t.is(options.hostname, 'localhost');
			}
		}
	);
});

test('allows modifications', async t => {
	const res = await got(
		s.url,
		{
			json: true,
			finalize: options => {
				options.headers.foo = 'bar';
			}
		}
	);
	t.is(res.body.foo, 'bar');
});

test('awaits async function', async t => {
	const res = await got(
		s.url,
		{
			json: true,
			finalize: async options => {
				return new Promise(
					resolve => {
						setTimeout(
							() => {
								options.headers.foo = 'bar';
								resolve();
							},
							100
						);
					}
				);
			}
		}
	);
	t.is(res.body.foo, 'bar');
});

test('rejects when finalize throws', async t => {
	await t.throws(
		() => got(s.url, {finalize: () => {
			throw new Error('oops');
		}}),
		{
			instanceOf: Error,
			message: 'oops'
		}
	);
});

test('rejects when finalize rejects', async t => {
	await t.throws(
		() => got(s.url, {finalize: () => Promise.reject(new Error('oops'))}),
		{
			instanceOf: Error,
			message: 'oops'
		}
	);
});

test.after('cleanup', async () => {
	await s.close();
});

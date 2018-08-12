import test from 'ava';
import delay from 'delay';
import {createServer} from './helpers/server';
import got from '..';

let s;

test.before('setup', async () => {
	s = await createServer();
	const echoHeaders = (request, response) => {
		response.statusCode = 200;
		response.write(JSON.stringify(request.headers));
		response.end();
	};
	s.on('/', echoHeaders);
	await s.listen(s.port);
});

test.after('cleanup', async () => {
	await s.close();
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
	const response = await got(
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
	t.is(response.body.foo, 'bar');
});

test('beforeRequest awaits async function', async t => {
	const response = await got(
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
	t.is(response.body.foo, 'bar');
});

test('beforeRequest rejects when beforeRequest throws', async t => {
	await t.throwsAsync(
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
	await t.throwsAsync(
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

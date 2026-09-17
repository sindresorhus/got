import test from 'ava';
import {TimeoutError} from '../source/index.js';
import withServer from './helpers/with-server.js';

test('response timeout starts after a bodyless redirected request', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.redirect('/slow');
	});
	server.get('/slow', () => {});

	const error = await t.throwsAsync(got('', {
		timeout: {response: 30, request: 500},
		retry: {limit: 0},
	}), {instanceOf: TimeoutError});

	t.is(error?.event, 'response');
});

test('response timeout starts after a 303 redirect that drops the body', withServer, async (t, server, got) => {
	server.post('/', (_request, response) => {
		response.redirect(303, '/slow');
	});
	server.get('/slow', () => {});

	const error = await t.throwsAsync(got.post('', {
		body: 'payload',
		timeout: {response: 30, request: 500},
		retry: {limit: 0},
	}), {instanceOf: TimeoutError});

	t.is(error?.event, 'response');
});

test('response timeout starts after a HEAD redirect', withServer, async (t, server, got) => {
	server.head('/', (_request, response) => {
		response.redirect('/slow');
	});
	server.head('/slow', () => {});

	const error = await t.throwsAsync(got.head('', {
		timeout: {response: 30, request: 500},
		retry: {limit: 0},
	}), {instanceOf: TimeoutError});

	t.is(error?.event, 'response');
});

test('fast redirected responses are unaffected by the response timeout', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.redirect('/fast');
	});
	server.get('/fast', (_request, response) => {
		response.end('ok');
	});

	const response = await got('', {timeout: {response: 500}});
	t.is(response.body, 'ok');
});

test('response timeout works without a request timeout on redirects', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.redirect('/slow');
	});
	server.get('/slow', () => {});

	const error = await t.throwsAsync(got('', {
		timeout: {response: 30},
		retry: {limit: 0},
	}), {instanceOf: TimeoutError});

	t.is(error?.event, 'response');
});

test('a stream client gets the response timeout error after a redirect', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.redirect('/slow');
	});
	server.get('/slow', () => {});

	const error = await t.throwsAsync(got.stream('', {
		timeout: {response: 30, request: 500},
		retry: {limit: 0},
	}).toArray(), {instanceOf: TimeoutError});

	t.is(error?.event, 'response');
});

test('redirect response timeout still applies through multiple hops', withServer, async (t, server, got) => {
	server.get('/a', (_request, response) => {
		response.redirect('/b');
	});
	server.get('/b', (_request, response) => {
		response.redirect('/slow');
	});
	server.get('/slow', () => {});

	const error = await t.throwsAsync(got('a', {
		timeout: {response: 30, request: 500},
		retry: {limit: 0},
	}), {instanceOf: TimeoutError});

	t.is(error?.event, 'response');
});

test('regression: normal redirected requests complete without timeouts', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.redirect('/final');
	});
	server.get('/final', (_request, response) => {
		response.end('done');
	});

	const response = await got('', {timeout: {response: 2000, request: 2000}});
	t.is(response.body, 'done');
	t.is(response.url, `${server.url}/final`);
});

import test from 'ava';
import withServer from './helpers/with-server';

test.failing('sends plain objects as JSON', withServer, async (t, server, got) => {
	server.delete('/', async (request, response) => {
		// Not using streams here to avoid this unhandled rejection:
		// Error [ERR_STREAM_PREMATURE_CLOSE]: Premature close
		response.json(request.body);
	});

	const {body} = await got.delete({
		json: {such: 'wow'},
		responseType: 'json'
	});
	t.deepEqual(body, {such: 'wow'});
});
